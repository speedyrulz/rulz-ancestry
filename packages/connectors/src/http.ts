import type { ConnectorManifest } from './manifest';

/**
 * The one way a connector reaches its source. A connector is handed a client
 * that is bound to its manifest, never `fetch` itself, so that it cannot ask
 * another host, ask more often than its source allows, or be led elsewhere by
 * an answer.
 *
 * Nothing here uses Electron or Node.js. The function that fetches, the clock
 * and the wait are handed in, so the tests run this as it is.
 */

/**
 * The part of `fetch` this needs. Electron's `net.fetch` and Node's own both
 * fit. `redirect: 'error'` makes an answer that points somewhere else fail.
 */
export type HttpFetch = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    /** No cookie is sent, and none that comes back is kept. */
    credentials: 'omit';
    /** The answer is not written to a cache on disk, and none is read from one. */
    cache: 'no-store';
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<Response>;

export type HttpErrorKind =
  /** The address is not one the source's manifest allows. Nothing was sent. */
  | 'address'
  /** The source asked for a pause, or the app's own limit is used up. Nothing was sent. */
  | 'paused'
  /** The caller gave the request up. */
  | 'cancelled'
  /** No answer came in time. */
  | 'timeout'
  /** The source could not be reached. */
  | 'network'
  /** The source answered with an error status. */
  | 'status'
  /** The answer was larger than allowed. */
  | 'too-large'
  /** The answer was not what was asked for (not JSON). */
  | 'format';

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  /** The HTTP status, for `status`. */
  readonly status: number | null;
  /** When the source may be asked again, in Unix milliseconds, for `paused`. */
  readonly retryAt: number | null;

  constructor(
    kind: HttpErrorKind,
    message: string,
    details: { status?: number; retryAt?: number } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = details.status ?? null;
    this.retryAt = details.retryAt ?? null;
  }
}

export interface HttpClientOptions {
  fetch: HttpFetch;
  /** Sent with every request. It names the app and its version, and nothing of the user. */
  userAgent: string;
  /** The clock, in Unix milliseconds; replaceable in tests. */
  now?: () => number;
  /** Waits; replaceable in tests. It must reject when the signal aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A request that would have to wait longer than this for its turn fails as `paused`. */
  maxWaitMs?: number;
  /** A request without an answer after this long is given up. */
  timeoutMs?: number;
  /** An answer larger than this is refused, in bytes. */
  maxBytes?: number;
  /** How long a source is left alone after it says "too many requests" without saying how long. */
  pauseMs?: number;
  /** How many answers are kept in memory. */
  cacheEntries?: number;
}

export interface JsonRequest {
  /** Added to the address as its query. A value that is undefined is left out. */
  params?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  /**
   * Called when the request's turn has come, just before it is sent. A
   * request can wait for its turn for a while; this is where its caller looks
   * once more whether it may still be sent, and throws when it may not.
   */
  beforeSend?: () => void;
}

export interface JsonAnswer {
  data: unknown;
  /** When the answer was fetched, in Unix milliseconds. */
  fetchedAt: number;
  /** True when the answer was kept from an earlier request and nothing was sent. */
  cached: boolean;
}

/** What a connector is given: its source, and nothing else. */
export interface SourceClient {
  readonly manifest: ConnectorManifest;
  /**
   * Asks the source for JSON. `path` is added to the manifest's address; an
   * empty path asks the address itself.
   */
  getJson(path: string, request?: JsonRequest): Promise<JsonAnswer>;
}

const DEFAULTS = {
  maxWaitMs: 15_000,
  timeoutMs: 20_000,
  maxBytes: 2 * 1024 * 1024,
  pauseMs: 5 * 60_000,
  cacheEntries: 200,
};

/** The longest pause a source can ask for. A longer one is cut to this. */
const LONGEST_PAUSE_MS = 24 * 3_600_000;

