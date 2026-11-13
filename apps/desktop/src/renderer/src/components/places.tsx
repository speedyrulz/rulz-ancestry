import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { PLACE_QUERY_MIN, PLACE_TEXT_MAX, formatCoordinates } from '@rulz/core';
import type {
  GazetteerEntry,
  GazetteerStatus,
  PlaceListPage,
  PlaceListRequest,
  PlaceSuggestions,
  TreePlaceInfo,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf, formatSize, formatWhen } from '../format';
import { ConfirmDialog, Dialog, SelectField, TextField } from './ui';

/**
 * Places: the field that offers places while one is typed, and the window
 * that lists the places of a tree and fetches the list of the world's places.
 */

/** How long typing must pause before places are looked up, in milliseconds. */
const TYPING_PAUSE = 150;

type Suggestion =
  | { kind: 'own'; text: string; events: number; linked: boolean }
  | { kind: 'gazetteer'; text: string; geonameId: number; region: boolean };

function suggestionsOf(found: PlaceSuggestions, typed: string): Suggestion[] {
  const own: Suggestion[] = found.own
    // A place that is already in the field word for word is no help.
    .filter((place) => place.text !== typed.trim())
    .map((place) => ({
      kind: 'own',
      text: place.text,
      events: place.events,
      linked: place.link !== null,
    }));
  const taken = new Set(found.own.map((place) => place.text.toLowerCase()));
  const gazetteer: Suggestion[] = found.gazetteer
    .filter((entry) => !taken.has(entry.text.toLowerCase()))
    .map((entry) => ({
      kind: 'gazetteer',
      text: entry.text,
      geonameId: entry.geonameId,
      region: entry.kind === 'region',
    }));
  return [...own, ...gazetteer];
}

interface PlaceFieldProps {
  label: string;
  value: string;
  /**
   * Called with the new text. `geonameId` is given when the text was picked
   * from the gazetteer, and left out when it was typed or picked from the
   * tree's own places.
   */
  onChange: (text: string, geonameId?: number) => void;
  testId: string;
}

/**
 * A text field for a place. While something is typed it offers the places
 * the tree already has and, when the place list has been downloaded, places
 * from all over the world. Arrow keys move through what is offered, Enter
 * takes one, and Escape puts the offers away.
 */
