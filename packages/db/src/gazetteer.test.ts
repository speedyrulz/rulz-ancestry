import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { formatGazetteerPlace } from '@rulz/core';
import { Gazetteer, GazetteerBuilder, GazetteerError } from './gazetteer';
import { GEONAMES_SAMPLE, cleanUpAfterEach, geonameLine, tempDir } from './testing';
import { ZipError, writeZip } from './zip';

cleanUpAfterEach();

const open: Gazetteer[] = [];

/** Builds the sample gazetteer in a folder of its own and opens it. */
function sampleGazetteer(): Gazetteer {
  const file = join(tempDir(), 'geonames.db');
  const builder = new GazetteerBuilder(file);
  builder.addCountryInfo(GEONAMES_SAMPLE.countryInfo);
  builder.addAdmin1(GEONAMES_SAMPLE.admin1);
  builder.addAdmin2(GEONAMES_SAMPLE.admin2);
  builder.addPlaceLines(GEONAMES_SAMPLE.US.split('\n'));
  builder.addPlaceLines(GEONAMES_SAMPLE.NL.split('\n'));
  builder.addPlaceLines(GEONAMES_SAMPLE.cities500.split('\n'));
  builder.finish({ countries: ['US', 'NL'], builtAt: 1_700_000_000_000 });
  const gazetteer = Gazetteer.open(file);
  open.push(gazetteer);
  return gazetteer;
}

function closeAll(): void {
  for (const gazetteer of open.splice(0)) gazetteer.close();
}

/** The places a search gives, written out. */
function found(gazetteer: Gazetteer, text: string, limit = 8): string[] {
  return gazetteer.search(text, { limit }).map(formatGazetteerPlace);
}

