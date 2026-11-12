import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DIR_NAME,
  BackupError,
  backupName,
  backupTree,
  backupsToPrune,
  listBackups,
  parseBackupName,
  restoreBackup,
  treeStateToken,
  verifyBackup,
  type BackupInfo,
} from './backup';
import { openDatabase } from './connection';
import { countPersons, createPerson } from './persons';
import { searchPersons } from './search';
import { cleanUpAfterEach, memoryTree, snapshot, tempDir, track } from './testing';
import { TREE_FILE_NAME, openExistingTree, openTree, type Tree } from './tree';

cleanUpAfterEach();
afterEach(() => {
  vi.useRealTimers();
});

const T0 = Date.UTC(2026, 10, 11, 15, 30, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function treeOnDisk(): Tree {
  return track(openTree(tempDir(), { name: 'Backup test' }));
}

function add(tree: Tree, given: string) {
  return createPerson(tree, { name: { given, surname: 'Müller' } });
}

function backupFiles(tree: Tree): string[] {
  const folder = join(tree.dir ?? '', BACKUP_DIR_NAME);
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

describe('backup file names', () => {
  it('stamps the time in UTC and reads it back', () => {
    expect(backupName(T0)).toBe('tree-20261111T153012Z.db');
    expect(backupName(T0, 3)).toBe('tree-20261111T153012Z-3.db');
    expect(parseBackupName('tree-20261111T153012Z.db')).toBe(T0);
    expect(parseBackupName('tree-20261111T153012Z-3.db')).toBe(T0);
  });

  it('rejects anything that is not a backup name', () => {
    for (const name of [
      'tree.db',
      'tree-20261111T153012Z.db.tmp',
      'tree-20261341T153012Z.db',
      'tree-20261111T253012Z.db',
      '..\\tree-20261111T153012Z.db',
      '../tree-20261111T153012Z.db',
      'tree-20261111T153012Z.db/..',
      '',
    ]) {
      expect(parseBackupName(name), name).toBeNull();
    }
  });
});

describe('backupTree', () => {
  it('writes nothing for a tree that has never been changed', () => {
    const tree = treeOnDisk();
    expect(treeStateToken(tree.db)).toBeNull();
    expect(backupTree(tree, { now: T0 })).toEqual({ created: null, pruned: [] });
    expect(backupFiles(tree)).toEqual([]);
  });

  it('writes a complete copy that opens as a tree, search index included', () => {
    const tree = treeOnDisk();
    add(tree, 'Johann');
    add(tree, 'Anna');

    const result = backupTree(tree, { now: T0 });
    expect(result.created).toMatchObject({ name: 'tree-20261111T153012Z.db', at: T0 });
    expect(result.created?.size).toBeGreaterThan(0);
    expect(backupFiles(tree)).toEqual(['tree-20261111T153012Z.db']);

    // Open the copy as a tree of its own.
    const copyDir = tempDir();
    writeFileSync(
      join(copyDir, TREE_FILE_NAME),
      readFileSync(join(tree.dir ?? '', BACKUP_DIR_NAME, 'tree-20261111T153012Z.db')),
    );
    const copy = track(openExistingTree(copyDir));
    expect(snapshot(copy)).toBe(snapshot(tree));
    expect(copy.info()).toMatchObject({ id: tree.info().id, name: 'Backup test', persons: 2 });
    expect(searchPersons(copy, 'muller')).toHaveLength(2);
    expect(copy.undoStatus().undo?.label).toBe('Add person');
  });

  it('leaves the open tree usable', () => {
    const tree = treeOnDisk();
    add(tree, 'Before');
    backupTree(tree, { now: T0 });
    add(tree, 'After');
    tree.undo();
    tree.redo();
    expect(countPersons(tree)).toBe(2);
  });

  it('skips a backup when the newest one already holds the same data', () => {
    const tree = treeOnDisk();
    add(tree, 'One');
    expect(backupTree(tree, { now: T0 }).created).not.toBeNull();
    expect(backupTree(tree, { now: T0 + MINUTE }).created).toBeNull();

    // Undo then redo ends where it started.
    tree.undo();
    tree.redo();
    expect(backupTree(tree, { now: T0 + 2 * MINUTE }).created).toBeNull();

    // An undo alone is a different state.
    tree.undo();
    expect(backupTree(tree, { now: T0 + 3 * MINUTE }).created).not.toBeNull();
    expect(backupFiles(tree)).toHaveLength(2);
  });

  it('makes a copy anyway when asked to', () => {
    const tree = treeOnDisk();
    add(tree, 'One');
    backupTree(tree, { now: T0 });
    expect(backupTree(tree, { now: T0 + MINUTE, force: true }).created?.name).toBe(
      'tree-20261111T153112Z.db',
    );
  });

  it('gives two backups made in the same second different names', () => {
    const tree = treeOnDisk();
    add(tree, 'One');
    backupTree(tree, { now: T0 });
    add(tree, 'Two');
    const second = backupTree(tree, { now: T0 + 500 });
    expect(second.created?.name).toBe('tree-20261111T153012Z-2.db');
    expect(listBackups(tree.dir ?? '').map((backup) => backup.name)).toEqual([
      'tree-20261111T153012Z-2.db',
      'tree-20261111T153012Z.db',
    ]);
  });

  it('replaces an unreadable newest backup instead of trusting it', () => {
    const tree = treeOnDisk();
    add(tree, 'One');
    const first = backupTree(tree, { now: T0 });
    const file = join(tree.dir ?? '', BACKUP_DIR_NAME, first.created?.name ?? '');
    truncateSync(file, 100);
    expect(() => verifyBackup(file)).toThrow(BackupError);

    expect(backupTree(tree, { now: T0 + MINUTE }).created).not.toBeNull();
  });

  it('ignores files in the backups folder that it did not make', () => {
    const tree = treeOnDisk();
    add(tree, 'One');
    const folder = join(tree.dir ?? '', BACKUP_DIR_NAME);
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), 'mine');
    // Left behind by a backup that was interrupted.
    writeFileSync(join(folder, 'tree-20261111T153012Z.db.tmp'), 'partial');

    backupTree(tree, { now: T0 });
    expect(listBackups(tree.dir ?? '').map((backup) => backup.name)).toEqual([
      'tree-20261111T153012Z.db',
    ]);
    expect(backupFiles(tree)).toEqual(['notes.txt', 'tree-20261111T153012Z.db']);
  });

  it('deletes old backups according to the retention policy', () => {
    const tree = treeOnDisk();
    const retention = { newest: 2, months: 0 };
    for (let i = 0; i < 4; i += 1) {
      add(tree, 'Person ' + String(i));
      backupTree(tree, { now: T0 + i * MINUTE, retention });
    }
    expect(backupFiles(tree)).toEqual(['tree-20261111T153212Z.db', 'tree-20261111T153312Z.db']);
  });

  it('refuses a tree that only exists in memory', () => {
    const tree = memoryTree();
    add(tree, 'One');
    expect(() => backupTree(tree)).toThrow(BackupError);
  });
});

