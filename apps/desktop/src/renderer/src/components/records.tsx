import { describeDate, parseDate, type ExternalRecord, type PersonQuery } from '@rulz/core';
import { useEffect, useRef, useState } from 'react';
import type {
  PersonCitationInfo,
  RecordLinkInfo,
  RecordSearchProblem,
  RecordSearchSetup,
  RecordSourceInfo,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf } from '../format';
import { ClipDialog } from './citations';
import { Dialog, TextField } from './ui';

/**
 * The search for records of a person outside the tree. The form shows what is
 * sent, and nothing is sent before "Search" is pressed. The main process
 * decides whether a search may be made at all (see `main/records.ts`); this
 * window only says what it decided.
 *
 * A result can be attached to the person as a source with one click. For
 * sites the app does not search itself, a button opens a search in the
 * user's browser, and a page found there is cited by pasting its address.
 */

interface Form {
  given: string;
  surname: string;
  birthYear: string;
  deathYear: string;
}

/** What one source has answered so far. */
interface Found {
  items: ExternalRecord[];
  total: number | null;
  nextOffset: number | null;
  hidden: number;
  busy: boolean;
  problem: RecordSearchProblem | null;
}

const NOTHING: Found = {
  items: [],
  total: null,
  nextOffset: null,
  hidden: 0,
  busy: false,
  problem: null,
};

function formOf(query: PersonQuery): Form {
  return {
    given: query.given,
    surname: query.surname,
    birthYear: query.birthYear === null ? '' : String(query.birthYear),
    deathYear: query.deathYear === null ? '' : String(query.deathYear),
  };
}

/** A year as typed; null when the field is empty, undefined when it is no year. */
function yearOf(text: string): number | null | undefined {
  const typed = text.trim();
  if (typed === '') return null;
  return /^\d{1,4}$/.test(typed) && Number(typed) >= 1 ? Number(typed) : undefined;
}

