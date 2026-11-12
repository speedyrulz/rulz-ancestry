import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { idTimestamp } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { UNTRACKED_WRITE_MESSAGE } from './changelog';
import { openDatabase } from './connection';
import { SchemaTooNewError, migrate } from './migrate';
import { createPerson, countPersons } from './persons';
import { treeMigrations } from './schema';
import { checkTreeEngine } from './selfcheck';
import { cleanUpAfterEach, memoryTree, tempDir, track, undoDepth } from './testing';
import {
  LOADED_AT_KEY,
  NoTreeError,
  NotATreeError,
  TREE_APPLICATION_ID,
  TREE_FILE_NAME,
  TreeLocationError,
  createTree,
  hasTree,
  openExistingTree,
  openTree,
  treeFolderName,
} from './tree';

cleanUpAfterEach();

describe('openTree', () => {
  it('creates an empty tree at the newest schema version', () => {
    const tree = memoryTree();
    const info = tree.info();
    expect(info).toMatchObject({
      name: 'Family tree',
      schemaVersion: treeMigrations.length,
      persons: 0,
      families: 0,
      events: 0,
    });
    expect(tree.dir).toBeNull();
    // The tree id is a UUIDv7 made just now.
    expect(Math.abs(idTimestamp(info.id) - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(info.createdAt - Date.now())).toBeLessThan(60_000);
  });

  it('creates the folder and the database file, named after the folder', () => {
    const dir = join(tempDir(), 'nested', 'Smith family');
    const tree = track(openTree(dir));
    expect(existsSync(join(dir, TREE_FILE_NAME))).toBe(true);
    expect(tree.dir).toBe(dir);
    expect(tree.info().name).toBe('Smith family');
    expect(tree.db.pragma('application_id', { simple: true })).toBe(TREE_APPLICATION_ID);
    expect(tree.db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('keeps the tree id, name and data when the folder is opened again', () => {
    const dir = tempDir();
    const first = track(openTree(dir, { name: 'My tree' }));
    const id = first.info().id;
    createPerson(first, { name: { given: 'Ada', surname: 'Lovelace' } });
    first.close();

    const second = track(openTree(dir, { name: 'Ignored for an existing tree' }));
    expect(second.info()).toMatchObject({ id, name: 'My tree', persons: 1 });
  });

  it('refuses a SQLite file that another program made', () => {
    const dir = tempDir();
    const other = openDatabase(join(dir, TREE_FILE_NAME));
    other.exec('CREATE TABLE notes (body TEXT)');
    other.close();

    expect(() => openTree(dir)).toThrow(NotATreeError);
    // The refusal must not have changed the file.
    const check = openDatabase(join(dir, TREE_FILE_NAME));
    expect(check.prepare('SELECT name FROM sqlite_schema').pluck().all()).toEqual(['notes']);
    check.close();
  });

  it('refuses a tree written by a newer version of the app', () => {
    const dir = tempDir();
    openTree(dir).close();
    const db = openDatabase(join(dir, TREE_FILE_NAME));
    db.pragma('user_version = 9999');
    db.close();

    expect(() => openTree(dir)).toThrow(SchemaTooNewError);
  });
});

describe('Tree.transact', () => {
  it('rejects a write to a tree table made outside a change', () => {
    const tree = memoryTree();
    const insert = tree.db.prepare(
      "INSERT INTO person (id, sex, created_at, updated_at) VALUES ('p1', 'U', 0, 0)",
    );
    expect(() => insert.run()).toThrow(UNTRACKED_WRITE_MESSAGE);

    const person = createPerson(tree);
    expect(() => tree.db.prepare('UPDATE person SET sex = ?').run('F')).toThrow(
      UNTRACKED_WRITE_MESSAGE,
    );
    expect(() => tree.db.prepare('DELETE FROM person WHERE id = ?').run(person.id)).toThrow(
      UNTRACKED_WRITE_MESSAGE,
    );
    expect(countPersons(tree)).toBe(1);
  });

  it('saves nothing when the change fails part way', () => {
    const tree = memoryTree();
    expect(() =>
      tree.transact('Add two people', () => {
        createPerson(tree, { name: { given: 'Kept?' } });
        throw new Error('second step failed');
      }),
    ).toThrow('second step failed');

    expect(countPersons(tree)).toBe(0);
    expect(undoDepth(tree)).toBe(0);
    expect(tree.db.prepare('SELECT mode, current_tx FROM change_state').get()).toEqual({
      mode: 'idle',
      current_tx: null,
    });
    // The tree still works afterwards.
    createPerson(tree);
    expect(countPersons(tree)).toBe(1);
  });

  it('makes one undo step out of several writes', () => {
    const tree = memoryTree();
    tree.transact('Add the Smiths', () => {
      createPerson(tree, { name: { given: 'John', surname: 'Smith' } });
      createPerson(tree, { name: { given: 'Jane', surname: 'Smith' } });
    });
    expect(undoDepth(tree)).toBe(1);
    expect(tree.undoStatus().undo?.label).toBe('Add the Smiths');

    tree.undo();
    expect(countPersons(tree)).toBe(0);
  });

  it('leaves no undo step for a change that changed nothing', () => {
    const tree = memoryTree();
    expect(tree.transact('Nothing', () => 42)).toBe(42);
    expect(undoDepth(tree)).toBe(0);
  });

  it('does not allow undo in the middle of a change', () => {
    const tree = memoryTree();
    createPerson(tree);
    expect(() => tree.transact('Bad', () => tree.undo())).toThrow(/cannot undo/);
    expect(countPersons(tree)).toBe(1);
  });
});

describe('Tree.load', () => {
  it('fills an empty tree without recording anything to undo', () => {
    const tree = memoryTree();
    expect(tree.getMeta(LOADED_AT_KEY)).toBeNull();
    const made = tree.load(() => {
      // The ordinary functions join the load; they make no undo steps of their own.
      createPerson(tree, { name: { given: 'Ada' } });
      createPerson(tree, { name: { given: 'Charles' } });
      return 2;
    });
    expect(made).toBe(2);
    expect(countPersons(tree)).toBe(2);
    expect(undoDepth(tree)).toBe(0);
    expect(tree.db.prepare('SELECT count(*) FROM change_log').pluck().get()).toBe(0);
    expect(Number(tree.getMeta(LOADED_AT_KEY))).toBeGreaterThan(0);

    // Afterwards the tree is edited, and protected, like any other.
    createPerson(tree, { name: { given: 'Later' } });
    expect(tree.undoStatus().undo?.label).toBe('Add person');
    expect(() => tree.db.prepare("UPDATE person SET sex = 'F'").run()).toThrow(
      UNTRACKED_WRITE_MESSAGE,
    );
  });

  it('refuses a tree that has people in it', () => {
    const tree = memoryTree();
    createPerson(tree);
    expect(() => tree.load(() => createPerson(tree))).toThrow(/still empty/);
    expect(countPersons(tree)).toBe(1);
    expect(undoDepth(tree)).toBe(1);
  });

  it('saves nothing when the load fails part way, and leaves the tree usable', () => {
    const tree = memoryTree();
    expect(() =>
      tree.load(() => {
        createPerson(tree);
        throw new Error('the file ended early');
      }),
    ).toThrow('the file ended early');
    expect(countPersons(tree)).toBe(0);
    expect(tree.getMeta(LOADED_AT_KEY)).toBeNull();
    // The tree is back in its guarded state, and a load can be tried again.
    expect(() =>
      tree.db.prepare("INSERT INTO person (id, created_at, updated_at) VALUES ('x', 1, 1)").run(),
    ).toThrow(UNTRACKED_WRITE_MESSAGE);
    tree.load(() => createPerson(tree));
    expect(countPersons(tree)).toBe(1);
  });

  it('cannot be started in the middle of a change', () => {
    const tree = memoryTree();
    expect(() => tree.transact('Bad', () => tree.load(() => 1))).toThrow(/cannot load a file/);
  });
});

describe('getMeta and setMeta', () => {
  it('store facts about the tree, replacing an earlier value', () => {
    const tree = memoryTree();
    expect(tree.getMeta('colour')).toBeNull();
    tree.setMeta('colour', 'green');
    tree.setMeta('colour', 'blue');
    expect(tree.getMeta('colour')).toBe('blue');
    expect(tree.getMeta('name')).toBe(tree.info().name);
  });
});

describe('trees made by an earlier version of the app', () => {
  it('are brought up to the newest schema when opened, keeping what they hold', () => {
    const dir = tempDir();
    // A tree as the first schema version left it.
    const old = openDatabase(join(dir, TREE_FILE_NAME));
    old.pragma(`application_id = ${TREE_APPLICATION_ID}`);
    migrate(old, treeMigrations.slice(0, 1));
    old
      .prepare("INSERT INTO tree_meta (key, value) VALUES ('id', 'old-tree'), ('name', 'Old')")
      .run();
    old.close();

    const tree = track(openExistingTree(dir));
    expect(tree.info()).toMatchObject({
      id: 'old-tree',
      name: 'Old',
      schemaVersion: treeMigrations.length,
    });
    expect(tree.db.prepare('SELECT count(*) FROM gedcom_record').pluck().get()).toBe(0);
    createPerson(tree, { name: { given: 'Still works' } });
    expect(countPersons(tree)).toBe(1);
  });
});

describe('checkTreeEngine', () => {
  it('reports the newest schema version', () => {
    expect(checkTreeEngine()).toEqual({ schemaVersion: treeMigrations.length });
  });
});

describe('createTree', () => {
  it('creates a named tree in a new folder or an empty one', () => {
    const parent = tempDir();
    const fresh = track(createTree(join(parent, 'New folder'), { name: '  The  Smith family ' }));
    expect(fresh.info()).toMatchObject({ name: 'The Smith family', persons: 0 });
    expect(hasTree(join(parent, 'New folder'))).toBe(true);

    const empty = tempDir();
    expect(hasTree(empty)).toBe(false);
    track(createTree(empty, { name: 'Empty folder' }));
    expect(hasTree(empty)).toBe(true);
  });

  it('refuses a folder that already holds a tree or other files, and changes nothing', () => {
    const withTree = tempDir();
    const first = track(createTree(withTree, { name: 'First' }));
    createPerson(first, { name: { given: 'Kept' } });
    first.close();
    expect(() => createTree(withTree, { name: 'Second' })).toThrow(/already a tree/);
    expect(track(openExistingTree(withTree)).info()).toMatchObject({ name: 'First', persons: 1 });

    const withFiles = tempDir();
    writeFileSync(join(withFiles, 'holiday.jpg'), 'not a tree');
    expect(() => createTree(withFiles, { name: 'Tree' })).toThrow(TreeLocationError);
    expect(readdirSync(withFiles)).toEqual(['holiday.jpg']);

    expect(() => createTree(join(withFiles, 'holiday.jpg'), { name: 'Tree' })).toThrow(
      /not a folder/,
    );
  });

  it('needs a name', () => {
    const dir = join(tempDir(), 'unnamed');
    expect(() => createTree(dir, { name: '   ' })).toThrow(TreeLocationError);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('openExistingTree', () => {
  it('opens a tree but never creates one', () => {
    const dir = tempDir();
    expect(() => openExistingTree(dir)).toThrow(NoTreeError);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => openExistingTree(join(dir, 'missing'))).toThrow(NoTreeError);
    expect(existsSync(join(dir, 'missing'))).toBe(false);

    track(createTree(dir, { name: 'Real' })).close();
    expect(track(openExistingTree(dir)).info().name).toBe('Real');
  });

  it('reports a tree file that is not a database, and lets go of the file', () => {
    const dir = tempDir();
    const file = join(dir, TREE_FILE_NAME);
    writeFileSync(file, 'this is not a database, but it is long enough to look like a file');

    expect(() => openExistingTree(dir)).toThrow(/not a database/);
    // Windows refuses to delete a file that is still open.
    rmSync(file);
    expect(existsSync(file)).toBe(false);
  });
});

describe('treeFolderName', () => {
  it('turns a tree name into a folder name Windows accepts', () => {
    const cases: [string, string][] = [
      ['Smith family', 'Smith family'],
      ['  Smith   family  ', 'Smith family'],
      ['Smith/Jones: "the" <big> tree?', 'Smith Jones the big tree'],
      ['Müller & Søn', 'Müller & Søn'],
      ['Ends with dots...', 'Ends with dots'],
      ['tab\there', 'tab here'],
      ['CON', 'CON tree'],
      ['lpt1.backup', 'lpt1.backup tree'],
      ['', 'Family tree'],
      ['???', 'Family tree'],
      ['. .', 'Family tree'],
    ];
    for (const [name, folder] of cases) expect(treeFolderName(name), name).toBe(folder);
    expect(treeFolderName('x'.repeat(200))).toHaveLength(80);
  });
});
