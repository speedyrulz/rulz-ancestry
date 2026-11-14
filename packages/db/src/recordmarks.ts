import { newId } from '@rulz/core';
import { sql } from './connection';
import { requirePerson } from './persons';
import { TreeRuleError, type Tree } from './tree';

/**
 * What the user decided about results of a search for records: kept to look
 * at later, or turned down because the record is not of this person. See
 * `schema/010-record-marks.ts` for what a row holds and why.
 *
 * Nothing here knows what a record is. Whoever keeps one hands in its JSON,
 * and whoever reads it back checks it again: a tree's folder can come from
 * another PC, and what its file holds is not to be trusted as it stands.
 */

/** How many marks a tree holds at most, so that its file and its backups do not swell. */
export const RECORD_MARK_LIMIT = 5000;

/** How long the JSON of a kept record may be, in characters. */
export const RECORD_MARK_JSON_MAX = 16_384;

const TITLE_MAX = 500;
const URL_MAX = 2000;

export type RecordMarkState = 'kept' | 'declined';

export interface RecordMark {
  id: string;
  personId: string;
  /** The id of the source, as in its manifest. */
  sourceId: string;
  /** What the source calls the record. */
  key: string;
  state: RecordMarkState;
  /** The line the record was shown under; empty when the source's terms bar keeping it. */
  title: string;
  /** The record's page at the source. */
  url: string;
  /** The record as it was read; null for one that was turned down, and where the terms bar keeping it. */
  recordJson: string | null;
  /** When the record was read from the source, in Unix milliseconds. */
  readAt: number;
  /** When the user kept it or turned it down. */
  markedAt: number;
}

/** What is written for a result that is kept or turned down. */
export interface RecordMarkInput {
  sourceId: string;
  key: string;
  title: string;
  url: string;
  /** Left out, or null, for a result that is turned down. */
  recordJson?: string | null;
  readAt: number;
  markedAt: number;
}

interface Row {
  id: string;
  person_id: string;
  source_id: string;
  record_key: string;
  state: RecordMarkState;
  title: string;
  url: string;
  record_json: string | null;
  read_at: number;
  marked_at: number;
}

const COLUMNS =
  'id, person_id, source_id, record_key, state, title, url, record_json, read_at, marked_at';

function markOf(row: Row): RecordMark {
  return {
    id: row.id,
    personId: row.person_id,
    sourceId: row.source_id,
    key: row.record_key,
    state: row.state,
    title: row.title,
    url: row.url,
    recordJson: row.record_json,
    readAt: row.read_at,
    markedAt: row.marked_at,
  };
}

/** The mark of a result for a person; null when there is none. */
export function getRecordMark(
  tree: Tree,
  personId: string,
  sourceId: string,
  key: string,
): RecordMark | null {
  const row = sql(
    tree.db,
    `SELECT ${COLUMNS} FROM record_mark
     WHERE person_id = ? AND source_id = ? AND record_key = ?`,
  ).get(personId, sourceId, key) as Row | undefined;
  return row === undefined ? null : markOf(row);
}

/** How many marks the tree holds, of one kind or of both, for one person or for all. */
export function countRecordMarks(
  tree: Tree,
  state: RecordMarkState | null = null,
  personId: string | null = null,
): number {
  return sql(
    tree.db,
    `SELECT count(*) FROM record_mark
     WHERE (@state IS NULL OR state = @state) AND (@personId IS NULL OR person_id = @personId)`,
  )
    .pluck()
    .get({ state, personId }) as number;
}

function setMark(
  tree: Tree,
  label: string,
  personId: string,
  state: RecordMarkState,
  input: RecordMarkInput,
): RecordMark {
  const recordJson = state === 'kept' ? (input.recordJson ?? null) : null;
  if (recordJson !== null && recordJson.length > RECORD_MARK_JSON_MAX) {
    throw new TreeRuleError('this record is too long to keep');
  }
  const values = {
    state,
    title: input.title.slice(0, TITLE_MAX),
    url: input.url.slice(0, URL_MAX),
    recordJson,
    readAt: input.readAt,
    markedAt: input.markedAt,
  };
  return tree.transact(label, () => {
    requirePerson(tree, personId);
    const existing = getRecordMark(tree, personId, input.sourceId, input.key);
    if (existing === null) {
      if (countRecordMarks(tree) >= RECORD_MARK_LIMIT) {
        throw new TreeRuleError(
          `a tree keeps at most ${RECORD_MARK_LIMIT} results that were kept or turned down`,
        );
      }
      sql(
        tree.db,
        `INSERT INTO record_mark
           (id, person_id, source_id, record_key, state, title, url, record_json, read_at, marked_at)
         VALUES
           (@id, @personId, @sourceId, @key, @state, @title, @url, @recordJson, @readAt, @markedAt)`,
      ).run({ id: newId(), personId, sourceId: input.sourceId, key: input.key, ...values });
    } else {
      sql(
        tree.db,
        `UPDATE record_mark
         SET state = @state, title = @title, url = @url, record_json = @recordJson,
             read_at = @readAt, marked_at = @markedAt
         WHERE id = @id`,
      ).run({ id: existing.id, ...values });
    }
    const mark = getRecordMark(tree, personId, input.sourceId, input.key);
    if (mark === null) throw new Error('a mark that was just written is gone');
    return mark;
  });
}

