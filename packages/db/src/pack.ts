import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * A data pack: one source's records, built on the user's PC from the files
 * the source publishes and kept in a SQLite file of its own. It belongs to the
 * app, never to a tree, and is never attached to another database.
 *
 * {@link PackWriter} writes the file once; {@link PackReader} opens it
 * read-only (never in WAL mode, never writing) and searches it. The rows are
 * the source's own columns, as text; what they mean is for the source's
 * connector to say when a row is read.
 */

/** Marks a SQLite file as a pack ("RZPK"). */
export const PACK_APPLICATION_ID = 0x52_5a_50_4b;
/** The format of the file, kept as `PRAGMA user_version`. */
export const PACK_FORMAT_VERSION = 1;
/** What a pack's id may look like: it names the file. */
export const PACK_ID_PATTERN = /^[a-z0-9]{2,12}$/;
/** The end of a pack's file name. */
export const PACK_FILE_SUFFIX = '.pack';

/** The most results one search gives. */
const MAX_LIMIT = 50;
/** A search counts matches only up to this many. */
const MAX_TOTAL = 1000;
/** The most terms of one part of a query. */
const MAX_TERMS = 8;
/** SQLite's own limit is 2000 columns in a table. */
const MAX_COLUMNS = 1000;

export interface PackMeta {
  packId: string;
  kind: string;
  builderVersion: number;
  title: string;
  sourceName: string;
  sourceUrl: string;
  licence: string;
  credit: string;
  files: {
    url: string;
    bytes: number;
    sha256: string;
    etag: string | null;
    modified: string | null;
  }[];
  rows: number;
  /** The day the files were downloaded, as an ISO date. */
  downloadedAt: string;
  /** When the pack was built, as an ISO time. */
  builtAt: string;
  /** Rows of the source that were left out because they were not whole. */
  skipped?: number;
  /** The source's own last-changed day (`YYYY-MM-DD`) when the pack was made, where the source gives one. */
  sourceModified?: string;
}

/** A search was stopped by its `stop()` function. */
export class PackSearchStopped extends Error {
  constructor() {
    super('The search of the pack was stopped.');
    this.name = 'PackSearchStopped';
  }
}

const META_KEY = 'pack';

const rawColumn = (i: number) => `c${i}`;

/** Builds a pack file at a path that must not exist yet. One connection, journal off. */
export class PackWriter {
  readonly #db: Database.Database;
  readonly #columns: readonly string[];
  readonly #nameAt: number[];
  readonly #placeAt: number[];
  readonly #insertRaw: Database.Statement;
  readonly #insertFts: Database.Statement;
  #rows = 0;
  #closed = false;

