import { cleanMediaFields, type MediaFields } from '../media';
import {
  cloneNode,
  findChild,
  insertInOrder,
  makeNode,
  pointerTarget,
  structureKey,
  touch,
  touchAll,
  type GedcomNode,
  type GedcomVersion,
} from './node';
import { ownNote } from './sources';

/**
 * Pictures and documents in a GEDCOM file: reading one from its structure,
 * and writing one back with as little change to the original lines as
 * possible.
 *
 * A file is named in one of two ways. A media record (`0 @M1@ OBJE`) stands
 * on its own, and a line under a person, a family, an event, a citation or a
 * source points at it (`1 OBJE @M1@`). GEDCOM 5.5.1 also lets the same
 * structure be written in place, under the thing it belongs to (`1 OBJE`
 * with a `2 FILE` line below it); GEDCOM 7.0 has records only.
 *
 * A GEDCOM file names a picture; it does not hold it. `FILE` gives a path or
 * a web address, as the program that wrote the file knew it.
 */

/** What the app reads from a media record or from a media item written in place. */
export interface MediaRecordFields extends MediaFields {
  /** Where the file is, as written: a path or a web address. Empty when none is given. */
  file: string;
  /** The kind of file, as written: `jpg` in GEDCOM 5.5.1, `image/jpeg` in 7.0. */
  format: string;
}

/** The longest file reference and format the app stores. */
export const MEDIA_RECORD_LIMITS = { file: 2000, format: 100 } as const;

/** The usual order of the lines under a FILE line. */
const FILE_ORDER = ['FORM', 'TITL'] as const;
/** The usual order of the first lines of a media item written in place. */
const IN_PLACE_ORDER = ['FILE', 'FORM', 'TITL'] as const;

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/**
 * The title line of a media structure, with the line it stands under. A
 * record has it under FILE; a media item written in place, and a record of
 * GEDCOM 5.5 and of many programs since, has it under OBJE. The first that
 * says something wins.
 */
function titleLine(node: GedcomNode): { parent: GedcomNode; line: GedcomNode } | null {
  const file = findChild(node, 'FILE');
  const places = file ? [file, node] : [node];
  let first: { parent: GedcomNode; line: GedcomNode } | null = null;
  for (const parent of places) {
    const line = findChild(parent, 'TITL');
    if (!line) continue;
    if (line.value.trim() !== '') return { parent, line };
    first ??= { parent, line };
  }
  return first;
}

/** Reads a media record, or a media item written in place. */
export function readMediaRecord(node: GedcomNode): MediaRecordFields {
  const file = findChild(node, 'FILE');
  const format = (file ? findChild(file, 'FORM') : undefined) ?? findChild(node, 'FORM');
  return {
    file: oneLine(file?.value ?? '', MEDIA_RECORD_LIMITS.file),
    format: oneLine(format?.value ?? '', MEDIA_RECORD_LIMITS.format),
    ...cleanMediaFields({
      title: titleLine(node)?.line.value ?? '',
      description: ownNote(node)?.value ?? '',
    }),
  };
}

/**
 * The cross-reference id of the media record a line points at (`1 OBJE @M1@`
 * gives `M1`), or null when the line is not such a pointer.
 */
export function mediaPointer(node: GedcomNode): string | null {
  return node.tag === 'OBJE' ? pointerTarget(node.value) : null;
}

/** True for a media item written in place: an OBJE line that points nowhere and names a file below it. */
export function isEmbeddedMedia(node: GedcomNode): boolean {
  if (node.tag !== 'OBJE' || node.xref !== null || node.value.trim() !== '') return false;
  return (findChild(node, 'FILE')?.value.trim() ?? '') !== '';
}

/**
 * Text that is the same for two media items written in place exactly when
 * they say the same in the same words. Programs write such an item out again
 * under every person on a photograph; equal ones are one file in the tree.
 */
export function embeddedMediaKey(node: GedcomNode): string {
  return structureKey(node);
}

