import { sql, type Db } from './connection';

/**
 * The activity log of the optional AI assistant, in the application database.
 * The assistant works in sessions the user starts, and every call it makes in
 * a session is written here, so that the user can see what it asked and which
 * records it read.
 *
 * The log holds what was asked and which records were read, never the text of
 * a record. It belongs to the installation, not to a tree, so it lives in
 * app.db and never travels with a tree's folder. Nothing here knows what a
 * detail means: the caller decides what to log, and this module only keeps it
 * small and clean.
 *
 * app.db is a file that anything can have written to, so what is read back is
 * checked again, the same way as what is written.
 */

export const AI_ACTIVITY_KINDS = [
  'session-started',
  'session-ended',
  'sources-listed',
  'tree-searched',
  'person-read',
  'relatives-read',
  'records-searched',
  'record-read',
  'proposal-made',
  'app-connected',
] as const;
export type AiActivityKind = (typeof AI_ACTIVITY_KINDS)[number];

/** Rows older than this many days are removed. */
export const AI_ACTIVITY_KEEP_DAYS = 90;
/** The most rows the log holds; the oldest go first. */
export const AI_ACTIVITY_MAX_ROWS = 20_000;
/** The most keys one detail may have. */
export const AI_ACTIVITY_DETAIL_KEYS = 20;
/** The longest text of one value of a detail, in characters. */
export const AI_ACTIVITY_TEXT_MAX = 300;

/** The longest key of a detail, in characters. A longer one is dropped. */
const KEY_MAX = 40;
/** The longest id of a session or of a tree, in characters. */
const ID_MAX = 64;
/** How many entries one page holds when the caller does not say, and at most. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = AI_ACTIVITY_KEEP_DAYS * DAY_MS;

/** A flat object: no nesting, no arrays. */
export type AiActivityDetail = Record<string, string | number | boolean | null>;

export interface AiActivityInput {
  /** Names the session; any text of 1 to 64 characters. */
  sessionId: string;
  /** The id of the tree the session is for; 1 to 64 characters. */
  treeId: string;
  kind: AiActivityKind;
  /** When it happened, in Unix milliseconds. */
  at: number;
  detail: AiActivityDetail;
}

export interface AiActivityEntry extends AiActivityInput {
  id: number;
}

interface Row {
  id: number;
  at: unknown;
  session_id: unknown;
  tree_id: unknown;
  kind: unknown;
  detail: unknown;
}

const KINDS: ReadonlySet<string> = new Set(AI_ACTIVITY_KINDS);

function isKind(value: unknown): value is AiActivityKind {
  return typeof value === 'string' && KINDS.has(value);
}

/** A control character: those below the space, the delete character, and the second set of 128 to 159. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (isControl(text.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * A text value as it is kept: control characters become a space, so that a
 * line of the log stays one line, and a longer text is cut. Half of a pair of
 * UTF-16 units left at the end of the cut is dropped too.
 */
function cleanText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length && out.length < AI_ACTIVITY_TEXT_MAX; i += 1) {
    const code = text.charCodeAt(i);
    out += isControl(code) ? ' ' : text.charAt(i);
  }
  const last = out.charCodeAt(out.length - 1);
  if (out.length === AI_ACTIVITY_TEXT_MAX && last >= 0xd800 && last <= 0xdbff) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * A detail as it is kept. Anything that is not a plain object becomes an
 * empty detail. A value that is not text, a finite number, true or false, or
 * null is dropped, and so is a key that is too long or holds a control
 * character. Beyond the most keys, the rest are dropped.
 */
function cleanDetail(value: unknown): AiActivityDetail {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const kept: [string, string | number | boolean | null][] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (kept.length >= AI_ACTIVITY_DETAIL_KEYS) break;
    if (key.length > KEY_MAX || hasControl(key)) continue;
    if (typeof item === 'string') {
      kept.push([key, cleanText(item)]);
    } else if (typeof item === 'number') {
      if (Number.isFinite(item)) kept.push([key, item]);
    } else if (typeof item === 'boolean' || item === null) {
      kept.push([key, item]);
    }
  }
  // Built this way, a key such as "__proto__" is an ordinary key, not the object's prototype.
  return Object.fromEntries(kept);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= ID_MAX;
}

/** Removes what is too old as of `now`, and what is beyond the most rows. Returns how many rows went. */
function pruneRows(db: Db, now: number): number {
  const byAge = sql(db, 'DELETE FROM ai_activity WHERE at < ?').run(now - KEEP_MS).changes;
  const byCount = sql(
    db,
    `DELETE FROM ai_activity WHERE id IN (
       SELECT id FROM ai_activity ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?
     )`,
  ).run(AI_ACTIVITY_MAX_ROWS).changes;
  return byAge + byCount;
}

