import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Connectors from '@rulz/connectors';
import type { SearchAnswer, SearchOptions } from '@rulz/connectors';
import { HttpError } from '@rulz/connectors';
import type { PageRequest, TextQuery, TextRecord } from '@rulz/core';
import { listCitations, openAppDatabase, type Db } from '@rulz/db';
import type {
  AttachRecordResult,
  GedcomExportInfo,
  PersonChange,
  RecordInboxPage,
  RecordSearchResult,
  RecordSearchSetup,
  RecordSourceKeyResult,
  RecordSourceKeyTest,
  TreeState,
} from '../shared/ipc';
import { AiSessionService } from './aisession';
import { GazetteerService } from './gazetteer';
import { SAMPLE_COUNTRIES, sampleFetch } from './gazetteersample';
import { createHandlers, type ApiHandlers, type Platform } from './handlers';
import { RecordRun } from './recordrun';
import {
  RECORD_RUN_SOURCE_IDS,
  RECORD_SEARCH_NOTICE_VERSION,
  RecordSearchService,
  type SecretStore,
} from './records';
import { TreeSession } from './session';

/**
 * Trove and Papers Past are built by their own parts; here they are stood in
 * for by fabricated connectors, so that what the app does with a result is
 * tested alone: the citation, the marks, the key, the refusals.
 */
const fakes = vi.hoisted(() => ({
  /** What each source answers; a test puts its own in its place. */
  ask: undefined as
    | undefined
    | ((
        sourceId: string,
        query: TextQuery,
        page: PageRequest,
        options: SearchOptions | undefined,
      ) => Promise<SearchAnswer<TextRecord>>),
  /** Every question that reached a fabricated connector: the source and the words. */
  asked: [] as { sourceId: string; query: TextQuery }[],
}));

vi.mock('@rulz/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof Connectors>();
  const fake = (manifest: (typeof actual)['troveManifest']) => () => ({
    manifest,
    searchTexts: (
      query: TextQuery,
      page: PageRequest,
      options: SearchOptions | undefined,
    ): Promise<SearchAnswer<TextRecord>> => {
      options?.beforeSend?.();
      fakes.asked.push({ sourceId: manifest.id, query });
      if (fakes.ask === undefined) throw new Error('no answer planned');
      return fakes.ask(manifest.id, query, page, options);
    },
  });
  return {
    ...actual,
    papersPastConnector: fake(actual.papersPastManifest),
    troveConnector: fake(actual.troveManifest),
  };
});

// Every name and identifier here is made up.
const CANARY = 'canary-snippet-9f3a71c2-never-stored';
const KEY = 'canary-key-0123456789';
const TROVE = 'trove';
const PAPERS_PAST = 'papers-past';
const TEXT: TextQuery = {
  words: 'pembury',
  phrase: false,
  fromYear: 1880,
  toYear: 1920,
  state: '',
};

const troveRecord = (over: Partial<TextRecord> = {}): TextRecord => ({
  kind: 'text',
  connectorId: TROVE,
  key: '1234567',
  title: 'Mr Hemi Pembury at the show',
  url: 'https://nla.gov.au/nla.news-article1234567',
  date: '3 MAR 1902',
  by: 'The Testland Gazette',
  about: 'Page 7',
  excerpt: `... ${CANARY} ...`,
  ...over,
});

let root: string;
let appDb: Db;
let session: TreeSession;
let gazetteer: GazetteerService;
let records: RecordSearchService;
let handlers: ApiHandlers;
let ai: AiSessionService;
let runs: RecordRun;
let secretsWork: boolean;
let savePath: string | null;

const secrets: SecretStore = {
  available: () => secretsWork,
  encrypt: (text) => `kept:${Buffer.from(text).toString('hex')}`,
  decrypt: (kept) => {
    if (!kept.startsWith('kept:')) throw new Error('cannot be read');
    return Buffer.from(kept.slice(5), 'hex').toString();
  },
};

async function call<T>(method: keyof ApiHandlers, ...args: unknown[]): Promise<T> {
  return (await handlers[method](...args)) as T;
}

async function addPerson(given: string, extra: object = {}): Promise<string> {
  const change = await call<PersonChange>('addPerson', { given, surname: 'Pembury', ...extra });
  return change.personId;
}

const answerWith = (items: TextRecord[]) => {
  fakes.ask = (_id, _query, _page, options) => {
    options?.beforeSend?.();
    return Promise.resolve({
      page: { items, total: items.length, next: null, hidden: 0 },
      fetchedAt: Date.UTC(2026, 10, 15),
      cached: false,
    });
  };
};