describe('backupsToPrune', () => {
  const backup = (at: number): BackupInfo => ({ name: backupName(at), at, size: 1 });

  it('keeps everything while there are no more than the newest allowed', () => {
    const backups = Array.from({ length: 10 }, (_, i) => backup(T0 - i * DAY));
    expect(backupsToPrune(backups)).toEqual([]);
  });

  it('keeps the newest ten, then the latest of each month for six months', () => {
    // One backup a day for 400 days, newest first.
    const backups = Array.from({ length: 400 }, (_, i) => backup(T0 - i * DAY));
    const pruned = new Set(backupsToPrune(backups));
    const kept = backups.filter((b) => !pruned.has(b.name)).map((b) => b.name.slice(5, 13));

    expect(kept).toEqual([
      // The newest ten: 11 November back to 2 November.
      '20261111',
      '20261110',
      '20261109',
      '20261108',
      '20261107',
      '20261106',
      '20261105',
      '20261104',
      '20261103',
      '20261102',
      // Then the latest remaining backup of each of six months.
      '20261101',
      '20261031',
      '20260930',
      '20260831',
      '20260731',
      '20260630',
    ]);
  });

  it('does not depend on the order it is given', () => {
    const backups = Array.from({ length: 60 }, (_, i) => backup(T0 - i * DAY));
    const shuffled = [...backups].sort((a, b) => a.name.localeCompare(b.name));
    expect(backupsToPrune(shuffled).sort()).toEqual(backupsToPrune(backups).sort());
  });
});

