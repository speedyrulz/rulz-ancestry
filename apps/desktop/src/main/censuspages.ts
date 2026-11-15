import {
  CENSUS_HOST,
  CENSUS_MAX_PAGES,
  NARA_CENSUS_PACK_KIND,
  censusCitationPage,
  censusDistrictUrl,
  censusImageUrl,
  cleanText,
  isCensusFile,
  isCensusPath,
  nara1950CensusManifest,
  citationSourceOf,
} from '@rulz/connectors';
import { CITATION_LIMITS } from '@rulz/core';
import {
  PACK_ID_PATTERN,
  PackSearchStopped,
  getPerson,
  type CitationInput,
  type ConnectorSource,
  type Tree,
} from '@rulz/db';
import type {
  CensusCiteRequest,
  CensusCountiesResult,
  CensusDistrictInfo,
  CensusDistrictRef,
  CensusDistrictResult,
  CensusDistrictsRequest,
  CensusDistrictsResult,
  CensusPageImageResult,
  CensusPageRequest,
  PackActionResult,
  PackInfo,
  RecordSearchProblem,
} from '../shared/ipc';
import type { PackFetch } from './packs';
import type { DistinctQuery, GetQuery, ListQuery } from './packsearch.worker';
import { localDay, userAgentOf } from './records';

/**
 * Browsing an installed pack of the 1950 census, viewing one page of a
 * district, citing it, and opening the district at the National Archives.
 *
 * Browsing asks the pack on this PC only (through the search worker, by
 * bounded requests), and asks nothing of the internet. A page image is the
 * one request this makes: it is fetched from the census bucket when the user
 * asks for it, for the window only, and never written to disk. What is
 * fetched is decided here, from the pack's own record of the district, never
 * from anything the window sends but the pack, the district's row and the
 * page's number. The user must have agreed to the notice of what the app
 * asks of the internet.
 *
 * Only the page last shown can be cited, and only for a person of the tree.
 * Citing writes into the tree and sends nothing, and nothing about a person is
 * part of any request.
 */

const MB = 1024 * 1024;
const REPLACED = 'This pack was replaced or removed; choose the district again.';
/** A page image is about 5 MB; one this large is not a page. */
export const CENSUS_IMAGE_CAP = 20 * MB;
const IMAGE_TIMEOUT_MS = 60_000;
/** At least this long lies between two requests for a page image. */
const MIN_GAP_MS = 1000;
/** How many districts a list gives at a time. */
export const CENSUS_DISTRICT_PAGE = 50;
const START_LENGTH = 200;
const COUNTY_PAGE = 1000;
const MAX_COUNTY_PAGES = 5;

/** What the browsing needs of the packs. `PackManager` is one. */
export interface CensusPacks {
  ready(): PackInfo[];
  distinct(
    id: string,
    q: DistinctQuery,
    signal: AbortSignal,
  ): Promise<{ value: string; count: number }[]>;
  list(
    id: string,
    q: ListQuery,
    signal: AbortSignal,
  ): Promise<{ rows: { rowid: number; values: Record<string, string> }[]; total: number }>;
  get(
    id: string,
    q: GetQuery,
    signal: AbortSignal,
  ): Promise<{ rowid: number; values: Record<string, string> } | null>;
  whenLeaving(listener: (id: string) => void): void;
  /** Changes whenever a pack's file is replaced or deleted (and while that is under way). */
  generationOf(id: string): number;
}

export interface CensusServiceOptions {
  packs: CensusPacks;
  fetch: PackFetch;
  appVersion: string;
  /** True once the user has agreed to the current wording of the notice. */
  agreed: () => boolean;
  /** Opens an address in the user's browser. */
  openInBrowser: (url: string) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  /** The least time between two requests for a page image, in milliseconds. */
  minGapMs?: number;
  /** Waits; replaceable in tests. Rejects when the signal is given up. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Something the window is told, in words. */
class Problem extends Error {
  readonly problem: RecordSearchProblem;

