import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { REGION_PRIORITY, type GazetteerPlace } from '@rulz/core';
import {
  GAZETTEER_FILE_NAME,
  Gazetteer,
  GazetteerBuilder,
  GazetteerError,
  type GazetteerInfo,
  type GazetteerMinimums,
} from '@rulz/db';
import type { GazetteerStatus } from '../shared/ipc';

/**
 * The gazetteer of the app: downloading GeoNames' lists when the user asks
 * for them, building the gazetteer file from them, and searching it.
 *
 * This is the only part of the app that asks anything of the internet, and
 * it does so only when the user presses "Download". It asks one host for a
 * fixed list of files and sends nothing about the user or their tree.
 *
 * Nothing here uses Electron; the function that fetches is handed in, so the
 * unit tests run this as it is with a fetch of their own.
 */

/** Where GeoNames publishes its lists. Every file is asked for below this address. */
export const GEONAMES_BASE_URL = 'https://download.geonames.org/export/dump/';

/** About how much is downloaded, for telling the user before they start. */
export const GAZETTEER_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const MB = 1024 * 1024;

type SourceKind = 'countries' | 'admin1' | 'admin2' | 'places';

export interface GazetteerSource {
  /** The file's name at GeoNames. */
  name: string;
  kind: SourceKind;
  /** The download is given up when the file turns out larger than this. */
  maxBytes: number;
}

/**
 * The files a gazetteer is built from: three lists of names for countries
 * and their divisions; every place of the countries of the region priority,
 * down to hamlets and townships; and the towns of 500 people and more of the
 * rest of the world.
 */
export function gazetteerSources(
  countries: readonly string[] = REGION_PRIORITY,
): GazetteerSource[] {
  return [
    { name: 'countryInfo.txt', kind: 'countries', maxBytes: 2 * MB },
    { name: 'admin1CodesASCII.txt', kind: 'admin1', maxBytes: 8 * MB },
    { name: 'admin2Codes.txt', kind: 'admin2', maxBytes: 40 * MB },
    ...countries.map((code) => ({
      name: `${code}.zip`,
      kind: 'places' as const,
      maxBytes: 400 * MB,
    })),
    { name: 'cities500.zip', kind: 'places', maxBytes: 100 * MB },
  ];
}

/**
 * The part of `fetch` this needs. Electron's `net.fetch` and Node's own both
 * fit. `redirect: 'error'` makes an answer that points somewhere else fail,
 * so that no request ever goes to another address than the one asked for.
 */
export type GazetteerFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'error' },
) => Promise<Response>;

/**
 * What the lists of GeoNames must at least hold. In November 2026 they held
 * 252 countries, 3,865 states and provinces, 47,753 counties and, of the
 * kinds the app keeps, 550,187 places.
 */
const FULL_LISTS: GazetteerMinimums = {
  places: 100_000,
  countries: 200,
  admin1: 3000,
  admin2: 30_000,
};

export interface GazetteerServiceOptions {
  /** The folder the gazetteer file is kept in. It is made when needed. */
  dir: string;
  fetch: GazetteerFetch;
  /** The countries taken in full; the region priority unless given. */
  countries?: readonly string[];
  /** The clock, replaceable in tests. */
  now?: () => number;
  /** A download that yields fewer entries than these is taken to have gone wrong. */
  minimums?: GazetteerMinimums;
  /** A download from which nothing arrives for this long is given up, in milliseconds. */
  stallMs?: number;
}

