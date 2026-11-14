import { createHash, randomUUID } from 'node:crypto';
import {
  AI_TOOL_INPUTS,
  NOT_GIVEN,
  RECORD_TEXT_NOTE,
  checkProposal,
  checkQuery,
  findPeople,
  readPerson,
  readPersonLine,
  readRelatives,
  sharedRecordOf,
  type AiToolName,
  type AiToolRefusal,
  type AiToolResult,
  type CheckedReason,
  type DroppedReason,
  type ProposalConfidence,
  type ProposalVerdict,
  type QuerySubject,
  type SharedRecord,
} from '@rulz/ai';
import { cleanText } from '@rulz/connectors';
import type { ExternalRecord, PersonQuery } from '@rulz/core';
import {
  getAncestorSlots,
  getPerson,
  getSetting,
  listNames,
  logAiActivity,
  presumedLivingIds,
  setSetting,
  type AiActivityDetail,
  type AiActivityKind,
  type Db,
  type Tree,
} from '@rulz/db';
import type { z } from 'zod';
import type { RecordSearchProblem, RecordSourceInfo } from '../shared/ipc';
import { defaultWait } from './recordrun';
import { queryOf, type RecordSearchService } from './records';

/**
 * A session of the optional AI assistant: the time during which an AI the
 * user connected may use the assistant's tools, for the people and the
 * sources the user chose.
 *
 * The rule of the app is that nothing is asked of the internet unless the
 * user pressed a button for it. With an AI, the request to search comes from
 * the AI. So the press is the start of a session, and a session is bounded
 * before it starts, as a search for several people is (`recordrun.ts`):
 *
 * - it starts only when the page asks for it, from a plan the user saw, after
 *   the user agreed to the notice of the assistant and to that of the search,
 *   and only while the tree is still as the plan showed it. Nothing here
 *   starts one by a clock, at start-up, or again after it ended;
 * - it is for a person and their ancestors up to so many generations, and
 *   for the sources the user ticked, of those whose terms let their results
 *   be passed on to an AI. A question to a source is for one of these people
 *   and at one of these sources, or it is refused;
 * - it has a count of questions for each source, and of calls in all, and it
 *   ends when the user stops it, when no call came for a while, when the tree
 *   closes, or when the user turns the assistant off;
 * - what the AI asks a source for is held against the person of the tree
 *   first (`checkQuery`): a name like one of theirs, years near theirs. Every
 *   question is kept for the page to show, as it is asked;
 * - it lives in memory and no longer than the tree is open. It writes nothing
 *   into the tree. What the AI proposes is kept in memory for the user to
 *   look at, and reaches the tree as any result does: by a press for it.
 *
 * Outside a session no tool gives anything. Inside one, the tools read the
 * tree through `@rulz/ai` only, which gives nobody who may be living and no
 * free text of the user, and they pass on only records a search of this
 * session brought, never one that was kept in a tree and read back.
 *
 * Every call that reads the tree, asks a source, gives a record or makes a
 * proposal is written to the activity log of the assistant, in the app's own
 * database: what was asked, and which records were given, never their text.
 * A call that cannot be logged gives nothing, and ends the session. A call
 * that names no tool, or sends what its tool does not take, reads nothing
 * and is counted only.
 *
 * Nothing here uses Electron, and nothing here connects to an AI: whatever
 * does hands each call of a tool to `call`.
 */

/** The setting that holds the day the user agreed to the notice of the assistant. */
export const AI_NOTICE_SETTING = 'aiAssistant.noticeAgreedAt';

/** The setting that holds which wording of that notice the user agreed to. */
export const AI_NOTICE_VERSION_SETTING = 'aiAssistant.noticeVersion';

/**
 * The wording of the notice of the assistant. It goes up when the notice has
 * more to say, and an agreement to an earlier wording does not count.
 *
 * 1: during a session the user started, the AI the user connected reads the
 *    people of the open tree who are not living (names, dates, places and who
 *    their relatives are), asks WikiTree, Open Archives and Wikidata for
 *    records of the people of the session under the limits of a question,
 *    and reads the results. All of that goes to the AI service of the user's
 *    own app.
 */
export const AI_NOTICE_VERSION = 1;

/** How many generations of ancestors a session can be for; 0 is the person alone. */
export const AI_SESSION_MAX_GENERATIONS = 3;

/** How many questions a session may send to one source. */
export const AI_SESSION_REQUESTS = 10;

/** How many calls of a tool a session takes in all. It ends with the next one. */
export const AI_SESSION_CALLS = 500;

/** A session ends when no call came for this long, in milliseconds. */
export const AI_SESSION_IDLE_MS = 15 * 60 * 1000;

/** The least time between the end of one question to a source and the next to it, in milliseconds. */
export const AI_SESSION_GAP_MS = 1000;

/** Someone a session would be for, or is for. */
export interface AiSessionPerson {
  personId: string;
  /** The main name, for the page of the user. */
  name: string;
  /** 0 for the person, 1 for the parents, 2 for the grandparents. */
  generation: number;
  /** Why the session is not for them: they may be living. Null when it is. */
  leftOut: 'living' | null;
}

