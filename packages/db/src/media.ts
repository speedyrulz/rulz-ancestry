import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  MEDIA_LIMITS,
  MEDIA_SNIFF_BYTES,
  cleanMediaFields,
  mediaStorePath,
  mediaTypeOf,
  newId,
  type MediaFields,
} from '@rulz/core';
import { sql } from './connection';
import { listCitationUses } from './sources';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

/**
 * Pictures and documents.
 *
 * A file that is added is copied into the `media` folder of the tree, under
 * the SHA-256 of its contents, and gets a `media` row. The copy is never
 * changed or removed by an edit: deleting a file from the tree deletes its
 * row, and Undo brings the row back to a file that is still there. One file
 * is one row; adding it a second time attaches the row that exists.
 *
 * A file is attached to a person or a family as a whole, an event, a
 * citation or a source, and may be attached to several of them. See
 * schema/005-media.ts.
 */

/** The folder inside a tree folder that holds the files. */
export const MEDIA_DIR_NAME = 'media';

/** The largest file the app takes into a tree. Copying blocks the app, and a tree should stay portable. */
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

/** How many files one step may add. */
export const MAX_MEDIA_FILES_AT_ONCE = 100;

/** A file could not be taken into the tree; the message says which and why. */
export class MediaFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaFileError';
  }
}

export interface Media extends MediaFields {
  id: string;
  /** SHA-256 of the file's contents in hex, or null when the tree does not hold the file. */
  sha256: string | null;
  /** The extension the file is stored under, without a dot. May be empty. */
  ext: string;
  mime: string;
  /** Size of the file in bytes. */
  size: number;
  /** The name the file had where it was added from. */
  fileName: string;
  createdAt: number;
  updatedAt: number;
}

export type MediaInput = Partial<MediaFields>;

export type MediaTargetType = 'person' | 'family' | 'event' | 'citation' | 'source';

/** What a file is attached to. */
export interface MediaTarget {
  type: MediaTargetType;
  id: string;
}

/** A file on a person's page, with the things of that page it is attached to. */
export interface PersonMedia extends Media {
  uses: MediaTarget[];
}

/** One thing a file is attached to, with enough to say which it is. */
export interface MediaUse extends MediaTarget {
  /** "person", "family", "citation", "source", or the type of the event, e.g. "birth". */
  what: string;
  /** For a citation: the title of its source and the place in it. For a source: its title. Otherwise empty. */
  detail: string;
  /** The people it concerns: the person, the partners of the family, or those a citation is about. */
  personIds: string[];
}

/** What adding one file did. */
export interface AddedMedia {
  media: Media;
  /** False when the tree held this file already. */
  isNew: boolean;
  /** False when nothing was to be attached, or the file was attached there already. */
  linked: boolean;
}

interface MediaRow {
  id: string;
  sha256: string | null;
  ext: string;
  mime: string;
  size: number;
  file_name: string;
  title: string;
  description: string;
  created_at: number;
  updated_at: number;
}

const MEDIA_COLUMNS =
  'id, sha256, ext, mime, size, file_name, title, description, created_at, updated_at';

const LINK_COLUMN = {
  person: 'person_id',
  family: 'family_id',
  event: 'event_id',
  citation: 'citation_id',
  source: 'source_id',
} as const;

const TARGET_TABLE = {
  person: 'person',
  family: 'family',
  event: 'event',
  citation: 'citation',
  source: 'source',
} as const;