interface Job {
  phase: 'downloading' | 'building';
  step: number;
  steps: number;
  file: string;
  bytes: number;
  places: number;
  abort: AbortController;
  done: Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GazetteerService {
  readonly #dir: string;
  readonly #file: string;
  readonly #fetch: GazetteerFetch;
  readonly #countries: readonly string[];
  readonly #now: () => number;
  readonly #minimums: GazetteerMinimums;
  readonly #stallMs: number;
  #gazetteer: Gazetteer | null = null;
  #job: Job | null = null;
  #error: string | null = null;

  constructor(options: GazetteerServiceOptions) {
    this.#dir = options.dir;
    this.#file = join(options.dir, GAZETTEER_FILE_NAME);
    this.#fetch = options.fetch;
    this.#countries = options.countries ?? REGION_PRIORITY;
    this.#now = options.now ?? Date.now;
    this.#minimums = options.minimums ?? FULL_LISTS;
    this.#stallMs = options.stallMs ?? 60_000;
    // What a run that was cut short left behind.
    this.#removeWorkFiles();
    // The app was stopped in the moment a new list took the place of the old
    // one: the old one is put back.
    try {
      if (existsSync(this.#oldFile)) {
        if (existsSync(this.#file)) rmSync(this.#oldFile, { force: true });
        else renameSync(this.#oldFile, this.#file);
      }
    } catch {
      // Then there is no list until one is downloaded.
    }
    if (existsSync(this.#file)) {
      try {
        this.#gazetteer = Gazetteer.open(this.#file);
      } catch (error) {
        // A file that cannot be read is no gazetteer; downloading again replaces it.
        this.#error = messageOf(error);
      }
    }
  }

  get #workDir(): string {
    return join(this.#dir, 'download');
  }

  get #newFile(): string {
    return `${this.#file}.new`;
  }

  /** Where the list in use waits while a new one takes its place. */
  get #oldFile(): string {
    return `${this.#file}.old`;
  }

  #removeWorkFiles(): void {
    rmSync(this.#workDir, { recursive: true, force: true });
    rmSync(this.#newFile, { force: true });
  }

  get installed(): GazetteerInfo | null {
    return this.#gazetteer?.info ?? null;
  }

  status(): GazetteerStatus {
    const job = this.#job;
    return {
      installed: this.installed,
      job:
        job === null
          ? null
          : {
              phase: job.phase,
              step: job.step,
              steps: job.steps,
              file: job.file,
              bytes: job.bytes,
              places: job.places,
            },
      error: this.#error,
      downloadBytes: GAZETTEER_DOWNLOAD_BYTES,
    };
  }

  /**
   * Starts downloading and building the gazetteer, unless that is under way.
   * Returns at once; {@link status} says how far it is. A gazetteer that is
   * already there stays in use until the new one is complete.
   */
  start(): void {
    if (this.#job !== null) return;
    const sources = gazetteerSources(this.#countries);
    const abort = new AbortController();
    const job: Job = {
      phase: 'downloading',
      step: 0,
      steps: sources.length,
      file: '',
      bytes: 0,
      places: 0,
      abort,
      done: Promise.resolve(),
    };
    this.#job = job;
    this.#error = null;
    job.done = this.#run(job, sources).then(
      () => undefined,
      (error: unknown) => {
        // Stopping is what the user asked for, not something that went wrong.
        if (!abort.signal.aborted) this.#error = messageOf(error);
      },
    );
    void job.done.finally(() => {
      if (this.#job === job) this.#job = null;
    });
  }

  /** Stops the download or the build that is under way. */
  cancel(): void {
    this.#job?.abort.abort();
  }

  /** Resolves when no download or build is under way. */
  async idle(): Promise<void> {
    while (this.#job !== null) await this.#job.done;
  }

  /** Removes the gazetteer from this computer. The trees keep the places they linked. */
  remove(): void {
    if (this.#job !== null) throw new GazetteerError('the gazetteer is being downloaded');
    this.#gazetteer?.close();
    this.#gazetteer = null;
    this.#error = null;
    rmSync(this.#file, { force: true });
  }

  search(text: string, limit = 8): GazetteerPlace[] {
    return this.#gazetteer?.search(text, { limit, priority: this.#countries }) ?? [];
  }

  /**
   * The entry to offer for a place as it stands in a tree, for linking it
   * with one press; null when none fits well enough. A region that was found
   * only by leaving out the start of the text is not offered: a church in a
   * village the gazetteer does not have must not be tied to the middle of its
   * state. Looking for the place by hand still finds the region.
   */
  offer(text: string): GazetteerPlace | null {
    const found = this.#gazetteer?.find(text, { limit: 1, priority: this.#countries });
    const place = found?.places[0];
    if (!found || !place) return null;
    if (found.skipped > 0 && place.featureClass === 'A') return null;
    return place;
  }

  get(geonameId: number): GazetteerPlace | null {
    return this.#gazetteer?.get(geonameId) ?? null;
  }

  /** Stops any download and lets go of the gazetteer file. */
  close(): void {
    this.cancel();
    this.#gazetteer?.close();
    this.#gazetteer = null;
  }

  async #run(job: Job, sources: readonly GazetteerSource[]): Promise<void> {
    const signal = job.abort.signal;
    try {
      this.#removeWorkFiles();
      mkdirSync(this.#workDir, { recursive: true });
      for (const [index, source] of sources.entries()) {
        job.step = index + 1;
        job.file = source.name;
        await this.#download(job, source);
      }

      job.phase = 'building';
      job.step = 0;
      const builder = new GazetteerBuilder(this.#newFile);
      let info: GazetteerInfo;
      try {
        for (const [index, source] of sources.entries()) {
          signal.throwIfAborted();
          job.step = index + 1;
          job.file = source.name;
          const path = join(this.#workDir, source.name);
          if (source.kind === 'places') {
            await builder.addPlacesFromZip(path, source.name.replace(/\.zip$/i, '.txt'), {
              signal,
              onProgress: (places) => {
                job.places = places;
              },
            });
          } else {
            const text = readFileSync(path, 'utf8');
            if (source.kind === 'countries') builder.addCountryInfo(text);
            else if (source.kind === 'admin1') builder.addAdmin1(text);
            else builder.addAdmin2(text);
          }
        }
        signal.throwIfAborted();
        info = builder.finish({
          countries: this.#countries,
          builtAt: this.#now(),
          minimums: this.#minimums,
        });
      } catch (error) {
        builder.discard();
        throw error;
      }
      job.places = info.places;
      this.#install();
    } finally {
      this.#removeWorkFiles();
    }
  }

  /** Puts the new file in the place of the old one, and keeps the old one if that fails. */
  #install(): void {
    const old = this.#oldFile;
    this.#gazetteer?.close();
    this.#gazetteer = null;
    let moved = false;
    let placed = false;
    try {
      rmSync(old, { force: true });
      if (existsSync(this.#file)) {
        renameSync(this.#file, old);
        moved = true;
      }
      renameSync(this.#newFile, this.#file);
      placed = true;
      this.#gazetteer = Gazetteer.open(this.#file);
    } catch (error) {
      try {
        // A new file that cannot be opened is no gazetteer, and must not be
        // found in its place at the next start.
        if (placed) rmSync(this.#file, { force: true });
        if (moved) renameSync(old, this.#file);
        if (existsSync(this.#file)) this.#gazetteer = Gazetteer.open(this.#file);
      } catch {
        // The old one cannot be put back either; the app goes on without one.
      }
      throw error;
    }
    rmSync(old, { force: true });
  }

  async #download(job: Job, source: GazetteerSource): Promise<void> {
    const user = job.abort.signal;
    // Given up as well when nothing arrives for a long time.
    const stall = new AbortController();
    const signal = AbortSignal.any([user, stall.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), this.#stallMs);
    };

    const url = GEONAMES_BASE_URL + source.name;
    let fd: number | undefined;
    try {
      watch();
      const response = await this.#fetch(url, { signal, redirect: 'error' });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let announced = NaN;
      let received = 0;
      try {
        if (!response.ok) {
          throw new GazetteerError(`GeoNames answered ${response.status} for ${source.name}`);
        }
        // No redirect is followed; should one be all the same, the file must
        // still come from GeoNames.
        if (response.url !== '' && !response.url.startsWith(GEONAMES_BASE_URL)) {
          throw new GazetteerError(`${source.name} was sent from somewhere else than GeoNames`);
        }
        // When the answer was packed on its way, the length it announces is
        // that of the packed bytes, which says nothing about what arrives here.
        const packed = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
        const length = response.headers.get('content-length')?.trim() ?? '';
        if (!packed && length !== '') announced = Number(length);
        if (announced > source.maxBytes) {
          throw new GazetteerError(`${source.name} is larger than it should be`);
        }
        reader = response.body?.getReader();
        if (!reader) throw new GazetteerError(`GeoNames sent nothing for ${source.name}`);

        fd = openSync(join(this.#workDir, source.name), 'w');
        for (;;) {
          watch();
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > source.maxBytes) {
            throw new GazetteerError(`${source.name} is larger than it should be`);
          }
          for (let written = 0; written < value.length;) {
            written += writeSync(fd, value, written, value.length - written);
          }
          job.bytes += value.length;
        }
      } catch (error) {
        // Lets go of the connection, whether or not reading had begun.
        void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => undefined);
        throw error;
      }
      if (Number.isFinite(announced) && received !== announced) {
        throw new GazetteerError(`the download of ${source.name} ended before it was complete`);
      }
      if (received === 0) throw new GazetteerError(`GeoNames sent nothing for ${source.name}`);
    } catch (error) {
      if (user.aborted) throw error;
      if (stall.signal.aborted) {
        throw new GazetteerError(
          `the download of ${source.name} stopped; check the internet connection and try again`,
        );
      }
      if (error instanceof GazetteerError) throw error;
      throw new GazetteerError(
        `${source.name} could not be downloaded (${messageOf(error)}); check the internet connection and try again`,
      );
    } finally {
      clearTimeout(timer);
      if (fd !== undefined) closeSync(fd);
    }
  }
}
