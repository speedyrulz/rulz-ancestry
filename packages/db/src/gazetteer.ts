import { existsSync, rmSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import Database from 'better-sqlite3';
import {
  REGION_PRIORITY,
  fitsRegions,
  foldPlace,
  isLatinFolded,
  parsePlaceQuery,
  placeNameVariants,
  scoreGazetteerHit,
  type GazetteerHit,
  type GazetteerPlace,
  type PlaceQuery,
} from '@rulz/core';
import type { Db } from './connection';
import { ZipReader } from './zip';

/**
 * The gazetteer: a list of the world's places with their coordinates, built
 * from the files GeoNames publishes (https://www.geonames.org, licensed
 * CC BY 4.0) and kept in one SQLite file of its own.
 *
 * It belongs to the app, not to a tree. A tree copies the name and the
 * coordinates of each entry it links to (see `places.ts`), so it does not
 * need this file to know where its places are.
 *
 * {@link GazetteerBuilder} writes the file once, from the downloaded lists;
 * {@link Gazetteer} only ever reads it.
 */

/** The name of the gazetteer file inside its folder. */
export const GAZETTEER_FILE_NAME = 'geonames.db';

/** Marks a SQLite file as a gazetteer of this app ("RGAZ"). */
const APPLICATION_ID = 0x5247415a;
const FORMAT_VERSION = 1;

/** The largest unpacked list of places taken from one archive. */
const MAX_LIST_BYTES = 1024 * 1024 * 1024;
/**
 * The longest line of a list of places, in characters. The longest that
 * GeoNames writes is a little over 10,000; a file with a longer one is not
 * such a list, and its line is not gathered up any further.
 */
const MAX_LINE_LENGTH = 100_000;
/** GeoNames' classes that are kept: `P`, where people live, and `A`, countries and their divisions. */
const KEPT_CLASSES = new Set(['P', 'A']);
/** A name longer than this is not a name anyone types. */
const MAX_NAME_LENGTH = 80;

/** The gazetteer file cannot be used, or the lists it is built from cannot be read. */
export class GazetteerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GazetteerError';
  }
}

export interface GazetteerInfo {
  /** How many places the gazetteer holds. */
  places: number;
  /** When it was built, in Unix milliseconds. */
  builtAt: number;
  /** The countries that are in it down to their villages, by their two letters. */
  countries: string[];
}

/**
 * The fewest entries each list must have brought for the gazetteer to be
 * taken for complete. A list that is left out counts as 0 wanted.
 */
export interface GazetteerMinimums {
  places?: number;
  countries?: number;
  admin1?: number;
  admin2?: number;
}

/** What a search found, and how much of the text it had to leave out for it. */
export interface GazetteerFound {
  places: GazetteerPlace[];
  /**
   * How many parts at the start of the text were left out before something
   * was found. A part that holds nothing, as in ", Story, Iowa", is not
   * counted: nothing was left out with it.
   */
  skipped: number;
}

export interface GazetteerSearchOptions {
  /** The most entries to give. */
  limit?: number;
  /** The countries whose places come first, most important first. */
  priority?: readonly string[];
}

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE country (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) WITHOUT ROWID;
  -- The code is the country's and the division's joined by a dot: "US.IL".
  CREATE TABLE admin1 (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) WITHOUT ROWID;
  -- "US.IL.167"
  CREATE TABLE admin2 (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE place (
    geonameid  INTEGER PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    fclass     TEXT NOT NULL,
    fcode      TEXT NOT NULL,
    country    TEXT NOT NULL,
    admin1     TEXT NOT NULL,
    admin2     TEXT NOT NULL,
    population INTEGER NOT NULL
  );
  -- Every name of every place, folded (see foldPlace), in the order of the
  -- alphabet, so that the names that start with what was typed lie together.
  -- The population and the country are repeated here so that the best of
  -- many thousand names can be picked without reading each place.
  CREATE TABLE place_name (
    folded     TEXT NOT NULL,
    geonameid  INTEGER NOT NULL,
    alternate  INTEGER NOT NULL,
    population INTEGER NOT NULL,
    country    TEXT NOT NULL,
    PRIMARY KEY (folded, geonameid)
  ) WITHOUT ROWID;
`;

function removeFile(file: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${file}${suffix}`, { force: true });
  }
}

