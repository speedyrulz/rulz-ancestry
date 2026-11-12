import type { GedcomVersion } from '@rulz/core';
import { sql } from '../connection';
import type { Tree } from '../tree';

/**
 * How the lines of an imported GEDCOM file are stored in the `gedcom_record`
 * table (see schema/002-gedcom.ts), shared by the import and the export.
 */

/**
 * What a line directly under a person or family record became:
 *
 * - person records: `name`, `sex`, `living`, `event`, `child-of` (FAMC, with
 *   the family's id) and `partner-in` (FAMS, with the family's id);
 * - family records: `partner` (HUSB or WIFE, with the person's id), `child`
 *   (CHIL, with the person's id) and `event`;
 * - both: `citation` (a SOUR line that cites a source record for the person
 *   or family as a whole, with the citation's id) and `media` (an OBJE line
 *   that attaches a picture or document to the person or family as a whole,
 *   with the id of the `media` row).
 *
 * The OBJE lines further down, under an event, a citation or a source, carry
 * no mark. The export tells which file each stands for from the line itself:
 * a pointer names a media record, and a media item written in place is found
 * by its wording (see `listEmbeddedMedia`).
 */
export type PartKind =
  | 'name'
  | 'sex'
  | 'living'
  | 'event'
  | 'child-of'
  | 'partner-in'
  | 'partner'
  | 'child'
  | 'citation'
  | 'media';

/** One line under a record, with everything below it. */
export interface StoredPart {
  /** What the line became. Left out for a line the app keeps as written. */
  k?: PartKind;
  /** The id of the name, event, family, person, citation or file the line became. */
  r?: string;
  /** The line and everything under it, as written in the file. */
  t: string;
  /**
   * For a name or an event: one entry for each SOUR line directly under it, in
   * order. An entry is the id of the citation that line became, or null for a
   * line that is kept as written (a source described in place, say). Left out
   * when no line under it became a citation.
   */
  c?: (string | null)[];
}

export type RecordKind = 'head' | 'person' | 'family' | 'source' | 'media' | 'kept';

export interface StoredRecord {
  /** For a person, family, source or media record: the id of that person, family, source or file. */
  id: string;
  position: number;
  tag: string;
  xref: string | null;
  kind: RecordKind;
  /** The whole record as written; for a person or family record, only its first line. */
  text: string;
  /** For a person or family record: the lines under it. */
  parts: StoredPart[] | null;
}

interface RecordRow {
  id: string;
  position: number;
  tag: string;
  xref: string | null;
  kind: RecordKind;
  text: string;
  parts: string | null;
}

/** Every record of the file the tree was imported from, in file order. */
export function listStoredRecords(tree: Tree): StoredRecord[] {
  const rows = sql(
    tree.db,
    'SELECT id, position, tag, xref, kind, text, parts FROM gedcom_record ORDER BY position, id',
  ).all() as RecordRow[];
  return rows.map((row) => ({
    ...row,
    parts: row.parts === null ? null : (JSON.parse(row.parts) as StoredPart[]),
  }));
}

/** The record a person or family was imported from, or null when it was added in the app. */
export function getStoredRecord(tree: Tree, id: string): StoredRecord | null {
  const row = sql(
    tree.db,
    'SELECT id, position, tag, xref, kind, text, parts FROM gedcom_record WHERE id = ?',
  ).get(id) as RecordRow | undefined;
  if (!row) return null;
  return { ...row, parts: row.parts === null ? null : (JSON.parse(row.parts) as StoredPart[]) };
}

/** Which person or family each merged one went into: the id it had, and the id of the one left. */
export function listMergedRecords(tree: Tree): { id: string; intoId: string }[] {
  return sql(
    tree.db,
    'SELECT id, into_id AS intoId FROM merged_record ORDER BY merged_at, id',
  ).all() as { id: string; intoId: string }[];
}

/**
 * The lines of a person's or family's imported record that the app has no
 * fields for, each with what is under it, as written in the file. The lines
 * of records that were merged into this one follow its own. Empty for a
 * person or family that was added in the app.
 */
export function keptLinesOf(tree: Tree, id: string): string[] {
  const merged = sql(
    tree.db,
    'SELECT id FROM merged_record WHERE into_id = ? ORDER BY merged_at, id',
  )
    .pluck()
    .all(id) as string[];
  return [id, ...merged].flatMap((recordId) =>
    (getStoredRecord(tree, recordId)?.parts ?? [])
      .filter((part) => part.k === undefined)
      .map((part) => part.t),
  );
}

/**
 * The file each media item written in place became, by its wording (see
 * `embeddedMediaKey` in `@rulz/core`). Empty for a tree whose file had none.
 */
export function listEmbeddedMedia(tree: Tree): Map<string, string> {
  const rows = sql(tree.db, 'SELECT key, media_id FROM gedcom_media').all() as {
    key: string;
    media_id: string;
  }[];
  return new Map(rows.map((row) => [row.key, row.media_id]));
}

/** `tree_meta` keys that describe the file a tree was imported from. */
export const GEDCOM_META = {
  version: 'gedcom_version',
  encoding: 'gedcom_encoding',
  lineEnding: 'gedcom_line_ending',
  fileName: 'gedcom_file',
  importedAt: 'gedcom_imported_at',
} as const;

/** What is known about the file a tree was imported from. */
export interface GedcomSource {
  version: GedcomVersion;
  /** The character set the file was in, e.g. "UTF-8" or "ANSEL". */
  encoding: string;
  lineEnding: string;
  /** The file's name, without its folder. */
  fileName: string;
  importedAt: number;
}

/** The file the tree was imported from, or null for a tree that was not imported. */
export function getGedcomSource(tree: Tree): GedcomSource | null {
  const version = tree.getMeta(GEDCOM_META.version);
  if (version !== '5.5.1' && version !== '7.0') return null;
  return {
    version,
    encoding: tree.getMeta(GEDCOM_META.encoding) ?? '',
    lineEnding: tree.getMeta(GEDCOM_META.lineEnding) ?? '\r\n',
    fileName: tree.getMeta(GEDCOM_META.fileName) ?? '',
    importedAt: Number(tree.getMeta(GEDCOM_META.importedAt) ?? 0),
  };
}
