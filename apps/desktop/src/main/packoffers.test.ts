import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PackMeta } from '@rulz/db';
import type { PackInfo } from '../shared/ipc';
import { PackOffers, type OfferPacks } from './packoffers';
import { PackError, type PackFetch, type PackInstallSpec } from './packs';
import { userAgentOf } from './records';

// The archives, codes and texts in the fixtures are made up.
const FIXTURES = join(
  import.meta.dirname,
  '../../../../packages/connectors/src/sources/open-archives/fixtures',
);
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const CATALOGUE = 'https://www.openarchieven.nl/datasets/datacatalog.jsonld';
const PAGE = 'https://www.openarchieven.nl/datasets/tst1';
const FILE_H = 'https://oa-export.s3.nl-ams.scw.cloud/csv/tst1.bsh.csv.gz';
const FILE_G = 'https://oa-export.s3.nl-ams.scw.cloud/csv/tst1.bsg.csv.gz';

interface Call {
  url: string;
  method: string;
  init: Parameters<PackFetch>[1];
}

/** A fetch that answers from a table of addresses and keeps every request it was given. */
function fakeNetwork(overrides: Record<string, () => Response> = {}) {
  const calls: Call[] = [];
  const answers: Record<string, (method: string) => Response> = {
    [CATALOGUE]: () => new Response(fixture('catalogue.sample.jsonld')),
    [PAGE]: () => new Response(fixture('dataset-page-tst1.html')),
    [FILE_H]: () => new Response(null, { headers: { 'content-length': '1000', etag: '"aaa"' } }),
    [FILE_G]: () => new Response(null, { headers: { 'content-length': '2000', etag: '"bbb"' } }),
  };
  const fetch: PackFetch = (url, init) => {
    calls.push({ url, method: init.method, init });
    const answer = overrides[url] ?? answers[url];
    return Promise.resolve(
      answer === undefined ? new Response('not found', { status: 404 }) : answer(init.method),
    );
  };
  return { fetch, calls, urls: () => calls.map((call) => call.url) };
}

function pack(over: Partial<PackInfo> = {}): PackInfo {
  return {
    id: 'oatst1',
    kind: 'open-archives',
    title: 'Test Town Archive',
    sourceName: 'Open Archives',
    licence: 'CC0 1.0',
    credit: '',
    rows: 5,
    bytes: 1,
    downloadedAt: '2026-01-01',
    state: 'ready',
    sourceModified: null,
    ...over,
  };
}

function fakePacks(packs: PackInfo[] = [], meta: PackMeta | null = null) {
  const installed: PackInstallSpec[] = [];
  const state = { freeBytes: 10 as number | null, packs, running: false, meta };
  const manager: OfferPacks = {
    state: () => ({ freeBytes: state.freeBytes, packs: state.packs }),
    metaOf: () => state.meta,
    install: (spec) => {
      installed.push(spec);
    },
    get running() {
      return state.running;
    },
    reserveBytes: 100,
  };
  return { manager, state, installed };
}

function metaOf(files: { url: string; bytes: number; etag: string | null }[]): PackMeta {
  return {
    packId: 'oatst1',
    kind: 'open-archives',
    builderVersion: 1,
    title: 'Test Town Archive',
    sourceName: 'Open Archives',
    sourceUrl: PAGE,
    licence: 'CC0 1.0',
    credit: '',
    files: files.map((file) => ({ ...file, sha256: '0'.repeat(64), modified: null })),
    rows: 5,
    downloadedAt: '2026-01-01',
    builtAt: '2026-01-01T00:00:00.000Z',
  };
}

function make(
  overrides: Record<string, () => Response> = {},
  packs = fakePacks(),
  now = { t: 1_000_000 },
) {
  const network = fakeNetwork(overrides);
  const offers = new PackOffers({
    fetch: network.fetch,
    appVersion: '9.9.9',
    packs: packs.manager,
    now: () => now.t,
  });
  return { offers, network, packs, now };
}

/** A body of `size` bytes in 1 MB pieces, with no length given. */
function endless(size: number): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024));
        sent += 1024 * 1024;
      },
    }),
  );
}

