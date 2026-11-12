import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  MEDIA_LIMITS,
  MEDIA_SNIFF_BYTES,
  cleanMediaFields,
  isWebAddress,
  mediaStorePath,
  mediaTypeOf,
  newId,
  referenceFileName,
  type MediaFields,
  type MediaType,
} from '@rulz/core';
import { sql } from './connection';
import { listCitationUses } from './sources';
import { NotFoundError, TreeRuleError, type Tree } from './tree';
import { ZipError } from './zip';

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
 *
 * An imported GEDCOM file names files without holding them. Such a row has no
 * `sha256` until the file itself is given to the tree: from the zip archive
 * the GEDCOM file came in, from a file the user points at, or from a folder
 * the user has the app look in. See schema/006-gedcom-media.ts.
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
  /**
   * Where an imported GEDCOM file says the file is: a path or a web address.
   * Empty for a file that was added in the app.
   */
  origin: string;
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
  origin: string;
  created_at: number;
  updated_at: number;
}

const MEDIA_COLUMNS =
  'id, sha256, ext, mime, size, file_name, title, description, origin, created_at, updated_at';

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
    origin: row.origin,
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

/** Where the bytes of a file come from: a file on disk, or an entry of a zip archive. */
export interface ByteSource {
  /** The name the file has where it comes from, without a folder. */
  fileName: string;
  /** Fills the buffer with the next bytes and returns how many it gave; 0 at the end. */
  read(buffer: Buffer): number;
}

/**
 * Copies the bytes of a file into the media folder under a temporary name,
 * working out their SHA-256 on the way. Nothing in the tree refers to the
 * copy yet.
 */
function stageFrom(mediaDir: string, source: ByteSource, maxBytes: number): StagedFile {
  const fileName = source.fileName;
  const temp = join(mediaDir, `incoming-${newId()}.tmp`);
  let target: number | null = null;
  try {
    target = openSync(temp, 'wx');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let head: Uint8Array = new Uint8Array(0);
    let size = 0;
    for (;;) {
      const read = source.read(buffer);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      if (size === 0) head = Uint8Array.from(chunk.subarray(0, MEDIA_SNIFF_BYTES));
      size += read;
      // A file on disk may have grown since its size was read.
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
    if (target !== null) closeSync(target);
  }
}

/** Stages a file on disk; see {@link stageFrom}. */
function stageFile(mediaDir: string, file: string, maxBytes: number): StagedFile {
  const fileName = basename(file);
  let source: number;
  try {
    source = openSync(file, 'r');
  } catch {
    throw new MediaFileError(`${fileName} could not be opened`);
  }
  try {
    const stat = fstatSync(source);
    if (!stat.isFile()) throw new MediaFileError(`${fileName} is not a file`);
    if (stat.size === 0) throw new MediaFileError(`${fileName} is empty`);
    if (stat.size > maxBytes) {
      throw new MediaFileError(
        `${fileName} is ${megabytes(stat.size)}; the largest file a tree takes is ${megabytes(maxBytes)}`,
      );
    }
    return stageFrom(
      mediaDir,
      { fileName, read: (buffer) => readSync(source, buffer, 0, buffer.length, null) },
      maxBytes,
    );
  } finally {
    closeSync(source);
  }
}

/**
 * Moves a staged copy to its place in the media folder, unless the folder
 * holds that file already, and says what kind of file it is.
 */
function placeStaged(mediaDir: string, file: StagedFile): MediaType {
  const type = mediaTypeOf(file.fileName, file.head);
  const path = join(mediaDir, ...mediaStorePath(file.sha256, type.ext).split('/'));
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    renameSync(file.temp, path);
  }
  return type;
}

/**
 * Makes a row that so far only named a file hold it: the staged copy goes
 * into the media folder, and the row says what the file is.
 */
