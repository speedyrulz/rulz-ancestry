import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CENSUS_BUILDER_VERSION,
  CENSUS_COLUMNS,
  CENSUS_MAX_DISTRICTS,
  CENSUS_MAX_PAGES,
  NARA_CENSUS_PACK_KIND,
} from '@rulz/connectors';
import { PackReader } from '@rulz/db';
import { BuildStopped, PACK_KINDS, buildPack } from './packbuild';
import { CENSUS_FIXTURES, buildCensusPack } from './censusfixtures';

// The state, counties and folders are made up.
let dir: string;
const readers: PackReader[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rulz-census-build-'));
});

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function open(path: string): PackReader {
  const opened = PackReader.open(path);
  if (!opened.ok) throw new Error('the pack did not open');
  readers.push(opened.reader);
  return opened.reader;
}

const never = () => false;
const fixture = (name: string) => join(CENSUS_FIXTURES, name);

/** A state file with the given districts in one county. */
function stateFile(districts: unknown[], abbreviation = 'DE'): string {
  const path = join(dir, `state-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      state: 'Testland',
      abbreviation,
      baseurl: 'https://example.invalid/never-used/',
      'county/city': [{ name: 'Alder County', enumeration: districts }],
    }),
  );
  return path;
}

const district = (
  n: number,
  folder = `1950census/10-Testland/d${n}`,
  files: unknown = ['p-0001.jpg'],
) => ({
  ed: `1-${n}`,
  description: `District ${n} of the made-up county`,
  roll: 'T1',
  schedule_image: { folder, files },
});

describe('the census pack kind', () => {
  it('is known to the app, with its own host, size limit and builder version', () => {
    const kind = PACK_KINDS[NARA_CENSUS_PACK_KIND];
    expect(NARA_CENSUS_PACK_KIND).toBe('nara-1950-areas');
    expect(kind?.allowedHosts).toEqual(['nara-1950-census.s3.us-east-2.amazonaws.com']);
    expect(kind?.maxFileBytes).toBe(80 * 1024 * 1024);
    expect(kind?.builderVersion).toBe(CENSUS_BUILDER_VERSION);
  });
});

describe('building a pack from a state file', () => {
  it('makes a row of each district, with its meta', async () => {
    const path = await buildCensusPack(join(dir, 'packs'), { file: fixture('state-sample.json') });
    const reader = open(path);
    expect(reader.columns).toEqual([...CENSUS_COLUMNS]);
    expect(reader.meta).toMatchObject({
      packId: 'c50de',
      kind: 'nara-1950-areas',
      builderVersion: CENSUS_BUILDER_VERSION,
      title: '1950 census: Testland',
      licence: 'Public domain (US Government work)',
      credit: '1950 Census, National Archives and Records Administration',
      rows: 4,
      skipped: 0,
      downloadedAt: '2026-03-04',
      sourceModified: '2022-04-01',
    });
    expect(reader.get(1, [...CENSUS_COLUMNS], never)?.values).toEqual({
      state: 'Testland',
      abbreviation: 'DE',
      county: 'Alder County',
      ed: '1-1',
      description:
        'Ward 1: that part of the village of Tarnwick bounded by Mill Road, the creek and Oak Street. Includes the school.',
      reservation: '',
      roll: 'T628-12',
      description_image: '1950census/10-Testland/descriptions/10-Testland-0001.jpg',
      folder: '1950census/10-Testland/10-Testland-000101',
      files:
        '["10-Testland-000101-0001.jpg","10-Testland-000101-0002.jpg","10-Testland-000101-0003.jpg"]',
      maps: '["1950census/10-Testland/maps/10-Testland-01.jpg"]',
      pages: '3',
    });
    expect(reader.get(4, ['roll', 'pages'], never)?.values).toEqual({ roll: '14', pages: '2' });
  });

  it('searches the county and the description as places', async () => {
    const reader = open(
      await buildCensusPack(join(dir, 'packs'), { file: fixture('state-sample.json') }),
    );
    const ids = (places: string) =>
      reader
        .search({ names: '', places, limit: 10, offset: 0 }, never)
        .rows.map((row) => `${row['county']} ${row['ed']}`);
    expect(ids('tarnwick').sort()).toEqual(['Alder County 1-1', 'Alder County 1-2']);
    expect(ids('quillhaven').sort()).toEqual(['Birch County 2-1', 'Cedar City 3-1']);
    expect(ids('birch')).toEqual(['Birch County 2-1']);
  });

  it('makes one row for a territory, with no county and no district', async () => {
    const reader = open(
      await buildCensusPack(join(dir, 'packs'), {
        id: 'c50ti',
        file: fixture('territory-sample.json'),
      }),
    );
    expect(reader.meta.rows).toBe(1);
    expect(reader.get(1, ['state', 'county', 'ed', 'folder', 'pages'], never)?.values).toEqual({
      state: 'Testisle',
      county: '',
      ed: '',
      folder: '1950census/90-Testisle',
      pages: '3',
    });
  });

  it("never writes the file's own baseurl", async () => {
    const path = await buildCensusPack(join(dir, 'packs'), { file: fixture('state-sample.json') });
    const reader = open(path);
    for (let row = 1; row <= 4; row += 1) {
      expect(JSON.stringify(reader.get(row, [...CENSUS_COLUMNS], never))).not.toContain('invalid');
    }
  });

  it('leaves out and counts a district with a ".." path, a file that is not a jpg, or a list that is too long', async () => {
    const districts = Array.from({ length: 297 }, (_, i) => district(i + 1));
    districts.push(
      district(298, '1950census/../etc'),
      district(299, '1950census/a/b', ['p-0001.jpg', 'p-0002.png']),
      district(
        300,
        '1950census/a/c',
        Array.from({ length: CENSUS_MAX_PAGES + 1 }, (_, i) => `p-${i}.jpg`),
      ),
    );
    const path = await buildCensusPack(join(dir, 'packs'), { file: stateFile(districts) });
    const reader = open(path);
    expect(reader.meta.rows).toBe(297);
    expect(reader.meta.skipped).toBe(3);
    const bad = reader.list(
      { columns: ['ed'], where: { county: 'Alder County' }, limit: 100, offset: 290 },
      never,
    );
    expect(bad.rows.map((row) => row.values['ed'])).not.toContain('1-298');
    expect(bad.total).toBe(297);
  });

  it('fails when more than 1% of the districts are not as they must be, and leaves no pack', async () => {
    const districts = Array.from({ length: 98 }, (_, i) => district(i + 1));
    districts.push(district(99, '1950census/../a'), district(100, '1950census/../b'));
    const out = join(dir, 'packs', 'c50de.pack');
    await expect(
      buildCensusPack(join(dir, 'packs'), { file: stateFile(districts) }),
    ).rejects.toThrow(/2 of 100 districts/);
    // The file was refused before anything was written.
    expect(existsSync(out)).toBe(false);
  });

  it('fails for a file of another state than the pack is for, and for text that is not JSON', async () => {
    await expect(
      buildCensusPack(join(dir, 'packs'), {
        id: 'c50wy',
        file: fixture('state-sample.json'),
        code: 'wy',
      }),
    ).rejects.toThrow(/not the state/);
    const junk = join(dir, 'junk.json');
    writeFileSync(junk, 'not json at all');
    await expect(buildCensusPack(join(dir, 'packs2'), { file: junk })).rejects.toThrow(/not JSON/);
    await expect(buildCensusPack(join(dir, 'packs3'), { file: stateFile([]) })).rejects.toThrow(
      /no districts/,
    );
  });

  it('fails for a file with more districts than a state can have', async () => {
    const districts = Array.from({ length: CENSUS_MAX_DISTRICTS + 1 }, (_, i) => district(i + 1));
    await expect(
      buildCensusPack(join(dir, 'packs'), { file: stateFile(districts) }),
    ).rejects.toThrow(/more districts/);
  });

  it('takes one file only, and stops when it is told to', async () => {
    const input = {
      kind: NARA_CENSUS_PACK_KIND,
      outPath: join(dir, 'x.pack'),
      files: [] as {
        path: string;
        url: string;
        bytes: number;
        sha256: string;
        etag: null;
        modified: null;
      }[],
      meta: {
        packId: 'c50de',
        title: 't',
        sourceName: 's',
        sourceUrl: 'https://1950census.archives.gov',
        licence: 'l',
        credit: 'c',
        downloadedAt: '2026-03-04',
      },
      reserveBytes: 1,
    };
    await expect(buildPack(input, { stop: never, progress: () => undefined })).rejects.toThrow(
      /one file/,
    );
    const file = {
      path: fixture('state-sample.json'),
      url: 'https://x',
      bytes: 1,
      sha256: '0',
      etag: null,
      modified: null,
    };
    await expect(
      buildPack({ ...input, files: [file] }, { stop: () => true, progress: () => undefined }),
    ).rejects.toThrow(BuildStopped);
    expect(existsSync(input.outPath)).toBe(false);
  });
});
