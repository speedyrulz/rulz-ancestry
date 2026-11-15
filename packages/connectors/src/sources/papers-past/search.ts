import {
  externalDate,
  textQueryWords,
  type Page,
  type PageRequest,
  type TextQuery,
  type TextRecord,
} from '@rulz/core';
import { z } from 'zod';
import { ConnectorError, cleanText, type TextConnector } from '../../connector';
import type { SourceClient } from '../../http';
import { papersPastManifest } from './manifest';

/**
 * The search of Papers Past, the newspapers of the National Library of New
 * Zealand, through the Records API, version 3, of DigitalNZ.
 *
 * It asks without a key unless the user saved one; nothing here sees it. Only
 * the headline, the newspaper, the date and the address of the page are asked
 * for, never the text of an article (`citeOnly`): the terms ask that nothing
 * of an answer be kept.
 */

/** The only site an article's page may be on. */
const SITE_HOST = 'paperspast.natlib.govt.nz';

/** The first year Papers Past holds anything of. */
export const PAPERS_PAST_FIRST_YEAR = 1839;

/** Results asked for at a time. */
export const PAPERS_PAST_PAGE_SIZE = 20;

/** Results beyond this many are not asked for; every page costs one request. */
export const PAPERS_PAST_LAST_OFFSET = 1000;

/** A DigitalNZ record number: whole digits. */
const ID = /^\d{1,15}$/;

/** The fields asked for. Never the text or a description, which can be long. */
const FIELDS = 'id,title,display_date,date,publisher,collection_title,landing_url';

/**
 * The shape asked of an answer. The documentation of version 3 shows the
 * count and the results at the top of the answer; a `search` wrapper is read
 * too. Each result is read with care below.
 */
