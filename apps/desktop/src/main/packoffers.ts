import {
  OA_CSV_HOST,
  OA_PACK_KIND,
  OA_SITE_HOST,
  OA_CATALOGUE_URL,
  oaDatasetPageUrl,
  parseOaCatalogue,
  parseOaDatasetPage,
  type OaArchive,
} from '@rulz/connectors';
import type { PackMeta } from '@rulz/db';
import type {
  PackActionResult,
  PackArchiveInfo,
  PackArchivesResult,
  PackInfo,
  PackOfferInfo,
  PackOfferResult,
} from '../shared/ipc';
import { PackError, type PackFetch, type PackInstallSpec } from './packs';
import { userAgentOf } from './records';

/**
 * The archives of Open Archives that can be installed as packs: the catalogue
 * of them, the page and file sizes of one, and the install spec that follows
 * from a look at one. It is the only place that asks Open Archives anything.
 *
 * Every request is a plain GET or HEAD of one address on one of two hosts,
 * sends nothing but its user agent, follows no redirect, gives up after 30
 * seconds, and is read no further than a fixed number of bytes. Nothing of the
 * user or of the tree is part of any of them. Nothing here uses Electron: the
 * function that fetches is handed in, and is looked up at each call.
 */

const MB = 1024 * 1024;
const CATALOGUE_CAP = 8 * MB;
const PAGE_CAP = 2 * MB;
const TIMEOUT_MS = 30_000;
const CATALOGUE_KEPT_MS = 60 * 60 * 1000;
const OFFER_KEPT_MS = 15 * 60 * 1000;
/** A pack is about this many times the size of its gzip files. */
const ESTIMATE_FACTOR = 12.5;
/** A pack takes about this many bytes for each record of the catalogue. */
const ESTIMATE_PER_RECORD = 735;

const LOOK_AGAIN = 'The look at this archive is out of date. Look at it again, then install.';

/** What goes wrong when asking Open Archives, in words for the user. */
export class PackOfferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackOfferError';
  }
}

/** The part of the pack manager this needs. */
export interface OfferPacks {
  state(): { freeBytes: number | null; packs: PackInfo[] };
  metaOf(id: string): PackMeta | null;
  install(spec: PackInstallSpec): void;
  readonly running: boolean;
  readonly reserveBytes: number;
}

export interface PackOffersOptions {
  fetch: PackFetch;
  appVersion: string;
  packs: OfferPacks;
  now?: () => number;
  timeoutMs?: number;
}

interface Held {
  offer: PackOfferInfo;
  spec: PackInstallSpec;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const packIdOf = (code: string): string => `oa${code}`;

export class PackOffers {
  readonly #fetch: PackFetch;
  readonly #userAgent: string;
  readonly #packs: OfferPacks;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #catalogue: { at: number; archives: OaArchive[] } | null = null;
  #loading: Promise<OaArchive[]> | null = null;
  readonly #held = new Map<string, Held>();
  /** How many looks at each code have been started; the last of them is the one held. */
  readonly #sequences = new Map<string, number>();

