import {
  PRESUMED_DEAD_AFTER_YEARS,
  QUERY_YEAR_SPREAD,
  externalDate,
  isLongAgo,
  type EventRecord,
  type Page,
  type PageRequest,
  type PersonQuery,
} from '@rulz/core';
import { z } from 'zod';
import { ConnectorError, cleanText, type PersonConnector } from '../../connector';
import type { SourceClient } from '../../http';
import { openArchivesManifest } from './manifest';

/**
 * The search for a person in the records of Dutch and Belgian archives that
 * Open Archives indexes, through its `records/search.json`, tried against the
 * service on 2026-11-13.
 *
 * A result is a record of an event that names the person in some role: the
 * child of a birth record, a witness of a marriage. The years of a query are
 * sent as the span of years the event may lie in, which is how the service
 * reads a span after a name.
 */

/** Where a record's page is, for the user's browser. */
export const OPEN_ARCHIVES_RECORD_URL = 'https://www.openarchieven.nl/';

/** The service gives at most this many results at a time. */
export const OPEN_ARCHIVES_PAGE_LIMIT = 100;

/** Results beyond this many are not asked for; a narrower search serves better. */
export const OPEN_ARCHIVES_LAST_OFFSET = 1000;

/** Only what must be there is asked of the shape; every field of a result is read with care below. */
const answerSchema = z.looseObject({
  response: z.looseObject({
    number_found: z.unknown().optional(),
    // Left out by the service when nothing is found.
    docs: z.array(z.unknown()).optional(),
  }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The words the service uses for the record of a death and for the one who died, in English and in Dutch. */
const DEATH_EVENTS = new Set(['death', 'burial', 'overlijden', 'begraven']);
const DECEASED_ROLES = new Set(['deceased', 'overledene']);

const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/**
 * One result as a record; null when it is left out. A record that the app
 * cannot name is left out, and so is one that names a person who may be
 * living: the app shows no living people of others. A person counts as dead
 * when the record is of their own death, or of an event long enough ago.
 */
function recordOf(doc: unknown, thisYear: number): EventRecord | null {
  if (!isObject(doc)) return null;
  const archive = doc['archive_code'];
  const identifier = doc['identifier'];
  const person = doc['pid'];
  if (typeof archive !== 'string' || !/^[a-z0-9]{2,12}$/.test(archive)) return null;
  if (typeof identifier !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(identifier)) return null;
  if (typeof person !== 'string' || !/^[A-Za-z0-9:-]{1,80}$/.test(person)) return null;
  const when = isObject(doc['eventdate']) ? doc['eventdate'] : {};
  const year = when['year'];
  const number = (value: unknown) => (typeof value === 'number' ? value : 0);
  const date =
    typeof year === 'number' ? externalDate(year, number(when['month']), number(when['day'])) : '';
  const ownDeath =
    (DEATH_EVENTS.has(lower(doc['eventtype'])) || DEATH_EVENTS.has(lower(doc['_eventtype']))) &&
    (DECEASED_ROLES.has(lower(doc['relationtype'])) ||
      DECEASED_ROLES.has(lower(doc['_relationtype'])));
  const longAgo = date !== '' && typeof year === 'number' && isLongAgo(year, thisYear);
  if (!ownDeath && !longAgo) return null;
  const places = Array.isArray(doc['eventplace']) ? doc['eventplace'] : [doc['eventplace']];
  const name = cleanText(doc['personname']);
  return {
    connectorId: openArchivesManifest.id,
    key: `${archive}:${identifier}/${person}`,
    kind: 'event',
    title: name === '' ? `${archive}:${identifier}` : name,
    url: `${OPEN_ARCHIVES_RECORD_URL}${archive}:${identifier}/en`,
    role: cleanText(doc['relationtype']),
    event: cleanText(doc['eventtype']),
    date,
    place: cleanText(
      places
        .slice(0, 3)
        .map((place) => cleanText(place))
        .filter((place) => place !== '')
        .join(', '),
    ),
    held: [cleanText(doc['sourcetype']), cleanText(doc['archive'])]
      .filter((part) => part !== '')
      .join(', '),
  };
}

/** Reads the answer of Open Archives to a search. Throws a `ConnectorError` when it is not one. */
export function parseOpenArchivesSearch(
  data: unknown,
  asked: PageRequest,
  thisYear: number,
): Page<EventRecord> {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError('format', 'Open Archives answered in a way the app cannot read.');
  }
  // No more than was asked for is taken, whatever comes.
  const docs = (parsed.data.response.docs ?? []).slice(0, asked.limit);
  const seen = new Set<string>();
  const items = docs
    .map((doc) => recordOf(doc, thisYear))
    .filter((record) => record !== null)
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  const found = parsed.data.response.number_found;
  const total = typeof found === 'number' && Number.isInteger(found) && found >= 0 ? found : null;
  const after = asked.offset + asked.limit;
  const more =
    docs.length > 0 &&
    (total === null ? docs.length === asked.limit : after < total) &&
    after <= OPEN_ARCHIVES_LAST_OFFSET;
  return {
    items,
    total,
    next: more ? { offset: after, limit: asked.limit } : null,
    hidden: docs.length - items.length,
  };
}

/**
 * A name as the service is sent it: letters, and the hyphen, the apostrophe
 * and the full stop that names have. Everything else goes, digits too: the
 * service reads wildcards, quotes and other signs as commands, and digits
 * after a name as years.
 */
function nameWords(text: string): string {
  return text
    .replace(/[^\p{L}\p{M}'’.\-\s]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The name of a query as the service is sent it; empty when nothing of a name is left. */
export function openArchivesName(query: PersonQuery): string {
  return [nameWords(query.given), nameWords(query.surname)].filter((part) => part !== '').join(' ');
}

/**
 * The span of years the event of a record may lie in: from the birth to the
 * death, and two years to either side, as a year of the tree may be off and
 * a death is not always registered in its year. With one of the two years,
 * the other end is as far as a life can reach. Null when the query names no year.
 */
export function openArchivesSpan(query: PersonQuery): { from: number; to: number } | null {
  const { birthYear, deathYear } = query;
  if (birthYear === null && deathYear === null) return null;
  const first = birthYear ?? (deathYear ?? 0) - PRESUMED_DEAD_AFTER_YEARS;
  const last = deathYear ?? (birthYear ?? 0) + PRESUMED_DEAD_AFTER_YEARS;
  const from = Math.max(1, Math.min(first, last) - QUERY_YEAR_SPREAD);
  const to = Math.min(9999, Math.max(first, last) + QUERY_YEAR_SPREAD);
  return { from, to };
}

function pageOf(page: PageRequest): PageRequest {
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), OPEN_ARCHIVES_PAGE_LIMIT));
  const offset = Math.max(0, Math.min(Math.trunc(page.offset), OPEN_ARCHIVES_LAST_OFFSET));
  // Whole pages, so that "more" is the page after this one.
  return { limit, offset: Math.floor(offset / limit) * limit };
}

/** What is sent to Open Archives for a search: the name, the span of years, and nothing else of the tree. */
export function openArchivesSearchParams(
  query: PersonQuery,
  page: PageRequest,
): Record<string, string | number | undefined> {
  const asked = pageOf(page);
  const span = openArchivesSpan(query);
  const name = openArchivesName(query);
  return {
    name: span === null ? name : `${name} ${span.from}-${span.to}`,
    lang: 'en',
    number_show: asked.limit,
    start: asked.offset,
  };
}

export function openArchivesConnector(
  client: SourceClient,
  now: () => number = Date.now,
): PersonConnector<EventRecord> {
  if (client.manifest.id !== openArchivesManifest.id) {
    throw new Error('the Open Archives connector needs the client of Open Archives');
  }
  return {
    manifest: openArchivesManifest,
    async searchPersons(query, page, options = {}) {
      if (openArchivesName(query) === '') {
        throw new ConnectorError('refused', 'Give a name to search for.');
      }
      const asked = pageOf(page);
      const answer = await client.getJson('records/search.json', {
        params: openArchivesSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parseOpenArchivesSearch(answer.data, asked, new Date(now()).getUTCFullYear()),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
