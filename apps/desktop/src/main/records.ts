import { createHash } from 'node:crypto';
import {
  ConnectorError,
  HttpClient,
  HttpError,
  citationSourceOf,
  cleanText,
  deepLinkSources,
  internetArchiveConnector,
  internetArchiveManifest,
  locConnector,
  locManifest,
  naraCatalogConnector,
  naraCatalogManifest,
  openArchivesConnector,
  openArchivesManifest,
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
  citedUrls,
  getPerson,
  getSetting,
  listCitations,
  listNames,
  listPersonEvents,
  presumedLivingIds,
  setSetting,
  type CitationInput,
  type ConnectorSource,
  type Db,
  type RecordFactsPlan,
  type Tree,
  type TreeEvent,
} from '@rulz/db';
import type {
  AttachRecordRequest,
  CompareRecordResult,
  RecordComparison,
  RecordFactTarget,
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
 * Results are kept in memory by that client for a while and are never written
 * to disk. Nothing here uses Electron; the function that fetches is handed in.
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
 */
export const RECORD_SEARCH_NOTICE_VERSION = 4;

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

/** How many results are remembered for attaching. The oldest go first. */
const SHOWN_LIMIT = 2000;

/** What is needed to cite a result; see `RecordSearchService.attachment`. */
export type RecordAttachment =
  | { ok: true; connector: ConnectorSource; citation: CitationInput & { url: string } }
  | { ok: false; problem: RecordSearchProblem };

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
  /** The results shown since the tree was opened, each with the person it was found for. */
  readonly #shown = new Map<string, { personId: string; record: ExternalRecord }>();
  /** Counts the trees that closed, so that an answer for an earlier tree is not kept. */
  #closed = 0;
  readonly #secrets: SecretStore | undefined;

  constructor(options: RecordSearchOptions) {
    this.#appDb = options.appDb;
    this.#now = options.now ?? Date.now;
    this.#secrets = options.secrets;
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

  sources(): RecordSourceInfo[] {
    return this.#connectors.map((connector) => ({
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
      links: this.links(),
    };
  }

  /** The sites a search can be opened at in the user's browser. */
  links(): RecordLinkInfo[] {
    return this.#links.map(({ manifest }) => ({
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
    const url = source.buildSearchUrl(request.query);
    if (url === null) {
      return fail({ kind: 'empty', message: 'Give a name to search for.', retryAt: null });
    }
    return { ok: true, url };
  }

  /**
   * What citing a result of a search writes into the tree. The result must be
   * one this service showed for this person since the tree was opened: the
   * page passes its key, never its contents.
   */
  attachment(tree: Tree, request: AttachRecordRequest): RecordAttachment {
    const found = this.#shownFor(tree, request);
    if (!found.ok) return found;
    const { connector, record } = found;
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
          accessedAt: localDay(this.#now()),
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
        accessedAt: localDay(this.#now()),
      },
    };
  }

  /**
   * The result a request names, with its source. It must be one this service
   * showed for this person since the tree was opened, and lead to the site of
   * its source.
   */
  #shownFor(
    tree: Tree,
    request: AttachRecordRequest,
  ):
    | { ok: true; connector: SourceConnector; record: ExternalRecord }
    | { ok: false; problem: RecordSearchProblem } {
    const fail = (kind: RecordSearchProblem['kind'], message: string) => ({
      ok: false as const,
      problem: { kind, message, retryAt: null },
    });
    if (getPerson(tree, request.personId) === null) {
      return fail('gone', 'This person is no longer in the tree.');
    }
    const connector = this.#connectors.find(({ manifest }) => manifest.id === request.sourceId);
    const shown = this.#shown.get(shownKey(request.sourceId, request.key));
    if (connector === undefined || shown === undefined || shown.personId !== request.personId) {
      return fail('record', 'This result is no longer at hand. Search again, then attach it.');
    }
    if (!isOnSite(shown.record.url, connector.manifest)) {
      return fail(
        'record',
        'This result does not lead to the site of its source, so it is not attached.',
      );
    }
    return { ok: true, connector, record: shown.record };
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
    for (const [key, shown] of this.#shown) {
      if (shown.personId !== personId) continue;
      const fit = scoreRecord(subject, shown.record);
      if (fit === null) continue;
      const sourceId = key.slice(0, key.indexOf('\n'));
      (all[sourceId] ??= {})[shown.record.key] = {
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
    const connector = this.#connectors.find(({ manifest }) => manifest.id === sourceId);
    const ask = connector === undefined ? null : askOf(connector);
    if (connector === undefined || ask === null) {
      return fail({ kind: 'source', message: 'This source is not known.', retryAt: null });
    }
    if (!this.agreed) {
      return fail({
        kind: 'notice',
        message: 'Nothing is sent before you have agreed to what a search sends.',
        retryAt: null,
      });
    }
    // Looked at again at each search: the person may have been edited since the form opened.
    const refusal = this.#refusal(tree, request.personId);
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

    this.#underWay.get(sourceId)?.abort();
    const abort = new AbortController();
    this.#underWay.set(sourceId, abort);
    const closed = this.#closed;
    try {
      const answer = await ask(
        { offset: request.offset, limit: RECORD_SEARCH_PAGE },
        {
          signal: abort.signal,
          // And once more when the request's turn has come: it can have waited
          // for that, and the tree can have been edited or closed meanwhile.
          beforeSend: () => {
            if (abort.signal.aborted || this.#refusal(tree, request.personId) !== null) {
              throw new HttpError('cancelled', 'The search was given up.');
            }
          },
        },
      );
      // The tree closed while the answer was on its way: it is for nobody now.
      if (closed !== this.#closed) throw new HttpError('cancelled', 'The search was given up.');
      // Remembered for attaching, with the person they were found for.
      for (const record of answer.page.items) {
        const key = shownKey(sourceId, record.key);
        this.#shown.delete(key);
        this.#shown.set(key, { personId: request.personId, record });
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
      for (const record of answer.page.items) {
        const fit = scoreRecord(subject, record);
        if (fit !== null) {
          fits[record.key] = { band: fit.band, reasons: fit.reasons, doubts: fit.doubts };
        }
      }
      return {
        ok: true,
        sourceId,
        fits,
        attached: answer.page.items
          .filter((record) => cited.has(record.url))
          .map((record) => record.key),
        items: answer.page.items,
        total: answer.page.total,
        nextOffset: answer.page.next?.offset ?? null,
        hidden: answer.page.hidden,
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    } catch (error) {
      return fail(problemOf(error));
    } finally {
      if (this.#underWay.get(sourceId) === abort) this.#underWay.delete(sourceId);
    }
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

function shownKey(sourceId: string, key: string): string {
  return `${sourceId}\n${key}`;
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

/** True when an address is HTTPS and on the site of a source, where its records' pages are. */
function isOnSite(address: string, manifest: ConnectorManifest): boolean {
  try {
    const url = new URL(address);
    const site = new URL(manifest.siteUrl ?? manifest.baseUrl);
    return url.protocol === 'https:' && url.origin === site.origin;
  } catch {
    return false;
  }
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
function queryOf(tree: Tree, personId: string): PersonQuery {
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
