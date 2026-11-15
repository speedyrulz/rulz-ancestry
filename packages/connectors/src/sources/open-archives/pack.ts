import { externalDate, foldPlace, isLongAgo, type EventRecord, type PersonQuery } from '@rulz/core';
import { ConnectorError, cleanText } from '../../connector';
import { openArchivesManifest } from './manifest';
import { openArchivesRecordUrl } from './search';

/**
 * The records of Open Archives' own CSV dumps, as a pack kind. A dump has one
 * row per record: 27 columns of the event and its source, then slots of 17
 * columns, one for each role the record names a person in (`GROOM`,
 * `BRIDE_FTHR`, `PR`, `PR_MTHR`, `WITNESS_1`, `OTHER`), and the slots differ
 * by kind of record. The columns are pipe-separated, with no quoting. Measured
 * on two real files on 2026-11-15 (part 5.0).
 *
 * The pack keeps the columns as they come. This module reads them: which
 * columns are searched, and how a row becomes the records of the people it
 * names.
 */

export const OA_PACK_KIND = 'open-archives';
/** Raised when a change to how rows are read means that packs must be built again. */
export const OA_BUILDER_VERSION = 1;

/** The columns without which a row cannot be a record of Open Archives. */
const REQUIRED_COLUMNS = ['SOURCE_RECORD_GUID', 'SOURCEREFERENCE_INSTITUTIONCODE', 'EVENT_TYPE'];
const NAME_PARTS = ['NAME', 'NAME_GN', 'NAME_PATR', 'NAME_SPRE', 'NAME_SURN'];
const SURNAME_SUFFIX = '_NAME_SURN';
const SLOT_PATTERN = /^[A-Z][A-Z0-9_]{0,23}$/;

/** The words of the dumps (Dutch) for the record of a death and for the one who died; as `search.ts` has them. */
const DEATH_EVENTS = new Set(['death', 'burial', 'overlijden', 'begraven']);
const DECEASED_ROLES = new Set(['deceased', 'overledene']);

const lower = (value: string | undefined) => (value ?? '').trim().toLowerCase();

/** Splits one line of a dump: pipe-separated, no quoting. A carriage return at its end is not part of it. */
export function splitOaLine(line: string): string[] {
  return (line.endsWith('\r') ? line.slice(0, -1) : line).split('|');
}

function slotsOf(header: readonly string[]): string[] {
  return header
    .filter((name) => name.endsWith(SURNAME_SUFFIX))
    .map((name) => name.slice(0, -SURNAME_SUFFIX.length));
}

/**
 * What a header says about the file: its role slots, and the columns whose
 * text is searched as names and as places. Throws a `ConnectorError` of kind
 * "format" when a column that every Open Archives record has is missing.
 */
export function oaLayout(header: readonly string[]): {
  slots: string[];
  ftsNames: string[];
  ftsPlaces: string[];
} {
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new ConnectorError(
        'format',
        `The file has no ${column} column: it is not an Open Archives file.`,
      );
    }
  }
  const has = new Set(header);
  const slots = slotsOf(header);
  const ftsNames = slots.flatMap((slot) =>
    NAME_PARTS.map((part) => `${slot}_${part}`).filter((name) => has.has(name)),
  );
  const ftsPlaces = [
    ...(has.has('EVENT_PLACE') ? ['EVENT_PLACE'] : []),
    ...slots.flatMap((slot) =>
      [`${slot}_RES_PLACE`, `${slot}_BIR_PLACE`].filter((name) => has.has(name)),
    ),
  ];
  return { slots, ftsNames, ftsPlaces };
}

const tokens = (text: string | undefined) =>
  foldPlace(text ?? '')
    .split(' ')
    .filter((part) => part !== '');

/**
 * Whether a person of a slot is the one asked for: the surname must match
 * (every word of the query's surname is one of the person's surname, prefix
 * and patronymic, accents and case ignored), and the given name when one was
 * asked (every word of it starts a given name of the person). A query with
 * no surname puts nothing on the surname.
 */
