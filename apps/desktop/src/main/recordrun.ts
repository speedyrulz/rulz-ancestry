import { createHash } from 'node:crypto';
import type { PersonQuery } from '@rulz/core';
import { getAncestorSlots, getPerson, listNames, presumedLivingIds, type Tree } from '@rulz/db';
import {
  RECORD_RUN_MAX_GENERATIONS,
  type RecordRunItem,
  type RecordRunPerson,
  type RecordRunPlan,
  type RecordRunPlanRequest,
  type RecordRunStartRequest,
  type RecordRunStartResult,
  type RecordRunUpdate,
  type RecordSearchProblem,
} from '../shared/ipc';
import { RECORD_RUN_SOURCE_IDS, queryOf, type RecordSearchService } from './records';

/**
 * A search for several people in one go: a person and their direct ancestors,
 * each asked for at the sources the user ticked. The project owner decided on
 * 2026-11-14 that one press may start it. What it must not become is a job in
 * the background, so:
 *
 * - it starts only when the page asks for it, from a plan the user saw, and
 *   only while the tree is still as that plan showed it. Nothing here starts
 *   one by a clock, at start-up, or again after it ended;
 * - it is bounded before it starts: so many generations, each person once,
 *   one question for a person at a source, and the first results only;
 * - it lives in memory and no longer than the tree is open. It writes nothing
 *   into the tree: a result reaches the tree as after any search, by a press
 *   for that one result;
 * - every question goes through `RecordSearchService.searchOnce`, where the
 *   rules of a search are kept, and which looks at the person again just
 *   before the request is sent;
 * - it is slower than the sources allow, never asks a second time for what
 *   failed, and leaves a source alone that is in trouble.
 *
 * The page follows a run by asking how it stands (`update`); there is no
 * channel from here to the page.
 */

/** The least time between the end of one question to a source and the next to it, in milliseconds. */
export const RECORD_RUN_GAP_MS = 1000;

/** After so many questions in a row that a source did not answer, the run asks it no more. */
export const RECORD_RUN_FAILURES = 2;

/** The source that is ticked when the window opens: the one whose records are of every country. */
const TICKED: readonly string[] = ['wikitree'];

export interface RecordRunOptions {
  /** The clock, replaceable in tests. */
  now?: () => number;
  /** Waits; replaceable in tests. It must reject when the signal aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The time between two questions to a source; {@link RECORD_RUN_GAP_MS} unless a test says otherwise. */
  gapMs?: number;
}

const defaultWait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('given up'));
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(new Error('given up'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });

/** One question of a run, with what the page is not told: when it last changed, and what is sent. */
interface Question extends RecordRunItem {
  revision: number;
  query: PersonQuery;
}

interface Run {
  id: number;
  tree: Tree;
  /** False once the tree the run was started for is no longer the open one. */
  still: () => boolean;
  abort: AbortController;
  status: RecordRunUpdate['status'];
  ended: string;
  left: RecordRunUpdate['left'];
  revision: number;
  questions: Question[];
  /** Settles when the run has asked its last question. Never rejects. */
  over: Promise<void>;
}

const problem = (kind: RecordSearchProblem['kind'], message: string): RecordSearchProblem => ({
  kind,
  message,
  retryAt: null,
});

export class RecordRun {
  readonly #records: RecordSearchService;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #gapMs: number;
  /** The run that is under way, or the last one that ended. One at a time. */
  #run: Run | null = null;
  #runs = 0;

  constructor(records: RecordSearchService, options: RecordRunOptions = {}) {
    this.#records = records;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? defaultWait;
    this.#gapMs = options.gapMs ?? RECORD_RUN_GAP_MS;
  }

