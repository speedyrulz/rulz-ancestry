import { useEffect, useState, type ReactNode } from 'react';
import type {
  DuplicateList,
  EventInfo,
  MergeInfo,
  PersonPage,
  PersonSummary,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { SEX_LABELS, countOf, fullName, labelOf, lifespan } from '../format';
import { PersonPicker } from './PersonPicker';
import { Dialog } from './ui';

/** How sure a score is, in a word. */
export function likelihood(score: number): string {
  if (score >= 80) return 'Very likely';
  if (score >= 65) return 'Likely';
  return 'Possible';
}

/** What a merge did, as a sentence for the message bar. */
export function mergeSummary(info: MergeInfo, name: string): string {
  const moved = [
    info.names > 0 ? countOf(info.names, 'name', 'names') : null,
    info.events > 0 ? countOf(info.events, 'event', 'events') : null,
  ].filter((part) => part !== null);
  const added = moved.length === 0 ? 'Nothing new was added' : `${moved.join(' and ')} came over`;
  const joined =
    info.families > 0 ? ` ${countOf(info.families, 'family was', 'families were')} joined.` : '';
  return `Merged into ${name}. ${added}.${joined} Undo brings both records back.`;
}

function eventLine(event: EventInfo): string {
  const details = [event.dateText, event.placeText, event.description].filter(
    (part) => part !== '',
  );
  return details.length === 0
    ? labelOf(event.type)
    : `${labelOf(event.type)}: ${details.join(', ')}`;
}

function people(list: readonly PersonSummary[]): ReactNode {
  if (list.length === 0) return <span className="muted">None recorded</span>;
  return (
    <ul className="plain">
      {list.map((person) => (
        <li key={person.id}>
          {fullName(person)} <span className="muted">{lifespan(person)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One side of the comparison: everything recorded for one of the two people. */
function side(page: PersonPage): Record<string, ReactNode> {
  const living =
    page.person.living === null ? 'Not stated' : page.person.living ? 'Living' : 'Deceased';
  return {
    Names: (
      <ul className="plain">
        {page.names.length === 0 && <li className="muted">None recorded</li>}
        {page.names.map((name) => (
          <li key={name.id}>{fullName({ name })}</li>
        ))}
      </ul>
    ),
    Sex: SEX_LABELS[page.person.sex],
    'Living or deceased': living,
    Events:
      page.events.length === 0 ? (
        <span className="muted">None recorded</span>
      ) : (
        <ul className="plain">
          {page.events.map((event) => (
            <li key={event.id}>{eventLine(event)}</li>
          ))}
        </ul>
      ),
    Parents: people(page.parentFamilies.flatMap((family) => family.parents)),
    Partners: people(
      page.partnerFamilies.flatMap((family) => (family.partner ? [family.partner] : [])),
    ),
    Children: people(
      page.partnerFamilies.flatMap((family) => family.children.map((child) => child.person)),
    ),
    'Other details from an imported file':
      page.keptLines.length === 0 ? (
        <span className="muted">None</span>
      ) : (
        countOf(page.keptLines.length, 'item', 'items')
      ),
  };
}

const ROWS = [
  'Names',
  'Sex',
  'Living or deceased',
  'Events',
  'Parents',
  'Partners',
  'Children',
  'Other details from an imported file',
] as const;

interface MergeDialogProps {
  personId: string;
  /** The other record, when it is already known; otherwise the dialog asks for it first. */
  otherId?: string;
  /** Shows the "different people" button: for a pair the app itself suggested. */
  suggested?: boolean;
  /** Goes up with every change to the tree, so the comparison is read again. */
  revision: number;
  /** Called after the merge, with what it did and the name of the person who is left. */
  onMerged: (info: MergeInfo, name: string) => void;
  /** Called with the tree's new state once the pair is marked as two different people. */
  onDismissed?: (tree: TreeState) => void;
  onClose: () => void;
}

/** Shows two records side by side and merges them into the one the user keeps. */
export function MergeDialog({
  personId,
  otherId: givenOtherId,
  suggested = false,
  revision,
  onMerged,
  onDismissed,
  onClose,
}: MergeDialogProps) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(givenOtherId !== undefined);
  const otherId = givenOtherId ?? pickedId;
  const [pages, setPages] = useState<{ key: string; pair: [PersonPage, PersonPage] | null } | null>(
    null,
  );
  const [keep, setKeep] = useState<'first' | 'second'>('first');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${personId}|${otherId ?? ''}|${revision}`;

  useEffect(() => {
    if (!comparing || otherId === null) return;
    let cancelled = false;
    Promise.all([api.getPersonPage(personId), api.getPersonPage(otherId)]).then(
      ([first, second]) => {
        if (!cancelled) setPages({ key, pair: first && second ? [first, second] : null });
      },
      (failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [comparing, personId, otherId, key]);

  const run = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    action()
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setBusy(false));
  };

  if (!comparing || otherId === null) {
    return (
      <Dialog title="Merge with another record" onClose={onClose} testId="merge-pick-dialog" wide>
        <p className="dialog-text">
          Use this when one person is in the tree twice. Choose the other record of the same person;
          you will see the two side by side before anything is merged.
        </p>
        <PersonPicker
          label="Find the other record by name"
          excludeId={personId}
          chosenId={pickedId}
          onChoose={(person) => setPickedId(person?.id ?? null)}
        />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={pickedId === null}
            onClick={() => setComparing(true)}
            data-testid="merge-compare"
          >
            Compare
          </button>
        </div>
      </Dialog>
    );
  }

  const pair = pages?.pair ?? null;
  const [first, second] = pair ?? [null, null];
  const sides = pair ? ([side(pair[0]), side(pair[1])] as const) : null;
  const kept = keep === 'first' ? first : second;
  const merged = keep === 'first' ? second : first;

  return (
    <Dialog title="Are these the same person?" onClose={onClose} testId="merge-dialog" wide>
      {pages === null && error === null && <p className="muted">Reading both records…</p>}
      {pages !== null && pair === null && (
        <p className="muted">One of these records is not in the tree any more.</p>
      )}
      {first && second && sides && (
        <>
          <p className="dialog-text">
            Merging keeps everything both records have: names, events, parents, partners and
            children. Only exact repeats are dropped. Choose which record to keep; its main name and
            its details come first.
          </p>
          <table className="table compare" data-testid="merge-compare-table">
            <thead>
              <tr>
                <td />
                {([first, second] as const).map((page, index) => {
                  const which = index === 0 ? 'first' : 'second';
                  return (
                    <th scope="col" key={page.person.id}>
                      <label>
                        <input
                          type="radio"
                          name="merge-keep"
                          checked={keep === which}
                          onChange={() => setKeep(which)}
                          data-testid={`merge-keep-${which}`}
                        />
                        Keep {fullName(page.summary)}
                      </label>
                      <span className="muted">{lifespan(page.summary)}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row}>
                  <th scope="row">{row}</th>
                  <td>{sides[0][row]}</td>
                  <td>{sides[1][row]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {error !== null && (
        <p className="error" role="alert" data-testid="dialog-error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {suggested && onDismissed && (
          <button
            type="button"
            disabled={busy || pair === null}
            title="They will not be offered as possible duplicates again"
            onClick={() =>
              run(async () => {
                onDismissed(await api.markNotDuplicate(personId, otherId));
                onClose();
              })
            }
            data-testid="merge-different"
          >
            They are different people
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={busy || kept === null || merged === null}
          onClick={() =>
            run(async () => {
              if (!kept || !merged) return;
              const info = await api.mergePersons(kept.person.id, merged.person.id);
              onMerged(info, fullName(kept.summary));
              onClose();
            })
          }
          data-testid="merge-submit"
        >
          Merge the two records
        </button>
      </div>
    </Dialog>
  );
}

interface DuplicatesDialogProps {
  tree: TreeState;
  onTree: (tree: TreeState) => void;
  /** Called after a merge, with what it did and the name of the person who is left. */
  onMerged: (info: MergeInfo, name: string) => void;
  onClose: () => void;
}

/** Lists the people who may be in the tree twice, likeliest first. */
export function DuplicatesDialog({ tree, onTree, onMerged, onClose }: DuplicatesDialogProps) {
  const [found, setFound] = useState<{ revision: number; list: DuplicateList } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ aId: string; bId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.findDuplicates().then(
      (list) => {
        if (!cancelled) setFound({ revision: tree.revision, list });
      },
      (failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tree.revision]);

  const list = found?.list ?? null;
  return (
    <Dialog title="Possible duplicates" onClose={onClose} testId="duplicates-dialog" wide>
      <p className="dialog-text">
        These are people who may be in the tree twice, judged by their names, dates, places and
        relatives. Nothing is merged until you compare two records and say so.
      </p>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list === null && error === null && (
        <p className="muted" data-testid="duplicates-looking">
          Comparing everyone in the tree…
        </p>
      )}
      {list !== null && (
        <>
          <p data-testid="duplicates-summary">
            {list.total === 0
              ? `No likely duplicates were found among ${countOf(list.persons, 'person', 'people')}.`
              : `${countOf(list.total, 'possible duplicate', 'possible duplicates')} among ${countOf(list.persons, 'person', 'people')}.`}
            {list.total > list.pairs.length && ` The ${list.pairs.length} likeliest are listed.`}
            {list.truncated &&
              ' The tree has so many people with the same surname that not every pair was compared.'}
          </p>
          {list.pairs.length > 0 && (
            <div className="scroll-box">
              <table className="table" data-testid="duplicates-list">
                <thead>
                  <tr>
                    <th scope="col">One record</th>
                    <th scope="col">The other</th>
                    <th scope="col">How likely</th>
                    <th scope="col">Why</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.pairs.map((pair) => (
                    <tr key={`${pair.a.id}|${pair.b.id}`} data-testid="duplicate-row">
                      <td>
                        {fullName(pair.a)} <span className="muted">{lifespan(pair.a)}</span>
                      </td>
                      <td>
                        {fullName(pair.b)} <span className="muted">{lifespan(pair.b)}</span>
                      </td>
                      <td data-testid="duplicate-score">
                        {likelihood(pair.score)} <span className="muted">({pair.score})</span>
                      </td>
                      <td>{pair.reasons.join('. ')}.</td>
                      <td className="row-actions">
                        <button
                          type="button"
                          onClick={() => setOpen({ aId: pair.a.id, bId: pair.b.id })}
                          data-testid="duplicate-compare"
                        >
                          Compare
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose} data-testid="duplicates-close">
          Close
        </button>
      </div>

      {open !== null && (
        <MergeDialog
          personId={open.aId}
          otherId={open.bId}
          suggested
          revision={tree.revision}
          onMerged={onMerged}
          onDismissed={onTree}
          onClose={() => setOpen(null)}
        />
      )}
    </Dialog>
  );
}
