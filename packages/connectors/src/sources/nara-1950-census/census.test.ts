import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import {
  CENSUS_BUCKET,
  CENSUS_CODES,
  CENSUS_HOST,
  CENSUS_LISTING_URL,
  CENSUS_MAX_COUNTIES,
  CENSUS_MAX_DISTRICTS,
  CENSUS_MAX_PAGES,
  censusCitationPage,
  censusDistrictUrl,
  censusImageUrl,
  censusSkipAcceptable,
  censusStateUrl,
  isCensusFile,
  isCensusPath,
  parseCensusListing,
  parseCensusState,
} from './census';

// The state, counties, descriptions and folders in the fixtures are made up.
const FIXTURES = join(import.meta.dirname, 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const state = (): Record<string, unknown> =>
  JSON.parse(read('state-sample.json')) as Record<string, unknown>;

/** A district with the given folder and files. */
const district = (ed: string, folder: string, files: unknown) => ({
  ed,
  description: `District ${ed}`,
  roll: 'T1',
  schedule_image: { folder, files },
});

describe('addresses', () => {
  it('names the bucket, its listing and a state file', () => {
    expect(CENSUS_HOST).toBe('nara-1950-census.s3.us-east-2.amazonaws.com');
    expect(CENSUS_BUCKET).toBe('https://nara-1950-census.s3.us-east-2.amazonaws.com/');
    expect(CENSUS_LISTING_URL).toBe(
      'https://nara-1950-census.s3.us-east-2.amazonaws.com/?list-type=2&prefix=metadata/json/',
    );
    expect(censusStateUrl('de')).toBe(
      'https://nara-1950-census.s3.us-east-2.amazonaws.com/metadata/json/de.json',
    );
  });

  it('knows 60 codes: 50 states, the District of Columbia and nine territories', () => {
    const codes = Object.keys(CENSUS_CODES);
    expect(codes).toHaveLength(60);
    expect(codes.every((code) => /^[a-z]{2}$/.test(code))).toBe(true);
    expect(CENSUS_CODES['dc']).toBe('District of Columbia');
    expect(
      ['as', 'cn', 'gu', 'jn', 'mw', 'pc', 'pr', 'vi', 'wk'].map((c) => CENSUS_CODES[c]),
    ).toEqual([
      'American Samoa',
      'Canal Zone',
      'Guam',
      'Johnston Island',
      'Midway Islands',
      'Pacific Islands (Trust Territory)',
      'Puerto Rico',
      'Virgin Islands',
      'Wake Island',
    ]);
    expect(new Set(Object.values(CENSUS_CODES)).size).toBe(60);
  });

  it('builds the address of a page image from the bucket, one segment at a time', () => {
    expect(
      censusImageUrl('1950census/10-Testland/10-Testland-000101', '10-Testland-000101-0002.jpg'),
    ).toBe(
      'https://nara-1950-census.s3.us-east-2.amazonaws.com/1950census/10-Testland/10-Testland-000101/10-Testland-000101-0002.jpg',
    );
    // A space in a folder name is encoded, not sent as it is.
    expect(censusImageUrl('1950census/10 Test land/ed 1', 'p-0001.jpg')).toBe(
      'https://nara-1950-census.s3.us-east-2.amazonaws.com/1950census/10%20Test%20land/ed%201/p-0001.jpg',
    );
  });

  it('gives no address for a folder or file that is not as the bucket names them', () => {
    for (const folder of [
      '../etc',
      'a/../b',
      '/abs',
      'a//b',
      'a/./b',
      'a?b',
      'a#b',
      'a%2e%2e/b',
      '',
    ]) {
      expect(censusImageUrl(folder, 'p-0001.jpg')).toBeNull();
    }
    for (const file of [
      'p.png',
      'p.JPG',
      '../p.jpg',
      'a/p.jpg',
      'p.jpg.exe',
      '.jpg',
      'p 1.jpg',
      '',
    ]) {
      expect(censusImageUrl('1950census/x', file)).toBeNull();
    }
    expect(censusImageUrl(1, 2)).toBeNull();
  });

  it("gives a district's address at the Archives' site, keys in sorted order, values encoded", () => {
    expect(censusDistrictUrl({ abbreviation: 'DE', county: 'Alder County', ed: '1-1' })).toBe(
      'https://1950census.archives.gov/search/?county=Alder%20County&ed=1-1&state=DE',
    );
    expect(censusDistrictUrl({ abbreviation: 'DE', county: 'A&B=C', ed: '1/2' })).toBe(
      'https://1950census.archives.gov/search/?county=A%26B%3DC&ed=1%2F2&state=DE',
    );
    // A territory names its state only.
    expect(censusDistrictUrl({ abbreviation: 'TI', county: '', ed: '' })).toBe(
      'https://1950census.archives.gov/search/?state=TI',
    );
    expect(censusDistrictUrl({ abbreviation: 'de', county: 'x', ed: '1' })).toBeNull();
  });

  it('words the page of a citation, leaving out county, district and an empty roll', () => {
    const row = { state: 'Testland', county: 'Alder County', ed: '1-1', roll: 'T628-12' };
    expect(censusCitationPage(row, 2, 3, 2000)).toBe(
      'Testland, Alder County, ED 1-1, image 2 of 3, roll T628-12',
    );
    expect(
      censusCitationPage({ state: 'Testisle', county: '', ed: '', roll: '' }, 1, 3, 2000),
    ).toBe('Testisle, image 1 of 3');
    expect(censusCitationPage(row, 1, 1, 20).length).toBeLessThanOrEqual(20);
  });
});

describe('paths and files', () => {
  it('accepts the bucket-shaped ones and nothing else', () => {
    expect(isCensusPath('1950census/10-Testland/10-Testland-000101')).toBe(true);
    expect(isCensusPath('a b/c.d_e')).toBe(true);
    expect(isCensusPath('a/..')).toBe(false);
    expect(isCensusPath('x'.repeat(301))).toBe(false);
    expect(isCensusPath('a\\b')).toBe(false);
    expect(isCensusPath('a/b\n')).toBe(false);
    expect(isCensusFile('10-Testland-000101-0001.jpg')).toBe(true);
    expect(isCensusFile('x'.repeat(120) + '.jpg')).toBe(true);
    expect(isCensusFile('x'.repeat(121) + '.jpg')).toBe(false);
    expect(isCensusFile('page.tif')).toBe(false);
  });
});

describe('parseCensusListing', () => {
  it('keeps the state files of codes the app has a name for, sorted by name', () => {
    const listed = parseCensusListing(read('listing.sample.xml'));
    expect(listed).toEqual([
      {
        code: 'de',
        bytes: 4_800_000,
        modified: '2022-04-01',
        etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      },
      {
        code: 'gu',
        bytes: 4096,
        modified: '2022-04-01',
        etag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
      },
      {
        code: 'wy',
        bytes: 2_200_000,
        modified: '2022-04-01',
        etag: '"0123456789abcdef0123456789abcdef-3"',
      },
    ]);
  });

  it('leaves out an unknown code, another key, an empty folder key and an entry without a day', () => {
    const codes = parseCensusListing(read('listing.sample.xml')).map((entry) => entry.code);
    expect(codes).not.toContain('zz');
    expect(codes).not.toContain('xx');
    expect(codes).toHaveLength(3);
  });

  it('refuses a text that is no listing and a listing without a state file', () => {
    expect(() => parseCensusListing('<html>nope</html>')).toThrow(ConnectorError);
    expect(() =>
      parseCensusListing('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'),
    ).toThrow(ConnectorError);
  });
});

describe('parseCensusState', () => {
  it('makes a row of each district, with its county, description, roll and pages', () => {
    const parsed = parseCensusState(state());
    expect(parsed).toMatchObject({
      state: 'Testland',
      abbreviation: 'DE',
      districts: 4,
      skippedDistricts: 0,
      skippedImages: 0,
    });
    expect(parsed.rows.map((row) => [row.county, row.ed, row.files.length, row.roll])).toEqual([
      ['Alder County', '1-1', 3, 'T628-12'],
      ['Alder County', '1-2', 2, 'T628-12'],
      ['Birch County', '2-1', 1, 'T628-13'],
      // A roll given as a number is kept as its digits.
      ['Cedar City', '3-1', 2, '14'],
    ]);
    const first = parsed.rows[0];
    expect(first?.folder).toBe('1950census/10-Testland/10-Testland-000101');
    expect(first?.maps).toEqual(['1950census/10-Testland/maps/10-Testland-01.jpg']);
    expect(first?.descriptionImage).toBe(
      '1950census/10-Testland/descriptions/10-Testland-0001.jpg',
    );
    // The description is cleaned: line breaks become spaces.
    expect(first?.description).toBe(
      'Ward 1: that part of the village of Tarnwick bounded by Mill Road, the creek and Oak Street. Includes the school.',
    );
    expect(parsed.rows[2]?.reservation).toBe('Sample Reservation');
  });

  it("ignores the file's own baseurl", () => {
    const parsed = parseCensusState(state());
    expect(JSON.stringify(parsed)).not.toContain('example.invalid');
  });

  it('makes one row for a territory, which has no counties', () => {
    const parsed = parseCensusState(JSON.parse(read('territory-sample.json')));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      state: 'Testisle',
      abbreviation: 'TI',
      county: '',
      ed: '',
      folder: '1950census/90-Testisle',
    });
    expect(parsed.rows[0]?.files).toHaveLength(3);
  });

  it('leaves out and counts a district with a bad folder, file or list', () => {
    const file = state();
    file['county/city'] = [
      {
        name: 'Test County',
        enumeration: [
          district('1', '1950census/a/ok', ['ok-0001.jpg']),
          district('2', '1950census/../etc', ['x-0001.jpg']),
          district('3', '1950census/a/b', ['x-0001.jpg', 'x-0002.png']),
          district('4', '1950census/a/c', ['../x-0001.jpg']),
          district('5', '1950census/a/d', []),
          district('6', '1950census/a/e', 'not a list'),
          district(
            '7',
            '1950census/a/f',
            Array.from({ length: CENSUS_MAX_PAGES + 1 }, (_, i) => `f-${i}.jpg`),
          ),
          district(
            '8',
            '1950census/a/g',
            Array.from({ length: CENSUS_MAX_PAGES }, (_, i) => `g-${i}.jpg`),
          ),
          { ed: '9', description: 'no images' },
          'not an object',
          { ...district('', '1950census/a/h', ['h-0001.jpg']) },
        ],
      },
      { name: '', enumeration: [district('10', '1950census/a/i', ['i-0001.jpg'])] },
      { name: 'Broken County' },
    ];
    const parsed = parseCensusState(file);
    expect(parsed.rows.map((row) => row.ed)).toEqual(['1', '8']);
    expect(parsed.districts).toBe(13);
    expect(parsed.skippedDistricts).toBe(11);
    expect(parsed.rows[1]?.files).toHaveLength(CENSUS_MAX_PAGES);
  });

  it('leaves out and counts a bad map or description image, and keeps the district', () => {
    const file = state();
    file['county/city'] = [
      {
        name: 'Test County',
        enumeration: [
          {
            ...district('1', '1950census/a/ok', ['ok-0001.jpg']),
            map_image: ['maps/ok.jpg', '../maps/bad.jpg', { not: 'a path' }],
            description_image: '../bad.jpg',
          },
        ],
      },
    ];
    const parsed = parseCensusState(file);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.maps).toEqual(['maps/ok.jpg']);
    expect(parsed.rows[0]?.descriptionImage).toBe('');
    expect(parsed.skippedImages).toBe(3);
    expect(parsed.skippedDistricts).toBe(0);
  });

  it('refuses a file that is not a state, or has too many districts', () => {
    expect(() => parseCensusState(null)).toThrow(ConnectorError);
    expect(() => parseCensusState([])).toThrow(ConnectorError);
    expect(() => parseCensusState({ state: 'X', abbreviation: 'XYZ' })).toThrow(ConnectorError);
    expect(() => parseCensusState({ abbreviation: 'XX' })).toThrow(ConnectorError);
    const file = state();
    file['county/city'] = [
      {
        name: 'Big County',
        enumeration: Array.from({ length: CENSUS_MAX_DISTRICTS + 1 }, (_, i) =>
          district(String(i), '1950census/a/b', ['x-0001.jpg']),
        ),
      },
    ];
    expect(() => parseCensusState(file)).toThrow(/more districts/);
  });

  it('counts malformed counties against the limit of districts too', () => {
    const file = state();
    file['county/city'] = [
      {
        name: 'Big County',
        enumeration: Array.from({ length: CENSUS_MAX_DISTRICTS }, (_, i) =>
          district(String(i), '1950census/a/b', ['x-0001.jpg']),
        ),
      },
      { name: 'Broken County' },
    ];
    expect(() => parseCensusState(file)).toThrow(/more districts/);
  });

  it('refuses a state with more counties than the list of counties can show', () => {
    const file = state();
    file['county/city'] = Array.from({ length: CENSUS_MAX_COUNTIES + 1 }, (_, i) => ({
      name: `County ${i}`,
      enumeration: [district('1', '1950census/a/b', ['x-0001.jpg'])],
    }));
    expect(() => parseCensusState(file)).toThrow(/more counties/);
    file['county/city'] = (file['county/city'] as unknown[]).slice(0, CENSUS_MAX_COUNTIES);
    expect(parseCensusState(file).rows).toHaveLength(CENSUS_MAX_COUNTIES);
  });

  it('accepts as many districts as the limit', () => {
    const file = state();
    file['county/city'] = [
      {
        name: 'Big County',
        enumeration: Array.from({ length: CENSUS_MAX_DISTRICTS }, (_, i) =>
          district(String(i), '1950census/a/b', ['x-0001.jpg']),
        ),
      },
    ];
    expect(parseCensusState(file).rows).toHaveLength(CENSUS_MAX_DISTRICTS);
  });

  it('allows at most 1% of the districts to be left out', () => {
    expect(censusSkipAcceptable(0, 10)).toBe(true);
    expect(censusSkipAcceptable(1, 100)).toBe(true);
    expect(censusSkipAcceptable(2, 100)).toBe(false);
    expect(censusSkipAcceptable(1, 99)).toBe(false);
  });
});
