import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCitations, openAppDatabase, setSetting, type Db } from '@rulz/db';
import { CENSUS_PACK_KIND } from '../shared/ipc';
import type {
  AttachRecordResult,
  CensusPageImageResult,
  PersonChange,
  RecordLinkResult,
  RecordSearchResult,
  RecordSearchSetup,
  TreeState,
} from '../shared/ipc';
import { AiSessionService } from './aisession';
import { CENSUS_FIXTURES, TINY_JPEG, buildCensusPack } from './censusfixtures';
import { CensusService } from './censuspages';
import { GazetteerService } from './gazetteer';
import { SAMPLE_COUNTRIES, sampleFetch } from './gazetteersample';
import { createHandlers, type ApiHandlers, type Platform } from './handlers';
import { buildPack, inProcessBuildRunner } from './packbuild';
import { PACKS_MARKER, PackManager, type PackFetch } from './packs';
import { PackSearch, inProcessSearchChannel } from './packsearch';
import { RecordRun } from './recordrun';
import {
  RECORD_SEARCH_NOTICE_SETTING,
  RECORD_SEARCH_NOTICE_VERSION,
  RECORD_SEARCH_NOTICE_VERSION_SETTING,
  RecordSearchService,
  localDay,
  markSourceOf,
} from './records';
import { TreeSession } from './session';

// Every name, place and identifier in the fixtures is made up.
const OA_FIXTURES = join(
  import.meta.dirname,
  '../../../../packages/connectors/src/sources/open-archives/fixtures',
);
const BUCKET = 'https://nara-1950-census.s3.us-east-2.amazonaws.com';
const PAGE_URL = (page: number) =>
  `${BUCKET}/1950census/10-Testland/10-Testland-000101/10-Testland-000101-000${page}.jpg`;
const GONE = '00000000-0000-4000-8000-000000000000';

let root: string;
let appDb: Db;
let session: TreeSession;
let gazetteer: GazetteerService;
let records: RecordSearchService;
let packs: PackManager;
let census: CensusService;
let handlers: ApiHandlers;
let runs: RecordRun;
let ai: AiSessionService;
let openedInBrowser: string[];
let imageRequests: string[];
let imageAnswer: (init: Parameters<PackFetch>[1]) => Promise<Response>;

async function call<T>(method: keyof ApiHandlers, ...args: unknown[]): Promise<T> {
  return (await handlers[method](...args)) as T;
}

async function addPerson(given: string, surname: string, extra: object = {}): Promise<string> {
  const change = await call<PersonChange>('addPerson', { given, surname, ...extra });
  return change.personId;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rulz-records-census-'));
  appDb = openAppDatabase(':memory:');
  openedInBrowser = [];
  imageRequests = [];
  imageAnswer = () => Promise.resolve(new Response(new Uint8Array(TINY_JPEG)));
  session = new TreeSession({ appDb, defaultParentDir: join(root, 'Trees') });
  gazetteer = new GazetteerService({
    dir: join(root, 'gazetteer'),
    fetch: sampleFetch().fetch,
    countries: SAMPLE_COUNTRIES,
    minimums: {},
  });
  const search: PackSearch = new PackSearch({
    spawn: () => inProcessSearchChannel(),
    pathOf: (id) => join(root, 'packs', `${id}.pack`),
  });
  packs = new PackManager({
    appDb,
    defaultRoot: join(root, 'packs'),
    fetch: () => Promise.reject(new Error('no network in a test')),
    appVersion: '0.0.0',
    search,
    build: inProcessBuildRunner(),
  });
  records = new RecordSearchService({
    appDb,
    appVersion: '0.0.0',
    fetch: () => Promise.reject(new Error('no live source in a test')),
    packs,
  });
  census = new CensusService({
    packs,
    fetch: (url, init) => {
      imageRequests.push(url);
      return imageAnswer(init);
    },
    appVersion: '0.0.0',
    agreed: () => records.agreed,
    openInBrowser: (url) => {
      openedInBrowser.push(url);
      return Promise.resolve();
    },
    minGapMs: 0,
  });
  runs = new RecordRun(records, { wait: () => Promise.resolve() });
  ai = new AiSessionService(records, { appDb });
  const platform = {
    openInBrowser: (url: string) => {
      openedInBrowser.push(url);
      return Promise.resolve();
    },
  } as Platform;
  handlers = createHandlers(
    session,
    platform,
    gazetteer,
    records,
    ai,
    runs,
    packs,
    null,
    null,
    census,
  );

  // A pack of Open Archives and a pack of the census, side by side.
  const dir = join(root, 'packs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PACKS_MARKER), 'marker');
  await buildPack(
    {
      kind: 'open-archives',
      outPath: join(dir, 'tst1.pack'),
      files: ['pack-sample.csv', 'pack-sample-births.csv'].map((name) => ({
        path: join(OA_FIXTURES, name),
        url: `https://oa-export.s3.nl-ams.scw.cloud/csv/${name}`,
        bytes: 1,
        sha256: '0'.repeat(64),
        etag: null,
        modified: null,
      })),
      meta: {
        packId: 'tst1',
        title: 'Test archive',
        sourceName: 'Open Archives',
        sourceUrl: 'https://www.openarchieven.nl/',
        licence: 'CC0 1.0',
        credit: 'Test archive, via Open Archives',
        downloadedAt: '2026-03-04',
      },
      reserveBytes: 1,
    },
    { stop: () => false, progress: () => undefined },
  );
  await buildCensusPack(dir, { file: join(CENSUS_FIXTURES, 'state-sample.json') });
  packs.start();
  await call<TreeState>('createTree', { name: 'Family', parentDir: join(root, 'Trees') });
});

