import { ConnectorError, cleanText } from '../../connector';

/**
 * Open Archives' catalogue of its archives, and the page of one archive, read
 * as plain data. Nothing here asks for anything: the caller fetches the text
 * and hands it in. Both are untrusted, so every text is cleaned and every
 * address is checked against the one pattern it may have.
 */

/** The catalogue as JSON-LD. Asked for at this address directly, because the well-known address redirects. */
export const OA_CATALOGUE_URL = 'https://www.openarchieven.nl/datasets/datacatalog.jsonld';

/** The host of the catalogue and of the archives' pages. */
export const OA_SITE_HOST = 'www.openarchieven.nl';

/** The host the CSV files of the archives are kept on. */
export const OA_CSV_HOST = 'oa-export.s3.nl-ams.scw.cloud';

/** The page of an archive, which links its CSV files. */
export function oaDatasetPageUrl(code: string): string {
  return `https://${OA_SITE_HOST}/datasets/${code}`;
}

/** What a code of an archive looks like, as the catalogue and the pack id need it. */
export const OA_CODE_PATTERN = /^[a-z0-9]{2,10}$/;

/** An archive of the catalogue that is offered: CC0 only. */
export interface OaArchive {
  code: string;
  name: string;
  /** The years it covers, as the catalogue gives them, e.g. "1798/1909". */
  period: string | null;
  records: number | null;
  /** The catalogue's last-changed day, `YYYY-MM-DD`. */
  modified: string | null;
  licence: 'CC0';
}

const SCHEMA = 'https://schema.org/';
const ID_PATTERN = /^https:\/\/www\.openarchieven\.nl\/id\/dataset_([a-z0-9]{2,10})$/;
const CC0_PATTERN = /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/;
/** The deed of CC0 as a page links it, with or without the deed's own file name. */
const CC0_DEED_PATTERN =
  /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?(?:deed(?:\.[a-z-]{2,8})?)?$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NODES = 1000;
const MAX_FILES = 40;

interface Value {
  value: string;
  lang: string | null;
}

/** The values of one property of a JSON-LD node, in expanded or plain form. */
function valuesOf(node: Record<string, unknown>, property: string): Value[] {
  const raw = node[`${SCHEMA}${property}`];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const found: Value[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      found.push({ value: item, lang: null });
    } else if (item !== null && typeof item === 'object') {
      const entry = item as Record<string, unknown>;
      const text = entry['@value'] ?? entry['@id'];
      if (typeof text === 'string') {
        const lang = entry['@language'];
        found.push({ value: text, lang: typeof lang === 'string' ? lang.toLowerCase() : null });
      }
    }
  }
  return found;
}

function hasType(node: Record<string, unknown>): boolean {
  const type = node['@type'];
  const list = Array.isArray(type) ? type : [type];
  return list.some((entry) => entry === `${SCHEMA}Dataset` || entry === 'Dataset');
}

/** A text in a language, then in another, else none. */
function pick(values: Value[], languages: readonly string[]): string | null {
  for (const language of languages) {
    const found = values.find(
      (entry) => entry.lang === language || entry.lang?.startsWith(`${language}-`),
    );
    if (found !== undefined) return found.value;
  }
  return null;
}

function recordsOf(description: string | null): number | null {
  if (description === null) return null;
  const match = /(\d[\d,.]*) records/.exec(description);
  const digits = match?.[1]?.replace(/[^\d]/g, '') ?? '';
  if (digits === '' || digits.length > 12) return null;
  return Number(digits);
}

/**
 * The CC0 archives of the catalogue, by name. Throws a `ConnectorError` when
 * the text is not a list of nodes with at least one dataset in it.
 */
export function parseOaCatalogue(json: unknown): OaArchive[] {
  if (!Array.isArray(json)) {
    throw new ConnectorError('format', 'The catalogue of Open Archives is not a list.');
  }
  const archives: OaArchive[] = [];
  const seen = new Set<string>();
  let datasets = 0;
  for (const node of json) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const entry = node as Record<string, unknown>;
    if (!hasType(entry)) continue;
    datasets += 1;
    if (datasets > MAX_NODES) break;
    const code = typeof entry['@id'] === 'string' ? ID_PATTERN.exec(entry['@id'])?.[1] : undefined;
    if (code === undefined || seen.has(code)) continue;
    const licences = valuesOf(entry, 'license');
    if (
      licences.length === 0 ||
      !licences.every((licence) => CC0_PATTERN.test(licence.value.trim()))
    ) {
      continue;
    }
    const name = cleanText(pick(valuesOf(entry, 'name'), ['en', 'nl']), 200);
    if (name === '') continue;
    const period = cleanText(valuesOf(entry, 'temporalCoverage')[0]?.value, 40);
    const modified = valuesOf(entry, 'dateModified')[0]?.value.trim() ?? '';
    seen.add(code);
    archives.push({
      code,
      name,
      period: period === '' ? null : period,
      records: recordsOf(pick(valuesOf(entry, 'description'), ['en'])),
      modified: DAY_PATTERN.test(modified) ? modified : null,
      licence: 'CC0',
    });
  }
  if (datasets === 0) {
    throw new ConnectorError('format', 'The catalogue of Open Archives lists no archives.');
  }
  return archives.sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.code.localeCompare(b.code),
  );
}

/**
 * What an archive's page says: the CSV files it links (those of this code
 * only, each address exactly of the one shape, no more than 40) and whether
 * every licence link on it is the CC0 deed, with at least one.
 */
export function parseOaDatasetPage(html: string, code: string): { files: string[]; cc0: boolean } {
  if (!OA_CODE_PATTERN.test(code)) return { files: [], cc0: false };
  const file = new RegExp(
    `^https://${OA_CSV_HOST.replace(/\./g, '\\.')}/csv/${code}\\.[a-z0-9_]{1,20}\\.csv\\.gz$`,
  );
  const files: string[] = [];
  for (const match of html.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1]?.toLowerCase() !== 'href') continue;
    const href = match[2] ?? match[3] ?? match[4] ?? '';
    if (href.includes('&') || !file.test(href) || files.includes(href)) continue;
    files.push(href);
    if (files.length >= MAX_FILES) break;
  }
  let licences = 0;
  let cc0 = true;
  for (const tag of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    const text = tag[0];
    const rel = attributeOf(text, 'rel');
    if (rel === undefined || !rel.toLowerCase().split(/\s+/).includes('license')) continue;
    licences += 1;
    const href = attributeOf(text, 'href')?.trim() ?? '';
    if (!CC0_DEED_PATTERN.test(href)) cc0 = false;
  }
  return { files, cc0: licences > 0 && cc0 };
}

/** One attribute: its name, then its value double-quoted, single-quoted or bare. */
const ATTRIBUTE_PATTERN = /([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;

/** The value of the first attribute of this name in a tag, in any of the three forms. */
function attributeOf(tag: string, name: string): string | undefined {
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    if (match[1]?.toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return undefined;
}
