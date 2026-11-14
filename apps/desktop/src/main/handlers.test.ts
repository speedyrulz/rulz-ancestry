import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_DIR_NAME, getSetting, openAppDatabase, setSetting, type Db } from '@rulz/db';
import {
  API_METHODS,
  type AppInfo,
  type AttachRecordResult,
  type ChartInfo,
  type DuplicateList,
  type GazetteerEntry,
  type GazetteerStatus,
  type GedcomExportInfo,
  type GedcomImportResult,
  type IpcError,
  type MediaAddResult,
  type MediaDetails,
  type MediaFindResult,
  type MediaInfo,
  type MediaListPage,
  type MergeInfo,
  type PersonChange,
  type PersonListPage,
  type PersonLifeInfo,
  type PersonPage,
  type PlaceListPage,
  type PlaceSuggestions,
  type RecordLinkResult,
  type RecordSearchResult,
  type RecordSearchSetup,
  type RecordSourceKeyResult,
  type RelationshipInfo,
  type SourceChange,
  type SourceDetails,
  type SourceListPage,
  type TreeState,
} from '../shared/ipc';
import { GazetteerService } from './gazetteer';
import {
  RECORD_SEARCH_NOTICE_SETTING,
  RECORD_SEARCH_NOTICE_VERSION,
  RECORD_SEARCH_NOTICE_VERSION_SETTING,
  RecordSearchService,
  recordSearchHostSetting,
  recordSearchKeySetting,
  type SecretStore,
} from './records';
import { SAMPLE_COUNTRIES, sampleFetch } from './gazetteersample';
import { createHandlers, toIpcError, type ApiHandlers, type Platform } from './handlers';
import { TreeSession } from './session';

const MISSING = '00000000-0000-7000-8000-000000000000';

let root: string;
let appDb: Db;
let session: TreeSession;
let handlers: ApiHandlers;
const QUERY = { given: 'Ada', surname: 'Test', birthYear: 1850, deathYear: null };
const TEXT = { words: 'Ada Test', phrase: true, fromYear: 1850, toYear: 1911, state: '' };
let gazetteer: GazetteerService;
let records: RecordSearchService;
/** Every address the search for records asked for. */
let askedOfSources: string[];
/** What a source answers in these tests: one profile of someone made up. */
const sourceAnswer = [
  {
    status: 0,
    matches: [
      {
        Id: 1,
        Name: 'Test-90001',
        FirstName: 'Ada',
        LastNameAtBirth: 'Test',
        LastNameCurrent: 'Test',
        BirthDate: '1850-03-00',
        IsLiving: 0,
        Privacy: 60,
      },
      { Id: 2 },
    ],
    total: 2,
  },
];
/** What the Library of Congress answers in these tests: two pages of newspapers that are made up. */
const newspaperAnswer = {
  pagination: { current: 1, from: 1, of: 2, next: null },
  results: [
    {
      id: 'http://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
      title: 'Image 8 of The Ashford gazette (Ashford, Vt.), May 1, 1903',
      url: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8&q=ada+test',
      date: '1903-05-01',
    },
    { id: 'https://elsewhere.example/resource/sn99000001/1903-05-01/ed-1/?sp=9' },
  ],
};
/** What the Internet Archive answers in these tests: one book that is made up. */
const bookAnswer = {
  responseHeader: { status: 0 },
  response: {
    numFound: 1,
    start: 0,
    docs: [
      { identifier: 'testfamily00exam', title: 'Test family.', creator: 'Fenwick, H.', year: 1930 },
    ],
  },
};
/** What Open Archives answers in these tests: one record long ago, and one of a time people may still live from. */
const archiveAnswer = {
  response: {
    number_found: 2,
    docs: [
      {
        pid: 'Person1',
        identifier: 'REC-1',
        archive_code: 'exa',
        archive: 'Example Municipal Archive',
        personname: 'Ada Test',
        relationtype: 'Bride',
        eventtype: 'Marriage',
        eventdate: { day: 21, month: 5, year: 1872 },
        eventplace: ['Voorbeeldstad'],
        sourcetype: 'Civil registration marriages',
        url: 'https://elsewhere.example/',
      },
      {
        pid: 'Person2',
        identifier: 'REC-2',
        archive_code: 'exa',
        personname: 'Ada Test',
        relationtype: 'Witness',
        eventtype: 'Marriage',
        eventdate: { year: 1990 },
      },
    ],
  },
};
/** What Wikidata answers in these tests: one person who died long ago, and one who may be living. */
const entryAnswer = {
  results: {
    bindings: [
      {
        item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q90001' },
        name: { type: 'literal', value: 'Ada Test' },
        description: { type: 'literal', value: 'surveyor (1850–1910)' },
        birth: { type: 'literal', value: '1850-03-12T00:00:00Z' },
        birthPrecision: { type: 'literal', value: '11' },
        birthLatest: { type: 'literal', value: '1850' },
        death: { type: 'literal', value: '1910-01-01T00:00:00Z' },
        deathPrecision: { type: 'literal', value: '9' },
        gender: { type: 'uri', value: 'http://www.wikidata.org/entity/Q6581072' },
      },
      {
        item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q90002' },
        name: { type: 'literal', value: 'Ada Test' },
        birth: { type: 'literal', value: '1985-06-01T00:00:00Z' },
        birthPrecision: { type: 'literal', value: '11' },
        birthLatest: { type: 'literal', value: '1985' },
      },
    ],
  },
};
/** What the National Archives answer in these tests: one description that is made up. */
const catalogAnswer = {
  statusCode: 200,
  body: {
    hits: {
      total: { value: 1 },
      hits: [
        {
          _source: {
            record: {
              naId: 90000001,
              title: 'Pension file of Ada Test',
              levelOfDescription: 'fileUnit',
              coverageStartDate: { year: 1862 },
              coverageEndDate: { year: 1910 },
            },
          },
        },
      ],
    },
  },
};
/** A key that is none: it only has to be found again wherever it must not be. */
const CANARY = 'canary-key-0123456789';
/** Whether the fake of Windows' data protection works, and can read what was kept. */
let secretsWork: { available: boolean; readable: boolean };
/** Stands in for Windows' data protection: what it keeps is not the text itself. */
const secrets: SecretStore = {
  available: () => secretsWork.available,
  encrypt: (text) => `kept:${Buffer.from(text).toString('hex')}`,
  decrypt: (kept) => {
    if (!secretsWork.readable || !kept.startsWith('kept:')) throw new Error('cannot be read');
    return Buffer.from(kept.slice(5), 'hex').toString();
  },
};
/** The headers of every request the search for records sent. */
let headersOfSources: Record<string, string>[];
/** What a source answers when asked; a test can put its own answer in its place. */
let answerOf: (url: string) => Response;
const usualAnswer = (url: string): Response => {
  const host = new URL(url).host;
  const data =
    host === 'www.loc.gov'
      ? newspaperAnswer
      : host === 'archive.org'
        ? bookAnswer
        : host === 'catalog.archives.gov'
          ? catalogAnswer
          : host === 'api.openarchieven.nl'
            ? archiveAnswer
            : host === 'query.wikidata.org'
              ? entryAnswer
              : sourceAnswer;
  return new Response(JSON.stringify(data));
};
/** What the fake folder picker answers next; null is a cancelled dialog. */
let pickedFolder: string | null;
/** What the fake dialogs for opening and saving a file answer next. */
let pickedFile: string | null;
let savePath: string | null;
/** Where each fake file dialog was told to start. */
let dialogDefaults: string[];
let openedFolders: string[];
/** The addresses handed to the browser. */
let openedInBrowser: string[];
/** What the fake dialog for adding pictures and documents answers next; none is a cancelled dialog. */
let pickedFiles: string[];
/** How often that dialog was shown. */
let filesDialogs: number;
/** The files handed to another program, and those shown in File Explorer. */
let openedFiles: string[];
let shownFiles: string[];

const platform: Platform = {
  openInBrowser: (url) => {
    openedInBrowser.push(url);
    return Promise.resolve();
  },
  appInfo: () => ({ appVersion: '1.2.3-test' }) as AppInfo,
  chooseFolder: () => Promise.resolve(pickedFolder),
  chooseFileToOpen: (options) => {
    dialogDefaults.push(options.defaultPath);
    return Promise.resolve(pickedFile);
  },
  chooseFileToSave: (options) => {
    dialogDefaults.push(options.defaultPath);
    return Promise.resolve(savePath);
  },
  chooseFilesToOpen: () => {
    filesDialogs += 1;
    return Promise.resolve(pickedFiles);
  },
  openFolder: (dir) => {
    openedFolders.push(dir);
    return Promise.resolve();
  },
  openFile: (file) => {
    openedFiles.push(file);
    return Promise.resolve();
  },
  showFileInFolder: (file) => {
    shownFiles.push(file);
  },
};

/** Calls a handler the way the IPC layer does, with arguments of any shape. */
async function call<T>(method: (typeof API_METHODS)[number], ...args: unknown[]): Promise<T> {
  return (await handlers[method](...args)) as T;
}

/** The error the page would receive for a call. */
async function errorOf(
  method: (typeof API_METHODS)[number],
  ...args: unknown[]
): Promise<IpcError> {
  try {
    await handlers[method](...args);
  } catch (error) {
    return toIpcError(error);
  }
  throw new Error(`${method} did not fail`);
}

async function openNewTree(): Promise<TreeState> {
  return call<TreeState>('createTree', { name: 'Family', parentDir: join(root, 'Trees') });
}

async function addPerson(given: string, extra: object = {}): Promise<string> {
  const change = await call<PersonChange>('addPerson', { given, surname: 'Test', ...extra });
  return change.personId;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rulz-handlers-'));
  appDb = openAppDatabase(':memory:');
  session = new TreeSession({ appDb, defaultParentDir: join(root, 'Trees') });
  gazetteer = new GazetteerService({
    dir: join(root, 'gazetteer'),
    fetch: sampleFetch().fetch,
    countries: SAMPLE_COUNTRIES,
    minimums: {},
  });
  askedOfSources = [];
  answerOf = usualAnswer;
  secretsWork = { available: true, readable: true };
  headersOfSources = [];
  records = new RecordSearchService({
    appDb,
    appVersion: '0.0.0',
    fetch: (url, init) => {
      askedOfSources.push(url);
      headersOfSources.push(init.headers);
      return Promise.resolve(answerOf(url));
    },
    secrets,
  });
  handlers = createHandlers(session, platform, gazetteer, records);
  pickedFolder = null;
  pickedFile = null;
  savePath = null;
  dialogDefaults = [];
  openedFolders = [];
  openedInBrowser = [];
  pickedFiles = [];
  filesDialogs = 0;
  openedFiles = [];
  shownFiles = [];
});

afterEach(async () => {
  gazetteer.close();
  await gazetteer.idle();
  session.shutdown();
  appDb.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the handler table', () => {
  it('has a handler for every function of the contract and nothing else', () => {
    expect(Object.keys(handlers).sort()).toEqual([...API_METHODS].sort());
  });
});

