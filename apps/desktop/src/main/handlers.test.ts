import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_DIR_NAME, openAppDatabase, type Db } from '@rulz/db';
import {
  API_METHODS,
  type AppInfo,
  type ChartInfo,
  type DuplicateList,
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
  type PersonPage,
  type RelationshipInfo,
  type SourceChange,
  type SourceDetails,
  type SourceListPage,
  type TreeState,
} from '../shared/ipc';
import { createHandlers, toIpcError, type ApiHandlers, type Platform } from './handlers';
import { TreeSession } from './session';

const MISSING = '00000000-0000-7000-8000-000000000000';

let root: string;
let appDb: Db;
let session: TreeSession;
let handlers: ApiHandlers;
/** What the fake folder picker answers next; null is a cancelled dialog. */
let pickedFolder: string | null;
/** What the fake dialogs for opening and saving a file answer next. */
let pickedFile: string | null;
let savePath: string | null;
/** Where each fake file dialog was told to start. */
let dialogDefaults: string[];
let openedFolders: string[];
/** What the fake dialog for adding pictures and documents answers next; none is a cancelled dialog. */
let pickedFiles: string[];
/** How often that dialog was shown. */
let filesDialogs: number;
/** The files handed to another program, and those shown in File Explorer. */
let openedFiles: string[];
let shownFiles: string[];

const platform: Platform = {
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
  handlers = createHandlers(session, platform);
  pickedFolder = null;
  pickedFile = null;
  savePath = null;
  dialogDefaults = [];
  openedFolders = [];
  pickedFiles = [];
  filesDialogs = 0;
  openedFiles = [];
  shownFiles = [];
});

afterEach(() => {
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