describe('the catalogue', () => {
  it('lists the CC0 archives, marked as not installed', async () => {
    const { offers } = make();
    const result = await offers.archives();
    expect(result).toEqual({
      ok: true,
      archives: [
        {
          code: 'tst1',
          name: 'Test Town Archive',
          period: '1798/1909',
          records: 6379,
          modified: '2026-02-01',
          installed: 'no',
        },
        {
          code: 'tst2',
          name: 'Voorbeeldstad Archief',
          period: null,
          records: null,
          modified: null,
          installed: 'no',
        },
      ],
    });
  });

  it('is asked for once an hour, and not twice at the same time', async () => {
    const { offers, network, now } = make();
    await Promise.all([offers.list(), offers.list()]);
    await offers.list();
    expect(network.urls()).toEqual([CATALOGUE]);
    now.t += 59 * 60 * 1000;
    await offers.list();
    expect(network.urls()).toEqual([CATALOGUE]);
    now.t += 2 * 60 * 1000;
    await offers.list();
    expect(network.urls()).toEqual([CATALOGUE, CATALOGUE]);
  });

  it('hints an update only when the catalogue day is after the pack source day', async () => {
    const packs = fakePacks([pack({ sourceModified: '2026-01-01' })]);
    const { offers } = make({}, packs);
    const first = await offers.archives();
    expect(first.ok && first.archives[0]?.installed).toBe('maybe-update');
    packs.state.packs = [pack({ sourceModified: '2026-02-01' })];
    const second = await offers.archives();
    expect(second.ok && second.archives[0]?.installed).toBe('yes');
    packs.state.packs = [pack({ sourceModified: null })];
    const third = await offers.archives();
    expect(third.ok && third.archives[0]?.installed).toBe('yes');
  });

  it('says why when the catalogue cannot be had or read', async () => {
    expect(
      await make({ [CATALOGUE]: () => new Response('no', { status: 503 }) }).offers.archives(),
    ).toEqual({ ok: false, message: 'www.openarchieven.nl answered 503.' });
    const unreadable = await make({ [CATALOGUE]: () => new Response('<html>') }).offers.archives();
    expect(unreadable.ok).toBe(false);
    const notAList = await make({ [CATALOGUE]: () => new Response('{}') }).offers.archives();
    expect(notAList).toMatchObject({ ok: false });
  });

  it('refuses a catalogue larger than 8 MB, given or streamed', async () => {
    const given = await make({
      [CATALOGUE]: () =>
        new Response('[]', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
    }).offers.archives();
    expect(given).toMatchObject({ ok: false, message: expect.stringContaining('larger') });
    const streamed = await make({ [CATALOGUE]: () => endless(9 * 1024 * 1024) }).offers.archives();
    expect(streamed).toMatchObject({ ok: false, message: expect.stringContaining('larger') });
  });
});

describe('requests', () => {
  it('carry only the address, the method and the user agent, and follow no redirect', async () => {
    const { offers, network } = make();
    await offers.list();
    await offers.describe('tst1');
    expect(network.calls.length).toBeGreaterThan(3);
    for (const call of network.calls) {
      expect(Object.keys(call.init).sort()).toEqual([
        'credentials',
        'headers',
        'method',
        'redirect',
        'signal',
      ]);
      expect(call.init.redirect).toBe('error');
      expect(call.init.credentials).toBe('omit');
      expect(call.init.headers).toEqual({ 'user-agent': userAgentOf('9.9.9') });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.url).not.toMatch(/\?/);
    }
    expect(network.calls.map((call) => call.method)).toEqual(['GET', 'GET', 'HEAD', 'HEAD']);
  });

  it('fail with a message when a redirect would have been followed', async () => {
    const fetch: PackFetch = () => Promise.reject(new TypeError('redirect mode is set to error'));
    const offers = new PackOffers({ fetch, appVersion: '1', packs: fakePacks().manager });
    const result = await offers.archives();
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('redirect') });
  });

  it('refuse an answer that came from another host', async () => {
    const elsewhere = () => {
      const response = new Response(fixture('catalogue.sample.jsonld'));
      Object.defineProperty(response, 'url', { value: 'https://example.com/x' });
      return response;
    };
    const result = await make({ [CATALOGUE]: elsewhere }).offers.archives();
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('somewhere else') });
  });
});

