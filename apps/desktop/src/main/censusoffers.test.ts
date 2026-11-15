import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CENSUS_LISTING_URL, NARA_CENSUS_PACK_KIND, censusStateUrl } from '@rulz/connectors';
import { openAppDatabase, type Db, type PackMeta } from '@rulz/db';
import type { CensusStatesResult, PackInfo } from '../shared/ipc';
import { CENSUS_FIXTURES } from './censusfixtures';
import { CENSUS_ESTIMATE_FACTOR, CensusOffers } from './censusoffers';
import type { OfferPacks } from './packoffers';
import { inProcessBuildRunner } from './packbuild';
import { PackError, PackManager, type PackFetch, type PackInstallSpec } from './packs';
import { PackSearch, inProcessSearchChannel } from './packsearch';
import { userAgentOf } from './records';

// The listing and the state file are made up.
const listingXml = readFileSync(join(CENSUS_FIXTURES, 'listing.sample.xml'), 'utf8');
const DE_URL = censusStateUrl('de');

interface Call {
  url: string;
  init: Parameters<PackFetch>[1];
}

/** A fetch that answers from a table of addresses and keeps every request it was given. */
function fakeNetwork(answers: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const table: Record<string, () => Response | Promise<Response>> = {
    [CENSUS_LISTING_URL]: () => new Response(listingXml),
    ...answers,
  };
  const fetch: PackFetch = (url, init) => {
    calls.push({ url, init });
    const answer = table[url];
    return Promise.resolve(answer === undefined ? new Response('no', { status: 404 }) : answer());
  };
  return { fetch, calls };
}

function pack(over: Partial<PackInfo> = {}): PackInfo {
  return {
    id: 'c50de',
    kind: NARA_CENSUS_PACK_KIND,
    title: '1950 census: Delaware',
    sourceName: 'x',
    licence: 'x',
    credit: '',
    rows: 4,
    bytes: 1,
    downloadedAt: '2026-01-01',
    state: 'ready',
    sourceModified: null,
    ...over,
  };
}

function fakePacks(packs: PackInfo[] = [], meta: PackMeta | null = null) {
  const installed: PackInstallSpec[] = [];
  const state = {
    freeBytes: 1e12 as number | null,
    packs,
    running: false,
    meta,
    failWith: null as Error | null,
  };
  const manager: OfferPacks = {
    state: () => ({ freeBytes: state.freeBytes, packs: state.packs }),
    metaOf: () => state.meta,
    install: (spec) => {
      if (state.failWith !== null) throw state.failWith;
      installed.push(spec);
    },
    get running() {
      return state.running;
    },
    reserveBytes: 100,
  };
  return { manager, state, installed };
}

function metaWith(files: { url: string; bytes: number; etag: string | null }[]): PackMeta {
  return {
    packId: 'c50de',
    kind: NARA_CENSUS_PACK_KIND,
    builderVersion: 1,
    title: 't',
    sourceName: 's',
    sourceUrl: 'https://1950census.archives.gov',
    licence: 'l',
    credit: 'c',
    files: files.map((file) => ({ ...file, sha256: '0'.repeat(64), modified: null })),
    rows: 4,
    downloadedAt: '2026-01-01',
    builtAt: '2026-01-01T00:00:00.000Z',
  };
}

function make(
  answers: Record<string, () => Response | Promise<Response>> = {},
  packs = fakePacks(),
) {
  const now = { t: 1_000_000 };
  const network = fakeNetwork(answers);
  const offers = new CensusOffers({
    fetch: network.fetch,
    appVersion: '9.9.9',
    packs: packs.manager,
    now: () => now.t,
  });
  return { offers, network, packs, now };
}