describe('argument checks', () => {
  it('rejects arguments of the wrong shape before anything runs', async () => {
    await openNewTree();
    const bad: [(typeof API_METHODS)[number], ...unknown[]][] = [
      ['addPerson'],
      ['addPerson', { given: 5 }],
      ['addPerson', { given: 'Ada', admin: true }],
      ['addPerson', { given: 'x'.repeat(201) }],
      ['addPerson', { given: 'Ada', sex: 'Q' }],
      ['addPerson', { given: 'Ada' }, 'extra argument'],
      ['getPersonPage', 'not-an-id'],
      ['getPersonPage', { id: MISSING }],
      ['getPersonLife', 'not-an-id'],
      ['getPersonLife', MISSING, 'extra argument'],
      ['getRecordSearch', 'not-an-id'],
      ['agreeToRecordSearch', true],
      ['cancelRecordSearch', 'now'],
      ['searchRecordTexts', { personId: MISSING, sourceId: 'loc', offset: 0 }],
      [
        'searchRecordTexts',
        { personId: MISSING, sourceId: 'loc', offset: 0, query: { ...TEXT, state: 'Atlantis' } },
      ],
      [
        'searchRecordTexts',
        { personId: MISSING, sourceId: 'loc', offset: 0, query: { ...TEXT, phrase: 'yes' } },
      ],
      [
        'searchRecordTexts',
        { personId: MISSING, sourceId: 'loc', offset: 0, query: { ...TEXT, fromYear: 0 } },
      ],
      [
        'searchRecordTexts',
        {
          personId: MISSING,
          sourceId: 'loc',
          offset: 0,
          query: { ...TEXT, words: 'x'.repeat(201) },
        },
      ],
      [
        'searchRecordTexts',
        {
          personId: MISSING,
          sourceId: 'loc',
          offset: 0,
          query: { ...TEXT, url: 'https://x.example' },
        },
      ],
      ['searchRecordTexts', { personId: MISSING, sourceId: 'loc', offset: 5000, query: TEXT }],
      ['attachRecord', { personId: MISSING, sourceId: 'wikitree' }],
      ['attachRecord', { personId: MISSING, sourceId: 'wikitree', key: '' }],
      [
        'attachRecord',
        { personId: MISSING, sourceId: 'wikitree', key: 'a', url: 'https://x.example' },
      ],
      ['setRecordSourceKey', { sourceId: 'nara-catalog' }],
      ['setRecordSourceKey', { sourceId: 'nara-catalog', key: 'short' }],
      ['setRecordSourceKey', { sourceId: 'nara-catalog', key: 'two words here' }],
      ['setRecordSourceKey', { sourceId: 'nara-catalog', key: 'line\nbreak-in-the-key' }],
      ['setRecordSourceKey', { sourceId: 'nara-catalog', key: 'x'.repeat(301) }],
      ['setRecordSourceKey', { sourceId: '../x', key: CANARY }],
      ['setRecordSourceKey', { sourceId: 'nara-catalog', key: CANARY, show: true }],
      ['removeRecordSourceKey', '../x'],
      ['removeRecordSourceKey', 'nara-catalog', 'extra argument'],
      ['openRecordLink', { personId: MISSING, linkId: 'find-a-grave' }],
      ['openRecordLink', { personId: MISSING, linkId: 'Find A Grave', query: QUERY }],
      [
        'openRecordLink',
        { personId: MISSING, linkId: 'find-a-grave', query: QUERY, url: 'https://x.example' },
      ],
      ['addCitation', { type: 'person', id: MISSING }, { siteId: '../x' }, {}],
      [
        'addCitation',
        { type: 'person', id: MISSING },
        { sourceId: MISSING },
        { accessedAt: 'today' },
      ],
      // A day that does not exist.
      ['updateCitation', MISSING, { accessedAt: '2026-02-30' }],
      ['updateCitation', MISSING, { url: 'x'.repeat(2049) }],
      ['searchRecords', { personId: MISSING, sourceId: 'wikitree', query: QUERY }],
      ['searchRecords', { personId: MISSING, sourceId: 'wikitree', query: QUERY, offset: 1001 }],
      ['searchRecords', { personId: MISSING, sourceId: '../x', query: QUERY, offset: 0 }],
      [
        'searchRecords',
        {
          personId: MISSING,
          sourceId: 'wikitree',
          query: { ...QUERY, birthYear: 1850.5 },
          offset: 0,
        },
      ],
      [
        'searchRecords',
        { personId: MISSING, sourceId: 'wikitree', query: { ...QUERY, place: 'x' }, offset: 0 },
      ],
      [
        'searchRecords',
        {
          personId: MISSING,
          sourceId: 'wikitree',
          query: { ...QUERY, given: 'x'.repeat(101) },
          offset: 0,
        },
      ],
      ['deletePerson', "x' OR 1=1 --"],
      ['listPersons', { query: '', offset: 0, limit: 100_000 }],
      ['listPersons', { query: '', offset: -1, limit: 10 }],
      ['addPersonEvent', MISSING, { type: '' }],
      ['addParent', MISSING, { existingId: MISSING, create: { given: 'Both' } }, {}],
      ['setPedigree', MISSING, MISSING, 'cloned'],
      ['restoreBackup', 42],
      ['getChart', { personId: MISSING, ancestors: 11, descendants: 0 }],
      ['getChart', { personId: MISSING, ancestors: 1.5, descendants: 0 }],
      ['getChart', { personId: MISSING, ancestors: 1 }],
      ['getRelationship', MISSING],
      ['getRelationship', MISSING, 'not-an-id'],
      ['findDuplicates', { limit: 5 }],
      ['mergePersons', MISSING, { id: MISSING }],
      ['markNotDuplicate', MISSING],
      ['listSources', { query: '', offset: 0, limit: 0 }],
      ['listSources', { query: 5, offset: 0, limit: 10 }],
      ['getSource', MISSING],
      ['getSource', MISSING, { offset: 0, limit: 1000 }],
      ['createSource', { title: 'x'.repeat(1001) }],
      ['createSource', { title: 'A', url: 'https://example.com' }],
      ['updateSource', 'not-an-id', { title: 'A' }],
      ['addCitation', { type: 'place', id: MISSING }, { sourceId: MISSING }, {}],
      ['addCitation', { type: 'event', id: MISSING }, { sourceId: MISSING, create: {} }, {}],
      ['addCitation', { type: 'event', id: MISSING }, { sourceId: MISSING }, { quality: 4 }],
      ['addCitation', { type: 'event', id: MISSING }, { sourceId: MISSING }, { quality: '3' }],
      ['addCitation', { type: 'event', id: MISSING }, { sourceId: MISSING }],
      ['updateCitation', MISSING, { page: 7 }],
      ['linkCitation', MISSING, { type: 'event' }],
      ['unlinkCitation', MISSING, MISSING],
      ['deleteCitation'],
      ['listMedia', { type: 'name', id: MISSING }],
      ['listAllMedia', { query: '', unattached: false, notHeld: false, offset: 0, limit: 100_000 }],
      ['listAllMedia', { query: '', notHeld: false, offset: 0, limit: 10 }],
      ['listAllMedia', { query: '', unattached: false, offset: 0, limit: 10 }],
      ['listAllMedia', { query: '', unattached: false, notHeld: 'yes', offset: 0, limit: 10 }],
      ['getMedia', '../../tree.db'],
      // The page cannot name a file to add; it can only say what to attach the chosen files to.
      ['addMedia', 'C:\\Windows\\win.ini'],
      ['addMedia', { type: 'person', id: MISSING, file: 'C:\\Windows\\win.ini' }],
      ['addMedia'],
      ['updateMedia', MISSING, { title: 'x'.repeat(501) }],
      ['updateMedia', MISSING, { fileName: 'other.png' }],
      ['unlinkMedia', MISSING, { type: 'person' }],
      ['deleteMedia', { id: MISSING }],
      // Nor a file for a picture the tree only knows of, nor a folder to look in.
      ['chooseMediaFile', 'C:\\Windows\\win.ini'],
      ['chooseMediaFile', MISSING, 'C:\\Windows\\win.ini'],
      ['chooseMediaFile'],
      ['findMediaFiles', 'C:\\Users'],
      ['openMedia', 'C:\\Windows\\notepad.exe'],
      ['showMediaInFolder'],
      ['createTree', { name: 'x', parentDir: '' }],
      ['undo', 'unexpected'],
    ];
    for (const [method, ...args] of bad) {
      expect((await errorOf(method, ...args)).code, `${method} ${JSON.stringify(args)}`).toBe(
        'invalid',
      );
    }
    expect(session.state().persons).toBe(0);
  });

  it('treats a key that is present but undefined as left out', async () => {
    await openNewTree();
    const change = await call<PersonChange>('addPerson', {
      given: 'Ada',
      surname: undefined,
      birthDate: undefined,
    });
    expect(change.tree.persons).toBe(1);
  });
});

describe('errors', () => {
  it('says when no tree is open', async () => {
    expect(await errorOf('listPersons', { query: '', offset: 0, limit: 10 })).toEqual({
      code: 'no-tree',
      message: 'no family tree is open',
    });
    expect((await errorOf('addPerson', { given: 'Ada' })).code).toBe('no-tree');
    expect((await errorOf('undo')).code).toBe('no-tree');
    expect((await errorOf('listBackups')).code).toBe('no-tree');
  });

  it('tells a missing record, a broken rule and an unexpected failure apart', async () => {
    await openNewTree();
    const ada = await addPerson('Ada');
    expect(await errorOf('deletePerson', MISSING)).toEqual({
      code: 'not-found',
      message: `person not found: ${MISSING}`,
    });
    expect(await errorOf('addParent', ada, { existingId: ada }, {})).toEqual({
      code: 'rule',
      message: 'a person cannot be their own parent',
    });
    expect((await errorOf('addPerson', { given: ' ' })).code).toBe('rule');
    expect((await errorOf('restoreBackup', 'tree.db')).code).toBe('rule');
    expect(toIpcError(new Error('disk on fire'))).toEqual({
      code: 'failed',
      message: 'disk on fire',
    });
    expect(toIpcError('a string')).toEqual({ code: 'failed', message: 'a string' });
  });
});

describe('opening trees', () => {
  it('creates a tree in a folder the user picked, and not in one they did not', async () => {
    const elsewhere = join(root, 'Elsewhere');
    expect((await errorOf('createTree', { name: 'Tree', parentDir: elsewhere })).code).toBe('rule');

    expect(await call('chooseParentFolder')).toBeNull();
    pickedFolder = elsewhere;
    expect(await call('chooseParentFolder')).toBe(elsewhere);
    const state = await call<TreeState>('createTree', { name: 'Tree', parentDir: elsewhere });
    expect(state.dir).toBe(join(elsewhere, 'Tree'));
  });

  it('opens the folder picked in the dialog, or nothing when it is cancelled', async () => {
    const created = await openNewTree();
    expect(await call('closeTree')).toEqual({ backupError: null });

    expect(await call('openTreeFromDialog')).toBeNull();
    pickedFolder = root;
    expect(await errorOf('openTreeFromDialog')).toEqual({
      code: 'rule',
      message: `there is no family tree in this folder: ${root}`,
    });
    pickedFolder = created.dir;
    expect(await call<TreeState>('openTreeFromDialog')).toMatchObject({ name: 'Family' });
  });
});

describe('reading and editing the open tree', () => {
  it('lists everyone by surname, or the matches of a search, with the total', async () => {
    await openNewTree();
    await call('addPerson', { given: 'Zoe', surname: 'Adams' });
    await call('addPerson', { given: 'Johann', surname: 'Müller', birthDate: 'abt 1850' });
    await call('addPerson', { given: 'Anna', surname: 'Müller' });

    const everyone = await call<PersonListPage>('listPersons', { query: ' ', offset: 0, limit: 2 });
    expect(everyone.total).toBe(3);
    expect(everyone.persons.map((person) => person.name?.given)).toEqual(['Zoe', 'Anna']);

    const found = await call<PersonListPage>('listPersons', {
      query: 'muller joh',
      offset: 0,
      limit: 50,
    });
    expect(found.total).toBe(1);
    expect(found.persons[0]).toMatchObject({
      name: { given: 'Johann' },
      birth: { dateText: 'abt 1850', year: 'c. 1850' },
    });

    const none = await call<PersonListPage>('listPersons', { query: '?!', offset: 0, limit: 50 });
    expect(none).toEqual({ total: 0, persons: [] });
  });

  it('builds a family through the edits the screens use, each one undoable', async () => {
    const start = await openNewTree();
    const mary = await addPerson('Mary', { sex: 'F', birthDate: '1819' });

    const father = await call<PersonChange>(
      'addParent',
      mary,
      { create: { given: 'Robert', sex: 'M' } },
      {},
    );
    const husband = await call<PersonChange>(
      'addPartner',
      mary,
      { create: { given: 'John', sex: 'M' } },
      {},
    );
    const page1 = await call<PersonPage>('getPersonPage', mary);
    const familyId = page1.partnerFamilies[0]?.familyId ?? '';
    const child = await call<PersonChange>(
      'addChild',
      mary,
      { create: { given: 'Child' } },
      { familyId },
    );
    await call('addFamilyEvent', familyId, { type: 'marriage', date: '6 May 1880' });
    await call('setPedigree', familyId, child.personId, 'adopted');
    await call('addName', mary, {
      type: 'married',
      given: 'Mary',
      surname: 'Cross',
      primary: true,
    });
    await call('updatePerson', mary, { living: false });
    await call('addPersonEvent', mary, { type: 'death', date: '22 Dec 1880', place: 'London' });

    const page = await call<PersonPage>('getPersonPage', mary);
    expect(page).toMatchObject({
      person: { sex: 'F', living: false },
      summary: { name: { surname: 'Cross' }, birth: { year: '1819' }, death: { year: '1880' } },
      names: [{ surname: 'Cross', isPrimary: true }, { surname: 'Test' }],
      events: [{ type: 'birth' }, { type: 'death', placeText: 'London' }],
      parentFamilies: [{ pedigree: 'birth', parents: [{ id: father.personId }], siblings: [] }],
      partnerFamilies: [
        {
          partner: { id: husband.personId },
          events: [{ type: 'marriage' }],
          children: [{ person: { id: child.personId }, pedigree: 'adopted' }],
        },
      ],
    });

    const deathId = page.events[1]?.id ?? '';
    await call('updateEvent', deathId, { type: 'death', date: '22 Dec 1880', place: 'Chelsea' });
    await call('deleteName', page.names[1]?.id ?? '');
    await call('removeChild', familyId, child.personId);
    const afterRemove = await call<TreeState>('removePartner', familyId, husband.personId);
    expect(afterRemove).toMatchObject({ persons: 4, undo: 'Remove partner from family' });
    expect(afterRemove.revision).toBeGreaterThan(start.revision);

    const undone = await call<TreeState>('undo');
    expect(undone).toMatchObject({
      undo: 'Remove child from family',
      redo: 'Remove partner from family',
    });
    const page2 = await call<PersonPage>('getPersonPage', mary);
    expect(page2.partnerFamilies[0]?.partner?.id).toBe(husband.personId);
    expect(page2.events[1]?.placeText).toBe('Chelsea');

    await call('redo');
    const deleted = await call<TreeState>('deletePerson', mary);
    expect(deleted.persons).toBe(3);
    expect(await call('getPersonPage', mary)).toBeNull();
    expect(await call('getPersonLife', mary)).toBeNull();
  });
});

