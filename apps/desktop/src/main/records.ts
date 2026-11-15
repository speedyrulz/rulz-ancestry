import { createHash } from 'node:crypto';
import { mayShareWithAi } from '@rulz/ai';
import {
  CENSUS_PACK_ID_PATTERN,
  ConnectorError,
  HttpClient,
  HttpError,
  citationSourceOf,
  cleanText,
  deepLinkSources,
  internetArchiveConnector,
  internetArchiveManifest,
  isOnSite,
  locConnector,
  locManifest,
  naraCatalogConnector,
  naraCatalogManifest,
  nara1950SearchManifest,
  OA_PACK_KIND,
  oaRecordsOf,
  openArchivesConnector,
  openArchivesManifest,
  openArchivesSpan,
  wikidataConnector,
  wikidataManifest,
  wikitreeConnector,
  wikitreeManifest,
  type ConnectorManifest,
  type DeepLinkSource,
  type HostMemory,
  type HttpFetch,
  type SearchAnswer,
  type SearchOptions,
  type SourceConnector,
} from '@rulz/connectors';
import {
  CITATION_LIMITS,
  PLACE_TEXT_MAX,
  canCiteFor,
  canTakeDate,
  canTakePlace,
  describeDate,
  isEventOf,
  isEmptyQuery,
  isEmptyTextQuery,
  jdnToCalendar,
  scoreRecord,
  parseDate,
  queryYear,
  recordFacts,
  relateDates,
  relatePlaces,
  textQueryProblem,
  type ExternalRecord,
  type MatchSubject,
  type RecordFact,
  type PageRequest,
  type PersonQuery,
  type TextQuery,
} from '@rulz/core';
import {
  RECORD_MARK_LIMIT,
  citedUrls,
  countRecordMarks,
  getPerson,
  getRecordMark,
  getSetting,
  listCitations,
  listNames,
  listPersonEvents,
  listRecordMarks,
  recordMarkStatesFor,
  PackSearchStopped,
  presumedLivingIds,
  setSetting,
  type CitationInput,
  type ConnectorSource,
  type Db,
  type RecordFactsPlan,
  type RecordMarkInput,
  type Tree,
  type TreeEvent,
} from '@rulz/db';
import type {
  AiOpinionInfo,
  AiProposalItem,
  AttachRecordRequest,
  CompareRecordResult,
  PackInfo,
  RecordComparison,
  RecordCopy,
  RecordFactTarget,
  RecordInboxItem,
  RecordInboxPage,
  RecordInboxRequest,
  RecordLinkInfo,
  RecordLinkRequest,
  RecordSearchProblem,
  RecordSearchRequest,
  RecordSearchResult,
  RecordFitInfo,
  RecordSearchSetup,
  RecordSourceInfo,
  RecordSourceKeyResult,
  TakeRecordFactsRequest,
  TextSearchRequest,
} from '../shared/ipc';
import { keptOpinionJson, keptOpinionOf } from './keptopinion';
import { keptFormOf, keptRecordOf, madeAddress, markTitle, whenOf } from './keptrecord';

/**
 * The search for records outside the tree. This is the one place where
 * something of a tree leaves the PC: a name and two years, typed or confirmed
 * by the user, go to a source the user sees named, when they press "Search".
 * A source of newspapers or books is asked for words instead, which start as
 * the person's name, and for the years they were printed in.
 *
 * Three rules are kept here, in the main process, so that no page and no later
 * part of the app can go around them:
 *
 * - nothing is sent before the user has agreed to the notice that says what a
 *   search sends, and to whom;
 * - nothing is sent for a person who may be living;
 * - a source is reached through its own client only (`@rulz/connectors`),
 *   which keeps to its address and its limits.
 *
 * Results are kept in memory by that client for a while. Nothing of them is
 * written to disk unless the user says so, result by result: one that is
 * attached becomes a citation, and one that is kept for later or turned down
 * becomes a mark in the tree (see `keptrecord.ts`). Nothing here uses
 * Electron; the function that fetches is handed in.
 *
 * What the user types into the form is theirs to send: the second rule looks
 * at the person the search was opened for, not at the words. The form is
 * never filled in for a person who may be living.
 *
 * Some sites the app must never ask itself (`deepLinkSources`). For those it
 * only makes the address of a search, which the user's browser opens. The
 * name and the years go to the site all the same, so the first two rules hold
 * for a link as they do for a search.
 *
 * A result can be attached to the person it was found for. The page names it
 * by its key only; what is written into the tree is what this service itself
 * read from the source, and nothing is sent.
 *
 * A result can also be set beside the person, and dates and places of it
 * taken over. The page says which, by the type of an event and the event of
 * the tree; the values are this service's own. What the page chose is taken
 * only while the tree is still as the comparison showed it.
 *
 * A result that is kept can be attached, compared and taken from later, from
 * the copy the tree holds. The page still names it by its key only, and says
 * which copy it means; that copy is read from the tree and checked again
 * here, since a tree's file can come from anywhere.
 *
 * A search for several people (`recordrun.ts`) asks through `searchOnce`, one
 * person at one source at a time. The three rules hold for each of its
 * questions as they do for a search of one person, and it is sent the name
 * and the years the tree has, which the list before the run showed.
 *
 * A session of the optional AI assistant (`aisession.ts`) asks through
 * `searchForAi`. The three rules hold for it too. Only a source whose terms
 * let its results be passed on to an AI is asked, and what is sent is what
 * the session let through of what the AI asked for.
 *
 * What an AI proposes about a record is a third copy of a result, beside the
 * one a search showed and the one the tree keeps: the record as it read when
 * the AI was given it. The page names a proposal, and the session hands the
 * copy over (`useProposals`). A proposed record that is kept for later takes
 * what the AI said of it along into the tree's file, and that is checked
 * again when it is read back (`keptopinion.ts`).
 */

/** The setting that holds the day the user agreed to the notice. */
export const RECORD_SEARCH_NOTICE_SETTING = 'recordSearch.noticeAgreedAt';

/** The setting that holds which wording of the notice the user agreed to. */
export const RECORD_SEARCH_NOTICE_VERSION_SETTING = 'recordSearch.noticeVersion';

/**
 * The wording of the notice. It goes up when the notice has more to say: more
 * that is sent, or someone else it is sent to. An agreement to an earlier
 * wording does not count, and the notice is shown again.
 *
 * 1: a name and two years, to WikiTree, and in a link to sites opened in the browser.
 * 2: also words and the years of printing, to the Library of Congress and the Internet Archive.
 * 3: the name and the years also to Open Archives, and the name to Wikidata.
 * 4: words, and the user's own key, to the US National Archives.
 * 5: one press can send the names and the years of several people: a person
 *    and their ancestors, as a list shows them before the press.
 * 6: a page image of the 1950 census is asked of its bucket
 *    (nara-1950-census.s3.us-east-2.amazonaws.com) when the user views a
 *    district's page: the pack, the district and the page's number go there,
 *    and nothing of the tree.
 */
export const RECORD_SEARCH_NOTICE_VERSION = 6;

/** The setting that holds the user's key for a source, as Windows encrypted it. */
export const recordSearchKeySetting = (sourceId: string) => `recordSearch.key.${sourceId}`;

/**
 * What keeps a secret for this user of the PC. The app hands in Windows' own
 * data protection; nothing here knows how it works. A secret is never kept
 * as it is: when the PC cannot encrypt, nothing is saved.
 */
export interface SecretStore {
  /** False when this PC cannot encrypt for the user. */
  available(): boolean;
  /** A text as it may be written to the settings. */
  encrypt(text: string): string;
  /** The text again. Throws when it cannot be read: another account, a profile from another PC. */
  decrypt(kept: string): string;
}

/** The setting that holds what the client keeps about a host between runs of the app. */
export const recordSearchHostSetting = (host: string) => `recordSearch.host.${host}`;

/** How many results are asked for at a time. */
export const RECORD_SEARCH_PAGE = 20;

/**
 * How many results are remembered for attaching. The oldest go first. A
 * search for several people brings 2,520 at most (63 people, two sources, 20
 * results each), and all of them must stay at hand while its window is open.
 */
const SHOWN_LIMIT = 5000;

/**
 * The sources a search for several people may ask, as the project owner
 * decided on 2026-11-14: those that keep people or records of people, whose
 * results can be held against a person of the tree. The others are left to
 * the search for one person: a text gets no label, the Library of Congress
 * shuts a client out for an hour, the terms of the Internet Archive have not
 * been read, the National Archives count each question against the user's own
 * key, and Wikidata keeps people of some note only.
 */
export const RECORD_RUN_SOURCE_IDS: readonly string[] = [
  wikitreeManifest.id,
  openArchivesManifest.id,
];

/**
 * A data pack that is installed on this PC is one more route for the search
 * of a person, with the id `pack:<packId>`. A route id is what a page names a
 * result's source by; what the tree keeps a result under is its source, and for
 * a result of a pack that is the source the pack was made from (every pack of
 * 5.1 is made from Open Archives' files). `markSourceOf` is the one place that
 * maps the one to the other, and it is used wherever a mark is written, read
 * or removed.
 */
