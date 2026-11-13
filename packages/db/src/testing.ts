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
  'place',
] as const;

/**
 * The complete contents of the tree and its search index as text, so two
 * states can be compared exactly. The change log itself is left out.
 */
export function snapshot(tree: Tree): string {
  // A tree of an older schema version lacks the tables that came later.
  const present = new Set(
    (
      tree.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const tables = Object.fromEntries(
    TREE_TABLES.filter((table) => present.has(table)).map((table) => [
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

/** One line of a GeoNames list of places: nineteen columns with tabs between them. */
export function geonameLine(fields: {
  id: number;
  name: string;
  ascii?: string;
  alternates?: string[];
  lat?: number;
  lon?: number;
  fclass?: string;
  fcode?: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  population?: number;
}): string {
  return [
    fields.id,
    fields.name,
    fields.ascii ?? fields.name,
    (fields.alternates ?? []).join(','),
    fields.lat ?? 40,
    fields.lon ?? -90,
    fields.fclass ?? 'P',
    fields.fcode ?? 'PPL',
    fields.country ?? 'US',
    '',
    fields.admin1 ?? '',
    fields.admin2 ?? '',
    '',
    '',
    fields.population ?? 0,
    '',
    '',
    'America/Chicago',
    '2024-01-01',
  ].join('\t');
}

/** A few lines of each list GeoNames publishes, enough to build a gazetteer in a test. */
export const GEONAMES_SAMPLE = {
  countryInfo: [
    '# ISO\tISO3\tISO-Numeric\tfips\tCountry\tCapital',
    'US\tUSA\t840\tUS\tUnited States\tWashington',
    'GB\tGBR\t826\tUK\tUnited Kingdom\tLondon',
    'NL\tNLD\t528\tNL\tThe Netherlands\tAmsterdam',
    'FR\tFRA\t250\tFR\tFrance\tParis',
    'IN\tIND\t356\tIN\tIndia\tNew Delhi',
    '',
  ].join('\n'),
  admin1: [
    'US.IL\tIllinois\tIllinois\t4896861',
    'US.MO\tMissouri\tMissouri\t4398678',
    'US.IA\tIowa\tIowa\t4862182',
    'GB.ENG\tEngland\tEngland\t6269131',
    'NL.07\tNorth Holland\tNorth Holland\t2749879',
    'FR.11\t\u00cele-de-France\tIle-de-France\t3012874',
    'IN.16\tMaharashtra\tMaharashtra\t1264418',
    '',
  ].join('\n'),
  admin2: [
    'US.IL.167\tSangamon County\tSangamon County\t4250165',
    'US.MO.077\tGreene County\tGreene County\t4388802',
    'US.IA.169\tStory County\tStory County\t4877725',
    'GB.ENG.Q5\tYork\tYork\t3333216',
    'NL.07.0363\tGemeente Amsterdam\tGemeente Amsterdam\t2759793',
    '',
  ].join('\n'),
  /** The places of the United States, as in GeoNames' `US.zip`. */
  US: [
    geonameLine({
      id: 4250542,
      name: 'Springfield',
      fcode: 'PPLA',
      admin1: 'IL',
      admin2: '167',
      lat: 39.80172,
      lon: -89.64371,
      population: 114394,
    }),
    geonameLine({
      id: 4409896,
      name: 'Springfield',
      fcode: 'PPLA2',
      admin1: 'MO',
      admin2: '077',
      lat: 37.21533,
      lon: -93.29824,
      population: 170188,
    }),
    geonameLine({
      id: 4250165,
      name: 'Sangamon County',
      fclass: 'A',
      fcode: 'ADM2',
      admin1: 'IL',
      admin2: '167',
      lat: 39.75817,
      lon: -89.65889,
      population: 194672,
    }),
    geonameLine({
      id: 4896861,
      name: 'Illinois',
      fclass: 'A',
      fcode: 'ADM1',
      admin1: 'IL',
      lat: 40.00032,
      lon: -89.25037,
      population: 12710158,
      alternates: ['IL', 'State of Illinois'],
    }),
    geonameLine({
      id: 4250552,
      name: 'Township of Springfield',
      fclass: 'A',
      fcode: 'ADM3',
      admin1: 'IL',
      admin2: '167',
      lat: 39.81,
      lon: -89.6,
    }),
    geonameLine({
      id: 4846834,
      name: 'Ames',
      admin1: 'IA',
      admin2: '169',
      lat: 42.03471,
      lon: -93.61994,
      population: 66427,
    }),
    geonameLine({
      id: 4250999,
      name: 'Spring Creek',
      fclass: 'H',
      fcode: 'STM',
      admin1: 'IL',
      admin2: '167',
    }),
    'this line is not a place',
    geonameLine({ id: 4251000, name: 'Nowhere', lat: 500, lon: 0 }),
    '',
  ].join('\n'),
  /** The places of the Netherlands, as in `NL.zip`. */
  NL: [
    geonameLine({
      id: 2759794,
      name: 'Amsterdam',
      fcode: 'PPLC',
      country: 'NL',
      admin1: '07',
      admin2: '0363',
      lat: 52.37403,
      lon: 4.88969,
      population: 741636,
      alternates: [
        'Amsterdam',
        'Amsterd\u00e3o',
        'Mokum',
        '\u0410\u043c\u0441\u0442\u0435\u0440\u0434\u0430\u043c',
      ],
    }),
    geonameLine({
      id: 2759793,
      name: 'Gemeente Amsterdam',
      fclass: 'A',
      fcode: 'ADM2',
      country: 'NL',
      admin1: '07',
      admin2: '0363',
      lat: 52.37,
      lon: 4.89,
      population: 854047,
    }),
    '',
  ].join('\n'),
  /** Towns of the whole world, as in `cities500.zip`. Two of them are in the lists above too. */
  cities500: [
    geonameLine({
      id: 4250542,
      name: 'Springfield (from the world list)',
      fcode: 'PPLA',
      admin1: 'IL',
      admin2: '167',
      population: 1,
    }),
    geonameLine({
      id: 2759794,
      name: 'Amsterdam',
      fcode: 'PPLC',
      country: 'NL',
      admin1: '07',
      admin2: '0363',
      population: 741636,
    }),
    geonameLine({
      id: 2633352,
      name: 'York',
      fcode: 'PPLA2',
      country: 'GB',
      admin1: 'ENG',
      admin2: 'Q5',
      lat: 53.95763,
      lon: -1.08271,
      population: 156135,
    }),
    geonameLine({
      id: 2988507,
      name: 'Paris',
      fcode: 'PPLC',
      country: 'FR',
      admin1: '11',
      lat: 48.85341,
      lon: 2.3488,
      population: 2138551,
    }),
    geonameLine({
      id: 1275339,
      name: 'Mumbai',
      fcode: 'PPLA',
      country: 'IN',
      admin1: '16',
      lat: 19.07283,
      lon: 72.88261,
      population: 12691836,
      alternates: ['Bombay', 'Mumbai'],
    }),
    '',
  ].join('\n'),
} as const;

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
  const later: readonly (readonly [table: string, column: string, type: string])[] = [
    ['person', 'note', "TEXT NOT NULL DEFAULT ''"],
    ['event', 'note', "TEXT NOT NULL DEFAULT ''"],
    ['source', 'note', "TEXT NOT NULL DEFAULT ''"],
    ['source', 'connector_id', 'TEXT'],
    ['citation', 'url', "TEXT NOT NULL DEFAULT ''"],
    ['citation', 'accessed_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  const added = later.filter(
    ([table, column]) =>
      tree.db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table) !== undefined &&
      tree.db
        .prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = '${column}'`)
        .get() === undefined,
  );
  for (const [table, column, type] of added) {
    tree.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  try {
    fn();
  } finally {
    for (const [table, column] of added) {
      tree.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
}
