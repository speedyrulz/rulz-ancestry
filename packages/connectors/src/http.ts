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
  | 'format'
  /** The source needs the user's own key, and there is none, or the source did not accept it. */
  | 'key'
  /** The source's count of requests for the month, or the day, is used up as far as the app lets it be. Nothing was sent. */
  | 'quota';

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
  /** Where the client keeps what must outlast the app. Without it, that is forgotten when the app closes. */
  memory?: HostMemory;
  /**
   * Gives the user's key for a source that needs one; null when there is
   * none. The client asks for it just before a request goes out, sends it in
   * the header the manifest names, and keeps it nowhere.
   */
  keyOf?: (manifest: ConnectorManifest) => string | null;
}

/** How much of a source's count of requests is used, as the app counts it. */
export interface QuotaRecord {
  /** The month ("2026-11") or the day ("2026-11-13") that is counted. */
  period: string;
  /** How many requests the app has sent in it. */
  used: number;
}

/** What the app lets itself use of a source's count, and when the count starts again. */
export interface QuotaState extends QuotaRecord {
  /** How many requests the app sends in a period at most. Below what the source allows. */
  ceiling: number;
  /** When the next period starts, in Unix milliseconds. */
  resetsAt: number;
}

/**
 * The share of a source's count the app uses at most. The rest is left for
 * whatever else uses the same key, and for a count of the source that
 * differs from the app's.
 */
export const QUOTA_SHARE = 0.9;

/**
 * A period starts when its first day has begun everywhere on Earth. The
 * source does not say by which clock it counts; this is the latest one.
 */
const QUOTA_CLOCK_BEHIND_MS = 12 * 3_600_000;

/** The name under which the count of a source is kept. No host has a colon in its name. */
export const quotaMemoryName = (manifestId: string) => `quota:${manifestId}`;

/** The period a moment lies in, and when the next one starts. */
export function quotaPeriod(now: number, period: 'day' | 'month'): { name: string; next: number } {
  const date = new Date(now - QUOTA_CLOCK_BEHIND_MS);
  const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
  const two = (value: number) => String(value).padStart(2, '0');
  return period === 'month'
    ? {
        name: `${year}-${two(month + 1)}`,
        next: Date.UTC(year, month + 1, 1) + QUOTA_CLOCK_BEHIND_MS,
      }
    : {
        name: `${year}-${two(month + 1)}-${two(day)}`,
        next: Date.UTC(year, month, day + 1) + QUOTA_CLOCK_BEHIND_MS,
      };
}

/** A key as it may stand in a header: printable, without spaces, not endless. */
const KEY = /^[\x21-\x7e]{1,300}$/;

/** What is kept about a host for the next time the app runs. */
export interface HostRecord {
  /** Until when the host must be left alone, in Unix milliseconds; 0 when it may be asked. */
  pausedUntil: number;
  /** The times of the last requests, in Unix milliseconds, oldest first. */
  sent: number[];
}

/**
 * A place outside the client for what it knows about a host. A source that
 * shuts a client out for an hour does so whether or not the app was closed in
 * between, and so does its count of requests per minute.
 */
export interface HostMemory {
  /** What was kept about a host, or under another name. Whatever comes back is checked before it is used. */
  load(name: string): unknown;
  save(name: string, record: HostRecord | QuotaRecord): void;
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

/** No more times of requests than this are kept about a host. */
const SENT_KEPT = 1000;

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
  readonly #memory: HostMemory | undefined;
  readonly #keyOf: ((manifest: ConnectorManifest) => string | null) | undefined;
  /** The counts of the sources that have one, by the id of the source. */
  readonly #quotas = new Map<string, QuotaRecord>();
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
    this.#memory = options.memory;
    this.#keyOf = options.keyOf;
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

  /** How much of a source's count is used; null for a source that has none. */
  quotaOf(manifest: ConnectorManifest): QuotaState | null {
    const quota = manifest.quota;
    if (quota === undefined) return null;
    const { name, next } = quotaPeriod(this.#now(), quota.period);
    const ceiling = Math.floor(quota.requests * QUOTA_SHARE);
    const record = this.#counted(manifest.id, name, ceiling);
    return { period: record.period, used: record.used, ceiling, resetsAt: next };
  }

  /**
   * The count of a source. It starts again only when a later period has
   * begun: a clock that is set forward and back again does not bring a used
   * month back, and one that is set back does not empty the month it left.
   */
  #counted(id: string, period: string, ceiling: number): QuotaRecord {
    let record = this.#quotas.get(id) ?? this.#recalledCount(id, period, ceiling);
    if (period > record.period) record = { period, used: 0 };
    this.#quotas.set(id, record);
    return record;
  }

