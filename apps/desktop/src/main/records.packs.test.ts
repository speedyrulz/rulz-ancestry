import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  declineRecord,
  getRecordMark,
  keepRecord,
  listCitations,
  listRecordMarks,
  openAppDatabase,
  type Db,
} from '@rulz/db';
import type {
  AttachRecordResult,
  CompareRecordResult,
  MarkRecordResult,
  PackActionResult,
  PacksState,
  PersonChange,
  RecordInboxPage,
  RecordSearchResult,
  RecordSearchSetup,
  TreeState,
} from '../shared/ipc';
import type { API_METHODS } from '../shared/ipc';
import { AiSessionService } from './aisession';
import { GazetteerService } from './gazetteer';
import { SAMPLE_COUNTRIES, sampleFetch } from './gazetteersample';
import { createHandlers, type ApiHandlers, type Platform } from './handlers';
import { buildPack, inProcessBuildRunner } from './packbuild';
import { PACKS_MARKER, PackManager } from './packs';
import { PackSearch, inProcessSearchChannel } from './packsearch';
import { RecordRun } from './recordrun';
import {
  PACK_ROUTE_PATTERN,
  RECORD_RUN_SOURCE_IDS,
  RecordSearchService,
  localDay,
  markSourceOf,
} from './records';
import { TreeSession } from './session';

// Every name, place and identifier in the fixtures is made up.
const FIXTURES = join(
  import.meta.dirname,
  '../../../../packages/connectors/src/sources/open-archives/fixtures',
);

/** The day the pack's files were "downloaded", and midday of it on this PC's clock. */
const DOWNLOADED = '2026-03-04';
const DOWNLOADED_AT = new Date(2026, 2, 4, 12).getTime();
const ROUTE = 'pack:tst1';

let root: string;
let appDb: Db;
let session: TreeSession;
let gazetteer: GazetteerService;
let records: RecordSearchService;
let packs: PackManager;
let handlers: ApiHandlers;
let runs: RecordRun;
let ai: AiSessionService;
/** Every address the live search asked for. */
let asked: string[];
/** What a live source is answered with: a promise a test settles itself, or at once. */
let liveAnswer: (url: string) => Promise<Response>;

async function call<T>(method: (typeof API_METHODS)[number], ...args: unknown[]): Promise<T> {
  return (await handlers[method](...args)) as T;
}

async function addPerson(given: string, surname: string, extra: object = {}): Promise<string> {
  const change = await call<PersonChange>('addPerson', { given, surname, ...extra });
  return change.personId;
}

/** Makes a pack of the two fixture files, as an install would, in the packs folder. */
async function installFixturePack(id = 'tst1', downloadedAt = DOWNLOADED): Promise<void> {
  const dir = join(root, 'packs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PACKS_MARKER), 'marker');
  const files = ['pack-sample.csv', 'pack-sample-births.csv'].map((name) => ({
    path: join(FIXTURES, name),
    url: `https://oa-export.s3.nl-ams.scw.cloud/csv/${name}`,
    bytes: 1,
    sha256: '0'.repeat(64),
    etag: null,
    modified: null,
  }));
  await buildPack(
    {
      kind: 'open-archives',
      outPath: join(dir, `${id}.pack`),
      files,
      meta: {
        packId: id,
        title: 'Test archive',
        sourceName: 'Open Archives',
        sourceUrl: 'https://www.openarchieven.nl/',
        licence: 'CC0 1.0',
        credit: 'Test archive, via Open Archives',
        downloadedAt,
      },
      reserveBytes: 1,
    },
    { stop: () => false, progress: () => undefined },
  );
}

const platform = {} as Platform;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rulz-records-packs-'));
  appDb = openAppDatabase(':memory:');
  session = new TreeSession({ appDb, defaultParentDir: join(root, 'Trees') });
  gazetteer = new GazetteerService({
    dir: join(root, 'gazetteer'),
    fetch: sampleFetch().fetch,
    countries: SAMPLE_COUNTRIES,
    minimums: {},
  });
  asked = [];
  liveAnswer = () => Promise.resolve(new Response(JSON.stringify({ response: { docs: [] } })));
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
    fetch: (url) => {
      asked.push(url);
      return liveAnswer(url);
    },
    packs,
  });
  runs = new RecordRun(records, { wait: () => Promise.resolve() });
  ai = new AiSessionService(records, { appDb });
  handlers = createHandlers(session, platform, gazetteer, records, ai, runs, packs);
  await installFixturePack();
  packs.start();
  await call<TreeState>('createTree', { name: 'Family', parentDir: join(root, 'Trees') });
});

