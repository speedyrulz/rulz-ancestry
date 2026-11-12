import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './connection';
import { schemaVersion } from './migrate';
import { treeMigrations } from './schema';
import { TREE_APPLICATION_ID, TREE_FILE_NAME, type Tree } from './tree';

/**
 * Backups of a tree: complete copies of `tree.db`, kept in the `backups`
 * folder inside the tree folder so they travel with it.
 *
 * A copy is written with SQLite's `VACUUM INTO`, which gives a consistent,
 * compact file even while the tree is open. It is written under a temporary
 * name, checked, and only then given its final name, so a file called
 * `tree-….db` is always a complete, readable backup.
 */

export const BACKUP_DIR_NAME = 'backups';

const BACKUP_NAME = /^tree-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.db$/;

/** A backup could not be made, read or restored. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupInfo {
  /** File name inside the backups folder, e.g. `tree-20261111T153012Z.db`. */
  name: string;
  /** When the backup was made, in Unix milliseconds (read from the name). */
  at: number;
  /** Size of the file in bytes. */
  size: number;
}

export interface RetentionPolicy {
  /** The newest backups, all kept. */
  newest: number;
  /** Beyond those, the latest backup of each month is kept for this many months. */
  months: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { newest: 10, months: 6 };

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** The file name for a backup made at `at`. `copy` tells apart two made in the same second. */
export function backupName(at: number, copy = 1): string {
  const d = new Date(at);
  const stamp =
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return `tree-${stamp}${copy > 1 ? `-${copy}` : ''}.db`;
}

/** The time in a backup file name, or null when the name is not a backup's. */
export function parseBackupName(name: string): number | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const at = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC accepts month 13 or day 40 and rolls over; a real backup name never needs that.
  return backupName(at).slice(0, 21) === name.slice(0, 21) ? at : null;
}

function copyNumber(name: string): number {
  return Number(BACKUP_NAME.exec(name)?.[7] ?? 1);
}

/** The backups in a tree folder, newest first. */
export function listBackups(dir: string): BackupInfo[] {
  const folder = join(dir, BACKUP_DIR_NAME);
  if (!existsSync(folder)) return [];
  const backups: BackupInfo[] = [];
  for (const name of readdirSync(folder)) {
    const at = parseBackupName(name);
    if (at === null) continue;
    const stat = statSync(join(folder, name));
    if (stat.isFile()) backups.push({ name, at, size: stat.size });
  }
  return backups.sort((a, b) => b.at - a.at || copyNumber(b.name) - copyNumber(a.name));
}

/**
 * Identifies the state of a tree's contents: two files with the same token
 * hold the same data. It is built from the change log, which every edit, undo
 * and redo passes through. Null means the tree has never been changed.
 */
export function treeStateToken(db: Db): string | null {
  const last = db.prepare('SELECT id, at FROM change_tx ORDER BY id DESC LIMIT 1').get() as
    { id: number; at: number } | undefined;
  if (!last) return null;
  const undone = db.prepare('SELECT count(*) FROM change_tx WHERE undone = 1').pluck().get();
  // The time is part of the token because step numbers repeat when a restored
  // backup is edited: its step 6 is not the step 6 of the tree it replaced.
  return `${last.id}:${last.at}:${String(undone)}`;
}

/**
 * Checks that a file is a readable tree this app can open, and returns its
 * state token. Throws {@link BackupError} if it is not.
 */
export function verifyBackup(file: string): string | null {
  let db: Db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new BackupError(`the backup cannot be opened: ${(error as Error).message}`);
  }
  try {
    if (db.pragma('application_id', { simple: true }) !== TREE_APPLICATION_ID) {
      throw new BackupError('the file is not a RulZ Ancestry tree');
    }
    const version = schemaVersion(db);
    if (version > treeMigrations.length) {
      throw new BackupError('the backup was made by a newer version of the app');
    }
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new BackupError(`the backup is damaged: ${String(check)}`);
    return treeStateToken(db);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(`the backup cannot be read: ${(error as Error).message}`);
  } finally {
    db.close();
  }
}