export const PACK_ROUTE_PATTERN = /^pack:([a-z0-9]{2,12})$/;

/**
 * The source a result of this route is kept, marked and cited under. Only a
 * pack of Open Archives is a route of the search: a pack of the 1950 census
 * (its id is `c50` and a state's code) is browsed, never searched for a person,
 * and its id names no source here.
 */
export function markSourceOf(routeId: string): string {
  const id = PACK_ROUTE_PATTERN.exec(routeId)?.[1];
  return id !== undefined && !CENSUS_PACK_ID_PATTERN.test(id) ? openArchivesManifest.id : routeId;
}

/** What the search for records needs of the installed packs. `PackManager` is one. */
export interface PackRoutes {
  /** The packs that can be searched. */
  ready(): PackInfo[];
  /** Looks for rows of one pack; rejects when the search is given up. */
  search(
    id: string,
    q: {
      names: string;
      places?: string;
      limit: number;
      offset: number;
      years?: { from: number; to: number };
    },
    signal: AbortSignal,
  ): Promise<{ rows: Record<string, string>[]; total: number }>;
}

/** True for a person who may be in the 1950 census: born in 1950 or before, or no birth year known. */
function bornByCensus(birthYear: number | null): boolean {
  return birthYear === null || birthYear <= 1950;
}

/** What a pack is searched for: the surname's words, then the given name's (not one letter alone, which is an initial). */
function packNames(query: PersonQuery): string {
  const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...words(query.surname), ...words(query.given).filter((word) => [...word].length >= 2)]
    .slice(0, 8)
    .join(' ');
}

/** A question that may not be sent after all, as the last look before sending found. */
class Refusal extends Error {
  readonly problem: RecordSearchProblem;

  constructor(problem: RecordSearchProblem) {
    super(problem.message);
    this.name = 'Refusal';
    this.problem = problem;
  }
}

const GIVEN_UP: RecordSearchProblem = {
  kind: 'cancelled',
  message: 'The search was given up.',
  retryAt: null,
};

const NOT_AGREED: RecordSearchProblem = {
  kind: 'notice',
  message: 'Nothing is sent before you have agreed to what a search sends.',
  retryAt: null,
};

/** The answer to one question of a session of the AI assistant; see `RecordSearchService.searchForAi`. */
export type AiSearchResult =
  | {
      ok: true;
      /** The source that answered, for the form its records are passed on in. */
      manifest: ConnectorManifest;
      /** The first results of the source, as its connector read them just now. */
      records: ExternalRecord[];
      /** How many results the source has in all; null when it does not say. */
      total: number | null;
      /** True when the source has more results than these. */
      more: boolean;
      /** How many results were left out: private profiles and living people. */
      hidden: number;
      fetchedAt: number;
      /** True when the answer was kept from an earlier search and nothing was sent. */
      cached: boolean;
    }
  | {
      ok: false;
      problem: RecordSearchProblem;
      /**
       * True when the request was let go to the source before it failed: its
       * last look passed, which is the last thing before the client sends.
       * False when nothing can have reached the source.
       */
      sent: boolean;
    };

/**
 * The record a proposal of the AI assistant is about, as the session holds
 * it: the reading the AI was given and when it came from the source, and
 * what the AI said of it as the tree keeps it (null when that is too long
 * to keep).
 */
export interface ProposalCopy {
  record: ExternalRecord;
  readAt: number;
  aiJson: string | null;
}

/** A proposal as the session holds it, as far as listing it for the user needs. */
export interface HeldProposal {
  sessionId: string;
  ref: string;
  personId: string;
  sourceId: string;
  key: string;
  /** When the AI proposed it. */
  at: number;
  verdict: AiOpinionInfo['verdict'];
  confidence: AiOpinionInfo['confidence'];
  reasons: readonly AiOpinionInfo['reasons'][number][];
  dropped: readonly unknown[];
  /** The record as it read when the AI was given it. */
  external: ExternalRecord;
  readAt: number;
}

/** What is needed to cite a result; see `RecordSearchService.attachment`. */
export type RecordAttachment =
  | { ok: true; connector: ConnectorSource; citation: CitationInput & { url: string } }
  | { ok: false; problem: RecordSearchProblem };

/** What keeping a result or turning it down writes into the tree; see `RecordSearchService.keeping`. */
export type RecordMarking =
  { ok: true; mark: RecordMarkInput } | { ok: false; problem: RecordSearchProblem };

/** What taking facts of a result over writes into the tree; see `RecordSearchService.take`. */
export type RecordTake =
  | {
      ok: true;
      connector: ConnectorSource;
      citation: CitationInput & { url: string };
      plan: RecordFactsPlan;
    }
  | { ok: false; problem: RecordSearchProblem; comparison: RecordComparison | null };

export interface RecordSearchOptions {
  appDb: Db;
  fetch: HttpFetch;
  /** The app's version, for the name it gives itself to a source. */
  appVersion: string;
  /** The clock, replaceable in tests. */
  now?: () => number;
  /** What keeps the user's keys. Without it no key can be saved, and a source that needs one is not asked. */
  secrets?: SecretStore;
  /** The data packs on this PC, searched as routes of their own. Without it there are none. */
  packs?: PackRoutes;
}

/** What the app calls itself to a source: its name, its version and where its code is. */
export function userAgentOf(appVersion: string): string {
  return `RulZAncestry/${appVersion} (+https://github.com/speedyrulz/rulz-ancestry)`;
}

const EMPTY_QUERY: PersonQuery = { given: '', surname: '', birthYear: null, deathYear: null };

const EMPTY_TEXT_QUERY: TextQuery = {
  words: '',
  phrase: true,
  fromYear: null,
  toYear: null,
  state: '',
};

/**
 * What of the search form each source is sent, in words for the notice and
 * the form. A source that is not named here is not offered: the user must be
 * told what goes to it. Keep these true to the connectors (`*SearchParams`).
 */
const ASKS: Readonly<Record<string, string>> = {
  [wikitreeManifest.id]: 'the given name, the last name and the years of birth and death',
  [openArchivesManifest.id]:
    'the given name, the last name, and a span of years from two years before the birth to two years after the death; with only one of the two years, the span reaches 110 years from it. It looks in records of Dutch and Belgian archives for someone of that name, in any role',
  [wikidataManifest.id]:
    'the given name and the last name, not the years. It has entries for people of some note only',
  [locManifest.id]:
    'the words, the years of printing and the state. It looks in the text of newspaper pages',
  [internetArchiveManifest.id]:
    'the words only. It looks in the titles, authors and descriptions of books, not inside them',
  [naraCatalogManifest.id]:
    'the words only, and your own key, which tells the Archives whose search it is. It looks in the descriptions of the records the Archives hold',
};

/** One of the searches of a source, with what it is asked already in it. */
type Ask = (page: PageRequest, options: SearchOptions) => Promise<SearchAnswer>;

export class RecordSearchService {
  readonly #appDb: Db;
  readonly #http: HttpClient;
  readonly #connectors: SourceConnector[];
  readonly #now: () => number;
  /** The search that is under way at each source. A new one gives the old one up. */
  readonly #underWay = new Map<string, AbortController>();
  readonly #links: readonly DeepLinkSource[] = deepLinkSources;
  /**
   * The results shown since the tree was opened, by the person they were
   * found for, their source and their key. One record can be found for two
   * people, a father and a son of one name, and is then a result of each.
   */
  readonly #shown = new Map<
    string,
    { personId: string; sourceId: string; record: ExternalRecord; readAt: number }
  >();
  /** Counts the trees that closed, so that an answer for an earlier tree is not kept. */
  #closed = 0;
  readonly #secrets: SecretStore | undefined;
  readonly #packs: PackRoutes | undefined;
  /** Hands over the record a proposal of the AI assistant is about; null until the assistant is set up. */
  #proposalCopy: ((tree: Tree, request: AttachRecordRequest) => ProposalCopy | null) | null = null;

