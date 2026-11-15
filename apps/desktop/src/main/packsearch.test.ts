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