  constructor(kind: RecordSearchProblem['kind'], message: string) {
    super(message);
    this.name = 'CensusProblem';
    this.problem = { kind, message, retryAt: null };
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Problem
    ? error.message
    : error instanceof PackSearchStopped
      ? 'The pack was changed meanwhile; try again.'
      : error instanceof Error && error.name === 'PackError'
        ? error.message
        : 'The pack could not be read.';

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('given up'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('given up'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A district as the pack keeps it, checked again as it is read. */
interface District {
  rowid: number;
  state: string;
  abbreviation: string;
  county: string;
  ed: string;
  description: string;
  reservation: string;
  roll: string;
  folder: string;
  pages: number;
}

const DISTRICT_COLUMNS = [
  'state',
  'abbreviation',
  'county',
  'ed',
  'description',
  'reservation',
  'roll',
  'folder',
  'pages',
] as const;

export class CensusService {
  readonly #packs: CensusPacks;
  readonly #fetch: PackFetch;
  readonly #userAgent: string;
  readonly #agreed: () => boolean;
  readonly #open: (url: string) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #gapMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The image that is being asked for, and the pack it belongs to. */
  #image: { abort: AbortController; packId: string } | null = null;
  /** When the last request for an image began. */
  #lastStart = Number.NEGATIVE_INFINITY;
  /** The page last shown to the window: the only one that can be cited. */
  #last: { packId: string; id: number; page: number; generation: number } | null = null;

  constructor(options: CensusServiceOptions) {
    this.#packs = options.packs;
    this.#fetch = options.fetch;
    this.#userAgent = userAgentOf(options.appVersion);
    this.#agreed = options.agreed;
    this.#open = options.openInBrowser;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS;
    this.#gapMs = options.minGapMs ?? MIN_GAP_MS;
    this.#sleep = options.sleep ?? sleepFor;
    // A pack that is being replaced, held or removed: nothing of it is read from outside.
    this.#packs.whenLeaving((id) => {
      if (this.#image?.packId === id) this.cancelImage();
      if (this.#last?.packId === id) this.#last = null;
    });
  }

  /** The page last shown to the window, the only one that can be cited; null when there is none. */
  get shown(): { packId: string; id: number; page: number } | null {
    return this.#last === null
      ? null
      : { packId: this.#last.packId, id: this.#last.id, page: this.#last.page };
  }

  /** Gives up the image that is being asked for. For when the window closes. */
  cancelImage(): void {
    this.#image?.abort.abort();
    this.#image = null;
  }

  /** Gives up the image and forgets the page last shown. For when a tree closes. */
  reset(): void {
    this.cancelImage();
    this.#last = null;
  }

  // ---- reading the pack ------------------------------------------------------

  /** Throws unless the pack is an installed pack of the census that can be read. */
  #census(packId: unknown): string {
    if (typeof packId !== 'string' || !PACK_ID_PATTERN.test(packId)) {
      throw new Problem('source', 'This is not the id of a pack.');
    }
    const pack = this.#packs.ready().find((entry) => entry.id === packId);
    if (pack === undefined || pack.kind !== NARA_CENSUS_PACK_KIND) {
      throw new Problem('source', 'This is not an installed pack of the 1950 census.');
    }
    return packId;
  }

  async #district(packId: string, rowid: number): Promise<District> {
    if (!Number.isSafeInteger(rowid) || rowid < 1) {
      throw new Problem('source', 'This district is not in the pack.');
    }
    const found = await this.#packs.get(
      packId,
      { rowid, columns: DISTRICT_COLUMNS },
      new AbortController().signal,
    );
    if (found === null) throw new Problem('source', 'This district is not in the pack.');
    const v = found.values;
    const pages = /^\d{1,4}$/.test(v['pages'] ?? '') ? Number(v['pages']) : 0;
    return {
      rowid,
      state: v['state'] ?? '',
      abbreviation: v['abbreviation'] ?? '',
      county: v['county'] ?? '',
      ed: v['ed'] ?? '',
      description: v['description'] ?? '',
      reservation: v['reservation'] ?? '',
      roll: v['roll'] ?? '',
      folder: v['folder'] ?? '',
      pages,
    };
  }

  /** The page files of a district, read from the pack and checked again. */
  async #files(packId: string, rowid: number, folder: string): Promise<string[]> {
    const found = await this.#packs.get(
      packId,
      { rowid, columns: ['files'] },
      new AbortController().signal,
    );
    let files: unknown;
    try {
      files = JSON.parse(found?.values['files'] ?? '');
    } catch {
      files = null;
    }
    if (
      !isCensusPath(folder) ||
      !Array.isArray(files) ||
      files.length < 1 ||
      files.length > CENSUS_MAX_PAGES ||
      !files.every(isCensusFile)
    ) {
      throw new Problem('source', "This district's pages are not listed in a form the app reads.");
    }
    return files as string[];
  }

  // ---- browsing --------------------------------------------------------------

