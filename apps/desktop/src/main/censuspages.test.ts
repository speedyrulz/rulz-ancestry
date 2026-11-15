import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAppDatabase, type Db } from '@rulz/db';
import type { CensusPageImageResult } from '../shared/ipc';
import { CENSUS_FIXTURES, TINY_JPEG, buildCensusPack } from './censusfixtures';
import { CENSUS_IMAGE_CAP, CensusService } from './censuspages';
import { inProcessBuildRunner } from './packbuild';
import { PackManager, type PackFetch } from './packs';
import { PackSearch, inProcessSearchChannel } from './packsearch';
import { userAgentOf } from './records';

// The state, counties, descriptions and folders are made up.
const BUCKET = 'https://nara-1950-census.s3.us-east-2.amazonaws.com';
const PAGE_1_2 = `${BUCKET}/1950census/10-Testland/10-Testland-000101/10-Testland-000101-0002.jpg`;

let dir: string;
let appDb: Db;
let manager: PackManager;
let census: CensusService;
let agreed: boolean;
let opened: string[];
let sleeps: number[];
let clock: { t: number };
/** What the network does for an address; a test can put its own in place. */
let answer: (url: string, init: Parameters<PackFetch>[1]) => Promise<Response>;
let requests: { url: string; init: Parameters<PackFetch>[1] }[];

const jpeg = (): Response => new Response(new Uint8Array(TINY_JPEG));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rulz-census-pages-'));
  appDb = openAppDatabase(':memory:');
  agreed = true;
  opened = [];
  sleeps = [];
  clock = { t: 5_000_000 };
  requests = [];
  answer = () => Promise.resolve(jpeg());
  await buildCensusPack(join(dir, 'packs'), { file: join(CENSUS_FIXTURES, 'state-sample.json') });
  manager = new PackManager({
    appDb,
    defaultRoot: join(dir, 'packs'),
    fetch: () => Promise.reject(new Error('no network for the manager')),
    appVersion: '0.0.0',
    search: new PackSearch({
      spawn: () => inProcessSearchChannel(),
      pathOf: (id) => manager.pathOf(id),
    }),
    build: inProcessBuildRunner(),
    reserveBytes: 1,
  });
  census = new CensusService({
    packs: manager,
    fetch: (url, init) => {
      requests.push({ url, init });
      return answer(url, init);
    },
    appVersion: '9.9.9',
    agreed: () => agreed,
    openInBrowser: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    now: () => clock.t,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      return Promise.resolve();
    },
  });
});

