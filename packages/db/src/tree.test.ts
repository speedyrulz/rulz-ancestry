import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { idTimestamp } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { UNTRACKED_WRITE_MESSAGE } from './changelog';
import { openDatabase } from './connection';
import { SchemaTooNewError } from './migrate';
import { createPerson, countPersons } from './persons';
import { treeMigrations } from './schema';
import { checkTreeEngine } from './selfcheck';
import { cleanUpAfterEach, memoryTree, tempDir, track, undoDepth } from './testing';
import { NotATreeError, TREE_APPLICATION_ID, TREE_FILE_NAME, openTree } from './tree';

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

describe('checkTreeEngine', () => {
  it('reports the newest schema version', () => {
    expect(checkTreeEngine()).toEqual({ schemaVersion: treeMigrations.length });
  });
});