describe('GazetteerBuilder', () => {
  it('takes towns and regions, and passes over everything else', () => {
    const file = join(tempDir(), 'geonames.db');
    const builder = new GazetteerBuilder(file);
    expect(builder.addCountryInfo(GEONAMES_SAMPLE.countryInfo)).toBe(5);
    expect(builder.addAdmin1(GEONAMES_SAMPLE.admin1)).toBe(7);
    expect(builder.addAdmin2(GEONAMES_SAMPLE.admin2)).toBe(5);
    // Six of the nine lines: not the stream, the broken line or the place off the map.
    expect(builder.addPlaceLines(GEONAMES_SAMPLE.US.split('\n'))).toBe(6);
    expect(builder.places).toBe(6);
    const info = builder.finish({ countries: ['US'], builtAt: 5 });
    expect(info).toEqual({ places: 6, builtAt: 5, countries: ['US'] });
    const gazetteer = Gazetteer.open(file);
    expect(gazetteer.info).toEqual(info);
    gazetteer.close();
  });

  it('keeps the first of two lines for one place', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(gazetteer.get(4250542)?.name).toBe('Springfield');
      expect(gazetteer.info.places).toBe(11);
    } finally {
      closeAll();
    }
  });

  it('reads a list of places from a zip archive, piece by piece', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    for (let id = 1; id <= 20_000; id += 1) {
      lines.push(geonameLine({ id, name: `Village ${id}`, population: id }));
    }
    // A line that ends without a line feed is read too.
    const zip = join(dir, 'US.zip');
    writeZip(zip, [
      { name: 'readme.txt', data: Buffer.from('not the list') },
      { name: 'US.txt', data: Buffer.from(lines.join('\n'), 'utf8') },
    ]);
    const file = join(dir, 'geonames.db');
    const builder = new GazetteerBuilder(file);
    const seen: number[] = [];
    const added = await builder.addPlacesFromZip(zip, 'US.txt', {
      onProgress: (places) => seen.push(places),
    });
    expect(added).toBe(20_000);
    expect(seen.at(-1)).toBe(20_000);
    builder.finish({ countries: ['US'], builtAt: 1 });
    const gazetteer = Gazetteer.open(file);
    try {
      expect(gazetteer.search('Village 20000')[0]?.geonameId).toBe(20_000);
    } finally {
      gazetteer.close();
    }
  });

  it('does not split a letter that falls on the edge of two pieces', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    // Two bytes to a letter, and enough of them to fill several pieces.
    for (let id = 1; id <= 30_000; id += 1) {
      lines.push(geonameLine({ id, name: `Zürich-Überlândia ${id}` }));
    }
    const zip = join(dir, 'CH.zip');
    writeZip(zip, [{ name: 'CH.txt', data: Buffer.from(lines.join('\n'), 'utf8') }]);
    const builder = new GazetteerBuilder(join(dir, 'geonames.db'));
    await builder.addPlacesFromZip(zip, 'CH.txt');
    builder.finish({ countries: [], builtAt: 1 });
    const gazetteer = Gazetteer.open(join(dir, 'geonames.db'));
    try {
      expect(gazetteer.info.places).toBe(30_000);
      for (const id of [1, 9_999, 17_345, 30_000]) {
        expect(gazetteer.get(id)?.name).toBe(`Zürich-Überlândia ${id}`);
      }
    } finally {
      gazetteer.close();
    }
  });

  it('stops when it is told to, and when the archive is damaged or lacks the list', async () => {
    const dir = tempDir();
    const zip = join(dir, 'US.zip');
    writeZip(zip, [{ name: 'US.txt', data: Buffer.from(GEONAMES_SAMPLE.US, 'utf8') }]);

    const stopped = new GazetteerBuilder(join(dir, 'a.db'));
    const abort = new AbortController();
    abort.abort();
    await expect(stopped.addPlacesFromZip(zip, 'US.txt', { signal: abort.signal })).rejects.toThrow(
      /abort/i,
    );
    stopped.discard();
    expect(existsSync(join(dir, 'a.db'))).toBe(false);

    const missing = new GazetteerBuilder(join(dir, 'b.db'));
    await expect(missing.addPlacesFromZip(zip, 'NL.txt')).rejects.toThrow(GazetteerError);
    missing.discard();

    writeFileSync(join(dir, 'bad.zip'), 'this is not a zip file at all, only some text');
    const damaged = new GazetteerBuilder(join(dir, 'c.db'));
    await expect(damaged.addPlacesFromZip(join(dir, 'bad.zip'), 'US.txt')).rejects.toThrow(
      ZipError,
    );
    damaged.discard();
  });

  it('refuses to finish with far too few places, and leaves no file behind', () => {
    const file = join(tempDir(), 'geonames.db');
    const builder = new GazetteerBuilder(file);
    builder.addPlaceLines(GEONAMES_SAMPLE.NL.split('\n'));
    expect(() => builder.finish({ countries: [], builtAt: 1, minimums: { places: 100 } })).toThrow(
      /far fewer/,
    );
    expect(existsSync(file)).toBe(false);
  });

  it('refuses to finish when a list of names was cut short', () => {
    const file = join(tempDir(), 'geonames.db');
    const builder = new GazetteerBuilder(file);
    builder.addCountryInfo(GEONAMES_SAMPLE.countryInfo);
    builder.addAdmin1(GEONAMES_SAMPLE.admin1);
    builder.addAdmin2(GEONAMES_SAMPLE.admin2);
    builder.addPlaceLines(GEONAMES_SAMPLE.US.split('\n'));
    expect(() =>
      builder.finish({
        countries: [],
        builtAt: 1,
        minimums: { places: 6, countries: 5, admin1: 7, admin2: 6 },
      }),
    ).toThrow(/list of counties holds 5 names/);
    expect(existsSync(file)).toBe(false);
  });

  it('gives up a list whose line never ends', async () => {
    const dir = tempDir();
    const zip = join(dir, 'US.zip');
    // Half a megabyte without a line feed, which packs to almost nothing.
    writeZip(zip, [{ name: 'US.txt', data: Buffer.alloc(500_000, 'a') }]);
    const builder = new GazetteerBuilder(join(dir, 'geonames.db'));
    await expect(builder.addPlacesFromZip(zip, 'US.txt')).rejects.toThrow(/not a list of places/);
    builder.discard();
  });

  it('replaces a file that is in the way', () => {
    const file = join(tempDir(), 'geonames.db');
    writeFileSync(file, 'left over from a run that was cut short');
    const builder = new GazetteerBuilder(file);
    builder.addPlaceLines(GEONAMES_SAMPLE.NL.split('\n'));
    builder.finish({ countries: [], builtAt: 1 });
    const gazetteer = Gazetteer.open(file);
    expect(gazetteer.info.places).toBe(2);
    gazetteer.close();
  });
});

