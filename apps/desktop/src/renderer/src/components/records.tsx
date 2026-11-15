import {
  TEXT_QUERY_MAX,
  US_STATES,
  textQueryProblem,
  type ExternalRecord,
  type PersonQuery,
  type TextQuery,
} from '@rulz/core';
import { useEffect, useRef, useState } from 'react';
import { CENSUS_PACK_KIND, type PackInfo } from '../../../shared/ipc';
import type {
  PersonCitationInfo,
  RecordFitInfo,
  RecordLinkInfo,
  RecordSearchProblem,
  RecordSearchSetup,
  RecordSourceInfo,
  RecordSourceKeyTest,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf } from '../format';
import { ClipDialog } from './citations';
import { CensusPanel } from './census';
import { RecordCompareDialog, dateWords, fitWhy, fitWords } from './recordcompare';
import { Dialog, TextField } from './ui';

/**
 * The search for records of a person outside the tree. The form shows what is
 * sent, and nothing is sent before "Search" is pressed. The main process
 * decides whether a search may be made at all (see `main/records.ts`); this
 * window only says what it decided.
 *
 * There are two forms. One asks sources that keep people for a person: a
 * name and two years. The other asks sources of newspapers and books for
 * words, which start as the person's name, and for the years they were
 * printed in. Each form says which source is sent what.
 *
 * A result can be attached to the person as a source with one click, and a
 * result that is a person or a record of one can be set beside the person
 * of the tree (see `recordcompare.tsx`). A result can be kept to look at
 * later, which puts it into the inbox (see `recordinbox.tsx`), or turned
 * down for this person, after which it is left out unless the user asks to
 * see what they turned down. For
 * sites the app does not search itself, a button opens a search in the
 * user's browser, and a page found there is cited by pasting its address.
 */

interface Form {
  given: string;
  surname: string;
  birthYear: string;
  deathYear: string;
}

/** The form for newspapers and books, as typed. */
interface TextForm {
  words: string;
  phrase: boolean;
  fromYear: string;
  toYear: string;
  state: string;
}

const NO_TEXT: TextQuery = { words: '', phrase: true, fromYear: null, toYear: null, state: '' };

function textFormOf(query: TextQuery): TextForm {
  return {
    words: query.words,
    phrase: query.phrase,
    fromYear: query.fromYear === null ? '' : String(query.fromYear),
    toYear: query.toYear === null ? '' : String(query.toYear),
    state: query.state,
  };
}

/**
 * What one source of newspapers and books is sent. The state is for the
 * Library of Congress only, so Papers Past, Trove and the other sources are
 * not sent it.
 */
function textSentTo(source: RecordSourceInfo, query: TextQuery): TextQuery {
  return source.id === 'loc' ? query : { ...query, state: '' };
}

/** What a search asks for: a person, or words. */
type Asked = { kind: 'person'; query: PersonQuery } | { kind: 'text'; query: TextQuery };

/** What the user decided about a result for this person. */
type Mark = 'kept' | 'declined';

/** What one source has answered so far. */
interface Found {
  items: ExternalRecord[];
  /** How well each result fits the person of the tree, by its key. */
  fits: Record<string, RecordFitInfo>;
  /** The results that are kept for this person or were turned down for them, by their key. */
  marks: Record<string, Mark>;
  total: number | null;
  nextOffset: number | null;
  hidden: number;
  busy: boolean;
  problem: RecordSearchProblem | null;
}