const search = (personId: string, sourceId = TROVE) =>
  call<RecordSearchResult>('searchRecordTexts', { personId, sourceId, query: TEXT, offset: 0 });
const setKey = (sourceId: string, key = KEY) =>
  call<RecordSourceKeyResult>('setRecordSourceKey', { sourceId, key });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rulz-records-citeonly-'));
  appDb = openAppDatabase(':memory:');
  secretsWork = true;
  savePath = null;
  fakes.ask = undefined;
  fakes.asked = [];
  session = new TreeSession({ appDb, defaultParentDir: join(root, 'Trees') });
  gazetteer = new GazetteerService({
    dir: join(root, 'gazetteer'),
    fetch: sampleFetch().fetch,
    countries: SAMPLE_COUNTRIES,
    minimums: {},
  });
  records = new RecordSearchService({
    appDb,
    appVersion: '0.0.0',
    fetch: () => Promise.reject(new Error('no live source in a test')),
    secrets,
  });
  runs = new RecordRun(records, { wait: () => Promise.resolve() });
  ai = new AiSessionService(records, { appDb });
  const platform = {
    openInBrowser: () => Promise.resolve(),
    appInfo: () => ({ appVersion: '1.2.3-test' }),
    chooseFileToSave: () => Promise.resolve(savePath),
  } as unknown as Platform;
  handlers = createHandlers(session, platform, gazetteer, records, ai, runs);
  await call<TreeState>('createTree', { name: 'Family', parentDir: join(root, 'Trees') });
});

afterEach(async () => {
  runs.clear();
  await runs.idle();
  ai.clear();
  await ai.idle();
  gazetteer.close();
  await gazetteer.idle();
  session.shutdown();
  appDb.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the sources of Papers Past and Trove', () => {
  it('is told in the notice at version 7, and each says what it is sent', async () => {
    expect(RECORD_SEARCH_NOTICE_VERSION).toBe(7);
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const sources = (await call<RecordSearchSetup>('getRecordSearch', ada)).sources;
    expect(sources.find((source) => source.id === PAPERS_PAST)).toMatchObject({
      searches: 'text',
      asks: 'the words and the years; your own key if you saved one',
      key: 'missing',
      keyOptional: true,
    });
    expect(sources.find((source) => source.id === TROVE)).toMatchObject({
      searches: 'text',
      asks: 'the words, the years and your own key',
      key: 'missing',
      keyOptional: false,
      keyUrl: 'https://trove.nla.gov.au/about/create-something/using-api',
    });
  });

  it('are not asked for several people, and not by the AI', async () => {
    for (const id of [PAPERS_PAST, TROVE]) {
      expect(RECORD_RUN_SOURCE_IDS).not.toContain(id);
    }
    expect(records.runSources().map((source) => source.id)).not.toEqual(
      expect.arrayContaining([PAPERS_PAST]),
    );
    expect(records.aiSources().map((source) => source.id)).not.toContain(PAPERS_PAST);
    expect(records.aiSources().map((source) => source.id)).not.toContain(TROVE);
    await call('agreeToRecordSearch');
    await setKey(TROVE);
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    answerWith([troveRecord()]);
    for (const sourceId of [PAPERS_PAST, TROVE]) {
      const forAi = await records.searchForAi(
        session.tree,
        {
          personId: ada,
          sourceId,
          query: { given: 'Ada', surname: 'Pembury', birthYear: 1850, deathYear: 1910 },
        },
        new AbortController().signal,
        () => null,
      );
      expect(forAi).toMatchObject({ ok: false, problem: { kind: 'source' } });
      const once = await records.searchOnce(
        session.tree,
        {
          personId: ada,
          sourceId,
          query: { given: 'Ada', surname: 'Pembury', birthYear: 1850, deathYear: 1910 },
        },
        new AbortController().signal,
      );
      expect(once).toMatchObject({ ok: false, problem: { kind: 'source' } });
    }
    expect(fakes.asked).toEqual([]);
  });

  it('send nothing for a person who may be living, and nothing before the notice', async () => {
    await setKey(TROVE);
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const rita = await addPerson('Rita', { birthDate: '1990' });
    answerWith([troveRecord()]);
    expect(await search(ada, PAPERS_PAST)).toMatchObject({
      ok: false,
      problem: { kind: 'notice' },
    });
    await call('agreeToRecordSearch');
    for (const sourceId of [PAPERS_PAST, TROVE]) {
      expect(await search(rita, sourceId)).toMatchObject({
        ok: false,
        problem: { kind: 'living' },
      });
    }
    expect(fakes.asked).toEqual([]);
  });
});

