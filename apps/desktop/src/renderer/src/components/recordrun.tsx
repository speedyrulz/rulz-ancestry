import type { ExternalRecord, PersonQuery } from '@rulz/core';
import { useEffect, useRef, useState } from 'react';
import {
  RECORD_RUN_GENERATIONS,
  RECORD_RUN_MAX_GENERATIONS,
  type RecordFitInfo,
  type RecordRunItem,
  type RecordRunPerson,
  type RecordRunPlan,
  type RecordRunUpdate,
  type RecordSearchSetup,
  type RecordSourceInfo,
  type TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';
import { countOf } from '../format';
import { RecordCompareDialog } from './recordcompare';
import { RecordNotice, Result, timeOf } from './records';
import { Dialog } from './ui';

/**
 * A search for a person and their direct ancestors in one go. The window
 * first lists who would be asked for, with the name and the years that would
 * be sent for each, who is left out and why, and the sources with how many
 * requests each would get. Nothing is sent before "Start" is pressed.
 *
 * The main process works the list out and runs the search (see
 * `main/recordrun.ts`); this window says which person, how far back and
 * which sources, and asks twice a second how the search stands. Closing the
 * window ends the search.
 *
 * What is found is shown person by person and stays in the app's memory. A
 * result reaches the tree as after any search: by a press for that one
 * result, to attach it, keep it for later, turn it down or take facts over.
 */

type Mark = 'kept' | 'declined';

/** What one source answered for one person, as the window holds it. */
interface Answer {
  state: RecordRunItem['state'];
  /** Why the source was not asked for the person, or did not answer. */
  message: string;
  items: ExternalRecord[];
  fits: Record<string, RecordFitInfo>;
  marks: Record<string, Mark>;
  /** The keys of the results the person's page cites. */
  attached: ReadonlySet<string>;
  total: number | null;
  hidden: number;
}

/** The run as the window follows it, without its questions. */
type Standing = Pick<RecordRunUpdate, 'runId' | 'status' | 'ended' | 'left'>;

const cellOf = (personId: string, sourceId: string) => `${personId}\n${sourceId}`;

function standingOf(update: RecordRunUpdate): Standing {
  return { runId: update.runId, status: update.status, ended: update.ended, left: update.left };
}

function answerOf(item: RecordRunItem): Answer {
  const result = item.result;
  return {
    state: item.state,
    message: item.message,
    items: result?.items ?? [],
    fits: result?.fits ?? {},
    marks: {
      ...Object.fromEntries((result?.marks.kept ?? []).map((key) => [key, 'kept' as const])),
      ...Object.fromEntries(
        (result?.marks.declined ?? []).map((key) => [key, 'declined' as const]),
      ),
    },
    attached: new Set(result?.attached ?? []),
    total: result?.total ?? null,
    hidden: result?.hidden ?? 0,
  };
}

/**
 * The answers with what changed since. An answer of a source comes once, so
 * what the user did with its results since is not written over.
 */
function merged(all: Record<string, Answer>, items: RecordRunItem[]): Record<string, Answer> {
  if (items.length === 0) return all;
  const next = { ...all };
  for (const item of items) next[cellOf(item.personId, item.sourceId)] = answerOf(item);
  return next;
}

const GENERATIONS = [
  'parents',
  'grandparents',
  'great-grandparents',
  '2nd great-grandparents',
  '3rd great-grandparents',
];

const RELATION = [
  '',
  'parent',
  'grandparent',
  'great-grandparent',
  '2nd great-grandparent',
  '3rd great-grandparent',
];

const LEFT_OUT: Record<NonNullable<RecordRunPerson['leftOut']>, string> = {
  living: 'may be living',
  name: 'no given name or no last name in your tree',
  years: 'no year of birth or death in your tree, and a name alone fits too many people',
};

function sentWords(query: PersonQuery): string {
  return [
    `${query.given} ${query.surname}`.trim(),
    query.birthYear === null ? '' : `born ${query.birthYear}`,
    query.deathYear === null ? '' : `died ${query.deathYear}`,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

/** About how long so many requests to one source take, in words. */
function durationWords(requests: number, gapSeconds: number): string {
  // A request is given a second to be answered; a slow service takes longer.
  const seconds = requests * (gapSeconds + 1);
  if (seconds < 15) return 'a few seconds';
  if (seconds < 45) return 'about half a minute';
  if (seconds < 90) return 'about a minute';
  return `about ${Math.round(seconds / 60)} minutes`;
}

/** What a source found for a person, in a few words. */
function foundWords(answer: Answer): string {
  if (answer.state === 'waiting') return 'not asked yet';
  if (answer.state === 'asking') return 'asking…';
  if (answer.state !== 'done') {
    const what =
      answer.state === 'skipped'
        ? 'left out'
        : answer.state === 'failed'
          ? 'no answer'
          : 'not asked';
    return answer.message === '' ? what : `${what}: ${answer.message}`;
  }
  const open = answer.items.filter((record) => answer.marks[record.key] !== 'declined');
  if (open.length === 0) return answer.items.length === 0 ? 'nothing found' : 'nothing new';
  const strong = open.filter((record) => answer.fits[record.key]?.band === 'strong').length;
  const possible = open.filter((record) => answer.fits[record.key]?.band === 'possible').length;
  const others = open.length - strong - possible;
  return [
    strong === 0 ? '' : `${strong} ${strong === 1 ? 'fits' : 'fit'} well`,
    possible === 0 ? '' : `${possible} may fit`,
    others === 0 ? '' : countOf(others, 'other', 'others'),
  ]
    .filter((part) => part !== '')
    .join(', ');
}

interface RecordRunDialogProps {
  personId: string;
  /** The person's name, for the title. */
  name: string;
  onTree: (tree: TreeState) => void;
  onClose: () => void;
}

export function RecordRunDialog({ personId, name, onTree, onClose }: RecordRunDialogProps) {
  const [generations, setGenerations] = useState(RECORD_RUN_GENERATIONS);
  const [plan, setPlan] = useState<RecordRunPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Every source and site, for the notice; loaded only when the notice is shown. */
  const [setup, setSetup] = useState<RecordSearchSetup | null>(null);
  /** The sources that are ticked; null until the plan says which are to begin with. */
  const [ticked, setTicked] = useState<ReadonlySet<string> | null>(null);
  const [starting, setStarting] = useState(false);
  const [run, setRun] = useState<Standing | null>(null);
  /** Who the run asks for and at which sources, as the plan had them when it started. */
  const [asked, setAsked] = useState<{
    people: RecordRunPerson[];
    sources: RecordSourceInfo[];
  } | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  /** The last revision of the run the window has seen. */
  const revision = useRef(0);
  /** What went wrong with starting, or with something done to a result. */
  const [problem, setProblem] = useState<string | null>(null);
  /** The result that is being attached or marked; null when none is. */
  const [busy, setBusy] = useState<string | null>(null);
  const [comparing, setComparing] = useState<{
    person: RecordRunPerson;
    sourceId: string;
    key: string;
  } | null>(null);
  /** The people whose results the user unfolded or folded away, against how they start. */
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [showDeclined, setShowDeclined] = useState(false);
  /** Counts the times the plan is read again. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    api.planRecordRun({ personId, generations }).then(
      (loaded) => {
        if (!current) return;
        if (loaded === null) {
          setError('This person is no longer in the tree.');
          return;
        }
        setPlan(loaded);
        setTicked((now) => now ?? new Set(loaded.ticked));
        if (loaded.agreed) return;
        api.getRecordSearch(personId).then(
          (found) => {
            if (current) setSetup(found);
          },
          (failure: unknown) => {
            if (current) setError(errorMessage(failure));
          },
        );
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [personId, generations, round]);

  // Closing the window ends the search: nothing is asked in the background.
  useEffect(
    () => () => {
      void api.stopRecordRun().catch(() => undefined);
    },
    [],
  );

  /**
   * Takes over how the run stands. Two answers can come out of order (one to
   * the regular question, one after "Stop"): the older one is left aside, so
   * that the run is not shown as going on after it ended.
   */
  const take = (update: RecordRunUpdate) => {
    if (update.revision < revision.current) return;
    revision.current = update.revision;
    setAnswers((all) => merged(all, update.items));
    setRun(standingOf(update));
  };

  const runId = run?.runId ?? null;
  const running = run?.status === 'running';
  useEffect(() => {
    if (runId === null || !running) return undefined;
    let current = true;
    let asking = false;
    const timer = setInterval(() => {
      if (asking) return;
      asking = true;
      api
        .getRecordRun({ runId, since: revision.current })
        .then(
          (update) => {
            if (!current) return;
            if (update === null) {
              setRun((now) =>
                now === null
                  ? now
                  : { ...now, status: 'stopped', ended: 'The search is no longer under way.' },
              );
              return;
            }
            take(update);
          },
          () => undefined,
        )
        .finally(() => {
          asking = false;
        });
    }, 500);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [runId, running]);

  const people = plan?.people ?? [];
  const eligible = people.filter((person) => person.query !== null);
  const leftOut = people.filter((person) => person.query === null);
  const chosen = (plan?.sources ?? []).filter((source) => ticked?.has(source.id) === true);

  const agree = () => {
    api.agreeToRecordSearch().then(
      () => setRound((now) => now + 1),
      (failure: unknown) => setError(errorMessage(failure)),
    );
  };

  const start = () => {
    if (plan === null || chosen.length === 0 || eligible.length === 0) return;
    setProblem(null);
    setStarting(true);
    api
      .startRecordRun({
        personId,
        generations,
        sourceIds: chosen.map((source) => source.id),
        stamp: plan.stamp,
      })
      .then(
        (result) => {
          if (!result.ok) {
            setProblem(result.problem.message);
            // The list as it stands now: the tree changed under the one that was shown.
            if (result.plan !== null) setPlan(result.plan);
            // Read again when the notice must be shown first: what it says is loaded with the list.
            if (result.plan?.agreed === false) setRound((now) => now + 1);
            return;
          }
          setAsked({ people: eligible, sources: chosen });
          revision.current = result.run.revision;
          setAnswers(merged({}, result.run.items));
          setRun(standingOf(result.run));
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setStarting(false));
  };

  const stop = () => {
    if (run === null) return;
    const { runId: id } = run;
    api
      .stopRecordRun()
      .then(() => api.getRecordRun({ runId: id, since: revision.current }))
      .then(
        (update) => {
          if (update !== null) take(update);
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      );
  };

  /** Changes what the window holds of one source's answer for one person. */
  const change = (cell: string, to: (now: Answer) => Answer) =>
    setAnswers((all) => {
      const now = all[cell];
      return now === undefined ? all : { ...all, [cell]: to(now) };
    });

  const attach = (person: RecordRunPerson, sourceId: string, record: ExternalRecord) => {
    const cell = cellOf(person.personId, sourceId);
    setProblem(null);
    setBusy(`${cell}\n${record.key}`);
    api
      .attachRecord({ personId: person.personId, sourceId, key: record.key })
      .then(
        (result) => {
          if (!result.ok) {
            setProblem(result.problem.message);
            return;
          }
          onTree(result.tree);
          change(cell, (now) => ({ ...now, attached: new Set(now.attached).add(record.key) }));
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setBusy(null));
  };

  /** Keeps a result for later, turns it down for the person, or takes a turning-down back. */
  const mark = (
    person: RecordRunPerson,
    sourceId: string,
    record: ExternalRecord,
    action: 'keep' | 'decline' | 'allow',
  ) => {
    const cell = cellOf(person.personId, sourceId);
    const request = { personId: person.personId, sourceId, key: record.key };
    setProblem(null);
    setBusy(`${cell}\n${record.key}`);
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
          change(cell, (now) => {
            const marks = Object.fromEntries(
              Object.entries(now.marks).filter(([key]) => key !== record.key),
            );
            if (action !== 'allow') marks[record.key] = action === 'keep' ? 'kept' : 'declined';
            return { ...now, marks };
          });
        },
        (failure: unknown) => setProblem(errorMessage(failure)),
      )
      .finally(() => setBusy(null));
  };

  // "Start" is gone once the search runs. The focus goes to the results, not to the page.
  const resultsRef = useRef<HTMLDivElement>(null);
  const started = run !== null;
  useEffect(() => {
    if (started && (document.activeElement === document.body || document.activeElement === null)) {
      resultsRef.current?.focus();
    }
  }, [started]);

  const all = Object.values(answers);
  const declined = all.reduce(
    (sum, answer) =>
      sum + answer.items.filter((record) => answer.marks[record.key] === 'declined').length,
    0,
  );
  const hidden = all.reduce((sum, answer) => sum + answer.hidden, 0);

  return (
    <Dialog title={`Search for ancestors of ${name}`} onClose={onClose} testId="record-run" wide>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error === null && (plan === null || (!plan.agreed && setup === null)) && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}

      {plan !== null && !plan.agreed && setup !== null && (
        <RecordNotice
          sources={setup.sources}
          links={setup.links}
          onAgree={agree}
          onClose={onClose}
        />
      )}

      {plan !== null && plan.agreed && run === null && (
        <div data-testid="run-plan">
          <p className="dialog-text">
            This asks the services you tick for {name === '' ? 'this person' : name} and their
            direct ancestors, one person after the other. Nothing is sent before you press
            &quot;Start&quot;, and closing this window ends the search.
          </p>
          <div className="field">
            <label htmlFor="run-generations">How far back</label>
            <select
              id="run-generations"
              value={generations}
              onChange={(event) => setGenerations(Number(event.target.value))}
              data-testid="run-generations"
            >
              {GENERATIONS.slice(0, RECORD_RUN_MAX_GENERATIONS).map((label, index) => (
                <option key={label} value={index + 1}>
                  As far as the {label}
                </option>
              ))}
            </select>
          </div>

          <h3>Services to ask</h3>
          <ul className="run-list" data-testid="run-sources">
            {plan.sources.map((source) => (
              <li key={source.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={ticked?.has(source.id) === true}
                    onChange={(event) =>
                      setTicked((now) => {
                        const next = new Set(now ?? []);
                        if (event.target.checked) next.add(source.id);
                        else next.delete(source.id);
                        return next;
                      })
                    }
                    data-testid={`run-source-${source.id}`}
                  />{' '}
                  <strong>{source.name}</strong>
                </label>
                <div className="hint">
                  It is sent {source.asks}.{' '}
                  <a
                    href={source.termsUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Terms of use of ${source.name}`}
                  >
                    Terms of use
                  </a>
                  {source.pausedUntil !== null &&
                    ` It asked to be left alone until ${timeOf(source.pausedUntil)}, and is not asked before.`}
                </div>
              </li>
            ))}
          </ul>

          <h3 data-testid="run-asked-count">
            {countOf(eligible.length, 'person is', 'people are')} asked for
          </h3>
          {eligible.length > 0 && (
            <>
              <p className="hint">For each of them, this is sent to every service you tick:</p>
              <ol className="run-list" data-testid="run-asked">
                {eligible.map((person) => (
                  <li key={person.personId}>
                    {person.query === null ? '' : sentWords(person.query)}
                    {person.generation > 0 && (
                      <span className="muted"> ({RELATION[person.generation]})</span>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
          {leftOut.length > 0 && (
            <>
              <h3>{countOf(leftOut.length, 'person is', 'people are')} left out</h3>
              <ul className="run-list" data-testid="run-left-out">
                {leftOut.map((person) => (
                  <li key={person.personId}>
                    {person.name === '' ? 'Someone without a name' : person.name}
                    <span className="muted">
                      {person.generation > 0 && ` (${RELATION[person.generation]})`}:{' '}
                      {person.leftOut === null ? '' : LEFT_OUT[person.leftOut]}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint">Nothing is sent for them.</p>
            </>
          )}

          <p className="dialog-text" data-testid="run-count">
            {chosen.length === 0 || eligible.length === 0
              ? chosen.length === 0
                ? 'Tick a service to ask.'
                : 'There is nobody to ask for.'
              : `"Start" sends at most ${countOf(
                  eligible.length * chosen.length,
                  'request',
                  'requests',
                )}: ${chosen
                  .map((source) => `${eligible.length} to ${source.name}`)
                  .join(', ')}. It takes ${durationWords(
                  eligible.length,
                  plan.gapSeconds,
                )}, and longer when a service is slow. Only the first 20 results for each person are fetched.`}
          </p>
          {problem !== null && (
            <p className="error" role="alert" data-testid="run-problem">
              {problem}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} data-testid="run-close">
              Close
            </button>
            <button
              type="button"
              className="primary"
              disabled={starting || chosen.length === 0 || eligible.length === 0}
              onClick={start}
              data-testid="run-start"
            >
              Start
            </button>
          </div>
        </div>
      )}

      {run !== null && asked !== null && (
        <div
          ref={resultsRef}
          tabIndex={-1}
          role="region"
          aria-label="Results of the search"
          data-testid="run-results"
        >
          <p className="dialog-text" role="status" data-testid="run-status">
            {run.status === 'running'
              ? 'Searching… '
              : run.status === 'finished'
                ? 'The search is finished. '
                : run.ended === ''
                  ? 'The search was stopped. '
                  : `${run.ended} `}
            {run.status === 'running' && (
              <button type="button" onClick={stop} data-testid="run-stop">
                Stop
              </button>
            )}
          </p>
          <ul className="run-list" data-testid="run-progress">
            {asked.sources.map((source) => {
              const mine = asked.people.map(
                (person) => answers[cellOf(person.personId, source.id)],
              );
              const answered = mine.filter(
                (answer) =>
                  answer !== undefined && answer.state !== 'waiting' && answer.state !== 'asking',
              ).length;
              const left = run.left[source.id];
              return (
                <li key={source.id} data-testid={`run-progress-${source.id}`}>
                  <strong>{source.name}:</strong> {answered} of {asked.people.length}
                  {left !== undefined && (
                    <span className="error">
                      {' '}
                      {left.message}
                      {left.retryAt !== null &&
                        ` It can be asked again at ${timeOf(left.retryAt)}.`}
                    </span>
                  )}
                  <div className="hint">
                    {source.attribution}.{' '}
                    <a
                      href={source.termsUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Terms of use of ${source.name}`}
                    >
                      Terms of use
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="hint" data-testid="run-hint">
            The labels hold each result against the person in your tree: the name, the years and the
            places. They help with reading and prove nothing; open a record to judge it. Nothing of
            this is in your tree: &quot;Keep for later&quot; puts a result into the inbox, and what
            you do not keep or attach is gone when this window closes.
          </p>
          {declined > 0 && (
            <p className="hint" data-testid="run-declined-count">
              {countOf(declined, 'result', 'results')} you turned down{' '}
              {declined === 1 ? 'is' : 'are'} {showDeclined ? 'shown too' : 'not shown'}.{' '}
              <button
                type="button"
                className="small"
                onClick={() => setShowDeclined((now) => !now)}
                data-testid="run-declined-show"
              >
                {showDeclined ? 'Hide' : 'Show'}
              </button>
            </p>
          )}
          {hidden > 0 && (
            <p className="hint" data-testid="run-hidden">
              {countOf(hidden, 'result', 'results')} {hidden === 1 ? 'is' : 'are'} not shown:
              private profiles, and people who may be living.
            </p>
          )}
          {problem !== null && (
            <p className="error" role="alert" data-testid="run-problem">
              {problem}
            </p>
          )}

          {asked.people.map((person) => {
            const mine = asked.sources.map((source) => ({
              source,
              answer: answers[cellOf(person.personId, source.id)],
            }));
            const visible = (answer: Answer) =>
              answer.items.filter(
                (record) => showDeclined || answer.marks[record.key] !== 'declined',
              );
            const count = mine.reduce(
              (sum, { answer }) => sum + (answer === undefined ? 0 : visible(answer).length),
              0,
            );
            // Unfolded to begin with when something fits; the rest is one press away.
            const fits = mine.some(
              ({ answer }) =>
                answer !== undefined &&
                visible(answer).some((record) => {
                  const band = answer.fits[record.key]?.band;
                  return band === 'strong' || band === 'possible';
                }),
            );
            const open = unfolded[person.personId] ?? fits;
            return (
              <section key={person.personId} className="record-source" data-testid="run-person">
                <h3>
                  {person.name}
                  {person.generation > 0 && (
                    <span className="muted"> {RELATION[person.generation]}</span>
                  )}
                </h3>
                <p className="hint" data-testid="run-person-found">
                  {mine
                    .map(
                      ({ source, answer }) =>
                        `${source.name}: ${answer === undefined ? 'not asked yet' : foundWords(answer)}`,
                    )
                    .join(' · ')}{' '}
                  {count > 0 && (
                    <button
                      type="button"
                      className="small"
                      aria-expanded={open}
                      aria-label={
                        open
                          ? `Hide the results for ${person.name}`
                          : `Show ${countOf(count, 'result', 'results')} for ${person.name}`
                      }
                      onClick={() => setUnfolded((now) => ({ ...now, [person.personId]: !open }))}
                      data-testid="run-person-toggle"
                    >
                      {open ? 'Hide' : `Show ${countOf(count, 'result', 'results')}`}
                    </button>
                  )}
                </p>
                {open &&
                  mine.map(({ source, answer }) =>
                    answer === undefined || visible(answer).length === 0 ? null : (
                      <div key={source.id} data-testid={`run-found-${source.id}`}>
                        <h4>{source.name}</h4>
                        <ol className="record-list">
                          {visible(answer).map((record) => (
                            <Result
                              key={record.key}
                              record={record}
                              fit={answer.fits[record.key]}
                              mark={answer.marks[record.key]}
                              attached={answer.attached.has(record.key)}
                              busy={busy !== null}
                              onAttach={() => attach(person, source.id, record)}
                              onCompare={() => {
                                setProblem(null);
                                setComparing({ person, sourceId: source.id, key: record.key });
                              }}
                              onKeep={() => mark(person, source.id, record, 'keep')}
                              onDecline={() => mark(person, source.id, record, 'decline')}
                              onAllow={() => mark(person, source.id, record, 'allow')}
                            />
                          ))}
                        </ol>
                      </div>
                    ),
                  )}
              </section>
            );
          })}

          <div className="dialog-actions">
            <button type="button" onClick={onClose} data-testid="run-close">
              Close
            </button>
          </div>
        </div>
      )}

      {comparing !== null && (
        <RecordCompareDialog
          personId={comparing.person.personId}
          name={comparing.person.name}
          sourceId={comparing.sourceId}
          recordKey={comparing.key}
          onTaken={(result) => {
            onTree(result.tree);
            // The record is cited now, and the person it is held against has changed.
            setAnswers((now) =>
              Object.fromEntries(
                Object.entries(now).map(([cell, answer]) => {
                  const [ofPerson, sourceId = ''] = cell.split('\n');
                  if (ofPerson !== comparing.person.personId) return [cell, answer];
                  return [
                    cell,
                    {
                      ...answer,
                      fits: result.fits[sourceId] ?? {},
                      attached:
                        sourceId === comparing.sourceId
                          ? new Set(answer.attached).add(comparing.key)
                          : answer.attached,
                    },
                  ];
                }),
              ),
            );
          }}
          onClose={() => setComparing(null)}
        />
      )}
    </Dialog>
  );
}
