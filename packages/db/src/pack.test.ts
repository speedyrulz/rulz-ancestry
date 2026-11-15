import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  PACK_APPLICATION_ID,
  PACK_FORMAT_VERSION,
  PackReader,
  PackSearchStopped,
  PackWriter,
  type PackMeta,
} from './pack';
import { cleanUpAfterEach, tempDir } from './testing';

cleanUpAfterEach();

const COLUMNS = ['KIND', 'GIVEN', 'SURNAME', 'PLACE', 'NOTE'] as const;
const FTS = { names: ['GIVEN', 'SURNAME'], places: ['PLACE'] };

const META: Omit<PackMeta, 'rows' | 'builtAt'> = {
  packId: 'tst',
  kind: 'open-archives',
  builderVersion: 1,
  title: 'Test pack',
  sourceName: 'A test source',
  sourceUrl: 'https://example.org/',
  licence: 'CC0',
  credit: 'Made up for a test',
  files: [
    { url: 'https://example.org/a.csv.gz', bytes: 10, sha256: 'ab', etag: null, modified: null },
  ],
  downloadedAt: '2026-11-15',
};

const row = (
  year: number | null,
  given: string,
  surname: string,
  place: string,
  note = '',
): { year: number | null; values: string[] } => ({
  year,
  values: ['Marriage', given, surname, place, note],
});

const SAMPLE = [
  row(1851, 'Jan', 'de Vries', 'Ashvale'),
  row(1880, 'José', 'Gómez', 'Amsterdam'),
  row(1880, 'Zoë', 'Müller', 'Dunmere'),
  row(1900, 'Tobias', 'Baker', 'Dunmere'),
  row(null, 'Ilse', 'Vries', 'Ames'),
];

function build(rows = SAMPLE): { path: string; meta: PackMeta } {
  const path = join(tempDir(), 'tst.pack');
  const writer = PackWriter.create(path, COLUMNS, FTS);
  writer.add(rows);
  return { path, meta: writer.finish(META) };
}

function reader(path: string): PackReader {
  const opened = PackReader.open(path);
  if (!opened.ok) throw new Error(`could not open: ${opened.reason}`);
  return opened.reader;
}

const never = () => false;
const ask = (r: PackReader, names: string, extra: { places?: string } = {}) =>
  r.search({ names, limit: 50, offset: 0, ...extra }, never);
const givens = (rows: Record<string, string>[]) => rows.map((r) => r['GIVEN']);

