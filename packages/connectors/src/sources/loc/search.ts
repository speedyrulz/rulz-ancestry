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
import { locManifest } from './manifest';

/**
 * The search of the pages of Chronicling America, the newspapers of the
 * Library of Congress, through the JSON API of loc.gov. The address and its
 * parameters are those of the Library's own search form and of its tutorial
 * (libraryofcongress.github.io/data-exploration), tried against the service on
 * 2026-11-13.
 *
 * A result is one page of a newspaper whose machine-read text has the words.
 * The answer does not say where on the page they stand: its `description` is
 * the start of the page's text, not the place of the match, so it is not shown.
 */

/** The collection that is searched, below the address of the manifest. */
export const LOC_NEWSPAPERS_PATH = 'collections/chronicling-america/';

/** Where a page of a newspaper is, for the user's browser. */
export const LOC_RESOURCE_URL = 'https://www.loc.gov/resource/';

/** The Library asks for pages of at most 1,000 results; the app asks for far fewer. */
export const LOC_PAGE_LIMIT = 100;

/** Results beyond this many are not asked for; a narrower search serves better. */
export const LOC_LAST_OFFSET = 1000;

/** Only what must be there is asked of the shape; every field of a result is read with care below. */
const answerSchema = z.looseObject({
  results: z.array(z.unknown()),
  pagination: z.looseObject({ of: z.unknown().optional() }).optional(),
});

/** The path of a page of a newspaper: the paper's number, the day, the edition. */
const RESOURCE_PATH = /^\/resource\/([a-z0-9]{4,20})\/(\d{4})-(\d{2})-(\d{2})\/(ed-\d{1,3})\/$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One result as a record; null when it is not a page of a newspaper the app
 * can name. The link is made by the app from the parts it has checked, and
 * holds nothing of the search.
 */
function recordOf(result: unknown): TextRecord | null {
  if (!isObject(result) || typeof result['id'] !== 'string') return null;
  let id: URL;
  try {
    id = new URL(result['id']);
  } catch {
    return null;
  }
  if (id.hostname !== 'www.loc.gov' && id.hostname !== 'loc.gov') return null;
  const path = RESOURCE_PATH.exec(id.pathname);
  const image = id.searchParams.get('sp') ?? '';
  if (path === null || !/^[1-9]\d{0,3}$/.test(image)) return null;
  const [, paper = '', year = '', month = '', day = '', edition = ''] = path;
  const issue = `${paper}/${year}-${month}-${day}/${edition}`;
  return {
    connectorId: locManifest.id,
    key: `${issue}/seq-${image}`,
    kind: 'text',
    title: cleanText(result['title']) || `Image ${image} of ${paper}, ${year}-${month}-${day}`,
    url: `${LOC_RESOURCE_URL}${issue}/?sp=${image}`,
    date: externalDate(Number(year), Number(month), Number(day)),
    by: '',
  };
}

/** Reads the Library's answer to a search. Throws a `ConnectorError` when it is not one. */
export function parseLocSearch(data: unknown, asked: PageRequest): Page<TextRecord> {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError(
      'format',
      'The Library of Congress answered in a way the app cannot read.',
    );
  }
  // No more than was asked for is taken, whatever comes.
  const results = parsed.data.results.slice(0, asked.limit);
  const seen = new Set<string>();
  const items = results
    .map(recordOf)
    .filter((record) => record !== null)
    // A page that comes twice is shown once.
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  const of = parsed.data.pagination?.of;
  const total = typeof of === 'number' && Number.isInteger(of) && of >= 0 ? of : null;
  // Results are asked for a page at a time, so the next ones are those of
  // the next page, however few came with this one. Counting what came would
  // ask for the same page again after a short one.
  const after = asked.offset + asked.limit;
  const more =
    results.length > 0 &&
    (total === null ? results.length === asked.limit : after < total) &&
    after <= LOC_LAST_OFFSET;
  return {
    items,
    total,
    next: more ? { offset: after, limit: asked.limit } : null,
    // Nothing is held back here: a result the app cannot name is no page of a newspaper.
    hidden: 0,
  };
}

/**
 * The words of a query as the Library is sent them. Quotes, brackets and the
 * other signs a search engine may read as commands are taken out, so that
 * what is typed is looked for and nothing else. A hyphen and an apostrophe
 * stay: names have them.
 */
export function locWords(query: TextQuery): string {
  return textQueryWords(query)
    .replace(/[^\p{L}\p{N}\p{M}'’.,\-\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const fourDigits = (year: number) => String(year).padStart(4, '0');

/** The page that is asked for: the Library counts pages of results from 1. */
function pageOf(page: PageRequest): PageRequest & { number: number } {
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), LOC_PAGE_LIMIT));
  const offset = Math.max(0, Math.min(Math.trunc(page.offset), LOC_LAST_OFFSET));
  const number = Math.floor(offset / limit) + 1;
  return { limit, offset: (number - 1) * limit, number };
}

/** What is sent to the Library for a search: the words, the years, the state, and nothing else. */
export function locSearchParams(
  query: TextQuery,
  page: PageRequest,
): Record<string, string | number | undefined> {
  const asked = pageOf(page);
  return {
    dl: 'page',
    ops: query.phrase ? 'PHRASE' : 'AND',
    qs: locWords(query),
    searchType: 'advanced',
    start_date: query.fromYear === null ? undefined : `${fourDigits(query.fromYear)}-01-01`,
    end_date: query.toYear === null ? undefined : `${fourDigits(query.toYear)}-12-31`,
    location_state: query.state === '' ? undefined : query.state.toLowerCase(),
    fo: 'json',
    // Only the results and their count: the rest of the answer is for the Library's own page.
    at: 'results,pagination',
    c: asked.limit,
    sp: asked.number,
  };
}

export function locConnector(client: SourceClient): TextConnector {
  if (client.manifest.id !== locManifest.id) {
    throw new Error('the Library of Congress connector needs the client of the Library');
  }
  return {
    manifest: locManifest,
    async searchTexts(query, page, options = {}) {
      if (locWords(query) === '') {
        throw new ConnectorError('refused', 'Give words to search for.');
      }
      const asked = pageOf(page);
      const answer = await client.getJson(LOC_NEWSPAPERS_PATH, {
        params: locSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parseLocSearch(answer.data, asked),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
