import { ConnectorError, cleanText } from '../../connector';

/**
 * The 1950 US census as the National Archives publish it in their open bucket:
 * a metadata file for each state, which lists its counties, their enumeration
 * districts (EDs) and the images of each district's pages. There is no index
 * of names in it. This module reads the bucket's listing and one state's
 * file, and builds the addresses the app uses. It asks nothing of the
 * internet itself.
 *
 * Everything that comes out of a file is checked here before the app keeps or
 * uses it: a path or a file name that does not look as the bucket's own do
 * is left out and counted, never kept.
 */

/** The kind of a pack built from one state's metadata file. */
export const NARA_CENSUS_PACK_KIND = 'nara-1950-areas';
/** Raised when a change to how a state's file is read means that packs must be built again. */
export const CENSUS_BUILDER_VERSION = 1;

/** The host of the bucket: the only host the app asks for the census. */
export const CENSUS_HOST = 'nara-1950-census.s3.us-east-2.amazonaws.com';
/** The bucket's own address, which the app uses whatever a file says its `baseurl` is. */
export const CENSUS_BUCKET = `https://${CENSUS_HOST}/`;
/** The list of the state files, which the bucket gives to anyone. */
export const CENSUS_LISTING_URL = `${CENSUS_BUCKET}?list-type=2&prefix=metadata/json/`;
/** The National Archives' own site for the census. */
export const CENSUS_SITE = 'https://1950census.archives.gov';

/** A pack of a state is named `c50` and the state's code. */
export const CENSUS_PACK_ID_PATTERN = /^c50[a-z]{2}$/;
export const censusPackId = (code: string): string => `c50${code}`;

/**
 * The 60 lists of the bucket: 50 states, the District of Columbia, and the
 * territories and special lists. The listing gives codes only, so the names
 * are the app's own.
 */
export const CENSUS_CODES: Readonly<Record<string, string>> = {
  ak: 'Alaska',
  al: 'Alabama',
  ar: 'Arkansas',
  as: 'American Samoa',
  az: 'Arizona',
  ca: 'California',
  cn: 'Canal Zone',
  co: 'Colorado',
  ct: 'Connecticut',
  dc: 'District of Columbia',
  de: 'Delaware',
  fl: 'Florida',
  ga: 'Georgia',
  gu: 'Guam',
  hi: 'Hawaii',
  ia: 'Iowa',
  id: 'Idaho',
  il: 'Illinois',
  in: 'Indiana',
  jn: 'Johnston Island',
  ks: 'Kansas',
  ky: 'Kentucky',
  la: 'Louisiana',
  ma: 'Massachusetts',
  md: 'Maryland',
  me: 'Maine',
  mi: 'Michigan',
  mn: 'Minnesota',
  mo: 'Missouri',
  ms: 'Mississippi',
  mt: 'Montana',
  mw: 'Midway Islands',
  nc: 'North Carolina',
  nd: 'North Dakota',
  ne: 'Nebraska',
  nh: 'New Hampshire',
  nj: 'New Jersey',
  nm: 'New Mexico',
  nv: 'Nevada',
  ny: 'New York',
  oh: 'Ohio',
  ok: 'Oklahoma',
  or: 'Oregon',
  pa: 'Pennsylvania',
  pc: 'Pacific Islands (Trust Territory)',
  pr: 'Puerto Rico',
  ri: 'Rhode Island',
  sc: 'South Carolina',
  sd: 'South Dakota',
  tn: 'Tennessee',
  tx: 'Texas',
  ut: 'Utah',
  va: 'Virginia',
  vi: 'Virgin Islands',
  vt: 'Vermont',
  wa: 'Washington',
  wi: 'Wisconsin',
  wk: 'Wake Island',
  wv: 'West Virginia',
  wy: 'Wyoming',
};

/** The address of a state's metadata file. */
export const censusStateUrl = (code: string): string =>
  `${CENSUS_BUCKET}metadata/json/${code}.json`;

// ---- the listing ----------------------------------------------------------

/** One state file as the bucket lists it. */
export interface CensusListed {
  /** Two lower-case letters. */
  code: string;
  /** The size of the file. */
  bytes: number;
  /** The file's last-changed day, `YYYY-MM-DD`. */
  modified: string;
  /** As the bucket says it, with its quotes. */
  etag: string;
}

const KEY = /^metadata\/json\/([a-z]{2})\.json$/;

const xmlText = (block: string, tag: string): string | null => {
  const found = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return found?.[1] ?? null;
};

/**
 * The state files of the bucket's listing (S3's ListObjectsV2 answer, XML).
 * A key that is not `metadata/json/<code>.json` of a code the app has a name
 * for, or that has no size, day or ETag, is left out. Throws a
 * `ConnectorError` of kind "format" when the text is no listing, or lists no
 * state file.
 */