  constructor(options: RecordSearchOptions) {
    this.#appDb = options.appDb;
    this.#now = options.now ?? Date.now;
    this.#secrets = options.secrets;
    this.#packs = options.packs;
    // A source's pause and its count of requests outlast the app: the Library
    // of Congress shuts a client out for an hour, whether or not the app was
    // closed in between. They are kept with the app's settings, not in a tree.
    const appDb = this.#appDb;
    const memory: HostMemory = {
      load: (host) => {
        const kept = getSetting(appDb, recordSearchHostSetting(host));
        return kept === null ? null : (JSON.parse(kept) as unknown);
      },
      save: (host, record) =>
        setSetting(appDb, recordSearchHostSetting(host), JSON.stringify(record)),
    };
    this.#http = new HttpClient({
      fetch: options.fetch,
      userAgent: userAgentOf(options.appVersion),
      now: this.#now,
      memory,
      // The key is read and decrypted for each request, and kept nowhere here.
      keyOf: (manifest) => this.#keyOf(manifest.id),
    });
    const connectors: SourceConnector[] = [
      wikitreeConnector(this.#http.for(wikitreeManifest)),
      openArchivesConnector(this.#http.for(openArchivesManifest), this.#now),
      wikidataConnector(this.#http.for(wikidataManifest), this.#now),
      locConnector(this.#http.for(locManifest)),
      internetArchiveConnector(this.#http.for(internetArchiveManifest)),
      naraCatalogConnector(this.#http.for(naraCatalogManifest)),
    ];
    this.#connectors = connectors.filter(({ manifest }) => ASKS[manifest.id] !== undefined);
  }

  /** True once the user has agreed to the notice as it is worded now. */
  get agreed(): boolean {
    // An agreement from before the wordings were numbered was to the first.
    // Anything that is no whole number is no agreement.
    const kept = getSetting(this.#appDb, RECORD_SEARCH_NOTICE_VERSION_SETTING) ?? '1';
    const version = /^[1-9]\d{0,5}$/.test(kept) ? Number(kept) : 0;
    return (
      getSetting(this.#appDb, RECORD_SEARCH_NOTICE_SETTING) !== null &&
      version >= RECORD_SEARCH_NOTICE_VERSION
    );
  }

  agree(): void {
    if (!this.agreed) {
      setSetting(this.#appDb, RECORD_SEARCH_NOTICE_SETTING, new Date(this.#now()).toISOString());
      setSetting(
        this.#appDb,
        RECORD_SEARCH_NOTICE_VERSION_SETTING,
        String(RECORD_SEARCH_NOTICE_VERSION),
      );
    }
  }

  /**
   * Says where the record of a proposal of the AI assistant comes from. The
   * session of the assistant holds it, and hands it over for a request that
   * names a proposal it holds for this tree, this person and this record;
   * for any other it hands over nothing, and the request is refused.
   */
  useProposals(copyOf: (tree: Tree, request: AttachRecordRequest) => ProposalCopy | null): void {
    this.#proposalCopy = copyOf;
  }

  sources(): RecordSourceInfo[] {
    const live = this.#connectors.map((connector): RecordSourceInfo => ({
      id: connector.manifest.id,
      name: connector.manifest.name,
      searches: connector.searchPersons === undefined ? 'text' : 'person',
      asks: ASKS[connector.manifest.id] ?? '',
      slowSeconds: connector.manifest.timeoutSeconds ?? null,
      key: this.#keyState(connector.manifest),
      quota: this.#quotaOf(connector.manifest),
      attribution: connector.manifest.attribution,
      termsUrl: connector.manifest.termsUrl,
      pausedUntil: this.#http.pausedUntil(connector.manifest),
    }));
    return [...live, ...this.#packSources()];
  }

  /** The installed packs that can be searched, as routes of the search. They send nothing anywhere. */
  #packSources(): RecordSourceInfo[] {
    return (this.#packs?.ready() ?? [])
      .filter((pack) => pack.kind === OA_PACK_KIND)
      .filter((pack) => this.#connectorOf(`pack:${pack.id}`) !== undefined)
      .map((pack) => ({
        id: `pack:${pack.id}`,
        name: `${pack.title} (pack on this PC)`,
        searches: 'person' as const,
        asks: 'nothing: the pack is searched on this PC',
        slowSeconds: null,
        key: 'none' as const,
        quota: null,
        attribution: pack.credit !== '' ? pack.credit : openArchivesManifest.attribution,
        termsUrl: openArchivesManifest.termsUrl,
        pausedUntil: null,
      }));
  }

  /** The connector whose manifest a result of this route is kept and cited under. */
  #connectorOf(routeId: string): SourceConnector | undefined {
    const sourceId = markSourceOf(routeId);
    return this.#connectors.find(({ manifest }) => manifest.id === sourceId);
  }

  /** The user's key for a source; null when none is saved or it cannot be read. */
  #keyOf(sourceId: string): string | null {
    const kept = getSetting(this.#appDb, recordSearchKeySetting(sourceId));
    if (kept === null || this.#secrets === undefined) return null;
    try {
      const key = this.#secrets.decrypt(kept);
      return key === '' ? null : key;
    } catch {
      return null;
    }
  }

  #keyState(manifest: ConnectorManifest): RecordSourceInfo['key'] {
    if (manifest.auth !== 'apiKey') return 'none';
    const kept = getSetting(this.#appDb, recordSearchKeySetting(manifest.id));
    if (kept !== null) return this.#keyOf(manifest.id) === null ? 'unreadable' : 'saved';
    return this.#secrets?.available() === true ? 'missing' : 'unavailable';
  }

  #quotaOf(manifest: ConnectorManifest): RecordSourceInfo['quota'] {
    const state = this.#http.quotaOf(manifest);
    return state === null || manifest.quota === undefined
      ? null
      : {
          used: state.used,
          ceiling: state.ceiling,
          period: manifest.quota.period,
          resetsAt: state.resetsAt,
        };
  }

  /** The source a key is for; undefined when the id names none that needs one. */
  #keyed(sourceId: string): SourceConnector | undefined {
    return this.#connectors.find(
      ({ manifest }) => manifest.id === sourceId && manifest.auth === 'apiKey',
    );
  }

  /**
   * Saves the user's own key for a source, encrypted for this user of the PC.
   * Nothing is sent: whether the source accepts the key shows at the first search.
   */
  setKey(sourceId: string, key: string): RecordSourceKeyResult {
    if (this.#keyed(sourceId) === undefined) {
      return { ok: false, message: 'This source takes no key.' };
    }
    if (this.#secrets?.available() !== true) {
      return {
        ok: false,
        message:
          'This PC cannot encrypt the key for your Windows account, so the app does not save it.',
      };
    }
    let kept: string;
    try {
      kept = this.#secrets.encrypt(key);
    } catch {
      return { ok: false, message: 'The key could not be encrypted, so it was not saved.' };
    }
    setSetting(this.#appDb, recordSearchKeySetting(sourceId), kept);
    return { ok: true, sources: this.sources() };
  }

  /** Removes the saved key of a source. The count of what was asked this month stays. */
  removeKey(sourceId: string): RecordSourceKeyResult {
    if (this.#keyed(sourceId) === undefined) {
      return { ok: false, message: 'This source takes no key.' };
    }
    setSetting(this.#appDb, recordSearchKeySetting(sourceId), null);
    return { ok: true, sources: this.sources() };
  }

  /**
   * What the search form starts with for a person: whether they may be
   * searched for, and their name and years. Null when the person is gone.
   * Of a person who may be living nothing is filled in.
   */
  setup(tree: Tree, personId: string): RecordSearchSetup | null {
    if (getPerson(tree, personId) === null) return null;
    const allowed = !presumedLivingIds(tree, this.#now()).has(personId);
    return {
      allowed,
      agreed: this.agreed,
      query: allowed ? queryOf(tree, personId) : EMPTY_QUERY,
      text: allowed ? textQueryOf(queryOf(tree, personId)) : EMPTY_TEXT_QUERY,
      sources: this.sources(),
      links: this.links(tree, personId),
    };
  }

  /**
   * The sites a search can be opened at in the user's browser. The name search
   * of the 1950 census is listed only for a person who was born in 1950 or
   * before, or whose birth year is not known: the census cannot hold anyone
   * born later. Without a person, every site is listed.
   */
  links(tree?: Tree, personId?: string): RecordLinkInfo[] {
    const born =
      tree !== undefined && personId !== undefined ? queryOf(tree, personId).birthYear : null;
    const census = bornByCensus(born);
    return this.#links
      .filter(({ manifest }) => census || manifest.id !== nara1950SearchManifest.id)
      .map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        termsUrl: manifest.termsUrl,
      }));
  }

  /** The site the tree keeps a source for under this id; undefined when the app knows none. */
  site(id: string): ConnectorSource | undefined {
    const manifest = [...this.#connectors, ...this.#links].find(
      (entry) => entry.manifest.id === id,
    )?.manifest;
    return manifest === undefined ? undefined : { id, create: citationSourceOf(manifest) };
  }

  /**
   * The address of a search for a person at a site the app does not ask
   * itself, for the user's browser. Nothing is sent here; the browser sends
   * the name and the years when it opens the address, so the rules of a
   * search apply.
   */
  link(
    tree: Tree,
    request: RecordLinkRequest,
  ): { ok: true; url: string } | { ok: false; problem: RecordSearchProblem } {
    const fail = (problem: RecordSearchProblem) => ({ ok: false as const, problem });
    const source = this.#links.find(({ manifest }) => manifest.id === request.linkId);
    if (source === undefined) {
      return fail({ kind: 'source', message: 'This site is not known.', retryAt: null });
    }
    if (!this.agreed) {
      return fail({
        kind: 'notice',
        message: 'Nothing is sent before you have agreed to what a search sends.',
        retryAt: null,
      });
    }
    const refusal = this.#refusal(tree, request.personId);
    if (refusal !== null) return fail(refusal);
    // The census cannot hold anyone born after 1950: the same rule as for the listed links.
    if (
      source.manifest.id === nara1950SearchManifest.id &&
      !bornByCensus(queryOf(tree, request.personId).birthYear)
    ) {
      return fail({
        kind: 'choice',
        message: 'The 1950 census holds only people born in 1950 or before.',
        retryAt: null,
      });
    }
    const url = source.buildSearchUrl(request.query);
    if (url === null) {
      return fail({ kind: 'empty', message: 'Give a name to search for.', retryAt: null });
    }
    return { ok: true, url };
  }

  /**
   * What citing a result of a search writes into the tree. The result must be
   * one this service showed for this person since the tree was opened, or one
   * the tree keeps for them: the page passes its key, never its contents.
   */
  attachment(tree: Tree, request: AttachRecordRequest): RecordAttachment {
    const found = this.#shownFor(tree, request);
    if (!found.ok) return found;
    const { connector, record } = found;
    // A kept copy says what the source said on the day it was read, not
    // today; and so does the copy a proposal is about. A result of a pack was
    // read on the day the pack's files were downloaded, whatever day it is now.
    const accessedAt = localDay(
      found.from === 'search' && !PACK_ROUTE_PATTERN.test(request.sourceId)
        ? this.#now()
        : found.readAt,
    );
    // A source whose terms bar keeping what it returns is cited by the
    // record's identifier and address alone; the app made both itself.
    if (connector.manifest.mayStoreText === false) {
      return {
        ok: true,
        connector: { id: connector.manifest.id, create: citationSourceOf(connector.manifest) },
        citation: {
          page: cleanText(`Identifier ${record.key}`, CITATION_LIMITS.page),
          text: '',
          url: record.url,
          accessedAt,
        },
      };
    }
    return {
      ok: true,
      connector: { id: connector.manifest.id, create: citationSourceOf(connector.manifest) },
      citation: {
        page: cleanText(`${record.title} (${record.key})`, CITATION_LIMITS.page),
        text:
          record.kind === 'person'
            ? factsText(record)
            : record.kind === 'event'
              ? eventText(record)
              : printText(record),
        url: record.url,
        accessedAt,
      },
    };
  }

  /**
   * The result a request names, with its source. It must be one this service
   * showed for this person since the tree was opened, or, when the request
   * says so, the copy the tree keeps for them, or the copy a proposal of the
   * AI assistant is about; and it must lead to the site of its source. A
   * request for one copy is never answered with another.
   */
  #shownFor(
    tree: Tree,
    request: AttachRecordRequest,
  ):
    | {
        ok: true;
        connector: SourceConnector;
        record: ExternalRecord;
        /** When the record was read from its source. */
        readAt: number;
        /** Which copy it is. */
        from: RecordCopy;
        /** What an AI said of it, as the tree keeps it; null unless the copy is a proposal's, and when that is too long to keep. */
        aiJson: string | null;
      }
    | { ok: false; problem: RecordSearchProblem } {
    const fail = (kind: RecordSearchProblem['kind'], message: string) => ({
      ok: false as const,
      problem: { kind, message, retryAt: null },
    });
    if (getPerson(tree, request.personId) === null) {
      return fail('gone', 'This person is no longer in the tree.');
    }
    // For a result of a pack the connector is that of the source the pack was made from.
    const connector = this.#connectorOf(request.sourceId);
    const isPack = PACK_ROUTE_PATTERN.test(request.sourceId);
    const from: RecordCopy = request.from ?? 'search';
    let at: { record: ExternalRecord; readAt: number; aiJson?: string | null } | null = null;
    if (connector !== undefined && from === 'inbox') {
      // Read from the tree's file, and checked: the file can come from anywhere.
      const mark = getRecordMark(
        tree,
        request.personId,
        markSourceOf(request.sourceId),
        request.key,
      );
      const record = mark === null ? null : keptRecordOf(mark, connector);
      if (mark !== null && record !== null) at = { record, readAt: mark.readAt };
    } else if (connector !== undefined && from === 'proposal') {
      // The reading the AI was given, from the session that holds the proposal.
      // The AI is never given a result of a pack, so there is none to hand over.
      at = isPack ? null : (this.#proposalCopy?.(tree, request) ?? null);
    } else if (connector !== undefined) {
      at = this.#shown.get(shownKey(request.personId, request.sourceId, request.key)) ?? null;
    }
    if (connector === undefined || at === null) {
      return fail(
        'record',
        from === 'inbox'
          ? 'This result is no longer kept, or what the tree holds of it cannot be read.'
          : from === 'proposal'
            ? 'This proposal is no longer at hand: it was forgotten, or the tree was closed since.'
            : 'This result is no longer at hand. Search again, then attach it.',
      );
    }
    if (!isOnSite(at.record.url, connector.manifest)) {
      return fail(
        'record',
        'This result does not lead to the site of its source, so it is not attached.',
      );
    }
    return {
      ok: true,
      connector,
      record: at.record,
      readAt: at.readAt,
      from,
      aiJson: at.aiJson ?? null,
    };
  }

  /** Why the tree takes no further mark; null when it does, or when the result has one already. */
  #full(tree: Tree, request: AttachRecordRequest): RecordSearchProblem | null {
    return getRecordMark(
      tree,
      request.personId,
      markSourceOf(request.sourceId),
      request.key,
      true,
    ) === null && countRecordMarks(tree) >= RECORD_MARK_LIMIT
      ? {
          kind: 'failed',
          message: `The tree holds ${RECORD_MARK_LIMIT.toLocaleString('en-US')} results that were kept or turned down, and takes no more. Remove some of them first.`,
          retryAt: null,
        }
      : null;
  }

  /**
   * What keeping a result for later writes into the tree: the record as this
   * service read it from the source, and when. Only a result a search showed
   * for this person can be kept, or the record a proposal of the AI
   * assistant is about; the page passes its key. Of a source whose terms bar
   * keeping what it returns, the identifier and the address are kept.
   *
   * A record kept from a proposal takes along what the AI said of it. A
   * record kept from a search takes nothing along, and a mark that had
   * something loses it: it was said of another reading.
   */
  keeping(tree: Tree, request: AttachRecordRequest): RecordMarking {
    const proposed = request.from === 'proposal';
    const found = this.#shownFor(tree, { ...request, from: proposed ? 'proposal' : 'search' });
    if (!found.ok) return found;
    const full = this.#full(tree, request);
    if (full !== null) return { ok: false, problem: full };
    if (proposed && found.aiJson === null) {
      return {
        ok: false,
        problem: {
          kind: 'record',
          message:
            'What the AI said of this record is too long to keep with it. The record can be attached as a source.',
          retryAt: null,
        },
      };
    }
    const form = keptFormOf(found.record, found.connector.manifest);
    if (form === null) {
      return {
        ok: false,
        problem: {
          kind: 'record',
          message: 'This result is too long to keep. It can be attached as a source.',
          retryAt: null,
        },
      };
    }
    return {
      ok: true,
      mark: {
        sourceId: markSourceOf(request.sourceId),
        key: request.key,
        ...form,
        aiJson: proposed ? found.aiJson : null,
        url: found.record.url,
        readAt: found.readAt,
        markedAt: this.#now(),
      },
    };
  }

  /**
   * What turning a result down for a person writes into the tree: which
   * result, with its title and address to show what was turned down. The
   * result is one a search showed, or one the tree keeps.
   */
  declining(tree: Tree, request: AttachRecordRequest): RecordMarking {
    const found = this.#shownFor(tree, request);
    if (!found.ok) return found;
    const full = this.#full(tree, request);
    if (full !== null) return { ok: false, problem: full };
    return {
      ok: true,
      mark: {
        sourceId: markSourceOf(request.sourceId),
        key: request.key,
        title:
          found.connector.manifest.mayStoreText === false ? '' : cleanText(found.record.title, 500),
        url: found.record.url,
        readAt: found.readAt,
        markedAt: this.#now(),
      },
    };
  }

  /**
   * The results the tree keeps to look at later, or those that were turned
   * down, the latest first. Each kept record is read from the tree's file and
   * checked again; one that cannot be used says why, and can only be removed.
   * How well a record fits is worked out against the person as the tree has
   * them now. Nothing is sent.
   */
  inbox(tree: Tree, request: RecordInboxRequest): RecordInboxPage {
    const living = presumedLivingIds(tree, this.#now());
    const people = new Map<string, { name: string; subject: MatchSubject; cited: Set<string> }>();
    const personOf = (personId: string) => {
      let person = people.get(personId);
      if (person === undefined) {
        const names = listNames(tree, personId);
        const name = names.find((entry) => entry.isPrimary) ?? names[0];
        person = {
          name: name === undefined ? '' : `${name.given} ${name.surname}`.trim(),
          subject: subjectOf(tree, personId),
          cited: citedUrls(tree, personId),
        };
        people.set(personId, person);
      }
      return person;
    };
    const items = listRecordMarks(tree, request).map((mark): RecordInboxItem => {
      const person = personOf(mark.personId);
      const connector = this.#connectors.find((entry) => entry.manifest.id === mark.sourceId);
      const manifest = connector?.manifest;
      const kept = mark.state === 'kept';
      const record = connector === undefined || !kept ? null : keptRecordOf(mark, connector);
      // Of a source whose terms bar keeping, the address is made from the
      // identifier, whatever the file gives as one.
      const url =
        record?.url ??
        (connector !== undefined && manifest?.mayStoreText === false
          ? (madeAddress(connector, mark.key) ?? '')
          : mark.url);
      const onSite = manifest !== undefined && isOnSite(url, manifest);
      const usable = record !== null && onSite;
      const problem =
        manifest === undefined
          ? 'The app does not know the source of this result any more.'
          : !kept
            ? ''
            : record === null
              ? 'What the tree holds of this result cannot be read.'
              : !onSite
                ? 'The address kept with this result does not lead to the site of its source.'
                : '';
      // Of a source whose terms bar keeping, there is no record to show.
      const shown = usable && manifest.mayStoreText !== false ? record : null;
      const fit = shown === null ? null : scoreRecord(person.subject, shown);
      // What an AI said of it, held against the kept record once more.
      const opinion = kept ? keptOpinionOf(mark, shown, manifest) : { ai: null, problem: '' };
      return {
        personId: mark.personId,
        personName: person.name,
        sourceId: mark.sourceId,
        sourceName: manifest?.name ?? cleanText(mark.sourceId, 100),
        key: mark.key,
        // The line of the record that is compared and cited, not one the file gives beside it.
        title: markTitle(mark, record, manifest),
        url: onSite ? url : '',
        record: shown,
        fit: fit === null ? null : { band: fit.band, reasons: fit.reasons, doubts: fit.doubts },
        attached: person.cited.has(url),
        canAttach: usable,
        mayBeLiving: living.has(mark.personId),
        readAt: whenOf(mark.readAt),
        markedAt: whenOf(mark.markedAt),
        problem,
        ai: opinion.ai,
        aiProblem: opinion.problem,
      };
    });
    return { items, total: countRecordMarks(tree, request.state, request.personId) };
  }

  /**
   * The proposals of the AI assistant as the inbox lists them: each record
   * as it read when the AI was given it, held against the person as the tree
   * has them now, with what the AI said and what the tree already has of the
   * result. Those the AI says do not fit stand last; otherwise the latest
   * stands first. Nothing is sent, and nothing is written.
   */
  proposalInbox(tree: Tree, proposals: readonly HeldProposal[]): AiProposalItem[] {
    const living = presumedLivingIds(tree, this.#now());
    const people = new Map<
      string,
      { name: string; subject: MatchSubject; cited: Set<string> } | null
    >();
    const personOf = (personId: string) => {
      let person = people.get(personId);
      if (person === undefined) {
        if (getPerson(tree, personId) === null) {
          person = null;
        } else {
          const names = listNames(tree, personId);
          const name = names.find((entry) => entry.isPrimary) ?? names[0];
          person = {
            name: name === undefined ? '' : `${name.given} ${name.surname}`.trim(),
            subject: subjectOf(tree, personId),
            cited: citedUrls(tree, personId),
          };
        }
        people.set(personId, person);
      }
      return person;
    };
    const items: AiProposalItem[] = [];
    for (const proposal of proposals) {
      const person = personOf(proposal.personId);
      const connector = this.#connectors.find((entry) => entry.manifest.id === proposal.sourceId);
      const record = proposal.external;
      // A proposal for someone who is gone, or about a record that does not
      // lead to the site of its source, could not be acted on: it is not listed.
      if (person === null || connector === undefined || !isOnSite(record.url, connector.manifest)) {
        continue;
      }
      const fit = scoreRecord(person.subject, record);
      const mark = getRecordMark(tree, proposal.personId, proposal.sourceId, proposal.key);
      // A result of the same record can be kept already, from a search or
      // from another proposal: then the tree holds another reading, or
      // other reasons, or none, and this proposal can still be kept.
      const keptAsProposed =
        mark?.state === 'kept' &&
        mark.aiJson !== null &&
        mark.aiJson === keptOpinionJson(proposal) &&
        mark.recordJson === (keptFormOf(record, connector.manifest)?.recordJson ?? null);
      items.push({
        sessionId: proposal.sessionId,
        ref: proposal.ref,
        personId: proposal.personId,
        personName: person.name,
        sourceId: proposal.sourceId,
        sourceName: connector.manifest.name,
        key: proposal.key,
        title: cleanText(record.title, 500),
        url: record.url,
        record,
        fit: fit === null ? null : { band: fit.band, reasons: fit.reasons, doubts: fit.doubts },
        ai: {
          verdict: proposal.verdict,
          confidence: proposal.confidence,
          reasons: proposal.reasons.map(({ side, text, quote, field }) => ({
            side,
            text,
            quote,
            field,
          })),
          proposedAt: proposal.at,
        },
        dropped: proposal.dropped.length,
        mark: mark?.state ?? null,
        keptAsProposed,
        attached: person.cited.has(record.url),
        mayBeLiving: living.has(proposal.personId),
        readAt: proposal.readAt,
      });
    }
    const last = (item: AiProposalItem) => (item.ai.verdict === 'does-not-fit' ? 1 : 0);
    // A sort keeps the order of what it finds equal: the latest first, as they came.
    return items.sort((a, b) => last(a) - last(b));
  }

  /**
   * A result set beside the person it was found for: what it says of their
   * birth, baptism, death or burial, and how each date and place stands to
   * every event of that type the tree has. Nothing is written or sent.
   */
  comparison(tree: Tree, request: AttachRecordRequest): CompareRecordResult {
    const found = this.#shownFor(tree, request);
    if (!found.ok) return found;
    const { connector, record } = found;
    const person = getPerson(tree, request.personId);
    if (record.kind === 'text' || person === null) {
      return {
        ok: false,
        problem: {
          kind: 'record',
          message:
            'A text was found by its words. It has no dates of a person to set beside the tree.',
          retryAt: null,
        },
      };
    }
    // What a source's terms bar the app from keeping is not taken into a tree.
    const mayKeep = connector.manifest.mayStoreText !== false;
    const said = mayKeep ? factsToTake(record) : [];
    const events = listPersonEvents(tree, request.personId);
    const facts = said.map((fact) => {
      const beside = (event: TreeEvent | null): RecordFactTarget => {
        const [dateOfTree, placeOfTree] = [event?.dateText ?? '', event?.placeText ?? ''];
        const date = relateDates(dateOfTree, fact.date);
        const place = relatePlaces(placeOfTree, fact.place);
        const citations =
          event === null ? [] : listCitations(tree, { type: 'event', id: event.id });
        const cited = citations.some((citation) => citation.url === record.url);
        return {
          eventId: event?.id ?? null,
          eventType: event?.type ?? fact.type,
          date: {
            tree: dateOfTree,
            record: fact.date,
            relation: date,
            canTake: canTakeDate(date),
          },
          place: {
            tree: placeOfTree,
            record: fact.place,
            relation: place,
            canTake: canTakePlace(place),
          },
          canCite: event !== null && !cited && canCiteFor(date, place),
          cited,
          otherCitations: citations.filter((citation) => citation.url !== record.url).length,
        };
      };
      // A baptism is set beside a christening of the tree too: it is the same rite.
      const ofType = events.filter((event) => isEventOf(fact.type, event.type));
      return {
        type: fact.type,
        targets: ofType.length === 0 ? [beside(null)] : ofType.map((event) => beside(event)),
      };
    });
    const fit = scoreRecord(subjectOf(tree, request.personId), record);
    const shown: Omit<RecordComparison, 'stamp'> = {
      sourceName: connector.manifest.name,
      title: record.title,
      url: record.url,
      fit: fit === null ? null : { band: fit.band, reasons: fit.reasons, doubts: fit.doubts },
      names: [...listNames(tree, request.personId)]
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
        .map((name) => `${name.given} ${name.surname}`.trim())
        .filter((name) => name !== ''),
      sex: { tree: person.sex, record: record.kind === 'person' ? record.sex : null },
      about: record.kind === 'person' ? record.about : '',
      event:
        record.kind === 'event'
          ? {
              role: record.role,
              event: record.event,
              date: record.date,
              place: record.place,
              held: record.held,
            }
          : null,
      facts,
      nothing: !mayKeep
        ? `The terms of ${connector.manifest.name} do not allow keeping what it returns, so nothing of this record is taken over. It can be attached as a source.`
        : facts.length > 0
          ? ''
          : "Nothing is taken from this record: it gives no date or place of the person's own birth, baptism, death or burial. It can be attached as a source.",
      attached: citedUrls(tree, request.personId).has(record.url),
    };
    // The stamp names all that was shown, and the record as it was read.
    const stamp = createHash('sha256')
      .update(JSON.stringify([shown, record]))
      .digest('hex');
    return { ok: true, comparison: { stamp, ...shown } };
  }

  /**
   * What taking facts of a result over writes into the tree. The page says
   * which dates and places, by the type of an event and the event of the
   * tree; the values are those this service read from the source. It is
   * refused when the tree is no longer as the comparison showed it, and when
   * something is asked for that the comparison does not offer.
   */
  take(tree: Tree, request: TakeRecordFactsRequest): RecordTake {
    const compared = this.comparison(tree, request);
    if (!compared.ok) return { ...compared, comparison: null };
    const { comparison } = compared;
    const fail = (kind: RecordSearchProblem['kind'], message: string): RecordTake => ({
      ok: false,
      problem: { kind, message, retryAt: null },
      comparison,
    });
    if (comparison.stamp !== request.stamp) {
      return fail(
        'changed',
        'The tree has changed since this was shown. Look at it again, then choose.',
      );
    }
    const found = this.#shownFor(tree, request);
    const attachment = this.attachment(tree, request);
    if (!found.ok || !attachment.ok) {
      return fail('record', 'This result is no longer at hand. Search again.');
    }
    const said = factsToTake(found.record);
    const types = new Set<string>();
    const events: RecordFactsPlan['events'] = [];
    for (const take of request.takes) {
      const fact = said.find((entry) => entry.type === take.type);
      const target = comparison.facts
        .find((entry) => entry.type === take.type)
        ?.targets.find((entry) => entry.eventId === take.eventId);
      if (
        fact === undefined ||
        target === undefined ||
        types.has(take.type) ||
        (take.date && !target.date.canTake) ||
        (take.place && !target.place.canTake) ||
        (!take.date && !take.place && !target.canCite)
      ) {
        return fail('choice', 'This cannot be taken over from the record as it stands.');
      }
      types.add(take.type);
      events.push({
        // The event's own type: a baptism may go to a christening of the tree.
        type: target.eventType,
        eventId: take.eventId,
        ...(take.date ? { date: fact.date } : {}),
        ...(take.place ? { place: fact.place } : {}),
      });
    }
    return {
      ok: true,
      connector: attachment.connector,
      citation: attachment.citation,
      plan: { events },
    };
  }

  /**
   * How well every result shown for a person fits them as the tree has them
   * now, by source and key. For after the tree changed under a search.
   */
  fits(tree: Tree, personId: string): Record<string, Record<string, RecordFitInfo>> {
    const all: Record<string, Record<string, RecordFitInfo>> = {};
    if (getPerson(tree, personId) === null) return all;
    const subject = subjectOf(tree, personId);
    for (const shown of this.#shown.values()) {
      if (shown.personId !== personId) continue;
      const fit = scoreRecord(subject, shown.record);
      if (fit === null) continue;
      (all[shown.sourceId] ??= {})[shown.record.key] = {
        band: fit.band,
        reasons: fit.reasons,
        doubts: fit.doubts,
      };
    }
    return all;
  }

  /** Asks a source that keeps people for a person. */
  search(tree: Tree, request: RecordSearchRequest): Promise<RecordSearchResult> {
    const { query } = request;
    if (PACK_ROUTE_PATTERN.test(request.sourceId)) return this.#searchPack(tree, request);
    return this.#search(
      tree,
      request,
      isEmptyQuery(query) ? 'Give a name to search for.' : null,
      (connector) => {
        const ask = connector.searchPersons?.bind(connector);
        return ask === undefined ? null : (page, options) => ask(query, page, options);
      },
    );
  }

  /**
   * Looks for a person in an installed pack. Nothing is sent anywhere, so the
   * notice of what a search sends does not stand in the way; the rest of the
   * gate holds: the person may not be living, and there is a tree open. A pack
   * search has its own place among the searches under way (its route id), so
   * it never gives up a search of a live source, nor the other way round.
   */
  async #searchPack(tree: Tree, request: RecordSearchRequest): Promise<RecordSearchResult> {
    const { sourceId: route, query } = request;
    const fail = (problem: RecordSearchProblem): RecordSearchResult => ({
      ok: false,
      sourceId: route,
      problem,
    });
    const id = PACK_ROUTE_PATTERN.exec(route)?.[1];
    const pack = this.#packs
      ?.ready()
      .find((entry) => entry.id === id && entry.kind === OA_PACK_KIND);
    // A pack whose download day is not a real day is not a source: nothing is cited with today's date for it.
    const downloaded = pack === undefined ? null : dayStart(pack.downloadedAt);
    if (
      this.#packs === undefined ||
      id === undefined ||
      pack === undefined ||
      downloaded === null
    ) {
      return fail({ kind: 'source', message: 'This pack is not installed.', retryAt: null });
    }
    if (this.#connectorOf(route) === undefined) {
      return fail({ kind: 'source', message: 'This source is not known.', retryAt: null });
    }
    const refusal = this.#refusal(tree, request.personId);
    if (refusal !== null) return fail(refusal);
    if (isEmptyQuery(query)) {
      return fail({ kind: 'empty', message: 'Give a name to search for.', retryAt: null });
    }

    this.#underWay.get(route)?.abort();
    const abort = new AbortController();
    this.#underWay.set(route, abort);
    const closed = this.#closed;
    try {
      const span = openArchivesSpan(query);
      const found = await this.#packs.search(
        id,
        {
          names: packNames(query),
          limit: RECORD_SEARCH_PAGE,
          offset: request.offset,
          ...(span === null ? {} : { years: span }),
        },
        abort.signal,
      );
      if (closed !== this.#closed || abort.signal.aborted) throw new Refusal(GIVEN_UP);
      // The person may have been edited while the pack was searched.
      const last = this.#refusal(tree, request.personId);
      if (last !== null) throw new Refusal(last);
      // The UTC year, as the live search of Open Archives takes it: never a year ahead of it.
      const thisYear = new Date(this.#now()).getUTCFullYear();
      let hidden = 0;
      const seen = new Set<string>();
      const items: ExternalRecord[] = [];
      for (const row of found.rows) {
        const read = oaRecordsOf(row, thisYear, query);
        hidden += read.hidden;
        for (const record of read.records) {
          if (!seen.has(record.key)) {
            seen.add(record.key);
            items.push(record);
          }
        }
      }
      // The day the pack's files were downloaded is the day these records were read.
      const after = request.offset + RECORD_SEARCH_PAGE;
      return this.#present(
        tree,
        { personId: request.personId, sourceId: route },
        {
          items,
          total: found.total,
          nextOffset: found.rows.length > 0 && after < found.total ? after : null,
          hidden,
          fetchedAt: downloaded,
          cached: false,
        },
      );
    } catch (error) {
      return fail(problemOf(error));
    } finally {
      if (this.#underWay.get(route) === abort) this.#underWay.delete(route);
    }
  }

  /** Asks a source of newspapers or books for words. */
  searchTexts(tree: Tree, request: TextSearchRequest): Promise<RecordSearchResult> {
    const { query } = request;
    return this.#search(
      tree,
      request,
      isEmptyTextQuery(query) ? 'Give words to search for.' : textQueryProblem(query),
      (connector) => {
        const ask = connector.searchTexts?.bind(connector);
        return ask === undefined ? null : (page, options) => ask(query, page, options);
      },
    );
  }

  /**
   * One search at one source, of either kind. The rules are the same for
   * both: the notice, the person who may be living, one search per source at
   * a time. `unfit` says why what is asked cannot be sent; `askOf` gives the
   * search of the source to make, or null when the source has no such search.
   */
  async #search(
    tree: Tree,
    request: { personId: string; sourceId: string; offset: number },
    unfit: string | null,
    askOf: (connector: SourceConnector) => Ask | null,
  ): Promise<RecordSearchResult> {
    const { sourceId } = request;
    const fail = (problem: RecordSearchProblem): RecordSearchResult => ({
      ok: false,
      sourceId,
      problem,
    });
    const gate = this.#gate(tree, request.personId, sourceId, unfit, askOf);
    if (!gate.ok) return fail(gate.problem);

    this.#underWay.get(sourceId)?.abort();
    const abort = new AbortController();
    this.#underWay.set(sourceId, abort);
    try {
      return await this.#answer(tree, request, gate.ask, abort.signal, () =>
        this.#refusal(tree, request.personId) === null ? null : GIVEN_UP,
      );
    } catch (error) {
      return fail(problemOf(error));
    } finally {
      if (this.#underWay.get(sourceId) === abort) this.#underWay.delete(sourceId);
    }
  }

  /**
   * One question of a search for several people: one source is asked for one
   * person, for its first results. The rules of a search hold as for any
   * other. What is sent is the name and the years the tree has for the person
   * now, and only while they are those the list before the run showed
   * (`request.query`): a person who was edited since is not asked for. Only a
   * source a run may ask is asked (`RECORD_RUN_SOURCE_IDS`).
   *
   * It stands beside the search of one person and takes no part in its
   * bookkeeping: that search gives up the one before it at the same source,
   * and all of them when its window closes; this one ends by `signal` alone.
   */
  async searchOnce(
    tree: Tree,
    request: { personId: string; sourceId: string; query: PersonQuery },
    signal: AbortSignal,
  ): Promise<RecordSearchResult> {
    const { personId, sourceId, query } = request;
    const fail = (problem: RecordSearchProblem): RecordSearchResult => ({
      ok: false,
      sourceId,
      problem,
    });
    if (!RECORD_RUN_SOURCE_IDS.includes(sourceId)) {
      return fail({
        kind: 'source',
        message: 'A search for several people does not ask this source.',
        retryAt: null,
      });
    }
    const gate = this.#gate(
      tree,
      personId,
      sourceId,
      isEmptyQuery(query) ? 'Give a name to search for.' : null,
      (connector) => {
        const ask = connector.searchPersons?.bind(connector);
        return ask === undefined ? null : (page, options) => ask(query, page, options);
      },
    );
    if (!gate.ok) return fail(gate.problem);
    /** Why nothing may be sent for the person as the tree has them now. */
    const look = (): RecordSearchProblem | null => {
      if (!this.agreed) return NOT_AGREED;
      return (
        this.#refusal(tree, personId) ??
        (sameQuery(queryOf(tree, personId), query)
          ? null
          : {
              kind: 'changed',
              message:
                'The name or the years of this person are no longer as the list showed them, so nothing was sent for them.',
              retryAt: null,
            })
      );
    };
    const changed = look();
    if (changed !== null) return fail(changed);
    if (signal.aborted) return fail(GIVEN_UP);
    try {
      return await this.#answer(tree, { personId, sourceId, offset: 0 }, gate.ask, signal, look);
    } catch (error) {
      return fail(problemOf(error));
    }
  }

  /** The sources a search for several people may ask, in the order they are offered. */
  runSources(): RecordSourceInfo[] {
    return this.sources().filter((source) => RECORD_RUN_SOURCE_IDS.includes(source.id));
  }

  /**
   * The source a session of the AI assistant may ask, by its id; undefined
   * when it may not be asked. It must keep people or records of people, and
   * its terms must let its results be passed on to an AI (`mayShareWithAi`).
   */
  #aiSource(sourceId: string): SourceConnector | undefined {
    return this.#connectors.find(
      (connector) =>
        connector.manifest.id === sourceId &&
        connector.searchPersons !== undefined &&
        mayShareWithAi(connector.manifest),
    );
  }

  /** The sources a session of the AI assistant may ask, in the order they are offered. */
  aiSources(): RecordSourceInfo[] {
    return this.sources().filter((source) => this.#aiSource(source.id) !== undefined);
  }

  /**
   * One question of a session of the AI assistant: one source is asked for
   * one person, for its first results. The rules of a search hold as for any
   * other: the notice, nobody who may be living, the source's own client.
   *
   * What is sent is `request.query`, which the session let through of what
   * the AI asked for. `stillAllowed` is the session's own last look: it is
   * called before anything is sent and again when the request's turn has
   * come, and says why the question may no longer be sent. A failure says
   * whether the request was let go to the source before it failed (`sent`),
   * so that a session counts and logs a question that was given up on its
   * way, and gives back one that never left.
   *
   * The results are records as the connector read them from the source just
   * now. Only these may be passed on to an AI: a record kept in a tree and
   * read back from its file is never given here.
   */
  async searchForAi(
    tree: Tree,
    request: { personId: string; sourceId: string; query: PersonQuery },
    signal: AbortSignal,
    stillAllowed: () => RecordSearchProblem | null,
  ): Promise<AiSearchResult> {
    const { personId, sourceId, query } = request;
    /** True once the last look has passed: the client sends right after it. */
    let sent = false;
    const fail = (problem: RecordSearchProblem): AiSearchResult => ({ ok: false, problem, sent });
    const connector = this.#aiSource(sourceId);
    if (connector === undefined) {
      return fail({
        kind: 'source',
        message: 'The results of this source are not passed on to an AI assistant.',
        retryAt: null,
      });
    }
    const gate = this.#gate(
      tree,
      personId,
      sourceId,
      isEmptyQuery(query) ? 'Give a name to search for.' : null,
      (found) => {
        const ask = found.searchPersons?.bind(found);
        return ask === undefined ? null : (page, options) => ask(query, page, options);
      },
    );
    if (!gate.ok) return fail(gate.problem);
    /** Why nothing may be sent for the person as the tree and the session stand now. */
    const look = (): RecordSearchProblem | null => {
      if (!this.agreed) return NOT_AGREED;
      return this.#refusal(tree, personId) ?? stillAllowed();
    };
    const refused = look();
    if (refused !== null) return fail(refused);
    if (signal.aborted) return fail(GIVEN_UP);
    try {
      const answer = await this.#answer(
        tree,
        { personId, sourceId, offset: 0 },
        gate.ask,
        signal,
        () => {
          const last = look();
          sent = last === null;
          return last;
        },
      );
      return {
        ok: true,
        manifest: connector.manifest,
        records: answer.items,
        total: answer.total,
        more: answer.nextOffset !== null,
        hidden: answer.hidden,
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    } catch (error) {
      return fail(problemOf(error));
    }
  }

  /**
   * Whether a source may be asked for a person at all: the source and its
   * search, or why not. `unfit` says why what is asked cannot be sent.
   */
  #gate(
    tree: Tree,
    personId: string,
    sourceId: string,
    unfit: string | null,
    askOf: (connector: SourceConnector) => Ask | null,
  ): { ok: true; ask: Ask } | { ok: false; problem: RecordSearchProblem } {
    const fail = (problem: RecordSearchProblem) => ({ ok: false as const, problem });
    const connector = this.#connectors.find(({ manifest }) => manifest.id === sourceId);
    const ask = connector === undefined ? null : askOf(connector);
    if (connector === undefined || ask === null) {
      return fail({ kind: 'source', message: 'This source is not known.', retryAt: null });
    }
    if (!this.agreed) return fail(NOT_AGREED);
    // Looked at again at each search: the person may have been edited since the form opened.
    const refusal = this.#refusal(tree, personId);
    if (refusal !== null) return fail(refusal);
    if (unfit !== null) return fail({ kind: 'empty', message: unfit, retryAt: null });
    const key = this.#keyState(connector.manifest);
    if (key !== 'none' && key !== 'saved') {
      return fail({
        kind: 'key',
        message:
          key === 'unreadable'
            ? `The key saved for ${connector.manifest.name} cannot be read on this Windows account. Enter it again.`
            : `${connector.manifest.name} needs your own key.`,
        retryAt: null,
      });
    }
    return { ok: true, ask };
  }

  /**
   * Asks a source, and makes of its answer what the page is given: the
   * results, each held against the person, with what the tree already has of
   * them. `lastLook` is called when the request's turn has come, and says why
   * it may no longer be sent. Throws what the client and the connector throw.
   */
  async #answer(
    tree: Tree,
    request: { personId: string; sourceId: string; offset: number },
    ask: Ask,
    signal: AbortSignal,
    lastLook: () => RecordSearchProblem | null,
  ): Promise<Extract<RecordSearchResult, { ok: true }>> {
    const closed = this.#closed;
    /** What the last look found. Kept here, since the client reports whatever that look throws as a request given up. */
    const last: { refused: RecordSearchProblem | null } = { refused: null };
    const answer = await ask(
      { offset: request.offset, limit: RECORD_SEARCH_PAGE },
      {
        signal,
        // And once more when the request's turn has come: it can have waited
        // for that, and the tree can have been edited or closed meanwhile.
        beforeSend: () => {
          last.refused = signal.aborted || closed !== this.#closed ? GIVEN_UP : lastLook();
          if (last.refused !== null) throw new Refusal(last.refused);
        },
      },
    ).catch((error: unknown) => {
      throw last.refused === null ? error : new Refusal(last.refused);
    });
    // The tree closed while the answer was on its way, or the search was
    // given up: the answer is for nobody now.
    if (closed !== this.#closed || signal.aborted) throw new Refusal(GIVEN_UP);
    return this.#present(tree, request, {
      items: answer.page.items,
      total: answer.page.total,
      nextOffset: answer.page.next?.offset ?? null,
      hidden: answer.page.hidden,
      fetchedAt: answer.fetchedAt,
      cached: answer.cached,
    });
  }

  /**
   * What the page is given for an answer: the results remembered for
   * attaching, each held against the person, with what the tree already has
   * of them. `request.sourceId` is the route the page asked, which for a pack
   * is not the source its results are marked under.
   */
  #present(
    tree: Tree,
    request: { personId: string; sourceId: string },
    page: {
      items: ExternalRecord[];
      total: number | null;
      nextOffset: number | null;
      hidden: number;
      fetchedAt: number;
      cached: boolean;
    },
  ): Extract<RecordSearchResult, { ok: true }> {
    const { sourceId } = request;
    // Remembered for attaching, with the person they were found for.
    for (const record of page.items) {
      const key = shownKey(request.personId, sourceId, record.key);
      this.#shown.delete(key);
      this.#shown.set(key, {
        personId: request.personId,
        sourceId,
        record,
        readAt: page.fetchedAt,
      });
    }
    for (const key of this.#shown.keys()) {
      if (this.#shown.size <= SHOWN_LIMIT) break;
      this.#shown.delete(key);
    }
    const cited = citedUrls(tree, request.personId);
    // Each result is held against the person of the tree, as the tree has
    // them now, whatever was typed into the form. Nothing is sent for it.
    const subject = subjectOf(tree, request.personId);
    const fits: Record<string, RecordFitInfo> = {};
    for (const record of page.items) {
      const fit = scoreRecord(subject, record);
      if (fit !== null) {
        fits[record.key] = { band: fit.band, reasons: fit.reasons, doubts: fit.doubts };
      }
    }
    // What the user kept for this person, and what they turned down for them.
    const states = recordMarkStatesFor(
      tree,
      request.personId,
      markSourceOf(sourceId),
      page.items.map((record) => record.key),
    );
    const marked = (state: 'kept' | 'declined') =>
      page.items.filter((record) => states.get(record.key) === state).map((record) => record.key);
    return {
      ok: true,
      sourceId,
      fits,
      marks: { kept: marked('kept'), declined: marked('declined') },
      attached: page.items.filter((record) => cited.has(record.url)).map((record) => record.key),
      // What fits the person best stands first, whatever the order of the source.
      items: byFit(page.items, fits),
      total: page.total,
      nextOffset: page.nextOffset,
      hidden: page.hidden,
      fetchedAt: page.fetchedAt,
      cached: page.cached,
    };
  }

  /** Why nothing may be sent for a person; null when a search may be made. */
  #refusal(tree: Tree, personId: string): RecordSearchProblem | null {
    if (getPerson(tree, personId) === null) {
      return { kind: 'gone', message: 'This person is no longer in the tree.', retryAt: null };
    }
    if (presumedLivingIds(tree, this.#now()).has(personId)) {
      return {
        kind: 'living',
        message: 'This person may be living. Nothing about living people is sent.',
        retryAt: null,
      };
    }
    return null;
  }

  /** Gives up every search that is under way. For when the search window closes. */
  cancel(): void {
    for (const abort of this.#underWay.values()) abort.abort();
    this.#underWay.clear();
  }

  /** Gives up every search that is under way and forgets what was found. For when a tree closes. */
  reset(): void {
    this.cancel();
    this.#closed += 1;
    this.#http.clearCache();
    this.#shown.clear();
  }
}