function holdStaged(tree: Tree, mediaDir: string, mediaId: string, file: StagedFile): void {
  const type = placeStaged(mediaDir, file);
  sql(
    tree.db,
    `UPDATE media SET sha256 = ?, ext = ?, mime = ?, size = ?, file_name = ?, updated_at = ?
     WHERE id = ?`,
  ).run(file.sha256, type.ext, type.mime, file.size, file.fileName, Date.now(), mediaId);
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
      // An imported file may name one picture in two records; the older row is used.
      const bySha = sql(
        tree.db,
        `SELECT ${MEDIA_COLUMNS} FROM media WHERE sha256 = ? ORDER BY id LIMIT 1`,
      );
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
            `INSERT INTO media (${MEDIA_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            file.sha256,
            type.ext,
            type.mime,
            file.size,
            file.fileName,
            '',
            '',
            '',
            now,
            now,
          );
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

/** A row that names a file the tree does not hold, with where the file is said to be. */
export interface NamedFile {
  id: string;
  /** The path or web address the imported file gives. */
  reference: string;
}

/** Somewhere the files an imported GEDCOM file names can be had from, such as the zip archive it came in. */
export interface MediaFileSource {
  /** The bytes of the file a reference names, or null when the source does not have it. */
  open(reference: string): ByteSource | null;
}

/**
 * Takes the files that rows name into the tree, from `source`, as far as it
 * has them. This writes without an undo step of its own: it is for an import,
 * which fills an empty tree. Returns how many files the tree now holds, and a
 * line for each file that could not be taken.
 */
export function holdNamedFiles(
  tree: Tree,
  named: readonly NamedFile[],
  source: MediaFileSource,
  options: AddMediaOptions = {},
): { held: number; problems: string[] } {
  const problems: string[] = [];
  if (tree.dir === null || named.length === 0) return { held: 0, problems };
  const mediaDir = join(tree.dir, MEDIA_DIR_NAME);
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
  let held = 0;
  let made = false;
  for (const item of named) {
    let staged: StagedFile | null = null;
    try {
      const bytes = source.open(item.reference);
      if (bytes === null) continue;
      if (!made) {
        mkdirSync(mediaDir, { recursive: true });
        made = true;
      }
      staged = stageFrom(mediaDir, bytes, maxBytes);
      holdStaged(tree, mediaDir, item.id, staged);
      held += 1;
    } catch (error) {
      // One picture that cannot be taken does not stop the import; anything else does.
      if (!(error instanceof MediaFileError) && !(error instanceof ZipError)) throw error;
      problems.push(error.message);
    } finally {
      if (staged !== null) rmSync(staged.temp, { force: true });
    }
  }
  return { held, problems };
}

/**
 * Gives a row the file it names. For a row of an imported GEDCOM file, which
 * the tree knows of and does not hold, any file the user points at is taken.
 * For a row whose file has gone from the media folder, only that same file
 * is, told by its contents.
 */
export function setMediaFile(
  tree: Tree,
  mediaId: string,
  file: string,
  options: AddMediaOptions = {},
): Media {
  const mediaDir = mediaDirOf(tree);
  const current = requireMedia(tree, mediaId);
  if (isMediaPresent(tree, current)) throw new TreeRuleError('the tree holds this file already');
  mkdirSync(mediaDir, { recursive: true });
  const staged = stageFile(mediaDir, file, options.maxBytes ?? MAX_MEDIA_BYTES);
  try {
    if (current.sha256 !== null && current.sha256 !== staged.sha256) {
      throw new MediaFileError(
        `${staged.fileName} is not the file the tree had: its contents are different`,
      );
    }
    return tree.transact('Add the file', () => {
      const row = requireMedia(tree, mediaId);
      if (row.sha256 === null) holdStaged(tree, mediaDir, mediaId, staged);
      else placeStaged(mediaDir, staged);
      return requireMedia(tree, mediaId);
    });
  } finally {
    rmSync(staged.temp, { force: true });
  }
}

/** How many files {@link locateMediaFiles} looks at in a folder before it stops. */
export const MAX_LOCATE_FILES = 50_000;
/** How many folders deep it looks. */
const MAX_LOCATE_DEPTH = 12;

export interface LocateResult {
  /** Files the tree knew of and did not hold, before the search. */
  wanted: number;
  /** How many of them were found and taken into the tree. */
  found: number;
  /** How many were left because two or more files in the folder fit equally well. */
  ambiguous: number;
  /** Files the search looked at. */
  scanned: number;
  /** True when the folder holds more files than the search looks at. */
  truncated: boolean;
}

/** The parts of a path, in lower case: `C:\Photos\Ann.JPG` gives `c:`, `photos`, `ann.jpg`. */
function pathParts(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[\\/]/)
    .filter((part) => part !== '' && part !== '.');
}

/**
 * Looks in a folder, and the folders inside it, for the files the tree knows
 * of and does not hold, and takes those it finds into the tree as one undo
 * step.
 *
 * A file is found by its name. Where several files have that name, the one
 * whose folders match the end of the path the imported file gives wins:
 * `C:\Old PC\Tree Media\1921\ann.jpg` is `1921\ann.jpg` in the folder
 * `Tree Media`, wherever that folder is now. When two fit equally well, none
 * is taken.
 */
export function locateMediaFiles(
  tree: Tree,
  folder: string,
  options: AddMediaOptions = {},
): LocateResult {
  const mediaDir = mediaDirOf(tree);
  const wanted = sql(
    tree.db,
    'SELECT id, origin, file_name FROM media WHERE sha256 IS NULL ORDER BY id',
  ).all() as { id: string; origin: string; file_name: string }[];
  const result: LocateResult = {
    wanted: wanted.length,
    found: 0,
    ambiguous: 0,
    scanned: 0,
    truncated: false,
  };
  if (wanted.length === 0) return result;

  // Every file below the folder, by its name in lower case.
  const byName = new Map<string, { path: string; parts: string[] }[]>();
  const own = resolve(mediaDir).toLowerCase();
  const pending: { dir: string; depth: number }[] = [{ dir: resolve(folder), depth: 0 }];
  while (pending.length > 0 && !result.truncated) {
    const next = pending.pop();
    if (!next || next.dir.toLowerCase() === own) continue;
    let entries;
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      // A folder that cannot be read is passed over.
      continue;
    }
    for (const entry of entries) {
      const path = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (next.depth < MAX_LOCATE_DEPTH) pending.push({ dir: path, depth: next.depth + 1 });
      } else if (entry.isFile()) {
        if (result.scanned >= MAX_LOCATE_FILES) {
          result.truncated = true;
          break;
        }
        result.scanned += 1;
        const name = entry.name.toLowerCase();
        const found = { path, parts: pathParts(path) };
        const list = byName.get(name);
        if (list) list.push(found);
        else byName.set(name, [found]);
      }
    }
  }

  const matches: { id: string; path: string }[] = [];
  for (const row of wanted) {
    const web = isWebAddress(row.origin);
    const named = web ? [] : pathParts(row.origin);
    const name = (
      named[named.length - 1] ??
      (row.file_name === '' ? referenceFileName(row.origin) : row.file_name)
    ).toLowerCase();
    const candidates = name === '' ? [] : (byName.get(name) ?? []);
    if (candidates.length === 0) continue;
    /** How many folders and names at the end of the two paths are the same. */
    const fit = (parts: readonly string[]): number => {
      let same = 0;
      while (
        same < parts.length &&
        same < named.length &&
        parts[parts.length - 1 - same] === named[named.length - 1 - same]
      ) {
        same += 1;
      }
      return same;
    };
    let best: { path: string; fit: number } | null = null;
    let tie = false;
    for (const candidate of candidates) {
      const score = fit(candidate.parts);
      if (best === null || score > best.fit) {
        best = { path: candidate.path, fit: score };
        tie = false;
      } else if (score === best.fit) {
        tie = true;
      }
    }
    if (best === null) continue;
    if (tie) result.ambiguous += 1;
    else matches.push({ id: row.id, path: best.path });
  }
  if (matches.length === 0) return result;

  mkdirSync(mediaDir, { recursive: true });
  const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
  const staged: { id: string; file: StagedFile }[] = [];
  try {
    for (const match of matches) {
      try {
        staged.push({ id: match.id, file: stageFile(mediaDir, match.path, maxBytes) });
      } catch (error) {
        // A file that cannot be read, or is too large, is left where it is.
        if (!(error instanceof MediaFileError)) throw error;
      }
    }
    if (staged.length === 0) return result;
    tree.transact(staged.length === 1 ? 'Find file' : 'Find files', () => {
      for (const item of staged) {
        const row = getMedia(tree, item.id);
        if (row === null || row.sha256 !== null) continue;
        holdStaged(tree, mediaDir, item.id, item.file);
        result.found += 1;
      }
    });
    return result;
  } finally {
    for (const item of staged) rmSync(item.file.temp, { force: true });
  }
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
  /** True lists only the files the tree knows of and does not hold. */
  notHeld?: boolean;
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
    OR NOT EXISTS (SELECT 1 FROM media_link WHERE media_link.media_id = media.id))
  AND (@notHeld = 0 OR sha256 IS NULL)`;

function filterValues(options: MediaListOptions): {
  all: number;
  like: string;
  unattached: number;
  notHeld: number;
} {
  const query = options.query ?? '';
  return {
    all: query.trim() === '' ? 1 : 0,
    like: likePattern(query),
    unattached: options.unattached === true ? 1 : 0,
    notHeld: options.notHeld === true ? 1 : 0,
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