function toMedia(row: MediaRow): Media {
  return {
    id: row.id,
    sha256: row.sha256,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    fileName: row.file_name,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getMedia(tree: Tree, id: string): Media | null {
  const row = sql(tree.db, `SELECT ${MEDIA_COLUMNS} FROM media WHERE id = ?`).get(id) as
    MediaRow | undefined;
  return row ? toMedia(row) : null;
}

export function requireMedia(tree: Tree, id: string): Media {
  const media = getMedia(tree, id);
  if (!media) throw new NotFoundError('file', id);
  return media;
}

/** The tree's media folder. A tree that only exists in memory has none. */
function mediaDirOf(tree: Tree): string {
  if (tree.dir === null) {
    throw new TreeRuleError('this tree is not stored in a folder, so it cannot hold files');
  }
  return join(tree.dir, MEDIA_DIR_NAME);
}

/**
 * The full path of a file in the tree's media folder, or null when the tree
 * does not hold it. The path is built from the file's hash and extension, so
 * it stays right when the tree folder is moved.
 */
export function mediaFilePath(tree: Tree, media: Pick<Media, 'sha256' | 'ext'>): string | null {
  if (tree.dir === null || media.sha256 === null) return null;
  return join(tree.dir, MEDIA_DIR_NAME, ...mediaStorePath(media.sha256, media.ext).split('/'));
}

/** True when the file a row names is in the media folder. */
export function isMediaPresent(tree: Tree, media: Pick<Media, 'sha256' | 'ext'>): boolean {
  const path = mediaFilePath(tree, media);
  return path !== null && existsSync(path);
}

/** A file copied into the media folder under a temporary name, with what was learnt on the way. */
interface StagedFile {
  temp: string;
  sha256: string;
  size: number;
  head: Uint8Array;
  fileName: string;
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024))).toLocaleString('en-GB')} MB`;
}

/**
 * Copies a file into the media folder under a temporary name, working out
 * its SHA-256 as it goes. Nothing in the tree refers to the copy yet.
 */
function stageFile(mediaDir: string, file: string, maxBytes: number): StagedFile {
  const fileName = basename(file);
  const temp = join(mediaDir, `incoming-${newId()}.tmp`);
  let source: number | null = null;
  let target: number | null = null;
  try {
    try {
      source = openSync(file, 'r');
    } catch {
      throw new MediaFileError(`${fileName} could not be opened`);
    }
    const stat = fstatSync(source);
    if (!stat.isFile()) throw new MediaFileError(`${fileName} is not a file`);
    if (stat.size === 0) throw new MediaFileError(`${fileName} is empty`);
    if (stat.size > maxBytes) {
      throw new MediaFileError(
        `${fileName} is ${megabytes(stat.size)}; the largest file a tree takes is ${megabytes(maxBytes)}`,
      );
    }

    target = openSync(temp, 'wx');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let head: Uint8Array = new Uint8Array(0);
    let size = 0;
    for (;;) {
      const read = readSync(source, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      if (size === 0) head = Uint8Array.from(chunk.subarray(0, MEDIA_SNIFF_BYTES));
      size += read;
      // The file may have grown since its size was read.
      if (size > maxBytes) {
        throw new MediaFileError(
          `${fileName} is larger than ${megabytes(maxBytes)}, the largest file a tree takes`,
        );
      }
      hash.update(chunk);
      let written = 0;
      while (written < read) written += writeSync(target, chunk, written, read - written);
    }
    if (size === 0) throw new MediaFileError(`${fileName} is empty`);
    return {
      temp,
      sha256: hash.digest('hex'),
      size,
      head,
      fileName: fileName.slice(0, MEDIA_LIMITS.fileName),
    };
  } catch (error) {
    if (target !== null) {
      closeSync(target);
      target = null;
    }
    rmSync(temp, { force: true });
    if (error instanceof MediaFileError) throw error;
    throw new MediaFileError(`${fileName} could not be copied: ${(error as Error).message}`);
  } finally {
    if (source !== null) closeSync(source);
    if (target !== null) closeSync(target);
  }
}

function requireTarget(tree: Tree, target: MediaTarget): void {
  const found = sql(tree.db, `SELECT 1 FROM ${TARGET_TABLE[target.type]} WHERE id = ?`).get(
    target.id,
  );
  if (found === undefined) throw new NotFoundError(target.type, target.id);
}

function isLinked(tree: Tree, mediaId: string, target: MediaTarget): boolean {
  const column = LINK_COLUMN[target.type];
  return (
    sql(tree.db, `SELECT 1 FROM media_link WHERE ${column} = ? AND media_id = ?`).get(
      target.id,
      mediaId,
    ) !== undefined
  );
}

function insertLink(tree: Tree, mediaId: string, target: MediaTarget): void {
  const column = LINK_COLUMN[target.type];
  // One statement per kind of owner, so each uses that owner's index.
  const last = sql(tree.db, `SELECT max(sort_order) FROM media_link WHERE ${column} = ?`)
    .pluck()
    .get(target.id) as number | null;
  sql(
    tree.db,
    `INSERT INTO media_link (id, media_id, ${column}, sort_order) VALUES (?, ?, ?, ?)`,
  ).run(newId(), mediaId, target.id, (last ?? -1) + 1);
}

export interface AddMediaOptions {
  /** The largest file accepted, in bytes. Tests lower it. */
  maxBytes?: number;
}

/**
 * Takes files into the tree and attaches each to `target`, or to nothing when
 * `target` is null. All of it is one undo step, and none of it happens when
 * one of the files cannot be read.
 *
 * A file the tree holds already (the same contents, whatever its name) is not
 * copied again: the row that exists is attached.
 */
export function addMediaFiles(
  tree: Tree,
  files: readonly string[],
  target: MediaTarget | null,
  options: AddMediaOptions = {},
): AddedMedia[] {
  if (files.length === 0) return [];
  if (files.length > MAX_MEDIA_FILES_AT_ONCE) {
    throw new TreeRuleError(
      `at most ${MAX_MEDIA_FILES_AT_ONCE} files can be added in one go; ${files.length} were chosen`,
    );
  }
  const mediaDir = mediaDirOf(tree);
  if (target !== null) requireTarget(tree, target);
  mkdirSync(mediaDir, { recursive: true });

  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
  const staged: StagedFile[] = [];
  try {
    for (const file of files) staged.push(stageFile(mediaDir, file, maxBytes));

    return tree.transact(files.length === 1 ? 'Add file' : 'Add files', () => {
      if (target !== null) requireTarget(tree, target);
      const bySha = sql(tree.db, `SELECT ${MEDIA_COLUMNS} FROM media WHERE sha256 = ?`);
      return staged.map((file): AddedMedia => {
        const existing = bySha.get(file.sha256) as MediaRow | undefined;
        let media: Media;
        if (existing) {
          media = toMedia(existing);
        } else {
          const type = mediaTypeOf(file.fileName, file.head);
          const path = join(mediaDir, ...mediaStorePath(file.sha256, type.ext).split('/'));
          if (!existsSync(path)) {
            mkdirSync(dirname(path), { recursive: true });
            renameSync(file.temp, path);
          }
          const id = newId();
          const now = Date.now();
          sql(
            tree.db,
            `INSERT INTO media (${MEDIA_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(id, file.sha256, type.ext, type.mime, file.size, file.fileName, '', '', now, now);
          media = requireMedia(tree, id);
        }
        // A row may name a file that has gone from the folder; adding the file again puts it back.
        const stored = mediaFilePath(tree, media);
        if (stored !== null && !existsSync(stored) && existsSync(file.temp)) {
          mkdirSync(dirname(stored), { recursive: true });
          renameSync(file.temp, stored);
        }
        const linked = target !== null && !isLinked(tree, media.id, target);
        if (target !== null && linked) insertLink(tree, media.id, target);
        return { media, isNew: existing === undefined, linked };
      });
    });
  } finally {
    // Whatever was not moved into place is a copy nobody needs.
    for (const file of staged) rmSync(file.temp, { force: true });
  }
}

