import { renameSync, rmSync } from 'node:fs';
import { openDatabase, sql, type Db } from './connection';
import { migrate, type Migration } from './migrate';

/**
 * The application database (`app.db` in the profile folder). It holds what
 * belongs to this installation rather than to a tree: the list of recently
 * opened trees and the app's settings.
 */

export const appMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'settings and recent trees',
    up(db) {
      db.exec(`
        CREATE TABLE setting (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        -- Windows paths ignore case, so two spellings of one folder are one row.
        CREATE TABLE recent_tree (
          dir            TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
          tree_id        TEXT NOT NULL,
          name           TEXT NOT NULL,
          last_opened_at INTEGER NOT NULL
        );
        CREATE INDEX recent_tree_opened ON recent_tree(last_opened_at);
      `);
    },
  },
];

/** Opens the application database, creating it or updating its schema as needed. */
export function openAppDatabase(file: string): Db {
  const db = openDatabase(file);
  try {
    migrate(db, appMigrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export interface AppDatabaseOpening {
  db: Db;
  /** Where an unusable file was moved to, or null when the file opened normally. */
  setAside: string | null;
}

/**
 * Opens the application database, and starts a new one if the file cannot be
 * used (it is damaged, or a newer version of the app wrote it). The app must
 * still start in that case: the file holds only the recent list and settings,
 * never a tree. The unusable file is renamed, not deleted.
 */
export function openOrResetAppDatabase(file: string, now = Date.now()): AppDatabaseOpening {
  try {
    return { db: openAppDatabase(file), setAside: null };
  } catch {
    const setAside = `${file}.unusable-${now}`;
    renameSync(file, setAside);
    // A write-ahead log left beside the file belongs to the file that was moved.
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    return { db: openAppDatabase(file), setAside };
  }
}

export function getSetting(db: Db, key: string): string | null {
  const value = sql(db, 'SELECT value FROM setting WHERE key = ?').pluck().get(key) as
    string | undefined;
  return value ?? null;
}

/** Stores a setting. Null removes it. */
export function setSetting(db: Db, key: string, value: string | null): void {
  if (value === null) {
    sql(db, 'DELETE FROM setting WHERE key = ?').run(key);
  } else {
    sql(
      db,
      'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }
}

export interface RecentTree {
  /** The tree's folder. */
  dir: string;
  treeId: string;
  name: string;
  /** When the tree was last opened, in Unix milliseconds. */
  lastOpenedAt: number;
}

/** Longest list of recent trees that is kept. */
export const RECENT_TREE_LIMIT = 20;

/** Records that a tree was opened, and drops the oldest entries beyond the limit. */
export function rememberTree(db: Db, tree: RecentTree): void {
  db.transaction(() => {
    sql(
      db,
      `INSERT INTO recent_tree (dir, tree_id, name, last_opened_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (dir) DO UPDATE SET
         dir = excluded.dir, tree_id = excluded.tree_id, name = excluded.name,
         last_opened_at = excluded.last_opened_at`,
    ).run(tree.dir, tree.treeId, tree.name, tree.lastOpenedAt);
    sql(
      db,
      `DELETE FROM recent_tree WHERE dir NOT IN (
         SELECT dir FROM recent_tree ORDER BY last_opened_at DESC, dir LIMIT ?
       )`,
    ).run(RECENT_TREE_LIMIT);
  })();
}

/** Recently opened trees, latest first. */
export function listRecentTrees(db: Db): RecentTree[] {
  return sql(
    db,
    `SELECT dir, tree_id AS treeId, name, last_opened_at AS lastOpenedAt
     FROM recent_tree ORDER BY last_opened_at DESC, dir`,
  ).all() as RecentTree[];
}

/** Removes a tree from the recent list. The tree itself is not touched. */
export function forgetTree(db: Db, dir: string): void {
  sql(db, 'DELETE FROM recent_tree WHERE dir = ?').run(dir);
}
