import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTree, type Tree } from './tree';

/** Helpers shared by this package's unit tests. Not part of the public API. */

const openTrees: Tree[] = [];
const tempDirs: string[] = [];

/** Closes every tree and removes every folder a test created. Call once per test file. */
export function cleanUpAfterEach(): void {
  afterEach(() => {
    for (const tree of openTrees.splice(0)) {
      if (tree.db.open) tree.close();
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
}

export function track(tree: Tree): Tree {
  openTrees.push(tree);
  return tree;
}

export function memoryTree(): Tree {
  return track(openTree(':memory:'));
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rulz-tree-'));
  tempDirs.push(dir);
  return dir;
}

const TREE_TABLES = [
  'person',
  'person_name',
  'family',
  'family_child',
  'event',
  'event_participant',
] as const;

/**
 * The complete contents of the tree and its search index as text, so two
 * states can be compared exactly. The change log itself is left out.
 */
export function snapshot(tree: Tree): string {
  const tables = Object.fromEntries(
    TREE_TABLES.map((table) => [
      table,
      tree.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ]),
  );
  const search = tree.db
    .prepare(
      `SELECT doc.entity_type, doc.entity_id, doc.person_id, fts.text
       FROM search_doc doc JOIN search_fts fts ON fts.rowid = doc.id
       ORDER BY doc.entity_type, doc.entity_id`,
    )
    .all();
  const orphanDocs = tree.db
    .prepare(
      `SELECT count(*) FROM search_doc
       WHERE id NOT IN (SELECT rowid FROM search_fts)`,
    )
    .pluck()
    .get();
  return JSON.stringify({ tables, search, orphanDocs }, null, 1);
}

/** Number of steps that can currently be undone. */
export function undoDepth(tree: Tree): number {
  return tree.db.prepare('SELECT count(*) FROM change_tx WHERE undone = 0').pluck().get() as number;
}
