import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { newId } from '@rulz/core';
import { beginRecording, endRecording, redo, undo, undoStatus, type ChangeTx } from './changelog';
import { openDatabase, sql, type Db } from './connection';
import { migrate, schemaVersion } from './migrate';
import { treeMigrations } from './schema';

/**
 * SQLite's `application_id` for tree files: the ASCII bytes "RulZ". It lets the
 * app refuse a SQLite file that belongs to some other program.
 */
export const TREE_APPLICATION_ID = 0x52756c5a;

/** The database file inside a tree folder. */
export const TREE_FILE_NAME = 'tree.db';

/** The file is a SQLite database, but not one this app created. */
export class NotATreeError extends Error {
  constructor(file: string) {
    super(`not a RulZ Ancestry tree: ${file}`);
    this.name = 'NotATreeError';
  }
}

/** A record the caller named does not exist. */
export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

/** The caller asked for something the tree's rules do not allow. */
export class TreeRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeRuleError';
  }
}

export interface TreeInfo {
  /** Stable id of the tree, kept when the folder is moved or renamed. */
  id: string;
  name: string;
  createdAt: number;
  schemaVersion: number;
  persons: number;
  families: number;
  events: number;
}

/** An open family tree. */
export class Tree {
  readonly db: Db;
  /** The tree's folder, or null for a tree that only exists in memory. */
  readonly dir: string | null;
  #writing = false;

  constructor(db: Db, dir: string | null) {
    this.db = db;
    this.dir = dir;
  }

  /**
   * Runs `fn` as one change: it is saved completely or not at all, and it
   * becomes a single undo step named `label`. Every function in this package
   * that changes the tree uses this, and calls made inside `fn` join the same
   * step, so wrap several of them to make one step out of a larger edit.
   *
   * `fn` must be synchronous; SQLite transactions cannot span an `await`.
   */
  transact<T>(label: string, fn: () => T): T {
    if (this.#writing) return fn();
    return this.db
      .transaction(() => {
        const txId = beginRecording(this.db, label);
        this.#writing = true;
        try {
          const result = fn();
          endRecording(this.db, txId);
          return result;
        } finally {
          this.#writing = false;
        }
      })
      .immediate();
  }

  /** Reverses the latest change. Returns it, or null when there is nothing to undo. */
  undo(): ChangeTx | null {
    this.#assertNotWriting('undo');
    return undo(this.db);
  }

  /** Repeats the latest undone change. Returns it, or null when there is nothing to redo. */
  redo(): ChangeTx | null {
    this.#assertNotWriting('redo');
    return redo(this.db);
  }

  /** The change that undo would reverse and the change that redo would repeat. */
  undoStatus(): { undo: ChangeTx | null; redo: ChangeTx | null } {
    return undoStatus(this.db);
  }

  info(): TreeInfo {
    const meta = new Map(
      (
        sql(this.db, 'SELECT key, value FROM tree_meta').all() as { key: string; value: string }[]
      ).map((row) => [row.key, row.value]),
    );
    const count = (table: string) =>
      sql(this.db, `SELECT count(*) FROM ${table}`).pluck().get() as number;
    return {
      id: meta.get('id') ?? '',
      name: meta.get('name') ?? '',
      createdAt: Number(meta.get('created_at') ?? 0),
      schemaVersion: schemaVersion(this.db),
      persons: count('person'),
      families: count('family'),
      events: count('event'),
    };
  }

  close(): void {
    this.db.close();
  }

  #assertNotWriting(action: string): void {
    if (this.#writing) throw new TreeRuleError(`cannot ${action} while a change is being made`);
  }
}

export interface OpenTreeOptions {
  /** Name given to a tree that is being created. Defaults to the folder name. */
  name?: string;
}

/**
 * Opens the tree in a folder, creating the folder and an empty tree if there
 * is none, and updates an older tree to the current schema. Pass ':memory:'
 * for a tree that is discarded when closed.
 */
export function openTree(location: string, options: OpenTreeOptions = {}): Tree {
  const inMemory = location === ':memory:';
  if (!inMemory) mkdirSync(location, { recursive: true });
  const file = inMemory ? location : join(location, TREE_FILE_NAME);
  const db = openDatabase(file);

  try {
    const applicationId = db.pragma('application_id', { simple: true }) as number;
    const objects = db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get() as number;
    const isNew = objects === 0 && schemaVersion(db) === 0 && applicationId === 0;
    if (isNew) {
      db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
    } else if (applicationId !== TREE_APPLICATION_ID) {
      throw new NotATreeError(file);
    }

    migrate(db, treeMigrations);

    const setMeta = sql(db, 'INSERT OR IGNORE INTO tree_meta (key, value) VALUES (?, ?)');
    const defaultName = inMemory ? 'Family tree' : basename(location);
    db.transaction(() => {
      setMeta.run('id', newId());
      setMeta.run('name', options.name ?? defaultName);
      setMeta.run('created_at', String(Date.now()));
    })();
  } catch (error) {
    db.close();
    throw error;
  }

  return new Tree(db, inMemory ? null : location);
}