  /**
   * The count that was kept when the app last ran. Nothing kept is a count of
   * nought. Something kept that cannot be read, or is no count, is taken for
   * a month that is used up: the app does not know how much it asked, and
   * asking on could shut the user's key out at the source.
   */
  #recalledCount(id: string, period: string, ceiling: number): QuotaRecord {
    const usedUp = { period, used: ceiling };
    if (this.#memory === undefined) return { period, used: 0 };
    let kept: unknown;
    try {
      kept = this.#memory.load(quotaMemoryName(id));
    } catch {
      return usedUp;
    }
    if (kept === null || kept === undefined) return { period, used: 0 };
    if (typeof kept !== 'object') return usedUp;
    const { period: was, used } = kept as Record<string, unknown>;
    const fits =
      typeof was === 'string' &&
      was.length === period.length &&
      /^\d{4}-\d{2}(-\d{2})?$/.test(was) &&
      typeof used === 'number' &&
      Number.isInteger(used) &&
      used >= 0;
    return fits ? { period: was, used } : usedUp;
  }

  /**
   * Counts one request against a source's count for the month or the day,
   * just before it goes out. Throws when the app's share is used up, and when
   * the count cannot be kept: a count that is lost would let the app ask on.
   */
  #spend(manifest: ConnectorManifest): void {
    const state = this.quotaOf(manifest);
    if (state === null) return;
    const lost = new HttpError(
      'quota',
      `The app cannot keep count of what it asks ${manifest.name}, so it does not ask.`,
    );
    // Without a place that outlasts the app, the count would start again with every start.
    if (this.#memory === undefined) throw lost;
    if (state.used >= state.ceiling) {
      throw new HttpError(
        'quota',
        `${manifest.name} has been asked as often this ${manifest.quota?.period ?? 'month'} as the app allows.`,
        { retryAt: state.resetsAt },
      );
    }
    const record = { period: state.period, used: state.used + 1 };
    try {
      this.#memory.save(quotaMemoryName(manifest.id), record);
    } catch {
      throw lost;
    }
    this.#quotas.set(manifest.id, record);
  }