function shownKey(personId: string, sourceId: string, key: string): string {
  return `${personId}\n${sourceId}\n${key}`;
}

const BAND_ORDER: Record<RecordFitInfo['band'], number> = {
  strong: 0,
  possible: 1,
  weak: 2,
  unlikely: 3,
};

/**
 * The results of one answer, those that fit the person best first. Within one
 * label they stay in the order the source gave them. A result the app could
 * not hold against the person stands with those that have little to go by, so
 * an answer without any label keeps the order of its source.
 */
function byFit(items: ExternalRecord[], fits: Record<string, RecordFitInfo>): ExternalRecord[] {
  const rank = (record: ExternalRecord) => BAND_ORDER[fits[record.key]?.band ?? 'weak'];
  // The sort keeps the order of what ranks the same.
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function sameQuery(a: PersonQuery, b: PersonQuery): boolean {
  return (
    a.given === b.given &&
    a.surname === b.surname &&
    a.birthYear === b.birthYear &&
    a.deathYear === b.deathYear
  );
}

/**
 * What a record says of the person's own events, as it would be written
 * into the tree: a place no longer than the tree keeps. What is set beside
 * the tree and what is written are then the same words.
 */
function factsToTake(record: ExternalRecord): RecordFact[] {
  return recordFacts(record).map((fact) => ({
    ...fact,
    place: fact.place.slice(0, PLACE_TEXT_MAX).trim(),
  }));
}

/** A date of a record in the words the app uses for dates. */
function dateWords(date: string): string {
  const parsed = date === '' ? null : parseDate(date);
  return (parsed === null ? null : describeDate(parsed)) ?? date;
}

/**
 * What a record of an event says, as the citation keeps it: the person's
 * role in it, the event with its date and place, and where the record is held.
 */
function eventText(record: Extract<ExternalRecord, { kind: 'event' }>): string {
  const event = [record.event, dateWords(record.date), record.place]
    .filter((part) => part !== '')
    .join(', ');
  return [record.role === '' ? '' : `Role: ${record.role}`, event, record.held]
    .filter((line) => line !== '')
    .join('\n');
}

/** What a result says of a text, as the citation keeps it: who made it, and when it was printed. */
function printText(record: Extract<ExternalRecord, { kind: 'text' }>): string {
  const parsed = record.date === '' ? null : parseDate(record.date);
  const date = (parsed === null ? null : describeDate(parsed)) ?? record.date;
  return [
    record.about,
    record.by === '' ? '' : `By ${record.by}`,
    date === '' ? '' : `Published ${date}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What the search of newspapers and books starts with for a person: their
 * name as a phrase, printed between the year of their birth and the year
 * after their death, which is when a death is still written about.
 */
function textQueryOf(person: PersonQuery): TextQuery {
  return {
    words: [person.given, person.surname]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join(' '),
    phrase: true,
    fromYear: person.birthYear,
    toYear: person.deathYear === null ? null : Math.min(person.deathYear + 1, 9999),
    state: '',
  };
}

/** What a result says of a person, as the citation keeps it: one line for the birth, one for the death. */
function factsText(record: Extract<ExternalRecord, { kind: 'person' }>): string {
  return record.facts
    .map((fact) => {
      const parsed = fact.date === '' ? null : parseDate(fact.date);
      const date = (parsed === null ? null : describeDate(parsed)) ?? fact.date;
      const said = [date, fact.place].filter((part) => part !== '').join(', ');
      return said === '' ? '' : `${fact.type === 'birth' ? 'Born' : 'Died'} ${said}`;
    })
    .filter((line) => line !== '')
    .concat(record.about === '' ? [] : [record.about])
    .join('\n');
}

/**
 * Midday of a calendar day (`YYYY-MM-DD`) on this PC's clock, so that
 * {@link localDay} gives the same day back; null when it is not a real day.
 */
export function dayStart(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(year, month - 1, date, 12);
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === date
    ? at.getTime()
    : null;
}

/** The day of a moment on this PC's clock, as `YYYY-MM-DD`. */
export function localDay(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * What of a person of the tree a result is held against: every name, the sex,
 * the years the birth and the death can lie in, and every place the tree
 * names for them.
 */
function subjectOf(tree: Tree, personId: string): MatchSubject {
  const person = getPerson(tree, personId);
  const events = listPersonEvents(tree, personId);
  const yearOf = (jdn: number) => jdnToCalendar('gregorian', jdn).year;
  const of = (type: string) => events.find((event) => event.type === type);
  const span = (type: string) => {
    const event = of(type);
    // A date that is open to one side ("before 1850") gives no span of years.
    return event === undefined || event.dateMinJdn === null || event.dateMaxJdn === null
      ? null
      : { min: yearOf(event.dateMinJdn), max: yearOf(event.dateMaxJdn) };
  };
  const names = listNames(tree, personId);
  return {
    sex: person?.sex ?? 'U',
    names: [...names]
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((name) => ({ given: name.given, surname: name.surname })),
    birth: span('birth'),
    death: span('death'),
    birthPlace: of('birth')?.placeText ?? '',
    deathPlace: of('death')?.placeText ?? '',
    places: [...new Set(events.map((event) => event.placeText).filter((place) => place !== ''))],
  };
}

/** The name and years of a person of the tree, as a search starts with them. */
export function queryOf(tree: Tree, personId: string): PersonQuery {
  const names = listNames(tree, personId);
  const name = names.find((entry) => entry.isPrimary) ?? names[0];
  const events = listPersonEvents(tree, personId);
  const yearOf = (type: string): number | null => {
    const event = events.find((entry) => entry.type === type);
    return event === undefined
      ? null
      : queryYear({ minJdn: event.dateMinJdn, maxJdn: event.dateMaxJdn });
  };
  return {
    given: name?.given ?? '',
    surname: name?.surname ?? '',
    birthYear: yearOf('birth'),
    deathYear: yearOf('death'),
  };
}

/** A failure in words for the user. Nothing of the error itself is passed on unless it is the app's own. */
function problemOf(error: unknown): RecordSearchProblem {
  if (error instanceof Refusal) return error.problem;
  // A search of a pack that was given up, or stopped because the pack is being replaced or deleted.
  if (error instanceof PackSearchStopped) return GIVEN_UP;
  if (error instanceof Error && error.name === 'PackError') {
    return { kind: 'source', message: error.message, retryAt: null };
  }
  if (error instanceof HttpError) {
    const kind =
      error.kind === 'paused' ||
      error.kind === 'cancelled' ||
      error.kind === 'timeout' ||
      error.kind === 'key'
        ? error.kind
        : error.kind === 'quota'
          ? 'paused'
          : error.kind === 'network'
            ? 'offline'
            : 'failed';
    return { kind, message: error.message, retryAt: error.retryAt };
  }
  if (error instanceof ConnectorError) {
    return {
      kind: error.kind === 'key' ? 'key' : 'failed',
      message: error.message,
      retryAt: null,
    };
  }
  return { kind: 'failed', message: 'The search failed.', retryAt: null };
}
