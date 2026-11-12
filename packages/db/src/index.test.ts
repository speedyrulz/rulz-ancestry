import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSqliteInfo, openDatabase, type Db } from './index';

const open: Db[] = [];
const tempDirs: string[] = [];

function track(db: Db): Db {
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('enforces foreign keys', () => {
    const db = track(openDatabase(':memory:'));
    db.exec(`
      CREATE TABLE person (id TEXT PRIMARY KEY);
      CREATE TABLE person_name (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES person(id)
      );
    `);
    expect(() =>
      db.prepare('INSERT INTO person_name (id, person_id) VALUES (?, ?)').run('n1', 'missing'),
    ).toThrow(/FOREIGN KEY/);
  });

  it('uses write-ahead logging for database files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rulz-db-'));
    tempDirs.push(dir);
    const db = track(openDatabase(join(dir, 'test.db')));
    expect(getSqliteInfo(db).journalMode).toBe('wal');
  });
});

describe('getSqliteInfo', () => {
  it('reports the SQLite version', () => {
    const db = track(openDatabase(':memory:'));
    expect(getSqliteInfo(db).sqliteVersion).toMatch(/^3\.\d+\.\d+/);
  });

  it('reports FTS5, and FTS5 matches names regardless of accents', () => {
    const db = track(openDatabase(':memory:'));
    expect(getSqliteInfo(db).fts5).toBe(true);

    // The tokenizer the plan specifies for own-tree search.
    db.exec(`
      CREATE VIRTUAL TABLE search_fts USING fts5(
        text, tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    const insert = db.prepare('INSERT INTO search_fts (text) VALUES (?)');
    insert.run('Johann Müller');
    insert.run('Zoë Brontë');
    insert.run('John Smith');

    const match = db.prepare('SELECT text FROM search_fts WHERE search_fts MATCH ?').pluck();
    expect(match.all('muller')).toEqual(['Johann Müller']);
    expect(match.all('bronte')).toEqual(['Zoë Brontë']);
    expect(match.all('schmidt')).toEqual([]);
  });
});
