import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  PACK_FILE_SUFFIX,
  PACK_ID_PATTERN,
  PackReader,
  getSetting,
  type Db,
  type PackMeta,
} from '@rulz/db';
import type { PackActionResult, PackInfo, PackJob, PacksState } from '../shared/ipc';
import {
  PACK_KINDS,
  freeBytesOf,
  type BuildInput,
  type BuildRun,
  type BuildRunner,
  BuildStopped,
} from './packbuild';
import type { PackSearch } from './packsearch';
import type { DistinctQuery, GetQuery, ListQuery, SearchQuery } from './packsearch.worker';
import { dayStart, userAgentOf } from './records';

/**
 * The data packs of the app: where they are kept, installing one from the
 * files its source publishes, replacing it, removing it, and searching it.
 *
 * A pack is one SQLite file, `<id>.pack`, in the packs folder. It is built on
 * this PC from the source's own files and belongs to the app, never to a tree.
 * The app writes and deletes only inside that folder, only files and folders
 * whose names it made itself (`<id>.pack`, `<id>.pack.new`, `<id>.pack.old`,
 * `work-<id>`, `job.lock` and the marker file), and never follows a link.
 * A folder that holds anything but the marker and no marker is not the app's
 * and is refused, so that a folder somebody chose for something else is never
 * swept.
 *
 * Nothing here uses Electron; the function that fetches, the build and the
 * search are handed in, so the unit tests run this as it is.
 */

/** The file that says a folder is the packs folder. It holds a few words for whoever finds it. */
export const PACKS_MARKER = 'rulz-packs.txt';
/** The file that says a job is running, with the process that runs it. */
export const PACKS_LOCK = 'job.lock';
/** The setting that holds where the packs are kept, when the user chose a folder. */
export const PACKS_ROOT_SETTING = 'packs.root';

const MB = 1024 * 1024;
/** What must stay free on the drive. */
const RESERVE_BYTES = 512 * MB;
/** Without a length, the free space is looked at after this much. */
const RECHECK_BYTES = 64 * MB;
/** How long a finished job stays in the state. */
const JOB_SHOWN_MS = 30_000;
/** At quit, a job is given this long to clean up; the build worker's own grace is 10 seconds. */
const SHUTDOWN_WAIT_MS = 15_000;

const WORK_NAME = /^work-([a-z0-9]{2,12})$/;
const PART_NAME = /^([a-z0-9]{2,12})\.pack\.(new|old)$/;
/** The only names a job makes inside its work folder: the downloaded files. */
const WORK_FILE_NAME = /^file\d{1,3}$/;
const PACK_NAME = /^([a-z0-9]{2,12})\.pack$/;

/** What is asked of a source to install a pack from it. */
export interface PackInstallSpec {
  id: string;
  kind: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  licence: string;
  credit: string;
  /** Each file may say the size and ETag it was listed with; a download that differs fails. */
  files: { url: string; bytes?: number; etag?: string | null }[];
  /** The source's own last-changed day, `YYYY-MM-DD`, kept in the pack. */
  sourceModified?: string;
}

/** What a download is told to expect of a file, from the listing it was chosen from. */
interface Expected {
  bytes?: number;
  etag?: string | null;
}

const CHANGED_MESSAGE = "The archive's files changed since they were listed; look again.";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The part of `fetch` this needs. `redirect: 'error'` makes an answer that
 * points somewhere else fail, so that no request goes to another address than
 * the one asked for.
 */
export type PackFetch = (
  url: string,
  init: {
    signal: AbortSignal;
    redirect: 'error';
    /** No cookie is stored or sent. */
    credentials: 'omit';
    method: 'GET' | 'HEAD';
    headers: Record<string, string>;
  },
) => Promise<Response>;

/** A problem with a request to install or remove a pack, in words for the user. */
export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

export interface PackManagerOptions {
  /** The app's settings. */
  appDb: Db;
  /** Where the packs are kept unless the setting names a folder. */
  defaultRoot: string;
  fetch: PackFetch;
  appVersion: string;
  /** The search side: told to let go of a pack's file before it is replaced or deleted. */
  search: PackSearch;
  /** Builds a pack from downloaded files. */
  build: BuildRunner;
  /** The clock, replaceable in tests. */
  now?: () => number;
  /** Free space on the drive of a folder; null when unknown. Replaceable in tests. */
  freeBytes?: (dir: string) => number | null;
  /** What must stay free on the drive, in bytes. */
  reserveBytes?: number;
  /** A download from which nothing arrives for this long is given up, in milliseconds. */
  stallMs?: number;
  /** The wait between two tries to rename or delete a file that is in use, in milliseconds. */
  retryMs?: number;
  /** Tests only: hosts that are allowed besides the kind's own, and whether they may be asked over plain http. */
  testHosts?: { hosts: readonly string[]; insecure: boolean };
  /** Whether a process is running; by default the system is asked. */
  isRunning?: (pid: number) => boolean;
}