function listed(result: CensusStatesResult) {
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('listing the states', () => {
  it('lists the states of the bucket with names from the app, sizes, days and an estimate', async () => {
    const { offers, now } = make();
    const result = listed(await offers.states());
    expect(result.states).toEqual([
      {
        code: 'de',
        name: 'Delaware',
        bytes: 4_800_000,
        modified: '2022-04-01',
        estimateBytes: Math.round(4_800_000 * CENSUS_ESTIMATE_FACTOR),
        installed: 'no',
      },
      {
        code: 'gu',
        name: 'Guam',
        bytes: 4096,
        modified: '2022-04-01',
        estimateBytes: Math.round(4096 * CENSUS_ESTIMATE_FACTOR),
        installed: 'no',
      },
      {
        code: 'wy',
        name: 'Wyoming',
        bytes: 2_200_000,
        modified: '2022-04-01',
        estimateBytes: Math.round(2_200_000 * CENSUS_ESTIMATE_FACTOR),
        installed: 'no',
      },
    ]);
    expect(result.freeBytes).toBe(1e12);
    expect(result.expiresAt).toBe(now.t + 15 * 60 * 1000);
  });

  it('asks the bucket for its listing and for nothing else, sending only its name', async () => {
    const { offers, network } = make();
    await offers.states();
    expect(network.calls.map((call) => call.url)).toEqual([CENSUS_LISTING_URL]);
    expect(CENSUS_LISTING_URL).toBe(
      'https://nara-1950-census.s3.us-east-2.amazonaws.com/?list-type=2&prefix=metadata/json/',
    );
    const init = network.calls[0]?.init;
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toEqual({ 'user-agent': userAgentOf('9.9.9') });
    expect(init?.signal.aborted).toBe(false);
  });

  it('keeps the listing for an hour', async () => {
    const { offers, network, now } = make();
    await offers.states();
    now.t += 59 * 60 * 1000;
    await offers.states();
    expect(network.calls).toHaveLength(1);
    now.t += 2 * 60 * 1000;
    await offers.states();
    expect(network.calls).toHaveLength(2);
  });

  it('asks once for two listings at the same time', async () => {
    const { offers, network } = make();
    await Promise.all([offers.states(), offers.states()]);
    expect(network.calls).toHaveLength(1);
  });

  it('says when the bucket cannot be reached, answers badly, or sends too much or something else', async () => {
    const down = make({
      [CENSUS_LISTING_URL]: () => {
        throw new Error('offline');
      },
    });
    const refused = await down.offers.states();
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.message).toContain('could not be reached');

    const missing = await make({
      [CENSUS_LISTING_URL]: () => new Response('x', { status: 503 }),
    }).offers.states();
    expect(missing).toEqual({
      ok: false,
      message: 'nara-1950-census.s3.us-east-2.amazonaws.com answered 503.',
    });

    const junk = await make({
      [CENSUS_LISTING_URL]: () => new Response('<html></html>'),
    }).offers.states();
    expect(junk.ok === false && junk.message).toContain('could not be read');

    const big = await make({
      [CENSUS_LISTING_URL]: () => new Response(`<ListBucketResult>${' '.repeat(1024 * 1024 + 1)}`),
    }).offers.states();
    expect(big.ok === false && big.message).toContain('larger than it should be');

    const declared = await make({
      [CENSUS_LISTING_URL]: () =>
        new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
    }).offers.states();
    expect(declared.ok === false && declared.message).toContain('larger than it should be');

    const elsewhere = await make({
      [CENSUS_LISTING_URL]: () => {
        const response = new Response(listingXml);
        Object.defineProperty(response, 'url', { value: 'https://elsewhere.invalid/x' });
        return response;
      },
    }).offers.states();
    expect(elsewhere.ok === false && elsewhere.message).toContain('from somewhere else');
  });

  it('marks an installed state as current when the pack was made from the listed file, and as an update otherwise', async () => {
    const same = fakePacks(
      [pack()],
      metaWith([{ url: DE_URL, bytes: 4_800_000, etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' }]),
    );
    const states = listed(await make({}, same).offers.states()).states;
    expect(states.map((state) => [state.code, state.installed])).toEqual([
      ['de', 'current'],
      ['gu', 'no'],
      ['wy', 'no'],
    ]);

    const changed = fakePacks(
      [pack()],
      metaWith([{ url: DE_URL, bytes: 4_800_000, etag: '"other"' }]),
    );
    expect(listed(await make({}, changed).offers.states()).states[0]?.installed).toBe('update');

    const rebuild = fakePacks([pack({ state: 'rebuild' })], null);
    expect(listed(await make({}, rebuild).offers.states()).states[0]?.installed).toBe('update');
  });
});

describe('installing a state', () => {
  it('refuses a state that was not listed, and does not list silently', async () => {
    const { offers, network, packs } = make();
    expect(offers.install('de')).toEqual({
      ok: false,
      message: 'The list of states is out of date. List them again, then install.',
    });
    expect(network.calls).toHaveLength(0);
    expect(packs.installed).toEqual([]);
  });

  it('installs from the listing held, with the size and ETag it listed', async () => {
    const { offers, packs } = make();
    await offers.states();
    expect(offers.install('de')).toEqual({ ok: true });
    expect(packs.installed).toEqual([
      {
        id: 'c50de',
        kind: 'nara-1950-areas',
        title: '1950 census: Delaware',
        sourceName: '1950 US Census (National Archives)',
        sourceUrl: 'https://1950census.archives.gov',
        licence: 'Public domain (US Government work)',
        credit: '1950 Census, National Archives and Records Administration',
        files: [{ url: DE_URL, bytes: 4_800_000, etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' }],
        sourceModified: '2022-04-01',
      },
    ]);
    // A state the listing did not hold cannot be installed.
    expect(offers.install('zz').ok).toBe(false);
    expect(offers.install('xx').ok).toBe(false);
  });

  it('holds the listing for 15 minutes', async () => {
    const { offers, packs, now } = make();
    await offers.states();
    now.t += 14 * 60 * 1000;
    expect(offers.install('gu')).toEqual({ ok: true });
    now.t += 2 * 60 * 1000;
    expect(offers.install('wy').ok).toBe(false);
    expect(offers.specOf('wy')).toBeNull();
    expect(packs.installed).toHaveLength(1);
  });

  it('refuses while another job runs, when the disk is too full, and passes on what the manager refuses', async () => {
    const { offers, packs } = make();
    await offers.states();
    packs.state.running = true;
    expect(offers.install('de').ok).toBe(false);
    packs.state.running = false;
    packs.state.freeBytes = 1000;
    const full = offers.install('de');
    expect(full.ok === false && full.message).toContain('not enough free space');
    packs.state.freeBytes = null;
    packs.state.failWith = new PackError('This pack is being removed.');
    expect(offers.install('de')).toEqual({ ok: false, message: 'This pack is being removed.' });
    expect(packs.installed).toEqual([]);
  });
});

describe('the download that follows', () => {
  let dir: string;
  let appDb: Db;
  let manager: PackManager;
  const body = readFileSync(join(CENSUS_FIXTURES, 'state-sample.json'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rulz-census-offers-'));
    appDb = openAppDatabase(':memory:');
  });

  afterEach(async () => {
    await manager.shutdown(1000);
    appDb.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** An offers object over a real manager, whose network serves the state file with the given ETag. */
  function over(etag: string, listedEtag = '"abc"') {
    const requests: string[] = [];
    const xml = `<ListBucketResult><Contents><Key>metadata/json/de.json</Key><LastModified>2022-04-01T00:00:00.000Z</LastModified><ETag>&quot;${listedEtag.replaceAll('"', '')}&quot;</ETag><Size>${body.length}</Size></Contents></ListBucketResult>`;
    const fetch: PackFetch = (url, init) => {
      requests.push(`${init.method} ${url}`);
      if (url === CENSUS_LISTING_URL) return Promise.resolve(new Response(xml));
      if (url !== DE_URL) return Promise.resolve(new Response('no', { status: 404 }));
      const headers = { 'content-length': String(body.length), etag };
      return Promise.resolve(
        init.method === 'HEAD'
          ? new Response(null, { headers })
          : new Response(new Uint8Array(body), { headers }),
      );
    };
    manager = new PackManager({
      appDb,
      defaultRoot: join(dir, 'packs'),
      fetch,
      appVersion: '0.0.0',
      search: new PackSearch({
        spawn: () => inProcessSearchChannel(),
        pathOf: (id) => manager.pathOf(id),
      }),
      build: inProcessBuildRunner(),
      reserveBytes: 1,
    });
    const offers = new CensusOffers({ fetch, appVersion: '0.0.0', packs: manager });
    return { offers, requests };
  }

  it('installs the state when size and ETag are as listed, asking only the listing and the file', async () => {
    const { offers, requests } = over('"abc"');
    await offers.states();
    expect(offers.install('de')).toEqual({ ok: true });
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'done', rows: 4 });
    expect(manager.state().packs.map((p) => `${p.id} ${p.state} ${p.kind}`)).toEqual([
      'c50de ready nara-1950-areas',
    ]);
    expect(requests).toEqual([`GET ${CENSUS_LISTING_URL}`, `HEAD ${DE_URL}`, `GET ${DE_URL}`]);
    // Listing again, the pack is the one the listing's file makes.
    expect(listed(await offers.states()).states[0]?.installed).toBe('current');
  });

  it('refuses the file when its ETag is not the one listed, and installs nothing', async () => {
    const { offers } = over('"changed"', '"abc"');
    await offers.states();
    expect(offers.install('de')).toEqual({ ok: true });
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(manager.state().job?.message).toContain('changed since they were listed');
    expect(manager.state().packs).toEqual([]);
  });
});