const NOTHING: Found = {
  items: [],
  fits: {},
  marks: {},
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

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function problemWords(problem: RecordSearchProblem): string {
  return problem.kind === 'paused' && problem.retryAt !== null
    ? `${problem.message} It can be asked again at ${timeOf(problem.retryAt)}.`
    : problem.message;
}

/** What turning a result down is called: a text is about someone, a record is of someone. */
export function declineWords(record: ExternalRecord): string {
  return record.kind === 'text' ? 'Not about this person' : 'Not this person';
}

/** What a record says, in the lines under its title. */
export function RecordLines({ record }: { record: ExternalRecord }) {
  return (
    <>
      {record.kind === 'person' && record.about !== '' && (
        <div className="record-fact" data-testid="record-about">
          {record.about}
        </div>
      )}
      {record.kind === 'event' && (
        <>
          <div className="record-fact" data-testid="record-event">
            {[
              record.role,
              [record.event, record.date === '' ? '' : dateWords(record.date), record.place]
                .filter((part) => part !== '')
                .join(', '),
            ]
              .filter((part) => part !== '')
              .join(' in: ')}
          </div>
          {record.held !== '' && <div className="record-fact muted">{record.held}</div>}
        </>
      )}
      {record.kind === 'person' &&
        record.facts.map((fact) => (
          <div key={fact.type} className="record-fact">
            {fact.type === 'birth' ? 'Born' : 'Died'}
            {fact.date !== '' && ` ${dateWords(fact.date)}`}
            {fact.place !== '' && `, ${fact.place}`}
          </div>
        ))}
      {record.kind === 'text' &&
        (record.about !== '' || record.by !== '' || record.date !== '') && (
          <div className="record-fact" data-testid="record-print">
            {[
              record.about,
              record.by,
              record.date === ''
                ? ''
                : // What an archive holds is dated; a newspaper or a book is published.
                  record.about !== ''
                  ? dateWords(record.date)
                  : `published ${dateWords(record.date)}`,
            ]
              .filter((part) => part !== '')
              .join(', ')}
          </div>
        )}
    </>
  );
}

interface RecordNoticeProps {
  /** Every source the app can ask, with what each is sent. */
  sources: RecordSourceInfo[];
  /** The sites a search is opened at in the browser. */
  links: RecordLinkInfo[];
  onAgree: () => void;
  onClose: () => void;
}

/**
 * What a search sends, to whom and when: shown before the first search, and
 * again when it has more to say. The search for one person and the search
 * for several people show the same notice, and one agreement covers both.
 */
export function RecordNotice({ sources, links, onAgree, onClose }: RecordNoticeProps) {
  return (
    <div data-testid="record-search-notice">
      <p className="dialog-text">
        A search asks other services on the internet. Before the first one:
      </p>
      <ul>
        <li>
          <strong>What is sent, and to whom:</strong> what the search forms show, and nothing else
          of your tree. You can change or empty each field before you search.
          <ul data-testid="record-notice-sources">
            {sources.map((source) => (
              <li key={source.id}>
                {source.name}: {source.asks}.
              </li>
            ))}
          </ul>
          Words and years go to DigitalNZ (New Zealand) for Papers Past, with your key if one is
          saved, which tells DigitalNZ whose search it is. Words, years and your key go to Trove
          (Australia).
        </li>
        <li>
          <strong>What you type is sent as you type it.</strong> The forms start with the name and
          the years of this person. Words you add, such as another name or a place, go to the
          service too.
        </li>
        <li data-testid="record-notice-several">
          <strong>Several people in one go:</strong> &quot;Search for ancestors&quot; asks for a
          person and their direct ancestors with one press. Before that press it lists everyone it
          will ask for, with the name and the years that are sent for each as your tree has them,
          and the services it will ask. It asks WikiTree and Open Archives only, and only those you
          tick.
        </li>
        <li>
          <strong>What a service sees besides:</strong> like any website, the internet address of
          your PC. Each service has its own privacy rules.
        </li>
        <li>
          <strong>1950 census pages:</strong> viewing a page asks the National Archives bucket
          nara-1950-census.s3.us-east-2.amazonaws.com for that page, and nothing about the person.
        </li>
        <li>
          <strong>When:</strong> only when you press &quot;Search&quot;, or &quot;Start&quot; in a
          search for ancestors. Nothing is sent while you type, and nothing in the background: a
          search for ancestors ends when you close its window.
        </li>
        <li>
          <strong>Other sites:</strong> {links.map((link) => link.name).join(', ')}. The app does
          not ask these itself. A button opens a search there in your own browser, and the name of
          the person, and for some sites their years, are part of the address it opens. That site,
          and your browser&apos;s history, then hold them; if you are signed in there, the site
          knows who searched. The Geni link carries the first and the last name to the browser.
        </li>
        <li>
          <strong>Living people:</strong> the app does not search for a person who may be living,
          and it shows no profiles of living people.
        </li>
        <li>
          <strong>What is kept:</strong> results stay in the app&apos;s memory until the tree or the
          app closes. Nothing is added to your tree unless you attach a result, keep it for later or
          turn it down; what you keep or turn down is saved in the tree&apos;s file, and goes where
          the tree&apos;s folder goes. The app notes when it asked each service, and until when a
          service asked to be left alone, so that it does not ask too often; it does not note what
          was asked. A snippet of an article is shown and is not kept. A citation, or a result you
          keep, keeps the heading, the newspaper, the date, the page and the link.
        </li>
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onAgree} data-testid="record-agree">
          I understand
        </button>
      </div>
    </div>
  );
}