/** The file a media structure is to name, when it names none or another one. */
export interface MediaFileReference {
  /** A path or a web address. */
  reference: string;
  /** The file extension without its dot; may be empty. */
  ext: string;
  /** The media type, e.g. `image/jpeg`. */
  mime: string;
}

export interface MediaWriteOptions {
  version: GedcomVersion;
  /** For a record: its cross-reference id. Left out for a media item written in place. */
  xref?: string;
  /**
   * Makes the structure name this file. Left out, the FILE line stays as it
   * was read, which is right for a file the tree does not hold and for an
   * export that does not carry the files.
   */
  file?: MediaFileReference;
}

/** The value of a FORM line for a file: its extension in GEDCOM 5.5.1, its media type in 7.0. */
function formatValue(file: MediaFileReference, version: GedcomVersion): string {
  if (version === '7.0') return file.mime === '' ? 'application/octet-stream' : file.mime;
  return file.ext === '' ? 'bin' : file.ext;
}

/**
 * The structure for a picture or document. With no `original` it is written
 * afresh. With the structure the file was imported from, only the lines whose
 * field has changed since are rewritten; the rest, and everything the app
 * does not model (a second file, a cropping, other programs' own tags), stay
 * as they were.
 */
export function patchMediaRecord(
  original: GedcomNode | null,
  fields: MediaFields,
  options: MediaWriteOptions,
): GedcomNode {
  const node = original ? cloneNode(original) : makeNode('OBJE');
  if (!original && options.xref !== undefined) node.xref = options.xref;
  const record = node.xref !== null;
  const was = original ? readMediaRecord(original) : null;

  if (options.file !== undefined) {
    let file = findChild(node, 'FILE');
    if (!file) {
      file = makeNode('FILE', options.file.reference);
      node.children.unshift(file);
      if (!findChild(node, 'FORM')) {
        file.children.push(makeNode('FORM', formatValue(options.file, options.version)));
      }
    } else if (file.value !== options.file.reference) {
      file.value = options.file.reference;
      touch(file);
    }
  }

  if (was === null || was.title !== fields.title) {
    const existing = titleLine(node);
    if (existing) {
      if (fields.title === '') {
        existing.parent.children = existing.parent.children.filter(
          (child) => child !== existing.line,
        );
      } else if (existing.line.value !== fields.title) {
        existing.line.value = fields.title;
        touch(existing.line);
      }
    } else if (fields.title !== '') {
      const file = findChild(node, 'FILE');
      // A record, and anything in 7.0, has its title under FILE; a media item
      // written in place in 5.5.1 has it beside FILE.
      if (file && (record || options.version === '7.0')) {
        insertInOrder(file, makeNode('TITL', fields.title), FILE_ORDER);
      } else {
        insertInOrder(node, makeNode('TITL', fields.title), IN_PLACE_ORDER);
      }
    }
  }

  if (was === null || was.description !== fields.description) {
    const existing = ownNote(node);
    if (fields.description === '') {
      if (existing) node.children = node.children.filter((child) => child !== existing);
    } else if (!existing) {
      node.children.push(makeNode('NOTE', fields.description));
    } else if (existing.value !== fields.description) {
      existing.value = fields.description;
      touch(existing);
    }
  }
  return node;
}

/**
 * A media record made from a media item that was written in place, for a
 * file in GEDCOM 7.0, which has records only. The format and the title move
 * under FILE, where a record has them; everything else comes along as it is.
 */
export function embeddedToRecord(node: GedcomNode, xref: string): GedcomNode {
  const record = cloneNode(node);
  // Every line is written at another level than it was read from.
  touchAll(record);
  record.xref = xref;
  record.value = '';
  const file = findChild(record, 'FILE');
  if (file) {
    for (const tag of FILE_ORDER) {
      const own = findChild(record, tag);
      if (!own || findChild(file, tag)) continue;
      record.children = record.children.filter((child) => child !== own);
      insertInOrder(file, own, FILE_ORDER);
    }
  }
  return record;
}