  /**
   * The key of a source that needs one, for one request. Throws when there is
   * none, or when it is not something a header can hold.
   */
  #key(manifest: ConnectorManifest): { header: string; value: string } | null {
    if (manifest.auth !== 'apiKey') return null;
    const value = this.#keyOf?.(manifest) ?? null;
    if (manifest.keyHeader === undefined || value === null || !KEY.test(value)) {
      throw new HttpError('key', `${manifest.name} needs your own key.`);
    }
    return { header: manifest.keyHeader, value };
  }

  /** Until when a source must be left alone, in Unix milliseconds; null when it may be asked. */
  pausedUntil(manifest: ConnectorManifest): number | null {
    const until = this.#host(new URL(manifest.baseUrl).host).pausedUntil;
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
      // Without a key there is nothing to wait a turn for.
      this.#key(manifest);
      await this.#takeTurn(manifest, url.host, abort.signal);
      try {
        request.beforeSend?.();
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError('cancelled', 'The request was given up.');
      }
      // The key is taken now, not kept from before: it may have been removed
      // while the request waited. Then the request is counted, and goes out.
      const key = this.#key(manifest);
      this.#spend(manifest);
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
          headers: {
            Accept: 'application/json',
            'User-Agent': this.#userAgent,
            ...(key === null ? {} : { [key.header]: key.value }),
          },
          signal: abort.signal,
          redirect: 'error',
        });
      } catch (error) {
        throw this.#failure(manifest, error, timedOut, outer);
      }
      if (response.status === 429 || response.status === 503) {
        const asked = retryAfterMs(response.headers.get('retry-after'), this.#now());
        await response.body?.cancel().catch(() => undefined);
        throw this.#pause(manifest, url.host, asked, response.status);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // "Forbidden" is how a source that names its own pause shuts a client
        // out, or asks it to prove that it is no robot.
        if (response.status === 403 && manifest.pauseSeconds !== undefined) {
          throw this.#pause(manifest, url.host, null, response.status);
        }
        // From a source with a key, "unauthorized" and "forbidden" are about the key.
        if (key !== null && (response.status === 401 || response.status === 403)) {
          throw this.#refusedKey(manifest, response.status);
        }
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
        // A source that names its own pause sends a web page in place of an
        // answer when it has been asked too often: a page that asks to prove
        // one is no robot. Asking on would make it worse.
        const page = /^\s*</.test(text) || /html/i.test(response.headers.get('content-type') ?? '');
        if (manifest.pauseSeconds !== undefined && page) {
          throw this.#pause(manifest, url.host, null, response.status);
        }
        // A source with a key that sends its website in place of an answer
        // has not taken the request for one of its API.
        if (key !== null && page) throw this.#refusedKey(manifest, response.status);
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

  /** The error for a key the source did not accept. It says nothing of the key itself. */
  #refusedKey(manifest: ConnectorManifest, status: number): HttpError {
    return new HttpError(
      'key',
      `${manifest.name} did not accept the key. It may be mistyped, no longer valid, or over its limit.`,
      { status },
    );
  }

  #pauseOf(manifest: ConnectorManifest): number {
    return manifest.pauseSeconds === undefined ? this.#pauseMs : manifest.pauseSeconds * 1000;
  }

  /**
   * Leaves a host alone from now on: for as long as it asked, or for the
   * manifest's own pause. Gives the error to throw.
   */
  #pause(
    manifest: ConnectorManifest,
    hostName: string,
    asked: number | null,
    status: number,
  ): HttpError {
    // A source that says "too many" and "ask again now" in one breath is
    // still left alone for the span of its limit.
    // And one whose manifest names a pause is left alone for that long at
    // least: it is how long the source says it shuts a client out, and asking
    // again meanwhile can make it longer.
    const least = Math.max(
      (manifest.rateLimit?.perSeconds ?? 0) * 1000,
      (manifest.pauseSeconds ?? 0) * 1000,
    );
    const pause = Math.min(Math.max(asked ?? this.#pauseOf(manifest), least), LONGEST_PAUSE_MS);
    // A pause is never cut short by a later answer that asks for a shorter one.
    const host = this.#host(hostName);
    host.pausedUntil = Math.max(host.pausedUntil, this.#now() + pause);
    this.#remember(hostName, host);
    return new HttpError('paused', `${manifest.name} asks to be left alone for a while.`, {
      status,
      retryAt: host.pausedUntil,
    });
  }

  #host(host: string): HostState {
    let state = this.#hosts.get(host);
    if (state === undefined) {
      const recalled = this.#recall(host);
      state = { ...recalled, turn: Promise.resolve() };
      this.#hosts.set(host, state);
      // What was read is kept as it was understood: a pause that was cut to
      // a day ends in a day, and is not cut to a day again at the next start.
      if (recalled.pausedUntil > 0 || recalled.sent.length > 0) this.#remember(host, state);
    }
    return this.#settle(state);
  }

  /**
   * Puts right what a clock that was set back would leave wrong: a request
   * counts as sent now at the latest, and a pause ends a day from now at the
   * latest. Without this, a source could be shut until the app is started again.
   */
  #settle(state: HostState): HostState {
    const now = this.#now();
    if (state.pausedUntil > now + LONGEST_PAUSE_MS) state.pausedUntil = now + LONGEST_PAUSE_MS;
    if (state.sent.some((at) => at > now)) state.sent = state.sent.map((at) => Math.min(at, now));
    return state;
  }

  /**
   * What was kept about a host when the app last ran. Nothing of it is taken
   * on trust: a pause ends a day from now at the latest, and a request counts
   * as sent now at the latest, whatever a changed clock or a damaged setting says.
   */
  #recall(host: string): HostRecord {
    const nothing: HostRecord = { pausedUntil: 0, sent: [] };
    if (this.#memory === undefined) return nothing;
    let kept: unknown;
    try {
      kept = this.#memory.load(host);
    } catch {
      return nothing;
    }
    if (typeof kept !== 'object' || kept === null) return nothing;
    const { pausedUntil, sent } = kept as Record<string, unknown>;
    const now = this.#now();
    const isTime = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0;
    return {
      pausedUntil: isTime(pausedUntil) ? Math.min(pausedUntil, now + LONGEST_PAUSE_MS) : 0,
      sent: Array.isArray(sent)
        ? sent
            .filter(isTime)
            .slice(-SENT_KEPT)
            .map((at) => Math.min(at, now))
            .sort((a, b) => a - b)
        : [],
    };
  }

  /** Keeps what is known about a host for the next time the app runs. A failure to keep it stops nothing. */
  #remember(host: string, state: HostState): void {
    if (this.#memory === undefined) return;
    try {
      this.#memory.save(host, {
        pausedUntil: state.pausedUntil,
        sent: state.sent.slice(-SENT_KEPT),
      });
    } catch {
      // The search goes on; the pause still holds while the app runs.
    }
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
        this.#settle(state);
        if (state.pausedUntil > now) {
          throw new HttpError('paused', `${manifest.name} asks to be left alone for a while.`, {
            retryAt: state.pausedUntil,
          });
        }
        state.sent = state.sent.filter((at) => at > now - span);
        if (state.sent.length < limit.requests) {
          state.sent.push(now);
          this.#remember(host, state);
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