describe('restoreBackup', () => {
  it('puts the tree back as it was, and the restored tree can be edited', () => {
    const tree = treeOnDisk();
    const dir = tree.dir ?? '';
    add(tree, 'Kept');
    const saved = snapshot(tree);
    const backup = backupTree(tree, { now: T0 });
    add(tree, 'Mistake');
    tree.close();

    restoreBackup(dir, backup.created?.name ?? '');

    const restored = track(openExistingTree(dir));
    expect(snapshot(restored)).toBe(saved);
    add(restored, 'Later');
    expect(countPersons(restored)).toBe(2);
    expect(existsSync(join(dir, TREE_FILE_NAME + '.restoring'))).toBe(false);
  });

  it('removes a write-ahead log left beside the tree file', () => {
    const tree = treeOnDisk();
    const dir = tree.dir ?? '';
    add(tree, 'Kept');
    const saved = snapshot(tree);
    const backup = backupTree(tree, { now: T0 });
    add(tree, 'Mistake');
    tree.close();
    // What a crash leaves behind: a log that belongs to the old file.
    writeFileSync(join(dir, TREE_FILE_NAME + '-wal'), 'stale log');
    writeFileSync(join(dir, TREE_FILE_NAME + '-shm'), 'stale index');

    restoreBackup(dir, backup.created?.name ?? '');

    expect(existsSync(join(dir, TREE_FILE_NAME + '-wal'))).toBe(false);
    expect(snapshot(track(openExistingTree(dir)))).toBe(saved);
  });

  it('still backs up after a restore followed by as many edits as were lost', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const tree = treeOnDisk();
    const dir = tree.dir ?? '';
    add(tree, 'First');
    const early = backupTree(tree, { now: T0 });

    vi.setSystemTime(T0 + MINUTE);
    add(tree, 'Second');
    backupTree(tree, { now: T0 + MINUTE });
    tree.close();

    restoreBackup(dir, early.created?.name ?? '');
    const restored = track(openExistingTree(dir));
    vi.setSystemTime(T0 + 2 * MINUTE);
    add(restored, 'Different second');

    // Both trees have two steps, but they are not the same two steps.
    expect(backupTree(restored, { now: T0 + 2 * MINUTE }).created).not.toBeNull();
  });

  it('refuses a name that is not a backup of this tree, and leaves the tree alone', () => {
    const tree = treeOnDisk();
    const dir = tree.dir ?? '';
    add(tree, 'Kept');
    backupTree(tree, { now: T0 });
    tree.close();
    const before = readFileSync(join(dir, TREE_FILE_NAME));

    expect(() => restoreBackup(dir, '..\\tree.db')).toThrow(BackupError);
    expect(() => restoreBackup(dir, '../' + TREE_FILE_NAME)).toThrow(BackupError);
    expect(() => restoreBackup(dir, 'tree-20200101T000000Z.db')).toThrow(/no longer exists/);
    expect(readFileSync(join(dir, TREE_FILE_NAME)).equals(before)).toBe(true);
  });

  it('refuses a damaged backup or another program’s database, and leaves the tree alone', () => {
    const tree = treeOnDisk();
    const dir = tree.dir ?? '';
    add(tree, 'Kept');
    const backup = backupTree(tree, { now: T0 });
    tree.close();
    const before = readFileSync(join(dir, TREE_FILE_NAME));
    const folder = join(dir, BACKUP_DIR_NAME);

    truncateSync(join(folder, backup.created?.name ?? ''), 2000);
    expect(() => restoreBackup(dir, backup.created?.name ?? '')).toThrow(BackupError);

    const foreign = openDatabase(join(folder, 'tree-20200101T000000Z.db'));
    foreign.exec('CREATE TABLE notes (body TEXT)');
    foreign.close();
    expect(() => restoreBackup(dir, 'tree-20200101T000000Z.db')).toThrow(/not a RulZ Ancestry/);

    expect(readFileSync(join(dir, TREE_FILE_NAME)).equals(before)).toBe(true);
  });
});
