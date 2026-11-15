import {
  CENSUS_CODES,
  CENSUS_HOST,
  CENSUS_LISTING_URL,
  NARA_CENSUS_PACK_KIND,
  censusPackId,
  censusStateUrl,
  nara1950CensusManifest,
  parseCensusListing,
  type CensusListed,
} from '@rulz/connectors';
import type { CensusStateInfo, CensusStatesResult, PackActionResult } from '../shared/ipc';
import { PackError, type PackFetch, type PackInstallSpec } from './packs';
import type { OfferPacks } from './packoffers';
import { userAgentOf } from './records';

/**
 * The states of the 1950 census that can be installed as packs: the bucket's
 * listing of them, and the install spec that follows from it. It is the only
 * place that asks the census bucket for a list.
 *
 * Every request is a plain GET of one address on one host, sends nothing but
 * its user agent, follows no redirect, gives up after 30 seconds, and is read
 * no further than 1 MB. Nothing of the user or of the tree is part of it.
 * Nothing here uses Electron: the function that fetches is handed in, and is
 * looked up at each call.
 */

const MB = 1024 * 1024;
const LISTING_CAP = 1 * MB;
const TIMEOUT_MS = 30_000;
const LISTING_KEPT_MS = 60 * 60 * 1000;
const HELD_MS = 15 * 60 * 1000;
/**
 * A pack is at most about this many times the size of its JSON file. Measured
 * on made-up states with the shape of a real one (descriptions of 50 to 300
 * characters, 20 to 40 page files a district, 300 to 14,000 districts): the
 * pack is 0.93 times the file when the file is indented by two spaces, and
 * 1.36 to 1.44 times when it is compact (the pack keeps the lists of page
 * files whole, and its text index adds to them). The real files' white space
 * is not known, so the estimate takes the larger.
 */
export const CENSUS_ESTIMATE_FACTOR = 1.5;

const LOOK_AGAIN = 'The list of states is out of date. List them again, then install.';

/** What goes wrong when asking the census bucket, in words for the user. */
export class CensusOfferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CensusOfferError';
  }
}

export interface CensusOffersOptions {
  fetch: PackFetch;
  appVersion: string;
  packs: OfferPacks;
  now?: () => number;
  timeoutMs?: number;
}

