import {
  QUERY_YEAR_SPREAD,
  externalDate,
  type ExternalFact,
  type ExternalRecord,
  type Page,
  type PageRequest,
  type PersonQuery,
} from '@rulz/core';
import { z } from 'zod';
import { ConnectorError, cleanText, type SourceConnector } from '../../connector';
import type { SourceClient } from '../../http';
import { wikitreeManifest } from './manifest';

/**
 * The search for people at WikiTree: its `searchPerson` action, read on
 * 2026-11-13 from https://github.com/wikitree/wikitree-api and tried once
 * against the service itself.
 */

/** WikiTree asks every app to name itself with each request. */
export const WIKITREE_APP_ID = 'RulZAncestry';

/** Where a profile's page is, for the user's browser. */
export const WIKITREE_PROFILE_URL = 'https://www.wikitree.com/wiki/';

/** WikiTree gives at most this many results at a time. */
export const WIKITREE_PAGE_LIMIT = 100;

/** Results beyond this many are not asked for; a narrower search serves better. */
export const WIKITREE_LAST_OFFSET = 1000;

const FIELDS = [
  'Id',
  'Name',
  'FirstName',
  'MiddleName',
  'RealName',
  'LastNameAtBirth',
  'LastNameCurrent',
  'Suffix',
  'BirthDate',
  'DeathDate',
  'BirthLocation',
  'DeathLocation',
  'Gender',
  'IsLiving',
  'Privacy',
  'DataStatus',
].join(',');

/** Only what must be there is asked of the shape; every field of a match is read with care below. */
const answerSchema = z
  .array(
    z.looseObject({
      status: z.union([z.number(), z.string()]),
      matches: z.array(z.unknown()).optional(),
      total: z.number().optional(),
    }),
  )
  .min(1);