/** Changes the title or the description of a file. */
export function updateMedia(tree: Tree, id: string, patch: MediaInput): Media {
  return tree.transact('Edit file details', () => {
    const current = requireMedia(tree, id);
    const fields = cleanMediaFields({
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
    });
    if (fields.title === current.title && fields.description === current.description) {
      return current;
    }
    sql(tree.db, 'UPDATE media SET title = ?, description = ?, updated_at = ? WHERE id = ?').run(
      fields.title,
      fields.description,
      Date.now(),
      id,
    );
    return requireMedia(tree, id);
  });
}

/**
 * Deletes a file from the tree, wherever it is attached. The copy in the
 * media folder stays, so that Undo can bring the file back.
 */
export function deleteMedia(tree: Tree, id: string): void {
  tree.transact('Delete file', () => {
    requireMedia(tree, id);
    sql(tree.db, 'DELETE FROM media WHERE id = ?').run(id);
  });
}

/** Attaches a file the tree holds to one more thing. Nothing happens when it is attached there already. */
export function linkMedia(tree: Tree, mediaId: string, target: MediaTarget): void {
  tree.transact('Attach file', () => {
    requireMedia(tree, mediaId);
    requireTarget(tree, target);
    if (!isLinked(tree, mediaId, target)) insertLink(tree, mediaId, target);
  });
}

