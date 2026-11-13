import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
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
  'not_duplicate',
  'merged_record',
  'source',
  'citation',
  'citation_link',
  'media',
  'media_link',
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

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
}

/**
 * The bytes of a real PNG picture of the given size. A different `seed`
 * gives a different picture, and so a different file.
 */
export function pngBytes(width: number, height: number, seed = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // red, green, blue
  const row = 1 + width * 3;
  const pixels = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * row + 1 + x * 3;
      pixels[at] = (x + seed * 31) & 255;
      pixels[at + 1] = (y + seed * 7) & 255;
      pixels[at + 2] = (x ^ y) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Number of steps that can currently be undone. */
export function undoDepth(tree: Tree): number {
  return tree.db.prepare('SELECT count(*) FROM change_tx WHERE undone = 0').pluck().get() as number;
}

/**
 * Runs `fn` on a tree of an older schema version with the columns today's
 * code reads and that version lacked, and takes them away again. The tests of
 * a migration use it to edit a tree as an older build did, before upgrading it.
 */
export function withLaterColumns(tree: Tree, fn: () => void): void {
  const tables = ['person', 'event', 'source'].filter(
    (table) =>
      tree.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table) !== undefined &&
      tree.db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'note'`).get() ===
        undefined,
  );
  for (const table of tables) {
    tree.db.exec(`ALTER TABLE ${table} ADD COLUMN note TEXT NOT NULL DEFAULT ''`);
  }
  try {
    fn();
  } finally {
    for (const table of tables) tree.db.exec(`ALTER TABLE ${table} DROP COLUMN note`);
  }
}