describe('charts, relationships and duplicates', () => {
  /** A father and mother with a daughter and a son. Returns their ids. */
  async function smallFamily() {
    const father = await addPerson('Frank', { sex: 'M', birthDate: '1850' });
    const mother = (
      await call<PersonChange>('addPartner', father, { create: { given: 'Mary', sex: 'F' } }, {})
    ).personId;
    const page = await call<PersonPage>('getPersonPage', father);
    const familyId = page.partnerFamilies[0]?.familyId ?? '';
    const child = async (given: string, sex: string) =>
      (
        await call<PersonChange>(
          'addChild',
          father,
          { create: { given, surname: 'Test', sex } },
          { familyId },
        )
      ).personId;
    return { father, mother, daughter: await child('Dora', 'F'), son: await child('Sam', 'M') };
  }

  it('reads what a chart shows, in the directions asked for', async () => {
    await openNewTree();
    const { father, mother, daughter, son } = await smallFamily();

    const up = await call<ChartInfo>('getChart', { personId: son, ancestors: 3, descendants: 0 });
    expect(up.rootId).toBe(son);
    expect(up.ancestors.map((entry) => [entry.slot, entry.personId])).toEqual([
      [1, son],
      [2, father],
      [3, mother],
    ]);
    expect(up.descendants).toEqual({ personId: son, unions: [], more: false });
    expect(up.persons.map((person) => person.name?.given).sort()).toEqual(['Frank', 'Mary', 'Sam']);

    const down = await call<ChartInfo>('getChart', {
      personId: father,
      ancestors: 0,
      descendants: 2,
    });
    expect(down.ancestors).toEqual([]);
    expect(down.descendants.unions).toEqual([
      {
        partnerId: mother,
        children: [
          { personId: daughter, unions: [], more: false },
          { personId: son, unions: [], more: false },
        ],
      },
    ]);
    expect(down.truncated).toBe(false);

    expect(await call('getChart', { personId: MISSING, ancestors: 2, descendants: 2 })).toBeNull();
  });

  it('says how two people are related, in words', async () => {
    await openNewTree();
    const { father, mother, daughter, son } = await smallFamily();

    const sister = await call<RelationshipInfo>('getRelationship', son, daughter);
    expect(sister).toMatchObject({ kind: 'blood', term: 'sister', via: null, others: [] });
    expect(sister.person.name?.given).toBe('Sam');
    expect(sister.other.name?.given).toBe('Dora');
    expect(sister.commonAncestors.map((person) => person.id).sort()).toEqual(
      [father, mother].sort(),
    );
    expect(sister.path.map((person) => person.name?.given)).toHaveLength(3);

    expect((await call<RelationshipInfo>('getRelationship', daughter, father)).term).toBe('father');
    expect((await call<RelationshipInfo>('getRelationship', father, mother)).term).toBe('partner');
    const stranger = await addPerson('Stranger');
    expect(await call<RelationshipInfo>('getRelationship', son, stranger)).toMatchObject({
      kind: 'none',
      term: '',
      path: [],
    });
    expect((await errorOf('getRelationship', son, MISSING)).code).toBe('not-found');
  });

  it('finds duplicates, merges them in one undo step and remembers a "different people"', async () => {
    await openNewTree();
    const first = await addPerson('Eliza', { birthDate: '1840', birthPlace: 'York' });
    const second = await addPerson('Eliza', { birthDate: '1840', deathDate: '1901' });
    const third = await addPerson('Eliza');

    const list = await call<DuplicateList>('findDuplicates');
    expect(list.persons).toBe(3);
    expect(list.total).toBe(3);
    expect(list.truncated).toBe(false);
    expect(list.pairs[0]).toMatchObject({
      score: 75,
      reasons: ['Same name', 'Born in the same year'],
    });
    expect([list.pairs[0]?.a.id, list.pairs[0]?.b.id].sort()).toEqual([first, second].sort());

    const marked = await call<TreeState>('markNotDuplicate', first, third);
    expect(marked.undo).toBe('Mark as different people');
    expect((await call<DuplicateList>('findDuplicates')).total).toBe(2);

    const merged = await call<MergeInfo>('mergePersons', first, second);
    // The second birth has no place, so it is not an exact repeat of the first and is kept.
    expect(merged).toMatchObject({ personId: first, names: 0, events: 2, families: 0 });
    expect(merged.tree).toMatchObject({ persons: 2, undo: 'Merge people' });
    expect(await call('getPersonPage', second)).toBeNull();
    const page = await call<PersonPage>('getPersonPage', first);
    expect(page.events.map((event) => event.type)).toEqual(['birth', 'birth', 'death']);

    expect((await call<TreeState>('undo')).persons).toBe(3);
    expect(await call('getPersonPage', second)).not.toBeNull();
  });

  it('explains a merge that is not allowed', async () => {
    await openNewTree();
    const { father, mother, son } = await smallFamily();
    expect(await errorOf('mergePersons', son, father)).toEqual({
      code: 'rule',
      message: 'a person cannot be merged with their own ancestor or descendant',
    });
    expect((await errorOf('mergePersons', father, mother)).message).toMatch(
      /partners of each other/,
    );
    expect((await errorOf('mergePersons', son, son)).code).toBe('rule');
    expect((await errorOf('mergePersons', son, MISSING)).code).toBe('not-found');
    expect((await errorOf('markNotDuplicate', son, son)).code).toBe('rule');
  });

  it('needs an open tree', async () => {
    for (const [method, ...args] of [
      ['getChart', { personId: MISSING, ancestors: 1, descendants: 1 }],
      ['getRelationship', MISSING, MISSING],
      ['findDuplicates'],
      ['mergePersons', MISSING, MISSING],
      ['markNotDuplicate', MISSING, MISSING],
    ] as [(typeof API_METHODS)[number], ...unknown[]][]) {
      expect((await errorOf(method, ...args)).code, method).toBe('no-tree');
    }
  });
});

describe('sources and citations', () => {
  /** A tree with one person who has a birth. */
  async function start(): Promise<{ personId: string; birthId: string }> {
    await openNewTree();
    const personId = await addPerson('John', { birthDate: '1870' });
    const page = await call<PersonPage>('getPersonPage', personId);
    return { personId, birthId: page.events[0]?.id ?? '' };
  }

  it('adds, lists, edits and deletes sources', async () => {
    await openNewTree();
    const made = await call<SourceChange>('createSource', {
      title: ' Parish register ',
      author: 'The parish',
    });
    expect(made.tree).toMatchObject({ sources: 1, undo: 'Add source' });
    await call('createSource', { abbreviation: 'Family bible' });

    const all = await call<SourceListPage>('listSources', { query: '', offset: 0, limit: 10 });
    expect(all).toEqual({
      total: 2,
      sources: [
        // A source with only a short title is listed under it.
        { id: expect.any(String), title: 'Family bible', author: '', citations: 0 },
        { id: made.sourceId, title: 'Parish register', author: 'The parish', citations: 0 },
      ],
    });
    const found = await call<SourceListPage>('listSources', { query: 'par', offset: 0, limit: 10 });
    expect(found.total).toBe(1);

    const state = await call<TreeState>('updateSource', made.sourceId, {
      publication: 'York',
      note: ' Seen on film.\r\nHard to read. ',
    });
    expect(state.undo).toBe('Edit source');
    const details = await call<SourceDetails>('getSource', made.sourceId, { offset: 0, limit: 50 });
    expect(details).toEqual({
      source: {
        id: made.sourceId,
        title: 'Parish register',
        author: 'The parish',
        publication: 'York',
        abbreviation: '',
        text: '',
        note: 'Seen on film.\nHard to read.',
      },
      citationCount: 0,
      citations: [],
      keptLines: [],
    });

    expect((await call<TreeState>('deleteSource', made.sourceId)).sources).toBe(1);
    expect(await call('getSource', made.sourceId, { offset: 0, limit: 50 })).toBeNull();
    expect((await errorOf('createSource', { author: 'Nobody' })).code).toBe('rule');
    expect((await errorOf('deleteSource', MISSING)).code).toBe('not-found');
  });

  it('cites a source for a fact, and shows it on the person and on the source', async () => {
    const { personId, birthId } = await start();
    const birth = { type: 'event', id: birthId };
    const state = await call<TreeState>(
      'addCitation',
      birth,
      { create: { title: 'Parish register' } },
      { page: 'p. 12', text: 'John, son of Tom', quality: 3 },
    );
    expect(state).toMatchObject({ sources: 1, undo: 'Add citation' });

    const page = await call<PersonPage>('getPersonPage', personId);
    expect(page.citations).toHaveLength(1);
    const citation = page.citations[0];
    expect(citation).toMatchObject({
      sourceTitle: 'Parish register',
      page: 'p. 12',
      text: 'John, son of Tom',
      quality: 3,
      note: '',
      uses: [birth],
    });

    // The same citation for the person as a whole, then edited once for both.
    const person = { type: 'person', id: personId };
    await call('linkCitation', citation?.id, person);
    await call('updateCitation', citation?.id, { note: 'Seen in person', quality: null });
    const after = await call<PersonPage>('getPersonPage', personId);
    expect(after.citations).toHaveLength(1);
    expect(after.citations[0]).toMatchObject({ note: 'Seen in person', quality: null });
    expect(after.citations[0]?.uses).toEqual([person, birth]);

    const details = await call<SourceDetails>('getSource', citation?.sourceId, {
      offset: 0,
      limit: 50,
    });
    expect(details.citationCount).toBe(1);
    expect(details.citations[0]?.uses.map((use) => [use.what, use.persons[0]?.id])).toEqual([
      ['birth', personId],
      ['person', personId],
    ]);

    // Taken away from both facts, the citation is gone; its source stays.
    await call('unlinkCitation', citation?.id, person);
    expect((await call<PersonPage>('getPersonPage', personId)).citations).toHaveLength(1);
    await call('unlinkCitation', citation?.id, birth);
    expect((await call<PersonPage>('getPersonPage', personId)).citations).toEqual([]);
    expect((await errorOf('updateCitation', citation?.id, { page: 'x' })).code).toBe('not-found');
    expect(session.state().sources).toBe(1);

    // One Undo brings it back with its last link.
    await call('undo');
    expect((await call<PersonPage>('getPersonPage', personId)).citations[0]?.uses).toEqual([birth]);
  });

  it('refuses a citation of nothing, and deletes one for every fact at once', async () => {
    const { personId, birthId } = await start();
    const birth = { type: 'event', id: birthId };
    expect((await errorOf('addCitation', birth, { sourceId: MISSING }, {})).code).toBe('not-found');
    expect(
      (await errorOf('addCitation', { type: 'name', id: MISSING }, { create: { title: 'A' } }, {}))
        .code,
    ).toBe('not-found');
    expect((await errorOf('addCitation', birth, { create: {} }, {})).code).toBe('rule');
    expect(session.state().sources).toBe(0);

    await call('addCitation', birth, { create: { title: 'A' } }, {});
    const citation = (await call<PersonPage>('getPersonPage', personId)).citations[0];
    await call('linkCitation', citation?.id, { type: 'person', id: personId });
    await call('deleteCitation', citation?.id);
    expect((await call<PersonPage>('getPersonPage', personId)).citations).toEqual([]);
  });

  it('needs an open tree', async () => {
    const target = { type: 'event', id: MISSING };
    for (const [method, ...args] of [
      ['listSources', { query: '', offset: 0, limit: 10 }],
      ['getSource', MISSING, { offset: 0, limit: 10 }],
      ['createSource', { title: 'A' }],
      ['updateSource', MISSING, { title: 'A' }],
      ['deleteSource', MISSING],
      ['addCitation', target, { sourceId: MISSING }, {}],
      ['updateCitation', MISSING, {}],
      ['linkCitation', MISSING, target],
      ['unlinkCitation', MISSING, target],
      ['deleteCitation', MISSING],
    ] as [(typeof API_METHODS)[number], ...unknown[]][]) {
      expect((await errorOf(method, ...args)).code, method).toBe('no-tree');
    }
  });
});

