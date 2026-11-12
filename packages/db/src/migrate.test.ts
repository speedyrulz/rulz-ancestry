import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './connection';
import { SchemaTooNewError, migrate, schemaVersion, type Migration } from './migrate';

const open: Db[] = [];

function memoryDb(): Db {
  const db = openDatabase(':memory:');
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const tables = (db: Db) =>
  db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").pluck().all();

const first: Migration = {
  version: 1,
  name: 'people',
  up: (db) => db.exec('CREATE TABLE person (id TEXT PRIMARY KEY NOT NULL)'),
};
const second: Migration = {
  version: 2,
  name: 'names',
  up: (db) =>
    db.exec(
      'CREATE TABLE person_name (id TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES person(id))',
    ),
};

describe('migrate', () => {
  it('brings a new database to the newest version', () => {
    const db = memoryDb();
    expect(migrate(db, [first, second])).toEqual({ from: 0, to: 2 });
    expect(schemaVersion(db)).toBe(2);
    expect(tables(db)).toEqual(['person', 'person_name']);
  });

  it('runs only the migrations a database has not had yet', () => {
    const db = memoryDb();
    migrate(db, [first]);
    db.prepare('INSERT INTO person (id) VALUES (?)').run('p1');

    expect(migrate(db, [first, second])).toEqual({ from: 1, to: 2 });
    expect(migrate(db, [first, second])).toEqual({ from: 2, to: 2 });
    expect(db.prepare('SELECT id FROM person').pluck().all()).toEqual(['p1']);
  });

  it('undoes a failed migration completely and keeps the earlier ones', () => {
    const db = memoryDb();
    const broken: Migration = {
      version: 2,
      name: 'broken',
      up: (db) => {
        db.exec('CREATE TABLE half_done (id TEXT)');
        throw new Error('boom');
      },
    };
    expect(() => migrate(db, [first, broken])).toThrow('boom');
    expect(schemaVersion(db)).toBe(1);
    expect(tables(db)).toEqual(['person']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses a database written by a newer version of the app', () => {
    const db = memoryDb();
    db.pragma('user_version = 7');
    expect(() => migrate(db, [first, second])).toThrow(SchemaTooNewError);
    expect(schemaVersion(db)).toBe(7);
  });

  it('rejects a migration that leaves a broken reference', () => {
    const db = memoryDb();
    const orphan: Migration = {
      version: 3,
      name: 'orphan',
      up: (db) => {
        db.prepare('INSERT INTO person_name (id, person_id) VALUES (?, ?)').run('n1', 'nobody');
      },
    };
    expect(() => migrate(db, [first, second, orphan])).toThrow(/broken foreign key/);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare('SELECT count(*) FROM person_name').pluck().get()).toBe(0);
  });

  it('rejects a migration list with a gap or a wrong order', () => {
    const db = memoryDb();
    expect(() => migrate(db, [second])).toThrow(/must have version 1/);
    expect(() => migrate(db, [first, { ...second, version: 3 }])).toThrow(/must have version 2/);
    expect(schemaVersion(db)).toBe(0);
  });
});