describe('Gazetteer.open', () => {
  it('says so when there is no file, or the file is something else', () => {
    const dir = tempDir();
    expect(() => Gazetteer.open(join(dir, 'none.db'))).toThrow(GazetteerError);
    writeFileSync(join(dir, 'text.db'), 'not a database');
    expect(() => Gazetteer.open(join(dir, 'text.db'))).toThrow(GazetteerError);
    // A database of some other kind is not one either.
    const other = new Database(join(dir, 'other.db'));
    other.exec('CREATE TABLE place (geonameid INTEGER PRIMARY KEY)');
    other.close();
    expect(() => Gazetteer.open(join(dir, 'other.db'))).toThrow(/not a gazetteer/);
  });
});

describe('Gazetteer.search', () => {
  it('finds places by the start of their name, with their regions written out', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(found(gazetteer, 'Springf')).toEqual([
        'Springfield, Sangamon County, Illinois, USA',
        'Springfield, Greene County, Missouri, USA',
        'Township of Springfield, Sangamon County, Illinois, USA',
      ]);
      expect(found(gazetteer, 'york')).toEqual(['York, England']);
      expect(found(gazetteer, 'AMSTERDAM')).toEqual([
        'Amsterdam, North Holland, Netherlands',
        'Gemeente Amsterdam, North Holland, Netherlands',
      ]);
      expect(found(gazetteer, 'paris')).toEqual(['Paris, Île-de-France, France']);
    } finally {
      closeAll();
    }
  });

  it('gives the coordinates and the number of each place', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(gazetteer.search('Ames')[0]).toEqual({
        geonameId: 4846834,
        name: 'Ames',
        featureClass: 'P',
        featureCode: 'PPL',
        countryCode: 'US',
        country: 'United States',
        admin1: 'Iowa',
        admin1Code: 'IA',
        admin2: 'Story County',
        lat: 42.03471,
        lon: -93.61994,
        population: 66427,
      });
      expect(gazetteer.get(4846834)).toEqual(gazetteer.search('Ames')[0]);
      expect(gazetteer.get(999)).toBeNull();
    } finally {
      closeAll();
    }
  });

  it('narrows a search by a county, a state or a country after a comma', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(found(gazetteer, 'Springfield, Mo')).toEqual([
        'Springfield, Greene County, Missouri, USA',
      ]);
      expect(found(gazetteer, 'Springfield, Sangamon, Illinois, USA')).toEqual([
        'Springfield, Sangamon County, Illinois, USA',
        'Township of Springfield, Sangamon County, Illinois, USA',
      ]);
      expect(found(gazetteer, 'Springfield, IL')[0]).toBe(
        'Springfield, Sangamon County, Illinois, USA',
      );
      expect(found(gazetteer, 'Springfield, England')).not.toContain(
        'Springfield, Sangamon County, Illinois, USA',
      );
    } finally {
      closeAll();
    }
  });

  it('finds a place by another of its names, and by its name without accents', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(found(gazetteer, 'Bombay')).toEqual(['Mumbai, Maharashtra, India']);
      expect(found(gazetteer, 'mokum')).toEqual(['Amsterdam, North Holland, Netherlands']);
      expect(found(gazetteer, 'Amsterdao')).toEqual(['Amsterdam, North Holland, Netherlands']);
      // Names in other scripts are not kept.
      expect(found(gazetteer, 'Амстердам')).toEqual([]);
    } finally {
      closeAll();
    }
  });

  it('finds a county and a township without the word that says what they are', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(found(gazetteer, 'Sangamon')).toEqual(['Sangamon County, Illinois, USA']);
      expect(found(gazetteer, 'Illinois')).toEqual(['Illinois, USA']);
      expect(found(gazetteer, 'Springfield, Sangamon')).toContain(
        'Township of Springfield, Sangamon County, Illinois, USA',
      );
    } finally {
      closeAll();
    }
  });

  it('tries the text after the first comma when the whole text finds nothing', () => {
    const gazetteer = sampleGazetteer();
    try {
      // A ward, a church or a street before the town.
      expect(found(gazetteer, 'Ward 7, Springfield, Greene, Missouri, USA')).toEqual([
        'Springfield, Greene County, Missouri, USA',
      ]);
      // Nothing before the first comma.
      expect(found(gazetteer, ', Ames, Story, Iowa, USA')).toEqual([
        'Ames, Story County, Iowa, USA',
      ]);
      // The town written twice, as some programs do.
      expect(found(gazetteer, 'Ames, Ames, Story, Iowa, USA')).toEqual([
        'Ames, Story County, Iowa, USA',
      ]);
      expect(found(gazetteer, 'First Church, Main Street, 4th floor, upstairs, Ames')).toEqual([]);
    } finally {
      closeAll();
    }
  });

  it('says how much of the text it left out', () => {
    const gazetteer = sampleGazetteer();
    try {
      const skipped = (text: string) => gazetteer.find(text).skipped;
      expect(skipped('Springfield, Greene, Missouri')).toBe(0);
      expect(skipped('Ward 7, Springfield, Greene, Missouri, USA')).toBe(1);
      expect(skipped('Pew 3, First Church, Springfield, Missouri')).toBe(2);
      // A part that holds nothing was not left out.
      expect(skipped(', Ames, Story, Iowa, USA')).toBe(0);
      expect(skipped(' , , Ames, Story, Iowa, USA')).toBe(0);
      expect(gazetteer.find('Ames, Ames, Story, Iowa, USA').places).toHaveLength(1);
      expect(gazetteer.find('Xyzzy')).toEqual({ places: [], skipped: 0 });
    } finally {
      closeAll();
    }
  });

  it('finds nothing for a letter, for nothing, and for what is not there', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(found(gazetteer, 'S')).toEqual([]);
      expect(found(gazetteer, '')).toEqual([]);
      expect(found(gazetteer, ' , ')).toEqual([]);
      expect(found(gazetteer, 'Xyzzy')).toEqual([]);
      expect(found(gazetteer, "Spr%ng'; DROP TABLE place; --")).toEqual([]);
    } finally {
      closeAll();
    }
  });

  it('gives no more than was asked for', () => {
    const gazetteer = sampleGazetteer();
    try {
      expect(found(gazetteer, 'Springf', 2)).toHaveLength(2);
      expect(found(gazetteer, 'Springf', 0)).toHaveLength(1);
    } finally {
      closeAll();
    }
  });

  it('puts the places of the countries named first before others', () => {
    const file = join(tempDir(), 'geonames.db');
    const builder = new GazetteerBuilder(file);
    builder.addCountryInfo(GEONAMES_SAMPLE.countryInfo);
    builder.addPlaceLines([
      geonameLine({ id: 1, name: 'Boston', country: 'GB', population: 45_000 }),
      geonameLine({ id: 2, name: 'Boston', country: 'FR', population: 45_000 }),
    ]);
    builder.finish({ countries: [], builtAt: 1 });
    const gazetteer = Gazetteer.open(file);
    try {
      expect(gazetteer.search('Boston', { priority: ['GB'] })[0]?.countryCode).toBe('GB');
      expect(gazetteer.search('Boston', { priority: ['FR'] })[0]?.countryCode).toBe('FR');
    } finally {
      gazetteer.close();
    }
  });
});
