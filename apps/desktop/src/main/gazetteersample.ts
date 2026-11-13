import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeZip } from '@rulz/db';
import { GEONAMES_BASE_URL, type GazetteerFetch } from './gazetteer';

/**
 * A few lines of each list GeoNames publishes, and a `fetch` that serves
 * them, for the unit tests of the gazetteer. Not part of the app.
 */

function line(fields: {
  id: number;
  name: string;
  alternates?: string;
  lat: number;
  lon: number;
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
    fields.name,
    fields.alternates ?? '',
    fields.lat,
    fields.lon,
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
    'UTC',
    '2024-01-01',
  ].join('\t');
}

const TEXTS = {
  'countryInfo.txt': [
    '# ISO\tISO3\tISO-Numeric\tfips\tCountry',
    'US\tUSA\t840\tUS\tUnited States',
    'NL\tNLD\t528\tNL\tThe Netherlands',
    'GB\tGBR\t826\tUK\tUnited Kingdom',
  ].join('\n'),
  'admin1CodesASCII.txt': [
    'US.IL\tIllinois\tIllinois\t4896861',
    'US.MO\tMissouri\tMissouri\t4398678',
    'NL.07\tNorth Holland\tNorth Holland\t2749879',
    'GB.ENG\tEngland\tEngland\t6269131',
  ].join('\n'),
  'admin2Codes.txt': [
    'US.IL.167\tSangamon County\tSangamon County\t4250165',
    'US.MO.077\tGreene County\tGreene County\t4388802',
  ].join('\n'),
};

const LISTS = {
  US: [
    line({
      id: 4250542,
      name: 'Springfield',
      fcode: 'PPLA',
      admin1: 'IL',
      admin2: '167',
      lat: 39.80172,
      lon: -89.64371,
      population: 114394,
    }),
    line({
      id: 4409896,
      name: 'Springfield',
      fcode: 'PPLA2',
      admin1: 'MO',
      admin2: '077',
      lat: 37.21533,
      lon: -93.29824,
      population: 170188,
    }),
    line({
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
  ].join('\n'),
  NL: [
    line({
      id: 2759794,
      name: 'Amsterdam',
      fcode: 'PPLC',
      country: 'NL',
      admin1: '07',
      lat: 52.37403,
      lon: 4.88969,
      population: 741636,
    }),
  ].join('\n'),
  cities500: [
    line({
      id: 2633352,
      name: 'York',
      fcode: 'PPLA2',
      country: 'GB',
      admin1: 'ENG',
      lat: 53.95763,
      lon: -1.08271,
      population: 156135,
    }),
  ].join('\n'),
};

/** The countries the sample has a list for. Give them to the service as its `countries`. */
export const SAMPLE_COUNTRIES = ['US', 'NL'] as const;
/** How many places a gazetteer built from the sample holds. */
export const SAMPLE_PLACES = 5;

function zipOf(entry: string, text: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'rulz-gazetteer-sample-'));
  try {
    const file = join(dir, 'list.zip');
    writeZip(file, [{ name: entry, data: Buffer.from(text, 'utf8') }]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The sample files by the name GeoNames gives each. */
export function sampleFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [name, text] of Object.entries(TEXTS)) files.set(name, Buffer.from(text, 'utf8'));
  for (const [name, text] of Object.entries(LISTS)) {
    files.set(`${name}.zip`, zipOf(`${name}.txt`, text));
  }
  return files;
}

export interface SampleFetch {
  fetch: GazetteerFetch;
  /** Every address that was asked for, in order. */
  asked: string[];
}

/**
 * A `fetch` that answers from `files` and with "not found" for anything
 * else. `answer` may answer an address in another way first.
 */
export function sampleFetch(
  files: Map<string, Buffer> = sampleFiles(),
  answer?: (name: string, signal: AbortSignal) => Response | Promise<Response> | undefined,
): SampleFetch {
  const asked: string[] = [];
  const fetch: GazetteerFetch = async (url, init) => {
    asked.push(url);
    if (init.redirect !== 'error') throw new Error('the request would follow a redirect');
    init.signal.throwIfAborted();
    const name = url.startsWith(GEONAMES_BASE_URL) ? url.slice(GEONAMES_BASE_URL.length) : '';
    const other = await answer?.(name, init.signal);
    if (other) return other;
    const bytes = files.get(name);
    if (!bytes) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: { 'content-length': String(bytes.length) },
    });
  };
  return { fetch, asked };
}
