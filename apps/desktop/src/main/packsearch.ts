import { Worker } from 'node:worker_threads';
import { PackSearchStopped } from '@rulz/db';
import {
  SearchHost,
  type BrowseResult,
  type DistinctQuery,
  type GetQuery,
  type ListQuery,
  type SearchQuery,
  type SearchReply,
  type SearchRequest,
} from './packsearch.worker';

/**
 * Searching the packs from the main thread. The packs are opened and searched
 * in one worker thread (`packsearch.worker.ts`), so that a long query never
 * holds up the app. A search that is given up, or a pack that is to be
 * replaced or deleted, sets the query's shared flag, which ends it at once;
 * where the worker does not answer in time, it is ended and started again.
 *
 * Nothing here knows what a pack holds: it gives the rows as they are stored.
 */

/** The ways the main thread talks to a worker; a test can put an in-process one in its place. */
export interface SearchChannel {
  post(message: SearchRequest): void;
  onMessage(listener: (reply: SearchReply) => void): void;
  /** Told when the worker is gone, whatever the reason. */
  onExit(listener: () => void): void;
  terminate(): Promise<void>;
}

/** The channel to a worker thread loaded from `path`. */
export function workerSearchChannel(path: string): SearchChannel {
  const worker = new Worker(path, { workerData: { rulzPackSearch: true } });
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.on('message', listener),
    onExit: (listener) => {
      worker.once('exit', listener);
      // An error ends the worker too; 'exit' follows.
      worker.on('error', () => undefined);
    },
    terminate: async () => {
      await worker.terminate();
    },
  };
}

/** What a test can do to the channel it gets: make the worker stuck. */
export interface InProcessOptions {
  /** True for a request that is never answered, as a worker stuck in a query would not. */
  stuck?: (request: SearchRequest) => boolean;
  /** Told when the channel is ended. */
  onTerminate?: () => void;
  /** A host to share between channels, so that a test can look at it. */
  host?: SearchHost;
}

/** A channel that answers from this thread, one request per turn of the event loop. For tests. */
export function inProcessSearchChannel(options: InProcessOptions = {}): SearchChannel {
  const host = options.host ?? new SearchHost();
  let listener: ((reply: SearchReply) => void) | null = null;
  let exit: (() => void) | null = null;
  let ended = false;
  return {
    post: (message) => {
      if (ended || options.stuck?.(message) === true) return;
      setImmediate(() => {
        if (!ended) listener?.(host.handle(message));
      });
    },
    onMessage: (next) => {
      listener = next;
    },
    onExit: (next) => {
      exit = next;
    },
    terminate: () => {
      ended = true;
      host.closeAll();
      options.onTerminate?.();
      exit?.();
      return Promise.resolve();
    },
  };
}

export interface PackSearchOptions {
  /** Starts the worker; called when a search needs one. */
  spawn: () => SearchChannel;
  /** Where the file of a pack is. */
  pathOf: (id: string) => string;
  /** How long the worker is given to close a pack before it is ended, in milliseconds. */
  ackMs?: number;
}

/** The answers that carry a result, as a query settles with them. */
type Answer = Extract<SearchReply, { type: 'result' | 'browsed' }>;

interface Query {
  id: string;
  flag: Int32Array;
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
}