describe('pictures and documents', () => {
  /** The first bytes of a PNG picture, followed by something to tell two files apart. */
  function png(name: string, mark = name): string {
    const file = join(root, name);
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(mark),
      ]),
    );
    return file;
  }

  async function start(): Promise<{ tree: TreeState; personId: string; birthId: string }> {
    const tree = await openNewTree();
    const personId = await addPerson('John', { birthDate: '1870' });
    const page = await call<PersonPage>('getPersonPage', personId);
    return { tree, personId, birthId: page.events[0]?.id ?? '' };
  }

  it('adds the files the user picked, and nothing when the dialog is cancelled', async () => {
    const { tree, personId, birthId } = await start();
    const person = { type: 'person', id: personId };
    expect(await call('addMedia', person)).toBeNull();
    expect(session.state().media).toBe(0);

    pickedFiles = [png('portrait.png'), png('wedding.png')];
    const added = await call<MediaAddResult>('addMedia', person);
    expect(added).toMatchObject({ chosen: 2, added: 2, attached: 2 });
    expect(added.mediaIds).toHaveLength(2);
    expect(added.tree).toMatchObject({ media: 2, undo: 'Add files' });

    const listed = await call<MediaInfo[]>('listMedia', person);
    expect(listed.map((media) => media.fileName)).toEqual(['portrait.png', 'wedding.png']);
    expect(listed[0]).toEqual({
      id: added.mediaIds[0],
      kind: 'image',
      mime: 'image/png',
      ext: 'png',
      size: 8 + 'portrait.png'.length,
      fileName: 'portrait.png',
      title: '',
      description: '',
      held: true,
      origin: '',
      present: true,
      canOpen: true,
    });
    // The page is given no path and no hash; the file is in the tree's own folder.
    expect(JSON.stringify(listed)).not.toContain(tree.dir.replaceAll('\\', '\\\\'));

    // The same file for the birth: the tree holds it already, so it is only attached.
    pickedFiles = [png('copy.png', 'portrait.png')];
    const again = await call<MediaAddResult>('addMedia', { type: 'event', id: birthId });
    expect(again).toMatchObject({
      chosen: 1,
      added: 0,
      attached: 1,
      mediaIds: [added.mediaIds[0]],
    });
    expect(again.tree).toMatchObject({ media: 2, undo: 'Add file' });

    const page = await call<PersonPage>('getPersonPage', personId);
    expect(page.media.map((media) => [media.fileName, media.uses])).toEqual([
      [
        'portrait.png',
        [
          { type: 'person', id: personId },
          { type: 'event', id: birthId },
        ],
      ],
      ['wedding.png', [{ type: 'person', id: personId }]],
    ]);

    // Attached to nothing: only the list of all files shows it.
    pickedFiles = [png('loose.png')];
    expect(await call<MediaAddResult>('addMedia', null)).toMatchObject({ added: 1, attached: 0 });
    const all = await call<MediaListPage>('listAllMedia', {
      query: '',
      unattached: false,
      notHeld: false,
      offset: 0,
      limit: 2,
    });
    expect(all.total).toBe(3);
    expect(all.media.map((media) => media.fileName)).toEqual(['loose.png', 'wedding.png']);
    const loose = await call<MediaListPage>('listAllMedia', {
      query: 'LOOSE',
      unattached: true,
      notHeld: false,
      offset: 0,
      limit: 10,
    });
    expect(loose).toMatchObject({ total: 1, media: [{ fileName: 'loose.png' }] });
  });

  it('shows a file with what it is attached to, and edits, detaches and deletes it', async () => {
    const { personId, birthId } = await start();
    const person = { type: 'person', id: personId };
    const birth = { type: 'event', id: birthId };
    await call('addCitation', birth, { create: { title: 'Parish register' } }, { page: 'p. 12' });
    const citationId = (await call<PersonPage>('getPersonPage', personId)).citations[0]?.id ?? '';

    pickedFiles = [png('scan.png')];
    const mediaId =
      (await call<MediaAddResult>('addMedia', { type: 'citation', id: citationId })).mediaIds[0] ??
      '';
    pickedFiles = [png('scan again.png', 'scan.png')];
    await call('addMedia', person);

    const details = await call<MediaDetails>('getMedia', mediaId);
    expect(details.media).toMatchObject({ id: mediaId, fileName: 'scan.png' });
    expect(
      details.uses.map((use) => [use.type, use.what, use.detail, use.persons.map((p) => p.id)]),
    ).toEqual([
      ['citation', 'citation', 'Parish register, p. 12', [personId]],
      ['person', 'person', '', [personId]],
    ]);
    // On the person's page the scan of a citation is listed too.
    const page = await call<PersonPage>('getPersonPage', personId);
    expect(page.media[0]?.uses).toEqual([
      { type: 'person', id: personId },
      { type: 'citation', id: citationId },
    ]);

    const edited = await call<TreeState>('updateMedia', mediaId, {
      title: ' Baptism of John ',
      description: 'Entry 4',
    });
    expect(edited.undo).toBe('Edit file details');
    expect((await call<MediaDetails>('getMedia', mediaId)).media).toMatchObject({
      title: 'Baptism of John',
      description: 'Entry 4',
    });

    expect((await call<TreeState>('unlinkMedia', mediaId, person)).undo).toBe('Remove file');
    expect((await call<MediaDetails>('getMedia', mediaId)).uses).toHaveLength(1);

    const deleted = await call<TreeState>('deleteMedia', mediaId);
    expect(deleted).toMatchObject({ media: 0, undo: 'Delete file' });
    expect(await call('getMedia', mediaId)).toBeNull();
    expect((await call<TreeState>('undo')).media).toBe(1);
    expect((await call<MediaDetails>('getMedia', mediaId)).media.present).toBe(true);

    expect((await errorOf('updateMedia', MISSING, { title: 'x' })).code).toBe('not-found');
    expect((await errorOf('deleteMedia', MISSING)).code).toBe('not-found');
  });

  it('opens a file in another program only when its kind cannot run', async () => {
    const { tree, personId } = await start();
    const person = { type: 'person', id: personId };
    const program = join(root, 'setup.exe');
    writeFileSync(program, 'MZ this would be a program');
    pickedFiles = [png('portrait.png'), program];
    const [pictureId, programId] = (await call<MediaAddResult>('addMedia', person)).mediaIds;

    await call('openMedia', pictureId);
    expect(openedFiles).toHaveLength(1);
    expect(openedFiles[0]).toMatch(/[0-9a-f]{64}\.png$/);
    expect(openedFiles[0]?.startsWith(join(tree.dir, 'media'))).toBe(true);
    expect(
      readFileSync(openedFiles[0] ?? '')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');

    // A program is kept like any other file, shown in its folder, and never started.
    const listed = await call<MediaInfo[]>('listMedia', person);
    expect(listed[1]).toMatchObject({ kind: 'document', ext: 'exe', canOpen: false });
    const refused = await errorOf('openMedia', programId);
    expect(refused.code).toBe('rule');
    expect(refused.message).toMatch(/does not open files of this kind/);
    expect(openedFiles).toHaveLength(1);
    await call('showMediaInFolder', programId);
    expect(shownFiles).toHaveLength(1);
    expect(shownFiles[0]).toMatch(/[0-9a-f]{64}\.exe$/);

    // A file that has gone from the folder is reported, not opened.
    rmSync(openedFiles[0] ?? '');
    expect((await call<MediaInfo[]>('listMedia', person))[0]?.present).toBe(false);
    for (const method of ['openMedia', 'showMediaInFolder'] as const) {
      const gone = await errorOf(method, pictureId);
      expect(gone.code).toBe('rule');
      expect(gone.message).toMatch(/portrait\.png is not in the tree's media folder any more/);
    }
    expect((await errorOf('openMedia', MISSING)).code).toBe('not-found');
  });

  it('explains a file that cannot be added, and adds none of the others', async () => {
    const { personId } = await start();
    writeFileSync(join(root, 'empty.png'), '');
    pickedFiles = [png('good.png'), join(root, 'empty.png')];
    const failed = await errorOf('addMedia', { type: 'person', id: personId });
    expect(failed).toEqual({ code: 'rule', message: 'empty.png is empty' });
    expect(session.state().media).toBe(0);

    pickedFiles = [png('good.png')];
    expect((await errorOf('addMedia', { type: 'event', id: MISSING })).code).toBe('not-found');
    expect(session.state().media).toBe(0);
  });

  it('names the files in a GEDCOM file, and carries them in a GEDZip file', async () => {
    const { personId } = await start();
    pickedFiles = [png('a.png'), png('b.png')];
    await call('addMedia', { type: 'person', id: personId });

    savePath = join(root, 'out.ged');
    const named = await call<GedcomExportInfo>('exportGedcom', {
      version: '5.5.1',
      includeLiving: true,
      withFiles: false,
    });
    expect(named).toMatchObject({ withFiles: false, media: 2, mediaFiles: 0, mediaNotHeld: 0 });
    const text = readFileSync(named.file, 'utf8');
    expect(text).toContain('1 FILE media/a.png');
    expect(text).toContain('1 OBJE @M1@');

    // A name typed without an extension gets .gdz, and the dialog starts on one.
    savePath = join(root, 'with pictures');
    const carried = await call<GedcomExportInfo>('exportGedcom', {
      version: '7.0',
      includeLiving: true,
      withFiles: true,
    });
    expect(carried).toMatchObject({
      file: join(root, 'with pictures.gdz'),
      withFiles: true,
      media: 2,
      mediaFiles: 2,
      mediaNotHeld: 0,
    });
    expect(dialogDefaults.at(-1)).toMatch(/\.gdz$/);
    // A zip file starts with "PK".
    expect(readFileSync(carried.file).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('imports a GEDZip file with its pictures', async () => {
    const { personId } = await start();
    pickedFiles = [png('a.png'), png('b.png')];
    await call('addMedia', { type: 'person', id: personId });
    savePath = join(root, 'family.gdz');
    await call('exportGedcom', { version: '5.5.1', includeLiving: true, withFiles: true });

    pickedFile = savePath;
    const result = await call<GedcomImportResult>('importGedcom', {
      name: 'From a zip',
      parentDir: join(root, 'Trees'),
    });
    expect(result.report).toMatchObject({ fileName: 'family.gdz', media: 2, mediaHeld: 2 });
    expect(result.tree).toMatchObject({ name: 'From a zip', persons: 1, media: 2 });
    const page = await call<MediaListPage>('listAllMedia', {
      query: '',
      unattached: false,
      notHeld: false,
      offset: 0,
      limit: 10,
    });
    expect(page).toMatchObject({ total: 2, notHeld: 0 });
    expect(page.media.every((media) => media.held && media.present)).toBe(true);
    expect(page.media.map((media) => media.origin).sort()).toEqual(['media/a.png', 'media/b.png']);
  });

  it('knows of the files a GEDCOM file names, and takes them when they are given', async () => {
    const { personId } = await start();
    const first = png('a.png');
    pickedFiles = [first, png('b.png')];
    await call('addMedia', { type: 'person', id: personId });
    savePath = join(root, 'names only.ged');
    await call('exportGedcom', { version: '5.5.1', includeLiving: true, withFiles: false });

    pickedFile = savePath;
    const imported = await call<GedcomImportResult>('importGedcom', {
      name: 'Names only',
      parentDir: join(root, 'Trees'),
    });
    expect(imported.report).toMatchObject({ media: 2, mediaHeld: 0 });
    const list = () =>
      call<MediaListPage>('listAllMedia', {
        query: '',
        unattached: false,
        notHeld: true,
        offset: 0,
        limit: 10,
      });
    const before = await list();
    expect(before).toMatchObject({ total: 2, notHeld: 2 });
    const one = before.media.find((media) => media.origin === 'media/a.png');
    expect(one).toMatchObject({ held: false, present: false, kind: 'image', fileName: 'a.png' });
    const mediaId = one?.id ?? '';
    // There is nothing to open or to show in a folder yet.
    expect(await errorOf('openMedia', mediaId)).toMatchObject({ code: 'rule' });
    expect((await errorOf('showMediaInFolder', mediaId)).message).toMatch(
      /does not hold this file/,
    );

    // One file is chosen by hand. A cancelled dialog changes nothing, and two files are one too many.
    filesDialogs = 0;
    pickedFiles = [];
    expect(await call('chooseMediaFile', mediaId)).toBeNull();
    pickedFiles = [first, png('b.png')];
    expect(await errorOf('chooseMediaFile', mediaId)).toMatchObject({ code: 'rule' });
    pickedFiles = [first];
    const chosen = await call<TreeState>('chooseMediaFile', mediaId);
    expect(chosen.undo).toBe('Add the file');
    expect(filesDialogs).toBe(3);
    expect((await call<MediaDetails>('getMedia', mediaId)).media).toMatchObject({
      held: true,
      present: true,
      origin: 'media/a.png',
    });
    expect(await errorOf('chooseMediaFile', mediaId)).toMatchObject({ code: 'rule' });
    expect(filesDialogs).toBe(3);
    expect((await errorOf('chooseMediaFile', MISSING)).code).toBe('not-found');

    // The other is found in a folder. A cancelled folder dialog changes nothing.
    expect(await call('findMediaFiles')).toBeNull();
    pickedFolder = root;
    const found = await call<MediaFindResult>('findMediaFiles');
    expect(found).toMatchObject({ wanted: 1, found: 1, ambiguous: 0, truncated: false });
    expect(found.tree.undo).toBe('Find file');
    expect(await list()).toMatchObject({ total: 0, notHeld: 0 });

    await call('undo');
    await call('undo');
    expect(await list()).toMatchObject({ total: 2, notHeld: 2 });
  });

  it('needs an open tree, and does not show the file dialog without one', async () => {
    const target = { type: 'person', id: MISSING };
    pickedFiles = [png('a.png')];
    for (const [method, ...args] of [
      ['listMedia', target],
      ['listAllMedia', { query: '', unattached: false, notHeld: false, offset: 0, limit: 10 }],
      ['getMedia', MISSING],
      ['addMedia', target],
      ['addMedia', null],
      ['updateMedia', MISSING, {}],
      ['unlinkMedia', MISSING, target],
      ['deleteMedia', MISSING],
      ['chooseMediaFile', MISSING],
      ['findMediaFiles'],
      ['openMedia', MISSING],
      ['showMediaInFolder', MISSING],
    ] as [(typeof API_METHODS)[number], ...unknown[]][]) {
      expect((await errorOf(method, ...args)).code, method).toBe('no-tree');
    }
    expect(filesDialogs).toBe(0);
  });
});

describe('backups', () => {
  it('backs up, lists, restores and shows the folder', async () => {
    const tree = await openNewTree();
    await addPerson('Kept');
    const first = await call<{ tree: TreeState; created: { name: string } | null }>('backupNow');
    expect(first.created).not.toBeNull();
    expect(first.tree.lastBackupAt).toEqual(expect.any(Number));
    expect((await call<{ created: unknown }>('backupNow')).created).toBeNull();

    await addPerson('Mistake');
    const restored = await call<TreeState>('restoreBackup', first.created?.name ?? '');
    expect(restored.persons).toBe(1);
    expect(await call<unknown[]>('listBackups')).toHaveLength(2);

    await call('showBackupsFolder');
    expect(openedFolders).toEqual([join(tree.dir, BACKUP_DIR_NAME)]);
    expect(existsSync(openedFolders[0] ?? '')).toBe(true);
  });
});

describe('GEDCOM files', () => {
  const FILE = [
    '0 HEAD',
    '1 GEDC',
    '2 VERS 5.5.1',
    '1 CHAR UTF-8',
    '0 @I1@ INDI',
    '1 NAME Old /Smith/',
    '1 BIRT',
    '2 DATE 1850',
    '1 _UID ABC123',
    '1 NOTE A note of the person.',
    '1 FAMS @F1@',
    '0 @I2@ INDI',
    '1 NAME Young /Smith/',
    '1 FAMC @F1@',
    '1 FAMC @F9@',
    '0 @F1@ FAM',
    '1 HUSB @I1@',
    '1 CHIL @I2@',
    '0 @S1@ SOUR',
    '1 TITL A source',
    '0 TRLR',
    '',
  ].join('\n');

  function writeGedcom(name = 'Smith family.ged'): string {
    const path = join(root, name);
    writeFileSync(path, FILE);
    return path;
  }

  it('imports the file the user picked into a new tree and opens it', async () => {
    pickedFile = writeGedcom();
    const result = await call<GedcomImportResult>('importGedcom', {
      name: '',
      parentDir: join(root, 'Trees'),
    });
    expect(result.tree).toMatchObject({
      name: 'Smith family',
      dir: join(root, 'Trees', 'Smith family'),
      persons: 2,
      families: 1,
      events: 1,
      undo: null,
    });
    expect(result.report).toEqual({
      fileName: 'Smith family.ged',
      version: '5.5.1',
      encoding: 'UTF-8',
      persons: 2,
      families: 1,
      events: 1,
      sources: 1,
      citations: 0,
      media: 0,
      mediaHeld: 0,
      keptRecords: 0,
      // One line of the first person, and the link to a family that is not in the file.
      keptLines: 2,
      issues: [
        {
          line: 15,
          message: 'FAMC @F9@ is not a family in this file; the line is kept as written',
        },
      ],
      issueCount: 1,
    });
    // The dialog starts where trees are kept, and the tree is now the open one.
    expect(dialogDefaults).toEqual([join(root, 'Trees')]);
    expect((await call<{ tree: TreeState }>('getStartInfo')).tree?.name).toBe('Smith family');
  });

  it('opens nothing when the file dialog is cancelled or the file is not GEDCOM', async () => {
    const input = { name: 'Mine', parentDir: join(root, 'Trees') };
    expect(await call('importGedcom', input)).toBeNull();

    pickedFile = join(root, 'letter.ged');
    writeFileSync(pickedFile, 'Dear John,\nthis is not a family tree.\n');
    expect(await errorOf('importGedcom', input)).toEqual({
      code: 'rule',
      message: 'this is not a GEDCOM file: it has no header, people or families',
    });
    // No folder was made for a tree that could not be imported.
    expect(existsSync(join(root, 'Trees', 'Mine'))).toBe(false);
    expect((await errorOf('getPersonPage', MISSING)).code).toBe('no-tree');
  });

  it('makes the tree only where the user picked a folder, and checks the name it is given', async () => {
    pickedFile = writeGedcom();
    expect(await errorOf('importGedcom', { name: '', parentDir: join(root, 'Elsewhere') })).toEqual(
      { code: 'rule', message: 'choose the folder for the new tree again' },
    );
    expect((await errorOf('importGedcom', { name: 'x'.repeat(101), parentDir: root })).code).toBe(
      'invalid',
    );
    expect((await errorOf('importGedcom', { parentDir: root })).code).toBe('invalid');
    expect(
      (await errorOf('importGedcom', { name: '', parentDir: root, file: pickedFile })).code,
    ).toBe('invalid');
  });

  it('shows the lines of an imported person that the app has no fields for', async () => {
    pickedFile = writeGedcom();
    await call('importGedcom', { name: 'Mine', parentDir: join(root, 'Trees') });
    const list = await call<PersonListPage>('listPersons', { query: 'old', offset: 0, limit: 10 });
    const page = await call<PersonPage>('getPersonPage', list.persons[0]?.id ?? '');
    expect(page.keptLines).toEqual(['1 _UID ABC123']);
    expect(page.person.note).toBe('A note of the person.');

    // Someone added in the app has none.
    const added = await addPerson('New');
    expect((await call<PersonPage>('getPersonPage', added)).keptLines).toEqual([]);
  });

  it('exports the open tree to the file the user chose, and gives the file back as it was', async () => {
    pickedFile = writeGedcom();
    const imported = await call<GedcomImportResult>('importGedcom', {
      name: 'Mine',
      parentDir: join(root, 'Trees'),
    });
    expect(await call<number>('countPresumedLiving')).toBe(1);

    // Cancelled: nothing is written.
    expect(
      await call('exportGedcom', { version: '5.5.1', includeLiving: true, withFiles: false }),
    ).toBeNull();
    expect(dialogDefaults[1]).toBe(join(root, 'Trees', 'Mine.ged'));

    // A name typed without an extension gets .ged.
    savePath = join(root, 'out');
    const everyone = await call<GedcomExportInfo>('exportGedcom', {
      version: '5.5.1',
      includeLiving: true,
      withFiles: false,
    });
    expect(everyone).toEqual({
      file: join(root, 'out.ged'),
      version: '5.5.1',
      persons: 2,
      families: 1,
      livingOmitted: 0,
      unconverted: [],
      withFiles: false,
      media: 0,
      mediaFiles: 0,
      mediaNotHeld: 0,
      mediaWithheld: 0,
    });
    const written = readFileSync(everyone.file, 'utf8');
    expect(written).toContain('2 VERS 1.2.3-test');
    // Everything after the header is the imported file, line for line.
    const body = (text: string) => text.slice(text.indexOf('0 @I1@ INDI'));
    expect(body(written)).toBe(body(FILE));

    savePath = join(root, 'shared.ged');
    const shared = await call<GedcomExportInfo>('exportGedcom', {
      version: '7.0',
      includeLiving: false,
      withFiles: false,
    });
    expect(shared).toMatchObject({ version: '7.0', persons: 1, families: 1, livingOmitted: 1 });
    expect(readFileSync(shared.file, 'utf8')).not.toContain('Young');

    // The export changes nothing in the tree.
    expect((await call<{ tree: TreeState }>('getStartInfo')).tree?.revision).toBe(
      imported.tree.revision,
    );
  });

  it('checks what the page sends for an export, and needs an open tree', async () => {
    expect(
      (await errorOf('exportGedcom', { version: '5.5.1', includeLiving: true, withFiles: false }))
        .code,
    ).toBe('no-tree');
    expect((await errorOf('countPresumedLiving')).code).toBe('no-tree');
    await openNewTree();
    savePath = join(root, 'out.ged');
    for (const bad of [
      { version: '5.5', includeLiving: true, withFiles: false },
      { version: '7.0', withFiles: false },
      { version: '7.0', includeLiving: 'yes', withFiles: false },
      { version: '7.0', includeLiving: true },
      { version: '7.0', includeLiving: true, withFiles: 1 },
      { version: '7.0', includeLiving: true, withFiles: true, file: 'C:\\somewhere\\else.gdz' },
    ]) {
      expect((await errorOf('exportGedcom', bad)).code, JSON.stringify(bad)).toBe('invalid');
    }
    expect(existsSync(savePath)).toBe(false);
  });
});

describe('places and the gazetteer', () => {
  const SPRINGFIELD = 4250542;
  const SPRINGFIELD_TEXT = 'Springfield, Sangamon County, Illinois, USA';

  /** Downloads the sample gazetteer and waits until it is in use. */
  async function download(): Promise<GazetteerStatus> {
    const started = await call<GazetteerStatus>('downloadGazetteer');
    expect(started.job?.phase).toBe('downloading');
    await gazetteer.idle();
    return call<GazetteerStatus>('getGazetteerStatus');
  }

  async function places(filter: 'all' | 'linked' | 'unlinked' = 'all'): Promise<PlaceListPage> {
    return call<PlaceListPage>('listPlaces', { query: '', filter, offset: 0, limit: 50 });
  }

  it('has no gazetteer at first, downloads one, and removes it', async () => {
    const before = await call<GazetteerStatus>('getGazetteerStatus');
    expect(before).toMatchObject({ installed: null, job: null, error: null });
    expect(before.downloadBytes).toBeGreaterThan(50_000_000);

    const after = await download();
    expect(after).toMatchObject({ installed: { places: 5, countries: ['US', 'NL'] }, job: null });
    expect((await call<GazetteerStatus>('removeGazetteer')).installed).toBeNull();
  });

  it('stops a download when asked', async () => {
    await call<GazetteerStatus>('downloadGazetteer');
    const stopped = await call<GazetteerStatus>('cancelGazetteerDownload');
    expect(stopped).toMatchObject({ job: null, error: null });
  });

  it('offers the places of the tree, and those of the gazetteer once it is there', async () => {
    await openNewTree();
    await addPerson('Ann', { birthPlace: 'Springdale, Iowa' });
    const before = await call<PlaceSuggestions>('suggestPlaces', 'spring');
    expect(before).toEqual({
      own: [{ text: 'Springdale, Iowa', events: 1, link: null }],
      gazetteer: [],
      installed: false,
    });

    await download();
    const after = await call<PlaceSuggestions>('suggestPlaces', 'spring');
    expect(after.installed).toBe(true);
    expect(after.own).toHaveLength(1);
    expect(after.gazetteer).toEqual([
      {
        geonameId: SPRINGFIELD,
        text: SPRINGFIELD_TEXT,
        kind: 'place',
        lat: 39.80172,
        lon: -89.64371,
      },
      {
        geonameId: 4409896,
        text: 'Springfield, Greene County, Missouri, USA',
        kind: 'place',
        lat: 37.21533,
        lon: -93.29824,
      },
    ]);
    const region = await call<PlaceSuggestions>('suggestPlaces', 'Sangamon');
    expect(region.gazetteer[0]).toMatchObject({
      kind: 'region',
      text: 'Sangamon County, Illinois, USA',
    });
  });

  it('links the place of an event that was picked from the gazetteer, in the same step', async () => {
    await download();
    await openNewTree();
    const ann = await addPerson('Ann');
    const state = await call<TreeState>('addPersonEvent', ann, {
      type: 'residence',
      place: SPRINGFIELD_TEXT,
      placeGeonameId: SPRINGFIELD,
    });
    expect(state.undo).toBe('Add event');
    expect((await places()).places).toEqual([
      {
        text: SPRINGFIELD_TEXT,
        events: 1,
        link: { geonamesId: SPRINGFIELD, name: SPRINGFIELD_TEXT, lat: 39.80172, lon: -89.64371 },
      },
    ]);
    await call<TreeState>('undo');
    expect((await places()).all).toBe(0);
    expect((await call<PlaceSuggestions>('suggestPlaces', 'spring')).own).toEqual([]);
  });

  it('links the birth and death places of a new person', async () => {
    await download();
    await openNewTree();
    await addPerson('Ann', {
      birthPlace: SPRINGFIELD_TEXT,
      birthPlaceGeonameId: SPRINGFIELD,
      deathPlace: 'York',
      deathPlaceGeonameId: 2633352,
    });
    const page = await places('linked');
    expect(page.places.map((place) => [place.text, place.link?.name])).toEqual([
      [SPRINGFIELD_TEXT, SPRINGFIELD_TEXT],
      ['York', 'York, England'],
    ]);
    expect(page).toMatchObject({ total: 2, all: 2, linked: 2 });
  });

  it('saves a place as typed when the gazetteer entry is not there', async () => {
    await openNewTree();
    const ann = await addPerson('Ann');
    await call<TreeState>('addPersonEvent', ann, {
      type: 'residence',
      place: 'Springfield',
      placeGeonameId: SPRINGFIELD,
    });
    expect((await places()).places).toEqual([{ text: 'Springfield', events: 1, link: null }]);
  });

  it('lists the places, offers the entry that fits one best, and links and unlinks them', async () => {
    await download();
    await openNewTree();
    const ann = await addPerson('Ann', {
      birthPlace: 'Springfield, Sangamon, Illinois, USA',
      deathPlace: 'Somewhere else entirely',
    });
    const page = await places();
    expect(page).toMatchObject({ total: 2, all: 2, linked: 0 });
    expect(page.places.map((place) => place.text)).toEqual([
      'Somewhere else entirely',
      'Springfield, Sangamon, Illinois, USA',
    ]);
    const offer = (place: string) => call<GazetteerEntry | null>('offerPlace', place);
    expect(await offer('Somewhere else entirely')).toBeNull();
    expect(await offer('Springfield, Sangamon, Illinois, USA')).toEqual({
      geonameId: SPRINGFIELD,
      text: SPRINGFIELD_TEXT,
      kind: 'place',
      lat: 39.80172,
      lon: -89.64371,
    });
    // A village the gazetteer does not have is not tied to its county with one press.
    expect(await offer('Smallville, Sangamon, Illinois')).toBeNull();
    expect(await offer(', Sangamon, Illinois')).toMatchObject({ kind: 'region' });

    const linked = await call<TreeState>(
      'linkPlace',
      'Springfield, Sangamon, Illinois, USA',
      SPRINGFIELD,
    );
    expect(linked.undo).toBe('Link place');
    expect(await places('linked')).toMatchObject({ total: 1, all: 2, linked: 1 });
    // The person's life says where the linked place lies, and nothing for the other.
    const life = await call<PersonLifeInfo>('getPersonLife', ann);
    expect(life.entries).toMatchObject([
      {
        kind: 'own',
        event: { type: 'birth' },
        relation: null,
        person: null,
        place: { geonamesId: SPRINGFIELD, name: SPRINGFIELD_TEXT, lat: 39.80172, lon: -89.64371 },
        age: null,
      },
      { kind: 'own', event: { type: 'death' }, place: null, age: null },
    ]);
    expect((await places('unlinked')).places.map((place) => place.text)).toEqual([
      'Somewhere else entirely',
    ]);
    // The place itself is still as it was typed.
    expect((await places('linked')).places[0]?.text).toBe('Springfield, Sangamon, Illinois, USA');

    const unlinked = await call<TreeState>('unlinkPlace', 'Springfield, Sangamon, Illinois, USA');
    expect(unlinked.undo).toBe('Unlink place');
    expect((await places()).linked).toBe(0);
  });

  it('keeps the links of a tree when the gazetteer is removed', async () => {
    await download();
    await openNewTree();
    await addPerson('Ann', { birthPlace: 'York', birthPlaceGeonameId: 2633352 });
    await call<GazetteerStatus>('removeGazetteer');
    expect((await places()).places[0]?.link).toMatchObject({
      name: 'York, England',
      lat: 53.95763,
    });
  });

  it('refuses a link to an entry the gazetteer does not have, and what is no place', async () => {
    await openNewTree();
    await addPerson('Ann', { birthPlace: 'York' });
    expect(await errorOf('linkPlace', 'York', 2633352)).toMatchObject({ code: 'rule' });
    expect(await errorOf('linkPlace', '', 2633352)).toMatchObject({ code: 'invalid' });
    expect(await errorOf('linkPlace', 'York', -1)).toMatchObject({ code: 'invalid' });
    expect(await errorOf('linkPlace', 'York', 1.5)).toMatchObject({ code: 'invalid' });
    expect(await errorOf('offerPlace', 5)).toMatchObject({ code: 'invalid' });
    expect(
      await errorOf('listPlaces', { query: '', filter: 'all', offset: 0, limit: 500 }),
    ).toMatchObject({ code: 'invalid' });
    expect(
      await errorOf('addPersonEvent', MISSING, { type: 'birth', placeGeonameId: 'York' }),
    ).toMatchObject({ code: 'invalid' });
  });

  it('needs an open tree for the places, but not for the gazetteer', async () => {
    expect(await errorOf('suggestPlaces', 'york')).toMatchObject({ code: 'no-tree' });
    expect(
      await errorOf('listPlaces', { query: '', filter: 'all', offset: 0, limit: 10 }),
    ).toMatchObject({
      code: 'no-tree',
    });
    expect(await call<GazetteerStatus>('getGazetteerStatus')).toMatchObject({ installed: null });
    expect(await call<GazetteerEntry | null>('offerPlace', 'York')).toBeNull();
  });

  it('does not remove the gazetteer while it is being downloaded', async () => {
    await call<GazetteerStatus>('downloadGazetteer');
    expect(await errorOf('removeGazetteer')).toMatchObject({ code: 'rule' });
    await gazetteer.idle();
  });
});

describe('the search for records', () => {
  const search = (personId: string, query: object = QUERY, sourceId = 'wikitree') =>
    call<RecordSearchResult>('searchRecords', { personId, sourceId, query, offset: 0 });

  it('starts with the name and the years of someone who has died', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', {
      birthDate: '12 MAR 1850',
      deathDate: 'BET 1910 AND 1920',
    });
    const setup = await call<RecordSearchSetup>('getRecordSearch', ada);
    expect(setup.allowed).toBe(true);
    expect(setup.agreed).toBe(false);
    expect(setup.query).toEqual({
      given: 'Ada',
      surname: 'Test',
      birthYear: 1850,
      deathYear: 1915,
    });
    expect(setup.sources.map((source) => [source.id, source.searches])).toEqual([
      ['wikitree', 'person'],
      ['open-archives', 'person'],
      ['wikidata', 'person'],
      ['loc', 'text'],
      ['internet-archive', 'text'],
      ['nara-catalog', 'text'],
    ]);
    // The Library of Congress is known to be slow, and is given more time than the others.
    expect(setup.sources.map((source) => source.slowSeconds)).toEqual([
      null,
      null,
      null,
      90,
      null,
      null,
    ]);
    // Only the National Archives need a key, and count what they are asked.
    expect(setup.sources.map((source) => source.key)).toEqual([
      'none',
      'none',
      'none',
      'none',
      'none',
      'missing',
    ]);
    expect(setup.sources.map((source) => source.quota?.ceiling ?? null)).toEqual([
      null,
      null,
      null,
      null,
      null,
      9000,
    ]);
    // Every source says what it is sent.
    expect(setup.sources.every((source) => source.asks !== '')).toBe(true);
    // Newspapers are asked for the name as a phrase, from the birth to the year after the death.
    expect(setup.text).toEqual({
      words: 'Ada Test',
      phrase: true,
      fromYear: 1850,
      toYear: 1916,
      state: '',
    });
    expect(setup.sources[0]?.pausedUntil).toBeNull();
    expect(await call('getRecordSearch', MISSING)).toBeNull();
    expect(askedOfSources).toEqual([]);
  });

  it('sends nothing before the user has agreed to the notice', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const refused = await search(ada);
    expect(refused).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    expect(askedOfSources).toEqual([]);

    await call('agreeToRecordSearch');
    expect((await call<RecordSearchSetup>('getRecordSearch', ada)).agreed).toBe(true);
    const found = await search(ada);
    expect(found).toMatchObject({
      ok: true,
      sourceId: 'wikitree',
      total: 2,
      hidden: 1,
      cached: false,
    });
    if (!found.ok) throw new Error('the search failed');
    expect(found.items).toEqual([
      {
        connectorId: 'wikitree',
        key: 'Test-90001',
        kind: 'person',
        title: 'Ada Test',
        url: 'https://www.wikitree.com/wiki/Test-90001',
        sex: null,
        facts: [{ type: 'birth', date: 'MAR 1850', place: '' }],
        about: '',
      },
    ]);
    expect(askedOfSources).toHaveLength(1);
    const asked = new URL(askedOfSources[0] ?? '');
    expect(asked.origin + asked.pathname).toBe('https://api.wikitree.com/api.php');
    // The name and the years, and nothing else of the tree.
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      action: 'searchPerson',
      appId: 'RulZAncestry',
      FirstName: 'Ada',
      LastName: 'Test',
      BirthDate: '1850',
      dateSpread: '2',
      limit: '20',
      start: '0',
      fields: asked.searchParams.get('fields'),
    });

    // The same search again is answered from memory.
    expect(await search(ada)).toMatchObject({ ok: true, cached: true });
    expect(askedOfSources).toHaveLength(1);
  });

  it('sends nothing about a person who may be living, whatever the page asks', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const recent = await addPerson('Rita', { birthDate: '1990' });
    const undated = await addPerson('Una');
    const marked = await addPerson('Liv', { birthDate: '1700', living: true });
    for (const person of [recent, undated, marked]) {
      const setup = await call<RecordSearchSetup>('getRecordSearch', person);
      expect(setup.allowed).toBe(false);
      // Nothing of the person is handed to the form.
      expect(setup.query).toEqual({ given: '', surname: '', birthYear: null, deathYear: null });
      expect(setup.text).toMatchObject({ words: '', fromYear: null, toYear: null });
      expect(await search(person)).toMatchObject({ ok: false, problem: { kind: 'living' } });
    }
    expect(askedOfSources).toEqual([]);

    // Once something shows that the person has died, they can be searched for.
    await call('addPersonEvent', undated, { type: 'death' });
    expect((await call<RecordSearchSetup>('getRecordSearch', undated)).allowed).toBe(true);
    expect(await search(undated)).toMatchObject({ ok: true });
  });

  it('refuses a search that names nobody, a person who is gone and a source it does not know', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const empty = { given: ' ', surname: '', birthYear: 1850, deathYear: null };
    expect(await search(ada, empty)).toMatchObject({ ok: false, problem: { kind: 'empty' } });
    expect(await search(ada, QUERY, 'find-a-grave')).toMatchObject({
      ok: false,
      problem: { kind: 'source' },
    });
    expect(await search(MISSING)).toMatchObject({ ok: false, problem: { kind: 'gone' } });
    expect(askedOfSources).toEqual([]);
  });

  it('says which results the page of the person cites already', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    expect(await search(ada)).toMatchObject({ ok: true, attached: [] });
    await call('attachRecord', { personId: ada, sourceId: 'wikitree', key: 'Test-90001' });
    expect(await search(ada)).toMatchObject({ ok: true, attached: ['Test-90001'] });
  });

  it('forgets what was found when another tree is opened', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    await search(ada);
    // Without closing the first tree by hand.
    await call('createTree', { name: 'Second', parentDir: join(root, 'Trees') });
    const again = await addPerson('Ada', { birthDate: '1850' });
    expect(await search(again)).toMatchObject({ ok: true, cached: false });
    expect(askedOfSources).toHaveLength(2);
  });
});

