import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { getSetting, setSetting, type Db } from '@rulz/db';
import { z } from 'zod';
import type {
  UpdateMethod,
  UpdateOutcome,
  UpdatePhase,
  UpdateResult,
  UpdateState,
} from '../shared/updates';
import type { HandlerTable } from './handlers';

export type UpdateHandlers = Pick<HandlerTable, UpdateMethod>;
export const FEED =
  'https://github.com/speedyrulz/rulz-kinspora/releases/latest/download/latest.yml';
const SETTING = 'update.startup';
const DISMISSED = 'update.dismissed';
/** The version an install was started for; read at the next start to tell whether it worked. */
const PENDING = 'update.pending';
const REPO = 'https://github.com/speedyrulz/rulz-kinspora/releases';
const TEMP_PREFIX = 'rulz-kinspora-update-';
/** The folder names this app makes: the prefix and 24 lowercase hex characters. Nothing else is swept. */
const TEMP_NAME = /^rulz-kinspora-update-[0-9a-f]{24}$/;
/** The address the installer comes from; GitHub then redirects to a host named by `githubHost`. */
export const RELEASE_DOWNLOAD_HOST = 'github.com';
/** The hosts of GitHub's release files, all under this name. */
export const RELEASE_FILE_HOST = 'githubusercontent.com';
const UNINSTALLER = 'Uninstall RulZ Kinspora.exe';
/** No installer of this app comes near this; a larger one in the feed is refused. */
const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const INSTALLER_ARGS = ['--updated', '/S', '--force-run'];
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function compareVersions(a: string, b: string): number | null {
  const x = semver.exec(a),
    y = semver.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const n = BigInt(x[i]!),
      m = BigInt(y[i]!);
    if (n !== m) return n > m ? 1 : -1;
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const xs = x[4].split('.'),
    ys = y[4].split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i],
      q = ys[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

/** What the feed says of the installer: checked, so that nothing else of the feed is trusted. */
export interface Installer {
  version: string;
  /** The 64 bytes of the installer's SHA-512. */
  sha512: Buffer;
  size: number;
}

function unquote(value: string): string {
  const v = value.trim();
  const q = v[0];
  return v.length >= 2 && (q === "'" || q === '"') && v.endsWith(q) ? v.slice(1, -1) : v;
}

/**
 * Reads the installer's name, SHA-512 and size from the `latest.yml` electron-builder writes: the
 * top-level `path` and `sha512`, and the entry of `files` whose `url` is that path. Null when
 * anything is missing, doubled, malformed or out of range. The path must be exactly the name this
 * app's installer has; it is never used as a path or an address, only compared.
 */
export function parseInstaller(text: string, version: string): Installer | null {
  const top = new Map<string, string>();
  const entries: Map<string, string>[] = [];
  let inFiles = false;
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const m = /^([A-Za-z][\w-]*):(.*)$/.exec(raw);
      inFiles = false;
      current = undefined;
      if (!m) continue;
      const key = m[1]!;
      if (key === 'files') {
        inFiles = true;
      } else if (key === 'path' || key === 'sha512') {
        if (top.has(key)) return null;
        top.set(key, unquote(m[2]!));
      }
      continue;
    }
    if (!inFiles) continue;
    const start = /^\s*-\s+([A-Za-z][\w-]*):(.*)$/.exec(raw);
    if (start) {
      current = new Map([[start[1]!, unquote(start[2]!)]]);
      entries.push(current);
      continue;
    }
    const field = /^\s+([A-Za-z][\w-]*):(.*)$/.exec(raw);
    if (field && current) {
      if (current.has(field[1]!)) return null;
      current.set(field[1]!, unquote(field[2]!));
    }
  }
  const path = top.get('path');
  const sha = top.get('sha512');
  if (path !== `RulZ-Kinspora-Setup-${version}.exe` || sha === undefined) return null;
  const matching = entries.filter((entry) => entry.get('url') === path);
  if (matching.length !== 1) return null;
  const entry = matching[0]!;
  const size = entry.get('size');
  if (entry.get('sha512') !== sha || size === undefined || !/^[1-9]\d{0,15}$/.test(size)) {
    return null;
  }
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_INSTALLER_BYTES) return null;
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha)) return null;
  const decoded = Buffer.from(sha, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== sha) return null;
  return { version, sha512: decoded, size: bytes };
}