/**
 * Chooses which backups to delete. Kept: the newest `policy.newest`, and of
 * the older ones the latest backup of each month, for the `policy.months` most
 * recent months that have one. Without the monthly copies, ten sessions after
 * a mistake every backup would already contain it.
 */
export function backupsToPrune(
  backups: readonly BackupInfo[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
): string[] {
  const sorted = [...backups].sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const months = new Set<string>();
  const prune: string[] = [];
  for (const backup of sorted.slice(policy.newest)) {
    const month = new Date(backup.at).toISOString().slice(0, 7);
    if (months.has(month) || months.size >= policy.months) {
      prune.push(backup.name);
    } else {
      months.add(month);
    }
  }
  return prune;
}

export interface BackupOptions {
  /** The time to stamp the backup with; defaults to now. */
  now?: number;
  /** Make a copy even when the newest backup already holds the same data. */
  force?: boolean;
  retention?: RetentionPolicy;
}

export interface BackupResult {
  /** The backup that was made, or null when none was needed. */
  created: BackupInfo | null;
  /** Names of old backups that were deleted. */
  pruned: string[];
}

/**
 * Backs up an open tree into its `backups` folder, then deletes old backups
 * according to the retention policy. Nothing is written when the tree has
 * never been changed, or when the newest backup already holds the same data
 * (unless `force` is set).
 */
export function backupTree(tree: Tree, options: BackupOptions = {}): BackupResult {
  if (tree.dir === null) throw new BackupError('a tree that is only in memory cannot be backed up');
  const folder = join(tree.dir, BACKUP_DIR_NAME);
  const token = treeStateToken(tree.db);
  const existing = listBackups(tree.dir);

  if (token === null) return { created: null, pruned: [] };
  if (!options.force && existing[0]) {
    let newestToken: string | null | undefined;
    try {
      newestToken = verifyBackup(join(folder, existing[0].name));
    } catch {
      // An unreadable newest backup is a reason to make a new one.
      newestToken = undefined;
    }
    if (newestToken === token) return { created: null, pruned: [] };
  }

  mkdirSync(folder, { recursive: true });
  const at = options.now ?? Date.now();
  let copy = 1;
  while (existsSync(join(folder, backupName(at, copy)))) copy += 1;
  const name = backupName(at, copy);
  const target = join(folder, name);
  const staging = `${target}.tmp`;

  rmSync(staging, { force: true });
  try {
    tree.db.prepare('VACUUM INTO ?').run(staging);
    if (verifyBackup(staging) !== token) {
      throw new BackupError('the copy does not match the tree it was made from');
    }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true });
    if (error instanceof BackupError) throw error;
    throw new BackupError(`the backup could not be written: ${(error as Error).message}`);
  }

  const created: BackupInfo = { name, at, size: statSync(target).size };
  const pruned = backupsToPrune([created, ...existing], options.retention);
  for (const old of pruned) rmSync(join(folder, old), { force: true });
  return { created, pruned };
}

/**
 * Replaces the tree in `dir` with one of its backups. The tree must be closed
 * first. The caller should back up the current tree before calling this, so
 * that the restore itself can be reversed.
 */
export function restoreBackup(dir: string, name: string): void {
  // The name comes from the user interface; it must be a plain backup file name.
  if (parseBackupName(name) === null) throw new BackupError(`not a backup file name: ${name}`);
  const source = join(dir, BACKUP_DIR_NAME, name);
  if (!existsSync(source)) throw new BackupError(`the backup no longer exists: ${name}`);
  verifyBackup(source);

  const target = join(dir, TREE_FILE_NAME);
  const staging = `${target}.restoring`;
  rmSync(staging, { force: true });
  copyFileSync(source, staging);
  // A write-ahead log left beside tree.db belongs to the file being replaced.
  // SQLite would apply it to the restored file and corrupt it.
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  renameSync(staging, target);
}