/** Takes a file away from one thing. The file stays in the tree, attached to whatever else it was. */
export function unlinkMedia(tree: Tree, mediaId: string, target: MediaTarget): void {
  tree.transact('Remove file', () => {
    requireMedia(tree, mediaId);
    const column = LINK_COLUMN[target.type];
    sql(tree.db, `DELETE FROM media_link WHERE ${column} = ? AND media_id = ?`).run(
      target.id,
      mediaId,
    );
  });
}

/** The files attached to one thing, in the order they were attached. */
export function listMedia(tree: Tree, target: MediaTarget): Media[] {
  const column = LINK_COLUMN[target.type];
  const rows = sql(
    tree.db,
    `SELECT ${MEDIA_COLUMNS.split(', ')
      .map((name) => `m.${name}`)
      .join(', ')}
     FROM media_link ml JOIN media m ON m.id = ml.media_id
     WHERE ml.${column} = ? ORDER BY ml.sort_order, ml.id`,
  ).all(target.id) as MediaRow[];
  return rows.map(toMedia);
}

/**
 * Every file on a person's page: those of the person as a whole, of their
 * events, of the families they are a partner in with those families' events,
 * and of the citations named in `citationIds` (the citations on the page).
 * Each file comes once, with the things of the page it is attached to.
 */
export function listPersonMedia(
  tree: Tree,
  personId: string,
  citationIds: readonly string[] = [],
): PersonMedia[] {
  const db = tree.db;
  type Use = { media_id: string; target: string };
  const uses: { mediaId: string; type: MediaTargetType; id: string }[] = [];
  const collect = (type: MediaTargetType, text: string, key: string) => {
    for (const row of sql(db, text).all(key) as Use[]) {
      uses.push({ mediaId: row.media_id, type, id: row.target });
    }
  };
  collect(
    'person',
    `SELECT media_id, person_id AS target FROM media_link
     WHERE person_id = ? ORDER BY sort_order, id`,
    personId,
  );
  collect(
    'event',
    `SELECT ml.media_id, ml.event_id AS target
     FROM event_participant ep JOIN media_link ml ON ml.event_id = ep.event_id
     WHERE ep.person_id = ? ORDER BY ep.sort_order, ml.sort_order, ml.id`,
    personId,
  );
  // One statement per partner place, so each uses that column's index.
  for (const place of ['partner1_id', 'partner2_id'] as const) {
    collect(
      'family',
      `SELECT ml.media_id, ml.family_id AS target
       FROM family f JOIN media_link ml ON ml.family_id = f.id
       WHERE f.${place} = ? ORDER BY f.id, ml.sort_order, ml.id`,
      personId,
    );
    collect(
      'event',
      `SELECT ml.media_id, ml.event_id AS target
       FROM family f JOIN event_participant ep ON ep.family_id = f.id
         JOIN media_link ml ON ml.event_id = ep.event_id
       WHERE f.${place} = ? ORDER BY f.id, ep.sort_order, ml.sort_order, ml.id`,
      personId,
    );
  }
  for (const citationId of citationIds) {
    collect(
      'citation',
      `SELECT media_id, citation_id AS target FROM media_link
       WHERE citation_id = ? ORDER BY sort_order, id`,
      citationId,
    );
  }

  const byId = new Map<string, PersonMedia>();
  for (const use of uses) {
    let media = byId.get(use.mediaId);
    if (!media) {
      const found = getMedia(tree, use.mediaId);
      if (!found) continue;
      media = { ...found, uses: [] };
      byId.set(use.mediaId, media);
    }
    media.uses.push({ type: use.type, id: use.id });
  }
  return [...byId.values()];
}

function partnersOf(tree: Tree, familyId: string): string[] {
  const family = sql(tree.db, 'SELECT partner1_id, partner2_id FROM family WHERE id = ?').get(
    familyId,
  ) as { partner1_id: string | null; partner2_id: string | null } | undefined;
  return [family?.partner1_id ?? null, family?.partner2_id ?? null].filter((id) => id !== null);
}