  /**
   * Who a run from this person would ask for, and what it would send for
   * each. The person, then their ancestors by generation, each once: someone
   * who stands twice in a pedigree is asked for once. Nothing is sent. Null
   * when the person is gone.
   */
  plan(tree: Tree, request: RecordRunPlanRequest): RecordRunPlan | null {
    if (getPerson(tree, request.personId) === null) return null;
    const generations = Math.min(
      Math.max(1, Math.trunc(request.generations)),
      RECORD_RUN_MAX_GENERATIONS,
    );
    const living = presumedLivingIds(tree, this.#now());
    const seen = new Set<string>();
    const people: RecordRunPerson[] = [];
    for (const { slot, personId } of getAncestorSlots(tree, request.personId, generations)) {
      if (seen.has(personId)) continue;
      seen.add(personId);
      const names = listNames(tree, personId);
      const name = names.find((entry) => entry.isPrimary) ?? names[0];
      const query = queryOf(tree, personId);
      const leftOut = living.has(personId)
        ? 'living'
        : query.given.trim() === '' || query.surname.trim() === ''
          ? 'name'
          : query.birthYear === null && query.deathYear === null
            ? 'years'
            : null;
      people.push({
        personId,
        name: name === undefined ? '' : `${name.given} ${name.surname}`.trim(),
        // Slot 1 is the person, 2 and 3 the parents, 4 to 7 the grandparents.
        generation: 31 - Math.clz32(slot),
        query: leftOut === null ? query : null,
        leftOut,
      });
    }
    const sources = this.#records.runSources();
    return {
      agreed: this.#records.agreed,
      people,
      sources,
      ticked: TICKED.filter((id) => sources.some((source) => source.id === id)),
      gapSeconds: this.#gapMs / 1000,
      // All that decides what is sent, and for whom nothing is.
      stamp: createHash('sha256')
        .update(
          JSON.stringify(people.map(({ personId, query, leftOut }) => [personId, query, leftOut])),
        )
        .digest('hex'),
    };
  }

  /**
   * Starts a run from the plan the user saw. Refused before the notice is
   * agreed to, when the tree is no longer as that plan showed it, for a source
   * a run may not ask, and when the plan names nobody to ask for. A run that
   * is under way ends when another starts. `still` says whether `tree` is
   * still the open one.
   */
  start(tree: Tree, request: RecordRunStartRequest, still: () => boolean): RecordRunStartResult {
    const plan = this.plan(tree, request);
    const fail = (kind: RecordSearchProblem['kind'], message: string): RecordRunStartResult => ({
      ok: false,
      problem: problem(kind, message),
      plan,
    });
    if (plan === null) return fail('gone', 'This person is no longer in the tree.');
    if (!plan.agreed) {
      return fail('notice', 'Nothing is sent before you have agreed to what a search sends.');
    }
    if (plan.stamp !== request.stamp) {
      return fail(
        'changed',
        'The tree has changed since this list was shown. Look at it again, then start.',
      );
    }
    const sourceIds = RECORD_RUN_SOURCE_IDS.filter((id) => request.sourceIds.includes(id));
    if (
      sourceIds.length === 0 ||
      sourceIds.length !== new Set(request.sourceIds).size ||
      sourceIds.some((id) => !plan.sources.some((source) => source.id === id))
    ) {
      return fail('source', 'Tick the sources to ask, of those in the list.');
    }
    const asked = plan.people.filter((person) => person.query !== null);
    if (asked.length === 0) {
      return fail('empty', 'Nobody in this list can be searched for.');
    }

    this.stop();
    this.#runs += 1;
    const run: Run = {
      id: this.#runs,
      tree,
      still,
      abort: new AbortController(),
      status: 'running',
      ended: '',
      left: {},
      revision: 1,
      // The nearest people first, at every source.
      questions: asked.flatMap((person) =>
        sourceIds.map((sourceId) => ({
          personId: person.personId,
          sourceId,
          state: 'waiting' as const,
          message: '',
          result: null,
          revision: 1,
          query: person.query ?? queryOf(tree, person.personId),
        })),
      ),
      over: Promise.resolve(),
    };
    this.#run = run;
    // The sources are other hosts with limits of their own, so each is asked
    // in its own line; within a source, one person after the other.
    run.over = Promise.all(sourceIds.map((sourceId) => this.#ask(run, sourceId))).then(() =>
      this.#close(run, 'finished', ''),
    );
    return { ok: true, run: this.#update(run, 0) };
  }

  /** The run as it stands, with the questions that changed after `since`. Null when there is no such run. */
  update(request: { runId: number; since: number }): RecordRunUpdate | null {
    const run = this.#run;
    if (run === null || run.id !== request.runId) return null;
    // A tree that closed takes its run with it, whoever asks first.
    this.#gone(run);
    return this.#update(run, request.since);
  }

  /** Ends the run that is under way: nothing more is sent, and an answer on its way is dropped. */
  stop(): void {
    if (this.#run !== null) this.#close(this.#run, 'stopped', '');
  }

  /** Ends the run and forgets what it found. For when a tree closes. */
  clear(): void {
    this.stop();
    this.#run = null;
  }

  /** Settles when no run is asking anything. For tests, and for closing down. */
  async idle(): Promise<void> {
    await this.#run?.over;
  }

  #update(run: Run, since: number): RecordRunUpdate {
    return {
      runId: run.id,
      status: run.status,
      ended: run.ended,
      left: { ...run.left },
      revision: run.revision,
      items: run.questions
        .filter((question) => question.revision > since)
        .map(({ personId, sourceId, state, message, result }) => ({
          personId,
          sourceId,
          state,
          message,
          result,
        })),
    };
  }

  #set(
    run: Run,
    question: Question,
    state: RecordRunItem['state'],
    message: string,
    result: RecordRunItem['result'] = null,
  ): void {
    run.revision += 1;
    Object.assign(question, { state, message, result, revision: run.revision });
  }

  /** Ends a run, once. Whatever was not asked yet is not asked. */
  #close(run: Run, status: 'finished' | 'stopped', ended: string): void {
    if (run.status !== 'running') return;
    run.status = status;
    run.ended = ended;
    run.revision += 1;
    for (const question of run.questions) {
      if (question.state === 'waiting' || question.state === 'asking') {
        this.#set(run, question, 'not-asked', ended);
      }
    }
    run.abort.abort();
  }

  /** Asks a source no more in this run. What was to be asked of it is not asked. */
  #leave(run: Run, sourceId: string, message: string, retryAt: number | null): void {
    run.left[sourceId] = { message, retryAt };
    run.revision += 1;
    for (const question of run.questions) {
      if (question.sourceId === sourceId && question.state === 'waiting') {
        this.#set(run, question, 'not-asked', message);
      }
    }
  }