describe('describe', () => {
  it('reads the page and the files, and gives the sizes, the estimate and the expiry', async () => {
    const { offers, network } = make();
    const result = await offers.describe('tst1');
    expect(result).toEqual({
      ok: true,
      offer: {
        code: 'tst1',
        name: 'Test Town Archive',
        period: '1798/1909',
        records: 6379,
        pageUrl: PAGE,
        files: [
          { url: FILE_H, bytes: 1000 },
          { url: FILE_G, bytes: 2000 },
        ],
        downloadBytes: 3000,
        // records x 735 is larger than the files x 12.5
        estimateBytes: 6379 * 735,
        freeBytes: 10,
        installed: 'no',
        expiresAt: 1_000_000 + 15 * 60 * 1000,
      },
    });
    expect(network.urls()).toEqual([CATALOGUE, PAGE, FILE_H, FILE_G]);
  });

  it('estimates 12.5 times the files when that is more than the records', async () => {
    const { offers } = make({
      [FILE_H]: () => new Response(null, { headers: { 'content-length': '10000000' } }),
    });
    const result = await offers.describe('tst1');
    expect(result.ok && result.offer.estimateBytes).toBe(Math.round(10_002_000 * 12.5));
  });

  it('refuses a code that is not in the catalogue, without asking for its page', async () => {
    const { offers, network } = make();
    const result = await offers.describe('tst3');
    expect(result).toEqual({
      ok: false,
      message: 'This archive is not in the catalogue of Open Archives.',
    });
    expect(network.urls()).toEqual([CATALOGUE]);
  });

  it('refuses a page that does not say CC0', async () => {
    const { offers } = make({
      [PAGE]: () => new Response(fixture('dataset-page-nolicence.html')),
    });
    expect(await offers.describe('tst1')).toEqual({
      ok: false,
      message: "This archive's page does not say it is CC0.",
    });
  });

  it('refuses a page with no CSV file', async () => {
    const { offers } = make({ [PAGE]: () => new Response(fixture('dataset-page-nocsv.html')) });
    expect(await offers.describe('tst1')).toEqual({
      ok: false,
      message: 'This archive offers no CSV files.',
    });
  });

  it('fails when a file has no length', async () => {
    const { offers } = make({ [FILE_G]: () => new Response(null, { headers: { etag: '"bbb"' } }) });
    const result = await offers.describe('tst1');
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('tst1.bsg.csv.gz'),
    });
    expect(offers.specOf('tst1')).toBeNull();
  });

  it('refuses a page larger than 2 MB', async () => {
    const { offers } = make({ [PAGE]: () => endless(3 * 1024 * 1024) });
    expect(await offers.describe('tst1')).toMatchObject({
      ok: false,
      message: expect.stringContaining('larger'),
    });
  });

  it('says the pack is current when the files are those it was made from, and an update when not', async () => {
    const same = [
      { url: FILE_H, bytes: 1000, etag: '"aaa"' },
      { url: FILE_G, bytes: 2000, etag: '"bbb"' },
    ];
    const packs = fakePacks([pack()], metaOf(same));
    const { offers } = make({}, packs);
    const current = await offers.describe('tst1');
    expect(current.ok && current.offer.installed).toBe('current');

    packs.state.meta = metaOf([same[0]!, { ...same[1]!, etag: '"changed"' }]);
    const changed = await offers.describe('tst1');
    expect(changed.ok && changed.offer.installed).toBe('update');

    packs.state.meta = metaOf([same[0]!]);
    const fewer = await offers.describe('tst1');
    expect(fewer.ok && fewer.offer.installed).toBe('update');

    packs.state.meta = metaOf(same);
    packs.state.packs = [pack({ state: 'rebuild' })];
    const rebuild = await offers.describe('tst1');
    expect(rebuild.ok && rebuild.offer.installed).toBe('update');
  });
});

