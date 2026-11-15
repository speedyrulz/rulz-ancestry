import { createHash, randomUUID } from 'node:crypto';
import {
  AI_TOOL_INPUTS,
  API_MODELS,
  API_EFFORTS,
  API_CAP_MIN,
  API_CAP_MAX,
  type ApiModel,
  type ApiEffort,
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
import type { ExternalRecord } from '@rulz/core';
import {
  AI_ACTIVITY_KEEP_DAYS,
  clearAiActivity,
  countAiActivity,
  getAncestorSlots,
  getPerson,
  getSetting,
  listAiActivity,
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
import {
  AI_ACTIVITY_PAGE_MAX,
  AI_SESSION_MAX_GENERATIONS,
  type AiActivityPage,
  type AiAssistantInfo,
  type AiClientInfo,
  type AiProposalRef,
  type AiQuestion,
  type AiSessionState,
  type AttachRecordRequest,
  type AiSessionEnd,
  type AiSessionPerson,
  type AiSessionPlan,
  type AiSessionPlanRequest,
  type AiSessionStartRequest,
  type AiSessionStartResult,
  type AiSessionStatus,
  type RecordSearchProblem,
  type AiRunSettings,
  type AiRunStatus,
  type AiActionResult,
  type AiKeyState,
} from '../shared/ipc';
import { activityWords } from './aiactivitywords';
import type { AiBridge } from './aibridge';
import {
  firstRequestReserve,
  type AiApiClient,
  type AiApiRunOptions,
  type AiApiProgress,
} from './aiapi';
import { keptOpinionJson } from './keptopinion';
import { whenOf } from './keptrecord';
import { defaultWait } from './recordrun';
import { queryOf, type ProposalCopy, type RecordSearchService, type SecretStore } from './records';

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
 *   A proposal holds the record as it read when the AI was given it, and
 *   that reading is the one the press keeps, cites or compares
 *   (`RecordSearchService.useProposals`), whatever a later search reads.
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
 * 2: an AI app can now be connected. Added: how (a connector the user
 *    installs in their own Claude app, which reaches this app over a pipe of
 *    this PC while a session is under way), that another program under the
 *    same Windows account could do the same during a session, that this app
 *    does not see or limit what else that AI app does, and that a session
 *    ends after two hours at the latest.
 * 3: after saving a key and starting a run, the app sends the conversation and
 *    tool results to Anthropic under the user's key and terms. The user pays;
 *    costs are estimates, caps are the app's, and a sent request may be billed
 *    even after Stop. The key is encrypted for this account and can be removed.
 */
export const AI_NOTICE_VERSION = 3;

export { AI_SESSION_MAX_GENERATIONS } from '../shared/ipc';

/** How many questions a session may send to one source. */
export const AI_SESSION_REQUESTS = 10;

/** How many calls of a tool a session takes in all. It ends with the next one. */
export const AI_SESSION_CALLS = 500;

/** A session ends when no call came for this long, in milliseconds. */
export const AI_SESSION_IDLE_MS = 15 * 60 * 1000;

/** A session ends this long after it started at the latest, in milliseconds, whatever calls come. */
export const AI_SESSION_MAX_MS = 2 * 60 * 60 * 1000;

/** How often the app looks whether a session has run out of time when nothing else asks, in milliseconds. */
const AI_SESSION_WATCH_MS = 30 * 1000;

/** How many programs that connect to one session are written to the activity log. More are counted only. */
export const AI_SESSION_CLIENTS_LOGGED = 20;

/** The least time between the end of one question to a source and the next to it, in milliseconds. */
export const AI_SESSION_GAP_MS = 1000;

/**
 * How many proposals are held in memory at most, those of the session and
 * those of the sessions before it since the tree was opened. The oldest of
 * the earlier sessions go first.
 */
export const AI_PROPOSALS_HELD = 1000;

/** What this copy of the app hands out so that an AI app can be connected. */
export interface AiConnector {
  /** The connector file for Claude Desktop. */
  file: string;
  /**
   * False when this copy of the app keeps its data in another folder than
   * the usual one. The connector file looks in the usual folder only, so it
   * does not find a session of this copy.
   */
  fileFits: boolean;
  /** The folder this copy of the app keeps its data in. */
  profile: string;
  /** The command that adds the connector to Claude Code. */
  command: string;
}

export type {
  AiQuestion,
  AiSessionEnd,
  AiSessionPerson,
  AiSessionPlan,
  AiSessionPlanRequest,
  AiSessionStartRequest,
  AiSessionStartResult,
  AiSessionStatus,
} from '../shared/ipc';

/** What an AI proposed about a record and a person, after the check. Kept in memory only. */
export interface AiProposal {
  /** The session it was made in. With the reference, it names the proposal. */
  sessionId: string;
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
  /** The same reading as the connector made it: what a press of the user keeps, cites or compares. */
  external: ExternalRecord;
  /** When that reading came from the source, in Unix milliseconds. */
  readAt: number;
}

export interface AiSessionOptions {
  appDb: Db;
  secrets?: SecretStore;
  runApi?: (options: AiApiRunOptions) => Promise<AiApiProgress>;
  makeApiClient?: (key: string) => AiApiClient;
  /** The clock, replaceable in tests. */
  now?: () => number;
  /** Waits; replaceable in tests. It must reject when the signal aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The time between two questions to a source; {@link AI_SESSION_GAP_MS} unless a test says otherwise. */
  gapMs?: number;
  /** Makes the name of a session; replaceable in tests. */
  newId?: () => string;
  /** Lets an AI app reach a session. Without it a session can be started, and nothing outside the app can call. */
  bridge?: AiBridge;
  /** What this copy of the app hands out for connecting an AI app; null when it has none. */
  connector?: AiConnector | null;
}

/** A record a search of the session brought, as it is kept for `get_record` and `propose_match`. */
interface Found {
  ref: string;
  personId: string;
  sourceId: string;
  record: ExternalRecord;
  shared: SharedRecord;
  /** When the source gave this reading, in Unix milliseconds. */
  readAt: number;
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
  route: 'app' | 'api';
  run:
    | (AiRunStatus & {
        abort: AbortController;
        busy: boolean;
        /** True once the entry for the end of the run is written: only one is. */
        written: boolean;
      })
    | null;
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
  /** How many programs connected to it and proved themselves. */
  clients: number;
  revision: number;
}

const ENDED: Record<AiSessionEnd, string> = {
  stopped: 'You stopped the session.',
  page: 'The window of the app was loaded again, so the session ended.',
  idle: 'No call came for a while, so the session ended.',
  time: 'The session lasted as long as one may, so it ended.',
  quit: 'The app was closed, so the session ended.',
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
  readonly #bridge: AiBridge | null;
  readonly #connector: AiConnector | null;
  readonly #secrets: SecretStore | undefined;
  readonly #runApi: AiSessionOptions['runApi'];
  readonly #makeApiClient: AiSessionOptions['makeApiClient'];
  /** The session that is under way, or the last one that ended. One at a time. */
  #session: Session | null = null;
  /**
   * What the sessions before this one proposed, for the same tree, the
   * latest first, {@link AI_PROPOSALS_HELD} at most. A new session does not
   * take from the user what they have not looked at yet, short of that
   * many. Empty whenever there is no session.
   */
  #earlier: AiProposal[] = [];
  /** Goes up whenever the proposals change. */
  #proposalsRevision = 0;
  /** Looks from time to time whether the session that is under way has run out of time. */
  #watch: NodeJS.Timeout | null = null;

  constructor(records: RecordSearchService, options: AiSessionOptions) {
    this.#records = records;
    this.#appDb = options.appDb;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? defaultWait;
    this.#gapMs = options.gapMs ?? AI_SESSION_GAP_MS;
    this.#newId = options.newId ?? randomUUID;
    this.#bridge = options.bridge ?? null;
    this.#connector = options.connector ?? null;
    this.#secrets = options.secrets;
    this.#runApi = options.runApi;
    this.#makeApiClient = options.makeApiClient;
    this.#bridge?.onClient((client) => this.#connected(client));
    this.#bridge?.onChange(() => {
      if (this.#session !== null) this.#session.revision += 1;
    });
    // A press for a proposed record acts on the reading the proposal is about.
    records.useProposals((tree, request) => this.#copyOf(tree, request));
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
    this.#forget();
  }

  /** Forgets the session and every proposal. */
  #forget(): void {
    this.#session = null;
    this.#earlier = [];
    this.#proposalsRevision += 1;
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
    if (request.route !== 'app' && request.route !== 'api')
      return fail('failed', 'Choose a route.');
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

    const before = this.#session;
    if (before !== null) {
      this.#end(before, 'replaced');
      // What it proposed stays for the user to look at, while the tree is the same.
      this.#earlier =
        before.tree === tree
          ? [...before.proposals.values(), ...this.#earlier]
              .sort((a, b) => b.at - a.at)
              .slice(0, AI_PROPOSALS_HELD)
          : [];
      this.#proposalsRevision += 1;
    }
    const startedAt = this.#now();
    const session: Session = {
      id: this.#newId(),
      route: request.route,
      run: null,
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
      clients: 0,
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
    // From here on an AI app can reach the session, and only until it ends.
    if (session.route === 'app') this.#bridge?.open();
    // The session ends when its time is up, also when nobody asks how it
    // stands: so does the way an AI app reaches it.
    this.#watch = setInterval(() => this.#live(), AI_SESSION_WATCH_MS);
    this.#watch.unref();
    return { ok: true, session: this.#status(session) };
  }

  /** The session as it stands; null when there is none. One that has run out of time is ended first. */
  status(): AiSessionStatus | null {
    this.#live();
    return this.#session === null ? null : this.#status(this.#session);
  }

  #key(): string | null {
    const kept = getSetting(this.#appDb, 'aiAssistant.apiKey');
    if (kept === null || this.#secrets?.available() !== true) return null;
    try {
      return this.#secrets.decrypt(kept) || null;
    } catch {
      return null;
    }
  }

  keyState(): AiKeyState {
    if (this.#secrets?.available() !== true) return 'unavailable';
    if (getSetting(this.#appDb, 'aiAssistant.apiKey') === null) return 'missing';
    return this.#key() === null ? 'unreadable' : 'saved';
  }

  saveKey(key: string): AiActionResult {
    if (this.#secrets?.available() !== true)
      return { ok: false, message: 'This PC cannot encrypt the key.' };
    if (typeof key !== 'string' || key.length > 300 || !/^sk-ant-\S+$/.test(key)) {
      return { ok: false, message: 'Enter a valid Anthropic key.' };
    }
    try {
      setSetting(this.#appDb, 'aiAssistant.apiKey', this.#secrets.encrypt(key));
      return { ok: true };
    } catch {
      return { ok: false, message: 'The key could not be saved.' };
    }
  }

  removeKey(): AiKeyState {
    // A run that is going does not carry on with a key that was removed.
    this.stopRun();
    setSetting(this.#appDb, 'aiAssistant.apiKey', null);
    return this.keyState();
  }

  startRun(settings: AiRunSettings): AiActionResult {
    const fail = (message: string): AiActionResult => ({ ok: false, message });
    const session = this.#live();
    if (session === null || session.route !== 'api')
      return fail('Start a session with your own API key first.');
    if (session.run?.running === true) return fail('A run is already under way.');
    const key = this.#key();
    if (key === null) return fail('Save a readable API key before starting a run.');
    if (!API_MODELS.includes(settings.model as ApiModel))
      return fail('Choose a model from the list.');
    if (!API_EFFORTS.includes(settings.effort as ApiEffort))
      return fail('Choose an effort from the list.');
    if (
      !Number.isFinite(settings.capUsd) ||
      settings.capUsd < API_CAP_MIN ||
      settings.capUsd > API_CAP_MAX
    )
      return fail('Choose a cap within the allowed range.');
    const model = settings.model as ApiModel;
    const effort = settings.effort as ApiEffort;
    const reserve = firstRequestReserve(model);
    if (reserve > settings.capUsd)
      return fail(`This model needs at least $${reserve.toFixed(4)} for its first request.`);
    if (this.#runApi === undefined || this.#makeApiClient === undefined)
      return fail('API runs are unavailable.');
    let client: AiApiClient;
    try {
      client = this.#makeApiClient(key);
    } catch {
      return fail('The API client could not be started.');
    }
    if (!this.#log(session, 'run-started', { model, effort, capUsd: settings.capUsd }))
      return fail(ENDED.log);
    const run = {
      id: randomUUID(),
      settings: { model, effort, capUsd: settings.capUsd },
      progress: null as AiApiProgress | null,
      running: true,
      abort: new AbortController(),
      busy: false,
      written: false,
    };
    session.run = run;
    session.revision += 1;
    const current = () =>
      this.#live() === session && session.route === 'api' && session.run === run && run.running;
    const options: AiApiRunOptions = {
      client,
      model,
      effort,
      capUsd: settings.capUsd,
      now: this.#now,
      signal: AbortSignal.any([session.abort.signal, run.abort.signal]),
      isCurrent: current,
      call: (name, input) =>
        current() && !run.abort.signal.aborted
          ? this.#call(session, name, input, options.signal)
          : Promise.resolve(NO_SESSION),
      onProgress: (progress) => {
        if (current()) {
          run.progress = progress;
          session.revision += 1;
        }
      },
      onRequest: (busy) => {
        if (session.run === run) {
          run.busy = busy;
          session.lastCallAt = this.#now();
          session.revision += 1;
        }
      },
    };
    void Promise.resolve()
      .then(() => this.#runApi!(options))
      .then((progress) => {
        run.progress = progress;
        run.running = false;
        run.busy = false;
        session.lastCallAt = this.#now();
        session.revision += 1;
        this.#writeRunEnd(session, run, progress.ended, progress.costMayBeHigher);
      })
      .catch(() => {
        run.running = false;
        run.busy = false;
        session.revision += 1;
        this.#writeRunEnd(session, run, 'failed', true);
      });
    return { ok: true };
  }

  /**
   * Writes the entry for the end of a run, once, from the last progress the
   * run reported. It holds counts and the reason, never a text.
   */
  #writeRunEnd(
    session: Session,
    run: NonNullable<Session['run']>,
    why: string | null,
    costMayBeHigher: boolean,
  ): void {
    if (run.written) return;
    run.written = true;
    const progress = run.progress;
    this.#write(session, 'run-ended', this.#now(), {
      model: run.settings.model,
      effort: run.settings.effort,
      capUsd: run.settings.capUsd,
      responses: progress?.responses ?? 0,
      input: progress?.usage.input ?? 0,
      output: progress?.usage.output ?? 0,
      cacheWrite: progress?.usage.cacheWrite ?? 0,
      cacheRead: progress?.usage.cacheRead ?? 0,
      costUsd: progress?.costUsd ?? 0,
      why,
      costMayBeHigher,
    });
  }

  stopRun(): void {
    const session = this.#live();
    // The run stays the current one until runApi has resolved, so that it reads
    // the signal and ends as "stopped", not as "session-ended".
    if (session?.run?.running === true) {
      session.run.abort.abort();
      session.lastCallAt = this.#now();
      session.revision += 1;
    }
  }

  /**
   * What the AI proposed since the tree was opened, the latest first: in the
   * session, and in the sessions before it. They stay after a session has
   * ended, until the tree closes or the assistant is turned off. A proposal
   * for someone who is no longer in the tree is not listed.
   */
  proposals(): AiProposal[] {
    const session = this.#session;
    if (session === null || !session.still()) return [];
    return [...session.proposals.values(), ...this.#earlier]
      .filter((proposal) => getPerson(session.tree, proposal.personId) !== null)
      .sort((a, b) => b.at - a.at);
  }

  /** The proposal a page names; null when it is not held. */
  proposal(named: AiProposalRef): AiProposal | null {
    return (
      this.proposals().find(
        (proposal) => proposal.sessionId === named.sessionId && proposal.ref === named.ref,
      ) ?? null
    );
  }

  /** Forgets one proposal. Nothing changes in the tree. False when it was not held. */
  dismiss(named: AiProposalRef): boolean {
    const session = this.#session;
    if (session === null) return false;
    const held =
      session.id === named.sessionId
        ? session.proposals.delete(named.ref)
        : this.#earlier.some(
            (proposal) => proposal.sessionId === named.sessionId && proposal.ref === named.ref,
          );
    if (!held) return false;
    this.#earlier = this.#earlier.filter(
      (proposal) => proposal.sessionId !== named.sessionId || proposal.ref !== named.ref,
    );
    this.#proposalsRevision += 1;
    session.revision += 1;
    return true;
  }

  /** The session and the count of proposals as they stand, for the page to follow. */
  state(): AiSessionState {
    return {
      session: this.status(),
      connection: this.#bridge?.state() ?? { open: false, problem: '', clients: [] },
      proposals: this.proposals().length,
      proposalsRevision: this.#proposalsRevision,
    };
  }

  /** The assistant as it stands: whether it is on, what a session may ask, and its limits. */
  info(): AiAssistantInfo {
    return {
      ...this.state(),
      agreed: this.agreed,
      searchAgreed: this.#records.agreed,
      canConnect: this.#connector !== null,
      connectorCommand: this.#connector?.command ?? '',
      connectorFileFits: this.#connector?.fileFits ?? false,
      connectorDataFolder:
        this.#connector === null || this.#connector.fileFits ? '' : this.#connector.profile,
      sources: this.#records.aiSources(),
      requestsPerSource: AI_SESSION_REQUESTS,
      idleMinutes: AI_SESSION_IDLE_MS / 60_000,
      maxCalls: AI_SESSION_CALLS,
      maxHours: AI_SESSION_MAX_MS / 3_600_000,
      logDays: AI_ACTIVITY_KEEP_DAYS,
    };
  }

  /** The connector file for Claude Desktop; null when this copy of the app has none. */
  get connectorFile(): string | null {
    return this.#connector?.file ?? null;
  }

  /**
   * A program connected to the session and proved that it holds the key of
   * the session. The log gets an entry for the first few; a program that
   * connects over and over cannot fill the log.
   */
  #connected(client: AiClientInfo): void {
    const session = this.#live();
    if (session === null) return;
    session.clients += 1;
    session.revision += 1;
    if (session.clients <= AI_SESSION_CLIENTS_LOGGED) {
      this.#log(session, 'app-connected', {
        name: cleanText(client.name, 60),
        version: cleanText(client.version, 30),
        number: session.clients,
      });
    }
  }

  /**
   * The record a proposal is about, for a press of the user to keep, cite,
   * compare or turn down: the reading the AI was given, when it was read,
   * and what the AI said of it in the form the tree keeps. Null unless the
   * request names a proposal that is held for this tree, and names the
   * person, the source and the record that proposal is about.
   */
  #copyOf(tree: Tree, request: AttachRecordRequest): ProposalCopy | null {
    if (request.proposal === undefined || this.#session?.tree !== tree) return null;
    const held = this.proposal(request.proposal);
    if (
      held === null ||
      held.personId !== request.personId ||
      held.sourceId !== request.sourceId ||
      held.key !== request.key
    ) {
      return null;
    }
    return { record: held.external, readAt: held.readAt, aiJson: keptOpinionJson(held) };
  }

  /**
   * The activity log, the latest first, each entry in words. A person is
   * named for an entry of the open tree only: an id means nothing in another.
   */
  activity(request: { offset: number; limit: number }, tree: Tree | null): AiActivityPage {
    const treeId = tree?.info().id ?? null;
    const sources = new Map(this.#records.sources().map((source) => [source.id, source.name]));
    const known = new Map<string, string>();
    /** A person of the open tree by their id. Asked for an entry of that tree only. */
    const personOf = (open: Tree, id: string): string => {
      if (id === '') return 'someone';
      let name = known.get(id);
      if (name === undefined) {
        if (getPerson(open, id) === null) {
          name = 'someone who is no longer in the tree';
        } else {
          const names = listNames(open, id);
          const main = names.find((entry) => entry.isPrimary) ?? names[0];
          const written = main === undefined ? '' : cleanText(`${main.given} ${main.surname}`, 400);
          name = written === '' ? 'someone without a name' : written;
        }
        known.set(id, name);
      }
      return name;
    };
    const limit = Math.min(AI_ACTIVITY_PAGE_MAX, Math.max(1, Math.trunc(request.limit) || 1));
    const offset = Math.max(0, Math.trunc(request.offset) || 0);
    return {
      // app.db can hold a moment that is none, as any file can, and showing
      // one would stop the page from showing the log. Such an entry is left out.
      items: listAiActivity(this.#appDb, { offset, limit })
        .filter((entry) => whenOf(entry.at) !== null)
        .map((entry) => {
          const open = tree !== null && entry.treeId === treeId ? tree : null;
          return {
            id: entry.id,
            at: entry.at,
            sessionId: entry.sessionId,
            thisTree: open !== null,
            what: activityWords(entry, {
              person: (id) => (open === null ? 'a person of another tree' : personOf(open, id)),
              source: (id) => sources.get(id) ?? (id === '' ? 'a service' : cleanText(id, 100)),
            }),
          };
        }),
      total: countAiActivity(this.#appDb),
    };
  }

  /** Removes every entry of the activity log. A session that is under way goes on, and writes into the empty log. */
  clearActivity(): void {
    clearAiActivity(this.#appDb);
  }

  /**
   * Ends the session that is under way: no tool gives anything more, and
   * nothing more is sent. What it proposed stays. 'page' when it is ended
   * not by the user but because the page that shows it was loaded again or
   * is gone, 'quit' when the app is closing.
   */
  stop(why: 'stopped' | 'page' | 'quit' = 'stopped'): void {
    // A session that had run out of time before this ended for that reason.
    this.#live();
    if (this.#session !== null) this.#end(this.#session, why);
  }

  /** Ends the session and forgets what it found and proposed. For when a tree closes. */
  clear(): void {
    if (this.#session !== null) this.#end(this.#session, 'tree-closed');
    this.#forget();
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
    if (session === null || session.route !== 'app') return NO_SESSION;
    return this.#call(session, name, input);
  }

  async #call(
    session: Session,
    name: string,
    input: unknown,
    stop?: AbortSignal,
  ): Promise<AiToolResult> {
    if (this.#live() !== session) return NO_SESSION;
    session.calls += 1;
    session.revision += 1;
    if (session.calls > AI_SESSION_CALLS) {
      this.#end(session, 'calls');
      return NO_SESSION;
    }
    if (typeof name !== 'string' || !isToolName(name)) {
      return refuse('unknown-tool', 'There is no tool of this name.');
    }
    try {
      return await this.#run(session, name, input, stop);
    } catch {
      // Nothing of what went wrong is passed on: it can name a file or hold a text of the tree.
      return refuse('failed', 'The call failed.');
    }
  }

  #run(
    session: Session,
    name: AiToolName,
    input: unknown,
    stop?: AbortSignal,
  ): Promise<AiToolResult> {
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
        return this.#take(name, input, (given) => this.#searchRecords(session, given, stop));
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
    // Only a call a tool can take puts off the end of the session: one that
    // names no tool, or sends what its tool does not take, keeps nothing alive.
    const session = this.#session;
    if (session !== null && session.status === 'running') session.lastCallAt = this.#now();
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
    } else {
      // Where both ends have passed before anybody looked, the earlier one is why it ended.
      const timeUp = session.startedAt + AI_SESSION_MAX_MS;
      if (session.run?.busy === true) session.lastCallAt = this.#now();
      const idleUp = session.lastCallAt + AI_SESSION_IDLE_MS;
      if (this.#now() >= Math.min(timeUp, idleUp)) {
        this.#end(session, idleUp < timeUp ? 'idle' : 'time', Math.min(timeUp, idleUp));
      }
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
    session.run?.abort.abort();
    // No AI app reaches a session that has ended: the pipe, its key and the file that names them go.
    this.#bridge?.close();
    if (this.#watch !== null) clearInterval(this.#watch);
    this.#watch = null;
    // The log is tried once more, except when it is the log that failed.
    if (why !== 'log') {
      this.#write(session, 'session-ended', at, {
        why,
        calls: session.calls,
        questions: session.questions.length,
        proposals: session.proposals.size,
        programs: session.clients,
      });
    }
    // A run under way ends with the session. Its entry is written now, from
    // what it last reported: by the time it settles the log may be gone, or
    // cleared. A request in flight may still be billed.
    const run = session.run;
    if (run?.running === true) {
      const mayBeHigher = run.busy || run.progress?.costMayBeHigher === true;
      run.running = false;
      run.busy = false;
      this.#writeRunEnd(session, run, 'session-ended', mayBeHigher);
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
      route: session.route,
      run:
        session.run === null
          ? null
          : {
              id: session.run.id,
              settings: { ...session.run.settings },
              progress:
                session.run.progress === null
                  ? null
                  : { ...session.run.progress, usage: { ...session.run.progress.usage } },
              running: session.run.running,
            },
      status: session.status,
      ended: session.ended,
      endedMessage: session.endedMessage,
      startedAt: session.startedAt,
      idleAt: session.status === 'running' ? session.lastCallAt + AI_SESSION_IDLE_MS : null,
      lastsUntil: session.status === 'running' ? session.startedAt + AI_SESSION_MAX_MS : null,
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
    stop?: AbortSignal,
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
      .then(() => this.#ask(session, source, question, stop))
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
  async #ask(
    session: Session,
    source: SourceLine,
    question: AiQuestion,
    stop?: AbortSignal,
  ): Promise<AiToolResult> {
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

    // A question that came through the door of a run also ends with the run: Stop cuts the wait short.
    const signal =
      stop === undefined ? session.abort.signal : AbortSignal.any([session.abort.signal, stop]);
    const stopped = 'The run was stopped, so nothing was sent.';
    const runStopped = (): boolean => stop?.aborted === true && live();
    if (!live()) {
      unsent(over);
      return NO_SESSION;
    }
    if (runStopped()) {
      unsent(stopped);
      return refuse('not-sent', stopped);
    }
    if (source.lastAt !== null) {
      const due = source.lastAt + this.#gapMs - this.#now();
      try {
        if (due > 0) await this.#wait(due, signal);
      } catch {
        // The wait was given up: the session ended meanwhile.
      }
      if (!live()) {
        unsent(over);
        return NO_SESSION;
      }
      if (runStopped()) {
        unsent(stopped);
        return refuse('not-sent', stopped);
      }
    }
    const result = await this.#records.searchForAi(
      session.tree,
      { personId, sourceId, query },
      signal,
      // The session's own last look, when the request's turn has come.
      () => {
        if (!live()) return problem('cancelled', over);
        if (runStopped()) return problem('cancelled', stopped);
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

    if (!result.ok && !result.sent && runStopped()) {
      // Stopped before it went out: nothing is counted and nothing is written.
      unsent(stopped);
      return refuse('not-sent', stopped);
    }
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
        session.found.set(ref, {
          ref,
          personId,
          sourceId,
          record,
          shared: shared.record,
          readAt: result.fetchedAt,
        });
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
      sessionId: session.id,
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
      external: found.record,
      readAt: found.readAt,
    });
    this.#proposalsRevision += 1;
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