export interface ResultProps {
  record: ExternalRecord;
  /** How well the result fits the person; undefined for a text, which is not held against them. */
  fit: RecordFitInfo | undefined;
  /** Whether the result is kept for this person, or was turned down for them. */
  mark: Mark | undefined;
  attached: boolean;
  busy: boolean;
  onAttach: () => void;
  onCompare: () => void;
  onKeep: () => void;
  onDecline: () => void;
  /** Takes a turning-down back. */
  onAllow: () => void;
}

/** One result of a search, with what can be done with it. */
export function Result({
  record,
  fit,
  mark,
  attached,
  busy,
  onAttach,
  onCompare,
  onKeep,
  onDecline,
  onAllow,
}: ResultProps) {
  return (
    <li data-testid="record-result">
      <a href={record.url} target="_blank" rel="noreferrer" data-testid="record-link">
        {record.title}
      </a>
      {fit !== undefined && (
        <span className={`badge fit fit-${fit.band}`} data-testid="record-fit">
          {fitWords(fit)}
        </span>
      )}
      {record.kind === 'person' && record.sex !== null && (
        <span className="muted"> {record.sex === 'M' ? 'male' : 'female'}</span>
      )}
      {record.kind === 'text' && record.excerpt !== undefined && record.excerpt.trim() !== '' && (
        <div className="record-fact" data-testid="record-excerpt">
          {record.excerpt}
        </div>
      )}
      {fit !== undefined && fitWhy(fit) !== '' && (
        <div className="record-fact muted" data-testid="record-fit-why">
          {fitWhy(fit)}
        </div>
      )}
      <RecordLines record={record} />
      <div className="record-actions">
        {mark === 'declined' ? (
          <>
            <span className="badge" data-testid="record-declined">
              Turned down
            </span>{' '}
            <button type="button" onClick={onAllow} disabled={busy} data-testid="record-allow">
              Allow again
            </button>
          </>
        ) : (
          <>
            {record.kind !== 'text' && (
              <button type="button" onClick={onCompare} data-testid="record-compare-open">
                Compare
              </button>
            )}{' '}
            {mark === 'kept' ? (
              <span className="badge" data-testid="record-kept">
                Kept for later
              </span>
            ) : (
              <button type="button" onClick={onKeep} disabled={busy} data-testid="record-keep">
                Keep for later
              </button>
            )}{' '}
            <button type="button" onClick={onDecline} disabled={busy} data-testid="record-decline">
              {declineWords(record)}
            </button>{' '}
            {attached ? (
              <span className="badge" data-testid="record-attached">
                Attached as a source
              </span>
            ) : (
              <button type="button" onClick={onAttach} disabled={busy} data-testid="record-attach">
                Attach as a source
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

/** Keep a result for later, turn it down, or take a turning-down back. */
type MarkAction = 'keep' | 'decline' | 'allow';

/**
 * The page Trove's terms ask an app to link where its results are shown.
 * A fixed address, not one taken from a result or from the source's data.
 */
const TROVE_CREDIT_URL = 'https://trove.nla.gov.au/';

/** The credit, ending in one full stop. A credit that already ends in one is left as it is. */
function creditLine(attribution: string): string {
  const trimmed = attribution.trim();
  if (/[!?]$/.test(trimmed)) return trimmed;
  const text = trimmed.replace(/\.+$/, '');
  return text === '' ? '' : `${text}.`;
}

/** The credit line. Where it names Trove, that word links to Trove's own site. */
function CreditWords({ source }: { source: RecordSourceInfo }) {
  const text = creditLine(source.attribution);
  if (source.id !== 'trove') return text;
  const at = text.indexOf('Trove');
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <a href={TROVE_CREDIT_URL} target="_blank" rel="noreferrer">
        Trove
      </a>
      {text.slice(at + 'Trove'.length)}
    </>
  );
}

interface SourceResultsProps {
  source: RecordSourceInfo;
  found: Found;
  /** The keys of the results the person's page cites. */
  attached: ReadonlySet<string>;
  /** The key of the result that is being attached or marked; null when none is. */
  attaching: string | null;
  onAttach: (record: ExternalRecord) => void;
  onCompare: (record: ExternalRecord) => void;
  onMark: (record: ExternalRecord, action: MarkAction) => void;
  onMore: () => void;
}

function SourceResults({
  source,
  found,
  attached,
  attaching,
  onAttach,
  onCompare,
  onMark,
  onMore,
}: SourceResultsProps) {
  /** Whether what was turned down for this person is shown all the same. */
  const [showDeclined, setShowDeclined] = useState(false);
  const declined = found.items.filter((record) => found.marks[record.key] === 'declined').length;
  const visible = found.items.filter(
    (record) => showDeclined || found.marks[record.key] !== 'declined',
  );
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
      {visible.length > 0 && (
        <ol className="record-list">
          {visible.map((record) => (
            <Result
              key={record.key}
              record={record}
              fit={found.fits[record.key]}
              mark={found.marks[record.key]}
              attached={attached.has(record.key)}
              busy={attaching !== null}
              onAttach={() => onAttach(record)}
              onCompare={() => onCompare(record)}
              onKeep={() => onMark(record, 'keep')}
              onDecline={() => onMark(record, 'decline')}
              onAllow={() => onMark(record, 'allow')}
            />
          ))}
        </ol>
      )}
      {declined > 0 && (
        <p className="hint" data-testid="record-declined-count">
          {countOf(declined, 'result', 'results')} you turned down for this person{' '}
          {declined === 1 ? 'is' : 'are'} {showDeclined ? 'shown too' : 'not shown'}.{' '}
          <button
            type="button"
            className="small"
            onClick={() => setShowDeclined((now) => !now)}
            data-testid="record-declined-show"
          >
            {showDeclined ? 'Hide' : 'Show'}
          </button>
        </p>
      )}
      {found.total === 0 && <p className="muted">Nothing found.</p>}
      {source.searches === 'person' && found.items.length > 0 && (
        <p className="hint" data-testid="record-fit-hint">
          The labels hold each result against this person in your tree: the name, the years and the
          places. They help with reading and prove nothing; open a record to judge it.
        </p>
      )}
      {source.searches === 'text' && found.items.length > 0 && (
        <p className="hint">
          Found by the words alone. Whether a text is about this person is for you to read.
        </p>
      )}
      {found.hidden > 0 && (
        <p className="hint" data-testid="record-hidden">
          {countOf(found.hidden, 'result', 'results')} {found.hidden === 1 ? 'is' : 'are'} not
          shown: private profiles, and people who may be living.
        </p>
      )}
      {found.problem !== null && (
        <p className="error" role="alert" data-testid="record-problem">
          {problemWords(found.problem)}
        </p>
      )}
      {found.busy && (
        <p className="muted" data-testid="record-busy">
          Searching…
          {source.slowSeconds !== null &&
            ` This service can take a while; the app waits up to ${source.slowSeconds} seconds.`}
        </p>
      )}
      {found.nextOffset !== null && !found.busy && (
        <button type="button" onClick={onMore} data-testid="record-more">
          More results
        </button>
      )}
      <p className="hint" data-testid="record-credit">
        <CreditWords source={source} />{' '}
        <a href={source.termsUrl} target="_blank" rel="noreferrer">
          Terms of use
        </a>
      </p>
    </section>
  );
}

interface SourceKeyProps {
  source: RecordSourceInfo;
  /** The sources as they stand after the key was saved or removed. */
  onSources: (sources: RecordSourceInfo[]) => void;
}

/**
 * The user's own key for a source that asks with one. The key is typed here
 * once and handed to the main process, which keeps it encrypted; this window
 * is never given it back, only told whether one is saved. A source that works
 * without a key is ready while none is saved. One that requires a key is off
 * until one is added.
 */
function SourceKey({ source, onSources }: SourceKeyProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** What a test of the saved key said. The key itself is not in it. */
  const [tested, setTested] = useState<Pick<RecordSourceKeyTest, 'outcome' | 'message'> | null>(
    null,
  );
  const fits = /^[\x21-\x7e]{8,300}$/.test(typed.trim());
  const keyPage = source.keyUrl ?? source.termsUrl;

  const done = (
    result: Promise<{ ok: true; sources: RecordSourceInfo[] } | { ok: false; message: string }>,
  ) => {
    setBusy(true);
    setProblem(null);
    setTested(null);
    result
      .then(
        (answer) => {
          if (!answer.ok) {
            setProblem(answer.message);
            return;
          }
          onSources(answer.sources);
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setBusy(false));
  };

  const save = () => {
    const key = typed.trim();
    // The field is emptied at once: the key is not kept in this window.
    setTyped('');
    done(api.setRecordSourceKey({ sourceId: source.id, key }));
  };

  /** Asks the main process to try the saved key. The key never comes back here. */
  const testKey = () => {
    setBusy(true);
    setProblem(null);
    setTested(null);
    api
      .testRecordSourceKey(source.id)
      .then(
        (answer) => {
          onSources(answer.sources);
          setTested({ outcome: answer.outcome, message: answer.message });
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setBusy(false));
  };

  const quota = source.quota;
  /** The count shown is the keyless one: no key of the user's own is saved. */
  const keyless = source.keyOptional && (source.key === 'missing' || source.key === 'unavailable');
  const howTo = (
    <a href={keyPage} target="_blank" rel="noreferrer">
      How to ask for one
    </a>
  );
  return (
    <div className="record-key" data-testid={`record-key-${source.id}`}>
      {source.keyOptional && source.key === 'missing' ? (
        <p data-testid="record-key-state">
          <strong>{source.name}</strong> is ready. Add your own free key. Without one, Papers Past
          is asked through a free allowance shared by everyone, which can run out. {howTo}
        </p>
      ) : source.key === 'missing' ? (
        <p data-testid="record-key-state">
          {source.name} is off until you add a key. It needs a key of your own, which the service
          gives out for free. {howTo}
        </p>
      ) : (
        <>
          <strong>{source.name}</strong>{' '}
          {source.keyOptional
            ? 'can take a key of your own, which the service gives out for free.'
            : 'needs a key of your own, which the service gives out for free.'}{' '}
          {howTo}
        </>
      )}
      {source.key === 'saved' && (
        <p data-testid="record-key-state">
          A key is saved, encrypted by Windows for your account. The app does not show it again.{' '}
          <button type="button" disabled={busy} onClick={testKey} data-testid="record-key-test">
            Test the key
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => done(api.removeRecordSourceKey(source.id))}
            data-testid="record-key-remove"
          >
            Remove the key
          </button>
        </p>
      )}
      {source.key === 'unreadable' && (
        <p className="error" data-testid="record-key-state">
          The key that was saved cannot be read on this Windows account. Enter it again.
        </p>
      )}
      {source.key === 'unavailable' && (
        <p className="error" data-testid="record-key-state">
          This PC cannot encrypt a key for your Windows account, so the app does not save one.
        </p>
      )}
      {(source.key === 'missing' || source.key === 'unreadable') && (
        <form
          className="record-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (fits && !busy) save();
          }}
        >
          <label htmlFor={`record-key-input-${source.id}`}>Your key</label>
          <input
            id={`record-key-input-${source.id}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={300}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            data-testid="record-key-input"
          />
          <button type="submit" disabled={!fits || busy} data-testid="record-key-save">
            Save the key
          </button>
        </form>
      )}
      {problem !== null && (
        <p className="error" role="alert" data-testid="record-key-problem">
          {problem}
        </p>
      )}
      {tested !== null && (
        <p
          className={tested.outcome === 'accepted' ? 'hint' : 'error'}
          role={tested.outcome === 'accepted' ? 'status' : 'alert'}
          data-testid="record-key-tested"
        >
          {tested.message}
        </p>
      )}
      {quota !== null && (
        <p className="hint" data-testid="record-quota">
          Asked {quota.used.toLocaleString()} of {quota.ceiling.toLocaleString()} times this{' '}
          {keyless ? `${quota.period} without a key of your own` : quota.period}, as this app counts
          it. Every search, and every &quot;More results&quot;, is one.{' '}
          {keyless
            ? 'This is as often as the app asks on this PC without a key of your own.'
            : 'The service allows a little more; the app keeps the rest in hand.'}
        </p>
      )}
    </div>
  );
}

interface SourceListProps {
  sources: RecordSourceInfo[];
  found: Record<string, Found>;
  /** The results the person's page cites, as "source, key". */
  attached: ReadonlySet<string>;
  attaching: string | null;
  onAttach: (source: RecordSourceInfo, record: ExternalRecord) => void;
  onCompare: (source: RecordSourceInfo, record: ExternalRecord) => void;
  onMark: (source: RecordSourceInfo, record: ExternalRecord, action: MarkAction) => void;
  onMore: (source: RecordSourceInfo, offset: number) => void;
}

/** The results of the sources of one form, each under the name of its source. */
function SourceList({
  sources,
  found,
  attached,
  attaching,
  onAttach,
  onCompare,
  onMark,
  onMore,
}: SourceListProps) {
  return (
    <>
      {sources.map((source) => (
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
          onAttach={(record) => onAttach(source, record)}
          onCompare={(record) => onCompare(source, record)}
          onMark={(record, action) => onMark(source, record, action)}
          onMore={() => {
            const offset = found[source.id]?.nextOffset;
            if (offset !== null && offset !== undefined) onMore(source, offset);
          }}
        />
      ))}
    </>
  );
}

const attachedKey = (sourceId: string, key: string) => `${sourceId}\n${key}`;

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

export function RecordSearchDialog({
  personId,
  name,
  tree,
  citations,
  onTree,
  onClose,
}: RecordSearchDialogProps) {
  const [setup, setSetup] = useState<RecordSearchSetup | null>(null);
  const [censusPacks, setCensusPacks] = useState<PackInfo[]>([]);
  const [censusNotice, setCensusNotice] = useState(false);
  useEffect(() => {
    let current = true;
    void api.getPacks().then(
      (result) => {
        if (current)
          setCensusPacks(
            result.packs.filter((pack) => pack.kind === CENSUS_PACK_KIND && pack.state === 'ready'),
          );
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(
    formOf({
      given: '',
      surname: '',
      birthYear: null,
      deathYear: null,
    }),
  );
  const [textForm, setTextForm] = useState<TextForm>(textFormOf(NO_TEXT));
  /** What was last sent, so that "More results" asks for more of the same. */
  const [sent, setSent] = useState<PersonQuery | null>(null);
  const [sentText, setSentText] = useState<TextQuery | null>(null);
  const [found, setFound] = useState<Record<string, Found>>({});
  /** Counts the searches of each form, so that an answer to an older one is not shown. */
  const round = useRef({ person: 0, text: 0 });
  /** The results the person's page cites, as "source, key". */
  const [attached, setAttached] = useState<ReadonlySet<string>>(new Set());
  const [attaching, setAttaching] = useState<string | null>(null);
  /** What went wrong with attaching a result or opening a site. */
  const [problem, setProblem] = useState<string | null>(null);
  /** The form for a page found in the browser: at a site the app knows, or at any other. */
  const [clip, setClip] = useState<{ site: RecordLinkInfo | null } | null>(null);
  /** The result that is set beside the person; null when none is. */
  const [comparing, setComparing] = useState<{ sourceId: string; key: string } | null>(null);

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
        setTextForm(textFormOf(loaded.text));
      },
      (problem: unknown) => {
        if (current) setError(errorMessage(problem));
      },
    );
    return () => {
      current = false;
      // An answer that comes after the window has closed is not shown anywhere,
      // and a search that has not been sent yet is not sent.
      round.current = { person: round.current.person + 1, text: round.current.text + 1 };
      void api.cancelRecordSearch().catch(() => undefined);
    };
  }, [personId]);

  const birthYear = yearOf(form.birthYear);
  const deathYear = yearOf(form.deathYear);
  const named = form.given.trim() !== '' || form.surname.trim() !== '';
  const ready = named && birthYear !== undefined && deathYear !== undefined;

  const fromYear = yearOf(textForm.fromYear);
  const toYear = yearOf(textForm.toYear);
  /** What the form for newspapers and books asks for now; null while a year is no year. */
  const typedText: TextQuery | null =
    fromYear === undefined || toYear === undefined
      ? null
      : {
          words: textForm.words.trim(),
          phrase: textForm.phrase,
          fromYear,
          toYear,
          state: textForm.state,
        };
  const textProblem = typedText === null ? null : textQueryProblem(typedText);
  const textReady = typedText !== null && typedText.words !== '' && textProblem === null;

  /** Reads the sources again: whether a key is saved, and how often a source was asked. */
  const refreshSources = () => {
    api.getRecordSearch(personId).then(
      (loaded) => {
        if (loaded !== null) setSources(loaded.sources);
      },
      () => undefined,
    );
  };
  const setSources = (sources: RecordSourceInfo[]) =>
    setSetup((now) => (now === null ? now : { ...now, sources }));

  const ask = (asked: Asked, source: RecordSourceInfo, offset: number, mine: number) => {
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
    const request = { personId, sourceId: source.id, offset };
    const answer =
      asked.kind === 'person'
        ? api.searchRecords({ ...request, query: asked.query })
        : api.searchRecordTexts({ ...request, query: asked.query });
    answer.then(
      (result) => {
        if (round.current[asked.kind] !== mine) return;
        // A source that counts what it is asked has been asked once more,
        // whether or not it answered.
        if (source.quota !== null) refreshSources();
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
          // A result that comes again with a later page is shown as it came
          // last. The main process holds that copy, and it is the one that is
          // kept, compared or attached: what is shown must be the same.
          const latest = new Map(result.items.map((record) => [record.key, record]));
          return {
            ...all,
            [source.id]: {
              items: [
                ...before.items.map((record) => latest.get(record.key) ?? record),
                ...result.items.filter((record) => !known.has(record.key)),
              ],
              // And with the label of that copy.
              fits: {
                ...Object.fromEntries(
                  Object.entries(before.fits).filter(([key]) => !latest.has(key)),
                ),
                ...result.fits,
              },
              marks: {
                ...before.marks,
                ...Object.fromEntries(result.marks.kept.map((key) => [key, 'kept' as const])),
                ...Object.fromEntries(
                  result.marks.declined.map((key) => [key, 'declined' as const]),
                ),
              },
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
        if (round.current[asked.kind] !== mine) return;
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

  const compare = (source: RecordSourceInfo, record: ExternalRecord) => {
    setProblem(null);
    setComparing({ sourceId: source.id, key: record.key });
  };

  /** Keeps a result for later, turns it down for this person, or takes a turning-down back. */
  const mark = (source: RecordSourceInfo, record: ExternalRecord, action: MarkAction) => {
    const request = { personId, sourceId: source.id, key: record.key };
    setProblem(null);
    setAttaching(attachedKey(source.id, record.key));
    (action === 'keep'
      ? api.keepRecord(request)
      : action === 'decline'
        ? api.declineRecord(request)
        : api.unmarkRecord(request)
    )
      .then(
        (result) => {
          if (!result.ok) {
            setProblem(result.problem.message);
            return;
          }
          onTree(result.tree);
          setFound((all) => {
            const now = all[source.id];
            if (now === undefined) return all;
            const marks = Object.fromEntries(
              Object.entries(now.marks).filter(([key]) => key !== record.key),
            );
            if (action !== 'allow') marks[record.key] = action === 'keep' ? 'kept' : 'declined';
            return { ...all, [source.id]: { ...now, marks } };
          });
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
    round.current.person += 1;
    setSent(query);
    for (const source of personSources) {
      ask({ kind: 'person', query }, source, 0, round.current.person);
    }
  };

  const searchTexts = () => {
    if (setup === null || typedText === null || !textReady) return;
    setProblem(null);
    round.current.text += 1;
    setSentText(typedText);
    for (const source of textSources) {
      ask({ kind: 'text', query: textSentTo(source, typedText) }, source, 0, round.current.text);
    }
  };

  const agree = () => {
    api.agreeToRecordSearch().then(
      () => {
        setCensusNotice(false);
        setSetup((now) => (now === null ? now : { ...now, agreed: true }));
      },
      (problem: unknown) => setError(errorMessage(problem)),
    );
  };

  const personSources = setup?.sources.filter((source) => source.searches === 'person') ?? [];
  const textSources = setup?.sources.filter((source) => source.searches === 'text') ?? [];
  const set = (field: keyof Form) => (value: string) =>
    setForm((now) => ({ ...now, [field]: value }));
  const setText = (field: 'words' | 'fromYear' | 'toYear' | 'state') => (value: string) =>
    setTextForm((now) => ({ ...now, [field]: value }));

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

      {setup !== null && ((setup.allowed && !setup.agreed) || censusNotice) && (
        <RecordNotice
          sources={setup.sources}
          links={setup.links}
          onAgree={agree}
          onClose={setup.allowed && !setup.agreed ? onClose : () => setCensusNotice(false)}
        />
      )}

      {setup !== null && setup.allowed && setup.agreed && (
        <div hidden={censusNotice}>
          <h3>People</h3>
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
              &quot;Search&quot; sends what this form shows, and nothing else:
            </p>
            <ul className="hint record-asks" data-testid="record-person-asks">
              {personSources.map((source) => (
                <li key={source.id}>
                  {source.name}: {source.asks}.
                </li>
              ))}
            </ul>
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
          {(sent !== null || sentText !== null) && (
            <p className="hint" data-testid="record-mark-hint">
              &quot;Keep for later&quot; puts a result into the inbox, which the bar at the top of
              the window opens. A result you turn down is left out of later searches for this
              person. Both are saved in your tree&apos;s file; nothing is sent for either.
            </p>
          )}

          {sent !== null && (
            <SourceList
              sources={personSources}
              found={found}
              attached={attached}
              attaching={attaching}
              onAttach={attach}
              onCompare={compare}
              onMark={mark}
              onMore={(source, offset) =>
                ask({ kind: 'person', query: sent }, source, offset, round.current.person)
              }
            />
          )}

          <h3>Newspapers, books and archives</h3>
          <form
            className="record-form"
            data-testid="record-text-form"
            onSubmit={(event) => {
              event.preventDefault();
              searchTexts();
            }}
          >
            <TextField
              label="Words"
              value={textForm.words}
              onChange={setText('words')}
              maxLength={TEXT_QUERY_MAX}
              testId="record-words"
            />
            <label className="record-check">
              <input
                type="checkbox"
                checked={textForm.phrase}
                onChange={(event) =>
                  setTextForm((now) => ({ ...now, phrase: event.target.checked }))
                }
                data-testid="record-phrase"
              />{' '}
              These words together, in this order
            </label>
            <TextField
              label="Printed from (year)"
              value={textForm.fromYear}
              onChange={setText('fromYear')}
              maxLength={4}
              testId="record-from"
              hint={
                fromYear === undefined ? <p className="error">A year, such as 1850.</p> : undefined
              }
            />
            <TextField
              label="Printed until (year)"
              value={textForm.toYear}
              onChange={setText('toYear')}
              maxLength={4}
              testId="record-to"
              hint={
                toYear === undefined ? <p className="error">A year, such as 1911.</p> : undefined
              }
            />
            <div className="field">
              <label htmlFor="record-state">
                Newspapers of (state) <span className="muted">Library of Congress only</span>
              </label>
              <select
                id="record-state"
                value={textForm.state}
                onChange={(event) => setText('state')(event.target.value)}
                data-testid="record-state"
              >
                <option value="">Any state</option>
                {US_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </div>
            {textProblem !== null && (
              <p className="error" role="alert" data-testid="record-text-problem">
                {textProblem}
              </p>
            )}
            <div className="hint" data-testid="record-text-sends">
              &quot;Search&quot; sends what this form shows, and nothing else:
              <ul>
                {textSources.map((source) => (
                  <li key={source.id}>
                    {source.name}: {source.asks}.
                  </li>
                ))}
              </ul>
              The years start as the year of birth and the year after the death, which is when a
              newspaper may still write about a death.
            </div>
            <button
              type="submit"
              className="primary"
              disabled={!textReady}
              data-testid="record-text-go"
            >
              Search
            </button>
          </form>

          {textSources
            .filter((source) => source.key !== 'none')
            .map((source) => (
              <SourceKey key={source.id} source={source} onSources={setSources} />
            ))}

          {sentText !== null && (
            <SourceList
              sources={textSources}
              found={found}
              attached={attached}
              attaching={attaching}
              onAttach={attach}
              onCompare={compare}
              onMark={mark}
              onMore={(source, offset) =>
                ask(
                  { kind: 'text', query: textSentTo(source, sentText) },
                  source,
                  offset,
                  round.current.text,
                )
              }
            />
          )}

          <section className="record-source" data-testid="record-links">
            <h3>Other sites</h3>
            <p className="hint">
              The app does not search these sites itself. A button opens a search for the name and
              the years under &quot;People&quot; in your browser, at the site. A page you find
              there, or anywhere else, becomes a source when you paste its address here.
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
        </div>
      )}

      {setup !== null && censusPacks.length > 0 && (
        <div hidden={censusNotice}>
          <CensusPanel
            packs={censusPacks}
            personId={personId}
            name={name}
            onTree={onTree}
            onNotice={() => setCensusNotice(true)}
          />
        </div>
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

      {comparing !== null && (
        <RecordCompareDialog
          personId={personId}
          name={name}
          sourceId={comparing.sourceId}
          recordKey={comparing.key}
          onTaken={(result) => {
            onTree(result.tree);
            // The record is cited now, and the tree it is held against has changed.
            setAttached((now) => new Set(now).add(attachedKey(comparing.sourceId, comparing.key)));
            setFound((all) =>
              Object.fromEntries(
                Object.entries(all).map(([sourceId, found]) => [
                  sourceId,
                  { ...found, fits: result.fits[sourceId] ?? {} },
                ]),
              ),
            );
          }}
          onClose={() => setComparing(null)}
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