afterEach(async () => {
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

const searchPack = (personId: string, query: object, offset = 0, sourceId = ROUTE) =>
  call<RecordSearchResult>('searchRecords', { personId, sourceId, query, offset });
const BAKER = { given: 'Tobias', surname: 'Baker', birthYear: null, deathYear: null };
const ref = (personId: string, key: string, sourceId = ROUTE) => ({ personId, sourceId, key });

function found(result: RecordSearchResult) {
  if (!result.ok) throw new Error(`the search failed: ${result.problem.message}`);
  return result;
}

describe('a pack as a route of the record search', () => {
  it('is listed as a source of its own, with nothing sent anywhere', async () => {
    const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
    const setup = await call<RecordSearchSetup>('getRecordSearch', thomas);
    const pack = setup.sources.find((source) => source.id === ROUTE);
    expect(pack).toMatchObject({
      id: ROUTE,
      name: 'Test archive (pack on this PC)',
      searches: 'person',
      asks: 'nothing: the pack is searched on this PC',
      key: 'none',
      quota: null,
      pausedUntil: null,
      attribution: 'Test archive, via Open Archives',
    });
    expect(setup.sources.slice(-1)[0]?.id).toBe(ROUTE);
    // The live sources are all still there.
    expect(setup.sources.map((source) => source.id)).toContain('open-archives');
  });

  it('returns records of Open Archives, with no notice agreed and no request made', async () => {
    const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
    expect(records.agreed).toBe(false);
    const result = found(await searchPack(thomas, BAKER));
    expect(result.sourceId).toBe(ROUTE);
    expect(result.items).toHaveLength(1);
    const record = result.items[0];
    expect(record).toMatchObject({
      connectorId: 'open-archives',
      kind: 'event',
      title: 'Tobias Baker',
      event: 'Huwelijk',
    });
    expect(record?.key).toMatch(/^tst:[A-Za-z0-9-]+\/_GROOM$/);
    expect(record?.url).toBe(`https://www.openarchieven.nl/${record?.key.split('/')[0] ?? ''}/en`);
    expect(result.fetchedAt).toBe(DOWNLOADED_AT);
    expect(result.cached).toBe(false);
    expect(asked).toEqual([]);
  });

  it('counts the recent ones it leaves out, and never shows a living person', async () => {
    const baker = await addPerson('Baker', 'Test', { birthDate: '1860', deathDate: '1930' });
    // Alex Baker's marriage was in 2010: not shown, and counted.
    const result = found(
      await searchPack(baker, { given: '', surname: 'Baker', birthYear: null, deathYear: null }),
    );
    expect(result.items.map((item) => item.title)).toEqual(['Tobias Baker']);
    expect(result.hidden).toBe(1);
  });

  it('keeps the gate: nothing for a person who may be living, a name is needed, a tree must be open', async () => {
    const young = await addPerson('Zoe', 'Young', { birthDate: '1990' });
    const refused = await searchPack(young, BAKER);
    expect(refused).toMatchObject({ ok: false, problem: { kind: 'living' } });
    const adult = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    expect(
      await searchPack(adult, { given: '', surname: '', birthYear: null, deathYear: null }),
    ).toMatchObject({ ok: false, problem: { kind: 'empty' } });
    expect(await searchPack(adult, BAKER, 0, 'pack:nope')).toMatchObject({
      ok: false,
      problem: { kind: 'source' },
    });
    await call('closeTree');
    await expect(searchPack(adult, BAKER)).rejects.toThrow();
  });

  it('uses the years of the query as the live search does', async () => {
    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    // Tobias Baker married in 1900: inside 1848 to 1912.
    expect(
      found(await searchPack(ada, { ...BAKER, birthYear: 1850, deathYear: 1910 })).items,
    ).toHaveLength(1);
    // Not inside 1700 to 1720.
    expect(
      found(await searchPack(ada, { ...BAKER, birthYear: 1705, deathYear: 1715 })).items,
    ).toHaveLength(0);
  });

  it('is never a live search, nor given up by one', async () => {
    const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
    records.agree();
    let release: (() => void) | undefined;
    liveAnswer = () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            new Response(
              JSON.stringify({
                response: {
                  number_found: 1,
                  docs: [
                    {
                      pid: 'P1',
                      identifier: 'REC-1',
                      archive_code: 'exa',
                      personname: 'Tobias Baker',
                      relationtype: 'Groom',
                      eventtype: 'Marriage',
                      eventdate: { year: 1900 },
                    },
                  ],
                },
              }),
            ),
          );
      });
    const live = call<RecordSearchResult>('searchRecords', {
      personId: thomas,
      sourceId: 'open-archives',
      query: BAKER,
      offset: 0,
    });
    while (release === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    // A pack search while the live one waits for its source.
    expect(found(await searchPack(thomas, BAKER)).items).toHaveLength(1);
    release();
    const liveResult = found(await live);
    expect(liveResult.items.map((item) => item.key)).toEqual(['exa:REC-1/P1']);
    // The pack's key and the live key cannot be one: the pack's has an underscore.
    expect(PACK_ROUTE_PATTERN.test('open-archives')).toBe(false);
  });

  it('offers no pack to a search for several people or to the AI', async () => {
    const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
    expect(RECORD_RUN_SOURCE_IDS.some((id) => id.startsWith('pack'))).toBe(false);
    expect(records.runSources().map((source) => source.id)).toEqual(['wikitree', 'open-archives']);
    expect(records.aiSources().some((source) => source.id.startsWith('pack:'))).toBe(false);
    const once = await records.searchOnce(
      session.tree,
      { personId: thomas, sourceId: ROUTE, query: BAKER },
      new AbortController().signal,
    );
    expect(once).toMatchObject({ ok: false, problem: { kind: 'source' } });
    const forAi = await records.searchForAi(
      session.tree,
      { personId: thomas, sourceId: ROUTE, query: BAKER },
      new AbortController().signal,
      () => null,
    );
    expect(forAi).toMatchObject({ ok: false, sent: false, problem: { kind: 'source' } });
    // A text search cannot be made of a pack either.
    expect(
      await call<RecordSearchResult>('searchRecordTexts', {
        personId: thomas,
        sourceId: 'loc',
        query: { words: 'Baker', phrase: true, fromYear: null, toYear: null, state: '' },
        offset: 0,
      }),
    ).toMatchObject({ ok: false });
    expect(asked).toEqual([]);
  });
});