/**
 * Writes one entry, then removes what is too old (measured from `input.at`)
 * and what is beyond the most rows. Both happen in one transaction.
 *
 * What it is given is cleaned rather than trusted: see `cleanDetail`. It
 * throws a TypeError when the kind is not one of the kinds, when `at` is not
 * a whole number of milliseconds of zero or more, or when the id of the
 * session or of the tree is not a text of 1 to 64 characters.
 */
export function logAiActivity(db: Db, input: AiActivityInput): void {
  if (!isKind(input.kind)) throw new TypeError('this is not a kind of AI activity');
  if (!Number.isSafeInteger(input.at) || input.at < 0) {
    throw new TypeError('the time of an AI activity must be a whole number of zero or more');
  }
  if (!isId(input.sessionId)) {
    throw new TypeError(`the id of a session must be a text of 1 to ${ID_MAX} characters`);
  }
  if (!isId(input.treeId)) {
    throw new TypeError(`the id of a tree must be a text of 1 to ${ID_MAX} characters`);
  }
  const detail = JSON.stringify(cleanDetail(input.detail));
  db.transaction(() => {
    sql(
      db,
      'INSERT INTO ai_activity (at, session_id, tree_id, kind, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(input.at, input.sessionId, input.treeId, input.kind, detail);
    pruneRows(db, input.at);
  })();
}

function parseDetail(text: unknown): AiActivityDetail {
  if (typeof text !== 'string') return {};
  try {
    return cleanDetail(JSON.parse(text));
  } catch {
    return {};
  }
}

function entryOf(row: Row): AiActivityEntry | null {
  if (!isKind(row.kind)) return null;
  // A time is a whole number of milliseconds of zero or more, as it is when it is written.
  if (typeof row.at !== 'number' || !Number.isSafeInteger(row.at) || row.at < 0) return null;
  if (!isId(row.session_id) || !isId(row.tree_id)) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    treeId: row.tree_id,
    kind: row.kind,
    at: row.at,
    detail: parseDetail(row.detail),
  };
}

function wholeNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * The entries, the latest first (by `at`, then by `id`, both descending), of
 * one session when it is named. `limit` is 100 when left out and is kept
 * between 1 and 500; `offset` is 0 when left out.
 *
 * A row whose kind is unknown, or whose time or ids are not of the right
 * kind, is left out, and a row whose detail is not JSON of a flat object
 * comes back with an empty detail. A page with rows left out is shorter than
 * `limit`, and the offset still counts those rows: paging is not corrected
 * for them, since only a file written by something else holds such rows.
 */
export function listAiActivity(
  db: Db,
  request: { limit?: number; offset?: number; sessionId?: string } = {},
): AiActivityEntry[] {
  const limit = Math.min(MAX_LIMIT, Math.max(1, wholeNumber(request.limit, DEFAULT_LIMIT)));
  const offset = Math.max(0, wholeNumber(request.offset, 0));
  const rows = sql(
    db,
    `SELECT id, at, session_id, tree_id, kind, detail FROM ai_activity
     WHERE @sessionId IS NULL OR session_id = @sessionId
     ORDER BY at DESC, id DESC
     LIMIT @limit OFFSET @offset`,
  ).all({ sessionId: request.sessionId ?? null, limit, offset }) as Row[];
  const entries: AiActivityEntry[] = [];
  for (const row of rows) {
    const entry = entryOf(row);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** How many entries there are, of one session when it is named. */
export function countAiActivity(db: Db, sessionId?: string): number {
  return sql(
    db,
    'SELECT count(*) FROM ai_activity WHERE @sessionId IS NULL OR session_id = @sessionId',
  )
    .pluck()
    .get({ sessionId: sessionId ?? null }) as number;
}

/** Removes every entry. Returns how many there were. */
export function clearAiActivity(db: Db): number {
  return sql(db, 'DELETE FROM ai_activity').run().changes;
}

/**
 * Removes what is older than 90 days before `now`, and what is beyond the
 * most rows. An entry with a time after `now` is kept. Returns how many rows
 * went.
 */
export function pruneAiActivity(db: Db, now: number): number {
  if (!Number.isFinite(now)) throw new TypeError('the time to prune from must be a number');
  return db.transaction(() => pruneRows(db, now))();
}