/** A date of a record in the words the rest of the app uses for dates. */
function dateWords(date: string): string {
  const parsed = parseDate(date);
  return (parsed === null ? null : describeDate(parsed)) ?? date;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function problemWords(problem: RecordSearchProblem): string {
  return problem.kind === 'paused' && problem.retryAt !== null
    ? `${problem.message} It can be asked again at ${timeOf(problem.retryAt)}.`
    : problem.message;
}

interface ResultProps {
  record: ExternalRecord;
  attached: boolean;
  busy: boolean;
  onAttach: () => void;
}

function Result({ record, attached, busy, onAttach }: ResultProps) {
  return (
    <li data-testid="record-result">
      <span className="record-attach">
        {attached ? (
          <span className="badge" data-testid="record-attached">
            Attached as a source
          </span>
        ) : (
          <button type="button" onClick={onAttach} disabled={busy} data-testid="record-attach">
            Attach as a source
          </button>
        )}
      </span>
      <a href={record.url} target="_blank" rel="noreferrer" data-testid="record-link">
        {record.title}
      </a>
      {record.sex !== null && (
        <span className="muted"> {record.sex === 'M' ? 'male' : 'female'}</span>
      )}
      {record.facts.map((fact) => (
        <div key={fact.type} className="record-fact">
          {fact.type === 'birth' ? 'Born' : 'Died'}
          {fact.date !== '' && ` ${dateWords(fact.date)}`}
          {fact.place !== '' && `, ${fact.place}`}
        </div>
      ))}
    </li>
  );
}

interface SourceResultsProps {
  source: RecordSourceInfo;
  found: Found;
  /** The keys of the results the person's page cites. */
  attached: ReadonlySet<string>;
  /** The key of the result that is being attached; null when none is. */
  attaching: string | null;
  onAttach: (record: ExternalRecord) => void;
  onMore: () => void;
}

function SourceResults({
  source,
  found,
  attached,
  attaching,
  onAttach,
  onMore,
}: SourceResultsProps) {
  return (
    <section className="record-source" data-testid={`records-${source.id}`}>
      <h3>
        {source.name}
        {found.total !== null && (
          <span className="muted" data-testid="record-total">
            {' '}
            {countOf(found.total, 'result', 'results')}
          </span>
        )}
      </h3>
      {found.items.length > 0 && (
        <ol className="record-list">
          {found.items.map((record) => (
            <Result
              key={record.key}
              record={record}
              attached={attached.has(record.key)}
              busy={attaching !== null}
              onAttach={() => onAttach(record)}
            />
          ))}
        </ol>
      )}
      {found.total === 0 && <p className="muted">Nothing found.</p>}
      {found.hidden > 0 && (
        <p className="hint" data-testid="record-hidden">
          {countOf(found.hidden, 'result', 'results')} {found.hidden === 1 ? 'is' : 'are'} not
          shown: private profiles and profiles of living people.
        </p>
      )}
      {found.problem !== null && (
        <p className="error" role="alert" data-testid="record-problem">
          {problemWords(found.problem)}
        </p>
      )}
      {found.busy && <p className="muted">Searching…</p>}
      {found.nextOffset !== null && !found.busy && (
        <button type="button" onClick={onMore} data-testid="record-more">
          More results
        </button>
      )}
      <p className="hint">
        {source.attribution}.{' '}
        <a href={source.termsUrl} target="_blank" rel="noreferrer">
          Terms of use
        </a>
      </p>
    </section>
  );
}

interface RecordSearchDialogProps {
  personId: string;
  /** The person's name, for the title. */
  name: string;
  tree: TreeState;
  /** The citations on the person's page. */
  citations: PersonCitationInfo[];
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

const attachedKey = (sourceId: string, key: string) => `${sourceId}\n${key}`;

export function RecordSearchDialog({
  personId,
  name,
  tree,
  citations,
  onTree,
  onClose,
}: RecordSearchDialogProps) {
  const [setup, setSetup] = useState<RecordSearchSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(
    formOf({
      given: '',
      surname: '',
      birthYear: null,
      deathYear: null,
    }),
  );
  /** What was last sent, so that "More results" asks for more of the same. */
  const [sent, setSent] = useState<PersonQuery | null>(null);
  const [found, setFound] = useState<Record<string, Found>>({});
  /** Counts the searches, so that an answer to an older one is not shown. */
  const round = useRef(0);
  /** The results the person's page cites, as "source, key". */
  const [attached, setAttached] = useState<ReadonlySet<string>>(new Set());
  const [attaching, setAttaching] = useState<string | null>(null);
  /** What went wrong with attaching a result or opening a site. */
  const [problem, setProblem] = useState<string | null>(null);
  /** The form for a page found in the browser: at a site the app knows, or at any other. */
  const [clip, setClip] = useState<{ site: RecordLinkInfo | null } | null>(null);

  useEffect(() => {
    let current = true;
    api.getRecordSearch(personId).then(
      (loaded) => {
        if (!current) return;
        if (loaded === null) {
          setError('This person is no longer in the tree.');
          return;
        }
        setSetup(loaded);
        setForm(formOf(loaded.query));
      },
      (problem: unknown) => {
        if (current) setError(errorMessage(problem));
      },
    );
    return () => {
      current = false;
      // An answer that comes after the window has closed is not shown anywhere,
      // and a search that has not been sent yet is not sent.
      round.current += 1;
      void api.cancelRecordSearch().catch(() => undefined);
    };
  }, [personId]);

  const birthYear = yearOf(form.birthYear);
  const deathYear = yearOf(form.deathYear);
  const named = form.given.trim() !== '' || form.surname.trim() !== '';
  const ready = named && birthYear !== undefined && deathYear !== undefined;

  const ask = (query: PersonQuery, source: RecordSourceInfo, offset: number, mine: number) => {
    setFound((all) => ({
      ...all,
      [source.id]: {
        ...(offset === 0 ? NOTHING : (all[source.id] ?? NOTHING)),
        busy: true,
        problem: null,
      },
    }));
    const failed = (problem: RecordSearchProblem) =>
      setFound((all) => ({
        ...all,
        [source.id]: { ...(all[source.id] ?? NOTHING), busy: false, problem },
      }));
    api.searchRecords({ personId, sourceId: source.id, query, offset }).then(
      (result) => {
        if (round.current !== mine) return;
        if (!result.ok) {
          failed(result.problem);
          return;
        }
        setAttached((now) => {
          const next = new Set(now);
          for (const record of result.items) next.delete(attachedKey(source.id, record.key));
          for (const key of result.attached) next.add(attachedKey(source.id, key));
          return next;
        });
        setFound((all) => {
          const before = offset === 0 ? NOTHING : (all[source.id] ?? NOTHING);
          const known = new Set(before.items.map((record) => record.key));
          return {
            ...all,
            [source.id]: {
              items: [...before.items, ...result.items.filter((record) => !known.has(record.key))],
              total: result.total,
              nextOffset: result.nextOffset,
              hidden: before.hidden + result.hidden,
              busy: false,
              problem: null,
            },
          };
        });
      },
      (problem: unknown) => {
        if (round.current !== mine) return;
        failed({ kind: 'failed', message: errorMessage(problem), retryAt: null });
      },
    );
  };

  /** What the form asks for now; null while it cannot be sent. */
  const typed = (): PersonQuery | null =>
    !ready || birthYear === undefined || deathYear === undefined
      ? null
      : { given: form.given.trim(), surname: form.surname.trim(), birthYear, deathYear };

  const attach = (source: RecordSourceInfo, record: ExternalRecord) => {
    const key = attachedKey(source.id, record.key);
    setProblem(null);
    setAttaching(key);
    api
      .attachRecord({ personId, sourceId: source.id, key: record.key })
      .then(
        (result) => {
          if (!result.ok) {
            setProblem(result.problem.message);
            return;
          }
          onTree(result.tree);
          setAttached((now) => new Set(now).add(key));
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setAttaching(null));
  };

  const openLink = (link: RecordLinkInfo) => {
    const query = typed();
    if (query === null) return;
    setProblem(null);
    api.openRecordLink({ personId, linkId: link.id, query }).then(
      (result) => {
        if (!result.ok) setProblem(result.problem.message);
      },
      (failure: unknown) => setProblem(errorMessage(failure)),
    );
  };

  const search = () => {
    const query = typed();
    if (setup === null || query === null) return;
    setProblem(null);
    round.current += 1;
    setSent(query);
    setFound({});
    for (const source of setup.sources) ask(query, source, 0, round.current);
  };

  const agree = () => {
    api.agreeToRecordSearch().then(
      () => setSetup((now) => (now === null ? now : { ...now, agreed: true })),
      (problem: unknown) => setError(errorMessage(problem)),
    );
  };

  const sourceNames = setup?.sources.map((source) => source.name).join(', ') ?? '';
  const linkNames = setup?.links.map((link) => link.name).join(', ') ?? '';
  const set = (field: keyof Form) => (value: string) =>
    setForm((now) => ({ ...now, [field]: value }));

  return (
    <Dialog title={`Search records for ${name}`} onClose={onClose} testId="record-search" wide>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {setup === null && error === null && <p className="muted">Loading…</p>}

      {setup !== null && !setup.allowed && (
        <div data-testid="record-search-living">
          <p className="dialog-text">
            This person may be living, so the app does not search for them. Nothing about living
            people is sent to anyone.
          </p>
          <p className="hint">
            A person counts as possibly living unless they are marked as deceased, have a death or
            burial, or have an event more than 110 years ago.
          </p>
        </div>
      )}

      {setup !== null && setup.allowed && !setup.agreed && (
        <div data-testid="record-search-notice">
          <p className="dialog-text">
            A search asks other services on the internet. Before the first one:
          </p>
          <ul>
            <li>
              <strong>What is sent:</strong> the given name, the last name and the years of birth
              and death that the search form shows, and nothing else of your tree. You can change or
              empty each of them before you search.
            </li>
            <li>
              <strong>To whom:</strong> {sourceNames}. Like any website, a service also sees the
              internet address of your PC, and it has its own privacy rules.
            </li>
            <li>
              <strong>When:</strong> only when you press &quot;Search&quot;. Nothing is sent while
              you type, and nothing in the background.
            </li>
            <li>
              <strong>Other sites:</strong> {linkNames}. The app does not ask these itself. A button
              opens a search there in your own browser, and the same four fields are part of the
              address it opens. That site, and your browser&apos;s history, then hold them; if you
              are signed in there, the site knows who searched.
            </li>
            <li>
              <strong>Living people:</strong> the app does not search for a person who may be
              living, and it shows no profiles of living people.
            </li>
            <li>
              <strong>What is kept:</strong> results stay in the app&apos;s memory until the tree or
              the app closes. Nothing is added to your tree unless you attach a result.
            </li>
          </ul>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={agree} data-testid="record-agree">
              I understand
            </button>
          </div>
        </div>
      )}

      {setup !== null && setup.allowed && setup.agreed && (
        <>
          <form
            className="record-form"
            onSubmit={(event) => {
              event.preventDefault();
              search();
            }}
          >
            <TextField
              label="Given name"
              value={form.given}
              onChange={set('given')}
              maxLength={100}
              testId="record-given"
            />
            <TextField
              label="Last name"
              value={form.surname}
              onChange={set('surname')}
              maxLength={100}
              testId="record-surname"
            />
            <TextField
              label="Born in (year)"
              value={form.birthYear}
              onChange={set('birthYear')}
              maxLength={4}
              testId="record-birth"
              hint={
                birthYear === undefined ? <p className="error">A year, such as 1850.</p> : undefined
              }
            />
            <TextField
              label="Died in (year)"
              value={form.deathYear}
              onChange={set('deathYear')}
              maxLength={4}
              testId="record-death"
              hint={
                deathYear === undefined ? <p className="error">A year, such as 1910.</p> : undefined
              }
            />
            <p className="hint" data-testid="record-sends">
              &quot;Search&quot; sends these four fields to {sourceNames}, and nothing else. A
              record may lie up to two years from a year given.
            </p>
            <button
              type="submit"
              className="primary"
              disabled={!ready}
              data-testid="record-search-go"
            >
              Search
            </button>
          </form>

          {problem !== null && (
            <p className="error" role="alert" data-testid="record-action-problem">
              {problem}
            </p>
          )}

          {sent !== null &&
            setup.sources.map((source) => (
              <SourceResults
                key={source.id}
                source={source}
                found={found[source.id] ?? NOTHING}
                attached={
                  new Set(
                    (found[source.id]?.items ?? [])
                      .filter((record) => attached.has(attachedKey(source.id, record.key)))
                      .map((record) => record.key),
                  )
                }
                attaching={attaching}
                onAttach={(record) => attach(source, record)}
                onMore={() => {
                  const offset = found[source.id]?.nextOffset;
                  if (offset !== null && offset !== undefined)
                    ask(sent, source, offset, round.current);
                }}
              />
            ))}

          <section className="record-source" data-testid="record-links">
            <h3>Other sites</h3>
            <p className="hint">
              The app does not search these sites itself. A button opens a search for the four
              fields above in your browser, at the site. A page you find there, or anywhere else,
              becomes a source when you paste its address here.
            </p>
            <ul className="record-links">
              {setup.links.map((link) => (
                <li key={link.id}>
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => openLink(link)}
                    data-testid={`record-open-${link.id}`}
                  >
                    Search at {link.name} in your browser
                  </button>
                  <button
                    type="button"
                    onClick={() => setClip({ site: link })}
                    data-testid={`record-clip-${link.id}`}
                  >
                    Cite a page you found there
                  </button>
                  <a href={link.termsUrl} target="_blank" rel="noreferrer">
                    Terms of use
                  </a>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setClip({ site: null })} data-testid="record-clip">
              Cite a page of another site
            </button>
          </section>
        </>
      )}

      {clip !== null && (
        <ClipDialog
          personId={personId}
          name={name}
          site={clip.site}
          anySource={tree.sources > 0}
          citations={citations}
          onTree={onTree}
          onClose={() => setClip(null)}
        />
      )}

      {!(setup !== null && setup.allowed && !setup.agreed) && (
        <div className="dialog-actions">
          <button type="button" onClick={onClose} data-testid="record-search-close">
            Close
          </button>
        </div>
      )}
    </Dialog>
  );
}