describe('attaching a result of the search', () => {
  const search = (personId: string) =>
    call<RecordSearchResult>('searchRecords', {
      personId,
      sourceId: 'wikitree',
      query: QUERY,
      offset: 0,
    });
  const attach = (personId: string, key = 'Test-90001', sourceId = 'wikitree') =>
    call<AttachRecordResult>('attachRecord', { personId, sourceId, key });

  it('cites the record for the person in one step, and sends nothing', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    await search(ada);
    const asked = askedOfSources.length;

    const result = await attach(ada);
    if (!result.ok) throw new Error(result.problem.message);
    expect(result.added).toBe(true);
    expect(result.tree.sources).toBe(1);
    const page = await call<PersonPage>('getPersonPage', ada);
    expect(page.citations).toMatchObject([
      {
        id: result.citationId,
        sourceTitle: 'WikiTree',
        page: 'Ada Test (Test-90001)',
        text: 'Born March 1850',
        quality: null,
        note: '',
        url: 'https://www.wikitree.com/wiki/Test-90001',
        accessedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        uses: [{ type: 'person', id: ada }],
      },
    ]);
    expect(askedOfSources).toHaveLength(asked);

    // A second click adds nothing.
    expect(await attach(ada)).toMatchObject({
      ok: true,
      added: false,
      citationId: result.citationId,
    });
    expect((await call<PersonPage>('getPersonPage', ada)).citations).toHaveLength(1);

    // One Undo takes the citation and the source back.
    const undone = await call<TreeState>('undo');
    expect(undone.sources).toBe(0);
    expect((await call<PersonPage>('getPersonPage', ada)).citations).toEqual([]);
  });

  it('takes nothing from the page but the key of a result it was shown for that person', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const other = await addPerson('Bea', { birthDate: '1850' });
    // Nothing was searched for yet.
    expect(await attach(ada)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    await search(ada);
    expect(await attach(ada, 'Test-1')).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(await attach(ada, 'Test-90001', 'find-a-grave')).toMatchObject({
      ok: false,
      problem: { kind: 'record' },
    });
    // Shown for Ada, not for Bea.
    expect(await attach(other)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(await attach(MISSING)).toMatchObject({ ok: false, problem: { kind: 'gone' } });
    expect(
      (await call<SourceListPage>('listSources', { query: '', offset: 0, limit: 10 })).total,
    ).toBe(0);
  });

  it('forgets the results when the tree closes', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    await search(ada);
    await call('createTree', { name: 'Second', parentDir: join(root, 'Trees') });
    const again = await addPerson('Ada', { birthDate: '1850' });
    expect(await attach(again)).toMatchObject({ ok: false, problem: { kind: 'record' } });
    expect(await attach(ada)).toMatchObject({ ok: false, problem: { kind: 'gone' } });
  });
});

