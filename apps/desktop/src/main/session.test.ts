import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_DIR_NAME,
  TREE_FILE_NAME,
  countPersons,
  createPerson,
  openAppDatabase,
  type Db,
} from '@rulz/db';
import { NoOpenTreeError, SessionError, TreeSession } from './session';

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const MINUTE = 60_000;

let root: string;
let appDb: Db;
let clock: number;
const sessions: TreeSession[] = [];

/** A session on the shared app database, as a fresh start of the app would make. */
function startSession(): TreeSession {
  const session = new TreeSession({
    appDb,
    defaultParentDir: join(root, 'Trees'),
    now: () => clock,
  });
  sessions.push(session);
  session.start();
  return session;
}

function addPerson(session: TreeSession, given: string): string {
  return session.change((tree) => createPerson(tree, { name: { given, surname: 'Test' } }).id);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rulz-session-'));
  appDb = openAppDatabase(join(root, 'app.db'));
  clock = T0;
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.shutdown();
  appDb.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('creating a tree', () => {
  it('starts with no tree open', () => {
    const session = startSession();
    expect(session.isOpen).toBe(false);
    expect(session.startInfo()).toEqual({
      tree: null,
      reopenError: null,
      recent: [],
      defaultParentDir: join(root, 'Trees'),
    });
    expect(() => session.tree).toThrow(NoOpenTreeError);
    expect(() => session.state()).toThrow(NoOpenTreeError);
  });

  it('makes a folder named after the tree in the default place and opens it', () => {
    const session = startSession();
    const state = session.create('Smith: the family?', join(root, 'Trees'));

    const dir = join(root, 'Trees', 'Smith the family');
    expect(existsSync(join(dir, TREE_FILE_NAME))).toBe(true);
    expect(state).toMatchObject({
      dir,
      name: 'Smith: the family?',
      persons: 0,
      undo: null,
      redo: null,
      lastBackupAt: null,
    });
    expect(session.startInfo().recent).toEqual([
      { dir, name: 'Smith: the family?', lastOpenedAt: T0, available: true },
    ]);
  });

  it('accepts another folder only after the user picked it', () => {
    const session = startSession();
    const elsewhere = join(root, 'Elsewhere');
    expect(() => session.create('Tree', elsewhere)).toThrow(SessionError);
    expect(existsSync(elsewhere)).toBe(false);

    expect(session.allowParentDir(elsewhere)).toBe(elsewhere);
    expect(session.create('Tree', elsewhere).dir).toBe(join(elsewhere, 'Tree'));
  });

  it('refuses a name whose folder already has something in it, and keeps the open tree', () => {
    const session = startSession();
    const first = session.create('First', join(root, 'Trees'));
    addPerson(session, 'Kept');

    expect(() => session.create('First', join(root, 'Trees'))).toThrow(/already a tree/);
    expect(() => session.create('  ', join(root, 'Trees'))).toThrow(/needs a name/);
    expect(session.state()).toMatchObject({ dir: first.dir, persons: 1 });
  });
});

describe('opening and closing', () => {
  it('reopens at the next start the tree that was open when the app quit', () => {
    const first = startSession();
    const created = first.create('Family', join(root, 'Trees'));
    addPerson(first, 'Ada');
    first.shutdown();

    const second = startSession();
    expect(second.startInfo().tree).toMatchObject({ dir: created.dir, name: 'Family', persons: 1 });
    expect(second.startInfo().reopenError).toBeNull();
  });

  it('shows the start screen at the next start after the user closed the tree', () => {
    const first = startSession();
    first.create('Family', join(root, 'Trees'));
    expect(first.close()).toEqual({ backupError: null });
    expect(first.isOpen).toBe(false);

    const second = startSession();
    expect(second.startInfo().tree).toBeNull();
    expect(second.startInfo().recent).toHaveLength(1);
  });

  it('says once why the last tree could not be reopened', () => {
    const first = startSession();
    const created = first.create('Family', join(root, 'Trees'));
    first.shutdown();
    rmSync(created.dir, { recursive: true, force: true });

    const second = startSession();
    expect(second.startInfo()).toMatchObject({
      tree: null,
      reopenError: expect.stringContaining('no family tree in this folder') as string,
      recent: [{ dir: created.dir, available: false }],
    });

    expect(startSession().startInfo().reopenError).toBeNull();
  });

  it('keeps the open tree when another one cannot be opened', () => {
    const session = startSession();
    const open = session.create('Open', join(root, 'Trees'));
    const empty = join(root, 'Empty');
    mkdirSync(empty);

    expect(() => session.open(join(root, 'Nowhere'))).toThrow(/no family tree/);
    expect(existsSync(join(root, 'Nowhere'))).toBe(false);
    // An existing folder with no tree in it is refused too, and no tree is made there.
    expect(() => session.open(empty)).toThrow(/no family tree/);
    expect(readdirSync(empty)).toEqual([]);
    expect(session.state().dir).toBe(open.dir);
  });

  it('switches trees, backing up the one it leaves, and lists the latest first', () => {
    const session = startSession();
    const one = session.create('One', join(root, 'Trees'));
    addPerson(session, 'In one');
    clock = T0 + MINUTE;
    const two = session.create('Two', join(root, 'Trees'));
    expect(readdirSync(join(one.dir, BACKUP_DIR_NAME))).toHaveLength(1);

    clock = T0 + 2 * MINUTE;
    expect(session.openRecent(one.dir.toUpperCase())).toMatchObject({ name: 'One', persons: 1 });
    expect(session.startInfo().recent.map((recent) => recent.name)).toEqual(['One', 'Two']);
    // Opening the tree that is already open changes nothing.
    const revision = session.state().revision;
    expect(session.open(one.dir).revision).toBe(revision);

    expect(session.forgetRecent(two.dir).map((recent) => recent.name)).toEqual(['One']);
    expect(existsSync(join(two.dir, TREE_FILE_NAME))).toBe(true);
  });

  it('opens from the recent list only what is in it', () => {
    const session = startSession();
    const outside = join(root, 'Outside');
    // A real tree, but one this app database has never opened.
    const other = new TreeSession({ appDb: openAppDatabase(':memory:'), defaultParentDir: root });
    other.create('Outside', root);
    other.shutdown();

    expect(() => session.openRecent(outside)).toThrow(SessionError);
    expect(session.isOpen).toBe(false);
    expect(session.open(outside).name).toBe('Outside');
  });
});

describe('changes', () => {
  it('raises the revision with every change, undo and redo, and not otherwise', () => {
    const session = startSession();
    const start = session.create('Family', join(root, 'Trees')).revision;

    addPerson(session, 'Ada');
    expect(session.state()).toMatchObject({ revision: start + 1, undo: 'Add person', persons: 1 });

    expect(() =>
      session.change(() => {
        throw new Error('nothing changed');
      }),
    ).toThrow('nothing changed');
    expect(session.state().revision).toBe(start + 1);

    expect(session.undo()).toMatchObject({
      revision: start + 2,
      undo: null,
      redo: 'Add person',
      persons: 0,
    });
    expect(session.undo().revision).toBe(start + 2);
    expect(session.redo()).toMatchObject({ revision: start + 3, persons: 1 });
    expect(session.redo().revision).toBe(start + 3);
  });
});

describe('backups', () => {
  it('backs up on closing only when the tree has changed since the newest backup', () => {
    const session = startSession();
    const { dir } = session.create('Family', join(root, 'Trees'));
    session.close();
    expect(existsSync(join(dir, BACKUP_DIR_NAME))).toBe(false);

    session.open(dir);
    addPerson(session, 'Ada');
    clock = T0 + MINUTE;
    session.close();
    expect(readdirSync(join(dir, BACKUP_DIR_NAME))).toEqual(['tree-20261111T120100Z.db']);

    clock = T0 + 2 * MINUTE;
    expect(session.open(dir).lastBackupAt).toBe(T0 + MINUTE);
    session.close();
    expect(readdirSync(join(dir, BACKUP_DIR_NAME))).toHaveLength(1);
  });

  it('backs up on request and reports when the newest backup was made', () => {
    const session = startSession();
    session.create('Family', join(root, 'Trees'));
    expect(session.backupNow()).toBeNull();

    addPerson(session, 'Ada');
    clock = T0 + MINUTE;
    expect(session.backupNow()).toMatchObject({ name: 'tree-20261111T120100Z.db' });
    expect(session.state().lastBackupAt).toBe(T0 + MINUTE);
    expect(session.backupNow()).toBeNull();
    expect(session.listBackups()).toHaveLength(1);
    expect(existsSync(session.backupsDir())).toBe(true);
  });

  it('still closes the tree when the backup cannot be written', () => {
    const session = startSession();
    const { dir } = session.create('Family', join(root, 'Trees'));
    addPerson(session, 'Ada');
    // A file where the backups folder should be.
    writeFileSync(join(dir, BACKUP_DIR_NAME), 'in the way');

    const closed = session.close();
    expect(closed.backupError).toEqual(expect.any(String));
    expect(session.isOpen).toBe(false);
    // The tree itself is intact.
    rmSync(join(dir, BACKUP_DIR_NAME));
    expect(session.open(dir).persons).toBe(1);
  });

  it('restores a backup after saving the present state, so the restore can be reversed', () => {
    const session = startSession();
    session.create('Family', join(root, 'Trees'));
    addPerson(session, 'Kept');
    clock = T0 + MINUTE;
    const good = session.backupNow();
    addPerson(session, 'Mistake');
    const before = session.state().revision;

    clock = T0 + 2 * MINUTE;
    const restored = session.restore(good?.name ?? '');
    expect(restored.persons).toBe(1);
    expect(restored.revision).toBeGreaterThan(before);
    expect(restored.lastBackupAt).toBe(T0 + 2 * MINUTE);
    expect(session.listBackups().map((backup) => backup.name)).toEqual([
      'tree-20261111T120200Z.db',
      'tree-20261111T120100Z.db',
    ]);

    // The state from before the restore is the newest backup; restoring it reverses the restore.
    clock = T0 + 3 * MINUTE;
    expect(session.restore('tree-20261111T120200Z.db').persons).toBe(2);
    addPerson(session, 'Later');
    expect(countPersons(session.tree)).toBe(3);
  });

  it('keeps the tree open and unchanged when the backup named cannot be restored', () => {
    const session = startSession();
    const { dir } = session.create('Family', join(root, 'Trees'));
    addPerson(session, 'Kept');

    expect(() => session.restore('..\\' + TREE_FILE_NAME)).toThrow(/not a backup file name/);
    expect(() => session.restore('tree-20200101T000000Z.db')).toThrow(/no longer exists/);
    expect(session.state()).toMatchObject({ dir, persons: 1 });
    addPerson(session, 'Still editable');
    expect(session.state().persons).toBe(2);
  });
});
