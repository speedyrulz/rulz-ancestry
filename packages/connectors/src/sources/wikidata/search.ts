import {
  externalDate,
  isLongAgo,
  type ExternalFact,
  type Page,
  type PageRequest,
  type PersonQuery,
  type PersonRecord,
} from '@rulz/core';
import { z } from 'zod';
import { ConnectorError, cleanText, type PersonConnector } from '../../connector';
import type { SourceClient } from '../../http';
import { wikidataManifest } from './manifest';

/**
 * The search for a person at Wikidata, through its Query Service, tried
 * against the service on 2026-11-13.
 *
 * One question does it all: the service searches the entries of humans for
 * the name, and gives each one's label, description, sex and dates of birth
 * and death, with how exactly each date is known. Only the name is sent. The
 * years of a query are not: the search of Wikidata looks for words, and the
 * user sees the years of each result.
 */

/** Where an entry's page is, for the user's browser. */
export const WIKIDATA_ENTITY_URL = 'https://www.wikidata.org/wiki/';

/** How many results are asked for at a time at most. */
export const WIKIDATA_PAGE_LIMIT = 50;

/** Results beyond this many are not asked for; the service reads all that come before them each time. */
export const WIKIDATA_LAST_OFFSET = 200;

/** The shape of an answer of the SPARQL protocol. Every value of a row is read with care below. */
const answerSchema = z.looseObject({
  results: z.looseObject({ bindings: z.array(z.unknown()) }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value of one field of a row; empty when the row has none. */
function valueOf(row: Record<string, unknown>, name: string): string {
  const field = row[name];
  return isObject(field) && typeof field['value'] === 'string' ? field['value'] : '';
}

/** A whole number of one field of a row; null when the row has none. */
function numberOf(row: Record<string, unknown>, name: string): number | null {
  const text = valueOf(row, name);
  return /^-?\d{1,6}$/.test(text) ? Number(text) : null;
}

const ENTITY = /^http:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d{0,11})$/;

/** A date as the service gives it: "1853-03-30T00:00:00Z". Nothing else is read as one. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}Z$/;

/** How exactly Wikidata knows a date: to the day, the month, the year. Below that it is a decade or more. */
const TO_THE_DAY = 11;
const TO_THE_MONTH = 10;
const TO_THE_YEAR = 9;

/**
 * A date of an entry in the wording of a GEDCOM file, as exactly as the
 * entry knows it. Null when the value is no real date. Empty when the entry
 * knows it to the decade or less: "1 January 1901" would then be a
 * misreading of "the twentieth century".
 */
function dateOf(value: string, precision: number | null): string | null {
  const parts = DATE.exec(value);
  if (parts === null) return null;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // A day that the calendar does not have is no date: the thirty-first of February.
  const real = new Date(Date.UTC(2000, month - 1, day));
  real.setUTCFullYear(year);
  if (year < 1 || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day) return null;
  // Without word of how exact it is, a date is taken to the year.
  const exact = precision ?? TO_THE_YEAR;
  if (exact < TO_THE_YEAR) return '';
  return externalDate(year, exact >= TO_THE_MONTH ? month : 0, exact >= TO_THE_DAY ? day : 0);
}

/**
 * One row as a record; null when it is left out. An entry of a person who
 * may be living is left out: the app shows no living people of others. A
 * person counts as dead when the entry gives a death, or when the latest
 * year their birth can lie in is long ago. A birth that is known to the
 * century only can lie in its last year.
 */
function recordOf(row: unknown, thisYear: number): PersonRecord | null {
  if (!isObject(row)) return null;
  const id = ENTITY.exec(valueOf(row, 'item'))?.[1];
  if (id === undefined) return null;
  const birth = dateOf(valueOf(row, 'birth'), numberOf(row, 'birthPrecision'));
  const death = dateOf(valueOf(row, 'death'), numberOf(row, 'deathPrecision'));
  const latest = numberOf(row, 'birthLatest');
  const longAgo = birth !== null && latest !== null && isLongAgo(latest, thisYear);
  if (death === null && !longAgo) return null;
  const sex = valueOf(row, 'gender');
  const facts: ExternalFact[] = [];
  if (birth !== null && birth !== '') facts.push({ type: 'birth', date: birth, place: '' });
  if (death !== null && death !== '') facts.push({ type: 'death', date: death, place: '' });
  return {
    connectorId: wikidataManifest.id,
    key: id,
    kind: 'person',
    title: cleanText(valueOf(row, 'name')) || id,
    url: WIKIDATA_ENTITY_URL + id,
    sex: sex.endsWith('/Q6581097') ? 'M' : sex.endsWith('/Q6581072') ? 'F' : null,
    facts,
    about: cleanText(valueOf(row, 'description')),
  };
}

/** Reads the answer of Wikidata to a search. Throws a `ConnectorError` when it is not one. */
export function parseWikidataSearch(
  data: unknown,
  asked: PageRequest,
  thisYear: number,
): Page<PersonRecord> {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError('format', 'Wikidata answered in a way the app cannot read.');
  }
  // One more than a page is asked for, to learn whether there is more.
  const rows = parsed.data.results.bindings;
  const shown = rows.slice(0, asked.limit);
  const seen = new Set<string>();
  const items = shown
    .map((row) => recordOf(row, thisYear))
    .filter((record) => record !== null)
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  const after = asked.offset + asked.limit;
  return {
    items,
    // The service does not say how many there are in all.
    total: null,
    next:
      rows.length > asked.limit && after <= WIKIDATA_LAST_OFFSET
        ? { offset: after, limit: asked.limit }
        : null,
    hidden: shown.length - items.length,
  };
}

/**
 * The name of a query as it is put into the question: letters, digits, and
 * the hyphen, the apostrophe and the full stop that names have. Nothing else
 * is left that could end the text it stands in, or be a command to the search.
 * It is put in small letters: OR, AND and NOT in capitals are commands to
 * the search, and it does not tell capitals from small letters otherwise.
 */
export function wikidataName(query: PersonQuery): string {
  return `${query.given} ${query.surname}`
    .replace(/[^\p{L}\p{N}\p{M}'’.\-\s]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pageOf(page: PageRequest): PageRequest {
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), WIKIDATA_PAGE_LIMIT));
  const offset = Math.max(0, Math.min(Math.trunc(page.offset), WIKIDATA_LAST_OFFSET));
  return { limit, offset: Math.floor(offset / limit) * limit };
}