describe('keeping, declining and citing a result of a pack', () => {
  async function firstResult() {
    const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
    const result = found(await searchPack(thomas, BAKER));
    const record = result.items[0];
    if (record === undefined) throw new Error('no result');
    return { thomas, record };
  }

  it('shows live marks on pack results and pack turn-downs on live and run results', async () => {
    const { thomas, record } = await firstResult();
    const other = await addPerson('Mira', 'Lark', { birthDate: '1860', deathDate: '1930' });
    const part = record.key.slice(0, record.key.lastIndexOf('/'));
    const liveKey = `${part}/P1`;
    const mark = {
      sourceId: 'open-archives',
      key: liveKey,
      title: '',
      url: '',
      readAt: 1,
      markedAt: 2,
    };
    keepRecord(session.tree, thomas, mark);
    expect(found(await searchPack(thomas, BAKER)).marks.kept).toContain(record.key);
    expect(found(await searchPack(other, BAKER)).marks.kept).not.toContain(record.key);
    declineRecord(session.tree, thomas, { ...mark, key: record.key });
    const [archive, identifier] = part.split(':');
    liveAnswer = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            response: {
              number_found: 1,
              docs: [
                {
                  pid: 'P1',
                  identifier,
                  archive_code: archive,
                  personname: 'Tobias Baker',
                  relationtype: 'Groom',
                  eventtype: 'Marriage',
                  eventdate: { year: 1900 },
                },
              ],
            },
          }),
        ),
      );
    records.agree();
    const request = { personId: thomas, sourceId: 'open-archives', query: BAKER };
    const live = found(await call<RecordSearchResult>('searchRecords', { ...request, offset: 0 }));
    expect(live.marks.declined).toContain(liveKey);
    const query = records.setup(session.tree, thomas)?.query;
    if (query === undefined) throw new Error('no search setup');
    const run = found(
      await records.searchOnce(session.tree, { ...request, query }, new AbortController().signal),
    );
    expect(run.marks.declined).toContain(liveKey);
  });

  it('maps a route to the source the tree keeps it under', () => {
    expect(markSourceOf('pack:tst1')).toBe('open-archives');
    expect(markSourceOf('open-archives')).toBe('open-archives');
    expect(markSourceOf('wikitree')).toBe('wikitree');
  });

  it('keeps it under open-archives with the pack key and the download day', async () => {
    const { thomas, record } = await firstResult();
    const kept = await call<MarkRecordResult>('keepRecord', ref(thomas, record.key));
    expect(kept.ok).toBe(true);
    const mark = getRecordMark(session.tree, thomas, 'open-archives', record.key);
    expect(mark).toMatchObject({ state: 'kept', sourceId: 'open-archives', key: record.key });
    expect(mark?.readAt).toBe(DOWNLOADED_AT);
    expect(getRecordMark(session.tree, thomas, ROUTE, record.key)).toBeNull();
    expect(
      listRecordMarks(session.tree, { state: 'kept', personId: thomas, offset: 0, limit: 10 }).map(
        (m) => m.sourceId,
      ),
    ).toEqual(['open-archives']);
    // The inbox lists it under Open Archives, and it can be cited from there.
    const inbox = await call<RecordInboxPage>('listRecordInbox', {
      state: 'kept',
      personId: thomas,
      offset: 0,
      limit: 10,
    });
    expect(inbox.items.map((item) => [item.sourceId, item.key, item.canAttach])).toEqual([
      ['open-archives', record.key, true],
    ]);
    // A search shows it as kept.
    const again = found(await searchPack(thomas, BAKER));
    expect(again.marks).toEqual({ kept: [record.key], declined: [] });
    // And turning it down for the same person is one mark, not two.
    expect((await call<MarkRecordResult>('declineRecord', ref(thomas, record.key))).ok).toBe(true);
    expect(found(await searchPack(thomas, BAKER)).marks).toEqual({
      kept: [],
      declined: [record.key],
    });
    // Taking the mark away by the route the page knows removes it.
    const removed = await call<MarkRecordResult>('unmarkRecord', {
      personId: thomas,
      sourceId: ROUTE,
      key: record.key,
    });
    expect(removed.ok).toBe(true);
    expect(getRecordMark(session.tree, thomas, 'open-archives', record.key)).toBeNull();
  });

  it('cites it through Open Archives, with the day the pack was downloaded', async () => {
    const { thomas, record } = await firstResult();
    const attached = await call<AttachRecordResult>('attachRecord', ref(thomas, record.key));
    expect(attached.ok).toBe(true);
    const [citation] = listCitations(session.tree, { type: 'person', id: thomas });
    expect(citation).toMatchObject({
      url: record.url,
      accessedAt: DOWNLOADED,
      sourceTitle: 'Open Archives (Open Archieven)',
    });
    // The search shows it as attached.
    expect(found(await searchPack(thomas, BAKER)).attached).toEqual([record.key]);
    // The same, from the copy the tree keeps.
    await call<MarkRecordResult>('keepRecord', ref(thomas, record.key));
    const inbox = await call<AttachRecordResult>('attachRecord', {
      ...ref(thomas, record.key, 'open-archives'),
      from: 'inbox',
    });
    expect(inbox.ok).toBe(true);
  });

  it('can be set beside the person', async () => {
    const { thomas, record } = await firstResult();
    const comparison = await call<CompareRecordResult>('compareRecord', ref(thomas, record.key));
    expect(comparison.ok).toBe(true);
  });

  it('cannot be named as a proposal of the AI, and a live key is not taken for a pack key', async () => {
    const { thomas, record } = await firstResult();
    const proposal = await call<MarkRecordResult>('keepRecord', {
      ...ref(thomas, record.key),
      from: 'proposal',
      proposal: { sessionId: 'session-1', ref: 'r1' },
    });
    expect(proposal.ok).toBe(false);
    // Another pack, not installed, has no such result.
    expect(
      (await call<MarkRecordResult>('keepRecord', ref(thomas, record.key, 'pack:other'))).ok,
    ).toBe(false);
  });

  it('keeps the result at hand after the pack is removed', async () => {
    const { thomas, record } = await firstResult();
    expect(await call<PackActionResult>('removePack', 'tst1')).toEqual({ ok: true });
    expect((await call<AttachRecordResult>('attachRecord', ref(thomas, record.key))).ok).toBe(true);
    const setup = await call<RecordSearchSetup>('getRecordSearch', thomas);
    expect(setup.sources.some((source) => source.id === ROUTE)).toBe(false);
    expect(await searchPack(thomas, BAKER)).toMatchObject({
      ok: false,
      problem: { kind: 'source' },
    });
  });
});