  constructor(options: PackOffersOptions) {
    this.#fetch = options.fetch;
    this.#userAgent = userAgentOf(options.appVersion);
    this.#packs = options.packs;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  // ---- asking ----------------------------------------------------------------

  /** One request, to one address on one host, and the answer if it is a good one. */
  async #ask(
    url: string,
    host: string,
    method: 'GET' | 'HEAD',
    signal: AbortSignal,
  ): Promise<Response> {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== host ||
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      throw new PackOfferError('The address is not one the app asks.');
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        method,
        headers: { 'user-agent': this.#userAgent },
      });
    } catch (error) {
      throw new PackOfferError(
        `${host} could not be reached (${messageOf(error)}); check the internet connection and try again.`,
      );
    }
    if (response.url !== '' && new URL(response.url).hostname !== host) {
      void response.body?.cancel().catch(() => undefined);
      throw new PackOfferError(`${host} answered from somewhere else.`);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new PackOfferError(`${host} answered ${response.status}.`);
    }
    return response;
  }

  /** The text of an answer, read until it ends or passes `cap` bytes, which is a refusal. */
  async #text(response: Response, cap: number): Promise<string> {
    const length = response.headers.get('content-length')?.trim() ?? '';
    if (/^\d{1,15}$/.test(length) && Number(length) > cap) {
      void response.body?.cancel().catch(() => undefined);
      throw new PackOfferError('The answer is larger than it should be.');
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > cap) throw new PackOfferError('The answer is larger than it should be.');
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (error instanceof PackOfferError) throw error;
      throw new PackOfferError(`The answer could not be read (${messageOf(error)}).`);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // ---- the catalogue ---------------------------------------------------------

  /** The CC0 archives of the catalogue. Asked for at most once an hour. */
  async list(): Promise<OaArchive[]> {
    const kept = this.#catalogue;
    if (kept !== null && this.#now() - kept.at < CATALOGUE_KEPT_MS) return kept.archives;
    this.#loading ??= this.#loadCatalogue().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #loadCatalogue(): Promise<OaArchive[]> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const response = await this.#ask(OA_CATALOGUE_URL, OA_SITE_HOST, 'GET', signal);
    const body = await this.#text(response, CATALOGUE_CAP);
    let archives: OaArchive[];
    try {
      archives = parseOaCatalogue(JSON.parse(body));
    } catch (error) {
      throw new PackOfferError(
        `The catalogue of Open Archives could not be read (${messageOf(error)}).`,
      );
    }
    this.#catalogue = { at: this.#now(), archives };
    return archives;
  }

  /** The archives for the window, each with whether it is installed. A failure is a message, not a throw. */
  async archives(): Promise<PackArchivesResult> {
    try {
      const archives = await this.list();
      const installed = new Map(this.#packs.state().packs.map((pack) => [pack.id, pack]));
      const infos: PackArchiveInfo[] = archives.map((archive) => {
        const pack = installed.get(packIdOf(archive.code));
        const maybe =
          pack !== undefined &&
          archive.modified !== null &&
          pack.sourceModified !== null &&
          archive.modified > pack.sourceModified;
        return {
          code: archive.code,
          name: archive.name,
          period: archive.period,
          records: archive.records,
          modified: archive.modified,
          installed: pack === undefined ? 'no' : maybe ? 'maybe-update' : 'yes',
        };
      });
      return { ok: true, archives: infos };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  // ---- one archive -----------------------------------------------------------

  /** Whether the pack of this archive is there, and is made from the files now offered. */
  #installedState(code: string, files: { url: string; bytes: number; etag: string | null }[]) {
    const id = packIdOf(code);
    const info = this.#packs.state().packs.find((pack) => pack.id === id);
    if (info === undefined) return 'no' as const;
    if (info.state !== 'ready') return 'update' as const;
    const meta = this.#packs.metaOf(id);
    if (meta === null) return 'update' as const;
    const same =
      meta.files.length === files.length &&
      files.every((file) => {
        const had = meta.files.find((kept) => kept.url === file.url);
        return had !== undefined && had.etag === file.etag && had.bytes === file.bytes;
      });
    return same ? ('current' as const) : ('update' as const);
  }

  /**
   * Reads the page of an archive and asks for the size of each of its files.
   * The result is held for 15 minutes; an install is made from it, and only
   * from it. A failure is a message, not a throw.
   */
  async describe(code: string): Promise<PackOfferResult> {
    try {
      return { ok: true, offer: await this.#describe(code) };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  /** Lets go of every look that has expired. */
  #prune(): void {
    const now = this.#now();
    for (const [code, held] of this.#held) {
      if (now >= held.offer.expiresAt) this.#held.delete(code);
    }
  }

  async #describe(code: string): Promise<PackOfferInfo> {
    // Only the latest look at a code may be held, whichever of two ends last.
    const sequence = (this.#sequences.get(code) ?? 0) + 1;
    this.#sequences.set(code, sequence);
    this.#held.delete(code);
    const archive = (await this.list()).find((entry) => entry.code === code);
    if (archive === undefined) {
      throw new PackOfferError('This archive is not in the catalogue of Open Archives.');
    }
    const pageUrl = oaDatasetPageUrl(code);
    const pageSignal = AbortSignal.timeout(this.#timeoutMs);
    const page = parseOaDatasetPage(
      await this.#text(await this.#ask(pageUrl, OA_SITE_HOST, 'GET', pageSignal), PAGE_CAP),
      code,
    );
    if (!page.cc0) throw new PackOfferError("This archive's page does not say it is CC0.");
    if (page.files.length === 0) throw new PackOfferError('This archive offers no CSV files.');

    const files: { url: string; bytes: number; etag: string | null }[] = [];
    for (const url of page.files) {
      const response = await this.#ask(
        url,
        OA_CSV_HOST,
        'HEAD',
        AbortSignal.timeout(this.#timeoutMs),
      );
      void response.body?.cancel().catch(() => undefined);
      const length = response.headers.get('content-length')?.trim() ?? '';
      if (!/^\d{1,15}$/.test(length) || Number(length) < 1) {
        throw new PackOfferError(
          `The size of ${url.slice(url.lastIndexOf('/') + 1)} is not given, so the download cannot be planned.`,
        );
      }
      const etag = response.headers.get('etag')?.trim() ?? '';
      files.push({ url, bytes: Number(length), etag: etag === '' ? null : etag });
    }

    const downloadBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const estimateBytes = Math.round(
      Math.max(downloadBytes * ESTIMATE_FACTOR, (archive.records ?? 0) * ESTIMATE_PER_RECORD),
    );
    const expiresAt = this.#now() + OFFER_KEPT_MS;
    const offer: PackOfferInfo = {
      code,
      name: archive.name,
      period: archive.period,
      records: archive.records,
      pageUrl,
      files: files.map(({ url, bytes }) => ({ url, bytes })),
      downloadBytes,
      estimateBytes,
      freeBytes: this.#packs.state().freeBytes,
      installed: this.#installedState(code, files),
      expiresAt,
    };
    const spec: PackInstallSpec = {
      id: packIdOf(code),
      kind: OA_PACK_KIND,
      title: archive.name,
      sourceName: 'Open Archives',
      sourceUrl: pageUrl,
      licence: 'CC0 1.0',
      credit: 'Open Archives (openarchieven.nl) and the archive',
      files,
      ...(archive.modified !== null ? { sourceModified: archive.modified } : {}),
    };
    this.#prune();
    if (this.#sequences.get(code) === sequence) this.#held.set(code, { offer, spec });
    return offer;
  }

  /** How many looks are in the map, expired ones that nothing has let go yet included. */
  get heldCount(): number {
    return this.#held.size;
  }

  /** The install spec of the last look at an archive, while that look is held; otherwise null. */
  specOf(code: string): PackInstallSpec | null {
    this.#prune();
    return this.#held.get(code)?.spec ?? null;
  }

  /** Starts the install or update from a look that is still held. Never looks silently. */
  install(code: string): PackActionResult {
    const spec = this.specOf(code);
    const held = this.#held.get(code);
    if (spec === null || held === undefined) return { ok: false, message: LOOK_AGAIN };
    if (this.#packs.running) {
      return { ok: false, message: 'Another pack is being installed. Wait for it, or cancel it.' };
    }
    const free = this.#packs.state().freeBytes;
    const need = held.offer.estimateBytes + this.#packs.reserveBytes;
    if (free !== null && free < need) {
      return {
        ok: false,
        message: `There is not enough free space: about ${Math.ceil(need / MB).toLocaleString('en-US')} MB are needed and ${Math.floor(free / MB).toLocaleString('en-US')} MB are free.`,
      };
    }
    try {
      this.#packs.install(spec);
    } catch (error) {
      if (error instanceof PackError) return { ok: false, message: error.message };
      throw error;
    }
    return { ok: true };
  }
}