/**
 * Whether this is the copy the installer put on the PC: the NSIS uninstaller sits beside the
 * executable, in a folder under %LOCALAPPDATA%\Programs. A development build and the unpacked
 * folder the packaged tests run are not, and must never start an installer.
 */
export function isInstalledCopy(
  execPath: string,
  localAppData: string,
  exists: (path: string) => boolean,
): boolean {
  if (localAppData.trim() === '') return false;
  const dir = win32.dirname(win32.resolve(execPath));
  const inside = win32.relative(win32.resolve(localAppData, 'Programs'), dir);
  const under = inside !== '' && !inside.startsWith('..') && !win32.isAbsolute(inside);
  return under && exists(win32.join(dir, UNINSTALLER));
}

/** The folder operations the download needs, so a test can stand in for the disk. */
export interface UpdateFiles {
  /** Makes a folder that must not exist yet. */
  makeDir(path: string): void;
  create(
    path: string,
  ): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }>;
  /** Removes a file or folder; nothing is thrown when it is not there. */
  remove(path: string): void;
  list(path: string): string[];
  /** The SHA-512 of the file as it is on disk now. */
  hash(path: string): Promise<Buffer>;
}
const realFiles: UpdateFiles = {
  makeDir: (path) => void mkdirSync(path),
  create: async (path) => {
    const handle = await openFile(path, 'wx');
    return {
      write: (chunk) => handle.writeFile(chunk),
      close: () => handle.close(),
    };
  },
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  list: (path) => readdirSync(path),
  hash: async (path) => {
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest();
  },
};

/** A reason in words for the user; any other error is shown as the general one. */
class UpdateError extends Error {}