describe('the handlers of the packs', () => {
  it('gives the packs, and refuses what is not an id of a pack or a route', async () => {
    const state = await call<PacksState>('getPacks');
    expect(state.root).toBe(join(root, 'packs'));
    expect(state.packs.map((pack) => [pack.id, pack.state, pack.rows > 0])).toEqual([
      ['tst1', 'ready', true],
    ]);
    expect(state.job).toBeNull();
    expect(await call<PackActionResult>('cancelPackJob')).toMatchObject({ ok: false });

    for (const bad of ['../tst1', 'TST1', 'a', 'tst1.pack', '', 'abcdefghijklm', 5, null]) {
      await expect(call('removePack', bad)).rejects.toThrow();
    }
    expect(readdirSync(join(root, 'packs')).sort()).toEqual([PACKS_MARKER, 'tst1.pack']);

    const ada = await addPerson('Ada', 'Test', { birthDate: '1850', deathDate: '1910' });
    for (const bad of ['pack:AB', 'pack:a', 'pack:../x', 'pack:', 'pack:tst1:x', 'Pack:tst1']) {
      await expect(searchPack(ada, BAKER, 0, bad)).rejects.toThrow();
      await expect(call('keepRecord', ref(ada, 'k', bad))).rejects.toThrow();
      await expect(call('attachRecord', ref(ada, 'k', bad))).rejects.toThrow();
      await expect(call('declineRecord', ref(ada, 'k', bad))).rejects.toThrow();
      await expect(call('compareRecord', ref(ada, 'k', bad))).rejects.toThrow();
    }
    // Keys and notices take a source, never a pack route.
    await expect(
      call('setRecordSourceKey', { sourceId: ROUTE, key: 'abcdefgh1234' }),
    ).rejects.toThrow();
    await expect(call('removeRecordSourceKey', ROUTE)).rejects.toThrow();
    await expect(
      call('addCitation', { type: 'person', id: ada }, { siteId: ROUTE }, {}),
    ).rejects.toThrow();
  });

  it('removes a pack, and the file is gone', async () => {
    expect(await call<PackActionResult>('removePack', 'tst1')).toEqual({ ok: true });
    expect(readdirSync(join(root, 'packs'))).toEqual([PACKS_MARKER]);
    expect((await call<PacksState>('getPacks')).packs).toEqual([]);
    expect(await call<PackActionResult>('removePack', 'tst1')).toMatchObject({ ok: false });
  });

  it('is unavailable when the app has no packs', async () => {
    const bare = createHandlers(session, platform, gazetteer, records, ai, runs);
    expect(() => bare.getPacks()).toThrow(/not available/);
  });
});