export function parseCensusListing(xml: string): CensusListed[] {
  if (!/<ListBucketResult[\s>]/.test(xml)) {
    throw new ConnectorError('format', 'The answer is not a listing of the census bucket.');
  }
  const found = new Map<string, CensusListed>();
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1] ?? '';
    const code = KEY.exec(xmlText(block, 'Key') ?? '')?.[1];
    if (code === undefined || CENSUS_CODES[code] === undefined || found.has(code)) continue;
    const size = xmlText(block, 'Size') ?? '';
    const day = (xmlText(block, 'LastModified') ?? '').slice(0, 10);
    const etag = (xmlText(block, 'ETag') ?? '').replace(/&quot;/g, '"').trim();
    if (!/^\d{1,12}$/.test(size) || Number(size) < 1) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!/^"[0-9a-zA-Z-]{1,64}"$/.test(etag)) continue;
    found.set(code, { code, bytes: Number(size), modified: day, etag });
  }
  if (found.size === 0) {
    throw new ConnectorError('format', 'The listing of the census bucket holds no state file.');
  }
  return [...found.values()].sort((a, b) =>
    (CENSUS_CODES[a.code] ?? '').localeCompare(CENSUS_CODES[b.code] ?? ''),
  );
}

// ---- one state's file -----------------------------------------------------

/** The columns of a pack of this kind, in order. */
export const CENSUS_COLUMNS = [
  'state',
  'abbreviation',
  'county',
  'ed',
  'description',
  'reservation',
  'roll',
  'description_image',
  'folder',
  'files',
  'maps',
  'pages',
] as const;
/** The column that holds a district's long list of page files; a list never reads it. */
export const CENSUS_FILES_COLUMN = 'files';

export const CENSUS_MAX_DISTRICTS = 20_000;
export const CENSUS_MAX_PAGES = 5_000;
/** Real states have at most 254 counties; every county of a pack must be reachable in a list of counties. */
export const CENSUS_MAX_COUNTIES = 5_000;
const MAX_MAPS = 200;

const PATH = /^[A-Za-z0-9._/ -]{1,300}$/;
const FILE = /^[A-Za-z0-9._-]{1,120}\.jpg$/;

/** True for a folder or file path of the bucket: no `..`, no empty or dotted segment, no leading slash. */
export function isCensusPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    PATH.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** True for the name of a page image. */
export const isCensusFile = (value: unknown): value is string =>
  typeof value === 'string' && FILE.test(value) && !value.startsWith('.');

/** One enumeration district (or, for a territory, the whole list of its pages). */
export interface CensusRow {
  state: string;
  /** Upper case, as the file gives it. */
  abbreviation: string;
  /** Empty for a territory. */
  county: string;
  /** Empty for a territory. */
  ed: string;
  description: string;
  reservation: string;
  roll: string;
  descriptionImage: string;
  folder: string;
  files: string[];
  maps: string[];
}

export interface CensusParse {
  state: string;
  abbreviation: string;
  rows: CensusRow[];
  /** Districts in the file, the left-out ones included. */
  districts: number;
  /** Districts left out because a path, a file name or a list was not as it must be. */
  skippedDistricts: number;
  /** Map and description images left out for the same reason. */
  skippedImages: number;
}

/** True when so few were left out that a pack may still be made: at most 1% of the districts. */
export const censusSkipAcceptable = (skipped: number, total: number): boolean =>
  skipped * 100 <= total;

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A text of the file, made safe to keep; numbers are taken as their digits. */
function text(value: unknown, max: number): string {
  const read = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof read === 'string' ? cleanText(read, max) : '';
}

/**
 * Reads one state's metadata file, already parsed from JSON. The file's own
 * `baseurl` is ignored: the app uses the bucket's address it knows. Throws a
 * `ConnectorError` of kind "format" when the file is not a state's, or has
 * more districts or pages than the limits allow.
 */