describe('the key of a source', () => {
  it('lets Papers Past be asked with no key, and refuses Trove with its message', async () => {
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    answerWith([troveRecord({ connectorId: PAPERS_PAST })]);
    expect(await search(ada, PAPERS_PAST)).toMatchObject({ ok: true });
    expect(fakes.asked.map((entry) => entry.sourceId)).toEqual([PAPERS_PAST]);
    expect(await search(ada, TROVE)).toMatchObject({
      ok: false,
      problem: {
        kind: 'key',
        message: 'Trove (National Library of Australia) needs your own key.',
      },
    });
    expect(fakes.asked.map((entry) => entry.sourceId)).toEqual([PAPERS_PAST]);
  });

  it('blocks a key that is saved and cannot be read, for Papers Past too', async () => {
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await setKey(PAPERS_PAST);
    // The setting now holds something Windows cannot read.
    appDb
      .prepare('UPDATE setting SET value = ? WHERE key = ?')
      .run('garbled', 'recordSearch.key.papers-past');
    answerWith([troveRecord({ connectorId: PAPERS_PAST })]);
    expect(await search(ada, PAPERS_PAST)).toMatchObject({
      ok: false,
      problem: { kind: 'key' },
    });
    expect(fakes.asked).toEqual([]);
  });

  describe('the test of a key', () => {
    const test = (sourceId: string) => call<RecordSourceKeyTest>('testRecordSourceKey', sourceId);
    const settings = () =>
      JSON.stringify(appDb.prepare('SELECT key, value FROM setting ORDER BY key').all());

    it('needs the notice and a saved key, and sends nothing without them', async () => {
      expect(await test(TROVE)).toMatchObject({ outcome: 'failed' });
      await call('agreeToRecordSearch');
      const none = await test(TROVE);
      expect(none).toMatchObject({ outcome: 'failed' });
      expect(none.message).toContain('Save a key');
      expect(await test('wikitree')).toMatchObject({
        outcome: 'failed',
        message: 'This source takes no key.',
      });
      expect(fakes.asked).toEqual([]);
    });

    it('asks once with a fixed word and no person, and says what came of it', async () => {
      await call('agreeToRecordSearch');
      await setKey(TROVE);
      answerWith([]);
      const accepted = await test(TROVE);
      expect(accepted.outcome).toBe('accepted');
      expect(fakes.asked).toEqual([
        {
          sourceId: TROVE,
          query: { words: 'library', phrase: false, fromYear: null, toYear: null, state: '' },
        },
      ]);

      fakes.ask = () => Promise.reject(new HttpError('key', 'The key was refused.'));
      expect((await test(TROVE)).outcome).toBe('refused');
      fakes.ask = () => Promise.reject(new HttpError('quota', 'Used up.'));
      expect((await test(TROVE)).outcome).toBe('quota');
      fakes.ask = () => Promise.reject(new HttpError('paused', 'Paused.', { retryAt: 1 }));
      expect((await test(TROVE)).outcome).toBe('quota');
      fakes.ask = () => Promise.reject(new HttpError('network', 'Offline.'));
      expect((await test(TROVE)).outcome).toBe('failed');
      fakes.ask = () => Promise.reject(new Error('broken'));
      expect((await test(TROVE)).outcome).toBe('failed');
    });

    it('says for Papers Past that DigitalNZ may accept a key it ignores', async () => {
      await call('agreeToRecordSearch');
      await setKey(PAPERS_PAST);
      answerWith([]);
      const accepted = await test(PAPERS_PAST);
      expect(accepted.outcome).toBe('accepted');
      expect(accepted.message).toContain('DigitalNZ may accept a key it ignores');
    });

    it('never returns, logs or keeps the key anywhere it should not be', async () => {
      const logged: string[] = [];
      const spies = (['log', 'info', 'warn', 'error'] as const).map((name) =>
        vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        }),
      );
      await call('agreeToRecordSearch');
      await setKey(TROVE);
      for (const make of [
        () => answerWith([]),
        () => {
          fakes.ask = () => Promise.reject(new HttpError('key', 'refused'));
        },
        () => {
          fakes.ask = () => Promise.reject(new Error('broken'));
        },
      ]) {
        make();
        expect(JSON.stringify(await test(TROVE))).not.toContain(KEY);
      }
      expect(logged.join('\n')).not.toContain(KEY);
      expect(settings()).not.toContain(KEY);
      for (const spy of spies) spy.mockRestore();
    });

    it('refuses a bad argument the way the other key handlers do', async () => {
      for (const args of [[], ['../x'], [42], ['trove', 'extra']]) {
        expect(() => handlers.testRecordSourceKey(...args)).toThrow();
      }
    });
  });
});

