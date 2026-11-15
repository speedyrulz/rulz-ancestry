import { newId } from '@rulz/core';
import { sql } from './connection';
import { requirePerson } from './persons';
import { TreeRuleError, type Tree } from './tree';

/**
 * What the user decided about results of a search for records: kept to look
 * at later, or turned down because the record is not of this person. See
 * `schema/010-record-marks.ts` for what a row holds and why.
 *
 * Whoever keeps a record hands in its JSON,
 * and whoever reads it back checks it again: a tree's folder can come from
 * another PC, and what its file holds is not to be trusted as it stands.
 */

/** How many marks a tree holds at most, so that its file and its backups do not swell. */
export const RECORD_MARK_LIMIT = 5000;

/** How long the JSON of a kept record may be, in characters. */
export const RECORD_MARK_JSON_MAX = 16_384;

/** How long the JSON of what an AI said of a kept record may be, in characters. */
export const RECORD_MARK_AI_JSON_MAX = 16_384;

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
  /**
   * What an AI said of the record, as JSON, when it was kept from a proposal
   * of the AI assistant; null otherwise. See `schema/011-record-mark-reasons.ts`.
   */
  aiJson: string | null;
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
  /**
   * What an AI said of the record, for one that is kept from a proposal. Left
   * out, or null, otherwise: a mark that is written again without it loses
   * what it had, since that was said of another reading of the record.
   */
  aiJson?: string | null;
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
  ai_json: string | null;
  read_at: number;
  marked_at: number;
}

const COLUMNS =
  'id, person_id, source_id, record_key, state, title, url, record_json, ai_json, read_at, marked_at';

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
    aiJson: row.ai_json,
    readAt: row.read_at,
    markedAt: row.marked_at,
  };
}

function formOf(sourceId: string, key: string): { part: string; pack: boolean } | null {
  if (sourceId !== 'open-archives') return null;
  const match = /^([^/]+:[^/]+)\/([^/]+)$/.exec(key);
  if (!match) return null;
  const suffix = match[2]!;
  if (suffix.startsWith('_') && !/^_[A-Z][A-Z0-9_]{0,23}$/.test(suffix)) return null;
  return { part: match[1]!, pack: suffix.startsWith('_') };
}

export function recordPartOf(sourceId: string, key: string): string {
  return formOf(sourceId, key)?.part ?? key;
}

function exactMark(tree: Tree, personId: string, sourceId: string, key: string): RecordMark | null {
  const row = sql(
    tree.db,
    `SELECT ${COLUMNS} FROM record_mark
    WHERE person_id = ? AND source_id = ? AND record_key = ?`,
  ).get(personId, sourceId, key) as Row | undefined;
  return row === undefined ? null : markOf(row);
}

function otherMarks(tree: Tree, personId: string, sourceId: string, key: string): RecordMark[] {
  const form = formOf(sourceId, key);
  if (form === null) return [];
  const rows = sql(
    tree.db,
    `SELECT ${COLUMNS} FROM record_mark
    WHERE person_id = ? AND source_id = ? AND substr(record_key, 1, ?) = ?`,
  ).all(personId, sourceId, form.part.length + 1, `${form.part}/`) as Row[];
  return rows.map(markOf).filter((mark) => {
    const other = formOf(sourceId, mark.key);
    return other !== null && other.part === form.part && other.pack !== form.pack;
  });
}

/** The mark of a result for a person; null when there is none. */
export function getRecordMark(
  tree: Tree,
  personId: string,
  sourceId: string,
  key: string,
  singleOnly = false,
): RecordMark | null {
  const exact = exactMark(tree, personId, sourceId, key);
  if (exact !== null) return exact;
  const others = otherMarks(tree, personId, sourceId, key);
  if (singleOnly && others.length !== 1) return null;
  return others.find((mark) => mark.state === 'kept') ?? others[0] ?? null;
}

/**
 * What each of the given results is marked as for a person, as
 * `getRecordMark` would say it, from one read of the person's marks of the
 * source. A result without a mark is left out of the map.
 */
