import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { PackReader, PackSearchStopped } from '@rulz/db';

/**
 * The worker thread that searches the packs (see `packsearch.ts`). better-sqlite3
 * cannot interrupt a query, and a query of millions of rows takes a while, so
 * the packs are searched here and not in the thread of the app's window. Each
 * query is given a shared flag that its search looks at for every row: when
 * the main thread sets it, the query ends at once.
 *
 * `SearchHost` holds the readers and answers one message at a time; the worker
 * only wires it to its port, and a test runs it in the main thread.
 */

export interface SearchQuery {
  names: string;
  places?: string;
  limit: number;
  offset: number;
  years?: { from: number; to: number };
}

/** What a browse of a pack asks: see `PackReader.distinct`, `list` and `get`. */
export interface DistinctQuery {
  column: string;
  where?: Record<string, string>;
  limit: number;
  offset: number;
}
export interface ListQuery {
  columns: readonly string[];
  where?: Record<string, string>;
  contains?: { column: string; words: string };
  limit: number;
  offset: number;
}
export interface GetQuery {
  rowid: number;
  columns: readonly string[];
}

/** What every request of a query has: its number, the pack, and the shared flag that stops it. */
interface QueryRequest {
  qid: number;
  id: string;
  /** The pack's file. */
  path: string;
  /** The query stops when this holds anything but nought. */
  flag: Int32Array;
}

export type SearchRequest =
  | ({ type: 'search'; q: SearchQuery } & QueryRequest)
  | ({ type: 'distinct'; q: DistinctQuery } & QueryRequest)
  | ({ type: 'list'; q: ListQuery } & QueryRequest)
  | ({ type: 'get'; q: GetQuery } & QueryRequest)
  | { type: 'close'; cid: number; id: string };

/** The answer of a browse, as the reader gives it. */
export type BrowseResult =
  | { kind: 'distinct'; values: { value: string; count: number }[] }
  | { kind: 'list'; rows: { rowid: number; values: Record<string, string> }[]; total: number }
  | { kind: 'get'; row: { rowid: number; values: Record<string, string> } | null };

export type SearchReply =
  | { type: 'result'; qid: number; rows: Record<string, string>[]; total: number }
  | { type: 'browsed'; qid: number; result: BrowseResult }
  | { type: 'error'; qid: number; kind: 'stopped' | 'missing' | 'failed'; message: string }
  | { type: 'closed'; cid: number };

export class SearchHost {
  readonly #readers = new Map<string, { path: string; reader: PackReader }>();

  handle(request: SearchRequest): SearchReply {
    if (request.type === 'close') {
      this.#drop(request.id);
      return { type: 'closed', cid: request.cid };
    }
    const { qid, id, path, flag } = request;
    try {
      let held = this.#readers.get(id);
      if (held !== undefined && held.path !== path) {
        this.#drop(id);
        held = undefined;
      }
      if (held === undefined) {
        const opened = PackReader.open(path);
        if (!opened.ok) {
          return { type: 'error', qid, kind: 'missing', message: 'This pack cannot be opened.' };
        }
        if (opened.reader.meta.packId !== id) {
          opened.reader.close();
          return { type: 'error', qid, kind: 'missing', message: 'This file is not that pack.' };
        }
        held = { path, reader: opened.reader };
        this.#readers.set(id, held);
      }
      const stop = () => Atomics.load(flag, 0) !== 0;
      const { reader } = held;
      switch (request.type) {
        case 'search': {
          const found = reader.search(request.q, stop);
          return { type: 'result', qid, rows: found.rows, total: found.total };
        }
        case 'distinct':
          return {
            type: 'browsed',
            qid,
            result: { kind: 'distinct', ...reader.distinct(request.q, stop) },
          };
        case 'list':
          return {
            type: 'browsed',
            qid,
            result: { kind: 'list', ...reader.list(request.q, stop) },
          };
        case 'get':
          return {
            type: 'browsed',
            qid,
            result: {
              kind: 'get',
              row: reader.get(request.q.rowid, request.q.columns, stop),
            },
          };
      }
    } catch (error) {
      if (error instanceof PackSearchStopped) {
        return { type: 'error', qid, kind: 'stopped', message: error.message };
      }
      return {
        type: 'error',
        qid,
        kind: 'failed',
        message: error instanceof Error ? error.message : 'The pack could not be searched.',
      };
    }
  }

  #drop(id: string): void {
    const held = this.#readers.get(id);
    this.#readers.delete(id);
    try {
      held?.reader.close();
    } catch {
      // A reader that cannot be closed is let go of.
    }
  }

  closeAll(): void {
    for (const id of [...this.#readers.keys()]) this.#drop(id);
  }
}

const start = workerData as { rulzPackSearch?: true } | null;

if (!isMainThread && parentPort !== null && start?.rulzPackSearch === true) {
  const port = parentPort;
  const host = new SearchHost();
  port.on('message', (request: SearchRequest) => {
    port.postMessage(host.handle(request));
  });
}