/** The question that is put to the Query Service, in SPARQL. `name` must come from `wikidataName`. */
export function wikidataQuery(name: string, page: PageRequest): string {
  const asked = pageOf(page);
  return [
    'SELECT ?item ?ordinal (SAMPLE(?label) AS ?name) (SAMPLE(?about) AS ?description)',
    // Of several births the latest counts, and of each the last year it can mean.
    '(MAX(?born) AS ?birth) (MIN(?bornPrecision) AS ?birthPrecision) (MAX(?bornLatest) AS ?birthLatest)',
    '(MIN(?died) AS ?death) (MIN(?diedPrecision) AS ?deathPrecision) (SAMPLE(?sex) AS ?gender) WHERE {',
    'SERVICE wikibase:mwapi {',
    'bd:serviceParam wikibase:endpoint "www.wikidata.org" ;',
    'wikibase:api "Search" ;',
    // The search stops after this many, and the page is cut from them below.
    `wikibase:limit ${asked.offset + asked.limit + 1} ;`,
    // Humans only. The name comes last, so that no word of it stands before the rule.
    `mwapi:srsearch "haswbstatement:P31=Q5 ${name}" .`,
    '?item wikibase:apiOutputItem mwapi:title .',
    '?ordinal wikibase:apiOrdinal true .',
    '}',
    'OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }',
    'OPTIONAL { ?item schema:description ?about . FILTER(LANG(?about) = "en") }',
    'OPTIONAL {',
    '?item p:P569/psv:P569 ?bornValue .',
    '?bornValue wikibase:timeValue ?born ; wikibase:timePrecision ?bornPrecision .',
    // 9 is "to the year"; 8 a decade, 7 a century, less than that a thousand years or more.
    'BIND(YEAR(?born) + IF(?bornPrecision >= 9, 0, IF(?bornPrecision = 8, 9, IF(?bornPrecision = 7, 99, 999))) AS ?bornLatest)',
    '}',
    'OPTIONAL {',
    '?item p:P570/psv:P570 ?diedValue .',
    '?diedValue wikibase:timeValue ?died ; wikibase:timePrecision ?diedPrecision .',
    '}',
    'OPTIONAL { ?item wdt:P21 ?sex }',
    `} GROUP BY ?item ?ordinal ORDER BY ?ordinal OFFSET ${asked.offset} LIMIT ${asked.limit + 1}`,
  ].join('\n');
}

/** What is sent to Wikidata for a search: a question that holds the name, and nothing else of the tree. */
export function wikidataSearchParams(
  query: PersonQuery,
  page: PageRequest,
): Record<string, string | number | undefined> {
  return { format: 'json', query: wikidataQuery(wikidataName(query), page) };
}

export function wikidataConnector(
  client: SourceClient,
  now: () => number = Date.now,
): PersonConnector {
  if (client.manifest.id !== wikidataManifest.id) {
    throw new Error('the Wikidata connector needs the client of Wikidata');
  }
  return {
    manifest: wikidataManifest,
    async searchPersons(query, page, options = {}) {
      if (wikidataName(query) === '') {
        throw new ConnectorError('refused', 'Give a name to search for.');
      }
      const asked = pageOf(page);
      const answer = await client.getJson('', {
        params: wikidataSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parseWikidataSearch(answer.data, asked, new Date(now()).getUTCFullYear()),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