const answerSchema = z.looseObject({
  search: z.unknown().optional(),
  result_count: z.unknown().optional(),
  results: z.unknown().optional(),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The texts of a value that is a text or a list of them. */
function texts(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((part) => cleanText(part, 200)).filter((part) => part !== '');
}

const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** A date as GEDCOM words, from a written date ("12 March 1895", "March 1895", "1895") or a timestamp. */
function dateOf(display: unknown, stamp: unknown): string {
  const written = typeof display === 'string' ? display.trim() : '';
  const words = /^(?:(\d{1,2})\s+)?(?:([A-Za-z]{3})[A-Za-z]*\.?\s+)?(\d{4})$/.exec(written);
  if (words?.[3] !== undefined) {
    const month = words[2] === undefined ? 0 : (MONTH_NUMBERS[words[2].toLowerCase()] ?? -1);
    const day = words[1] === undefined ? 0 : Number(words[1]);
    // A day without a month is no date.
    if (month >= 0 && !(month === 0 && day !== 0)) {
      const found = externalDate(Number(words[3]), month, day);
      if (found !== '') return found;
    }
  }
  const first = Array.isArray(stamp) ? stamp[0] : stamp;
  const iso = typeof first === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(first) : null;
  return iso === null ? '' : externalDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
}

/** True when the address is an https page on Papers Past, and no more. */
function onSite(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === SITE_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/** One result as a record; null when it is no article the app can name and link. */
function recordOf(result: unknown): TextRecord | null {
  if (!isObject(result)) return null;
  const raw = result['id'];
  const id = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : raw;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const landing = result['landing_url'];
  if (!onSite(landing)) return null;
  const newspaper = texts(result['collection_title']).find((name) => name !== 'Papers Past');
  return {
    connectorId: papersPastManifest.id,
    key: id,
    kind: 'text',
    title: cleanText(result['title'], 500) || `Papers Past item ${id}`,
    url: landing,
    date: dateOf(result['display_date'], result['date']),
    by: newspaper ?? texts(result['publisher'])[0] ?? '',
    about: '',
  };
}

/** Reads DigitalNZ's answer to a search. Throws a `ConnectorError` when it is not one. */
export function parsePapersPastSearch(data: unknown, asked: PageRequest): Page<TextRecord> {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError('format', 'DigitalNZ answered in a way the app cannot read.');
  }
  const body = isObject(parsed.data.search) ? parsed.data.search : parsed.data;
  const results = body['results'];
  if (!Array.isArray(results)) {
    throw new ConnectorError('format', 'DigitalNZ answered in a way the app cannot read.');
  }
  const hits = results.slice(0, asked.limit);
  const seen = new Set<string>();
  const items = hits
    .map(recordOf)
    .filter((record) => record !== null)
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  const count = body['result_count'];
  const total = typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
  const after = asked.offset + asked.limit;
  const more =
    hits.length > 0 &&
    (total === null ? hits.length === asked.limit : after < total) &&
    after <= PAPERS_PAST_LAST_OFFSET;
  return { items, total, next: more ? { offset: after, limit: asked.limit } : null, hidden: 0 };
}

/**
 * The words of a query as DigitalNZ is sent them. Its search reads `date:`,
 * `TO`, brackets, quotation marks, `~ ^ + ! /` and AND, OR and NOT in capitals
 * as commands, so only letters, digits, marks, apostrophes, full stops,
 * commas, hyphens and spaces are kept, and the words go into small letters.
 * A phrase is wrapped in quotation marks after that.
 */
export function papersPastWords(query: TextQuery): string {
  const words = textQueryWords(query)
    .replace(/[^\p{L}\p{N}\p{M}'’.,\-\s]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return query.phrase && words !== '' ? `"${words}"` : words;
}

/**
 * The years as one range, `[A TO B]`; null when there is none. A range with
 * one end is closed with the first year of Papers Past or the current year.
 * Years given that fall outside the collection (a closed range upside down)
 * are refused, so that unfiltered results never look like matches.
 */
export function papersPastYears(query: TextQuery, thisYear: number): string | null {
  const given = (year: number | null) =>
    year !== null && Number.isInteger(year) && year >= 1 && year <= 9999 ? year : null;
  const from = given(query.fromYear);
  const to = given(query.toYear);
  if (from === null && to === null) return null;
  const low = from ?? PAPERS_PAST_FIRST_YEAR;
  const high = to ?? thisYear;
  if (low > high) {
    throw new ConnectorError(
      'refused',
      from !== null && from > thisYear
        ? 'Papers Past holds no newspapers from those years (it ends with this year).'
        : `Papers Past holds no newspapers from those years (it starts in ${PAPERS_PAST_FIRST_YEAR}).`,
    );
  }
  return `[${low} TO ${high}]`;
}

/** The page asked for: DigitalNZ counts pages from 1. */
function pageOf(page: PageRequest): PageRequest & { number: number } {
  const offset = Math.max(0, Math.min(Math.trunc(page.offset), PAPERS_PAST_LAST_OFFSET));
  const number = Math.floor(offset / PAPERS_PAST_PAGE_SIZE) + 1;
  return {
    limit: PAPERS_PAST_PAGE_SIZE,
    offset: (number - 1) * PAPERS_PAST_PAGE_SIZE,
    number,
  };
}

/** What is put into the address of a search. No state, and no key: the client sends that in a header. */
export function papersPastSearchParams(
  query: TextQuery,
  page: PageRequest,
  thisYear = new Date().getFullYear(),
): Record<string, string | number | undefined> {
  const asked = pageOf(page);
  const years = papersPastYears(query, thisYear);
  return {
    text: papersPastWords(query),
    'and[primary_collection][]': 'Papers Past',
    ...(years === null ? {} : { 'and[year][]': years }),
    fields: FIELDS,
    per_page: asked.limit,
    page: asked.number,
  };
}

export function papersPastConnector(client: SourceClient): TextConnector {
  if (client.manifest.id !== papersPastManifest.id) {
    throw new Error('the Papers Past connector needs the client of Papers Past');
  }
  return {
    manifest: papersPastManifest,
    async searchTexts(query, page, options = {}) {
      if (papersPastWords(query) === '') {
        throw new ConnectorError('refused', 'Give words to search for.');
      }
      const asked = pageOf(page);
      const answer = await client.getJson('records.json', {
        params: papersPastSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parsePapersPastSearch(answer.data, asked),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