interface Job {
  id: string;
  title: string;
  phase: PackJob['phase'];
  doneBytes: number;
  totalBytes: number | null;
  rows: number;
  message: string | null;
  abort: AbortController;
  build: BuildRun | null;
  done: Promise<void>;
  /** When the job ended; null while it runs. */
  endedAt: number | null;
}

interface Downloaded {
  path: string;
  url: string;
  bytes: number;
  sha256: string;
  etag: string | null;
  modified: string | null;
}

type Inspection = { state: 'ok' | 'new' } | { state: 'refused'; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Deletes what a job made in its work folder: the files it downloaded, each
 * only when it is a plain file. Then removes the folder if it is empty. A link
 * is never followed, and anything else in the folder stays.
 */
function clearWorkFolder(work: string): void {
  const folder = lstatOrNull(work);
  if (folder === null || folder.isSymbolicLink() || !folder.isDirectory()) return;
  let names: string[];
  try {
    names = readdirSync(work);
  } catch {
    return;
  }
  for (const name of names) {
    if (!WORK_FILE_NAME.test(name)) continue;
    const path = join(work, name);
    const stats = lstatOrNull(path);
    if (stats === null || stats.isSymbolicLink() || !stats.isFile()) continue;
    try {
      unlinkSync(path);
    } catch {
      // Looked at again at the next start.
    }
  }
  try {
    // Fails, and so keeps the folder, unless it is empty.
    rmdirSync(work);
  } catch {
    // Something else is in it.
  }
}

/** A text of a pack's own description as a page may be given it: a string, and not very long. */
const shortText = (value: unknown, max = 500): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

function isRunningProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

export class PackManager {
  readonly #appDb: Db;
  readonly #defaultRoot: string;
  readonly #fetch: PackFetch;
  readonly #userAgent: string;
  readonly #search: PackSearch;
  readonly #build: BuildRunner;
  readonly #now: () => number;
  readonly #freeBytes: (dir: string) => number | null;
  readonly #reserve: number;
  readonly #stallMs: number;
  readonly #retryMs: number;
  readonly #testHosts: { hosts: readonly string[]; insecure: boolean };
  readonly #isRunning: (pid: number) => boolean;
  #job: Job | null = null;
  /** Packs that are being removed: no job for them starts meanwhile. */
  readonly #removing = new Set<string>();
  /** What was read of each pack's file, by its size and time. */
  readonly #infos = new Map<string, { signature: string; info: PackInfo }>();
  /** Told when a pack's file is about to be replaced or deleted. */
  readonly #leaving: ((id: string) => void)[] = [];
  /** See {@link generationOf}. */
  readonly #generations = new Map<string, number>();

  constructor(options: PackManagerOptions) {
    this.#appDb = options.appDb;
    this.#defaultRoot = options.defaultRoot;
    this.#fetch = options.fetch;
    this.#userAgent = userAgentOf(options.appVersion);
    this.#search = options.search;
    this.#build = options.build;
    this.#now = options.now ?? Date.now;
    this.#freeBytes = options.freeBytes ?? freeBytesOf;
    this.#reserve = options.reserveBytes ?? RESERVE_BYTES;
    this.#stallMs = options.stallMs ?? 60_000;
    this.#retryMs = options.retryMs ?? 250;
    this.#testHosts = options.testHosts ?? { hosts: [], insecure: false };
    this.#isRunning = options.isRunning ?? isRunningProcess;
  }

  /** The folder the packs are kept in. */
  get root(): string {
    const kept = getSetting(this.#appDb, PACKS_ROOT_SETTING);
    return kept !== null && kept !== '' && isAbsolute(kept) ? kept : this.#defaultRoot;
  }

  /** Where the file of a pack is. */
  pathOf(id: string): string {
    return join(this.root, `${id}${PACK_FILE_SUFFIX}`);
  }

  // ---- the folder ----------------------------------------------------------

  /** Whether the folder is the app's, is new, or is somebody else's. Writes nothing. */
  #inspect(): Inspection {
    const root = this.root;
    const stats = lstatOrNull(root);
    if (stats === null) return { state: 'new' };
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return {
        state: 'refused',
        message: `The packs folder ${root} is not a plain folder, so the app does not use it.`,
      };
    }
    const marker = lstatOrNull(join(root, PACKS_MARKER));
    if (marker !== null) {
      return marker.isFile() && !marker.isSymbolicLink()
        ? { state: 'ok' }
        : {
            state: 'refused',
            message: `The packs folder ${root} has a marker that is not a file.`,
          };
    }
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      return {
        state: 'refused',
        message: `The packs folder ${root} cannot be read (${messageOf(error)}).`,
      };
    }
    return entries.length === 0
      ? { state: 'new' }
      : {
          state: 'refused',
          message: `The folder ${root} holds files but is not a packs folder of this app, so nothing is kept or deleted there. Choose another folder or empty this one.`,
        };
  }

  /** Makes the folder and its marker when it is new. Returns why it may not be used, or null. */
  #prepare(): string | null {
    const found = this.#inspect();
    if (found.state === 'refused') return found.message;
    if (found.state === 'ok') return null;
    try {
      mkdirSync(this.root, { recursive: true });
      writeFileSync(
        join(this.root, PACKS_MARKER),
        'This folder holds the data packs of RulZ Ancestry. The app writes and deletes files here. Put nothing else in it.\r\n',
        { flag: 'wx' },
      );
    } catch (error) {
      return `The packs folder ${this.root} could not be made (${messageOf(error)}).`;
    }
    return null;
  }

  /**
   * Sweeps what a run that was cut short left in the folder: a pack that was
   * being built, a download, a pack that was being replaced (the old one is
   * put back when the new one did not arrive). Does nothing in a folder that
   * is not the app's, or where a job of a running process is at work.
   */
  start(): void {
    const found = this.#inspect();
    if (found.state !== 'ok') return;
    const root = this.root;
    const lock = join(root, PACKS_LOCK);
    const lockStats = lstatOrNull(lock);
    if (lockStats !== null) {
      if (lockStats.isFile() && !lockStats.isSymbolicLink() && this.#lockIsLive(lock)) return;
    }
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(root, name);
      const stats = lstatOrNull(path);
      // A link is never followed and never deleted.
      if (stats === null || stats.isSymbolicLink()) continue;
      try {
        if (WORK_NAME.test(name)) {
          clearWorkFolder(path);
          continue;
        }
        const part = PART_NAME.exec(name);
        if (part === null || !stats.isFile()) continue;
        if (part[2] === 'new') {
          unlinkSync(path);
        } else {
          const pack = join(root, `${part[1] ?? ''}${PACK_FILE_SUFFIX}`);
          if (lstatOrNull(pack) === null) renameSync(path, pack);
          else unlinkSync(path);
        }
      } catch {
        // What cannot be deleted now is looked at again at the next start.
      }
    }
    if (lockStats !== null && lockStats.isFile() && !lockStats.isSymbolicLink()) {
      rmSync(lock, { force: true });
    }
  }

  #lockIsLive(lock: string): boolean {
    try {
      const kept = JSON.parse(readFileSync(lock, 'utf8')) as { pid?: unknown };
      return (
        typeof kept.pid === 'number' &&
        Number.isInteger(kept.pid) &&
        kept.pid > 0 &&
        kept.pid !== process.pid &&
        this.#isRunning(kept.pid)
      );
    } catch {
      return false;
    }
  }

  // ---- what is installed ---------------------------------------------------

  #freeBytesOfRoot(): number | null {
    let dir = this.root;
    for (let up = 0; up < 8; up += 1) {
      if (existsSync(dir)) return this.#freeBytes(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  #readPack(path: string, id: string, bytes: number): PackInfo {
    const unreadable: PackInfo = {
      id,
      kind: '',
      title: id,
      sourceName: '',
      licence: '',
      credit: '',
      rows: 0,
      bytes,
      downloadedAt: '',
      state: 'unreadable',
      sourceModified: null,
    };
    const opened = PackReader.open(path);
    if (!opened.ok) return unreadable;
    const meta: PackMeta = opened.reader.meta;
    opened.reader.close();
    const kind = PACK_KINDS[meta.kind];
    const dated = dayStart(meta.downloadedAt) !== null;
    const state =
      meta.packId !== id || kind === undefined || !dated
        ? 'unreadable'
        : meta.builderVersion !== kind.builderVersion
          ? 'rebuild'
          : 'ready';
    return {
      id,
      kind: shortText(meta.kind, 40),
      title: shortText(meta.title, 300) || id,
      sourceName: shortText(meta.sourceName, 300),
      licence: shortText(meta.licence),
      credit: shortText(meta.credit),
      rows: Number.isFinite(meta.rows) ? Math.max(0, Math.trunc(meta.rows)) : 0,
      bytes,
      downloadedAt: dated ? meta.downloadedAt : '',
      state,
      sourceModified:
        typeof meta.sourceModified === 'string' && DAY.test(meta.sourceModified)
          ? meta.sourceModified
          : null,
    };
  }

  /** What the file of an installed pack says of itself, or null when it is not there or not a pack. */
  metaOf(id: string): PackMeta | null {
    if (typeof id !== 'string' || !PACK_ID_PATTERN.test(id)) return null;
    const path = this.pathOf(id);
    const stats = lstatOrNull(path);
    if (stats === null || !stats.isFile() || stats.isSymbolicLink()) return null;
    const opened = PackReader.open(path);
    if (!opened.ok) return null;
    const meta = opened.reader.meta;
    opened.reader.close();
    return meta;
  }

  /** What must stay free on the drive besides a pack's own size. */
  get reserveBytes(): number {
    return this.#reserve;
  }

  /** The packs in the folder, read from their own files. A file is read again only when it changed. */
  #list(): PackInfo[] {
    const root = this.root;
    const marker = lstatOrNull(join(root, PACKS_MARKER));
    if (marker === null || !marker.isFile() || marker.isSymbolicLink()) return [];
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return [];
    }
    const found: PackInfo[] = [];
    const seen = new Set<string>();
    for (const name of names.sort()) {
      const match = PACK_NAME.exec(name);
      const id = match?.[1];
      if (id === undefined) continue;
      const path = join(root, name);
      const stats = lstatOrNull(path);
      if (stats === null || !stats.isFile() || stats.isSymbolicLink()) continue;
      seen.add(id);
      const signature = `${stats.mtimeMs}:${stats.size}`;
      let kept = this.#infos.get(id);
      if (kept?.signature !== signature) {
        kept = { signature, info: this.#readPack(path, id, stats.size) };
        this.#infos.set(id, kept);
      }
      found.push(kept.info);
    }
    for (const id of [...this.#infos.keys()]) if (!seen.has(id)) this.#infos.delete(id);
    return found;
  }

  /** The packs that can be searched: made by this version of the builder, of a kind the app knows. */
  ready(): PackInfo[] {
    return this.#list().filter((pack) => pack.state === 'ready');
  }

  state(): PacksState {
    const refused = this.#inspect();
    const job = this.#job;
    const shown =
      job !== null && (job.endedAt === null || this.#now() - job.endedAt < JOB_SHOWN_MS)
        ? job
        : null;
    return {
      root: this.root,
      freeBytes: this.#freeBytesOfRoot(),
      packs: refused.state === 'refused' ? [] : this.#list(),
      job:
        shown !== null
          ? {
              id: shown.id,
              title: shown.title,
              phase: shown.phase,
              doneBytes: shown.doneBytes,
              totalBytes: shown.totalBytes,
              rows: shown.rows,
              message: shown.message,
            }
          : refused.state === 'refused'
            ? {
                id: '',
                title: 'Packs folder',
                phase: 'failed',
                doneBytes: 0,
                totalBytes: null,
                rows: 0,
                message: refused.message,
              }
            : null,
    };
  }

  // ---- searching -----------------------------------------------------------

  /** Searches one pack. Rejects when the pack is not one that can be searched, or the search is given up. */
  async search(
    id: string,
    q: SearchQuery,
    signal: AbortSignal,
  ): Promise<{ rows: Record<string, string>[]; total: number }> {
    if (!PACK_ID_PATTERN.test(id) || !this.ready().some((pack) => pack.id === id)) {
      throw new PackError('This pack is not installed.');
    }
    return this.#search.search(id, q, signal);
  }

  /** The pack that is ready, or a `PackError` when it is not one that can be read. */
  #readable(id: string): void {
    if (!PACK_ID_PATTERN.test(id) || !this.ready().some((pack) => pack.id === id)) {
      throw new PackError('This pack is not installed.');
    }
  }

  /** The values of a column of a pack, each with how many rows hold it. */
  async distinct(
    id: string,
    q: DistinctQuery,
    signal: AbortSignal,
  ): Promise<{ value: string; count: number }[]> {
    this.#readable(id);
    return this.#search.distinct(id, q, signal);
  }

  /** Some columns of some rows of a pack, each with its row number. */
  async list(
    id: string,
    q: ListQuery,
    signal: AbortSignal,
  ): Promise<{ rows: { rowid: number; values: Record<string, string> }[]; total: number }> {
    this.#readable(id);
    return this.#search.list(id, q, signal);
  }

  /** Some columns of one row of a pack, by its row number. */
  async get(
    id: string,
    q: GetQuery,
    signal: AbortSignal,
  ): Promise<{ rowid: number; values: Record<string, string> } | null> {
    this.#readable(id);
    return this.#search.get(id, q, signal);
  }

  /**
   * Asks to be told, with the pack's id, when a pack's file is about to be
   * replaced or deleted: whatever is reading it from outside the search worker
   * (an image being fetched for a district of it) is to let go.
   */
  whenLeaving(listener: (id: string) => void): void {
    this.#leaving.push(listener);
  }

  /**
   * A number that changes whenever a pack's file is about to be replaced or
   * deleted, and again once that is done. A reader that sees the same number
   * before and after a read knows both reads were of one file.
   */
  generationOf(id: string): number {
    return this.#generations.get(id) ?? 0;
  }

  #bump(id: string): void {
    this.#generations.set(id, this.generationOf(id) + 1);
  }

  #leave(id: string): void {
    this.#bump(id);
    for (const listener of this.#leaving) {
      try {
        listener(id);
      } catch {
        // A listener that fails must not keep a pack from being replaced or removed.
      }
    }
  }

  // ---- installing ----------------------------------------------------------

  #validate(spec: PackInstallSpec): void {
    const text = (value: unknown, max: number, what: string) => {
      if (typeof value !== 'string' || value === '' || value.length > max) {
        throw new PackError(`The pack's ${what} is missing or too long.`);
      }
    };
    if (typeof spec.id !== 'string' || !PACK_ID_PATTERN.test(spec.id)) {
      throw new PackError('The pack id is not valid.');
    }
    const kind = PACK_KINDS[spec.kind];
    if (kind === undefined)
      throw new PackError(`This app builds no packs of the kind ${spec.kind}.`);
    text(spec.title, 300, 'title');
    text(spec.sourceName, 300, 'source name');
    text(spec.sourceUrl, 2000, 'source address');
    text(spec.licence, 500, 'licence');
    text(spec.credit, 500, 'credit line');
    if (!Array.isArray(spec.files) || spec.files.length < 1 || spec.files.length > 200) {
      throw new PackError('A pack needs between 1 and 200 files.');
    }
    for (const file of spec.files) {
      let url: URL;
      try {
        url = new URL(file.url);
      } catch {
        throw new PackError('A file address is not valid.');
      }
      const test = this.#testHosts.hosts.includes(url.hostname);
      const secure = url.protocol === 'https:' || (test && this.#testHosts.insecure);
      if (!secure) throw new PackError('Files are downloaded over https only.');
      if (url.username !== '' || url.password !== '') {
        throw new PackError('A file address may not hold a user name or password.');
      }
      if (url.port !== '' && !test) throw new PackError('A file address may not name a port.');
      if (!kind.allowedHosts.includes(url.hostname) && !test) {
        throw new PackError(`Files of this kind are not downloaded from ${url.hostname}.`);
      }
    }
  }

  /**
   * Starts installing a pack, or replacing the one of that id, unless a job
   * is under way. Returns at once; {@link state} says how far it is. A pack
   * that is there stays in use until the new one is complete and checked.
   * Throws a `PackError` when the request is not one the app takes.
   */
  install(spec: PackInstallSpec): void {
    this.#validate(spec);
    if (this.#job !== null && this.#job.endedAt === null) {
      throw new PackError('Another pack is being installed. Wait for it, or cancel it.');
    }
    if (this.#removing.has(spec.id)) throw new PackError('This pack is being removed.');
    const refused = this.#prepare();
    if (refused !== null) throw new PackError(refused);
    const job: Job = {
      id: spec.id,
      title: spec.title,
      phase: 'checking',
      doneBytes: 0,
      totalBytes: null,
      rows: 0,
      message: null,
      abort: new AbortController(),
      build: null,
      done: Promise.resolve(),
      endedAt: null,
    };
    this.#job = job;
    job.done = this.#run(job, spec).then(
      () => undefined,
      () => undefined,
    );
  }

  /** True while a job is under way. */
  get running(): boolean {
    return this.#job !== null && this.#job.endedAt === null;
  }

  /** Gives up the job that is under way; what it made so far is deleted. */
  cancel(): PackActionResult {
    const job = this.#job;
    if (job === null || job.endedAt !== null) {
      return { ok: false, message: 'No pack is being installed.' };
    }
    if (job.phase === 'switching') {
      return { ok: false, message: 'The pack is being put in place; that cannot be stopped now.' };
    }
    job.abort.abort();
    job.build?.stop();
    return { ok: true };
  }

  /** Resolves when no job is under way. */
  async idle(): Promise<void> {
    while (this.#job !== null && this.#job.endedAt === null) await this.#job.done;
  }

  /** For when the app quits: gives up a job, waits for it to clean up, and ends the search worker. */
  async shutdown(waitMs = SHUTDOWN_WAIT_MS): Promise<void> {
    const working = this.running;
    this.cancel();
    if (working) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.idle(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await this.#search.dispose();
  }

  async #remoteLength(job: Job, spec: PackInstallSpec): Promise<number | null> {
    let total = 0;
    for (const file of spec.files) {
      const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(this.#stallMs)]);
      let length: number | null = null;
      try {
        const response = await this.#fetch(file.url, {
          signal,
          redirect: 'error',
          credentials: 'omit',
          method: 'HEAD',
          headers: { 'user-agent': this.#userAgent },
        });
        const header = response.headers.get('content-length')?.trim() ?? '';
        const packed = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
        if (response.ok && !packed && /^\d{1,15}$/.test(header)) length = Number(header);
        void response.body?.cancel().catch(() => undefined);
      } catch {
        if (job.abort.signal.aborted) throw new BuildStopped();
      }
      if (length === null) return null;
      total += length;
    }
    return total;
  }

  async #run(job: Job, spec: PackInstallSpec): Promise<void> {
    const kind = PACK_KINDS[spec.kind];
    const root = this.root;
    const id = spec.id;
    const work = join(root, `work-${id}`);
    const newFile = join(root, `${id}${PACK_FILE_SUFFIX}.new`);
    const lock = join(root, PACKS_LOCK);
    const signal = job.abort.signal;
    // Whether this job holds the lock; only then is anything of the job's cleaned up.
    let locked = false;
    try {
      if (kind === undefined) throw new PackError('This pack kind is not known.');
      this.#takeLock(lock);
      locked = true;
      this.#removeLeftovers(work, newFile);

      // Is there room? A pack takes some times the size of its files, as its kind says.
      const total = await this.#remoteLength(job, spec);
      job.totalBytes = total;
      this.#requireRoom((total ?? 0) * kind.spaceFactor + this.#reserve);
      signal.throwIfAborted();

      const folder = lstatOrNull(work);
      if (folder !== null && (folder.isSymbolicLink() || !folder.isDirectory())) {
        throw new PackError(
          'The work folder of this pack is not a plain folder, so it was not used.',
        );
      }
      mkdirSync(work, { recursive: true });
      job.phase = 'downloading';
      const files: Downloaded[] = [];
      for (const [index, file] of spec.files.entries()) {
        files.push(await this.#download(job, kind.maxFileBytes, file, join(work, `file${index}`)));
      }
      const downloadedAt = new Date(this.#now()).toISOString().slice(0, 10);
      signal.throwIfAborted();
      // Without sizes from the source, the room is looked at again with the real ones.
      if (total === null) {
        const actual = files.reduce((sum, file) => sum + file.bytes, 0);
        this.#requireRoom(actual * kind.spaceFactor + this.#reserve);
      }

      job.phase = 'building';
      const input: BuildInput = {
        kind: spec.kind,
        outPath: newFile,
        files,
        meta: {
          packId: id,
          title: spec.title,
          sourceName: spec.sourceName,
          sourceUrl: spec.sourceUrl,
          licence: spec.licence,
          credit: spec.credit,
          downloadedAt,
          ...(spec.sourceModified !== undefined && DAY.test(spec.sourceModified)
            ? { sourceModified: spec.sourceModified }
            : {}),
        },
        reserveBytes: this.#reserve,
      };
      const build = this.#build(input, (rows) => {
        job.rows = rows;
      });
      job.build = build;
      if (signal.aborted) build.stop();
      // Settles when nothing of the build can write any more.
      await build.promise;
      job.build = null;

      // The new pack must be a pack of this id and kind, with records in it,
      // before it takes the place of the one in use.
      const opened = PackReader.open(newFile);
      if (!opened.ok) throw new PackError('The new pack failed its check, so it was not used.');
      const meta = opened.reader.meta;
      opened.reader.close();
      if (meta.packId !== id || meta.kind !== spec.kind || meta.rows < 1) {
        throw new PackError('The new pack failed its check, so it was not used.');
      }
      signal.throwIfAborted();

      job.phase = 'switching';
      await this.#swap(id);
      job.rows = meta.rows;
      job.phase = 'done';
    } catch (error) {
      if (signal.aborted || error instanceof BuildStopped) {
        job.phase = 'cancelled';
        job.message = null;
      } else {
        job.phase = 'failed';
        job.message = error instanceof PackError ? error.message : this.#describe(error);
      }
    } finally {
      // The build has ended, one way or the other, before this runs.
      job.build = null;
      if (locked) {
        this.#removeLeftovers(work, newFile);
        const lockStats = lstatOrNull(lock);
        if (lockStats?.isFile() === true && !lockStats.isSymbolicLink())
          rmSync(lock, { force: true });
      }
      job.endedAt = this.#now();
    }
  }

  /** Throws unless `need` bytes are free on the drive of the packs folder. */
  #requireRoom(need: number): void {
    const free = this.#freeBytes(this.root);
    if (free !== null && free < need) {
      throw new PackError(
        `There is not enough free space: about ${Math.ceil(need / MB).toLocaleString('en-US')} MB are needed and ${Math.floor(free / MB).toLocaleString('en-US')} MB are free.`,
      );
    }
  }

  /**
   * Takes the job lock. A link or anything but a plain file in its place is
   * refused and left alone; a lock of another process that is running is
   * refused; our own stale one is removed first, and the new one is made with
   * the exclusive flag so that nothing is overwritten.
   */
  #takeLock(lock: string): void {
    const stats = lstatOrNull(lock);
    if (stats !== null) {
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new PackError(
          'The job lock in the packs folder is not a plain file, so nothing was installed.',
        );
      }
      if (this.#lockIsLive(lock)) {
        throw new PackError('Another copy of the app is working on packs.');
      }
      rmSync(lock, { force: true });
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: this.#now() }), {
      flag: 'wx',
    });
  }

  #describe(error: unknown): string {
    const message = messageOf(error);
    return `The pack could not be made: ${message}`;
  }

  /** Deletes a job's work folder and its unfinished pack, whichever of them is there; links are left alone. */
  #removeLeftovers(work: string, newFile: string): void {
    try {
      clearWorkFolder(work);
      const file = lstatOrNull(newFile);
      if (file !== null && !file.isSymbolicLink() && file.isFile()) {
        rmSync(newFile, { force: true, maxRetries: 3, retryDelay: 100 });
      }
    } catch {
      // What stays is swept at the next start.
    }
  }

  async #download(
    job: Job,
    maxBytes: number,
    expected: { url: string } & Expected,
    path: string,
  ): Promise<Downloaded> {
    const url = expected.url;
    const user = job.abort.signal;
    // Given up as well when nothing arrives for a long time.
    const stall = new AbortController();
    const signal = AbortSignal.any([user, stall.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), this.#stallMs);
    };
    const name = new URL(url).pathname.split('/').pop() ?? 'a file';
    const hash = createHash('sha256');
    let fd: number | undefined;
    try {
      watch();
      const response = await this.#fetch(url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        method: 'GET',
        headers: { 'user-agent': this.#userAgent },
      });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let announced = Number.NaN;
      let received = 0;
      let sinceLook = 0;
      try {
        if (!response.ok)
          throw new PackError(`The source answered ${response.status} for ${name}.`);
        // No redirect is followed; should one be all the same, the file must
        // still come from the host that was asked.
        if (response.url !== '' && new URL(response.url).host !== new URL(url).host) {
          throw new PackError(`${name} was sent from somewhere else than where it was asked for.`);
        }
        // A file that is not the one that was listed (by its ETag) is refused
        // before anything is read of it.
        if (
          typeof expected.etag === 'string' &&
          response.headers.get('etag')?.trim() !== expected.etag
        ) {
          throw new PackError(CHANGED_MESSAGE);
        }
        const packed = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
        const length = response.headers.get('content-length')?.trim() ?? '';
        if (!packed && /^\d{1,15}$/.test(length)) announced = Number(length);
        if (
          expected.bytes !== undefined &&
          Number.isFinite(announced) &&
          announced !== expected.bytes
        ) {
          throw new PackError(CHANGED_MESSAGE);
        }
        if (announced > maxBytes) throw new PackError(`${name} is larger than it should be.`);
        reader = response.body?.getReader();
        if (!reader) throw new PackError(`The source sent nothing for ${name}.`);
        fd = openSync(path, 'wx');
        for (;;) {
          watch();
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > maxBytes) throw new PackError(`${name} is larger than it should be.`);
          if (expected.bytes !== undefined && received > expected.bytes) {
            throw new PackError(CHANGED_MESSAGE);
          }
          hash.update(value);
          for (let written = 0; written < value.length;) {
            written += writeSync(fd, value, written, value.length - written);
          }
          job.doneBytes += value.length;
          if (Number.isNaN(announced)) {
            sinceLook += value.length;
            if (sinceLook >= RECHECK_BYTES) {
              sinceLook = 0;
              const free = this.#freeBytes(dirname(path));
              if (free !== null && free < this.#reserve) {
                throw new PackError('The disk is nearly full, so the download was stopped.');
              }
            }
          }
        }
      } catch (error) {
        // Lets go of the connection, whether or not reading had begun.
        void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => undefined);
        throw error;
      }
      if (Number.isFinite(announced) && received !== announced) {
        throw new PackError(`The download of ${name} ended before it was complete.`);
      }
      if (received === 0) throw new PackError(`The source sent nothing for ${name}.`);
      if (expected.bytes !== undefined && received !== expected.bytes) {
        throw new PackError(CHANGED_MESSAGE);
      }
      return {
        path,
        url,
        bytes: received,
        sha256: hash.digest('hex'),
        etag: response.headers.get('etag'),
        modified: response.headers.get('last-modified'),
      };
    } catch (error) {
      if (user.aborted) throw error;
      if (stall.signal.aborted) {
        throw new PackError(
          `The download of ${name} stopped; check the internet connection and try again.`,
        );
      }
      if (error instanceof PackError) throw error;
      throw new PackError(
        `${name} could not be downloaded (${messageOf(error)}); check the internet connection and try again.`,
      );
    } finally {
      clearTimeout(timer);
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Tries something with a file that may be in use for a moment (a virus scanner, a search), five times over about a second. */
  async #retry(run: () => void): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await sleep(this.#retryMs);
      try {
        run();
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  /**
   * Puts the new file in the place of the one in use. The searches of the
   * pack wait, and the search worker lets go of its file, while the files are
   * renamed. The old pack is put back when anything fails.
   */
  async #swap(id: string): Promise<void> {
    const pack = this.pathOf(id);
    const old = `${pack}.old`;
    const fresh = `${pack}.new`;
    this.#leave(id);
    await this.#search.hold(id);
    try {
      const plain = (stats: Stats | null) =>
        stats !== null && stats.isFile() && !stats.isSymbolicLink();
      const current = lstatOrNull(pack);
      if (current !== null && !plain(current)) {
        throw new PackError(
          'The pack file in the packs folder is not a plain file, so it was not replaced.',
        );
      }
      const stale = lstatOrNull(old);
      if (stale !== null && !plain(stale)) {
        throw new PackError(
          'A leftover of an earlier replacement is not a plain file, so the pack was not replaced.',
        );
      }
      if (stale !== null) {
        // When the pack is missing, the old file is the only copy: put it back, never delete it.
        if (current === null) await this.#retry(() => renameSync(old, pack));
        else await this.#retry(() => unlinkSync(old));
      }
      let moved = false;
      try {
        if (lstatOrNull(pack) !== null) {
          await this.#retry(() => renameSync(pack, old));
          moved = true;
        }
        await this.#retry(() => renameSync(fresh, pack));
        const again = PackReader.open(pack);
        if (!again.ok) throw new PackError('The new pack could not be opened once in place.');
        again.reader.close();
      } catch (error) {
        if (moved) {
          try {
            if (lstatOrNull(pack) !== null) await this.#retry(() => rmSync(pack, { force: true }));
          } catch {
            // The failed file stays in the pack's place: call it a leftover, so that
            // the sweep deletes it and puts the old file back.
            try {
              renameSync(pack, fresh);
            } catch {
              // Nothing more can be done now.
            }
          }
          try {
            await this.#retry(() => renameSync(old, pack));
          } catch {
            // The old file stays; the sweep at the next start puts it back.
          }
        }
        throw error;
      }
      this.#infos.delete(id);
      if (moved) {
        try {
          await this.#retry(() => unlinkSync(old));
        } catch {
          // The new pack is in use; the old file is swept at the next start.
        }
      }
    } finally {
      this.#bump(id);
      this.#search.release(id);
    }
  }

  // ---- removing ------------------------------------------------------------

  /**
   * Deletes a pack from this PC. The searches of it are stopped and the
   * search worker lets go of the file first. Citations made from it stay in
   * the trees. Refused while a job for the same pack runs.
   */
  async remove(id: string): Promise<PackActionResult> {
    if (typeof id !== 'string' || !PACK_ID_PATTERN.test(id)) {
      return { ok: false, message: 'This is not the id of a pack.' };
    }
    const found = this.#inspect();
    if (found.state !== 'ok') {
      return {
        ok: false,
        message: found.state === 'refused' ? found.message : 'This pack is not installed.',
      };
    }
    if (this.#job !== null && this.#job.endedAt === null && this.#job.id === id) {
      return { ok: false, message: 'This pack is being installed. Cancel that first.' };
    }
    if (this.#removing.has(id)) return { ok: false, message: 'This pack is being removed.' };
    const path = this.pathOf(id);
    const stats = lstatOrNull(path);
    if (stats === null || !stats.isFile() || stats.isSymbolicLink()) {
      return { ok: false, message: 'This pack is not installed.' };
    }
    this.#removing.add(id);
    try {
      this.#leave(id);
      await this.#search.hold(id);
      try {
        await this.#retry(() => unlinkSync(path));
      } catch {
        return {
          ok: false,
          message:
            'The pack file could not be deleted; another program may be using it. Try again.',
        };
      } finally {
        this.#bump(id);
        this.#search.release(id);
      }
      this.#infos.delete(id);
      return { ok: true };
    } finally {
      this.#removing.delete(id);
    }
  }
}