export function recordMarkStatesFor(
  tree: Tree,
  personId: string,
  sourceId: string,
  keys: readonly string[],
): Map<string, RecordMarkState> {
  const found = new Map<string, RecordMarkState>();
  if (keys.length === 0) return found;
  const states = recordMarkStates(tree, personId, sourceId);
  if (states.size === 0) return found;
  // The marks by record, for the other form of a result.
  const byPart = new Map<string, { pack: boolean; state: RecordMarkState }[]>();
  for (const [markKey, state] of states) {
    const form = formOf(sourceId, markKey);
    if (form === null) continue;
    const list = byPart.get(form.part) ?? [];
    list.push({ pack: form.pack, state });
    byPart.set(form.part, list);
  }
  for (const key of keys) {
    const exact = states.get(key);
    if (exact !== undefined) {
      found.set(key, exact);
      continue;
    }
    const form = formOf(sourceId, key);
    if (form === null) continue;
    const others = (byPart.get(form.part) ?? []).filter((mark) => mark.pack !== form.pack);
    if (others.length === 0) continue;
    found.set(key, others.some((mark) => mark.state === 'kept') ? 'kept' : 'declined');
  }
  return found;
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
  // Written with every mark, so that what an AI said of one reading of a
  // record never stays beside another reading, or beside a turning-down.
  const aiJson = state === 'kept' ? (input.aiJson ?? null) : null;
  if (aiJson !== null && aiJson.length > RECORD_MARK_AI_JSON_MAX) {
    throw new TreeRuleError('what the AI said of this record is too long to keep');
  }
  const values = {
    state,
    title: input.title.slice(0, TITLE_MAX),
    url: input.url.slice(0, URL_MAX),
    recordJson,
    aiJson,
    readAt: input.readAt,
    markedAt: input.markedAt,
  };
  return tree.transact(label, () => {
    requirePerson(tree, personId);
    const existing = getRecordMark(tree, personId, input.sourceId, input.key, true);
    if (existing === null) {
      if (countRecordMarks(tree) >= RECORD_MARK_LIMIT) {
        throw new TreeRuleError(
          `a tree keeps at most ${RECORD_MARK_LIMIT} results that were kept or turned down`,
        );
      }
      sql(
        tree.db,
        `INSERT INTO record_mark
           (id, person_id, source_id, record_key, state, title, url, record_json, ai_json,
            read_at, marked_at)
         VALUES
           (@id, @personId, @sourceId, @key, @state, @title, @url, @recordJson, @aiJson,
            @readAt, @markedAt)`,
      ).run({ id: newId(), personId, sourceId: input.sourceId, key: input.key, ...values });
    } else {
      sql(
        tree.db,
        `UPDATE record_mark
         SET record_key = @key, state = @state, title = @title, url = @url, record_json = @recordJson,
             ai_json = @aiJson, read_at = @readAt, marked_at = @markedAt
         WHERE id = @id`,
      ).run({ id: existing.id, key: input.key, ...values });
    }
    const mark = getRecordMark(tree, personId, input.sourceId, input.key);
    if (mark === null) throw new Error('a mark that was just written is gone');
    return mark;
  });
}

/**
 * Keeps a result for a person, to look at later. One that was kept before is
 * kept as it is read now; one that was turned down is kept again. What an AI
 * said of it is kept with it when it is handed in, and goes otherwise.
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
  // The mark of this very result; failing that, every mark of the same record
  // found the other way, which is what the result was shown as.
  const exact = exactMark(tree, personId, sourceId, key);
  const marks = exact !== null ? [exact] : otherMarks(tree, personId, sourceId, key);
  if (marks.length === 0) return null;
  const state: RecordMarkState = marks.some((mark) => mark.state === 'kept') ? 'kept' : 'declined';
  return tree.transact(state === 'kept' ? 'Remove a kept record' : 'Allow a record again', () => {
    for (const mark of marks) sql(tree.db, 'DELETE FROM record_mark WHERE id = ?').run(mark.id);
    return state;
  });
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
 * stays. Where both have a mark of the very same result (the same key), that
 * of the person who stays is the one that counts and the other goes with its person, with one
 * exception: a result that was kept for the one who goes and turned down for
 * the one who stays is kept. A record that was kept is not lost without a
 * word; it is in the inbox, where it can be turned down again.
 */
export function moveRecordMarks(tree: Tree, fromId: string, toId: string): void {
  // Only the columns every version of the table has: a merge also runs while
  // an older tree is brought up to date.
  type Lite = { id: string; source_id: string; record_key: string; state: RecordMarkState };
  const marksOf = (personId: string) =>
    sql(
      tree.db,
      'SELECT id, source_id, record_key, state FROM record_mark WHERE person_id = ?',
    ).all(personId) as Lite[];
  // The marks of the person who stays as they were before this merge: what is
  // moved here never counts as a conflict for what is moved after it.
  const staying = marksOf(toId);
  for (const incoming of marksOf(fromId)) {
    // Only the very same result clashes (the table is unique per person, source
    // and key). The same record found the other way is a different key: it
    // moves beside it, and nothing of the staying person is lost.
    const clash = staying.find(
      (mark) => mark.source_id === incoming.source_id && mark.record_key === incoming.record_key,
    );
    if (clash !== undefined) {
      if (incoming.state !== 'kept' || clash.state === 'kept') continue;
      sql(tree.db, 'DELETE FROM record_mark WHERE id = ?').run(clash.id);
    }
    sql(tree.db, 'UPDATE record_mark SET person_id = ? WHERE id = ?').run(toId, incoming.id);
  }
}
