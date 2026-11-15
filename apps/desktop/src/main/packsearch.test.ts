import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PackSearchStopped, PackWriter } from '@rulz/db';
import { PackSearch, inProcessSearchChannel, type InProcessOptions } from './packsearch';
import { SearchHost } from './packsearch.worker';

// The names are made up.
let dir: string;
const open: PackSearch[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rulz-packsearch-'));
  const writer = PackWriter.create(join(dir, 'ab.pack'), ['NAME', 'PLACE'], {
    names: ['NAME'],
    places: ['PLACE'],
  });
  writer.add([
    { year: 1900, values: ['Ada Baker', 'Ashvale'] },
    { year: 1910, values: ['Bram Baker', 'Dunmere'] },
  ]);
  writer.finish({
    packId: 'ab',
    kind: 'open-archives',
    builderVersion: 1,
    title: 'Test',
    sourceName: 's',
    sourceUrl: 'https://example.com/',
    licence: 'l',
    credit: 'c',
    files: [],
    downloadedAt: '2026-11-15',
  });
});

afterEach(async () => {
  for (const search of open.splice(0)) await search.dispose();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const Q = { names: 'Baker', limit: 20, offset: 0 };

function make(
  options: InProcessOptions = {},
  ackMs = 2000,
): { search: PackSearch; ended: number[] } {
  const ended: number[] = [];
  const search = new PackSearch({
    spawn: () => inProcessSearchChannel({ ...options, onTerminate: () => ended.push(1) }),
    pathOf: (id) => join(dir, `${id}.pack`),
    ackMs,
  });
  open.push(search);
  return { search, ended };
}

describe("the search worker's host", () => {
  it('searches a pack and stops a query whose flag is set', () => {
    const host = new SearchHost();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const path = join(dir, 'ab.pack');
    const found = host.handle({ type: 'search', qid: 1, id: 'ab', path, q: Q, flag });
    expect(found).toMatchObject({ type: 'result', qid: 1, total: 2 });
    Atomics.store(flag, 0, 1);
    expect(host.handle({ type: 'search', qid: 2, id: 'ab', path, q: Q, flag })).toMatchObject({
      type: 'error',
      qid: 2,
      kind: 'stopped',
    });
    expect(host.handle({ type: 'close', cid: 3, id: 'ab' })).toEqual({ type: 'closed', cid: 3 });
    host.closeAll();
  });

  it('answers for a file that is not that pack, or not there', () => {
    const host = new SearchHost();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    expect(
      host.handle({ type: 'search', qid: 1, id: 'zz', path: join(dir, 'ab.pack'), q: Q, flag }),
    ).toMatchObject({ type: 'error', kind: 'missing' });
    expect(
      host.handle({ type: 'search', qid: 2, id: 'ab', path: join(dir, 'none.pack'), q: Q, flag }),
    ).toMatchObject({ type: 'error', kind: 'missing' });
  });
});

describe('searching through the worker channel', () => {
  it('gives the rows and the total', async () => {
    const { search } = make();
    const found = await search.search('ab', Q, new AbortController().signal);
    expect(found.total).toBe(2);
    expect(found.rows.map((row) => row['NAME']).sort()).toEqual(['Ada Baker', 'Bram Baker']);
    const years = await search.search(
      'ab',
      { ...Q, years: { from: 1905, to: 1920 } },
      new AbortController().signal,
    );
    expect(years.rows.map((row) => row['NAME'])).toEqual(['Bram Baker']);
  });

  it('a search that is given up before it starts is stopped', async () => {
    const { search } = make();
    const abort = new AbortController();
    abort.abort();
    await expect(search.search('ab', Q, abort.signal)).rejects.toBeInstanceOf(PackSearchStopped);
  });

  it('a search given up while it waits for the worker sets its flag', async () => {
    const seen: Int32Array[] = [];
    const { search } = make(
      {
        stuck: (request) => {
          if (request.type === 'search') seen.push(request.flag);
          return true;
        },
      },
      50,
    );
    const abort = new AbortController();
    const pending = search.search('ab', Q, abort.signal).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Atomics.load(seen[0] ?? new Int32Array(1), 0)).toBe(0);
    abort.abort();
    expect(Atomics.load(seen[0] ?? new Int32Array(1), 0)).toBe(1);
    // The worker would answer "stopped"; here it is stuck, so the close ends it.
    await search.close('ab');
    expect(await pending).toBeInstanceOf(Error);
  });

  it('searches of a held pack wait, and go on when it is released', async () => {
    const { search } = make();
    await search.search('ab', Q, new AbortController().signal);
    await search.hold('ab');
    let done = false;
    const waiting = search.search('ab', Q, new AbortController().signal).then((found) => {
      done = true;
      return found;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(false);
    search.release('ab');
    expect((await waiting).total).toBe(2);
  });

  it('a search that waits for a held pack can be given up', async () => {
    const { search } = make();
    await search.hold('ab');
    const abort = new AbortController();
    const waiting = search.search('ab', Q, abort.signal).catch((error: unknown) => error);
    abort.abort();
    expect(await waiting).toBeInstanceOf(PackSearchStopped);
    search.release('ab');
  });

  it('holds of two jobs on one pack need two releases', async () => {
    const { search } = make();
    await search.hold('ab');
    await search.hold('ab');
    let done = false;
    const waiting = search.search('ab', Q, new AbortController().signal).then(() => {
      done = true;
    });
    search.release('ab');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    search.release('ab');
    await waiting;
  });

  it('ends a worker that does not acknowledge a close, and starts another for the next search', async () => {
    let stuckNow = true;
    const { search, ended } = make(
      { stuck: (request) => stuckNow && request.type === 'close' },
      50,
    );
    await search.search('ab', Q, new AbortController().signal);
    const started = Date.now();
    await search.close('ab');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ended).toHaveLength(1);
    stuckNow = false;
    expect((await search.search('ab', Q, new AbortController().signal)).total).toBe(2);
  });

  it('fails the searches under way when the worker dies', async () => {
    let exit: (() => void) | null = null;
    const search = new PackSearch({
      spawn: () => {
        const channel = inProcessSearchChannel({ stuck: () => true });
        return {
          ...channel,
          onExit: (listener) => {
            exit = listener;
          },
        };
      },
      pathOf: (id) => join(dir, `${id}.pack`),
    });
    open.push(search);
    const pending = search
      .search('ab', Q, new AbortController().signal)
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    (exit as (() => void) | null)?.();
    expect(await pending).toMatchObject({ message: expect.stringMatching(/ended unexpectedly/) });
  });
});

describe('a worker that is ended', () => {
  it('is gone before the next one starts, and a close waits for it', async () => {
    const events: string[] = [];
    const search = new PackSearch({
      spawn: () => {
        events.push('spawn');
        const channel = inProcessSearchChannel({ stuck: (request) => request.type === 'close' });
        return {
          ...channel,
          terminate: async () => {
            events.push('terminate');
            await new Promise((resolve) => setTimeout(resolve, 150));
            await channel.terminate();
            events.push('gone');
          },
        };
      },
      pathOf: (id) => join(dir, `${id}.pack`),
      ackMs: 20,
    });
    open.push(search);
    await search.search('ab', Q, new AbortController().signal);
    const holding = search.hold('ab');
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The old worker is still going; a search of another pack must not start a second one.
    const other = search
      .search('zz', Q, new AbortController().signal)
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['spawn', 'terminate']);
    await holding;
    expect(events.slice(0, 3)).toEqual(['spawn', 'terminate', 'gone']);
    await other;
    expect(events[3]).toBe('spawn');
    search.release('ab');
  });

  it('gets no search when a hold began just before the post', async () => {
    const posted: string[] = [];
    const search = new PackSearch({
      spawn: () => {
        const channel = inProcessSearchChannel();
        return {
          ...channel,
          post: (message) => {
            posted.push(message.type);
            channel.post(message);
          },
        };
      },
      pathOf: (id) => join(dir, `${id}.pack`),
    });
    open.push(search);
    await search.search('ab', Q, new AbortController().signal);
    await search.hold('ab');
    const waiting = search.search('ab', Q, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    posted.length = 0;
    search.release('ab');
    // One turn of the microtask queue: the search is woken but has not posted yet.
    await Promise.resolve();
    const again = search.hold('ab');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(posted.filter((type) => type === 'search')).toEqual([]);
    await again;
    search.release('ab');
    expect((await waiting).total).toBe(2);
  });
});

describe('browsing a pack through the worker', () => {
  const never = () => new AbortController().signal;

  it('the host answers a distinct, a list and a get, and stops each when its flag is set', () => {
    const host = new SearchHost();
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const path = join(dir, 'ab.pack');
    expect(
      host.handle({
        type: 'distinct',
        qid: 1,
        id: 'ab',
        path,
        q: { column: 'PLACE', limit: 10, offset: 0 },
        flag,
      }),
    ).toEqual({
      type: 'browsed',
      qid: 1,
      result: {
        kind: 'distinct',
        values: [
          { value: 'Ashvale', count: 1 },
          { value: 'Dunmere', count: 1 },
        ],
      },
    });
    expect(
      host.handle({
        type: 'list',
        qid: 2,
        id: 'ab',
        path,
        q: { columns: ['NAME'], where: { PLACE: 'Dunmere' }, limit: 10, offset: 0 },
        flag,
      }),
    ).toEqual({
      type: 'browsed',
      qid: 2,
      result: { kind: 'list', rows: [{ rowid: 2, values: { NAME: 'Bram Baker' } }], total: 1 },
    });
    expect(
      host.handle({
        type: 'get',
        qid: 3,
        id: 'ab',
        path,
        q: { rowid: 1, columns: ['PLACE'] },
        flag,
      }),
    ).toEqual({
      type: 'browsed',
      qid: 3,
      result: { kind: 'get', row: { rowid: 1, values: { PLACE: 'Ashvale' } } },
    });
    Atomics.store(flag, 0, 1);
    for (const request of [
      { type: 'distinct', q: { column: 'PLACE', limit: 10, offset: 0 } },
      { type: 'list', q: { columns: ['NAME'], limit: 10, offset: 0 } },
      { type: 'get', q: { rowid: 1, columns: ['PLACE'] } },
    ] as const) {
      expect(host.handle({ ...request, qid: 9, id: 'ab', path, flag })).toMatchObject({
        type: 'error',
        kind: 'stopped',
      });
    }
    // A column that is not there is a failure, not a crash.
    Atomics.store(flag, 0, 0);
    expect(
      host.handle({
        type: 'get',
        qid: 4,
        id: 'ab',
        path,
        q: { rowid: 1, columns: ['NOPE'] },
        flag,
      }),
    ).toMatchObject({ type: 'error', kind: 'failed' });
    host.closeAll();
  });

  it('gives the values, rows and one row through the channel', async () => {
    const { search } = make();
    expect(await search.distinct('ab', { column: 'PLACE', limit: 10, offset: 0 }, never())).toEqual(
      [
        { value: 'Ashvale', count: 1 },
        { value: 'Dunmere', count: 1 },
      ],
    );
    expect(
      await search.list('ab', { columns: ['NAME', 'PLACE'], limit: 10, offset: 0 }, never()),
    ).toEqual({
      rows: [
        { rowid: 1, values: { NAME: 'Ada Baker', PLACE: 'Ashvale' } },
        { rowid: 2, values: { NAME: 'Bram Baker', PLACE: 'Dunmere' } },
      ],
      total: 2,
    });
    expect(await search.get('ab', { rowid: 2, columns: ['NAME'] }, never())).toEqual({
      rowid: 2,
      values: { NAME: 'Bram Baker' },
    });
    expect(await search.get('ab', { rowid: 9, columns: ['NAME'] }, never())).toBeNull();
  });

  it('is given up when the signal is, and waits while the pack is held', async () => {
    const { search } = make();
    const abort = new AbortController();
    abort.abort();
    await expect(
      search.list('ab', { columns: ['NAME'], limit: 10, offset: 0 }, abort.signal),
    ).rejects.toThrow(PackSearchStopped);

    await search.hold('ab');
    let answered = false;
    const waiting = search.get('ab', { rowid: 1, columns: ['NAME'] }, never()).then((row) => {
      answered = true;
      return row;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    search.release('ab');
    expect(await waiting).toEqual({ rowid: 1, values: { NAME: 'Ada Baker' } });
  });

  it('fails for a column the pack does not have', async () => {
    const { search } = make();
    await expect(
      search.list('ab', { columns: ['NOPE'], limit: 10, offset: 0 }, never()),
    ).rejects.toThrow(/no column/);
    await expect(
      search.distinct('ab', { column: 'NOPE', limit: 10, offset: 0 }, never()),
    ).rejects.toThrow(/no column/);
  });
});