interface Held {
  info: CensusStateInfo;
  spec: PackInstallSpec;
  expiresAt: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class CensusOffers {
  readonly #fetch: PackFetch;
  readonly #userAgent: string;
  readonly #packs: OfferPacks;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  #listing: { at: number; states: CensusListed[] } | null = null;
  #loading: Promise<CensusListed[]> | null = null;
  readonly #held = new Map<string, Held>();

  constructor(options: CensusOffersOptions) {
    this.#fetch = options.fetch;
    this.#userAgent = userAgentOf(options.appVersion);
    this.#packs = options.packs;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /** The text of the listing, read until it ends or passes the cap, which is a refusal. */
  async #listingText(signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(CENSUS_LISTING_URL, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        method: 'GET',
        headers: { 'user-agent': this.#userAgent },
      });
    } catch (error) {
      throw new CensusOfferError(
        `${CENSUS_HOST} could not be reached (${messageOf(error)}); check the internet connection and try again.`,
      );
    }
    if (response.url !== '' && new URL(response.url).hostname !== CENSUS_HOST) {
      void response.body?.cancel().catch(() => undefined);
      throw new CensusOfferError(`${CENSUS_HOST} answered from somewhere else.`);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new CensusOfferError(`${CENSUS_HOST} answered ${response.status}.`);
    }
    const length = response.headers.get('content-length')?.trim() ?? '';
    if (/^\d{1,15}$/.test(length) && Number(length) > LISTING_CAP) {
      void response.body?.cancel().catch(() => undefined);
      throw new CensusOfferError('The answer is larger than it should be.');
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
        if (received > LISTING_CAP) {
          throw new CensusOfferError('The answer is larger than it should be.');
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (error instanceof CensusOfferError) throw error;
      throw new CensusOfferError(`The answer could not be read (${messageOf(error)}).`);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** The states of the bucket's listing. Asked for at most once an hour. */
  async #list(): Promise<CensusListed[]> {
    const kept = this.#listing;
    if (kept !== null && this.#now() - kept.at < LISTING_KEPT_MS) return kept.states;
    this.#loading ??= this.#load().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #load(): Promise<CensusListed[]> {
    const text = await this.#listingText(AbortSignal.timeout(this.#timeoutMs));
    let states: CensusListed[];
    try {
      states = parseCensusListing(text);
    } catch (error) {
      throw new CensusOfferError(
        `The listing of the census bucket could not be read (${messageOf(error)}).`,
      );
    }
    this.#listing = { at: this.#now(), states };
    return states;
  }

  /** Whether the pack of this state is there, and is made from the file now listed. */
  #installedState(listed: CensusListed): CensusStateInfo['installed'] {
    const id = censusPackId(listed.code);
    const info = this.#packs.state().packs.find((pack) => pack.id === id);
    if (info === undefined) return 'no';
    if (info.state !== 'ready') return 'update';
    const meta = this.#packs.metaOf(id);
    if (meta === null) return 'update';
    const url = censusStateUrl(listed.code);
    const had = meta.files.find((file) => file.url === url);
    return meta.files.length === 1 &&
      had !== undefined &&
      had.etag === listed.etag &&
      had.bytes === listed.bytes
      ? 'current'
      : 'update';
  }

  /**
   * The states for the window, with whether each is installed, and how long
   * this listing is held: an install is made from what was listed, and only
   * while it is held. A failure is a message, not a throw.
   */
  async states(): Promise<CensusStatesResult> {
    try {
      const listed = await this.#list();
      const now = this.#now();
      const expiresAt = now + HELD_MS;
      this.#held.clear();
      const states = listed.map((entry): CensusStateInfo => {
        const info: CensusStateInfo = {
          code: entry.code,
          name: CENSUS_CODES[entry.code] ?? entry.code,
          bytes: entry.bytes,
          modified: entry.modified,
          estimateBytes: Math.round(entry.bytes * CENSUS_ESTIMATE_FACTOR),
          installed: this.#installedState(entry),
        };
        const spec: PackInstallSpec = {
          id: censusPackId(entry.code),
          kind: NARA_CENSUS_PACK_KIND,
          title: `1950 census: ${info.name}`,
          sourceName: nara1950CensusManifest.name,
          sourceUrl: 'https://1950census.archives.gov',
          licence: 'Public domain (US Government work)',
          credit: nara1950CensusManifest.attribution,
          files: [{ url: censusStateUrl(entry.code), bytes: entry.bytes, etag: entry.etag }],
          sourceModified: entry.modified,
        };
        this.#held.set(entry.code, { info, spec, expiresAt });
        return info;
      });
      return { ok: true, states, freeBytes: this.#packs.state().freeBytes, expiresAt };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  /** The install spec of a state of the listing last given, while it is held; otherwise null. */
  specOf(code: string): PackInstallSpec | null {
    const held = this.#held.get(code);
    if (held === undefined) return null;
    if (this.#now() >= held.expiresAt) {
      this.#held.delete(code);
      return null;
    }
    return held.spec;
  }

  /** Starts the install or update of a state from the listing last given, while it is held. Never lists silently. */
  install(code: string): PackActionResult {
    const spec = this.specOf(code);
    const held = this.#held.get(code);
    if (spec === null || held === undefined) return { ok: false, message: LOOK_AGAIN };
    if (this.#packs.running) {
      return { ok: false, message: 'Another pack is being installed. Wait for it, or cancel it.' };
    }
    const free = this.#packs.state().freeBytes;
    const need = held.info.estimateBytes + held.info.bytes + this.#packs.reserveBytes;
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
