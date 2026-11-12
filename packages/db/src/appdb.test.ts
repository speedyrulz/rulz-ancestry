import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RECENT_TREE_LIMIT,
  appMigrations,
  forgetTree,
  getSetting,
  listRecentTrees,
  openAppDatabase,
  openOrResetAppDatabase,
  rememberTree,
  setSetting,
} from './appdb';
import { openDatabase, type Db } from './connection';
import { schemaVersion } from './migrate';
import { cleanUpAfterEach, tempDir } from './testing';

cleanUpAfterEach();

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    if (db.open) db.close();
  }
});

function appDb(file = ':memory:'): Db {
  const db = openAppDatabase(file);
  open.push(db);
  return db;
}

describe('openAppDatabase', () => {
  it('creates the schema at the newest version', () => {
    const db = appDb();
    expect(schemaVersion(db)).toBe(appMigrations.length);
    expect(listRecentTrees(db)).toEqual([]);
  });

  it('upgrades the empty database file that earlier builds of the app left behind', () => {
    const file = join(tempDir(), 'app.db');
    // Phase 0 and 1a opened app.db but never created a table in it.
    openDatabase(file).close();

    const first = appDb(file);
    expect(schemaVersion(first)).toBe(appMigrations.length);
    setSetting(first, 'k', 'v');
    first.close();

    expect(getSetting(appDb(file), 'k')).toBe('v');
  });
});

describe('openOrResetAppDatabase', () => {
  it('opens a usable file as it is', () => {
    const file = join(tempDir(), 'app.db');
    const first = appDb(file);
    setSetting(first, 'k', 'v');
    first.close();

    const opening = openOrResetAppDatabase(file);
    open.push(opening.db);
    expect(opening.setAside).toBeNull();
    expect(getSetting(opening.db, 'k')).toBe('v');
  });

  it('starts afresh when the file is not a database, and keeps the old file', () => {
    const dir = tempDir();
    const file = join(dir, 'app.db');
    writeFileSync(file, 'this is not a database, but it is long enough to look like a file');

    const opening = openOrResetAppDatabase(file, 1234);
    open.push(opening.db);
    expect(opening.setAside).toBe(file + '.unusable-1234');
    expect(readFileSync(file + '.unusable-1234', 'utf8')).toMatch(/^this is not a database/);
    expect(schemaVersion(opening.db)).toBe(appMigrations.length);
    setSetting(opening.db, 'k', 'v');
    expect(getSetting(opening.db, 'k')).toBe('v');
  });

  it('starts afresh when a newer version of the app wrote the file', () => {
    const dir = tempDir();
    const file = join(dir, 'app.db');
    const newer = openDatabase(file);
    newer.pragma(`user_version = ${appMigrations.length + 1}`);
    newer.close();

    const opening = openOrResetAppDatabase(file, 5678);
    open.push(opening.db);
    expect(opening.setAside).toBe(file + '.unusable-5678');
    // The new file is open, so its write-ahead log files are there too.
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['app.db', 'app.db.unusable-5678']));
    const kept = openDatabase(file + '.unusable-5678');
    open.push(kept);
    expect(schemaVersion(kept)).toBe(appMigrations.length + 1);
    expect(schemaVersion(opening.db)).toBe(appMigrations.length);
  });
});

describe('settings', () => {
  it('stores, replaces and removes a value', () => {
    const db = appDb();
    expect(getSetting(db, 'last_tree')).toBeNull();
    setSetting(db, 'last_tree', 'C:\\Trees\\One');
    setSetting(db, 'last_tree', 'C:\\Trees\\Two');
    expect(getSetting(db, 'last_tree')).toBe('C:\\Trees\\Two');
    setSetting(db, 'last_tree', null);
    expect(getSetting(db, 'last_tree')).toBeNull();
  });
});

describe('recent trees', () => {
  it('lists the latest opened first', () => {
    const db = appDb();
    rememberTree(db, { dir: 'C:\\T\\A', treeId: 'a', name: 'A', lastOpenedAt: 100 });
    rememberTree(db, { dir: 'C:\\T\\B', treeId: 'b', name: 'B', lastOpenedAt: 300 });
    rememberTree(db, { dir: 'C:\\T\\C', treeId: 'c', name: 'C', lastOpenedAt: 200 });
    expect(listRecentTrees(db).map((tree) => tree.name)).toEqual(['B', 'C', 'A']);
  });

  it('keeps one entry per folder, whatever the letter case, with the latest details', () => {
    const db = appDb();
    rememberTree(db, { dir: 'C:\\Trees\\Smith', treeId: 'a', name: 'Old name', lastOpenedAt: 1 });
    rememberTree(db, { dir: 'c:\\trees\\SMITH', treeId: 'a', name: 'New name', lastOpenedAt: 2 });
    expect(listRecentTrees(db)).toEqual([
      { dir: 'c:\\trees\\SMITH', treeId: 'a', name: 'New name', lastOpenedAt: 2 },
    ]);
  });

  it('forgets a tree without touching the others', () => {
    const db = appDb();
    rememberTree(db, { dir: 'C:\\T\\A', treeId: 'a', name: 'A', lastOpenedAt: 1 });
    rememberTree(db, { dir: 'C:\\T\\B', treeId: 'b', name: 'B', lastOpenedAt: 2 });
    forgetTree(db, 'c:\\t\\a');
    expect(listRecentTrees(db).map((tree) => tree.name)).toEqual(['B']);
  });

  it('drops the oldest entries beyond the limit', () => {
    const db = appDb();
    const total = RECENT_TREE_LIMIT + 5;
    for (let i = 1; i <= total; i += 1) {
      rememberTree(db, {
        dir: 'C:\\T\\' + String(i),
        treeId: String(i),
        name: 'Tree ' + String(i),
        lastOpenedAt: i,
      });
    }
    const names = listRecentTrees(db).map((tree) => tree.name);
    expect(names).toHaveLength(RECENT_TREE_LIMIT);
    expect(names[0]).toBe('Tree ' + String(total));
    expect(names.at(-1)).toBe('Tree 6');
  });
});