function fits(row: Record<string, string>, slot: string, query: PersonQuery): boolean {
  const surname = new Set([
    ...tokens(row[`${slot}_NAME_SURN`]),
    ...tokens(row[`${slot}_NAME_SPRE`]),
    ...tokens(row[`${slot}_NAME_PATR`]),
  ]);
  if (!tokens(query.surname).every((word) => surname.has(word))) return false;
  const given = tokens(row[`${slot}_NAME_GN`]);
  return tokens(query.given).every((word) => given.some((name) => name.startsWith(word)));
}

function yearOf(text: string | undefined): number {
  const value = (text ?? '').trim();
  return /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
}

/**
 * The records of the people one row names, one for each slot that has a
 * surname or a given name, and only for those who are the person asked for
 * (all of them when `query` is null). The living rule is the live search's:
 * a person counts as dead when the row is of their own death, or of an event
 * long enough ago; the others are left out and counted in `hidden`, when they
 * were the person asked for. A row that fails the checks of the archive code
 * and the identifier gives none.
 *
 * The key is `archive:identifier/_SLOT`. The live search's person numbers
 * never start with an underscore, so a key of a pack and one of the live
 * search cannot be the same.
 */
export function oaRecordsOf(
  row: Record<string, string>,
  thisYear: number,
  query: PersonQuery | null,
): { records: EventRecord[]; hidden: number } {
  const none = { records: [], hidden: 0 };
  const archive = (row['SOURCEREFERENCE_INSTITUTIONCODE'] ?? '').trim();
  const guid = (row['SOURCE_RECORD_GUID'] ?? '').trim();
  const identifier = guid.startsWith('{') && guid.endsWith('}') ? guid.slice(1, -1) : guid;
  if (!/^[a-z0-9]{2,12}$/.test(archive)) return none;
  if (!/^[A-Za-z0-9-]{1,80}$/.test(identifier)) return none;
  const year = yearOf(row['EVENT_YEAR']);
  const number = (text: string | undefined) => {
    const value = yearOf(text);
    return Number.isNaN(value) ? 0 : value;
  };
  const date = Number.isNaN(year)
    ? ''
    : externalDate(year, number(row['EVENT_MONTH']), number(row['EVENT_DAY']));
  const longAgo = date !== '' && isLongAgo(year, thisYear);
  const deathEvent = DEATH_EVENTS.has(lower(row['EVENT_TYPE']));
  const held = [cleanText(row['SOURCE_TYPE']), cleanText(row['SOURCEREFERENCE_INSTITUTIONNAME'])]
    .filter((part) => part !== '')
    .join(', ');
  const records: EventRecord[] = [];
  let hidden = 0;
  for (const slot of slotsOf(Object.keys(row))) {
    if (!SLOT_PATTERN.test(slot)) continue;
    const given = (row[`${slot}_NAME_GN`] ?? '').trim();
    const surname = (row[`${slot}_NAME_SURN`] ?? '').trim();
    if (given === '' && surname === '') continue;
    if (query !== null && !fits(row, slot, query)) continue;
    const role = row[`${slot}_RELATIONTYPE`];
    const ownDeath = deathEvent && DECEASED_ROLES.has(lower(role));
    if (!ownDeath && !longAgo) {
      hidden += 1;
      continue;
    }
    const name = cleanText(row[`${slot}_NAME`]);
    const composed = cleanText(
      [given, row[`${slot}_NAME_SPRE`], surname]
        .filter((part) => (part ?? '').trim() !== '')
        .join(' '),
    );
    records.push({
      connectorId: openArchivesManifest.id,
      key: `${archive}:${identifier}/_${slot}`,
      kind: 'event',
      title: name !== '' ? name : composed !== '' ? composed : `${archive}:${identifier}`,
      url: openArchivesRecordUrl(archive, identifier),
      role: cleanText(role),
      event: cleanText(row['EVENT_TYPE']),
      date,
      place: cleanText(row['EVENT_PLACE']),
      held,
    });
  }
  return { records, hidden };
}