describe('a search opened in the browser', () => {
  const open = (personId: string, linkId = 'find-a-grave', query: object = QUERY) =>
    call<RecordLinkResult>('openRecordLink', { personId, linkId, query });

  it('names the sites, and hands the browser an address on the site', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const setup = await call<RecordSearchSetup>('getRecordSearch', ada);
    expect(setup.links.map((link) => link.id)).toEqual(['familysearch-records', 'find-a-grave']);

    expect(await open(ada)).toEqual({ ok: true });
    expect(await open(ada, 'familysearch-records')).toEqual({ ok: true });
    expect(openedInBrowser.map((url) => new URL(url).origin)).toEqual([
      'https://www.findagrave.com',
      'https://www.familysearch.org',
    ]);
    expect(new URL(openedInBrowser[0] ?? '').searchParams.get('lastname')).toBe(QUERY.surname);
    // The app itself asked nobody.
    expect(askedOfSources).toEqual([]);
  });

  it('opens nothing before the notice, for a person who may be living, or for nobody', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const rita = await addPerson('Rita', { birthDate: '1990' });
    expect(await open(ada)).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    await call('agreeToRecordSearch');
    expect(await open(rita)).toMatchObject({ ok: false, problem: { kind: 'living' } });
    expect(await open(MISSING)).toMatchObject({ ok: false, problem: { kind: 'gone' } });
    expect(await open(ada, 'wikitree')).toMatchObject({ ok: false, problem: { kind: 'source' } });
    expect(
      await open(ada, 'find-a-grave', {
        given: '',
        surname: ' ',
        birthYear: 1850,
        deathYear: null,
      }),
    ).toMatchObject({ ok: false, problem: { kind: 'empty' } });
    expect(openedInBrowser).toEqual([]);
  });
});