/** What a session from a person would be for. Nothing has started. */
export interface AiSessionPlan {
  /** Whether the user agreed to the notice of the assistant as it is worded now. */
  agreed: boolean;
  /** Whether the user agreed to the notice of the search for records. */
  searchAgreed: boolean;
  people: AiSessionPerson[];
  /** The sources a session may ask. */
  sources: RecordSourceInfo[];
  requestsPerSource: number;
  /** After how many minutes without a call a session ends. */
  idleMinutes: number;
  /** Names who the session would be for; a start gives it back. */
  stamp: string;
}

export interface AiSessionPlanRequest {
  personId: string;
  /** Generations of ancestors: 0 for the person alone, up to {@link AI_SESSION_MAX_GENERATIONS}. */
  generations: number;
}

export interface AiSessionStartRequest extends AiSessionPlanRequest {
  sourceIds: string[];
  stamp: string;
}

/**
 * Why a session ended: the user stopped it; no call came for a while; the
 * tree closed; the user turned the assistant off, or the notice of the search
 * no longer stands; another session took its place; it took all its calls;
 * the activity log could not be written.
 */
export type AiSessionEnd =
  'stopped' | 'idle' | 'tree-closed' | 'withdrawn' | 'replaced' | 'calls' | 'log';

/** One question an AI put to a source, as the page shows it. */
export interface AiQuestion {
  number: number;
  at: number;
  personId: string;
  sourceId: string;
  /** What was sent, or would have been. */
  query: PersonQuery;
  /**
   * "asking": on its way, or waiting for its turn. "answered": the source
   * answered, or the app still had its answer. "failed": the source did not
   * answer. "not-sent": nothing was sent, and the message says why.
   */
  state: 'asking' | 'answered' | 'failed' | 'not-sent';
  /** How many records were passed on to the AI. */
  found: number;
  /** True when the app still had the answer and nothing was sent. */
  cached: boolean;
  message: string;
}

/** A session as it stands, for the page. */
export interface AiSessionStatus {
  sessionId: string;
  status: 'running' | 'ended';
  ended: AiSessionEnd | null;
  /** Why it ended, in words for the user. */
  endedMessage: string;
  startedAt: number;
  /** When it ends unless a call comes; null once it has ended. */
  idleAt: number | null;
  /** The people it is for. */
  people: AiSessionPerson[];
  sources: { id: string; name: string; used: number; limit: number }[];
  calls: number;
  questions: AiQuestion[];
  /** How many proposals the AI made that passed the check. */
  proposals: number;
  /** Goes up with every change, so that the page knows when to look again. */
  revision: number;
}

export type AiSessionStartResult =
  | { ok: true; session: AiSessionStatus }
  | { ok: false; problem: RecordSearchProblem; plan: AiSessionPlan | null };

/** What an AI proposed about a record and a person, after the check. Kept in memory only. */
export interface AiProposal {
  /** The reference the session gave the record. */
  ref: string;
  personId: string;
  sourceId: string;
  /** What the source calls the record. */
  key: string;
  at: number;
  verdict: ProposalVerdict;
  confidence: ProposalConfidence;
  /** The reasons whose quotes are in the record. */
  reasons: CheckedReason[];
  /** The reasons that do not count, for the user to see. */
  dropped: DroppedReason[];
  /** The record as it was passed on, which the quotes were looked up in. */
  record: SharedRecord;
}

export interface AiSessionOptions {
  appDb: Db;
  /** The clock, replaceable in tests. */
  now?: () => number;
  /** Waits; replaceable in tests. It must reject when the signal aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The time between two questions to a source; {@link AI_SESSION_GAP_MS} unless a test says otherwise. */
  gapMs?: number;
  /** Makes the name of a session; replaceable in tests. */
  newId?: () => string;
}

/** A record a search of the session brought, as it is kept for `get_record` and `propose_match`. */
interface Found {
  ref: string;
  personId: string;
  sourceId: string;
  record: ExternalRecord;
  shared: SharedRecord;
}

interface SourceLine {
  name: string;
  attribution: string;
  asks: string;
  /** Questions that were sent, or are on their way. */
  used: number;
  /** Settles when the question before the next has ended. Never rejects. */
  line: Promise<void>;
  /** When the last question that may have reached the source ended; null before the first. */
  lastAt: number | null;
}

interface Session {
  id: string;
  tree: Tree;
  treeId: string;
  /** False once the tree the session was started for is no longer the open one. */
  still: () => boolean;
  abort: AbortController;
  status: 'running' | 'ended';
  ended: AiSessionEnd | null;
  endedMessage: string;
  startedAt: number;
  lastCallAt: number;
  people: AiSessionPerson[];
  personIds: Set<string>;
  sources: Map<string, SourceLine>;
  calls: number;
  questions: AiQuestion[];
  /** The records of this session by their reference, and the reference of each by person, source and key. */
  found: Map<string, Found>;
  refs: Map<string, string>;
  proposals: Map<string, AiProposal>;
  revision: number;
}