describe('PackWriter and PackReader', () => {
  it('writes a pack and reads it back, with its meta and columns', () => {
    const { path, meta } = build();
    expect(meta.rows).toBe(5);
    expect(Number.isNaN(Date.parse(meta.builtAt))).toBe(false);
    const db = new Database(path, { readonly: true });
    expect(db.pragma('application_id', { simple: true })).toBe(PACK_APPLICATION_ID);
    expect(db.pragma('user_version', { simple: true })).toBe(PACK_FORMAT_VERSION);
    db.close();
    const r = reader(path);
    expect(r.meta).toEqual(meta);
    expect(r.columns).toEqual([...COLUMNS]);
    r.close();
  });

  it('finds names with case and accents folded, and words in any order', () => {
    const r = reader(build().path);
    expect(givens(ask(r, 'zoe muller').rows)).toEqual(['Zoë']);
    expect(givens(ask(r, 'GOMEZ jose').rows)).toEqual(['José']);
    expect(givens(ask(r, 'vries').rows).sort()).toEqual(['Ilse', 'Jan']);
    expect(ask(r, 'Zoë').rows[0]).toEqual({
      KIND: 'Marriage',
      GIVEN: 'Zoë',
      SURNAME: 'Müller',
      PLACE: 'Dunmere',
      NOTE: '',
    });
    r.close();
  });

  it('takes a prefix on the last word only, and only from two characters', () => {
    const r = reader(build().path);
    expect(givens(ask(r, 'tob').rows)).toEqual(['Tobias']);
    expect(ask(r, 'tob baker').total).toBe(0);
    expect(ask(r, 'baker t').total).toBe(0);
    expect(ask(r, 'baker to').total).toBe(1);
    r.close();
  });

  it('treats operators in a query as plain words', () => {
    const r = reader(build().path);
    expect(ask(r, 'baker OR "vries').total).toBe(0);
    expect(ask(r, 'NEAR(jan vries) *').total).toBe(0);
    expect(ask(r, '').total).toBe(0);
    expect(ask(r, '---').rows).toEqual([]);
    r.close();
  });

  it('narrows by places and by years', () => {
    const r = reader(build().path);
    expect(givens(ask(r, 'baker', { places: 'dunmere' }).rows)).toEqual(['Tobias']);
    expect(ask(r, 'baker', { places: 'amster' }).total).toBe(0);
    expect(givens(ask(r, '', { places: 'dunmere' }).rows).sort()).toEqual(['Tobias', 'Zoë']);
    const years = (from: number, to: number) =>
      r.search({ names: 'vries', limit: 50, offset: 0, years: { from, to } }, never);
    expect(givens(years(1850, 1860).rows)).toEqual(['Jan']);
    // a row with no year is left out of a search by years
    expect(years(1, 9999).total).toBe(1);
    r.close();
  });

  it('orders by rank, then year, then the order the rows were added', () => {
    const rows = [
      row(1900, 'Piet', 'Smit', 'Dunmere', 'c'),
      row(1850, 'Piet', 'Smit', 'Dunmere', 'b'),
      row(1850, 'Piet', 'Smit', 'Dunmere', 'a'),
    ];
    const r = reader(build(rows).path);
    expect(ask(r, 'piet smit').rows.map((x) => x['NOTE'])).toEqual(['b', 'a', 'c']);
    r.close();
  });

  it('pages, caps a page at 50 and the total at 1000', () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      row(1800 + (i % 100), 'Piet', 'Smit', 'Dunmere', String(i)),
    );
    const r = reader(build(rows).path);
    const first = r.search({ names: 'smit', limit: 500, offset: 0 }, never);
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(1000);
    const second = r.search({ names: 'smit', limit: 50, offset: 50 }, never);
    expect(second.rows).toHaveLength(50);
    expect(second.rows[0]).not.toEqual(first.rows[0]);
    expect(r.search({ names: 'smit', limit: 0, offset: -5 }, never).rows).toHaveLength(1);
    r.close();
  });

  it('throws at once when stop() is true, and when it turns true during a search', () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row(1800, 'Piet', 'Smit', 'Dunmere', String(i)),
    );
    const r = reader(build(rows).path);
    expect(() => r.search({ names: 'smit', limit: 10, offset: 0 }, () => true)).toThrow(
      PackSearchStopped,
    );
    let calls = 0;
    expect(() => r.search({ names: 'smit', limit: 10, offset: 0 }, () => ++calls > 3)).toThrow(
      PackSearchStopped,
    );
    // far fewer than the 200 rows were looked at
    expect(calls).toBeLessThan(20);
    // the reader still works afterwards
    expect(r.search({ names: 'smit', limit: 10, offset: 0 }, never).rows).toHaveLength(10);
    r.close();
  });

  it('leaves no -wal, -shm or journal file after building or reading', () => {
    const { path } = build();
    const dir = join(path, '..');
    expect(readdirSync(dir)).toEqual(['tst.pack']);
    const r = reader(path);
    ask(r, 'vries');
    expect(readdirSync(dir)).toEqual(['tst.pack']);
    r.close();
    expect(readdirSync(dir)).toEqual(['tst.pack']);
  });

  it('refuses a file that exists, rows of the wrong width, and columns that cannot be used', () => {
    const { path } = build();
    expect(() => PackWriter.create(path, COLUMNS, FTS)).toThrow(/exists/);
    const fresh = join(tempDir(), 'x.pack');
    expect(() => PackWriter.create(fresh, ['A', 'A'], { names: [], places: [] })).toThrow(/differ/);
    expect(() => PackWriter.create(fresh, ['A'], { names: ['B'], places: [] })).toThrow(/not one/);
    expect(existsSync(fresh)).toBe(false);
    const writer = PackWriter.create(fresh, ['A', 'B'], { names: ['A'], places: [] });
    expect(() => writer.add([{ year: null, values: ['only one'] }])).toThrow(/2 columns/);
    writer.abandon();
    expect(PackReader.open(fresh)).toEqual({ ok: false, reason: 'not-a-pack' });
  });
});

describe('PackReader.open', () => {
  it('refuses a file that is not a pack', () => {
    const dir = tempDir();
    const text = join(dir, 'text.pack');
    writeFileSync(
      text,
      'this is not a database, and it is long enough to have a header '.repeat(10),
    );
    expect(PackReader.open(text)).toEqual({ ok: false, reason: 'not-a-pack' });
    const other = join(dir, 'other.pack');
    const db = new Database(other);
    db.exec('CREATE TABLE t (a)');
    db.pragma('application_id = 12345');
    db.close();
    expect(PackReader.open(other)).toEqual({ ok: false, reason: 'not-a-pack' });
    const empty = join(dir, 'empty.pack');
    writeFileSync(empty, '');
    expect(PackReader.open(empty)).toEqual({ ok: false, reason: 'not-a-pack' });
  });

  it('refuses a missing file', () => {
    expect(PackReader.open(join(tempDir(), 'none.pack'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('refuses a pack of a newer format, and one without its description', () => {
    const { path } = build();
    const db = new Database(path);
    db.pragma(`user_version = ${PACK_FORMAT_VERSION + 1}`);
    db.close();
    expect(PackReader.open(path)).toEqual({ ok: false, reason: 'newer-format' });

    const { path: second } = build();
    const edit = new Database(second);
    edit.exec('DELETE FROM meta');
    edit.close();
    expect(PackReader.open(second)).toEqual({ ok: false, reason: 'not-a-pack' });

    const { path: third } = build();
    const broken = new Database(third);
    broken.exec(`UPDATE meta SET value = '{"packId":"../x"}'`);
    broken.close();
    expect(PackReader.open(third)).toEqual({ ok: false, reason: 'unreadable' });
  });
});
