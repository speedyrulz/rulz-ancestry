import {
  textQueryWords,
  type Page,
  type PageRequest,
  type TextQuery,
  type TextRecord,
} from '@rulz/core';
import { z } from 'zod';
import { ConnectorError, cleanText, type TextConnector } from '../../connector';
import type { SourceClient } from '../../http';
import { naraCatalogManifest } from './manifest';

/**
 * The search of the catalog of the US National Archives, through its Catalog
 * API, version 2.
 *
 * It needs the user's own key, which the client of the source sends in a
 * header; nothing here sees it. The connector was written from the API's own
 * specification and its getting-started guide, without a key, and has not
 * been tried against the service. It reads an answer with care for that
 * reason: what is not as the guide shows it is left out, not guessed at.
 *
 * A result is the description of something the Archives hold: a series, a
 * file, an item. It is found by words in the description. Only the words are
 * sent; the years of a query are not, because the catalog's dates are those
 * of the records, and what they mean for a search has not been tried.
 */

/** Where a description's page is, for the user's browser. */
export const NARA_RECORD_URL = 'https://catalog.archives.gov/id/';

/** How many results are asked for at a time at most. The API allows 1,000. */
export const NARA_PAGE_LIMIT = 100;

/** Results beyond this many are not asked for; every page costs one of the month's requests. */
export const NARA_LAST_OFFSET = 1000;

/** The fields of a description that are asked for. The rest would make an answer large. */
const FIELDS = [
  'naId',
  'title',
  'levelOfDescription',
  'inclusiveStartDate',
  'inclusiveEndDate',
  'coverageStartDate',
  'coverageEndDate',
  'productionDates',
].join(',');

/** Only what must be there is asked of the shape; every field of a description is read with care below. */
const answerSchema = z.looseObject({
  body: z.looseObject({
    hits: z.looseObject({
      total: z.unknown().optional(),
      hits: z.array(z.unknown()),
    }),
  }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The levels of the Archives' descriptions, in words. */
const LEVELS: Readonly<Record<string, string>> = {
  recordGroup: 'Record group',
  collection: 'Collection',
  series: 'Series',
  fileUnit: 'File unit',
  item: 'Item',
};

/** The year of a date as the catalog gives one: an object with a year; null when it is none. */
function yearOf(value: unknown): number | null {
  const date = Array.isArray(value) ? value[0] : value;
  if (!isObject(date)) return null;
  const year = typeof date['year'] === 'string' ? Number(date['year']) : date['year'];
  return typeof year === 'number' && Number.isInteger(year) && year >= 1 && year <= 9999
    ? year
    : null;
}

/**
 * The years a description covers, in words: "1862–1910"; empty when it gives
 * none. They are years and no more, so they are not written as dates: a date
 * would be read as its first or its last day.
 */
function yearsOf(record: Record<string, unknown>): string {
  const from =
    yearOf(record['inclusiveStartDate']) ??
    yearOf(record['coverageStartDate']) ??
    yearOf(record['productionDates']);
  const to = yearOf(record['inclusiveEndDate']) ?? yearOf(record['coverageEndDate']);
  const first = from ?? to;
  if (first === null) return '';
  const last = to ?? first;
  return last > first ? `${first}–${last}` : String(first);
}

/** One hit as a record; null when it is no description the app can name. */
function recordOf(hit: unknown): TextRecord | null {
  const source = isObject(hit) ? hit['_source'] : null;
  const record = isObject(source) ? source['record'] : null;
  if (!isObject(record)) return null;
  const id = typeof record['naId'] === 'number' ? String(record['naId']) : record['naId'];
  if (typeof id !== 'string' || !/^[1-9]\d{0,14}$/.test(id)) return null;
  const level = record['levelOfDescription'];
  return {
    connectorId: naraCatalogManifest.id,
    key: id,
    kind: 'text',
    title: cleanText(record['title']) || `National Archives Identifier ${id}`,
    url: NARA_RECORD_URL + id,
    // What kind of thing it is, and the years it covers.
    date: '',
    by: '',
    about: [
      typeof level === 'string' ? (LEVELS[level] ?? cleanText(level, 40)) : '',
      yearsOf(record),
    ]
      .filter((part) => part !== '')
      .join(', '),
  };
}

/** Reads the catalog's answer to a search. Throws a `ConnectorError` when it is not one. */
export function parseNaraSearch(data: unknown, asked: PageRequest): Page<TextRecord> {
  // The catalog can say inside an answer that it is an error: its own
  // examples look at a status in the body, not only at the one of the answer.
  const status = isObject(data) ? data['statusCode'] : undefined;
  if (typeof status === 'number' && status !== 200) {
    throw status === 401 || status === 403
      ? new ConnectorError(
          'key',
          'The National Archives did not accept the key. It may be mistyped, no longer valid, or over its limit.',
        )
      : new ConnectorError(
          'refused',
          `The National Archives did not search: it answered with error ${Math.trunc(status)}.`,
        );
  }
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError(
      'format',
      'The National Archives answered in a way the app cannot read.',
    );
  }
  // No more than was asked for is taken, whatever comes.
  const hits = parsed.data.body.hits.hits.slice(0, asked.limit);
  const seen = new Set<string>();
  const items = hits
    .map(recordOf)
    .filter((record) => record !== null)
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  // The count comes as a number, or as an object with the number in it.
  const count = parsed.data.body.hits.total;
  const value = isObject(count) ? count['value'] : count;
  const total = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  const after = asked.offset + asked.limit;
  const more =
    hits.length > 0 &&
    (total === null ? hits.length === asked.limit : after < total) &&
    after <= NARA_LAST_OFFSET;
  return {
    items,
    total,
    next: more ? { offset: after, limit: asked.limit } : null,
    hidden: 0,
  };
}

/**
 * The words of a query as the catalog is sent them. Its search reads
 * quotation marks, an asterisk and AND, OR and NOT in capitals as commands,
 * so the signs are taken out and the words are put in small letters.
 */
export function naraWords(query: TextQuery): string {
  return textQueryWords(query)
    .replace(/[^\p{L}\p{N}\p{M}'’.,\-\s]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The page that is asked for: the catalog counts pages of results from 1. */
function pageOf(page: PageRequest): PageRequest & { number: number } {
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), NARA_PAGE_LIMIT));
  const offset = Math.max(0, Math.min(Math.trunc(page.offset), NARA_LAST_OFFSET));
  const number = Math.floor(offset / limit) + 1;
  return { limit, offset: (number - 1) * limit, number };
}

/**
 * What is put into the address of a search: the words, and nothing else of a
 * tree. The key is not here: the client sends it in a header.
 */
export function naraSearchParams(
  query: TextQuery,
  page: PageRequest,
): Record<string, string | number | undefined> {
  const asked = pageOf(page);
  const words = naraWords(query);
  return {
    q: query.phrase ? `"${words}"` : words,
    // Descriptions of records, not the Archives' lists of people and organisations.
    dataSource: 'description',
    sourceIncludes: FIELDS,
    limit: asked.limit,
    page: asked.number,
  };
}

export function naraCatalogConnector(client: SourceClient): TextConnector {
  if (client.manifest.id !== naraCatalogManifest.id) {
    throw new Error('the National Archives connector needs the client of the National Archives');
  }
  return {
    manifest: naraCatalogManifest,
    async searchTexts(query, page, options = {}) {
      if (naraWords(query) === '') {
        throw new ConnectorError('refused', 'Give words to search for.');
      }
      const asked = pageOf(page);
      const answer = await client.getJson('records/search', {
        params: naraSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parseNaraSearch(answer.data, asked),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