afterEach(async () => {
  census.reset();
  await manager.shutdown(1000);
  appDb.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const gen = (packId = 'c50de') => manager.generationOf(packId);
const view = (id: number, page: number, packId = 'c50de') =>
  census.pageImage({ packId, id, generation: gen(packId), page });

function problemOf(result: CensusPageImageResult) {
  if (result.ok) throw new Error('the page was served');
  return result.problem;
}

describe('browsing a pack of the census', () => {
  it('lists the counties with how many districts each has, and asks the internet for nothing', async () => {
    expect(await census.counties('c50de')).toEqual({
      ok: true,
      counties: [
        { name: 'Alder County', districts: 2 },
        { name: 'Birch County', districts: 1 },
        { name: 'Cedar City', districts: 1 },
      ],
    });
    expect(requests).toEqual([]);
  });

  it('lists the districts of a county with the start of each description, and pages and filters them', async () => {
    const all = await census.districts({
      packId: 'c50de',
      county: 'Alder County',
      filter: '',
      offset: 0,
    });
    expect(all).toEqual({
      ok: true,
      total: 2,
      districts: [
        {
          id: 1,
          generation: 0,
          ed: '1-1',
          descriptionStart:
            'Ward 1: that part of the village of Tarnwick bounded by Mill Road, the creek and Oak Street. Includes the school.',
          pages: 3,
        },
        {
          id: 2,
          generation: 0,
          ed: '1-2',
          descriptionStart:
            'Ward 2: the rest of Tarnwick, and the farms north of the creek to the county line.',
          pages: 2,
        },
      ],
    });
    const second = await census.districts({
      packId: 'c50de',
      county: 'Alder County',
      filter: '',
      offset: 1,
    });
    expect(second.ok && second.districts.map((d) => d.ed)).toEqual(['1-2']);
    const school = await census.districts({
      packId: 'c50de',
      county: 'Alder County',
      filter: 'SCHOOL',
      offset: 0,
    });
    expect(school.ok && school.districts.map((d) => d.ed)).toEqual(['1-1']);
    const none = await census.districts({
      packId: 'c50de',
      county: 'Alder County',
      filter: 'quarry',
      offset: 0,
    });
    expect(none).toEqual({ ok: true, total: 0, districts: [] });
    // A district is found in its own county only.
    const other = await census.districts({
      packId: 'c50de',
      county: 'Birch County',
      filter: 'school',
      offset: 0,
    });
    expect(other.ok && other.total).toBe(0);
  });

  it('cuts a long description to 200 characters in a list, and gives it whole in the district', async () => {
    const long = 'word '.repeat(100).trim();
    const file = join(dir, 'long.json');
    writeFileSync(
      file,
      JSON.stringify({
        state: 'Testland',
        abbreviation: 'DE',
        'county/city': [
          {
            name: 'Long County',
            enumeration: [
              {
                ed: '9-9',
                description: long,
                schedule_image: { folder: 'f/a', files: ['a-0001.jpg'] },
              },
            ],
          },
        ],
      }),
    );
    await manager.remove('c50de');
    await buildCensusPack(join(dir, 'packs'), { file });
    const list = await census.districts({
      packId: 'c50de',
      county: 'Long County',
      filter: '',
      offset: 0,
    });
    const start = list.ok ? (list.districts[0]?.descriptionStart ?? '') : '';
    expect(start.length).toBeLessThanOrEqual(200);
    expect(start.endsWith('…')).toBe(true);
    const district = await census.district({ packId: 'c50de', id: 1, generation: gen() });
    expect(district.ok && district.district.description).toBe(long);
  });

  it('gives a district with its full description, roll, pages and no list of files', async () => {
    const result = await census.district({ packId: 'c50de', id: 3, generation: gen() });
    expect(result).toEqual({
      ok: true,
      district: {
        packId: 'c50de',
        id: 3,
        generation: 0,
        state: 'Testland',
        county: 'Birch County',
        ed: '2-1',
        description:
          'Quillhaven township, including the hamlet of Upper Quillhaven and the quarry.',
        reservation: 'Sample Reservation',
        roll: 'T628-13',
        pages: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain('.jpg');
  });

  it('refuses a district that is not there, and a pack that is not an installed census pack', async () => {
    expect((await census.district({ packId: 'c50de', id: 99, generation: gen() })).ok).toBe(false);
    expect((await census.district({ packId: 'c50de', id: 0, generation: gen() })).ok).toBe(false);
    expect((await census.district({ packId: 'c50zz', id: 1, generation: gen() })).ok).toBe(false);
    expect((await census.district({ packId: '../x', id: 1, generation: gen() })).ok).toBe(false);
    expect((await census.counties('c50zz')).ok).toBe(false);
    expect(
      (await census.districts({ packId: 'c50zz', county: 'x', filter: '', offset: 0 })).ok,
    ).toBe(false);
  });

  it('opens a district at the National Archives, and says so when there is no such district', async () => {
    expect(await census.openDistrict({ packId: 'c50de', id: 1, generation: gen() })).toEqual({
      ok: true,
    });
    expect(opened).toEqual([
      'https://1950census.archives.gov/search/?county=Alder%20County&ed=1-1&state=DE',
    ]);
    expect((await census.openDistrict({ packId: 'c50de', id: 77, generation: gen() })).ok).toBe(
      false,
    );
    expect(opened).toHaveLength(1);
    expect(requests).toEqual([]);
  });
});

describe('a page image', () => {
  it("is fetched from the bucket, at the pack's own address, and given back as bytes", async () => {
    const result = await view(1, 2);
    expect(result).toEqual({ ok: true, bytes: TINY_JPEG, page: 2, pages: 3 });
    expect(requests.map((r) => r.url)).toEqual([PAGE_1_2]);
    const init = requests[0]?.init;
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    expect(init?.headers).toEqual({ 'user-agent': userAgentOf('9.9.9') });
  });

  it('needs the notice agreed, and asks nothing before it is', async () => {
    agreed = false;
    expect(problemOf(await view(1, 1)).kind).toBe('notice');
    expect(requests).toEqual([]);
  });

  it('refuses a district that is not there, a page that is not one, and a pack that is not a census pack', async () => {
    expect(problemOf(await view(99, 1)).kind).toBe('source');
    for (const page of [0, 4, -1, 1.5, Number.NaN]) {
      expect(problemOf(await view(1, page)).kind).toBe('source');
    }
    expect(problemOf(await view(1, 1, 'c50zz')).kind).toBe('source');
    expect(problemOf(await view(1, 1, '../c50de')).kind).toBe('source');
    expect(requests).toEqual([]);
  });

  it('refuses an answer that is not a JPEG, however it is named', async () => {
    answer = () =>
      Promise.resolve(
        new Response('<html>not an image</html>', { headers: { 'content-type': 'image/jpeg' } }),
      );
    expect(problemOf(await view(1, 1)).message).toContain('not a JPEG');
    // The bucket calls its images binary/octet-stream; the first bytes decide.
    answer = () =>
      Promise.resolve(
        new Response(new Uint8Array(TINY_JPEG), {
          headers: { 'content-type': 'binary/octet-stream' },
        }),
      );
    expect((await view(1, 1)).ok).toBe(true);
    // Too short to tell.
    answer = () => Promise.resolve(new Response(new Uint8Array([0xff, 0xd8])));
    expect(problemOf(await view(1, 1)).message).toContain('not a JPEG');
  });

  it('refuses an image over 20 MB, by its length and by what streams in, and stops reading', async () => {
    expect(CENSUS_IMAGE_CAP).toBe(20 * 1024 * 1024);
    answer = () =>
      Promise.resolve(
        new Response(new Uint8Array(TINY_JPEG), {
          headers: { 'content-length': String(CENSUS_IMAGE_CAP + 1) },
        }),
      );
    expect(problemOf(await view(1, 1)).message).toContain('larger than it should be');

    let sent = 0;
    let cancelled = false;
    answer = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = new Uint8Array(1024 * 1024);
              if (sent === 0) chunk.set(TINY_JPEG);
              controller.enqueue(chunk);
              sent += 1;
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    expect(problemOf(await view(1, 1)).message).toContain('larger than it should be');
    expect(sent).toBeLessThanOrEqual(23);
    expect(cancelled).toBe(true);
  });

  it('says so when the bucket answers with an error, from another host, or cannot be reached', async () => {
    answer = () => Promise.resolve(new Response('no', { status: 403 }));
    expect(problemOf(await view(1, 1))).toMatchObject({ kind: 'failed' });
    answer = () => {
      const response = jpeg();
      Object.defineProperty(response, 'url', { value: 'https://elsewhere.invalid/p.jpg' });
      return Promise.resolve(response);
    };
    expect(problemOf(await view(1, 1)).message).toContain('from somewhere else');
    answer = () => Promise.reject(new Error('offline'));
    expect(problemOf(await view(1, 1))).toMatchObject({ kind: 'offline' });
  });

  it('leaves at least a second between two requests', async () => {
    await view(1, 1);
    expect(sleeps).toEqual([]);
    await view(1, 2);
    expect(sleeps).toEqual([1000]);
    clock.t += 400;
    await view(1, 3);
    expect(sleeps).toEqual([1000, 600]);
    clock.t += 5000;
    await view(1, 1);
    expect(sleeps).toEqual([1000, 600]);
  });

  it('is given up by a newer request, and by the window closing', async () => {
    const hang = (url: string, init: Parameters<PackFetch>[1]) =>
      new Promise<Response>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        void url;
      });
    answer = hang;
    const first = view(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    answer = () => Promise.resolve(jpeg());
    const second = await view(1, 2);
    expect(problemOf(await first).kind).toBe('cancelled');
    expect(second.ok).toBe(true);

    answer = hang;
    const third = view(1, 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    census.cancelImage();
    expect(problemOf(await third).kind).toBe('cancelled');
  });

  it('is given up when the pack is replaced or removed', async () => {
    answer = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const pending = view(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await manager.remove('c50de')).toEqual({ ok: true });
    expect(problemOf(await pending).kind).toBe('cancelled');
    // The pack is gone: nothing more is asked.
    expect(problemOf(await view(1, 1)).kind).toBe('source');
  });
});

describe('a row of a pack that was replaced', () => {
  const STALE = 'This pack was replaced or removed; choose the district again.';

  it('is refused by every request that names a district, with the old generation', async () => {
    const list = await census.districts({
      packId: 'c50de',
      county: 'Alder County',
      filter: '',
      offset: 0,
    });
    const old = list.ok ? (list.districts[0]?.generation ?? -1) : -1;
    expect(old).toBe(0);
    // The pack is taken out and one is put in its place.
    await manager.remove('c50de');
    await buildCensusPack(join(dir, 'packs'), { file: join(CENSUS_FIXTURES, 'state-sample.json') });
    expect(gen()).toBeGreaterThan(old);
    const ref = { packId: 'c50de', id: 1, generation: old };
    expect(await census.district(ref)).toEqual({ ok: false, message: STALE });
    expect(await census.openDistrict(ref)).toEqual({ ok: false, message: STALE });
    const image = await census.pageImage({ ...ref, page: 1 });
    expect(problemOf(image)).toMatchObject({ kind: 'changed', message: STALE });
    expect(opened).toEqual([]);
    expect(requests).toEqual([]);
    // With the current generation the same row is served.
    expect((await census.district({ ...ref, generation: gen() })).ok).toBe(true);
  });
});

describe('a pack that is replaced or removed', () => {
  it('changes the generation of the pack when it is removed, before and after', async () => {
    const before = manager.generationOf('c50de');
    const removing = manager.remove('c50de');
    expect(manager.generationOf('c50de')).toBeGreaterThan(before);
    const during = manager.generationOf('c50de');
    await removing;
    expect(manager.generationOf('c50de')).toBeGreaterThan(during);
  });

  it('refuses a page whose pack changed between the reads and the fetch', async () => {
    let bumped = false;
    const base = manager.generationOf('c50de');
    vi.spyOn(manager, 'generationOf').mockImplementation(() => base + (bumped ? 1 : 0));
    const real = manager.get.bind(manager);
    vi.spyOn(manager, 'get').mockImplementation(async (...args) => {
      const found = await real(...args);
      bumped = true;
      return found;
    });
    expect(problemOf(await view(1, 1)).kind).toBe('changed');
    expect(requests).toEqual([]);
    expect(census.shown).toBeNull();
  });

  it('serves nothing for a request that begins while the pack is being removed', async () => {
    const removing = manager.remove('c50de');
    const result = await view(1, 1);
    await removing;
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
    expect(census.shown).toBeNull();
  });

  it('does not take a page that finished after the pack changed as the page shown', async () => {
    let bump = false;
    const base = manager.generationOf('c50de');
    vi.spyOn(manager, 'generationOf').mockImplementation(() => base + (bump ? 1 : 0));
    answer = () => {
      // The pack is replaced while the image is on its way.
      bump = true;
      return Promise.resolve(jpeg());
    };
    expect(problemOf(await view(1, 1)).kind).toBe('changed');
    expect(census.shown).toBeNull();
  });
});

describe('the page last shown', () => {
  it('is the page that was last served, and nothing before one was served', async () => {
    expect(census.shown).toBeNull();
    await view(1, 1);
    expect(census.shown).toEqual({ packId: 'c50de', id: 1, page: 1 });
    await view(2, 2);
    expect(census.shown).toEqual({ packId: 'c50de', id: 2, page: 2 });
    // A page that failed does not take its place.
    answer = () => Promise.resolve(new Response('no', { status: 404 }));
    await view(1, 1);
    expect(census.shown).toEqual({ packId: 'c50de', id: 2, page: 2 });
  });

  it('is forgotten when the pack is removed or a tree closes', async () => {
    await view(1, 1);
    census.reset();
    expect(census.shown).toBeNull();
    await view(1, 1);
    await manager.remove('c50de');
    expect(census.shown).toBeNull();
  });
});