  async counties(packId: string): Promise<CensusCountiesResult> {
    try {
      const id = this.#census(packId);
      const counties: { name: string; districts: number }[] = [];
      for (let page = 0; page < MAX_COUNTY_PAGES; page += 1) {
        const values = await this.#packs.distinct(
          id,
          { column: 'county', limit: COUNTY_PAGE, offset: page * COUNTY_PAGE },
          new AbortController().signal,
        );
        for (const { value, count } of values) counties.push({ name: value, districts: count });
        if (values.length < COUNTY_PAGE) break;
      }
      return { ok: true, counties };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async districts(request: CensusDistrictsRequest): Promise<CensusDistrictsResult> {
    try {
      const id = this.#census(request.packId);
      const generation = this.#packs.generationOf(id);
      const found = await this.#packs.list(
        id,
        {
          columns: ['ed', 'description', 'pages'],
          where: { county: request.county },
          ...(request.filter.trim() === ''
            ? {}
            : { contains: { column: 'description', words: request.filter } }),
          limit: CENSUS_DISTRICT_PAGE,
          offset: request.offset,
        },
        new AbortController().signal,
      );
      // The rows are of the file they were asked of, or they are not given.
      if (this.#packs.generationOf(id) !== generation) throw new Problem('changed', REPLACED);
      return {
        ok: true,
        total: found.total,
        districts: found.rows.map((row) => ({
          id: row.rowid,
          generation,
          ed: row.values['ed'] ?? '',
          descriptionStart: cleanText(row.values['description'], START_LENGTH),
          pages: /^\d{1,4}$/.test(row.values['pages'] ?? '') ? Number(row.values['pages']) : 0,
        })),
      };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  async district(ref: CensusDistrictRef): Promise<CensusDistrictResult> {
    try {
      const id = this.#census(ref.packId);
      this.#sameFile(id, ref.generation);
      const found = await this.#district(id, ref.id);
      this.#sameFile(id, ref.generation);
      const district: CensusDistrictInfo = {
        packId: id,
        id: ref.id,
        generation: ref.generation,
        state: found.state,
        county: found.county,
        ed: found.ed,
        description: cleanText(found.description, 20_000),
        reservation: found.reservation,
        roll: found.roll,
        pages: found.pages,
      };
      return { ok: true, district };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  /** Opens the district at the National Archives' site in the user's browser. Sends nothing from the app. */
  async openDistrict(ref: CensusDistrictRef): Promise<PackActionResult> {
    try {
      const id = this.#census(ref.packId);
      this.#sameFile(id, ref.generation);
      const found = await this.#district(id, ref.id);
      this.#sameFile(id, ref.generation);
      const url = censusDistrictUrl(found);
      if (url === null)
        throw new Problem('source', 'This district has no address at the Archives.');
      await this.#open(url);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  // ---- one page --------------------------------------------------------------

  /**
   * Fetches one page image of a district, for the window only. The address is
   * the bucket's own, made from the folder and file the pack holds for the
   * district; the request follows no redirect, sends no cookie, and is read
   * no further than {@link CENSUS_IMAGE_CAP}. A request gives the one before
   * it up, and leaves at least a second since the last one began.
   */
  async pageImage(request: CensusPageRequest): Promise<CensusPageImageResult> {
    const fail = (kind: RecordSearchProblem['kind'], message: string): CensusPageImageResult => ({
      ok: false,
      problem: { kind, message, retryAt: null },
    });
    // A new request ends the one before it.
    this.cancelImage();
    if (!this.#agreed()) {
      return fail(
        'notice',
        'Nothing is asked of the internet before you have agreed to the notice.',
      );
    }
    const mine = {
      abort: new AbortController(),
      packId: typeof request.packId === 'string' ? request.packId : '',
    };
    this.#image = mine;
    try {
      const packId = this.#census(request.packId);
      // The row is of the file the window was shown, and both reads are of that one file.
      const generation = request.generation;
      this.#sameFile(packId, generation);
      const found = await this.#district(packId, request.id);
      const files = await this.#files(packId, request.id, found.folder);
      mine.abort.signal.throwIfAborted();
      this.#sameFile(packId, generation);
      if (!Number.isInteger(request.page) || request.page < 1 || request.page > files.length) {
        throw new Problem('source', 'This district has no such page.');
      }
      const url = censusImageUrl(found.folder, files[request.page - 1]);
      if (url === null) throw new Problem('source', 'This page has no address the app asks.');
      const signal = AbortSignal.any([mine.abort.signal, AbortSignal.timeout(this.#timeoutMs)]);

      // At least a second since the last request began.
      const wait = this.#lastStart + this.#gapMs - this.#now();
      if (wait > 0) await this.#sleep(wait, mine.abort.signal);
      mine.abort.signal.throwIfAborted();
      this.#sameFile(packId, generation);
      this.#lastStart = this.#now();

      const bytes = await this.#fetchImage(url, signal);
      if (mine.abort.signal.aborted || this.#image !== mine) {
        throw new Problem('cancelled', 'The page was given up.');
      }
      this.#sameFile(packId, generation);
      this.#image = null;
      this.#last = { packId, id: request.id, page: request.page, generation };
      return { ok: true, bytes, page: request.page, pages: files.length };
    } catch (error) {
      if (this.#image === mine) this.#image = null;
      if (error instanceof Problem) return { ok: false, problem: error.problem };
      if (mine.abort.signal.aborted) return fail('cancelled', 'The page was given up.');
      return fail('failed', messageOf(error));
    }
  }

  /** Throws unless the pack's file is the one that was read at `generation`. */
  #sameFile(packId: string, generation: number): void {
    if (this.#packs.generationOf(packId) !== generation) throw new Problem('changed', REPLACED);
  }

  /** One request for one image, and its bytes, which must be a JPEG no larger than the cap. */
  async #fetchImage(url: string, signal: AbortSignal): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        method: 'GET',
        headers: { 'user-agent': this.#userAgent },
      });
    } catch (error) {
      if (signal.aborted) {
        const timedOut = (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
        throw new Problem(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'The page could not be fetched in time.' : 'The page was given up.',
        );
      }
      throw new Problem(
        'offline',
        `${CENSUS_HOST} could not be reached (${error instanceof Error ? error.message : String(error)}); check the internet connection and try again.`,
      );
    }
    const cancel = () => void response.body?.cancel().catch(() => undefined);
    if (response.url !== '' && new URL(response.url).hostname !== CENSUS_HOST) {
      cancel();
      throw new Problem('failed', `${CENSUS_HOST} answered from somewhere else.`);
    }
    if (!response.ok) {
      cancel();
      throw new Problem('failed', `${CENSUS_HOST} answered ${response.status} for this page.`);
    }
    const length = response.headers.get('content-length')?.trim() ?? '';
    if (/^\d{1,15}$/.test(length) && Number(length) > CENSUS_IMAGE_CAP) {
      cancel();
      throw new Problem('failed', 'The page image is larger than it should be.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Problem('failed', 'The page image came empty.');
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > CENSUS_IMAGE_CAP) {
          throw new Problem('failed', 'The page image is larger than it should be.');
        }
        chunks.push(value);
        if (chunks.length === 1 && value.length >= 3 && !isJpeg(value)) {
          throw new Problem('failed', 'The answer is not a JPEG image.');
        }
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (error instanceof Problem) throw error;
      if (signal.aborted) throw new Problem('cancelled', 'The page was given up.');
      throw new Problem(
        'offline',
        `The page image could not be read (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    if (!isJpeg(bytes)) throw new Problem('failed', 'The answer is not a JPEG image.');
    return bytes;
  }

  // ---- citing ----------------------------------------------------------------

  /**
   * What citing the page last shown writes into the tree: the source of the
   * 1950 census, and a citation whose page names the state, county, district,
   * image and roll, whose text is the district's description, and whose address
   * is the page image's own. Only the page last shown can be cited, and only
   * for a person of the tree (a living one too: nothing about them is sent).
   */
  async citation(
    tree: Tree,
    request: CensusCiteRequest,
  ): Promise<
    | { ok: true; connector: ConnectorSource; citation: CitationInput & { url: string } }
    | { ok: false; problem: RecordSearchProblem }
  > {
    const refuse = (kind: RecordSearchProblem['kind'], message: string) => ({
      ok: false as const,
      problem: { kind, message, retryAt: null },
    });
    if (getPerson(tree, request.personId) === null) {
      return refuse('gone', 'This person is no longer in the tree.');
    }
    // The page last shown, of the file it was shown from: never of a pack that was replaced since.
    const shown = (): boolean =>
      this.#last !== null &&
      this.#last.packId === request.packId &&
      this.#last.id === request.id &&
      this.#last.page === request.page &&
      this.#last.generation === request.generation &&
      this.#packs.generationOf(request.packId) === request.generation;
    if (!shown()) {
      return refuse('record', 'Only the page you last viewed can be cited. View it, then cite it.');
    }
    let found: District;
    let files: string[];
    try {
      const packId = this.#census(request.packId);
      found = await this.#district(packId, request.id);
      files = await this.#files(packId, request.id, found.folder);
    } catch (error) {
      return refuse('source', messageOf(error));
    }
    // The pack may have been replaced or removed, or another page shown, meanwhile.
    if (!shown()) {
      return refuse('record', 'Only the page you last viewed can be cited. View it, then cite it.');
    }
    const url = censusImageUrl(found.folder, files[request.page - 1]);
    if (url === null || url.length > CITATION_LIMITS.url) {
      return refuse('source', 'This page has no address the app can cite.');
    }
    const result = {
      ok: true as const,
      connector: {
        id: nara1950CensusManifest.id,
        create: citationSourceOf(nara1950CensusManifest),
      },
      citation: {
        page: censusCitationPage(found, request.page, files.length, CITATION_LIMITS.page),
        text: cleanText(found.description, CITATION_LIMITS.text),
        url,
        accessedAt: localDay(this.#now()),
      },
    };
    // Last look, with nothing awaited since the reads.
    if (!shown()) {
      return refuse('record', 'Only the page you last viewed can be cited. View it, then cite it.');
    }
    return result;
  }
}

/** True when the bytes start as a JPEG file does. */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