const ENDED: Record<AiSessionEnd, string> = {
  stopped: 'You stopped the session.',
  idle: 'No call came for a while, so the session ended.',
  'tree-closed': 'The tree was closed, so the session ended.',
  withdrawn: 'The AI assistant was turned off, so the session ended.',
  replaced: 'Another session was started in its place.',
  calls: 'The session took all the calls it may take, so it ended.',
  log: 'The activity log could not be written, so the session ended.',
};

const refuse = (reason: AiToolRefusal, message: string, detail?: unknown): AiToolResult =>
  detail === undefined ? { ok: false, reason, message } : { ok: false, reason, message, detail };

const NO_SESSION = refuse(
  'no-session',
  'No session of the AI assistant is under way. The user starts one in RulZ Ancestry, for the people and the sources they choose.',
);

const problem = (kind: RecordSearchProblem['kind'], message: string): RecordSearchProblem => ({
  kind,
  message,
  retryAt: null,
});

/** A reference as a session gives it. Anything else an AI sends as one is not written to the log. */
const REF = /^r[1-9]\d{0,8}$/;

function isToolName(name: string): name is AiToolName {
  return Object.hasOwn(AI_TOOL_INPUTS, name);
}

function refKey(personId: string, sourceId: string, key: string): string {
  return `${personId}\n${sourceId}\n${key}`;
}

export class AiSessionService {
  readonly #records: RecordSearchService;
  readonly #appDb: Db;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #gapMs: number;
  readonly #newId: () => string;
  /** The session that is under way, or the last one that ended. One at a time. */
  #session: Session | null = null;

  constructor(records: RecordSearchService, options: AiSessionOptions) {
    this.#records = records;
    this.#appDb = options.appDb;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? defaultWait;
    this.#gapMs = options.gapMs ?? AI_SESSION_GAP_MS;
    this.#newId = options.newId ?? randomUUID;
  }