describe('the days and years a pack search uses', () => {
  const zone = process.env['TZ'];
  afterEach(() => {
    if (zone === undefined) delete process.env['TZ'];
    else process.env['TZ'] = zone;
  });

  it('cites the day the pack was downloaded on any clock, even far east of Greenwich', async () => {
    for (const where of ['Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Honolulu', 'UTC']) {
      process.env['TZ'] = where;
      const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
      const result = found(await searchPack(thomas, BAKER));
      expect(localDay(result.fetchedAt)).toBe(DOWNLOADED);
    }
  });

  it('takes the year as the live search of Open Archives does, by UTC', async () => {
    process.env['TZ'] = 'Pacific/Auckland';
    // At this moment it is already 2121 in Auckland, and still 2120 in UTC.
    const moment = Date.UTC(2120, 11, 31, 23, 30);
    const dated = new RecordSearchService({
      appDb,
      appVersion: '0.0.0',
      fetch: (url) => liveAnswer(url),
      packs,
      now: () => moment,
    });
    const baker = await addPerson('Baker', 'Test', { birthDate: '1860', deathDate: '1930' });
    const result = found(
      await dated.search(session.tree, {
        personId: baker,
        sourceId: ROUTE,
        query: { given: '', surname: 'Baker', birthYear: null, deathYear: null },
        offset: 0,
      }),
    );
    // A marriage of 2010 is not long enough ago in 2120, whatever the clock says.
    expect(result.items.map((item) => item.title)).toEqual(['Tobias Baker']);
    expect(result.hidden).toBe(1);
  });

  it('does not offer a pack whose download day is not a day, and never cites today for it', async () => {
    await installFixturePack('bad1', '2026-02-31');
    await installFixturePack('bad2', '2026-3-4');
    const thomas = await addPerson('Tobias', 'Baker', { birthDate: '1860', deathDate: '1930' });
    const setup = await call<RecordSearchSetup>('getRecordSearch', thomas);
    expect(setup.sources.map((source) => source.id)).toEqual(
      expect.not.arrayContaining(['pack:bad1', 'pack:bad2']),
    );
    expect(setup.sources.map((source) => source.id)).toContain(ROUTE);
    expect(await searchPack(thomas, BAKER, 0, 'pack:bad1')).toMatchObject({
      ok: false,
      problem: { kind: 'source' },
    });
    const state = await call<PacksState>('getPacks');
    expect(state.packs.find((pack) => pack.id === 'bad1')?.state).toBe('unreadable');
    expect(state.packs.find((pack) => pack.id === 'bad2')?.state).toBe('unreadable');
  });
});