/** Waits at most `ms` for a promise; true when it settled in time. */
async function within(ms: number, promise: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class PackSearch {
  readonly #spawn: () => SearchChannel;
  readonly #pathOf: (id: string) => string;
  readonly #ackMs: number;
  #channel: SearchChannel | null = null;
  #next = 1;
  readonly #queries = new Map<number, Query>();
  readonly #acks = new Map<number, () => void>();
  /** Workers that were told to end and have not yet gone: no new worker starts before they have. */
  readonly #ending = new Set<Promise<void>>();
  /** Packs whose searches wait: one that is being replaced or deleted. */
  readonly #held = new Map<string, { count: number; waiting: (() => void)[] }>();

  constructor(options: PackSearchOptions) {
    this.#spawn = options.spawn;
    this.#pathOf = options.pathOf;
    this.#ackMs = options.ackMs ?? 2000;
  }

  #open(): SearchChannel {
    if (this.#channel !== null) return this.#channel;
    const channel = this.#spawn();
    channel.onMessage((reply) => this.#reply(reply));
    channel.onExit(() => {
      // Only the channel in use matters; one that was dropped has been dealt with.
      if (this.#channel === channel) {
        this.#channel = null;
        this.#failAll(new Error('The search of the packs ended unexpectedly.'));
      }
    });
    this.#channel = channel;
    return channel;
  }

  #reply(reply: SearchReply): void {
    if (reply.type === 'closed') {
      const done = this.#acks.get(reply.cid);
      this.#acks.delete(reply.cid);
      done?.();
      return;
    }
    const query = this.#queries.get(reply.qid);
    if (query === undefined) return;
    this.#queries.delete(reply.qid);
    if (reply.type === 'result' || reply.type === 'browsed') query.resolve(reply);
    else if (reply.kind === 'stopped') query.reject(new PackSearchStopped());
    else query.reject(new Error(reply.message));
  }

  #failAll(error: Error): void {
    const queries = [...this.#queries.values()];
    this.#queries.clear();
    for (const query of queries) query.reject(error);
    const acks = [...this.#acks.values()];
    this.#acks.clear();
    for (const done of acks) done();
  }

  /** Ends the worker, at once, and fails what it was doing. The next search starts another. */
  async #restart(): Promise<void> {
    const channel = this.#channel;
    this.#channel = null;
    this.#failAll(new Error('The search of the packs was ended.'));
    if (channel !== null) {
      const ended: Promise<void> = Promise.resolve()
        .then(() => channel.terminate())
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => this.#ending.delete(ended));
      this.#ending.add(ended);
    }
    await this.#settled();
  }

  /** Resolves when no worker that was told to end is still there, so that none holds a file. */
  async #settled(): Promise<void> {
    while (this.#ending.size > 0) await Promise.all([...this.#ending]);
  }

  /** Waits while searches of a pack are held. */
  async #whileHeld(id: string, signal: AbortSignal): Promise<void> {
    while (this.#held.has(id)) {
      const held = this.#held.get(id);
      if (held === undefined) break;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new PackSearchStopped());
        signal.addEventListener('abort', onAbort, { once: true });
        held.waiting.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  /**
   * Looks for a person in a pack. Rejects with `PackSearchStopped` when the
   * signal is given up, or when the pack is about to be replaced or deleted.
   */
  async search(
    id: string,
    q: SearchQuery,
    signal: AbortSignal,
  ): Promise<{ rows: Record<string, string>[]; total: number }> {
    const answer = await this.#send(id, signal, (qid, path, flag) => ({
      type: 'search',
      qid,
      id,
      path,
      q,
      flag,
    }));
    if (answer.type !== 'result')
      throw new Error('The pack gave an answer that was not asked for.');
    return { rows: answer.rows, total: answer.total };
  }

  async #browse(
    id: string,
    signal: AbortSignal,
    make: (qid: number, path: string, flag: Int32Array) => SearchRequest,
  ): Promise<BrowseResult> {
    const answer = await this.#send(id, signal, make);
    if (answer.type !== 'browsed')
      throw new Error('The pack gave an answer that was not asked for.');
    return answer.result;
  }

  /** The values of one column of a pack, each with how many rows hold it. */
  async distinct(
    id: string,
    q: DistinctQuery,
    signal: AbortSignal,
  ): Promise<{ value: string; count: number }[]> {
    const result = await this.#browse(id, signal, (qid, path, flag) => ({
      type: 'distinct',
      qid,
      id,
      path,
      q,
      flag,
    }));
    if (result.kind !== 'distinct')
      throw new Error('The pack gave an answer that was not asked for.');
    return result.values;
  }

  /** Some columns of some rows of a pack, with their row numbers; never the `files` column. */
  async list(
    id: string,
    q: ListQuery,
    signal: AbortSignal,
  ): Promise<{ rows: { rowid: number; values: Record<string, string> }[]; total: number }> {
    const result = await this.#browse(id, signal, (qid, path, flag) => ({
      type: 'list',
      qid,
      id,
      path,
      q,
      flag,
    }));
    if (result.kind !== 'list') throw new Error('The pack gave an answer that was not asked for.');
    return { rows: result.rows, total: result.total };
  }

  /** Some columns of one row of a pack, by its row number; null when there is none. */
  async get(
    id: string,
    q: GetQuery,
    signal: AbortSignal,
  ): Promise<{ rowid: number; values: Record<string, string> } | null> {
    const result = await this.#browse(id, signal, (qid, path, flag) => ({
      type: 'get',
      qid,
      id,
      path,
      q,
      flag,
    }));
    if (result.kind !== 'get') throw new Error('The pack gave an answer that was not asked for.');
    return result.row;
  }

  /** Sends one request to the worker, once the pack is not held, and waits for its answer. */
  async #send(
    id: string,
    signal: AbortSignal,
    make: (qid: number, path: string, flag: Int32Array) => SearchRequest,
  ): Promise<Answer> {
    if (signal.aborted) throw new PackSearchStopped();
    let channel: SearchChannel;
    for (;;) {
      await this.#whileHeld(id, signal);
      if (signal.aborted) throw new PackSearchStopped();
      // An old worker may still hold a file; the next one waits for it to go.
      if (this.#ending.size > 0) {
        await this.#settled();
        continue;
      }
      // A hold may have begun while this waited; look once more, with no wait before the post.
      if (this.#held.has(id)) continue;
      channel = this.#open();
      break;
    }
    const qid = this.#next++;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const stop = () => Atomics.store(flag, 0, 1);
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<Answer>((resolve, reject) => {
        this.#queries.set(qid, { id, flag, resolve, reject });
        try {
          channel.post(make(qid, this.#pathOf(id), flag));
        } catch (error) {
          this.#queries.delete(qid);
          reject(error instanceof Error ? error : new Error('The search could not be started.'));
        }
      });
    } finally {
      signal.removeEventListener('abort', stop);
      this.#queries.delete(qid);
    }
  }

  /**
   * Makes the worker let go of a pack's file: the searches under way for it
   * are stopped, and the worker closes its reader. When the worker does not
   * say so in time (it is in a query that does not look at its flag), it is
   * ended and started again. Resolves when no file of the pack is held open.
   */
  async close(id: string): Promise<void> {
    for (const query of this.#queries.values()) {
      if (query.id === id) Atomics.store(query.flag, 0, 1);
    }
    const channel = this.#channel;
    if (channel === null) {
      await this.#settled();
      return;
    }
    const cid = this.#next++;
    const acknowledged = new Promise<void>((resolve) => this.#acks.set(cid, resolve));
    channel.post({ type: 'close', cid, id });
    if (!(await within(this.#ackMs, acknowledged))) {
      this.#acks.delete(cid);
      await this.#restart();
    }
  }

  /**
   * Holds the searches of a pack, so that its file can be replaced or deleted:
   * new searches of it wait, those under way are stopped, and the worker lets
   * go of the file. Call {@link release} when done.
   */
  async hold(id: string): Promise<void> {
    const held = this.#held.get(id);
    if (held === undefined) this.#held.set(id, { count: 1, waiting: [] });
    else held.count += 1;
    await this.close(id);
  }

  release(id: string): void {
    const held = this.#held.get(id);
    if (held === undefined) return;
    held.count -= 1;
    if (held.count > 0) return;
    this.#held.delete(id);
    for (const wake of held.waiting) wake();
  }

  /** Ends the worker. For when the app quits. */
  async dispose(): Promise<void> {
    await this.#restart();
  }
}