/** A profile's id at WikiTree: a last name, a hyphen and a number ("Clemens-1"). */
const PROFILE_NAME = /^[^\s/\\?#%<>"&]{1,100}-\d{1,9}$/u;

function field(match: Record<string, unknown>, name: string): string {
  return cleanText(match[name]);
}

function qualifierOf(status: unknown): 'about' | 'before' | 'after' | null {
  if (status === 'guess') return 'about';
  if (status === 'before') return 'before';
  if (status === 'after') return 'after';
  return null;
}

/** WikiTree writes a date as "1835-11-30", with 00 for a month or a day it does not know. */
function dateOf(value: unknown, status: unknown): string {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (parts === null) return '';
  return externalDate(Number(parts[1]), Number(parts[2]), Number(parts[3]), qualifierOf(status));
}

function factOf(
  match: Record<string, unknown>,
  status: Record<string, unknown>,
  type: ExternalFact['type'],
): ExternalFact | null {
  const name = type === 'birth' ? 'Birth' : 'Death';
  const date = dateOf(match[`${name}Date`], status[`${name}Date`]);
  const place = field(match, `${name}Location`);
  return date === '' && place === '' ? null : { type, date, place };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** WikiTree's number for a profile that everyone may see; "open" is above it, the private kinds below. */
const PUBLIC = 50;

/**
 * One match as a record; null when it is left out. Only a profile that
 * WikiTree itself calls public or open is shown, whatever else comes with a
 * private one. A profile of a living person is left out too: the app shows
 * no living people of others. What does not say which it is, is left out.
 */
function recordOf(match: unknown): ExternalRecord | null {
  if (!isObject(match)) return null;
  const key = typeof match['Name'] === 'string' ? match['Name'].trim().replace(/ /g, '_') : '';
  if (!PROFILE_NAME.test(key)) return null;
  if (match['IsLiving'] !== 0) return null;
  const privacy = match['Privacy'];
  if (typeof privacy !== 'number' || !(privacy >= PUBLIC)) return null;
  const status = isObject(match['DataStatus']) ? match['DataStatus'] : {};
  const first = field(match, 'RealName') || field(match, 'FirstName');
  const born = field(match, 'LastNameAtBirth');
  const last = field(match, 'LastNameCurrent') || born;
  const name = [first, field(match, 'MiddleName'), last, field(match, 'Suffix')]
    .filter((part) => part !== '')
    .join(' ');
  const title = born !== '' && born !== last ? `${name} (born ${born})` : name;
  const gender = match['Gender'];
  return {
    connectorId: wikitreeManifest.id,
    key,
    kind: 'person',
    title: title === '' ? key : title,
    url: WIKITREE_PROFILE_URL + encodeURIComponent(key),
    sex: gender === 'Male' ? 'M' : gender === 'Female' ? 'F' : null,
    facts: [factOf(match, status, 'birth'), factOf(match, status, 'death')].filter(
      (fact) => fact !== null,
    ),
  };
}

/** Reads WikiTree's answer to a search. Throws a `ConnectorError` when it is not one. */
export function parseWikitreeSearch(data: unknown, asked: PageRequest): Page<ExternalRecord> {
  const parsed = answerSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConnectorError('format', 'WikiTree answered in a way the app cannot read.');
  }
  const answer = parsed.data[0];
  if (answer === undefined || answer.status !== 0) {
    const said = answer === undefined ? '' : cleanText(String(answer.status));
    throw new ConnectorError('refused', `WikiTree did not search: ${said || 'no reason given'}`);
  }
  // No more than was asked for is taken, whatever comes.
  const matches = (answer.matches ?? []).slice(0, asked.limit);
  const seen = new Set<string>();
  const items = matches
    .map(recordOf)
    .filter((record) => record !== null)
    // A profile that comes twice is shown once.
    .filter((record) => !seen.has(record.key) && seen.add(record.key));
  const total =
    answer.total !== undefined && Number.isInteger(answer.total) && answer.total >= 0
      ? answer.total
      : null;
  const after = asked.offset + matches.length;
  const more =
    matches.length > 0 &&
    (total === null ? matches.length === asked.limit : after < total) &&
    after <= WIKITREE_LAST_OFFSET;
  return {
    items,
    total,
    next: more ? { offset: after, limit: asked.limit } : null,
    hidden: matches.length - items.length,
  };
}

/** What is sent to WikiTree for a search: the name, the years, and nothing else of the tree. */
export function wikitreeSearchParams(
  query: PersonQuery,
  page: PageRequest,
): Record<string, string | number | undefined> {
  const given = query.given.trim();
  const surname = query.surname.trim();
  const dated = query.birthYear !== null || query.deathYear !== null;
  return {
    action: 'searchPerson',
    appId: WIKITREE_APP_ID,
    FirstName: given === '' ? undefined : given,
    LastName: surname === '' ? undefined : surname,
    BirthDate: query.birthYear === null ? undefined : String(query.birthYear),
    DeathDate: query.deathYear === null ? undefined : String(query.deathYear),
    dateSpread: dated ? QUERY_YEAR_SPREAD : undefined,
    limit: Math.max(1, Math.min(page.limit, WIKITREE_PAGE_LIMIT)),
    start: Math.max(0, Math.min(page.offset, WIKITREE_LAST_OFFSET)),
    fields: FIELDS,
  };
}

export function wikitreeConnector(client: SourceClient): SourceConnector {
  if (client.manifest.id !== wikitreeManifest.id) {
    throw new Error('the WikiTree connector needs the client of WikiTree');
  }
  return {
    manifest: wikitreeManifest,
    async searchPersons(query, page, options = {}) {
      const asked = {
        offset: Math.max(0, Math.min(page.offset, WIKITREE_LAST_OFFSET)),
        limit: Math.max(1, Math.min(page.limit, WIKITREE_PAGE_LIMIT)),
      };
      const answer = await client.getJson('', {
        params: wikitreeSearchParams(query, asked),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      return {
        page: parseWikitreeSearch(answer.data, asked),
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
