import { cleanText, type ConnectorManifest, type SourceConnector } from '@rulz/connectors';
import type { ExternalRecord } from '@rulz/core';
import { RECORD_MARK_JSON_MAX, type RecordMark } from '@rulz/db';
import { z } from 'zod';

/**
 * A result of a search as the tree keeps it, and as it is read back.
 *
 * What is kept is the record as a connector made it (`ExternalRecord`), never
 * the answer of the source itself. For a source whose terms bar keeping what
 * it returns, nothing of the record is kept: the mark holds the identifier
 * and the address, which the app makes itself.
 *
 * What is read back is not trusted. A tree's folder can come from another PC
 * or from another person, and its file can hold anything. A kept record is
 * taken only when it has the shape of a record, names the source and the key
 * its row names, and every text of it is cleaned again, as a connector cleans
 * what a source sends. That makes it safe to show and to compare. It does not
 * make it true: whoever wrote the file could have written the tree itself.
 *
 * The same goes for the rest of a row. The line a result is shown under is
 * taken from the checked record, not from the row's own title, so that what
 * is shown and what is cited cannot differ. A moment that is none is left
 * out. And the address of a record of a source whose terms bar keeping is
 * made again from the identifier, as it was made when the record was read.
 */

/** The latest moment a mark can name: the end of the year 9999. */
const WHEN_MAX = 253_402_300_799_999;

/** A moment as a row holds it, in Unix milliseconds; null when the file holds something else there. */
export function whenOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= WHEN_MAX
    ? value
    : null;
}

/** What is needed of a source to read a mark back. */
export type MarkSource = Pick<SourceConnector, 'manifest' | 'recordUrl'>;

/**
 * The address of a record of a source whose terms bar keeping what it
 * returns, made from the record's identifier; null when the source makes no
 * addresses, or the identifier is none of its own.
 */
export function madeAddress(source: MarkSource, key: unknown): string | null {
  return typeof key === 'string' ? (source.recordUrl?.(key) ?? null) : null;
}

/** A text of a record, cleaned again: plain text of one line, no longer than a record's texts are. */
const text = (max: number) => z.string().transform((value) => cleanText(value, max));

const base = {
  connectorId: z.string().min(1).max(100),
  key: z.string().min(1).max(200),
  title: text(500),
  url: z.string().min(1).max(2000),
};

const keptRecord = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('person'),
    sex: z.enum(['M', 'F']).nullable(),
    facts: z
      .array(
        z.strictObject({ type: z.enum(['birth', 'death']), date: text(100), place: text(500) }),
      )
      .max(8),
    about: text(1000),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('event'),
    role: text(200),
    event: text(200),
    date: text(100),
    place: text(500),
    held: text(500),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('text'),
    date: text(100),
    by: text(500),
    about: text(1000),
  }),
]);

/**
 * What is kept of a result: its title, and the record as JSON. Null when the
 * record is too long to keep. For a source whose terms bar keeping what it
 * returns, the title is empty and there is no JSON.
 */
export function keptFormOf(
  record: ExternalRecord,
  manifest: ConnectorManifest,
): { title: string; recordJson: string | null } | null {
  if (manifest.mayStoreText === false) return { title: '', recordJson: null };
  const recordJson = JSON.stringify(record);
  return recordJson.length > RECORD_MARK_JSON_MAX
    ? null
    : { title: cleanText(record.title, 500), recordJson };
}

/**
 * The record a kept mark holds, checked; null when it cannot be used. Whether
 * its address leads to the site of its source is for the caller to check, as
 * it is for a result of a search.
 */
export function keptRecordOf(mark: RecordMark, source: MarkSource): ExternalRecord | null {
  const { manifest } = source;
  if (mark.state !== 'kept' || mark.sourceId !== manifest.id) return null;
  // A kept record is cited with the day it was read: one without a day is none.
  if (whenOf(mark.readAt) === null) return null;
  // The terms of the source as they are now decide, not what the file holds:
  // of such a record the app uses the identifier alone, and makes the address
  // from it again. An address in the file could lead to another record.
  if (manifest.mayStoreText === false) {
    const url = madeAddress(source, mark.key);
    if (url === null) return null;
    return {
      kind: 'text',
      connectorId: manifest.id,
      key: mark.key,
      title: '',
      url,
      date: '',
      by: '',
      about: '',
    };
  }
  if (mark.recordJson === null || mark.recordJson.length > RECORD_MARK_JSON_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(mark.recordJson);
  } catch {
    return null;
  }
  const result = keptRecord.safeParse(parsed);
  if (!result.success) return null;
  const record = result.data;
  return record.connectorId === mark.sourceId && record.key === mark.key ? record : null;
}

/**
 * The line a mark is shown under. Where the record it keeps could be read,
 * that is the record's own title, so that the line and what is compared or
 * cited are one record. Otherwise it is the title of the row. For a source
 * whose terms bar keeping a title, and where there is none, it is the
 * record's identifier.
 */
export function markTitle(
  mark: RecordMark,
  record: ExternalRecord | null,
  manifest: ConnectorManifest | undefined,
): string {
  const title = manifest?.mayStoreText === false ? '' : cleanText(record?.title ?? mark.title, 500);
  return title === '' ? `Identifier ${cleanText(mark.key, 200)}` : title;
}
