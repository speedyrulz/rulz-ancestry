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
import { internetArchiveManifest } from './manifest';

/**
 * The search for books and other texts at the Internet Archive, through its
 * advancedsearch.php, tried against the service on 2026-11-13.
 *
 * It looks in what is written about an item: its title, its author, its
 * subjects, its description. It does not look inside the text of a book. A
 * family history is found by the family's name in its title, not by a person
 * it names on page 212. The years of a query are not sent: they would be
 * compared with the year a book was published, which says little about whom
 * it is about.
 */

/** Where an item's page is, for the user's browser. */
export const INTERNET_ARCHIVE_ITEM_URL = 'https://archive.org/details/';

/** How many results are asked for at a time at most. */
export const INTERNET_ARCHIVE_PAGE_LIMIT = 100;

/** Results beyond this many are not asked for; a narrower search serves better. */
export const INTERNET_ARCHIVE_LAST_OFFSET = 1000;

const FIELDS = ['identifier', 'title', 'creator', 'year', 'publisher'];

/** Only what must be there is asked of the shape; every field of an item is read with care below. */
const answerSchema = z.looseObject({
  response: z.looseObject({
    numFound: z.unknown().optional(),
    docs: z.array(z.unknown()),
  }),
});

/** An item's name at the Archive: letters, digits, dots, hyphens and underscores. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field that the Archive gives as one text or as a list of them. */
function textOf(value: unknown): string {
  const parts = Array.isArray(value) ? value.slice(0, 5) : [value];
  return cleanText(
    parts
      .map((part) => cleanText(part))
      .filter((part) => part !== '')
      .join('; '),
  );
}

function yearOf(value: unknown): string {
  const year = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : value;
  return typeof year === 'number' ? externalDate(year, 0, 0) : '';
}

/** One item as a record; null when it comes without a name the app can make a link of. */
function recordOf(doc: unknown): TextRecord | null {
  if (!isObject(doc)) return null;
  const identifier = doc['identifier'];
  if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) return null;
  return {
    connectorId: internetArchiveManifest.id,
    key: identifier,
    kind: 'text',
    title: textOf(doc['title']) || identifier,
    url: INTERNET_ARCHIVE_ITEM_URL + encodeURIComponent(identifier),
    date: yearOf(doc['year']),
    by: textOf(doc['creator']) || textOf(doc['publisher']),
  };
}

/** Reads the Archive's answer to a search. Throws a `ConnectorError` when it is not one. */
export function parseInternetArchiveSearch(data: unknown, asked: PageRequest): Page<TextRecord> {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError(
      'format',
      'The Internet Archive answered in a way the app cannot read.',
    );
  }
  // No more than was asked for is taken, whatever comes.
  const docs = parsed.data.response.docs.slice(0, asked.limit);
  const seen = new Set<string>();
  const items = docs
    .map(recordOf)
    .filter((record) => record !== null)
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  const found = parsed.data.response.numFound;
  const total = typeof found === 'number' && Number.isInteger(found) && found >= 0 ? found : null;
  // Results are asked for a page at a time, so the next ones are those of
  // the next page, however few came with this one. Counting what came would
  // ask for the same page again after a short one.
  const after = asked.offset + asked.limit;
  const more =
    docs.length > 0 &&
    (total === null ? docs.length === asked.limit : after < total) &&
    after <= INTERNET_ARCHIVE_LAST_OFFSET;
  return {
    items,
    total,
    next: more ? { offset: after, limit: asked.limit } : null,
    hidden: 0,
  };
}

/**
 * The words of a query as the Archive's search may read them: the signs that
 * mean something to its query language are taken out, and the words are put
 * in small letters, because AND, OR, NOT and TO in capitals are commands to it.
 */
export function internetArchiveWords(query: TextQuery): string {
  return textQueryWords(query)
    .replace(/[^\p{L}\p{N}\p{M}'.,\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The page that is asked for: the Archive counts pages of results from 1. */
function pageOf(page: PageRequest): PageRequest & { number: number } {
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), INTERNET_ARCHIVE_PAGE_LIMIT));
  const offset = Math.max(0, Math.min(Math.trunc(page.offset), INTERNET_ARCHIVE_LAST_OFFSET));
  const number = Math.floor(offset / limit) + 1;
  return { limit, offset: (number - 1) * limit, number };
}

/** What is sent to the Archive for a search: the words, and nothing else. */
export function internetArchiveSearchParams(
  query: TextQuery,
  page: PageRequest,
): Record<string, string | number | undefined> {
  const asked = pageOf(page);
  const words = internetArchiveWords(query);
  const params: Record<string, string | number | undefined> = {
    q: `(${query.phrase ? `"${words}"` : words}) AND mediatype:texts`,
  };
  FIELDS.forEach((field, index) => {
    params[`fl[${index}]`] = field;
  });
  return { ...params, rows: asked.limit, page: asked.number, output: 'json' };
}

export function internetArchiveConnector(client: SourceClient): TextConnector {
  if (client.manifest.id !== internetArchiveManifest.id) {
    throw new Error('the Internet Archive connector needs the client of the Archive');
  }
  return {
    manifest: internetArchiveManifest,
    async searchTexts(query, page, options = {}) {
      if (internetArchiveWords(query) === '') {
        throw new ConnectorError('refused', 'Give words to search for.');
      }
      const asked = pageOf(page);
      const answer = await client.getJson('', {
        params: internetArchiveSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parseInternetArchiveSearch(answer.data, asked),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
