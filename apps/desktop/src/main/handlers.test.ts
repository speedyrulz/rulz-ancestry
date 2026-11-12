import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_DIR_NAME, openAppDatabase, type Db } from '@rulz/db';
import {
  API_METHODS,
  type AppInfo,
  type GedcomExportInfo,
  type GedcomImportResult,
  type IpcError,
  type PersonChange,
  type PersonListPage,
  type PersonPage,
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
  openFolder: (dir) => {
    openedFolders.push(dir);
    return Promise.resolve();
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
    '1 NOTE Kept as written.',
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
      keptRecords: 1,
      // The two lines of the first person, and the link to a family that is not in the file.
      keptLines: 3,
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
    expect(page.keptLines).toEqual(['1 _UID ABC123', '1 NOTE Kept as written.']);

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
    expect(await call('exportGedcom', { version: '5.5.1', includeLiving: true })).toBeNull();
    expect(dialogDefaults[1]).toBe(join(root, 'Trees', 'Mine.ged'));

    // A name typed without an extension gets .ged.
    savePath = join(root, 'out');
    const everyone = await call<GedcomExportInfo>('exportGedcom', {
      version: '5.5.1',
      includeLiving: true,
    });
    expect(everyone).toEqual({
      file: join(root, 'out.ged'),
      version: '5.5.1',
      persons: 2,
      families: 1,
      livingOmitted: 0,
      unconverted: [],
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
    });
    expect(shared).toMatchObject({ version: '7.0', persons: 1, families: 1, livingOmitted: 1 });
    expect(readFileSync(shared.file, 'utf8')).not.toContain('Young');

    // The export changes nothing in the tree.
    expect((await call<{ tree: TreeState }>('getStartInfo')).tree?.revision).toBe(
      imported.tree.revision,
    );
  });

  it('checks what the page sends for an export, and needs an open tree', async () => {
    expect((await errorOf('exportGedcom', { version: '5.5.1', includeLiving: true })).code).toBe(
      'no-tree',
    );
    expect((await errorOf('countPresumedLiving')).code).toBe('no-tree');
    await openNewTree();
    savePath = join(root, 'out.ged');
    for (const bad of [
      { version: '5.5', includeLiving: true },
      { version: '7.0' },
      { version: '7.0', includeLiving: 'yes' },
      { version: '7.0', includeLiving: true, file: 'C:\\somewhere\\else.ged' },
    ]) {
      expect((await errorOf('exportGedcom', bad)).code, JSON.stringify(bad)).toBe('invalid');
    }
    expect(existsSync(savePath)).toBe(false);
  });
});