  /** True once the user has agreed to the notice of the assistant as it is worded now. */
  get agreed(): boolean {
    const kept = getSetting(this.#appDb, AI_NOTICE_VERSION_SETTING) ?? '';
    const version = /^[1-9]\d{0,5}$/.test(kept) ? Number(kept) : 0;
    return getSetting(this.#appDb, AI_NOTICE_SETTING) !== null && version >= AI_NOTICE_VERSION;
  }

  /** Turns the assistant on: the user agreed to its notice. */
  agree(): void {
    if (!this.agreed) {
      setSetting(this.#appDb, AI_NOTICE_SETTING, new Date(this.#now()).toISOString());
      setSetting(this.#appDb, AI_NOTICE_VERSION_SETTING, String(AI_NOTICE_VERSION));
    }
  }

  /** Turns the assistant off again. A session ends, and what it found and proposed is forgotten. */
  withdraw(): void {
    setSetting(this.#appDb, AI_NOTICE_SETTING, null);
    setSetting(this.#appDb, AI_NOTICE_VERSION_SETTING, null);
    if (this.#session !== null) this.#end(this.#session, 'withdrawn');
    this.#session = null;
  }

  /**
   * Who a session from this person would be for: the person, then their
   * ancestors by generation, each once. Someone who may be living is listed
   * as left out, for the user to see; the session is not for them. Nothing
   * starts, and nothing is sent. Null when the person is gone.
   */
  plan(tree: Tree, request: AiSessionPlanRequest): AiSessionPlan | null {
    if (getPerson(tree, request.personId) === null) return null;
    const generations = Math.min(
      Math.max(0, Math.trunc(request.generations) || 0),
      AI_SESSION_MAX_GENERATIONS,
    );
    const living = presumedLivingIds(tree, this.#now());
    const seen = new Set<string>();
    const people: AiSessionPerson[] = [];
    for (const { slot, personId } of getAncestorSlots(tree, request.personId, generations)) {
      if (seen.has(personId)) continue;
      seen.add(personId);
      const names = listNames(tree, personId);
      const name = names.find((entry) => entry.isPrimary) ?? names[0];
      people.push({
        personId,
        name: name === undefined ? '' : cleanText(`${name.given} ${name.surname}`, 400),
        // Slot 1 is the person, 2 and 3 the parents, 4 to 7 the grandparents.
        generation: 31 - Math.clz32(slot),
        leftOut: living.has(personId) ? 'living' : null,
      });
    }
    return {
      agreed: this.agreed,
      searchAgreed: this.#records.agreed,
      people,
      sources: this.#records.aiSources(),
      requestsPerSource: AI_SESSION_REQUESTS,
      idleMinutes: AI_SESSION_IDLE_MS / 60_000,
      // All that decides who the session is for, and who it is not for.
      stamp: createHash('sha256')
        .update(JSON.stringify(people.map(({ personId, leftOut }) => [personId, leftOut])))
        .digest('hex'),
    };
  }

  /**
   * Starts a session from the plan the user saw. Refused before both notices
   * are agreed to, when the tree is no longer as that plan showed it, for a
   * source a session may not ask, and when the plan names nobody the session
   * can be for. A session that is under way ends when another starts. `still`
   * says whether `tree` is still the open one.
   */
  start(tree: Tree, request: AiSessionStartRequest, still: () => boolean): AiSessionStartResult {
    const plan = this.plan(tree, request);
    const fail = (kind: RecordSearchProblem['kind'], message: string): AiSessionStartResult => ({
      ok: false,
      problem: problem(kind, message),
      plan,
    });
    if (plan === null) return fail('gone', 'This person is no longer in the tree.');
    if (!plan.agreed) {
      return fail(
        'notice',
        'The AI assistant is off. It is turned on by agreeing to what it sends, and to whom.',
      );
    }
    if (!plan.searchAgreed) {
      return fail('notice', 'Nothing is sent before you have agreed to what a search sends.');
    }
    if (plan.stamp !== request.stamp) {
      return fail(
        'changed',
        'The tree has changed since this list was shown. Look at it again, then start.',
      );
    }
    const asked: unknown = request.sourceIds;
    const sourceIds = Array.isArray(asked)
      ? asked.filter((id): id is string => typeof id === 'string')
      : [];
    const sources = plan.sources.filter((source) => sourceIds.includes(source.id));
    if (
      !Array.isArray(asked) ||
      sources.length === 0 ||
      sources.length !== asked.length ||
      sources.length !== new Set(sourceIds).size
    ) {
      return fail('source', 'Tick the sources to ask, of those in the list.');
    }
    const people = plan.people.filter((person) => person.leftOut === null);
    if (people.length === 0) {
      return fail(
        'living',
        'Everybody in this list may be living. Nothing about living people is sent.',
      );
    }

    if (this.#session !== null) this.#end(this.#session, 'replaced');
    const startedAt = this.#now();
    const session: Session = {
      id: this.#newId(),
      tree,
      treeId: tree.info().id,
      still,
      abort: new AbortController(),
      status: 'running',
      ended: null,
      endedMessage: '',
      startedAt,
      lastCallAt: startedAt,
      people,
      personIds: new Set(people.map((person) => person.personId)),
      sources: new Map(
        sources.map((source) => [
          source.id,
          {
            name: source.name,
            attribution: source.attribution,
            asks: source.asks,
            used: 0,
            line: Promise.resolve(),
            lastAt: null,
          },
        ]),
      ),
      calls: 0,
      questions: [],
      found: new Map(),
      refs: new Map(),
      proposals: new Map(),
      revision: 1,
    };
    this.#session = session;
    const logged = this.#log(session, 'session-started', {
      person: request.personId,
      generations: Math.max(...people.map((person) => person.generation)),
      people: people.length,
      sources: sources.map((source) => source.id).join(' '),
    });
    if (!logged) {
      return fail('failed', ENDED.log);
    }
    return { ok: true, session: this.#status(session) };
  }

  /** The session as it stands; null when there is none. One that has run out of time is ended first. */
  status(): AiSessionStatus | null {
    this.#live();
    return this.#session === null ? null : this.#status(this.#session);
  }

  /** What the AI proposed in the session, the latest first. They stay after the session has ended. */
  proposals(): AiProposal[] {
    return this.#session === null
      ? []
      : [...this.#session.proposals.values()].sort((a, b) => b.at - a.at);
  }

  /** Ends the session that is under way: no tool gives anything more, and nothing more is sent. */
  stop(): void {
    if (this.#session !== null) this.#end(this.#session, 'stopped');
  }

  /** Ends the session and forgets what it found and proposed. For when a tree closes. */
  clear(): void {
    if (this.#session !== null) this.#end(this.#session, 'tree-closed');
    this.#session = null;
  }

  /** Settles when no question of a session is on its way. For tests, and for closing down. */
  async idle(): Promise<void> {
    const lines = [...(this.#session?.sources.values() ?? [])].map((source) => source.line);
    await Promise.all(lines);
  }

  /**
   * One call of a tool by the AI: its name, and what it sent, as it came.
   * Outside a session nothing is given. The answer is plain data.
   */
  async call(name: string, input: unknown): Promise<AiToolResult> {
    const session = this.#live();
    if (session === null) return NO_SESSION;
    session.calls += 1;
    session.revision += 1;
    if (session.calls > AI_SESSION_CALLS) {
      this.#end(session, 'calls');
      return NO_SESSION;
    }
    session.lastCallAt = this.#now();
    if (typeof name !== 'string' || !isToolName(name)) {
      return refuse('unknown-tool', 'There is no tool of this name.');
    }
    try {
      return await this.#run(session, name, input);
    } catch {
      // Nothing of what went wrong is passed on: it can name a file or hold a text of the tree.
      return refuse('failed', 'The call failed.');
    }
  }

  #run(session: Session, name: AiToolName, input: unknown): Promise<AiToolResult> {
    switch (name) {
      case 'get_session':
        return this.#take(name, input, () => this.#getSession(session));
      case 'list_sources':
        return this.#take(name, input, () => this.#listSources(session));
      case 'search_tree':
        return this.#take(name, input, (given) => this.#searchTree(session, given));
      case 'get_person':
        return this.#take(name, input, (given) => this.#getPerson(session, given.personId));
      case 'get_relatives':
        return this.#take(name, input, (given) => this.#getRelatives(session, given.personId));
      case 'search_records':
        return this.#take(name, input, (given) => this.#searchRecords(session, given));
      case 'get_record':
        return this.#take(name, input, (given) => this.#getRecord(session, given.ref));
      case 'propose_match':
        return this.#take(name, input, (given) => this.#propose(session, given));
    }
  }

  /** Reads what a tool was sent, and hands it on when it is what the tool takes. */
  async #take<N extends AiToolName>(
    name: N,
    input: unknown,
    then: (given: z.infer<(typeof AI_TOOL_INPUTS)[N]>) => AiToolResult | Promise<AiToolResult>,
  ): Promise<AiToolResult> {
    const parsed = AI_TOOL_INPUTS[name].safeParse(input ?? {});
    if (!parsed.success) {
      return refuse('input', `This is not what ${name} takes. Look at what it asks for.`);
    }
    return then(parsed.data as z.infer<(typeof AI_TOOL_INPUTS)[N]>);
  }

  /**
   * The session when it is under way; null otherwise. A session whose tree
   * closed, whose notices no longer stand, or that no call came to for a
   * while is ended here, whoever asks first.
   */
  #live(): Session | null {
    const session = this.#session;
    if (session === null || session.status !== 'running') return null;
    if (!session.still()) {
      this.#end(session, 'tree-closed');
    } else if (!this.agreed || !this.#records.agreed) {
      this.#end(session, 'withdrawn');
    } else if (this.#now() - session.lastCallAt >= AI_SESSION_IDLE_MS) {
      this.#end(session, 'idle', session.lastCallAt + AI_SESSION_IDLE_MS);
    }
    return session.status === 'running' ? session : null;
  }

  /** Ends a session, once. A question on its way is given up, and its answer is dropped. */
  #end(session: Session, why: AiSessionEnd, at: number = this.#now()): void {
    if (session.status !== 'running') return;
    session.status = 'ended';
    session.ended = why;
    session.endedMessage = ENDED[why];
    session.revision += 1;
    session.abort.abort();
    // The log is tried once more, except when it is the log that failed.
    if (why !== 'log') {
      this.#write(session, 'session-ended', at, {
        why,
        calls: session.calls,
        questions: session.questions.length,
        proposals: session.proposals.size,
      });
    }
  }

  #write(session: Session, kind: AiActivityKind, at: number, detail: AiActivityDetail): boolean {
    try {
      logAiActivity(this.#appDb, {
        sessionId: session.id,
        treeId: session.treeId,
        kind,
        at,
        detail,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes a call to the activity log. False when it could not be written:
   * the session is ended then, and the caller gives nothing.
   */
  #log(session: Session, kind: AiActivityKind, detail: AiActivityDetail): boolean {
    if (this.#write(session, kind, this.#now(), detail)) return true;
    this.#end(session, 'log');
    return false;
  }

  #status(session: Session): AiSessionStatus {
    return {
      sessionId: session.id,
      status: session.status,
      ended: session.ended,
      endedMessage: session.endedMessage,
      startedAt: session.startedAt,
      idleAt: session.status === 'running' ? session.lastCallAt + AI_SESSION_IDLE_MS : null,
      people: session.people.map((person) => ({ ...person })),
      sources: [...session.sources].map(([id, source]) => ({
        id,
        name: source.name,
        used: source.used,
        limit: AI_SESSION_REQUESTS,
      })),
      calls: session.calls,
      questions: session.questions.map((question) => ({
        ...question,
        query: { ...question.query },
      })),
      proposals: session.proposals.size,
      revision: session.revision,
    };
  }

  /**
   * What a question about a person is held against; null when nothing may be
   * asked or given for them: they are gone, or may be living.
   */
  #subject(tree: Tree, personId: string): QuerySubject | null {
    if (getPerson(tree, personId) === null) return null;
    if (presumedLivingIds(tree, this.#now()).has(personId)) return null;
    const query = queryOf(tree, personId);
    return {
      names: listNames(tree, personId).map(({ given, surname }) => ({ given, surname })),
      birthYear: query.birthYear,
      deathYear: query.deathYear,
    };
  }

  #sourcesOf(session: Session) {
    return [...session.sources].map(([id, source]) => ({
      id,
      name: source.name,
      asks: source.asks,
      attribution: source.attribution,
      questionsLeft: Math.max(0, AI_SESSION_REQUESTS - source.used),
    }));
  }

  #getSession(session: Session): AiToolResult {
    const now = this.#now();
    // Someone who has come to count as living since the start is not listed.
    // Nor is it said which generation each is of: a list that starts at the
    // parents would say that the person it was started from is in the tree
    // and may be living. get_relatives says how they are related.
    const people = session.people.flatMap((person) => {
      const line = readPersonLine(session.tree, person.personId, now);
      return line.ok ? [line.value] : [];
    });
    if (!this.#log(session, 'sources-listed', { tool: 'get_session', people: people.length })) {
      return NO_SESSION;
    }
    return {
      ok: true,
      value: {
        people,
        sources: this.#sourcesOf(session),
        rules: [
          'search_records asks a source for one of these people only, under a name the tree has for them, or another spelling of it that differs by a letter or two, and years near the years the tree has.',
          'propose_match files a proposal for the user. Every reason must quote the record word for word. Nothing changes in the tree: the user decides.',
          RECORD_TEXT_NOTE,
        ],
      },
    };
  }

  #listSources(session: Session): AiToolResult {
    if (!this.#log(session, 'sources-listed', { tool: 'list_sources' })) return NO_SESSION;
    return { ok: true, value: { sources: this.#sourcesOf(session) } };
  }

  #searchTree(
    session: Session,
    given: z.infer<(typeof AI_TOOL_INPUTS)['search_tree']>,
  ): AiToolResult {
    const found = findPeople(
      session.tree,
      given.query,
      given.offset === undefined ? {} : { offset: given.offset },
      this.#now(),
    );
    const logged = this.#log(session, 'tree-searched', {
      query: cleanText(given.query, 200),
      offset: given.offset ?? 0,
      found: found.people.length,
    });
    return logged ? { ok: true, value: found } : NO_SESSION;
  }

  /**
   * An id an AI sent, as it is written to the log: the id when it names a
   * person of the tree, and nothing otherwise. What an AI sends as an id can
   * be any text, and the log holds no text an AI made up in place of one.
   */
  #personOf(session: Session, personId: string): string {
    return getPerson(session.tree, personId) === null ? '' : personId;
  }

  #getPerson(session: Session, personId: string): AiToolResult {
    const answer = readPerson(session.tree, personId, this.#now());
    const person = this.#personOf(session, personId);
    if (!this.#log(session, 'person-read', { person, given: answer.ok })) {
      return NO_SESSION;
    }
    return answer.ok ? answer : refuse('not-given', answer.message);
  }

  #getRelatives(session: Session, personId: string): AiToolResult {
    const answer = readRelatives(session.tree, personId, this.#now());
    const person = this.#personOf(session, personId);
    if (!this.#log(session, 'relatives-read', { person, given: answer.ok })) {
      return NO_SESSION;
    }
    return answer.ok ? answer : refuse('not-given', answer.message);
  }

  /**
   * A question to a source. It is held against the session and the person
   * first; what passes waits for its turn at the source, one question after
   * the other, and is then sent through the search of the app.
   */
  async #searchRecords(
    session: Session,
    given: z.infer<(typeof AI_TOOL_INPUTS)['search_records']>,
  ): Promise<AiToolResult> {
    const { personId, sourceId, ...asked } = given;
    const source = session.sources.get(sourceId);
    const refused = (reason: AiToolRefusal, message: string, outcome: string): AiToolResult =>
      this.#log(session, 'records-searched', {
        // The ids as the session knows them; what else an AI sent as one is not written down.
        person: session.personIds.has(personId) ? personId : '',
        source: source === undefined ? '' : sourceId,
        // The name is what was asked, and stands in the log as it was asked, cut.
        given: cleanText(asked.given, 100),
        surname: cleanText(asked.surname, 100),
        birthYear: asked.birthYear,
        deathYear: asked.deathYear,
        sent: false,
        found: 0,
        outcome,
      })
        ? refuse(reason, message)
        : NO_SESSION;
    if (!session.personIds.has(personId)) {
      return refused(
        'not-in-session',
        'This session is not for this person. get_session lists the people it is for.',
        'not-in-session',
      );
    }
    if (source === undefined) {
      return refused(
        'not-in-session',
        'This session does not ask this source. list_sources lists the sources it asks.',
        'not-in-session',
      );
    }
    const subject = this.#subject(session.tree, personId);
    if (subject === null) return refused('not-given', NOT_GIVEN.message, 'not-given');
    const checked = checkQuery(asked, subject, new Date(this.#now()).getFullYear());
    if (!checked.ok) return refused('query', checked.message, `query-${checked.problem}`);
    if (source.used >= AI_SESSION_REQUESTS) {
      return refused(
        'budget',
        `This session has no question left for ${source.name}. It had ${AI_SESSION_REQUESTS}.`,
        'budget',
      );
    }
    // Taken now, so that two questions at once cannot both take the last one.
    source.used += 1;
    const question: AiQuestion = {
      number: session.questions.length + 1,
      at: this.#now(),
      personId,
      sourceId,
      query: checked.query,
      state: 'asking',
      found: 0,
      cached: false,
      message: '',
    };
    session.questions.push(question);
    session.revision += 1;
    const turn = source.line
      .then(() => this.#ask(session, source, question))
      .catch((): AiToolResult => {
        // Something failed that should not: the file of the tree can have
        // gone. The question stays counted, since it can have gone out, and
        // it is written down as that.
        if (question.state === 'asking') {
          Object.assign(question, { state: 'failed', message: 'The search failed.' });
          session.revision += 1;
        }
        this.#write(session, 'records-searched', this.#now(), {
          person: personId,
          source: sourceId,
          given: question.query.given,
          surname: question.query.surname,
          birthYear: question.query.birthYear,
          deathYear: question.query.deathYear,
          sent: true,
          found: 0,
          outcome: 'error',
        });
        return refuse('failed', 'The search failed.');
      });
    source.line = turn.then(() => undefined);
    return turn;
  }

  /** Sends one question when its turn has come, and makes of the answer what the AI is given. */
  async #ask(session: Session, source: SourceLine, question: AiQuestion): Promise<AiToolResult> {
    const { personId, sourceId, query } = question;
    const settle = (
      state: AiQuestion['state'],
      message: string,
      found = 0,
      cached = false,
    ): void => {
      Object.assign(question, { state, message, found, cached });
      session.revision += 1;
    };
    /** Nothing reached the source: the question is given back to the session. */
    const unsent = (message: string): void => {
      source.used -= 1;
      settle('not-sent', message);
    };
    const detail = (sent: boolean, found: number, outcome: string): AiActivityDetail => ({
      person: personId,
      source: sourceId,
      given: query.given,
      surname: query.surname,
      birthYear: query.birthYear,
      deathYear: query.deathYear,
      sent,
      found,
      outcome,
    });
    const log = (sent: boolean, found: number, outcome: string): boolean =>
      this.#log(session, 'records-searched', detail(sent, found, outcome));
    /**
     * True while the session is the one under way. Asked again after every
     * wait, and not of the session's own state alone: a session that ran out
     * of time while a question waited, whose tree closed or whose notices no
     * longer stand, is ended by this look.
     */
    const live = (): boolean => this.#live() === session;
    const over = 'The session has ended, so nothing was sent.';
    const dropped = 'The session ended while this question was on its way. Its answer was dropped.';

    if (!live()) {
      unsent(over);
      return NO_SESSION;
    }
    if (source.lastAt !== null) {
      const due = source.lastAt + this.#gapMs - this.#now();
      try {
        if (due > 0) await this.#wait(due, session.abort.signal);
      } catch {
        // The wait was given up: the session ended meanwhile.
      }
      if (!live()) {
        unsent(over);
        return NO_SESSION;
      }
    }
    const result = await this.#records.searchForAi(
      session.tree,
      { personId, sourceId, query },
      session.abort.signal,
      // The session's own last look, when the request's turn has come.
      () => {
        if (!live()) return problem('cancelled', over);
        const subject = this.#subject(session.tree, personId);
        if (subject === null) return problem('living', NOT_GIVEN.message);
        return checkQuery(query, subject, new Date(this.#now()).getFullYear()).ok
          ? null
          : problem(
              'changed',
              'The name or the years of this person have changed since this was asked, so nothing was sent.',
            );
      },
    );

    if (!result.ok) {
      const { kind, message } = result.problem;
      const { sent } = result;
      const ended = !live();
      if (sent) {
        // It went out, whatever became of it: it stays counted, and the source is given its rest.
        source.lastAt = this.#now();
        settle('failed', ended ? dropped : message);
      } else {
        unsent(ended ? over : message);
      }
      if (ended) {
        // Nothing is given after the end. What went out is written down all the same.
        if (sent) this.#write(session, 'records-searched', this.#now(), detail(true, 0, kind));
        return NO_SESSION;
      }
      if (!log(sent, 0, kind)) return NO_SESSION;
      return kind === 'living' || kind === 'gone'
        ? refuse('not-given', NOT_GIVEN.message)
        : refuse(sent ? 'failed' : 'not-sent', message);
    }

    if (!result.cached) source.lastAt = this.#now();
    if (!live()) {
      // The answer came after the session ended: it is given to nobody.
      if (result.cached) {
        unsent(over);
      } else {
        settle('answered', dropped);
        this.#write(session, 'records-searched', this.#now(), detail(true, 0, 'dropped'));
      }
      return NO_SESSION;
    }
    // An answer the app still had sent nothing, and takes no question of the session.
    if (result.cached) source.used -= 1;
    // The person can have come to count as living, or have gone, while the
    // answer was on its way. Then it is given to nobody, and nothing of it is kept.
    if (this.#subject(session.tree, personId) === null) {
      settle('answered', NOT_GIVEN.message, 0, result.cached);
      if (!log(!result.cached, 0, 'not-given')) return NO_SESSION;
      return refuse('not-given', NOT_GIVEN.message);
    }
    const given: (SharedRecord & { ref: string })[] = [];
    let withheld = 0;
    for (const record of result.records) {
      const shared = sharedRecordOf(record, result.manifest);
      if (!shared.ok) {
        withheld += 1;
        continue;
      }
      const key = refKey(personId, sourceId, record.key);
      const earlier = session.refs.get(key);
      const before = earlier === undefined ? undefined : session.found.get(earlier);
      let ref = earlier;
      // A reference names one reading of a record for good. A record that
      // reads otherwise now is given a reference of its own, so that a quote
      // is never held against a text other than the one its reference gave.
      if (
        ref === undefined ||
        before === undefined ||
        JSON.stringify(before.shared) !== JSON.stringify(shared.record)
      ) {
        ref = `r${session.found.size + 1}`;
        session.refs.set(key, ref);
        session.found.set(ref, { ref, personId, sourceId, record, shared: shared.record });
      }
      given.push({ ref, ...shared.record });
    }
    settle('answered', '', given.length, result.cached);
    if (!log(!result.cached, given.length, 'answered')) return NO_SESSION;
    for (const record of given) {
      const key = session.found.get(record.ref)?.record.key ?? '';
      if (
        !this.#log(session, 'record-read', {
          person: personId,
          source: sourceId,
          key,
          by: 'search',
        })
      ) {
        return NO_SESSION;
      }
    }
    return {
      ok: true,
      value: {
        source: { id: sourceId, name: source.name, attribution: source.attribution },
        asked: query,
        records: given,
        total: result.total,
        more: result.more,
        // Private profiles and living people, and what could not be passed on.
        leftOut: result.hidden + withheld,
        fromEarlierAnswer: result.cached,
        questionsLeft: Math.max(0, AI_SESSION_REQUESTS - source.used),
        note: RECORD_TEXT_NOTE,
      },
    };
  }

  /** The record a reference names, when nothing speaks against giving it; a refusal otherwise. */
  #found(session: Session, ref: string, personId: string | null): Found | AiToolResult {
    const found = session.found.get(ref);
    if (found === undefined || (personId !== null && found.personId !== personId)) {
      return refuse(
        'record',
        personId === null
          ? 'This reference names no record of this session. search_records gives the references.'
          : 'This reference names no record that was found for this person in this session.',
      );
    }
    // The person it was found for may have come to count as living since.
    if (this.#subject(session.tree, found.personId) === null) {
      return refuse('not-given', NOT_GIVEN.message);
    }
    return found;
  }