export function parseCensusState(json: unknown): CensusParse {
  const file = object(json);
  if (file === null) throw new ConnectorError('format', 'The file is not a state of the census.');
  const state = text(file['state'], 100);
  const abbreviation = text(file['abbreviation'], 2).toUpperCase();
  if (state === '' || !/^[A-Z]{2}$/.test(abbreviation)) {
    throw new ConnectorError('format', 'The file names no state: it is not a file of the census.');
  }
  const rows: CensusRow[] = [];
  let districts = 0;
  let skippedDistricts = 0;
  let skippedImages = 0;

  /** The images of a district; null when its page list is not one the app keeps. */
  const imagesOf = (
    schedule: unknown,
    maps: unknown,
    descriptionImage: unknown,
  ): { folder: string; files: string[]; maps: string[]; descriptionImage: string } | null => {
    const sheet = object(schedule);
    const files = sheet?.['files'];
    const folder = sheet?.['folder'];
    if (!isCensusPath(folder) || !Array.isArray(files)) return null;
    if (files.length < 1 || files.length > CENSUS_MAX_PAGES) return null;
    if (!files.every(isCensusFile)) return null;
    const keptMaps: string[] = [];
    for (const map of Array.isArray(maps) ? (maps as unknown[]).slice(0, MAX_MAPS) : []) {
      if (isCensusPath(map)) keptMaps.push(map);
      else skippedImages += 1;
    }
    let image = '';
    if (descriptionImage !== undefined && descriptionImage !== null && descriptionImage !== '') {
      if (isCensusPath(descriptionImage)) image = descriptionImage;
      else skippedImages += 1;
    }
    return { folder, files: files as string[], maps: keptMaps, descriptionImage: image };
  };

  const counties = file['county/city'];
  if (Array.isArray(counties)) {
    if (counties.length > CENSUS_MAX_COUNTIES) {
      throw new ConnectorError('format', 'The file has more counties than a state can have.');
    }
    for (const entry of counties as unknown[]) {
      const county = object(entry);
      const name = text(county?.['name'], 200);
      const list = county?.['enumeration'];
      if (county === null || !Array.isArray(list)) {
        districts += 1;
        if (districts > CENSUS_MAX_DISTRICTS) {
          throw new ConnectorError('format', 'The file has more districts than a state can have.');
        }
        skippedDistricts += 1;
        continue;
      }
      for (const raw of list as unknown[]) {
        districts += 1;
        if (districts > CENSUS_MAX_DISTRICTS) {
          throw new ConnectorError('format', 'The file has more districts than a state can have.');
        }
        const district = object(raw);
        const ed = text(district?.['ed'], 40);
        const images =
          district === null
            ? null
            : imagesOf(
                district['schedule_image'],
                district['map_image'],
                district['description_image'],
              );
        if (district === null || name === '' || ed === '' || images === null) {
          skippedDistricts += 1;
          continue;
        }
        rows.push({
          state,
          abbreviation,
          county: name,
          ed,
          description: text(district['description'], 20_000),
          reservation: text(district['reservation'], 200),
          roll: text(district['roll'], 40),
          ...images,
        });
      }
    }
  } else {
    // A territory has no counties or districts: its pages are listed at the top.
    districts = 1;
    const images = imagesOf(file['schedule_image'], file['map_image'], undefined);
    if (images === null) skippedDistricts = 1;
    else {
      rows.push({
        state,
        abbreviation,
        county: '',
        ed: '',
        description: '',
        reservation: '',
        roll: '',
        ...images,
      });
    }
  }
  return { state, abbreviation, rows, districts, skippedDistricts, skippedImages };
}

// ---- addresses ------------------------------------------------------------

/**
 * The address of a page image: the bucket's own, the folder and the file
 * encoded segment by segment. Null when either is not as the bucket's own
 * are, or the address leads anywhere but the bucket.
 */
export function censusImageUrl(folder: unknown, file: unknown): string | null {
  if (!isCensusPath(folder) || !isCensusFile(file)) return null;
  const url = `${CENSUS_BUCKET}${[...folder.split('/'), file].map(encodeURIComponent).join('/')}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === CENSUS_HOST && parsed.search === ''
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * The address of a district at the National Archives' census site. The keys
 * are those the site's own code puts in its search address, in its sorted
 * order, the values encoded. NOT VERIFIED: that this address opens the
 * district has not been tried in a browser. A territory has no county or
 * district, so the address names its state only.
 */
export function censusDistrictUrl(row: {
  abbreviation: string;
  county: string;
  ed: string;
}): string | null {
  if (!/^[A-Z]{2}$/.test(row.abbreviation)) return null;
  const pairs: [string, string][] = [];
  if (row.county !== '') pairs.push(['county', row.county]);
  if (row.ed !== '') pairs.push(['ed', row.ed]);
  pairs.push(['state', row.abbreviation]);
  return `${CENSUS_SITE}/search/?${pairs
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

/**
 * What a citation of a page names as its page: the state, the county and the
 * district (a territory has neither), the image of the district and its roll.
 */
export function censusCitationPage(
  row: { state: string; county: string; ed: string; roll: string },
  page: number,
  pages: number,
  max: number,
): string {
  const parts = [row.state];
  if (row.county !== '') parts.push(row.county);
  if (row.ed !== '') parts.push(`ED ${row.ed}`);
  parts.push(`image ${page} of ${pages}`);
  if (row.roll !== '') parts.push(`roll ${row.roll}`);
  return cleanText(parts.join(', '), max);
}