/** Lets other work of the program run, such as answering the window. */
function pause(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Writes a new gazetteer file from GeoNames' lists. Add the three small
 * lists and any number of lists of places, in any order, then call
 * {@link finish}; or {@link discard} to give up. The file is not a gazetteer
 * until `finish` has returned.
 */
export class GazetteerBuilder {
  readonly file: string;
  readonly #db: Db;
  readonly #addPlace: Database.Statement;
  readonly #addName: Database.Statement;
  #places = 0;
  readonly #codes = { country: 0, admin1: 0, admin2: 0 };
  #open = true;

  constructor(file: string) {
    this.file = file;
    removeFile(file);
    this.#db = new Database(file);
    try {
      // The file is thrown away if anything goes wrong, so nothing needs to
      // be kept safe while it is written, and writing is several times faster.
      this.#db.pragma('journal_mode = OFF');
      this.#db.pragma('synchronous = OFF');
      this.#db.pragma('locking_mode = EXCLUSIVE');
      this.#db.pragma('cache_size = -131072');
      this.#db.exec(SCHEMA);
      this.#db.exec('BEGIN');
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#addPlace = this.#db.prepare(
      `INSERT OR IGNORE INTO place
         (geonameid, name, lat, lon, fclass, fcode, country, admin1, admin2, population)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#addName = this.#db.prepare(
      `INSERT OR IGNORE INTO place_name (folded, geonameid, alternate, population, country)
       VALUES (?, ?, ?, ?, ?)`,
    );
  }

  /** How many places have been taken so far. */
  get places(): number {
    return this.#places;
  }

  #addCodes(table: 'country' | 'admin1' | 'admin2', rows: Iterable<[string, string]>): number {
    const add = this.#db.prepare(`INSERT OR REPLACE INTO ${table} (code, name) VALUES (?, ?)`);
    let count = 0;
    for (const [code, name] of rows) {
      if (code === '' || name === '') continue;
      add.run(code, name);
      count += 1;
    }
    this.#codes[table] += count;
    return count;
  }

  /** Takes GeoNames' `countryInfo.txt`: the countries with their names. */
  addCountryInfo(text: string): number {
    const rows: [string, string][] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('#')) continue;
      const columns = line.split('\t');
      const code = (columns[0] ?? '').trim();
      if (/^[A-Z]{2}$/.test(code)) rows.push([code, (columns[4] ?? '').trim()]);
    }
    return this.#addCodes('country', rows);
  }

  #codeList(text: string): [string, string][] {
    const rows: [string, string][] = [];
    for (const line of text.split(/\r?\n/)) {
      const columns = line.split('\t');
      rows.push([(columns[0] ?? '').trim(), (columns[1] ?? '').trim()]);
    }
    return rows;
  }

  /** Takes GeoNames' `admin1CodesASCII.txt`: the states and provinces. */
  addAdmin1(text: string): number {
    return this.#addCodes('admin1', this.#codeList(text));
  }

  /** Takes GeoNames' `admin2Codes.txt`: the counties and municipalities. */
  addAdmin2(text: string): number {
    return this.#addCodes('admin2', this.#codeList(text));
  }

  /**
   * Takes lines of a GeoNames list of places (nineteen columns with tabs
   * between them). Lines that are not a place where people live or a
   * division of a country are passed over, and so is a line that cannot be
   * read. Returns how many places were new.
   */
  addPlaceLines(lines: Iterable<string>): number {
    let added = 0;
    for (const line of lines) {
      const columns = line.split('\t');
      if (columns.length < 15) continue;
      const fclass = columns[6] ?? '';
      if (!KEPT_CLASSES.has(fclass)) continue;
      const id = Number(columns[0]);
      const name = (columns[1] ?? '').trim();
      const lat = Number(columns[4]);
      const lon = Number(columns[5]);
      if (!Number.isSafeInteger(id) || id <= 0 || name === '') continue;
      if (columns[4] === '' || columns[5] === '') continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const population = Math.max(0, Math.trunc(Number(columns[14]) || 0));
      const country = (columns[8] ?? '').trim().toUpperCase();
      const inserted = this.#addPlace.run(
        id,
        name,
        lat,
        lon,
        fclass,
        (columns[7] ?? '').trim(),
        country,
        (columns[10] ?? '').trim(),
        (columns[11] ?? '').trim(),
        population,
      );
      // A place that two lists hold is taken from the first.
      if (inserted.changes === 0) continue;
      added += 1;

      const main = foldPlace(name);
      const ascii = foldPlace(columns[2] ?? '');
      for (const folded of ascii === main ? [main] : [main, ascii]) {
        if (folded === '' || folded.length > MAX_NAME_LENGTH) continue;
        this.#addName.run(folded, id, 0, population, country);
        // "Township of Monroe" is also found as "Monroe".
        for (const variant of placeNameVariants(folded)) {
          this.#addName.run(variant, id, 0, population, country);
        }
      }
      const others = columns[3] ?? '';
      if (others !== '') {
        for (const other of others.split(',')) {
          const folded = foldPlace(other);
          // Names in other scripts are left out: nobody types them here, and
          // they would more than double the size of the file.
          if (folded.length < 2 || folded.length > MAX_NAME_LENGTH || !isLatinFolded(folded)) {
            continue;
          }
          this.#addName.run(folded, id, 1, population, country);
        }
      }
    }
    this.#places += added;
    return added;
  }

  /**
   * Takes a list of places from a zip archive as GeoNames publishes them
   * (`US.zip` holds `US.txt`). The list is read piece by piece, and other
   * work of the program gets its turn in between. Stops with the signal's
   * reason when the signal is given.
   */
  async addPlacesFromZip(
    zipFile: string,
    entryName: string,
    options: { signal?: AbortSignal; onProgress?: (places: number) => void } = {},
  ): Promise<number> {
    const zip = ZipReader.open(zipFile);
    try {
      const entry = zip.find(entryName);
      if (!entry) throw new GazetteerError(`${entryName} is not in the downloaded archive`);
      const decoder = new StringDecoder('utf8');
      let rest = '';
      let added = 0;
      for await (const piece of zip.stream(entry, MAX_LIST_BYTES)) {
        options.signal?.throwIfAborted();
        const text = rest + decoder.write(piece);
        const lines = text.split('\n');
        rest = lines.pop() ?? '';
        if (rest.length > MAX_LINE_LENGTH) {
          throw new GazetteerError(`${entryName} is not a list of places`);
        }
        added += this.addPlaceLines(lines);
        options.onProgress?.(this.#places);
        await pause();
      }
      rest += decoder.end();
      if (rest !== '') {
        added += this.addPlaceLines([rest]);
        options.onProgress?.(this.#places);
      }
      return added;
    } finally {
      zip.close();
    }
  }

  /**
   * Completes the file and closes it. Fails, and removes the file, when a
   * list brought fewer entries than `minimums` asks for: lists that were cut
   * short must not pass for a gazetteer.
   */
  finish(options: {
    countries: readonly string[];
    builtAt: number;
    minimums?: GazetteerMinimums;
  }): GazetteerInfo {
    if (!this.#open) throw new GazetteerError('the gazetteer file is already closed');
    const info: GazetteerInfo = {
      places: this.#places,
      builtAt: options.builtAt,
      countries: [...options.countries],
    };
    try {
      const minimums = options.minimums ?? {};
      if (this.#places < (minimums.places ?? 1)) {
        throw new GazetteerError(
          `the downloaded lists hold ${this.#places} places, far fewer than they should`,
        );
      }
      const lists = [
        ['countries', this.#codes.country, minimums.countries],
        ['states and provinces', this.#codes.admin1, minimums.admin1],
        ['counties', this.#codes.admin2, minimums.admin2],
      ] as const;
      for (const [what, count, wanted] of lists) {
        if (count < (wanted ?? 0)) {
          throw new GazetteerError(
            `the downloaded list of ${what} holds ${count} names, far fewer than it should`,
          );
        }
      }
      const set = this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      set.run('places', String(info.places));
      set.run('built_at', String(info.builtAt));
      set.run('countries', info.countries.join(','));
      set.run('source', 'GeoNames, https://www.geonames.org, CC BY 4.0');
      this.#db.exec('COMMIT');
      this.#db.pragma(`application_id = ${APPLICATION_ID}`);
      this.#db.pragma(`user_version = ${FORMAT_VERSION}`);
      this.#db.exec('ANALYZE');
      const check = this.#db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new GazetteerError('the gazetteer file did not pass its check');
    } catch (error) {
      this.discard();
      throw error;
    }
    this.#open = false;
    this.#db.close();
    return info;
  }

  /** Gives up: closes the file and removes it. */
  discard(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#db.close();
    removeFile(this.file);
  }
}

interface PlaceRow {
  geonameid: number;
  name: string;
  lat: number;
  lon: number;
  fclass: string;
  fcode: string;
  country: string;
  admin1_code: string;
  population: number;
  country_name: string;
  admin1: string;
  admin2: string;
}

interface HitRow extends PlaceRow {
  folded: string;
  alternate: number;
}

const PLACE_COLUMNS = `p.geonameid, p.name, p.lat, p.lon, p.fclass, p.fcode, p.country,
  p.admin1 AS admin1_code, p.population, coalesce(c.name, '') AS country_name,
  coalesce(a1.name, '') AS admin1, coalesce(a2.name, '') AS admin2`;

const PLACE_JOINS = `LEFT JOIN country c ON c.code = p.country
  LEFT JOIN admin1 a1 ON a1.code = p.country || '.' || p.admin1
  LEFT JOIN admin2 a2 ON a2.code = p.country || '.' || p.admin1 || '.' || p.admin2`;

function toPlace(row: PlaceRow): GazetteerPlace {
  return {
    geonameId: row.geonameid,
    name: row.name,
    featureClass: row.fclass,
    featureCode: row.fcode,
    countryCode: row.country,
    country: row.country_name,
    admin1: row.admin1,
    admin1Code: row.admin1_code,
    admin2: row.admin2,
    lat: row.lat,
    lon: row.lon,
    population: row.population,
  };
}

/** Sorts after every text that starts with what stands before it. */
const LAST_CHARACTER = String.fromCodePoint(0x10ffff);
/** How many names are weighed for one search, and how many when a region was typed too. */
const CANDIDATES = 200;
const CANDIDATES_WITH_REGIONS = 4000;
/** How many parts at the start of a text are left out in turn when it finds nothing. */
const MAX_PARTS_SKIPPED = 3;

/** A gazetteer file, open for reading. Close it when done. */
export class Gazetteer {
  readonly info: GazetteerInfo;
  readonly #db: Db;

  private constructor(db: Db, info: GazetteerInfo) {
    this.#db = db;
    this.info = info;
  }

  /** Opens a gazetteer file. Throws {@link GazetteerError} when it is not one or is damaged. */
  static open(file: string): Gazetteer {
    if (!existsSync(file)) throw new GazetteerError('the gazetteer has not been downloaded');
    let db: Db;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
    } catch (error) {
      throw new GazetteerError(`the gazetteer file cannot be opened: ${(error as Error).message}`);
    }
    try {
      const application = db.pragma('application_id', { simple: true });
      const version = db.pragma('user_version', { simple: true });
      if (application !== APPLICATION_ID || version !== FORMAT_VERSION) {
        throw new GazetteerError('this file is not a gazetteer this version of the app can read');
      }
      const meta = new Map(
        (db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(
          (row) => [row.key, row.value],
        ),
      );
      const info: GazetteerInfo = {
        places: Number(meta.get('places') ?? 0),
        builtAt: Number(meta.get('built_at') ?? 0),
        countries: (meta.get('countries') ?? '').split(',').filter((code) => code !== ''),
      };
      return new Gazetteer(db, info);
    } catch (error) {
      db.close();
      if (error instanceof GazetteerError) throw error;
      throw new GazetteerError(`the gazetteer file is damaged: ${(error as Error).message}`);
    }
  }

  /** The entry with this GeoNames number, or null. */
  get(geonameId: number): GazetteerPlace | null {
    const row = this.#db
      .prepare(`SELECT ${PLACE_COLUMNS} FROM place p ${PLACE_JOINS} WHERE p.geonameid = ?`)
      .get(geonameId) as PlaceRow | undefined;
    return row ? toPlace(row) : null;
  }

  #candidates(name: string, limit: number, countries: readonly string[] | null): HitRow[] {
    const inCountries =
      countries === null ? '' : `AND country IN (${countries.map(() => '?').join(', ')})`;
    return this.#db
      .prepare(
        `WITH hit AS (
           SELECT folded, geonameid, alternate FROM place_name
           WHERE folded >= ? AND folded < ? ${inCountries}
           ORDER BY (folded = ?) DESC, population DESC LIMIT ?
         )
         SELECT hit.folded, hit.alternate, ${PLACE_COLUMNS}
         FROM hit JOIN place p ON p.geonameid = hit.geonameid ${PLACE_JOINS}`,
      )
      .all(name, name + LAST_CHARACTER, ...(countries ?? []), name, limit) as HitRow[];
  }

  /**
   * The entries whose name starts with what was typed, best first. Text
   * after a comma narrows the search to a county, a state or a country:
   * "Springfield, Ill" or "York, England". Nothing is found for fewer than
   * two letters. When the whole text finds nothing, what follows its first
   * comma is searched for instead, up to three times.
   */
  search(text: string, options: GazetteerSearchOptions = {}): GazetteerPlace[] {
    return this.find(text, options).places;
  }

  /** As {@link search}, and says how many parts of the text were left out. */
  find(text: string, options: GazetteerSearchOptions = {}): GazetteerFound {
    const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
    const priority = (options.priority ?? REGION_PRIORITY).filter((code) =>
      /^[A-Z]{2}$/.test(code),
    );
    // Many places in family trees start with something that is no place of
    // its own: a ward, a church, a street, or nothing at all before the
    // first comma. When the whole text finds nothing, the text after its
    // first comma is tried, and so on.
    const parts = text.split(',');
    let skipped = 0;
    for (let skip = 0; skip < Math.min(parts.length, MAX_PARTS_SKIPPED + 1); skip += 1) {
      const query = parsePlaceQuery(parts.slice(skip).join(','));
      if (query !== null) {
        const places = this.#search(query, limit, priority);
        if (places.length > 0) return { places, skipped };
      }
      if (foldPlace(parts[skip] ?? '') !== '') skipped += 1;
    }
    return { places: [], skipped: 0 };
  }

  #search(query: PlaceQuery, limit: number, priority: readonly string[]): GazetteerPlace[] {
    const count = query.regions.length > 0 ? CANDIDATES_WITH_REGIONS : CANDIDATES;
    // The largest places of the world, and the largest of the countries that
    // come first: a village there must not be crowded out by towns elsewhere.
    const rows = [
      ...this.#candidates(query.name, count, null),
      ...(priority.length > 0 ? this.#candidates(query.name, count, priority) : []),
    ];

    const best = new Map<number, { hit: GazetteerHit; score: number }>();
    const seen = new Set<string>();
    for (const row of rows) {
      // The two lists share most of their names when the place is in a
      // country that comes first.
      const name = `${row.geonameid} ${row.folded}`;
      if (seen.has(name)) continue;
      seen.add(name);
      const hit: GazetteerHit = {
        place: toPlace(row),
        folded: row.folded,
        alternate: row.alternate === 1,
      };
      if (!fitsRegions(hit.place, query.regions)) continue;
      const score = scoreGazetteerHit(hit, query, priority);
      const known = best.get(hit.place.geonameId);
      if (!known || score > known.score) best.set(hit.place.geonameId, { hit, score });
    }
    return [...best.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.hit.place.name.localeCompare(b.hit.place.name, 'en') ||
          a.hit.place.geonameId - b.hit.place.geonameId,
      )
      .slice(0, limit)
      .map((entry) => entry.hit.place);
  }

  close(): void {
    if (this.#db.open) this.#db.close();
  }
}