/** Waits for the promise, or fails at once when the signal is aborted (a body that stalls ignores it). */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('aborted'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const githubHost = (host: string) =>
  host === RELEASE_DOWNLOAD_HOST || host.endsWith(`.${RELEASE_FILE_HOST}`);

interface Run {
  abort: AbortController;
  idle: boolean;
  /** Set when the user, not the app closing, gave the update up. */
  cancelled: boolean;
}

interface Options {
  db: Db;
  version: string;
  packaged: boolean;
  feed?: string;
  busy: () => boolean;
  fetch: typeof fetch;
  open: (url: string) => Promise<unknown>;
  timeoutMs?: number;
  clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /** Where the installer may be downloaded and started from; false in a development build or an unpacked folder. */
  installable?: () => boolean;
  /** The folder that holds the throwaway folder of a download (the temp folder). */
  tempDir?: string;
  files?: UpdateFiles;
  random?: () => string;
  /** Milliseconds without a byte after which a download is given up. */
  idleMs?: number;
  /** Milliseconds between looks at whether an import or a pack install has ended. */
  waitMs?: number;
  /** Shutdown work that must be done before the installer is started: backing up the open tree. */
  prepare?: () => void;
  /** Starts the installer, detached. Throws, or returns no pid, when it could not start. */
  spawn?: (file: string, args: string[]) => { pid?: number | undefined };
  /** Quits the app, normally, so the rest of the shutdown runs. */
  quit?: () => void;
}
export class UpdateService {
  private available: string | null = null;
  private installer: Installer | null = null;
  private checking = false;
  private stopped = false;
  private controller: AbortController | undefined;
  private phase: UpdatePhase = 'idle';
  private percent: number | null = null;
  private failure: string | null = null;
  private outcome: UpdateOutcome | null = null;
  private run: Run | undefined;
  private file: string | undefined;
  private canInstall: boolean | undefined;
  constructor(private readonly options: Options) {}
  state(): UpdateState {
    this.canInstall ??= this.options.installable?.() === true;
    return {
      startup: getSetting(this.options.db, SETTING) !== 'off',
      version: this.available,
      phase: this.phase,
      percent: this.phase === 'downloading' ? this.percent : null,
      canInstall: this.canInstall,
      failure: this.phase === 'failed' ? this.failure : null,
      outcome: this.outcome,
    };
  }
  /** True from the moment the installer is started: no import, pack install or AI session may begin. */
  get installing(): boolean {
    return this.phase === 'installing';
  }
  /**
   * Run once at startup: removes the folders of downloads an earlier run left, and tells whether
   * the update the last run started has been installed. The marker is cleared either way.
   */
  start(): void {
    const files = this.options.files ?? realFiles;
    const temp = this.options.tempDir;
    if (temp !== undefined) {
      let names: string[] = [];
      try {
        names = files.list(temp);
      } catch {
        // A folder that cannot be listed is left for the next start.
      }
      for (const name of names) {
        if (!TEMP_NAME.test(name)) continue;
        try {
          files.remove(join(temp, name));
        } catch {
          // One that is locked does not stop the rest.
        }
      }
    }
    const pending = getSetting(this.options.db, PENDING);
    if (pending === null) return;
    setSetting(this.options.db, PENDING, null);
    const comparison = compareVersions(pending, this.options.version);
    if (comparison === 0) this.outcome = { kind: 'updated', version: pending };
    else if (comparison !== null && comparison > 0) {
      this.outcome = { kind: 'not-installed', version: pending };
    }
  }
  setStartup(enabled: boolean): void {
    setSetting(this.options.db, SETTING, enabled ? 'on' : 'off');
  }
  /** The notice of what the last update left has been seen. */
  acknowledge(): void {
    this.outcome = null;
  }
  dismiss(): void {
    if (this.active()) return;
    if (this.available) setSetting(this.options.db, DISMISSED, this.available);
    this.available = null;
    this.installer = null;
    if (this.phase !== 'installing') this.phase = 'idle';
  }
  async open(): Promise<void> {
    // After an update that did not install, the page of that version, even before a check ran.
    const version =
      this.available ?? (this.outcome?.kind === 'not-installed' ? this.outcome.version : null);
    if (version !== null && semver.test(version))
      await this.options.open(`${REPO}/tag/v${version}`);
  }
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    // Our own quit after the installer has been started must leave the file for it.
    if (this.phase === 'installing') return;
    this.run?.abort.abort();
    if (this.run === undefined) this.dropFile();
  }
  /** Gives up a download or a wait. The partial or checked file is deleted. */
  cancel(): void {
    const run = this.run;
    if (run && this.phase !== 'installing') {
      run.cancelled = true;
      run.abort.abort();
    } else if (this.phase === 'verified' || this.phase === 'failed') {
      this.dropFile();
      this.phase = 'idle';
      this.failure = null;
    }
  }
  private active(): boolean {
    return this.phase === 'downloading' || this.phase === 'waiting' || this.phase === 'installing';
  }
  private dropFile(): void {
    const file = this.file;
    this.file = undefined;
    if (file === undefined) return;
    try {
      (this.options.files ?? realFiles).remove(dirname(file));
    } catch {
      // The next start sweeps what is left.
    }
  }
  /** Fetches with manual redirects: at most `maxRedirects`, and each hop must pass `allowed`. The first address is the caller's to check. */
  private async follow(
    start: URL,
    signal: AbortSignal,
    maxRedirects: number,
    allowed: (url: URL) => boolean,
  ): Promise<Response> {
    let url = start;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      response = await this.options.fetch(url.toString(), { redirect: 'manual', signal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location || redirects === maxRedirects) throw new Error('Invalid redirect');
      url = new URL(location, url);
      if (!allowed(url)) throw new Error('Invalid redirect');
    }
    if (!response?.ok || !response.body) throw new Error('Unavailable');
    return response;
  }
  /** Downloads, checks and (in an installed copy) installs the newer version. Progress is in {@link state}. */
  async install(): Promise<void> {
    const installer = this.installer;
    if (this.checking && !this.stopped) {
      this.fail('A check for a new version is running. Try again in a moment.');
      return;
    }
    if (this.stopped || this.active() || this.phase === 'verified') return;
    if (this.available === null || installer?.version !== this.available) {
      if (this.available !== null)
        this.fail('This release has no installer details that can be checked.');
      return;
    }
    const run: Run = { abort: new AbortController(), idle: false, cancelled: false };
    this.run = run;
    this.phase = 'downloading';
    this.percent = 0;
    this.failure = null;
    const clock = this.options.clock ?? { setTimeout, clearTimeout };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clock.clearTimeout(idleTimer);
      idleTimer = clock.setTimeout(() => {
        run.idle = true;
        run.abort.abort();
      }, this.options.idleMs ?? 60_000);
    };
    let handle: Awaited<ReturnType<UpdateFiles['create']>> | undefined;
    let installStarted = false;
    try {
      const files = this.options.files ?? realFiles;
      const temp = this.options.tempDir;
      if (temp === undefined) throw new Error('No temp folder');
      const { version } = installer;
      const feedUrl = new URL(this.options.packaged ? FEED : this.options.feed || FEED);
      const local = !this.options.packaged && Boolean(this.options.feed);
      const url = local
        ? new URL(`RulZ-Kinspora-Setup-${version}.exe`, feedUrl)
        : new URL(`${REPO}/download/v${version}/RulZ-Kinspora-Setup-${version}.exe`);
      const dir = join(
        temp,
        `${TEMP_PREFIX}${(this.options.random ?? (() => randomBytes(12).toString('hex')))()}`,
      );
      if (
        url.protocol !== 'https:' &&
        !(local && url.protocol === 'http:' && url.hostname === '127.0.0.1')
      ) {
        throw new Error('Invalid download address');
      }
      files.makeDir(dir);
      const file = join(dir, `RulZ-Kinspora-Setup-${version}.exe`);
      this.file = file;
      handle = await files.create(file);
      touch();
      const response = await this.follow(
        url,
        run.abort.signal,
        5,
        (u) => u.protocol === 'https:' && githubHost(u.hostname),
      );
      const reader = response.body!.getReader();
      const hash = createHash('sha512');
      let received = 0;
      try {
        while (true) {
          const part = await until(reader.read(), run.abort.signal);
          if (part.done) break;
          touch();
          received += part.value.length;
          if (received > installer.size) {
            throw new UpdateError(
              'The download was larger than the release says, so it was stopped.',
            );
          }
          hash.update(part.value);
          await handle.write(part.value);
          this.percent = Math.floor((received / installer.size) * 100);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      clock.clearTimeout(idleTimer);
      if (received !== installer.size) {
        throw new UpdateError('The download was shorter than the release says, so it was deleted.');
      }
      await handle.close();
      handle = undefined;
      const digest = hash.digest();
      if (digest.length !== installer.sha512.length || !timingSafeEqual(digest, installer.sha512)) {
        throw new UpdateError('The downloaded file did not match the release, so it was deleted.');
      }
      run.abort.signal.throwIfAborted();
      this.percent = 100;
      if (this.canInstall === undefined) this.canInstall = this.options.installable?.() === true;
      if (!this.canInstall) {
        this.phase = 'verified';
        return;
      }
      // Busy again after the long download: wait, and say so. Then the file is read from disk once
      // more, so that a change made while it lay there is caught; that takes time, so busy is
      // looked at again afterwards.
      while (true) {
        while (this.options.busy()) {
          run.abort.signal.throwIfAborted();
          this.phase = 'waiting';
          await this.sleep(this.options.waitMs ?? 5000, run.abort.signal);
        }
        const again = await files.hash(file);
        run.abort.signal.throwIfAborted();
        if (again.length !== installer.sha512.length || !timingSafeEqual(again, installer.sha512)) {
          throw new UpdateError(
            'The downloaded file changed before it was run, so it was deleted.',
          );
        }
        if (!this.options.busy()) break;
      }
      // From here to the quit nothing yields, so nothing can begin in between.
      this.phase = 'installing';
      installStarted = true;
      setSetting(this.options.db, PENDING, version);
      try {
        try {
          this.options.prepare?.();
        } catch {
          throw new UpdateError('The tree could not be backed up, so the update was not started.');
        }
        const child = this.options.spawn?.(file, INSTALLER_ARGS);
        if (!child?.pid) throw new Error('The installer did not start.');
      } catch (error) {
        setSetting(this.options.db, PENDING, null);
        installStarted = false;
        if (error instanceof UpdateError) throw error;
        throw new UpdateError(
          error instanceof Error && error.message === 'The installer did not start.'
            ? 'The installer could not be started.'
            : 'The update could not be started.',
        );
      }
      this.options.quit?.();
    } catch (error) {
      this.phase = 'idle';
      if (run.cancelled || (run.abort.signal.aborted && !run.idle)) {
        this.failure = null;
      } else {
        this.fail(
          run.idle
            ? 'The download stalled and was stopped.'
            : error instanceof UpdateError
              ? error.message
              : 'The update could not be downloaded.',
        );
      }
    } finally {
      clock.clearTimeout(idleTimer);
      await handle?.close().catch(() => undefined);
      this.run = undefined;
      if (!installStarted && this.phase !== 'verified') this.dropFile();
      else if (this.stopped && this.phase === 'verified') this.dropFile();
    }
  }
  private fail(message: string): void {
    this.phase = 'failed';
    this.failure = message;
  }
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    const clock = this.options.clock ?? { setTimeout, clearTimeout };
    return new Promise((resolve) => {
      const done = () => {
        clock.clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = clock.setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  async check(userStarted = false): Promise<UpdateResult> {
    if (this.stopped) return 'failed';
    if (this.checking || this.active() || this.options.busy()) return 'busy';
    this.checking = true;
    const controller = new AbortController();
    this.controller = controller;
    const clock = this.options.clock ?? { setTimeout, clearTimeout };
    const timer = clock.setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const url = new URL(this.options.packaged ? FEED : this.options.feed || FEED);
      // The first address is the feed (a test feed on this PC is allowed outside a packaged
      // build). A redirect may go only to GitHub's own hosts, as the installer download does.
      const first =
        url.protocol === 'https:' ||
        (!this.options.packaged && url.protocol === 'http:' && url.hostname === '127.0.0.1');
      if (!first) throw new Error('Invalid feed');
      const response = await this.follow(
        url,
        controller.signal,
        3,
        (u) => u.protocol === 'https:' && githubHost(u.hostname),
      );
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65_536) {
          await reader.cancel();
          throw new Error('Feed too large');
        }
        chunks.push(part.value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const lines = [...text.matchAll(/^version:\s*([^\s]+)\s*$/gm)];
      if (lines.length !== 1) throw new Error('Invalid feed');
      const version = lines[0]![1]!;
      const comparison = compareVersions(version, this.options.version);
      if (comparison === null) {
        this.available = null;
        throw new Error('Invalid version');
      }
      if (this.stopped) return 'failed';
      if (comparison <= 0) {
        this.available = null;
        this.installer = null;
        return 'current';
      }
      const dismissed = getSetting(this.options.db, DISMISSED);
      this.available =
        !userStarted && dismissed && (compareVersions(version, dismissed) ?? 1) <= 0
          ? null
          : version;
      this.installer = this.available === null ? null : parseInstaller(text, version);
      if (this.phase === 'failed' || this.phase === 'verified') {
        this.dropFile();
        this.phase = 'idle';
        this.failure = null;
      }
      return 'newer';
    } catch {
      return 'failed';
    } finally {
      clock.clearTimeout(timer);
      this.controller = undefined;
      this.checking = false;
    }
  }
}

/** Schedule a startup check, retrying busy checks for up to 30 minutes. */
export function scheduleStartupUpdate(service: UpdateService): () => void {
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      if (!service.state().startup) return;
      const result = await service.check();
      if (!stopped && result === 'busy' && ++attempts <= 30) {
        timer = setTimeout(() => void run(), 60_000);
      }
    } catch {
      // Startup checks fail silently, including when the app is closing.
    }
  };
  timer = setTimeout(() => void run(), 5000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    service.stop();
  };
}

export function createUpdateHandlers(service: UpdateService): UpdateHandlers {
  return {
    updateState: (...args) => {
      z.tuple([]).parse(args);
      return service.state();
    },
    checkUpdate: (...args) => {
      z.tuple([]).parse(args);
      return service.check(true);
    },
    setUpdateStartup: (...args) => {
      const [enabled] = z.tuple([z.boolean()]).parse(args);
      service.setStartup(enabled);
    },
    dismissUpdate: (...args) => {
      z.tuple([]).parse(args);
      service.dismiss();
    },
    openUpdate: (...args) => {
      z.tuple([]).parse(args);
      return service.open();
    },
    installUpdate: (...args) => {
      z.tuple([]).parse(args);
      // Progress and failure are in the state; the call itself answers at once.
      void service.install();
    },
    cancelUpdate: (...args) => {
      z.tuple([]).parse(args);
      service.cancel();
    },
    acknowledgeUpdate: (...args) => {
      z.tuple([]).parse(args);
      service.acknowledge();
    },
  };
}