/**
 * Keeps a result for a person, to look at later. One that was kept before is
 * kept as it is read now; one that was turned down is kept again.
 */
export function keepRecord(tree: Tree, personId: string, input: RecordMarkInput): RecordMark {
  return setMark(tree, 'Keep a record for later', personId, 'kept', input);
}

/**
 * Turns a result down for a person: it is not of them. What was kept of the
 * record goes; its title and address stay, to show what was turned down.
 */
export function declineRecord(tree: Tree, personId: string, input: RecordMarkInput): RecordMark {
  return setMark(tree, 'Turn a record down', personId, 'declined', input);
}

/**
 * Takes the mark of a result away: a kept one is no longer kept, and one that
 * was turned down may be shown again. Returns what the mark was, or null when
 * there was none.
 */
export function removeRecordMark(
  tree: Tree,
  personId: string,
  sourceId: string,
  key: string,
): RecordMarkState | null {
  const existing = getRecordMark(tree, personId, sourceId, key);
  if (existing === null) return null;
  return tree.transact(
    existing.state === 'kept' ? 'Remove a kept record' : 'Allow a record again',
    () => {
      sql(tree.db, 'DELETE FROM record_mark WHERE id = ?').run(existing.id);
      return existing.state;
    },
  );
}

export interface RecordMarkPage {
  state: RecordMarkState;
  /** Only the marks of this person; null or left out for those of everyone. */
  personId?: string | null;
  offset: number;
  limit: number;
}

/** The marks of one kind, the latest first. */
export function listRecordMarks(tree: Tree, page: RecordMarkPage): RecordMark[] {
  const rows = sql(
    tree.db,
    `SELECT ${COLUMNS} FROM record_mark
     WHERE state = @state AND (@personId IS NULL OR person_id = @personId)
     ORDER BY marked_at DESC, id DESC
     LIMIT @limit OFFSET @offset`,
  ).all({
    state: page.state,
    personId: page.personId ?? null,
    limit: page.limit,
    offset: page.offset,
  }) as Row[];
  return rows.map(markOf);
}

/** What a person's results of one source are marked as, by what the source calls each record. */
export function recordMarkStates(
  tree: Tree,
  personId: string,
  sourceId: string,
): Map<string, RecordMarkState> {
  const rows = sql(
    tree.db,
    'SELECT record_key, state FROM record_mark WHERE person_id = ? AND source_id = ?',
  ).all(personId, sourceId) as { record_key: string; state: RecordMarkState }[];
  return new Map(rows.map((row) => [row.record_key, row.state]));
}

/**
 * Moves the marks of a person who is merged into another to the one who
 * stays. Where both have a mark of the same result, that of the person who
 * stays is the one that counts and the other goes with its person, with one
 * exception: a result that was kept for the one who goes and turned down for
 * the one who stays is kept. A record that was kept is not lost without a
 * word; it is in the inbox, where it can be turned down again.
 */
export function moveRecordMarks(tree: Tree, fromId: string, toId: string): void {
  sql(
    tree.db,
    `DELETE FROM record_mark
     WHERE person_id = @toId AND state = 'declined'
       AND EXISTS (
         SELECT 1 FROM record_mark other
         WHERE other.person_id = @fromId
           AND other.state = 'kept'
           AND other.source_id = record_mark.source_id
           AND other.record_key = record_mark.record_key
       )`,
  ).run({ fromId, toId });
  sql(
    tree.db,
    `UPDATE record_mark SET person_id = @toId
     WHERE person_id = @fromId
       AND NOT EXISTS (
         SELECT 1 FROM record_mark other
         WHERE other.person_id = @toId
           AND other.source_id = record_mark.source_id
           AND other.record_key = record_mark.record_key
       )`,
  ).run({ fromId, toId });
}