  #getRecord(session: Session, ref: string): AiToolResult {
    const found = this.#found(session, ref, null);
    const logged = this.#log(
      session,
      'record-read',
      'ref' in found
        ? { person: found.personId, source: found.sourceId, key: found.record.key, by: 'get' }
        : { ref: REF.test(ref) ? ref : '', by: 'get', given: false },
    );
    if (!logged) return NO_SESSION;
    if (!('ref' in found)) return found;
    return {
      ok: true,
      value: {
        ref,
        personId: found.personId,
        ...found.shared,
        note: RECORD_TEXT_NOTE,
      },
    };
  }

  /** A proposal of the AI about a record of this session and the person it was found for. */
  #propose(
    session: Session,
    given: z.infer<(typeof AI_TOOL_INPUTS)['propose_match']>,
  ): AiToolResult {
    const { personId, ref, ...proposal } = given;
    const found = this.#found(session, ref, personId);
    if (!('ref' in found)) {
      return this.#log(session, 'proposal-made', {
        person: this.#personOf(session, personId),
        ref: REF.test(ref) ? ref : '',
        accepted: false,
        outcome: found.ok ? '' : found.reason,
      })
        ? found
        : NO_SESSION;
    }
    const checked = checkProposal(proposal, found.shared);
    const logged = this.#log(session, 'proposal-made', {
      person: personId,
      source: found.sourceId,
      key: found.record.key,
      verdict: proposal.verdict,
      confidence: proposal.confidence,
      accepted: checked.ok,
      kept: checked.ok ? checked.reasons.length : 0,
      dropped: checked.dropped.length,
      outcome: checked.ok ? 'accepted' : checked.problem,
    });
    if (!logged) return NO_SESSION;
    const dropped = checked.dropped.map(({ side, quote, why }) => ({ side, quote, why }));
    if (!checked.ok) return refuse('proposal', checked.message, { dropped });
    // A later proposal about the same record and person takes the place of an earlier one.
    session.proposals.set(ref, {
      ref,
      personId,
      sourceId: found.sourceId,
      key: found.record.key,
      at: this.#now(),
      verdict: checked.verdict,
      confidence: checked.confidence,
      reasons: checked.reasons,
      dropped: checked.dropped,
      record: found.shared,
    });
    session.revision += 1;
    return {
      ok: true,
      value: {
        filed: true,
        verdict: checked.verdict,
        confidence: checked.confidence,
        reasonsKept: checked.reasons.length,
        // Told, so that a reason can be given again with the words of the record.
        reasonsDropped: dropped,
      },
    };
  }
}