describe('a web page cited by its address', () => {
  it('keeps the address and the day, and one source for each site the app knows', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const target = { type: 'person', id: ada };
    await call(
      'addCitation',
      target,
      { siteId: 'find-a-grave' },
      {
        page: 'Memorial 1',
        url: 'https://www.findagrave.com/memorial/1',
        accessedAt: '2026-11-13',
      },
    );
    const state = await call<TreeState>(
      'addCitation',
      target,
      { siteId: 'find-a-grave' },
      {
        page: 'Memorial 2',
        url: 'http://old.example/page?id=2',
      },
    );
    expect(state.sources).toBe(1);
    const page = await call<PersonPage>('getPersonPage', ada);
    expect(page.citations).toMatchObject([
      {
        sourceTitle: 'Find a Grave',
        url: 'https://www.findagrave.com/memorial/1',
        accessedAt: '2026-11-13',
      },
      { sourceTitle: 'Find a Grave', url: 'http://old.example/page?id=2', accessedAt: '' },
    ]);
    // Nothing was asked of anyone.
    expect(askedOfSources).toEqual([]);
    expect(openedInBrowser).toEqual([]);

    expect(
      (await errorOf('addCitation', target, { siteId: 'no-such-site' }, {})).message,
    ).toContain('not known');
  });

  it('refuses what is no web address, in words', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const target = { type: 'person', id: ada };
    for (const url of [
      'example.org/page',
      'javascript:alert(1)',
      'file:///C:/x.txt',
      'https://user:secret@example.org/',
    ]) {
      const error = await errorOf('addCitation', target, { create: { title: 'A site' } }, { url });
      expect(error.message, url).toMatch(/web address/);
    }
    expect(
      (await call<SourceListPage>('listSources', { query: '', offset: 0, limit: 10 })).total,
    ).toBe(0);

    await call(
      'addCitation',
      target,
      { create: { title: 'A site' } },
      {
        url: 'https://example.org/a',
      },
    );
    const [citation] = (await call<PersonPage>('getPersonPage', ada)).citations;
    const id = citation?.id ?? '';
    expect((await errorOf('updateCitation', id, { url: 'nonsense' })).message).toMatch(
      /web address/,
    );
    // The rest of a citation can be changed while its address stays as it is.
    await call('updateCitation', id, { page: 'p. 2', url: 'https://example.org/a' });
    await call('updateCitation', id, { url: '' });
    expect((await call<PersonPage>('getPersonPage', ada)).citations[0]).toMatchObject({
      page: 'p. 2',
      url: '',
    });
  });
});

describe('the search of newspapers and books', () => {
  const search = (personId: string, sourceId = 'loc', query: object = TEXT, offset = 0) =>
    call<RecordSearchResult>('searchRecordTexts', { personId, sourceId, query, offset });
  const attach = (personId: string, sourceId: string, key: string) =>
    call<AttachRecordResult>('attachRecord', { personId, sourceId, key });

  it('asks the Library of Congress for the words, the years and the state', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const found = await search(ada, 'loc', { ...TEXT, state: 'Vermont' });
    if (!found.ok) throw new Error(found.problem.message);
    // The second result does not lead to the Library, and is left out.
    expect(found.items).toEqual([
      {
        connectorId: 'loc',
        key: 'sn99000001/1903-05-01/ed-1/seq-8',
        kind: 'text',
        title: 'Image 8 of The Ashford gazette (Ashford, Vt.), May 1, 1903',
        url: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
        date: '1 MAY 1903',
        by: '',
        about: '',
      },
    ]);
    expect(found).toMatchObject({ total: 2, hidden: 0, attached: [], cached: false });
    expect(askedOfSources).toHaveLength(1);
    const asked = new URL(askedOfSources[0] ?? '');
    expect(asked.origin + asked.pathname).toBe(
      'https://www.loc.gov/collections/chronicling-america/',
    );
    // The words, the years and the state, and nothing else of the tree.
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      dl: 'page',
      ops: 'PHRASE',
      qs: 'Ada Test',
      searchType: 'advanced',
      start_date: '1850-01-01',
      end_date: '1911-12-31',
      location_state: 'vermont',
      fo: 'json',
      at: 'results,pagination',
      c: '20',
      sp: '1',
    });
  });

  it('asks the Internet Archive for the words alone', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const found = await search(ada, 'internet-archive', { ...TEXT, state: 'Vermont' });
    if (!found.ok) throw new Error(found.problem.message);
    expect(found.items).toEqual([
      {
        connectorId: 'internet-archive',
        key: 'testfamily00exam',
        kind: 'text',
        title: 'Test family.',
        url: 'https://archive.org/details/testfamily00exam',
        date: '1930',
        by: 'Fenwick, H.',
        about: '',
      },
    ]);
    const asked = new URL(askedOfSources[0] ?? '');
    expect(asked.origin + asked.pathname).toBe('https://archive.org/advancedsearch.php');
    expect(asked.searchParams.get('q')).toBe('("ada test") AND mediatype:texts');
    expect(asked.search).not.toContain('1850');
    expect(asked.search.toLowerCase()).not.toContain('vermont');
  });

  it('keeps the rules of every search: the notice, living people, a person of the tree', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const rita = await addPerson('Rita', { birthDate: '1990' });
    expect(await search(ada)).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    await call('agreeToRecordSearch');
    for (const sourceId of ['loc', 'internet-archive']) {
      expect(await search(rita, sourceId)).toMatchObject({
        ok: false,
        problem: { kind: 'living' },
      });
      expect(await search(MISSING, sourceId)).toMatchObject({
        ok: false,
        problem: { kind: 'gone' },
      });
    }
    expect(askedOfSources).toEqual([]);
  });

  it('refuses what cannot be sent, and a source that has no such search', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    for (const query of [
      { ...TEXT, words: '   ' },
      { ...TEXT, fromYear: 1900, toYear: 1850 },
      { ...TEXT, fromYear: 1600, toYear: 1900 },
    ]) {
      expect(await search(ada, 'loc', query)).toMatchObject({
        ok: false,
        problem: { kind: 'empty' },
      });
    }
    // WikiTree is not asked for words, and the newspapers are not asked for a person.
    expect(await search(ada, 'wikitree')).toMatchObject({ ok: false, problem: { kind: 'source' } });
    expect(
      await call<RecordSearchResult>('searchRecords', {
        personId: ada,
        sourceId: 'loc',
        query: QUERY,
        offset: 0,
      }),
    ).toMatchObject({ ok: false, problem: { kind: 'source' } });
    expect(await search(ada, 'find-a-grave')).toMatchObject({
      ok: false,
      problem: { kind: 'source' },
    });
    expect(askedOfSources).toEqual([]);
  });

  it('attaches a page of a newspaper and a book as sources', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await search(ada, 'loc');
    await search(ada, 'internet-archive');
    const asked = askedOfSources.length;

    const page = await attach(ada, 'loc', 'sn99000001/1903-05-01/ed-1/seq-8');
    const book = await attach(ada, 'internet-archive', 'testfamily00exam');
    if (!page.ok || !book.ok) throw new Error('a result was not attached');
    expect([page.added, book.added]).toEqual([true, true]);
    expect(book.tree.sources).toBe(2);
    const cited = (await call<PersonPage>('getPersonPage', ada)).citations;
    expect(cited).toMatchObject([
      {
        sourceTitle: 'Library of Congress (Chronicling America)',
        page: 'Image 8 of The Ashford gazette (Ashford, Vt.), May 1, 1903 (sn99000001/1903-05-01/ed-1/seq-8)',
        text: 'Published 1 May 1903',
        url: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
      },
      {
        sourceTitle: 'Internet Archive',
        page: 'Test family. (testfamily00exam)',
        text: 'By Fenwick, H.\nPublished 1930',
        url: 'https://archive.org/details/testfamily00exam',
      },
    ]);
    // Nothing was sent to attach them, and the next search knows them.
    expect(askedOfSources).toHaveLength(asked);
    expect(await search(ada, 'loc')).toMatchObject({
      ok: true,
      attached: ['sn99000001/1903-05-01/ed-1/seq-8'],
    });
    // A result the search never showed is not attached.
    expect(await attach(ada, 'loc', 'sn99000001/1903-05-01/ed-1/seq-9')).toMatchObject({
      ok: false,
      problem: { kind: 'record' },
    });
  });
});

describe('the notice of the search, when it has more to say', () => {
  it('does not count an agreement to an earlier wording', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    // As an earlier build left it: a day, and no number of the wording.
    setSetting(appDb, RECORD_SEARCH_NOTICE_SETTING, '2026-11-13T12:00:00.000Z');
    expect((await call<RecordSearchSetup>('getRecordSearch', ada)).agreed).toBe(false);
    expect(
      await call<RecordSearchResult>('searchRecords', {
        personId: ada,
        sourceId: 'wikitree',
        query: QUERY,
        offset: 0,
      }),
    ).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    expect(askedOfSources).toEqual([]);

    // A number of the wording that is none is no agreement either.
    for (const damaged of ['Infinity', '1e9', '2.5', ' 2', '-2', 'two', '', '0']) {
      setSetting(appDb, RECORD_SEARCH_NOTICE_VERSION_SETTING, damaged);
      expect((await call<RecordSearchSetup>('getRecordSearch', ada)).agreed, damaged).toBe(false);
    }
    // One from a later build counts: a later wording says no less.
    setSetting(
      appDb,
      RECORD_SEARCH_NOTICE_VERSION_SETTING,
      String(RECORD_SEARCH_NOTICE_VERSION + 1),
    );
    expect((await call<RecordSearchSetup>('getRecordSearch', ada)).agreed).toBe(true);
    setSetting(appDb, RECORD_SEARCH_NOTICE_VERSION_SETTING, '1');

    await call('agreeToRecordSearch');
    expect(getSetting(appDb, RECORD_SEARCH_NOTICE_VERSION_SETTING)).toBe(
      String(RECORD_SEARCH_NOTICE_VERSION),
    );
    expect((await call<RecordSearchSetup>('getRecordSearch', ada)).agreed).toBe(true);
  });
});