  private constructor(
    db: Database.Database,
    columns: readonly string[],
    nameAt: number[],
    placeAt: number[],
  ) {
    this.#db = db;
    this.#columns = columns;
    this.#nameAt = nameAt;
    this.#placeAt = placeAt;
    this.#insertRaw = db.prepare(
      `INSERT INTO raw (year, ${columns.map((_, i) => rawColumn(i)).join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})`,
    );
    this.#insertFts = db.prepare('INSERT INTO fts (rowid, names, places) VALUES (?, ?, ?)');
  }

  /**
   * Starts a pack at `path`. `columns` are the source's column names, in the
   * order the rows will have; `ftsColumns` name those whose text is searched
   * as names and as places.
   */
  static create(
    path: string,
    columns: readonly string[],
    ftsColumns: { names: readonly string[]; places: readonly string[] },
  ): PackWriter {
    if (existsSync(path)) throw new Error(`The pack file ${path} exists already.`);
    if (columns.length === 0 || columns.length > MAX_COLUMNS) {
      throw new Error('A pack needs between 1 and 1000 columns.');
    }
    if (new Set(columns).size !== columns.length) throw new Error('Column names must differ.');
    const indexes = (names: readonly string[]) =>
      names.map((name) => {
        const at = columns.indexOf(name);
        if (at < 0) throw new Error(`The column ${name} is not one of the pack's columns.`);
        return at;
      });
    const nameAt = indexes(ftsColumns.names);
    const placeAt = indexes(ftsColumns.places);
    const db = new Database(path);
    try {
      db.pragma('journal_mode = OFF');
      db.pragma('synchronous = OFF');
      db.pragma('locking_mode = EXCLUSIVE');
      db.pragma('cache_size = -131072');
      db.exec(
        `CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID;
         CREATE TABLE columns (i INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL);
         CREATE TABLE raw (
           rowid INTEGER PRIMARY KEY,
           year INTEGER,
           ${columns.map((_, i) => `${rawColumn(i)} TEXT`).join(', ')}
         );
         CREATE VIRTUAL TABLE fts USING fts5(
           names, places, content='', tokenize='unicode61 remove_diacritics 2', prefix='2 3'
         );`,
      );
      const insertColumn = db.prepare('INSERT INTO columns (i, name) VALUES (?, ?)');
      columns.forEach((name, i) => insertColumn.run(i, name));
      return new PackWriter(db, columns, nameAt, placeAt);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Adds rows (values in the order of the columns), all in one transaction. */
  add(rows: readonly { year: number | null; values: readonly string[] }[]): void {
    if (this.#closed) throw new Error('The pack writer is closed.');
    for (const row of rows) {
      if (row.values.length !== this.#columns.length) {
        throw new Error(
          `A row has ${row.values.length} values; the pack has ${this.#columns.length} columns.`,
        );
      }
    }
    const text = (row: { values: readonly string[] }, at: number[]) =>
      at
        .map((i) => row.values[i] ?? '')
        .filter((part) => part !== '')
        .join(' ');
    this.#db.transaction(() => {
      for (const row of rows) {
        const year = row.year !== null && Number.isInteger(row.year) ? row.year : null;
        const info = this.#insertRaw.run(year, ...row.values);
        this.#insertFts.run(
          info.lastInsertRowid,
          text(row, this.#nameAt),
          text(row, this.#placeAt),
        );
      }
    })();
    this.#rows += rows.length;
  }

  /**
   * Writes the description, marks the file as a pack, checks it and closes
   * it. Throws when the check fails; the file is then left for the caller to
   * delete.
   */
  finish(meta: Omit<PackMeta, 'rows' | 'builtAt'>): PackMeta {
    if (this.#closed) throw new Error('The pack writer is closed.');
    const full: PackMeta = { ...meta, rows: this.#rows, builtAt: new Date().toISOString() };
    try {
      this.#db.exec('CREATE INDEX raw_year ON raw (year)');
      this.#db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(META_KEY, JSON.stringify(full));
      this.#db.pragma(`application_id = ${PACK_APPLICATION_ID}`);
      this.#db.pragma(`user_version = ${PACK_FORMAT_VERSION}`);
      const check = this.#db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`The new pack failed its check: ${String(check)}`);
    } finally {
      this.#closed = true;
      this.#db.close();
    }
    return full;
  }

  /** Closes without finishing. The file is the caller's to delete. */
  abandon(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export type PackOpen =
  | { ok: true; reader: PackReader }
  | { ok: false; reason: 'not-a-pack' | 'newer-format' | 'unreadable' };

function isMeta(value: unknown): value is PackMeta {
  if (typeof value !== 'object' || value === null) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta['packId'] === 'string' &&
    PACK_ID_PATTERN.test(meta['packId']) &&
    typeof meta['kind'] === 'string' &&
    typeof meta['rows'] === 'number' &&
    typeof meta['downloadedAt'] === 'string' &&
    Array.isArray(meta['files'])
  );
}

/**
 * The terms of a text for an FTS5 query: letters and digits, each quoted so
 * that nothing typed is an operator. At most {@link MAX_TERMS}; only the last
 * may be a prefix, and only when it has two characters or more.
 */
function ftsTerms(text: string): string {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);
  return words
    .map((word, i) => {
      const prefix = i === words.length - 1 && [...word].length >= 2;
      return `"${word}"${prefix ? '*' : ''}`;
    })
    .join(' ');
}

/** A pack opened for reading. */
export class PackReader {
  readonly meta: PackMeta;
  readonly columns: readonly string[];
  readonly #db: Database.Database;
  readonly #state: { stop: () => boolean } = { stop: () => false };

  private constructor(db: Database.Database, meta: PackMeta, columns: readonly string[]) {
    this.#db = db;
    this.meta = meta;
    this.columns = columns;
    // Called in the WHERE of every query, per row: throws when the search was stopped.
    db.function('rulz_go', () => {
      if (this.#state.stop()) throw new PackSearchStopped();
      return 1;
    });
  }

  /** Opens a pack read-only. Never sets WAL and never writes. */
  static open(path: string): PackOpen {
    let db: Database.Database | null = null;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
      const id = db.pragma('application_id', { simple: true });
      if (id !== PACK_APPLICATION_ID) {
        db.close();
        return { ok: false, reason: 'not-a-pack' };
      }
      const version = db.pragma('user_version', { simple: true });
      if (typeof version !== 'number' || version < 1) {
        db.close();
        return { ok: false, reason: 'not-a-pack' };
      }
      if (version > PACK_FORMAT_VERSION) {
        db.close();
        return { ok: false, reason: 'newer-format' };
      }
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as
        { value: string } | undefined;
      if (row === undefined) {
        db.close();
        return { ok: false, reason: 'not-a-pack' };
      }
      const meta: unknown = JSON.parse(row.value);
      if (!isMeta(meta)) {
        db.close();
        return { ok: false, reason: 'unreadable' };
      }
      const names = db.prepare('SELECT name FROM columns ORDER BY i').pluck().all() as string[];
      return { ok: true, reader: new PackReader(db, meta, names) };
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Nothing more to do with a file that cannot be closed.
      }
      const code = (error as { code?: unknown }).code;
      if (code === 'SQLITE_NOTADB') return { ok: false, reason: 'not-a-pack' };
      return { ok: false, reason: 'unreadable' };
    }
  }

  /**
   * Looks for rows whose names (and places, when given) hold the terms, best
   * match first, then by year, then in the order they were added. At most 50
   * rows come back, and a total counted up to 1000. `stop()` is asked for
   * every row looked at; when it returns true the search throws
   * {@link PackSearchStopped}. A query with `years` leaves out rows that have
   * no year.
   */
  search(
    q: {
      names: string;
      places?: string;
      limit: number;
      offset: number;
      years?: { from: number; to: number };
    },
    stop: () => boolean,
  ): { rows: Record<string, string>[]; total: number } {
    if (stop()) throw new PackSearchStopped();
    const names = ftsTerms(q.names);
    const places = ftsTerms(q.places ?? '');
    const parts = [
      ...(names === '' ? [] : [`names : (${names})`]),
      ...(places === '' ? [] : [`places : (${places})`]),
    ];
    if (parts.length === 0) return { rows: [], total: 0 };
    const match = parts.join(' AND ');
    const limit = Math.max(1, Math.min(Math.trunc(q.limit) || 1, MAX_LIMIT));
    const offset = Math.max(0, Math.trunc(q.offset) || 0);
    const years = q.years ? ' AND raw.year BETWEEN ? AND ?' : '';
    const yearArgs = q.years ? [Math.trunc(q.years.from), Math.trunc(q.years.to)] : [];
    const from = `FROM fts CROSS JOIN raw ON raw.rowid = fts.rowid
                  WHERE fts MATCH ? AND rulz_go() = 1${years}`;
    this.#state.stop = stop;
    try {
      const list = this.#db
        .prepare(
          `SELECT ${this.columns.map((_, i) => `raw.${rawColumn(i)}`).join(', ')}
           ${from}
           ORDER BY fts.rank, raw.year, raw.rowid
           LIMIT ? OFFSET ?`,
        )
        .raw()
        .all(match, ...yearArgs, limit, offset) as unknown[][];
      const total = this.#db
        .prepare(`SELECT count(*) FROM (SELECT 1 ${from} LIMIT ${MAX_TOTAL})`)
        .pluck()
        .get(match, ...yearArgs) as number;
      const rows = list.map((values) => {
        const row: Record<string, string> = {};
        this.columns.forEach((name, i) => {
          const value = values[i];
          row[name] = typeof value === 'string' ? value : '';
        });
        return row;
      });
      return { rows, total };
    } finally {
      this.#state.stop = () => false;
    }
  }

  close(): void {
    this.#db.close();
  }
}