/** Everything a file is attached to, with who it concerns. */
export function listMediaUses(tree: Tree, mediaId: string): MediaUse[] {
  const db = tree.db;
  const links = sql(
    db,
    `SELECT person_id, family_id, event_id, citation_id, source_id FROM media_link
     WHERE media_id = ? ORDER BY id`,
  ).all(mediaId) as {
    person_id: string | null;
    family_id: string | null;
    event_id: string | null;
    citation_id: string | null;
    source_id: string | null;
  }[];
  const titleOf = (sourceId: string): string =>
    (sql(
      db,
      `SELECT (CASE WHEN title = '' THEN abbreviation ELSE title END) FROM source WHERE id = ?`,
    )
      .pluck()
      .get(sourceId) as string | undefined) ?? '';

  return links.map((link): MediaUse => {
    if (link.person_id !== null) {
      return {
        type: 'person',
        id: link.person_id,
        what: 'person',
        detail: '',
        personIds: [link.person_id],
      };
    }
    if (link.family_id !== null) {
      return {
        type: 'family',
        id: link.family_id,
        what: 'family',
        detail: '',
        personIds: partnersOf(tree, link.family_id),
      };
    }
    if (link.source_id !== null) {
      return {
        type: 'source',
        id: link.source_id,
        what: 'source',
        detail: titleOf(link.source_id),
        personIds: [],
      };
    }
    if (link.citation_id !== null) {
      const citation = sql(db, 'SELECT source_id, page FROM citation WHERE id = ?').get(
        link.citation_id,
      ) as { source_id: string; page: string } | undefined;
      const title = citation ? titleOf(citation.source_id) : '';
      const personIds = listCitationUses(tree, link.citation_id).flatMap((use) => use.personIds);
      return {
        type: 'citation',
        id: link.citation_id,
        what: 'citation',
        detail: [title, citation?.page ?? ''].filter((part) => part !== '').join(', '),
        personIds: [...new Set(personIds)],
      };
    }
    const eventId = link.event_id ?? '';
    const type = sql(db, 'SELECT type FROM event WHERE id = ?').pluck().get(eventId) as
      string | undefined;
    const owners = sql(
      db,
      'SELECT person_id, family_id FROM event_participant WHERE event_id = ? ORDER BY sort_order, id',
    ).all(eventId) as { person_id: string | null; family_id: string | null }[];
    const personIds = owners.flatMap((owner) =>
      owner.person_id !== null
        ? [owner.person_id]
        : owner.family_id !== null
          ? partnersOf(tree, owner.family_id)
          : [],
    );
    return {
      type: 'event',
      id: eventId,
      what: type ?? 'event',
      detail: '',
      personIds: [...new Set(personIds)],
    };
  });
}

export interface MediaListOptions {
  /** Narrows the files by title, description or file name. */
  query?: string;
  /** True lists only the files that are attached to nothing. */
  unattached?: boolean;
  offset?: number;
  limit?: number;
}

/** The text of a search box as a LIKE pattern that matches it anywhere, with `!` as the escape. */
function likePattern(query: string): string {
  return `%${query.trim().replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
}

const MEDIA_FILTER = `(@all = 1 OR title LIKE @like ESCAPE '!' OR file_name LIKE @like ESCAPE '!'
    OR description LIKE @like ESCAPE '!')
  AND (@unattached = 0
    OR NOT EXISTS (SELECT 1 FROM media_link WHERE media_link.media_id = media.id))`;

function filterValues(options: MediaListOptions): {
  all: number;
  like: string;
  unattached: number;
} {
  const query = options.query ?? '';
  return {
    all: query.trim() === '' ? 1 : 0,
    like: likePattern(query),
    unattached: options.unattached === true ? 1 : 0,
  };
}

/** How many files of the tree match. With no options, how many files the tree has. */
export function countMedia(tree: Tree, options: MediaListOptions = {}): number {
  return sql(tree.db, `SELECT count(*) FROM media WHERE ${MEDIA_FILTER}`)
    .pluck()
    .get(filterValues(options)) as number;
}

/** The files of the tree, the one added last first. */
export function listAllMedia(tree: Tree, options: MediaListOptions = {}): Media[] {
  const rows = sql(
    tree.db,
    `SELECT ${MEDIA_COLUMNS} FROM media WHERE ${MEDIA_FILTER}
     ORDER BY id DESC LIMIT @limit OFFSET @offset`,
  ).all({
    ...filterValues(options),
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  }) as MediaRow[];
  return rows.map(toMedia);
}