describe('a result of a source that is cited and not quoted', () => {
  async function start() {
    await call('agreeToRecordSearch');
    await setKey(TROVE);
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    answerWith([troveRecord()]);
    const found = await search(ada);
    if (!found.ok) throw new Error(found.problem.message);
    // The snippet is shown with the result: it is display only.
    expect(found.items[0]).toMatchObject({ excerpt: `... ${CANARY} ...` });
    return ada;
  }
  const ref = (personId: string, extra: object = {}) => ({
    personId,
    sourceId: TROVE,
    key: '1234567',
    ...extra,
  });

  /** Every text the tree holds, as the citations, the marks and the file of the tree show it. */
  function everythingKept(): string {
    const texts: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else texts.push(readFileSync(path).toString('latin1'));
      }
    };
    walk(session.tree.dir ?? '');
    return texts.join('\n');
  }

  it('cites the heading, the newspaper, the date, the page and the link, and no text', async () => {
    const ada = await start();
    const attached = await call<AttachRecordResult>('attachRecord', ref(ada));
    expect(attached).toMatchObject({ ok: true });
    const citations = listCitations(session.tree, { type: 'person', id: ada });
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      page: 'Mr Hemi Pembury at the show (The Testland Gazette, 3 MAR 1902, page 7)',
      text: '',
      url: 'https://nla.gov.au/nla.news-article1234567',
    });
    expect(JSON.stringify(citations)).not.toContain(CANARY);
  });

  it('cites without the page when the record has none', async () => {
    await call('agreeToRecordSearch');
    await setKey(TROVE);
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    answerWith([troveRecord({ about: '', date: '' })]);
    await search(ada);
    await call('attachRecord', ref(ada));
    expect(listCitations(session.tree, { type: 'person', id: ada })[0]?.page).toBe(
      'Mr Hemi Pembury at the show (The Testland Gazette)',
    );
  });

  it('keeps no snippet, in a mark, the inbox, a citation or an export', async () => {
    const ada = await start();
    expect(await call('keepRecord', ref(ada))).toMatchObject({ ok: true });
    // Turned down for another person, with the same result.
    const bea = await addPerson('Bea', { birthDate: '1852', deathDate: '1920' });
    answerWith([troveRecord()]);
    await search(bea);
    expect(await call('declineRecord', ref(bea))).toMatchObject({ ok: true });

    const kept = await call<RecordInboxPage>('listRecordInbox', {
      state: 'kept',
      personId: null,
      offset: 0,
      limit: 50,
    });
    expect(kept.items).toHaveLength(1);
    // What the mark keeps: heading, newspaper, date, page and the link.
    expect(kept.items[0]).toMatchObject({
      title: 'Mr Hemi Pembury at the show',
      url: 'https://nla.gov.au/nla.news-article1234567',
      canAttach: true,
      record: {
        kind: 'text',
        by: 'The Testland Gazette',
        date: '3 MAR 1902',
        about: 'Page 7',
      },
    });
    expect(kept.items[0]?.record).not.toHaveProperty('excerpt');
    const declined = await call<RecordInboxPage>('listRecordInbox', {
      state: 'declined',
      personId: null,
      offset: 0,
      limit: 50,
    });
    expect(declined.items).toHaveLength(1);
    expect(JSON.stringify([kept, declined])).not.toContain(CANARY);

    // Cited from the kept copy, the citation is the same and holds no text.
    const fromInbox = await call<AttachRecordResult>('attachRecord', ref(ada, { from: 'inbox' }));
    expect(fromInbox).toMatchObject({ ok: true });
    const citation = listCitations(session.tree, { type: 'person', id: ada })[0];
    expect(citation).toMatchObject({
      page: 'Mr Hemi Pembury at the show (The Testland Gazette, 3 MAR 1902, page 7)',
      text: '',
    });

    savePath = join(root, 'out.ged');
    const exported = await call<GedcomExportInfo>('exportGedcom', {
      version: '5.5.1',
      includeLiving: true,
      withFiles: false,
    });
    const ged = readFileSync(exported.file, 'utf8');
    expect(ged).toContain('nla.news-article1234567');
    expect(ged).not.toContain(CANARY);
    // Nowhere in the tree's own files either.
    expect(everythingKept()).not.toContain(CANARY);
  });

  it('keeps a snippet out of the saved JSON of any source', async () => {
    const { keptFormOf } = await import('./keptrecord');
    const { troveManifest, papersPastManifest } = await import('@rulz/connectors');
    for (const manifest of [troveManifest, papersPastManifest]) {
      const form = keptFormOf(troveRecord({ connectorId: manifest.id }), manifest);
      expect(form?.recordJson).not.toContain(CANARY);
      expect(form?.recordJson).not.toContain('excerpt');
    }
  });
});