export function PlaceField({ label, value, onChange, testId }: PlaceFieldProps) {
  const id = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [found, setFound] = useState<{ typed: string; result: PlaceSuggestions } | null>(null);
  /** What was last typed by hand; picking an offer must not look places up again. */
  const typedRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Where on the screen the offers are shown. */
  const [box, setBox] = useState<CSSProperties | null>(null);

  useEffect(() => {
    const typed = typedRef.current;
    if (typed === null || typed !== value) return;
    if (typed.trim() === '') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.suggestPlaces(typed).then(
        (result) => {
          if (cancelled) return;
          setFound({ typed, result });
          setActive(-1);
        },
        () => {
          // No offers is no reason to bother someone who is typing.
          if (!cancelled) setFound(null);
        },
      );
    }, TYPING_PAUSE);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  // Only the answer to what is in the field now is offered.
  const current = found !== null && found.typed === value ? found.result : null;
  const offers = current === null ? [] : suggestionsOf(current, value);
  // Said under the offers only: a box that opened at every place typed would be in the way.
  const needsList =
    current !== null && !current.installed && value.trim().length >= PLACE_QUERY_MIN;
  const shown = open && offers.length > 0;
  const offerCount = offers.length;

  // The offers are laid over the window, not inside the form: a form scrolls
  // what does not fit, and would cut the list off. They open upwards when
  // there is too little room under the field.
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 180 && above > below;
      setBox({
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(100, Math.min(280, upwards ? above : below)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 2 } : { top: rect.bottom + 2 }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [shown, offerCount]);

  const pick = (offer: Suggestion) => {
    typedRef.current = null;
    setOpen(false);
    setActive(-1);
    onChange(offer.text, offer.kind === 'gazetteer' ? offer.geonameId : undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // A key that belongs to the composing of a letter is not for the offers.
    if (!shown || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (offers.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(
        (at) => (at + step + offers.length + (at === -1 && step === -1 ? 1 : 0)) % offers.length,
      );
    } else if (event.key === 'Enter') {
      const offer = offers[active];
      if (!offer) return;
      // Takes the offer; the form is not sent.
      event.preventDefault();
      pick(offer);
    } else if (event.key === 'Escape') {
      // Puts the offers away; the form stays open.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="field place-field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        value={value}
        maxLength={PLACE_TEXT_MAX}
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        onChange={(event) => {
          typedRef.current = event.target.value;
          setOpen(true);
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {shown && box !== null && (
        <div className="place-offers" style={box} data-testid={`${testId}-offers`}>
          <ul id={listId} role="listbox" aria-label="Places that fit">
            {offers.map((offer, index) => (
              <li
                key={`${offer.kind}-${offer.kind === 'gazetteer' ? offer.geonameId : offer.text}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'active' : undefined}
                data-testid="place-offer"
                data-kind={offer.kind}
                // Before the field loses the focus, which would put the list away.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(offer);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span>{offer.text}</span>
                <span className="muted">
                  {offer.kind === 'own'
                    ? `In this tree, ${countOf(offer.events, 'event', 'events')}`
                    : offer.region
                      ? 'Region, from GeoNames'
                      : 'From GeoNames'}
                </span>
              </li>
            ))}
          </ul>
          {needsList && (
            <p className="hint" data-testid="place-offers-hint">
              These are places already in this tree. For places from all over the world, download
              the place list: close this form and choose Places.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function entryNote(entry: GazetteerEntry): string {
  return `${entry.kind === 'region' ? 'Region. ' : ''}${formatCoordinates(entry.lat, entry.lon)}`;
}

interface GazetteerPanelProps {
  status: GazetteerStatus | null;
  onStatus: (status: GazetteerStatus) => void;
}

/** Says whether the place list is on this computer, and downloads or removes it. */
function GazetteerPanel({ status, onStatus }: GazetteerPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const running = status?.job != null;

  // While a download runs, ask how far it is.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api.getGazetteerStatus().then(
        (next) => {
          if (!cancelled) onStatus(next);
        },
        () => undefined,
      );
    }, 400);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, onStatus]);

  const run = (action: () => Promise<GazetteerStatus>) => {
    setError(null);
    action().then(onStatus, (failure: unknown) => setError(errorMessage(failure)));
  };

  if (status === null) return <p className="muted">Looking…</p>;
  const { installed, job } = status;
  const credit = (
    <>
      The list comes from{' '}
      <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
        GeoNames
      </a>{' '}
      and is licensed{' '}
      <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
        CC BY 4.0
      </a>
      .
    </>
  );

  return (
    <section className="gazetteer-panel" data-testid="gazetteer-panel">
      {job !== null && (
        <>
          <p className="dialog-text" role="status" data-testid="gazetteer-progress">
            {job.phase === 'downloading'
              ? `Downloading the place list: file ${job.step} of ${job.steps}, ${formatSize(job.bytes)} so far.`
              : `Putting the place list together: ${countOf(job.places, 'place', 'places')} so far.`}
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => run(() => api.cancelGazetteerDownload())}
              data-testid="gazetteer-cancel"
            >
              Stop
            </button>
          </div>
        </>
      )}
      {job === null && installed === null && (
        <>
          <p className="dialog-text" data-testid="gazetteer-absent">
            The app can offer places from all over the world while you type, and knows where each
            lies on the map. For that it needs a list of places, which it downloads once (about{' '}
            {formatSize(status.downloadBytes)}). Nothing about you or your tree is sent. {credit}
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => run(() => api.downloadGazetteer())}
              data-testid="gazetteer-download"
            >
              Download the place list
            </button>
          </div>
        </>
      )}
      {job === null && installed !== null && (
        <>
          <p className="dialog-text" data-testid="gazetteer-installed">
            The place list holds {countOf(installed.places, 'place', 'places')}, downloaded on{' '}
            {formatWhen(installed.builtAt)}. {credit}
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => run(() => api.downloadGazetteer())}
              data-testid="gazetteer-refresh"
            >
              Download again
            </button>
            <button type="button" onClick={() => setRemoving(true)} data-testid="gazetteer-remove">
              Remove
            </button>
          </div>
        </>
      )}
      {(error ?? (job === null ? status.error : null)) !== null && (
        <p className="error" role="alert" data-testid="gazetteer-error">
          {error ?? errorMessage(status.error)}
        </p>
      )}
      {removing && (
        <ConfirmDialog
          title="Remove the place list?"
          confirmLabel="Remove"
          onConfirm={async () => {
            onStatus(await api.removeGazetteer());
          }}
          onClose={() => setRemoving(false)}
        >
          <p className="dialog-text">
            The list is removed from this computer. Places you have linked stay linked, and the list
            can be downloaded again.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

interface LinkPlaceDialogProps {
  place: string;
  onLinked: (tree: TreeState) => void;
  onClose: () => void;
}

/** Looks a place of the tree up in the place list, to link it to an entry. */
function LinkPlaceDialog({ place, onLinked, onClose }: LinkPlaceDialogProps) {
  const [query, setQuery] = useState(place);
  const [found, setFound] = useState<{ query: string; entries: GazetteerEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.suggestPlaces(query).then(
        (result) => {
          if (!cancelled) setFound({ query, entries: result.gazetteer });
        },
        (failure: unknown) => {
          if (!cancelled) setError(errorMessage(failure));
        },
      );
    }, TYPING_PAUSE);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const shown = found !== null && found.query === query ? found.entries : null;
  const link = (entry: GazetteerEntry) => {
    setError(null);
    api.linkPlace(place, entry.geonameId).then(
      (tree) => {
        onLinked(tree);
        onClose();
      },
      (failure: unknown) => setError(errorMessage(failure)),
    );
  };

  return (
    <Dialog
      title="Find a place in the place list"
      onClose={onClose}
      testId="link-place-dialog"
      wide
    >
      <p className="dialog-text">
        Every event at <strong>{place}</strong> will know where it lies. The place stays written as
        it is.
      </p>
      <TextField
        label="Look for"
        value={query}
        onChange={setQuery}
        testId="link-place-search"
        maxLength={PLACE_TEXT_MAX}
        autoFocus
        hint={
          <p className="hint">
            Type the start of a name. A county, a state or a country after a comma narrows it down:
            Springfield, Illinois.
          </p>
        }
      />
      <div className="scroll-box places-box">
        {shown === null && <p className="muted pad">Looking…</p>}
        {shown !== null && shown.length === 0 && (
          <p className="muted pad" data-testid="link-place-empty">
            The place list has no place of that name.
          </p>
        )}
        {shown !== null && shown.length > 0 && (
          <table className="table" data-testid="link-place-results">
            <tbody>
              {shown.map((entry) => (
                <tr key={entry.geonameId} data-testid="link-place-result">
                  <td>
                    {entry.text}
                    <div className="hint">{entryNote(entry)}</div>
                  </td>
                  <td className="row-actions">
                    <button type="button" onClick={() => link(entry)} data-testid="link-place-pick">
                      Link
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} data-testid="link-place-close">
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

const PAGE = 50;
const NO_OFFERS: ReadonlyMap<string, GazetteerEntry | null> = new Map();
const FILTER_OPTIONS = [
  ['all', 'All places'],
  ['unlinked', 'Not linked'],
  ['linked', 'Linked'],
] as const;

interface PlacesDialogProps {
  tree: TreeState;
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

/**
 * The places of the tree, each with the entry of the place list it is linked
 * to; and the place list itself, which is downloaded from here.
 */
export function PlacesDialog({ tree, onTree, onClose }: PlacesDialogProps) {
  const [status, setStatus] = useState<GazetteerStatus | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PlaceListRequest['filter']>('all');
  const [offset, setOffset] = useState(0);
  const [found, setFound] = useState<
    { key: string; page: PlaceListPage } | { key: string; error: string } | null
  >(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<{
    /** The place list the offers were made from. */
    list: number;
    known: ReadonlyMap<string, GazetteerEntry | null>;
  }>({ list: 0, known: NO_OFFERS });

  useEffect(() => {
    api.getGazetteerStatus().then(setStatus, () => undefined);
  }, []);

  // The offers under each place depend on the place list being there.
  const listKey = status?.installed?.builtAt ?? 0;
  const key = `${query}|${filter}|${offset}|${tree.revision}|${listKey}`;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api.listPlaces({ query, filter, offset, limit: PAGE }).then(
        (page) => {
          if (!cancelled) setFound({ key, page });
        },
        (failure: unknown) => {
          if (!cancelled) setFound({ key, error: errorMessage(failure) });
        },
      );
    }, TYPING_PAUSE);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, query, filter, offset]);

  // The last answer stays on screen while the next is fetched, so the list does not flicker.
  const page = found !== null && 'page' in found ? found.page : null;
  const failure = found !== null && 'error' in found && found.key === key ? found.error : null;
  const installed = status?.installed != null;

  // The entry that fits each place without a link is asked for one place at
  // a time: looking one up takes a moment, and fifty in one go would keep the
  // app from answering. What was found is kept while the window is open.
  const known = offers.list === listKey ? offers.known : NO_OFFERS;
  const wanted =
    page !== null && installed
      ? page.places.find((place) => place.link === null && !known.has(place.text))?.text
      : undefined;
  useEffect(() => {
    if (wanted === undefined) return;
    const keep = (offer: GazetteerEntry | null) =>
      setOffers((was) => ({
        list: listKey,
        known: new Map(was.list === listKey ? was.known : NO_OFFERS).set(wanted, offer),
      }));
    api.offerPlace(wanted).then(keep, () => keep(null));
  }, [wanted, listKey]);
  const offerOf = (place: TreePlaceInfo) => known.get(place.text) ?? null;

  const change = (action: Promise<TreeState>) => {
    setError(null);
    action.then(onTree, (problem: unknown) => setError(errorMessage(problem)));
  };

  const row = (place: TreePlaceInfo, offer: GazetteerEntry | null) => (
    <tr key={place.text} data-testid="place-row">
      <td>
        <span data-testid="place-text">{place.text}</span>
        <div className="hint">{countOf(place.events, 'event', 'events')}</div>
      </td>
      <td data-testid="place-link">
        {place.link !== null ? (
          <>
            {place.link.name}
            <div className="hint">{formatCoordinates(place.link.lat, place.link.lon)}</div>
          </>
        ) : offer !== null ? (
          <>
            <span className="muted">Perhaps: </span>
            {offer.text}
          </>
        ) : (
          <span className="muted">{installed ? 'Not linked' : ''}</span>
        )}
      </td>
      <td className="row-actions">
        {place.link !== null ? (
          <button
            type="button"
            onClick={() => change(api.unlinkPlace(place.text))}
            data-testid="unlink-place"
          >
            Unlink
          </button>
        ) : (
          installed && (
            <>
              {offer !== null && (
                <button
                  type="button"
                  onClick={() => change(api.linkPlace(place.text, offer.geonameId))}
                  data-testid="link-place-offer"
                >
                  Link
                </button>
              )}
              <button type="button" onClick={() => setLinking(place.text)} data-testid="find-place">
                {offer !== null ? 'Other…' : 'Find…'}
              </button>
            </>
          )
        )}
      </td>
    </tr>
  );

  return (
    <Dialog title="Places" onClose={onClose} testId="places-dialog" wide>
      <GazetteerPanel status={status} onStatus={setStatus} />
      <h3>Places in this tree</h3>
      {page !== null && (
        <p className="dialog-text" data-testid="places-count">
          {page.all === 0
            ? 'No event in this tree has a place yet.'
            : `${countOf(page.all, 'place', 'places')}, ${page.linked.toLocaleString()} linked to the place list. A linked place knows where it lies on the map; its text stays as you wrote it.`}
        </p>
      )}
      <div className="field-grid">
        <TextField
          label="Find a place"
          value={query}
          onChange={(next) => {
            setQuery(next);
            setOffset(0);
          }}
          testId="places-search"
          maxLength={PLACE_TEXT_MAX}
        />
        <SelectField
          label="Show"
          value={filter}
          options={FILTER_OPTIONS}
          onChange={(next) => {
            setFilter(next);
            setOffset(0);
          }}
          testId="places-filter"
        />
      </div>
      <div className="scroll-box places-box">
        {page === null && failure === null && <p className="muted pad">Looking…</p>}
        {failure !== null && (
          <p className="error" role="alert">
            {failure}
          </p>
        )}
        {page !== null && page.places.length === 0 && page.all > 0 && (
          <p className="muted pad" data-testid="places-empty">
            No place fits.
          </p>
        )}
        {page !== null && page.places.length > 0 && (
          <table className="table" data-testid="places-list">
            <thead>
              <tr>
                <th scope="col">Place</th>
                <th scope="col">In the place list</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>{page.places.map((place) => row(place, offerOf(place)))}</tbody>
          </table>
        )}
      </div>
      {page !== null && page.total > PAGE && (
        <div className="actions">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset((now) => Math.max(0, now - PAGE))}
            data-testid="places-previous"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={offset + PAGE >= page.total}
            onClick={() => setOffset((now) => now + PAGE)}
            data-testid="places-next"
          >
            Next
          </button>
          <span className="hint" data-testid="places-range">
            {(offset + 1).toLocaleString()} to{' '}
            {Math.min(offset + PAGE, page.total).toLocaleString()} of{' '}
            {countOf(page.total, 'place', 'places')}
          </span>
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert" data-testid="places-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose} data-testid="places-close">
          Close
        </button>
      </div>
      {linking !== null && (
        <LinkPlaceDialog place={linking} onLinked={onTree} onClose={() => setLinking(null)} />
      )}
    </Dialog>
  );
}