const defaultWait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new HttpError('cancelled', 'The request was given up.'));
      return;
    }
    const done = () => {
      signal.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new HttpError('cancelled', 'The request was given up.'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/** What is kept about one host: when it was asked, and until when it must be left alone. */
interface HostState {
  /** The times of the requests of the current window, oldest first. */
  sent: number[];
  pausedUntil: number;
  /** The requests wait for each other, so that their turns are counted one at a time. */
  turn: Promise<void>;
}

interface Kept {
  data: unknown;
  fetchedAt: number;
  until: number;
}

/**
 * How long a source asks to be left alone: the `Retry-After` header, which
 * gives seconds or a date. Null when it gives neither.
 */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  // `Date.parse` takes much that is no date of HTTP ("-5" is a year to it).
  if (!/^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * The address of a request: the manifest's address, the path, and the query.
 * Throws when the result leaves the manifest's host or the folder of its
 * address, or is not HTTPS.
 */
export function addressOf(
  manifest: ConnectorManifest,
  path: string,
  params: Record<string, string | number | undefined> = {},
): URL {
  const base = new URL(manifest.baseUrl);
  if (base.protocol !== 'https:' || base.username !== '' || base.password !== '') {
    throw new HttpError('address', `${manifest.name} is not asked over HTTPS.`);
  }
  // No "%" either: "%2e%2e" is ".." to whoever reads the address.
  if (/[\\?#%]|^\/\/|(^|\/)\.\.?(\/|$)|^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new HttpError('address', `"${path}" is not a path of ${manifest.name}.`);
  }
  const url = new URL(base.href);
  if (path !== '') {
    url.pathname = `${base.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  }
  const folder = base.pathname.replace(/\/$/, '');
  const within = url.pathname === folder || url.pathname.startsWith(`${folder}/`);
  if (url.origin !== base.origin || !(path === '' ? url.pathname === base.pathname : within)) {
    throw new HttpError('address', `"${path}" is not a path of ${manifest.name}.`);
  }
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.append(name, String(value));
  }
  return url;
}

export class HttpClient {
  readonly #fetch: HttpFetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #maxWaitMs: number;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #pauseMs: number;
  readonly #cacheEntries: number;
  readonly #hosts = new Map<string, HostState>();
  /** Answers by address. A Map keeps the order they were put in, oldest first. */
  readonly #kept = new Map<string, Kept>();
  /** Requests that are under way, by address, so that the same one is not sent twice at once. */
  readonly #underWay = new Map<string, Promise<JsonAnswer>>();
  /** Counts the times the kept answers were forgotten. An answer asked for before is not kept after. */
  #forgotten = 0;

  constructor(options: HttpClientOptions) {
    this.#fetch = options.fetch;
    this.#userAgent = options.userAgent;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? defaultWait;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULTS.maxWaitMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.#maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    this.#pauseMs = options.pauseMs ?? DEFAULTS.pauseMs;
    this.#cacheEntries = options.cacheEntries ?? DEFAULTS.cacheEntries;
  }

  /** The client of one source. */
  for(manifest: ConnectorManifest): SourceClient {
    if (manifest.tier !== 'api' || manifest.rateLimit === undefined) {
      throw new Error(`${manifest.id} is not a source the app may ask`);
    }
    return {
      manifest,
      getJson: (path, request = {}) => this.#getJson(manifest, path, request),
    };
  }

  /** Forgets every answer that was kept. */
  clearCache(): void {
    this.#forgotten += 1;
    this.#kept.clear();
  }

  /** Until when a source must be left alone, in Unix milliseconds; null when it may be asked. */
  pausedUntil(manifest: ConnectorManifest): number | null {
    const until = this.#hosts.get(new URL(manifest.baseUrl).host)?.pausedUntil ?? 0;
    return until > this.#now() ? until : null;
  }

  async #getJson(
    manifest: ConnectorManifest,
    path: string,
    request: JsonRequest,
  ): Promise<JsonAnswer> {
    const url = addressOf(manifest, path, request.params);
    const key = url.href;
    const now = this.#now();
    const kept = this.#kept.get(key);
    if (kept !== undefined) {
      if (kept.until > now) return { data: kept.data, fetchedAt: kept.fetchedAt, cached: true };
      this.#kept.delete(key);
    }
    // A caller that gives its own signal or its own last look is not joined
    // to another's request: giving one up must not give the other up.
    if (request.signal === undefined && request.beforeSend === undefined) {
      const same = this.#underWay.get(key);
      if (same !== undefined) return same;
      const asked = this.#send(manifest, url, request).finally(() => this.#underWay.delete(key));
      this.#underWay.set(key, asked);
      return asked;
    }
    return this.#send(manifest, url, request);
  }

  async #send(manifest: ConnectorManifest, url: URL, request: JsonRequest): Promise<JsonAnswer> {
    const abort = new AbortController();
    const outer = request.signal;
    const cancel = () => abort.abort();
    if (outer?.aborted) throw new HttpError('cancelled', 'The request was given up.');
    outer?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forgotten = this.#forgotten;
    try {
      await this.#takeTurn(manifest, url.host, abort.signal);
      try {
        request.beforeSend?.();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError('cancelled', 'The request was given up.');
      }
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(url.href, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-store',
          headers: { Accept: 'application/json', 'User-Agent': this.#userAgent },
          signal: abort.signal,
          redirect: 'error',
        });
      } catch (error) {
        throw this.#failure(manifest, error, timedOut, outer);
      }
      if (response.status === 429 || response.status === 503) {
        const asked = retryAfterMs(response.headers.get('retry-after'), this.#now());
        // A source that says "too many" and "ask again now" in one breath is
        // still left alone for the span of its limit.
        const least = (manifest.rateLimit?.perSeconds ?? 0) * 1000;
        const pause = Math.min(Math.max(asked ?? this.#pauseOf(manifest), least), LONGEST_PAUSE_MS);
        const until = this.#now() + pause;
        // A pause is never cut short by a later answer that asks for a shorter one.
        const host = this.#host(url.host);
        host.pausedUntil = Math.max(host.pausedUntil, until);
        await response.body?.cancel().catch(() => undefined);
        throw new HttpError('paused', `${manifest.name} asks to be left alone for a while.`, {
          status: response.status,
          retryAt: this.#host(url.host).pausedUntil,
        });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpError('status', `${manifest.name} answered with error ${response.status}.`, {
          status: response.status,
        });
      }
      let text: string;
      try {
        text = await readText(response, this.#maxBytes, manifest);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw this.#failure(manifest, error, timedOut, outer);
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new HttpError('format', `${manifest.name} answered with something other than JSON.`);
      }
      const fetchedAt = this.#now();
      if (forgotten === this.#forgotten) this.#keep(manifest, url.href, data, fetchedAt);
      return { data, fetchedAt, cached: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer?.removeEventListener('abort', cancel);
    }
  }

  #failure(
    manifest: ConnectorManifest,
    error: unknown,
    timedOut: boolean,
    outer: AbortSignal | undefined,
  ): HttpError {
    if (error instanceof HttpError) return error;
    if (timedOut) return new HttpError('timeout', `${manifest.name} did not answer in time.`);
    if (outer?.aborted) return new HttpError('cancelled', 'The request was given up.');
    return new HttpError('network', `${manifest.name} could not be reached.`);
  }

  #pauseOf(manifest: ConnectorManifest): number {
    return manifest.pauseSeconds === undefined ? this.#pauseMs : manifest.pauseSeconds * 1000;
  }

  #host(host: string): HostState {
    let state = this.#hosts.get(host);
    if (state === undefined) {
      state = { sent: [], pausedUntil: 0, turn: Promise.resolve() };
      this.#hosts.set(host, state);
    }
    return state;
  }

  /**
   * Waits until the host may be asked, and counts the request. No more than
   * the manifest's number of requests is ever sent within its span of time,
   * wherever that span is laid: the times of the last requests are kept, and
   * the next goes only when the oldest of them is a whole span back.
   */
  async #takeTurn(manifest: ConnectorManifest, host: string, signal: AbortSignal): Promise<void> {
    const limit = manifest.rateLimit;
    if (limit === undefined) throw new Error(`${manifest.id} has no rate limit`);
    const state = this.#host(host);
    const before = state.turn;
    let release: () => void = () => undefined;
    state.turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    let mine = false;
    try {
      // A request that is given up while it waits leaves the queue at once;
      // those behind it still wait for the one before it.
      await untilAborted(before, signal);
      mine = true;
      const span = limit.perSeconds * 1000;
      for (;;) {
        if (signal.aborted) throw new HttpError('cancelled', 'The request was given up.');
        const now = this.#now();
        if (state.pausedUntil > now) {
          throw new HttpError('paused', `${manifest.name} asks to be left alone for a while.`, {
            retryAt: state.pausedUntil,
          });
        }
        state.sent = state.sent.filter((at) => at > now - span);
        if (state.sent.length < limit.requests) {
          state.sent.push(now);
          return;
        }
        const free = (state.sent[0] ?? now) + span;
        if (free - now > this.#maxWaitMs) {
          throw new HttpError(
            'paused',
            `${manifest.name} has been asked as often as it allows for now.`,
            { retryAt: free },
          );
        }
        await this.#wait(Math.max(1, free - now), signal);
      }
    } finally {
      if (mine) release();
      else void before.then(release);
    }
  }

  #keep(manifest: ConnectorManifest, key: string, data: unknown, fetchedAt: number): void {
    const lifetime = manifest.cacheTtlHours * 3_600_000;
    if (lifetime <= 0 || this.#cacheEntries <= 0) return;
    this.#kept.delete(key);
    this.#kept.set(key, { data, fetchedAt, until: fetchedAt + lifetime });
    while (this.#kept.size > this.#cacheEntries) {
      const oldest = this.#kept.keys().next();
      if (oldest.done) break;
      this.#kept.delete(oldest.value);
    }
  }
}

/** Waits for `turn`, which never fails, unless the signal aborts first. */
function untilAborted(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop = () => reject(new HttpError('cancelled', 'The request was given up.'));
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    void turn.then(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    });
  });
}

/** Reads an answer as text, and gives up as soon as it is larger than allowed. */
async function readText(
  response: Response,
  maxBytes: number,
  manifest: ConnectorManifest,
): Promise<string> {
  const tooLarge = () =>
    new HttpError('too-large', `${manifest.name} answered with more than the app takes.`);
  const announced = Number(response.headers.get('content-length')?.trim() ?? '');
  if (Number.isFinite(announced) && announced > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