afterEach(async () => {
  census.reset();
  runs.clear();
  await runs.idle();
  ai.clear();
  await ai.idle();
  await packs.shutdown(500);
  gazetteer.close();
  await gazetteer.idle();
  session.shutdown();
  appDb.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const view = (id: number, page: number) =>
  call<CensusPageImageResult>('censusPageImage', {
    packId: 'c50de',
    id,
    generation: packs.generationOf('c50de'),
    page,
  });
const cite = (personId: string, id: number, page: number) =>
  call<AttachRecordResult>('citeCensusPage', {
    packId: 'c50de',
    id,
    generation: packs.generationOf('c50de'),
    page,
    personId,
  });

describe('a pack of the census is not a source of the search for a person', () => {
  it('is installed and ready, of its own kind', () => {
    const found = packs.ready().map((pack) => [pack.id, pack.kind]);
    expect(found).toEqual([
      ['c50de', CENSUS_PACK_KIND],
      ['tst1', 'open-archives'],
    ]);
  });

  it('is left out of the sources, and of the packs a person is searched in', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    const setup = await call<RecordSearchSetup>('getRecordSearch', ada);
    expect(setup.sources.map((source) => source.id)).toContain('pack:tst1');
    expect(setup.sources.map((source) => source.id)).not.toContain('pack:c50de');
    const result = await call<RecordSearchResult>('searchRecords', {
      personId: ada,
      sourceId: 'pack:c50de',
      query: { given: 'Ada', surname: 'Test', birthYear: null, deathYear: null },
      offset: 0,
    });
    expect(result).toMatchObject({ ok: false, problem: { kind: 'source' } });
  });

  it('names no source of marks, citations or keeping', async () => {
    expect(markSourceOf('pack:tst1')).toBe('open-archives');
    expect(markSourceOf('pack:c50de')).toBe('pack:c50de');
    expect(markSourceOf('pack:c50wy')).toBe('pack:c50wy');
    expect(markSourceOf('wikitree')).toBe('wikitree');
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    const ref = { personId: ada, sourceId: 'pack:c50de', key: 'c50:1' };
    expect(await call<AttachRecordResult>('attachRecord', ref)).toMatchObject({ ok: false });
    expect(await call('keepRecord', ref)).toMatchObject({ ok: false });
  });
});

describe('the name search of the census, as a link', () => {
  const linkIds = async (personId: string) =>
    (await call<RecordSearchSetup>('getRecordSearch', personId)).links.map((link) => link.id);

  it('is listed for a person born in 1950 or before, or whose birth year is not known', async () => {
    const early = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    const born1950 = await addPerson('Bea', 'Test', { birthDate: '1950' });
    const unknown = await addPerson('Cy', 'Test');
    const late = await addPerson('Di', 'Test', { birthDate: '1951' });
    expect(await linkIds(early)).toContain('nara-1950-search');
    expect(await linkIds(born1950)).toContain('nara-1950-search');
    expect(await linkIds(unknown)).toContain('nara-1950-search');
    expect(await linkIds(late)).not.toContain('nara-1950-search');
    // The other sites are listed for everyone.
    expect(await linkIds(late)).toContain('find-a-grave');
  });

  it('is refused, though asked for by hand, for a person born after 1950', async () => {
    const query = { given: 'Di', surname: 'Test', birthYear: null, deathYear: null };
    const open = (personId: string) =>
      call<RecordLinkResult>('openRecordLink', { personId, linkId: 'nara-1950-search', query });
    await call('agreeToRecordSearch');
    const late = await addPerson('Di', 'Test', { birthDate: '1951', deathDate: '2000' });
    const born1950 = await addPerson('Bea', 'Test', { birthDate: '1950', deathDate: '2000' });
    expect(await open(late)).toMatchObject({ ok: false, problem: { kind: 'choice' } });
    expect(openedInBrowser).toEqual([]);
    expect(await open(born1950)).toEqual({ ok: true });
  });

  it('is refused for a person who may be living, and needs the notice; otherwise it opens the name search', async () => {
    const query = { given: 'Ada', surname: 'Test', birthYear: null, deathYear: null };
    const open = (personId: string) =>
      call<RecordLinkResult>('openRecordLink', { personId, linkId: 'nara-1950-search', query });
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    const living = await addPerson('Zoe', 'Test', { birthDate: '1930' });
    expect(await open(ada)).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    await call('agreeToRecordSearch');
    expect(await open(living)).toMatchObject({ ok: false, problem: { kind: 'living' } });
    expect(openedInBrowser).toEqual([]);
    expect(await open(ada)).toEqual({ ok: true });
    const url = new URL(openedInBrowser[0] ?? '');
    expect(url.origin).toBe('https://1950census.archives.gov');
    expect(url.pathname).toBe('/search/');
    expect(url.searchParams.get('name')).toBe('Ada Test');
    // The app itself asked nobody.
    expect(imageRequests).toEqual([]);
  });
});

describe('the notice', () => {
  it('is at version 7, and an agreement to the version before no longer counts', async () => {
    expect(RECORD_SEARCH_NOTICE_VERSION).toBe(7);
    setSetting(appDb, RECORD_SEARCH_NOTICE_SETTING, '2026-11-14T00:00:00.000Z');
    setSetting(appDb, RECORD_SEARCH_NOTICE_VERSION_SETTING, '6');
    expect(records.agreed).toBe(false);
    records.agree();
    expect(records.agreed).toBe(true);
  });
});

describe('viewing and citing a page through the handlers', () => {
  it('needs the notice before a page image is asked for', async () => {
    const result = await view(1, 1);
    expect(result).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    expect(imageRequests).toEqual([]);
  });

  it('cites only the page last shown, with the page, the text, the address of the image and today', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    await call('agreeToRecordSearch');
    // Nothing was shown yet.
    expect(await cite(ada, 1, 2)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toEqual([]);

    const shown = await view(1, 2);
    expect(shown).toMatchObject({ ok: true, page: 2, pages: 3 });
    expect(imageRequests).toEqual([PAGE_URL(2)]);

    // Not the page, nor the district, that was shown.
    expect(await cite(ada, 1, 1)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(await cite(ada, 2, 2)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toEqual([]);

    const done = await cite(ada, 1, 2);
    expect(done).toMatchObject({ ok: true, added: true });
    const [citation] = listCitations(session.tree, { type: 'person', id: ada });
    expect(citation).toMatchObject({
      page: 'Testland, Alder County, ED 1-1, image 2 of 3, roll T628-12',
      text: 'Ward 1: that part of the village of Tarnwick bounded by Mill Road, the creek and Oak Street. Includes the school.',
      url: PAGE_URL(2),
      accessedAt: localDay(Date.now()),
      sourceTitle: '1950 US Census (National Archives)',
    });
    // Citing the same page again adds nothing.
    expect(await cite(ada, 1, 2)).toMatchObject({ ok: true, added: false });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toHaveLength(1);
    // Citing sent nothing: only the one image was asked for.
    expect(imageRequests).toHaveLength(1);

    // Another page needs to be shown first, and is its own citation.
    await view(1, 1);
    expect(await cite(ada, 1, 2)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(await cite(ada, 1, 1)).toMatchObject({ ok: true, added: true });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toHaveLength(2);
  });

  it('does not cite a page of a pack that was replaced since it was shown', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    await call('agreeToRecordSearch');
    await view(1, 2);
    const base = packs.generationOf('c50de');
    const generation = vi.spyOn(packs, 'generationOf').mockReturnValue(base + 1);
    expect(await cite(ada, 1, 2)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    // A change while the pack is read is seen too.
    let bumped = false;
    generation.mockImplementation(() => base + (bumped ? 1 : 0));
    const real = packs.get.bind(packs);
    vi.spyOn(packs, 'get').mockImplementation(async (...args) => {
      const found = await real(...args);
      bumped = true;
      return found;
    });
    expect(await cite(ada, 1, 2)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toEqual([]);
  });

  it('refuses a citation with a generation other than the one the page was shown under', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    await call('agreeToRecordSearch');
    await view(1, 2);
    const base = packs.generationOf('c50de');
    const citeWith = (generation: number) =>
      call<AttachRecordResult>('citeCensusPage', {
        packId: 'c50de',
        id: 1,
        generation,
        page: 2,
        personId: ada,
      });
    expect(await citeWith(base + 1)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(await citeWith(base)).toMatchObject({ ok: true, added: true });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toHaveLength(1);
  });

  it('refuses a citation when the page last shown was set under another generation mid-read', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    await call('agreeToRecordSearch');
    await view(1, 2);
    const base = packs.generationOf('c50de');
    // While the citation reads the pack, the pack is replaced and the same page is shown from the new one.
    const real = packs.get.bind(packs);
    let first = true;
    vi.spyOn(packs, 'get').mockImplementation(async (...args) => {
      const found = await real(...args);
      if (first) {
        first = false;
        vi.spyOn(packs, 'generationOf').mockReturnValue(base + 1);
        await census.pageImage({ packId: 'c50de', id: 1, generation: base + 1, page: 2 });
      }
      return found;
    });
    const result = await call<AttachRecordResult>('citeCensusPage', {
      packId: 'c50de',
      id: 1,
      generation: base,
      page: 2,
      personId: ada,
    });
    expect(result).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(listCitations(session.tree, { type: 'person', id: ada })).toEqual([]);
  });

  it('cites for a person who may be living, since nothing about them is sent', async () => {
    const living = await addPerson('Zoe', 'Test', { birthDate: '1990' });
    await call('agreeToRecordSearch');
    await view(3, 1);
    expect(await cite(living, 3, 1)).toMatchObject({ ok: true, added: true });
    const [citation] = listCitations(session.tree, { type: 'person', id: living });
    expect(citation?.page).toBe('Testland, Birch County, ED 2-1, image 1 of 1, roll T628-13');
  });

  it('cites for a person of the tree only, and forgets the page when the tree closes', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    await call('agreeToRecordSearch');
    await view(1, 1);
    expect(await cite(GONE, 1, 1)).toMatchObject({ ok: false, problem: { kind: 'gone' } });
    await call('closeTree');
    await call<TreeState>('createTree', { name: 'Other', parentDir: join(root, 'Trees') });
    const other = await addPerson('Bea', 'Test', { birthDate: '1850', deathDate: '1910' });
    expect(await cite(other, 1, 1)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(ada).not.toBe(other);
  });

  it('refuses what the pages of the bridge must not pass: ids, pages and extra keys', async () => {
    // The arguments are checked before anything runs.
    expect(() =>
      handlers.censusPageImage({ packId: 'c50de', id: 1, generation: 0, page: 0 }),
    ).toThrow();
    expect(() =>
      handlers.censusPageImage({ packId: 'c50de', id: 0, generation: 0, page: 1 }),
    ).toThrow();
    expect(() =>
      handlers.censusPageImage({ packId: '../x', id: 1, generation: 0, page: 1 }),
    ).toThrow();
    expect(() =>
      handlers.censusPageImage({
        packId: 'c50de',
        id: 1,
        generation: 0,
        page: 1,
        url: 'https://x.example/a.jpg',
      }),
    ).toThrow();
    expect(() =>
      handlers.citeCensusPage({
        packId: 'c50de',
        id: 1,
        generation: 0,
        page: 1,
        personId: 'not-an-id',
      }),
    ).toThrow();
    expect(() => handlers.censusDistricts({ packId: 'c50de', county: 'x', filter: 'y' })).toThrow();
    expect(imageRequests).toEqual([]);
  });

  it('browses through the handlers, and the search window closing gives up a page', async () => {
    expect(await call('censusCounties', 'c50de')).toMatchObject({ ok: true });
    expect(
      await call('censusDistricts', {
        packId: 'c50de',
        county: 'Alder County',
        filter: '',
        offset: 0,
      }),
    ).toMatchObject({ ok: true, total: 2 });
    expect(
      await call('censusDistrict', {
        packId: 'c50de',
        id: 2,
        generation: packs.generationOf('c50de'),
      }),
    ).toMatchObject({
      ok: true,
      district: { ed: '1-2', pages: 2 },
    });
    expect(
      await call('openCensusDistrict', {
        packId: 'c50de',
        id: 2,
        generation: packs.generationOf('c50de'),
      }),
    ).toEqual({ ok: true });
    expect(openedInBrowser).toEqual([
      'https://1950census.archives.gov/search/?county=Alder%20County&ed=1-2&state=DE',
    ]);

    await call('agreeToRecordSearch');
    imageAnswer = (init) =>
      new Promise<Response>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const pending = view(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await call('cancelRecordSearch');
    expect(await pending).toMatchObject({ ok: false, problem: { kind: 'cancelled' } });
  });
});