  /** True when the tree of a run is no longer the open one; the run is then ended. */
  #gone(run: Run): boolean {
    if (run.status === 'running' && !run.still()) {
      this.#close(run, 'stopped', 'The tree was closed, so the search was ended.');
    }
    return run.status !== 'running';
  }

  /** Asks one source for each person of a run in turn. Never rejects. */
  async #ask(run: Run, sourceId: string): Promise<void> {
    const name =
      this.#records.runSources().find((source) => source.id === sourceId)?.name ?? sourceId;
    let failures = 0;
    /** When the last question that may have reached the source ended; null before the first. */
    let lastAt: number | null = null;
    try {
      for (const question of run.questions) {
        if (question.sourceId !== sourceId) continue;
        if (this.#gone(run) || run.left[sourceId] !== undefined) return;
        if (lastAt !== null) {
          const due = lastAt + this.#gapMs - this.#now();
          if (due > 0) await this.#wait(due, run.abort.signal);
          if (this.#gone(run)) return;
        }
        this.#set(run, question, 'asking', '');
        const result = await this.#records.searchOnce(
          run.tree,
          { personId: question.personId, sourceId, query: question.query },
          run.abort.signal,
        );
        // An answer that comes after the run ended is dropped.
        if (this.#gone(run)) return;
        if (result.ok) {
          this.#set(run, question, 'done', '', result);
          failures = 0;
          // An answer the client still had sent nothing.
          if (!result.cached) lastAt = this.#now();
          continue;
        }
        const { kind, message, retryAt } = result.problem;
        if (kind === 'living' || kind === 'gone' || kind === 'changed' || kind === 'empty') {
          // Nothing was sent: the person is no longer as the plan showed them.
          this.#set(run, question, 'skipped', message);
        } else if (kind === 'timeout' || kind === 'failed') {
          lastAt = this.#now();
          failures += 1;
          this.#set(run, question, 'failed', message);
          if (failures >= RECORD_RUN_FAILURES) {
            this.#leave(
              run,
              sourceId,
              `${name} did not answer ${failures} times in a row, so it was asked no more.`,
              null,
            );
          }
        } else if (kind === 'offline') {
          this.#set(run, question, 'failed', message);
          this.#close(
            run,
            'stopped',
            'The internet could not be reached, so the search was ended.',
          );
        } else if (kind === 'cancelled') {
          this.#set(run, question, 'not-asked', '');
        } else {
          // The source asks to be left alone, or cannot be asked at all.
          this.#set(run, question, 'not-asked', message);
          this.#leave(run, sourceId, message, retryAt);
        }
      }
    } catch {
      // A wait that was given up, or a tree that closed under a question.
      if (run.status === 'running' && !run.abort.signal.aborted) {
        this.#close(run, 'stopped', 'The search could not go on.');
      }
    }
  }
}
