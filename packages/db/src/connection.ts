import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface SqliteInfo {
  /** Version of the SQLite library compiled into better-sqlite3. */
  sqliteVersion: string;
  /** Whether full-text search (FTS5) is available; own-tree search depends on it. */
  fts5: boolean;
  journalMode: string;
}

/**
 * Opens (and creates if needed) a SQLite database with the settings every
 * RulZ Ancestry database uses. Pass ':memory:' for a throwaway database.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  // WAL lets the UI read while a background job writes, and survives crashes
  // without corrupting the file.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // SQLite does not enforce foreign keys unless asked, per connection.
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function getSqliteInfo(db: Db): SqliteInfo {
  const sqliteVersion = db.prepare('SELECT sqlite_version()').pluck().get() as string;
  const fts5 = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5')").pluck().get() === 1;
  const journalMode = db.pragma('journal_mode', { simple: true }) as string;
  return { sqliteVersion, fts5, journalMode };
}

const statements = new WeakMap<Db, Map<string, Database.Statement>>();

/**
 * Returns a prepared statement for `text`, compiling it only the first time it
 * is used on this connection. An import runs the same few statements tens of
 * thousands of times, so compiling once matters.
 */
export function sql(db: Db, text: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) {
    cache = new Map();
    statements.set(db, cache);
  }
  let statement = cache.get(text);
  if (!statement) {
    statement = db.prepare(text);
    cache.set(text, statement);
  }
  return statement;
}