describe('a source that asks to be left alone', () => {
  const search = (personId: string) =>
    call<RecordSearchResult>('searchRecordTexts', {
      personId,
      sourceId: 'loc',
      query: TEXT,
      offset: 0,
    });

  it('is still left alone after the app was closed and started again', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    // The Library sends a page that asks whether one is a robot.
    answerOf = () => new Response('<!DOCTYPE html><html><body>Are you a robot?</body></html>');
    const paused = await search(ada);
    expect(paused).toMatchObject({ ok: false, problem: { kind: 'paused' } });
    if (paused.ok || paused.problem.retryAt === null) throw new Error('no time was given');
    const until = paused.problem.retryAt;
    // An hour, as the manifest of the Library says.
    expect(until - Date.now()).toBeGreaterThan(3_500_000);
    expect(
      JSON.parse(getSetting(appDb, recordSearchHostSetting('www.loc.gov')) ?? '{}'),
    ).toMatchObject({ pausedUntil: until });

    // The app starts again: a new service, the same settings.
    answerOf = usualAnswer;
    const again = new RecordSearchService({
      appDb,
      appVersion: '0.0.0',
      fetch: (url) => {
        askedOfSources.push(url);
        return Promise.resolve(answerOf(url));
      },
    });
    const sources = again.sources();
    expect(sources.find((source) => source.id === 'loc')?.pausedUntil).toBe(until);
    expect(sources.find((source) => source.id === 'wikitree')?.pausedUntil).toBeNull();
    const asked = askedOfSources.length;
    expect(
      await again.searchTexts(session.tree, {
        personId: ada,
        sourceId: 'loc',
        query: TEXT,
        offset: 0,
      }),
    ).toMatchObject({
      ok: false,
      problem: { kind: 'paused', retryAt: until },
    });
    expect(askedOfSources).toHaveLength(asked);
  });

  it('goes on when what was kept about a source cannot be read', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850' });
    setSetting(appDb, recordSearchHostSetting('www.loc.gov'), 'not JSON');
    const service = new RecordSearchService({
      appDb,
      appVersion: '0.0.0',
      fetch: (url) => Promise.resolve(answerOf(url)),
    });
    expect(
      await service.searchTexts(session.tree, {
        personId: ada,
        sourceId: 'loc',
        query: TEXT,
        offset: 0,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('the search of archive records and of Wikidata', () => {
  const search = (personId: string, sourceId: string, query: object = QUERY) =>
    call<RecordSearchResult>('searchRecords', { personId, sourceId, query, offset: 0 });
  const attach = (personId: string, sourceId: string, key: string) =>
    call<AttachRecordResult>('attachRecord', { personId, sourceId, key });

  it('asks Open Archives for the name and a span of years, and shows nobody who may be living', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const found = await search(ada, 'open-archives', { ...QUERY, deathYear: 1910 });
    if (!found.ok) throw new Error(found.problem.message);
    expect(found.items).toEqual([
      {
        connectorId: 'open-archives',
        key: 'exa:REC-1/Person1',
        kind: 'event',
        title: 'Ada Test',
        // Made by the app, not taken from the answer.
        url: 'https://www.openarchieven.nl/exa:REC-1/en',
        role: 'Bride',
        event: 'Marriage',
        date: '21 MAY 1872',
        place: 'Voorbeeldstad',
        held: 'Civil registration marriages, Example Municipal Archive',
      },
    ]);
    // The witness of 1990 may be living, and is counted, not shown.
    expect(found).toMatchObject({ total: 2, hidden: 1 });
    const asked = new URL(askedOfSources[0] ?? '');
    expect(asked.origin + asked.pathname).toBe(
      'https://api.openarchieven.nl/1.1/records/search.json',
    );
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      name: 'Ada Test 1848-1912',
      lang: 'en',
      number_show: '20',
      start: '0',
    });
  });

  it('asks Wikidata for the name alone, and shows nobody who may be living', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const found = await search(ada, 'wikidata', { ...QUERY, deathYear: 1910 });
    if (!found.ok) throw new Error(found.problem.message);
    expect(found.items).toEqual([
      {
        connectorId: 'wikidata',
        key: 'Q90001',
        kind: 'person',
        title: 'Ada Test',
        url: 'https://www.wikidata.org/wiki/Q90001',
        sex: 'F',
        facts: [
          { type: 'birth', date: '12 MAR 1850', place: '' },
          { type: 'death', date: '1910', place: '' },
        ],
        about: 'surveyor (1850–1910)',
      },
    ]);
    expect(found).toMatchObject({ total: null, hidden: 1 });
    const asked = new URL(askedOfSources[0] ?? '');
    expect(asked.origin + asked.pathname).toBe('https://query.wikidata.org/sparql');
    const question = asked.searchParams.get('query') ?? '';
    expect(question).toContain('"haswbstatement:P31=Q5 ada test"');
    expect(question).not.toContain('1850');
    expect(question).not.toContain('1910');
  });

  it('attaches a record of an archive and an entry of Wikidata as sources', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await search(ada, 'open-archives');
    await search(ada, 'wikidata');
    const asked = askedOfSources.length;
    const record = await attach(ada, 'open-archives', 'exa:REC-1/Person1');
    const entry = await attach(ada, 'wikidata', 'Q90001');
    if (!record.ok || !entry.ok) throw new Error('a result was not attached');
    const cited = (await call<PersonPage>('getPersonPage', ada)).citations;
    expect(cited).toMatchObject([
      {
        sourceTitle: 'Open Archives (Open Archieven)',
        page: 'Ada Test (exa:REC-1/Person1)',
        text: 'Role: Bride\nMarriage, 21 May 1872, Voorbeeldstad\nCivil registration marriages, Example Municipal Archive',
        url: 'https://www.openarchieven.nl/exa:REC-1/en',
      },
      {
        sourceTitle: 'Wikidata',
        page: 'Ada Test (Q90001)',
        text: 'Born 12 March 1850\nDied 1910\nsurveyor (1850–1910)',
        url: 'https://www.wikidata.org/wiki/Q90001',
      },
    ]);
    expect(askedOfSources).toHaveLength(asked);
    // What was counted and not shown cannot be attached.
    expect(await attach(ada, 'open-archives', 'exa:REC-2/Person2')).toMatchObject({
      ok: false,
      problem: { kind: 'record' },
    });
    expect(await attach(ada, 'wikidata', 'Q90002')).toMatchObject({
      ok: false,
      problem: { kind: 'record' },
    });
  });

  it('keeps the rules of every search for both', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const rita = await addPerson('Rita', { birthDate: '1990' });
    for (const sourceId of ['open-archives', 'wikidata']) {
      expect(await search(ada, sourceId)).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    }
    await call('agreeToRecordSearch');
    for (const sourceId of ['open-archives', 'wikidata']) {
      expect(await search(rita, sourceId)).toMatchObject({
        ok: false,
        problem: { kind: 'living' },
      });
      // Neither is asked for words.
      expect(
        await call<RecordSearchResult>('searchRecordTexts', {
          personId: ada,
          sourceId,
          query: TEXT,
          offset: 0,
        }),
      ).toMatchObject({ ok: false, problem: { kind: 'source' } });
    }
    expect(askedOfSources).toEqual([]);
  });
});

describe('the National Archives, and the key of the user', () => {
  const search = (personId: string, offset = 0) =>
    call<RecordSearchResult>('searchRecordTexts', {
      personId,
      sourceId: 'nara-catalog',
      query: TEXT,
      offset,
    });
  const setKey = (key: string, sourceId = 'nara-catalog') =>
    call<RecordSourceKeyResult>('setRecordSourceKey', { sourceId, key });
  const stateOf = async (personId: string) =>
    (await call<RecordSearchSetup>('getRecordSearch', personId)).sources.find(
      (source) => source.id === 'nara-catalog',
    );
  /** Every setting of the app, as text. */
  const settings = () =>
    JSON.stringify(appDb.prepare('SELECT key, value FROM setting ORDER BY key').all());

  it('asks nothing without a key', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    expect(await search(ada)).toMatchObject({
      ok: false,
      problem: { kind: 'key', message: 'US National Archives Catalog needs your own key.' },
    });
    expect(askedOfSources).toEqual([]);
  });

  it('keeps the key encrypted, sends it in its header, and never hands it back', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    const saved = await setKey(CANARY);
    // The answer says that a key is saved, and nothing of the key.
    expect(saved).toMatchObject({ ok: true });
    expect(JSON.stringify(saved)).not.toContain(CANARY);
    expect((await stateOf(ada))?.key).toBe('saved');
    // Saving sent nothing.
    expect(askedOfSources).toEqual([]);
    // The settings hold what Windows made of it, not the key.
    expect(getSetting(appDb, recordSearchKeySetting('nara-catalog'))).toMatch(/^kept:[0-9a-f]+$/);
    expect(settings()).not.toContain(CANARY);

    const found = await search(ada);
    if (!found.ok) throw new Error(found.problem.message);
    expect(found.items).toEqual([
      {
        connectorId: 'nara-catalog',
        key: '90000001',
        kind: 'text',
        title: 'Pension file of Ada Test',
        url: 'https://catalog.archives.gov/id/90000001',
        date: '',
        by: '',
        about: 'File unit, 1862–1910',
      },
    ]);
    expect(JSON.stringify(found)).not.toContain(CANARY);
    // One request, to the Archives, with the words in its address and the key in its header.
    expect(askedOfSources).toHaveLength(1);
    const asked = new URL(askedOfSources[0] ?? '');
    expect(asked.origin + asked.pathname).toBe(
      'https://catalog.archives.gov/api/v2/records/search',
    );
    expect(asked.searchParams.get('q')).toBe('"ada test"');
    expect(askedOfSources[0]).not.toContain(CANARY);
    expect(headersOfSources[0]?.['x-api-key']).toBe(CANARY);
    // No page of the app, and no setting, holds the key afterwards.
    expect(JSON.stringify(await call('getRecordSearch', ada))).not.toContain(CANARY);
    expect(settings()).not.toContain(CANARY);
    // No other source is sent it.
    await call<RecordSearchResult>('searchRecordTexts', {
      personId: ada,
      sourceId: 'loc',
      query: TEXT,
      offset: 0,
    });
    expect(Object.values(headersOfSources[1] ?? {})).not.toContain(CANARY);
  });

  it('counts what it asks the Archives, and keeps no answer', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await setKey(CANARY);
    expect((await stateOf(ada))?.quota).toMatchObject({ used: 0, ceiling: 9000, period: 'month' });
    await search(ada);
    // The same search again is asked again: the terms of the Archives bar keeping an answer.
    expect(await search(ada)).toMatchObject({ ok: true, cached: false });
    expect(askedOfSources).toHaveLength(2);
    expect((await stateOf(ada))?.quota?.used).toBe(2);

    // When the app's share of the month is used up, nothing more is sent.
    const period = (await stateOf(ada))?.quota;
    const kept = JSON.parse(
      getSetting(appDb, recordSearchHostSetting('quota:nara-catalog')) ?? '{}',
    ) as { period: string };
    setSetting(
      appDb,
      recordSearchHostSetting('quota:nara-catalog'),
      JSON.stringify({ period: kept.period, used: 9000 }),
    );
    const again = new RecordSearchService({
      appDb,
      appVersion: '0.0.0',
      fetch: (url) => {
        askedOfSources.push(url);
        return Promise.resolve(answerOf(url));
      },
      secrets,
    });
    expect(
      await again.searchTexts(session.tree, {
        personId: ada,
        sourceId: 'nara-catalog',
        query: TEXT,
        offset: 0,
      }),
    ).toMatchObject({ ok: false, problem: { kind: 'paused', retryAt: period?.resetsAt } });
    expect(askedOfSources).toHaveLength(2);
  });

  it('cites a description by its identifier and address, and keeps nothing the Archives sent', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await setKey(CANARY);
    await search(ada);
    const attached = await call<AttachRecordResult>('attachRecord', {
      personId: ada,
      sourceId: 'nara-catalog',
      key: '90000001',
    });
    if (!attached.ok) throw new Error(attached.problem.message);
    const [cited] = (await call<PersonPage>('getPersonPage', ada)).citations;
    expect(cited).toMatchObject({
      sourceTitle: 'US National Archives Catalog',
      page: 'Identifier 90000001',
      text: '',
      url: 'https://catalog.archives.gov/id/90000001',
    });
    // Not the title, nor what kind of record it is.
    expect(JSON.stringify(cited)).not.toContain('Pension');
    expect(JSON.stringify(cited)).not.toContain('File unit');
  });

  it('says when the Archives do not accept the key', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await setKey(CANARY);
    for (const answer of [
      () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
      () => new Response('<!doctype html><html><body>Catalog</body></html>'),
    ]) {
      answerOf = answer;
      const refused = await search(ada);
      expect(refused).toMatchObject({ ok: false, problem: { kind: 'key' } });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
    }
    // An error that the Archives put inside an answer.
    answerOf = () => new Response(JSON.stringify({ statusCode: 403, body: {} }));
    const inside = await search(ada);
    expect(inside).toMatchObject({ ok: false, problem: { kind: 'key' } });
    if (inside.ok) throw new Error('it did not fail');
    expect(inside.problem.message).toContain('did not accept the key');
  });

  it('replaces and removes the key, and takes none for a source that needs none', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    await setKey(CANARY);
    await setKey('another-key-9876543210');
    await search(ada);
    expect(headersOfSources[0]?.['x-api-key']).toBe('another-key-9876543210');

    expect(
      await call<RecordSourceKeyResult>('removeRecordSourceKey', 'nara-catalog'),
    ).toMatchObject({
      ok: true,
    });
    expect(getSetting(appDb, recordSearchKeySetting('nara-catalog'))).toBeNull();
    expect((await stateOf(ada))?.key).toBe('missing');
    expect(await search(ada)).toMatchObject({ ok: false, problem: { kind: 'key' } });
    // The count of the month stays, whoever's key it was.
    expect((await stateOf(ada))?.quota?.used).toBe(1);

    for (const sourceId of ['wikitree', 'loc', 'find-a-grave', 'no-such-source']) {
      expect(await setKey(CANARY, sourceId)).toEqual({
        ok: false,
        message: 'This source takes no key.',
      });
      expect(getSetting(appDb, recordSearchKeySetting(sourceId))).toBeNull();
    }
  });

  it('saves no key when the PC cannot encrypt, and says when a saved one cannot be read', async () => {
    await openNewTree();
    await call('agreeToRecordSearch');
    const ada = await addPerson('Ada', { birthDate: '1850', deathDate: '1910' });
    secretsWork.available = false;
    expect((await stateOf(ada))?.key).toBe('unavailable');
    expect(await setKey(CANARY)).toMatchObject({ ok: false });
    expect(getSetting(appDb, recordSearchKeySetting('nara-catalog'))).toBeNull();
    expect(settings()).not.toContain(CANARY);

    secretsWork.available = true;
    await setKey(CANARY);
    // As on another Windows account, or with a profile copied from another PC.
    secretsWork.readable = false;
    expect((await stateOf(ada))?.key).toBe('unreadable');
    const refused = await search(ada);
    expect(refused).toMatchObject({ ok: false, problem: { kind: 'key' } });
    if (refused.ok) throw new Error('it did not fail');
    expect(refused.problem.message).toContain('cannot be read on this Windows account');
    expect(askedOfSources).toEqual([]);
    // Entering it again puts it right.
    secretsWork.readable = true;
    await setKey(CANARY);
    expect(await search(ada)).toMatchObject({ ok: true });
  });

  it('keeps the rules of every search', async () => {
    await openNewTree();
    const ada = await addPerson('Ada', { birthDate: '1850' });
    const rita = await addPerson('Rita', { birthDate: '1990' });
    await setKey(CANARY);
    expect(await search(ada)).toMatchObject({ ok: false, problem: { kind: 'notice' } });
    await call('agreeToRecordSearch');
    expect(await search(rita)).toMatchObject({ ok: false, problem: { kind: 'living' } });
    expect(askedOfSources).toEqual([]);
  });
});