describe('specOf and install', () => {
  it('gives no spec for a code that was not described', async () => {
    const { offers } = make();
    await offers.list();
    expect(offers.specOf('tst1')).toBeNull();
    expect(offers.install('tst1')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Look'),
    });
  });

  it('builds the spec from the look it holds: sizes and ETags from the files, nothing from the caller', async () => {
    const { offers } = make();
    await offers.describe('tst1');
    expect(offers.specOf('tst1')).toEqual({
      id: 'oatst1',
      kind: 'open-archives',
      title: 'Test Town Archive',
      sourceName: 'Open Archives',
      sourceUrl: PAGE,
      licence: 'CC0 1.0',
      credit: 'Open Archives (openarchieven.nl) and the archive',
      files: [
        { url: FILE_H, bytes: 1000, etag: '"aaa"' },
        { url: FILE_G, bytes: 2000, etag: '"bbb"' },
      ],
      sourceModified: '2026-02-01',
    });
  });

  it('lets the look go after 15 minutes, and never looks again by itself', async () => {
    const { offers, network, now, packs } = make();
    packs.state.freeBytes = null;
    await offers.describe('tst1');
    const asked = network.calls.length;
    now.t += 15 * 60 * 1000 - 1;
    expect(offers.specOf('tst1')).not.toBeNull();
    now.t += 1;
    expect(offers.specOf('tst1')).toBeNull();
    expect(offers.install('tst1')).toMatchObject({ ok: false });
    expect(network.calls.length).toBe(asked);
    expect(packs.installed).toEqual([]);
  });

  it('lets go of expired looks whenever the map is read or written', async () => {
    const page2 = 'https://www.openarchieven.nl/datasets/tst2';
    const file2 = 'https://oa-export.s3.nl-ams.scw.cloud/csv/tst2.aa.csv.gz';
    const html = `<a rel="license" href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a><a href="${file2}">x</a>`;
    const { offers, now } = make({
      [page2]: () => new Response(html),
      [file2]: () => new Response(null, { headers: { 'content-length': '10' } }),
    });
    await offers.describe('tst1');
    expect(offers.heldCount).toBe(1);
    now.t += 15 * 60 * 1000;
    // A write of another code drops the expired one.
    await offers.describe('tst2');
    expect(offers.heldCount).toBe(1);
    expect(offers.specOf('tst2')).not.toBeNull();
    // A read drops the expired one too.
    now.t += 15 * 60 * 1000;
    expect(offers.specOf('tst1')).toBeNull();
    expect(offers.heldCount).toBe(0);
  });

  it('holds the newer look when two looks at one code end in the wrong order', async () => {
    const network = fakeNetwork();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pages = 0;
    const fetch: PackFetch = async (url, init) => {
      if (url === PAGE) {
        pages += 1;
        // The first look is held up at its page until the second has ended.
        if (pages === 1) await gate;
      }
      return network.fetch(url, init);
    };
    const now = { t: 1_000_000 };
    const offers = new PackOffers({
      fetch,
      appVersion: '1',
      packs: fakePacks().manager,
      now: () => now.t,
    });
    const older = offers.describe('tst1');
    // Let the older one reach its page before the newer one starts.
    await vi.waitFor(() => expect(pages).toBe(1));
    now.t += 1000;
    const newer = await offers.describe('tst1');
    // The older one ends last, and later by the clock.
    now.t += 5000;
    release();
    const olderResult = await older;
    if (!newer.ok || !olderResult.ok) throw new Error('both looks should have worked');
    expect(olderResult.offer.expiresAt).toBeGreaterThan(newer.offer.expiresAt);
    // The older one still answered its caller, but only the newer is held.
    expect(offers.heldCount).toBe(1);
    now.t = newer.offer.expiresAt - 1;
    expect(offers.specOf('tst1')).not.toBeNull();
    now.t = newer.offer.expiresAt;
    expect(offers.specOf('tst1')).toBeNull();
  });

  it('starts the install from the held look', async () => {
    const { offers, packs } = make();
    packs.state.freeBytes = null;
    await offers.describe('tst1');
    expect(offers.install('tst1')).toEqual({ ok: true });
    expect(packs.installed).toHaveLength(1);
    expect(packs.installed[0]?.id).toBe('oatst1');
  });

  it('refuses while a job runs, when the room is short, and gives the manager its refusal', async () => {
    const { offers, packs } = make();
    await offers.describe('tst1');
    packs.state.running = true;
    packs.state.freeBytes = null;
    expect(offers.install('tst1')).toMatchObject({
      ok: false,
      message: expect.stringContaining('Another pack'),
    });
    packs.state.running = false;
    packs.state.freeBytes = 1000;
    expect(offers.install('tst1')).toMatchObject({
      ok: false,
      message: expect.stringContaining('free space'),
    });
    expect(packs.installed).toEqual([]);
    packs.state.freeBytes = null;
    packs.manager.install = () => {
      throw new PackError('This pack is being removed.');
    };
    expect(offers.install('tst1')).toEqual({ ok: false, message: 'This pack is being removed.' });
  });
});
