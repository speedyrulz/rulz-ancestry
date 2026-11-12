import {
  childValue,
  cloneNode,
  findChild,
  insertInOrder,
  makeNode,
  pointerTarget,
  pointerTo,
  touch,
  type GedcomNode,
} from './node';

/**
 * Sources and citations: reading one from a GEDCOM structure, and writing one
 * back with as little change to the original lines as possible.
 *
 * A source is a record of its own (`0 @S1@ SOUR`): a census, a parish
 * register, a book. A citation is a line under a person, a name, an event or
 * a family that points at a source (`2 SOUR @S1@`) and says where in it the
 * fact was found.
 */

/** A source as the app stores it. */
export interface SourceFields {
  title: string;
  author: string;
  /** Who published it, where and when. May have several lines. */
  publication: string;
  /** A short title, which some programs use to file the source under. */
  abbreviation: string;
  /** Words copied from the source itself. May have several lines. */
  text: string;
}

/** A citation as the app stores it. */
export interface CitationFields {
  /** Where in the source: a page, a sheet, an entry number. */
  page: string;
  /** What the source says there, copied out. May have several lines. */
  text: string;
  /** How far the source can be trusted for this fact: 0 (unreliable) to 3 (direct and primary). */
  quality: number | null;
  /** The user's own remark. May have several lines. */
  note: string;
}

/** The longest text the app's forms accept. */
export const SOURCE_LIMITS = {
  title: 1000,
  author: 500,
  publication: 5000,
  abbreviation: 200,
  text: 50_000,
} as const;

export const CITATION_LIMITS = {
  page: 2000,
  text: 50_000,
  note: 20_000,
} as const;

/** The values a citation's quality may have, from least to most trusted. */
export const CITATION_QUALITIES = [0, 1, 2, 3] as const;

/** The usual order of the first lines of a source record the app writes. */
const SOURCE_ORDER = ['TITL', 'AUTH', 'ABBR', 'PUBL', 'TEXT'] as const;
/** The usual order of the lines under a citation. */
const CITATION_ORDER = ['PAGE', 'EVEN', 'DATA', 'QUAY'] as const;
const DATA_ORDER = ['DATE', 'TEXT'] as const;

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function block(text: string, max: number): string {
  return text.replace(/\r\n?/g, '\n').trim().slice(0, max).trim();
}

/** A source's fields in the form the app stores them: trimmed, and cut to the lengths the forms accept. */
export function cleanSourceFields(fields: SourceFields): SourceFields {
  return {
    title: oneLine(fields.title, SOURCE_LIMITS.title),
    author: oneLine(fields.author, SOURCE_LIMITS.author),
    publication: block(fields.publication, SOURCE_LIMITS.publication),
    abbreviation: oneLine(fields.abbreviation, SOURCE_LIMITS.abbreviation),
    text: block(fields.text, SOURCE_LIMITS.text),
  };
}

/** The same for a citation. A quality outside 0 to 3 counts as not stated. */
export function cleanCitationFields(fields: CitationFields): CitationFields {
  const quality = fields.quality;
  return {
    page: oneLine(fields.page, CITATION_LIMITS.page),
    text: block(fields.text, CITATION_LIMITS.text),
    quality:
      quality !== null && (CITATION_QUALITIES as readonly number[]).includes(quality)
        ? quality
        : null,
    note: block(fields.note, CITATION_LIMITS.note),
  };
}

/** Reads a source record. */
export function readSource(node: GedcomNode): SourceFields {
  return cleanSourceFields({
    title: childValue(node, 'TITL'),
    author: childValue(node, 'AUTH'),
    publication: childValue(node, 'PUBL'),
    abbreviation: childValue(node, 'ABBR'),
    text: childValue(node, 'TEXT'),
  });
}

/**
 * Sets the value of the first child with `tag`, adding one (in `order`) when
 * there is none. An empty value removes that first child. Further children
 * with the same tag are left alone: a citation may quote a source twice.
 */
function setFirst(parent: GedcomNode, tag: string, value: string, order: readonly string[]): void {
  const first = findChild(parent, tag);
  if (value === '') {
    if (first) parent.children = parent.children.filter((child) => child !== first);
    return;
  }
  if (!first) {
    insertInOrder(parent, makeNode(tag, value), order);
    return;
  }
  if (first.value !== value) {
    first.value = value;
    touch(first);
  }
}

/**
 * The record for a source. With no `original` it is written afresh, under the
 * cross-reference id `xref`. With the record the source was imported from,
 * only the lines whose field has changed since are rewritten; the rest, and
 * everything the app does not model (the repository, notes, other programs'
 * own tags), stay as they were.
 */
export function patchSource(
  original: GedcomNode | null,
  fields: SourceFields,
  xref: string,
): GedcomNode {
  const node = original ? cloneNode(original) : makeNode('SOUR');
  if (!original) node.xref = xref;
  const was = original ? readSource(original) : null;
  const set = (field: keyof SourceFields, tag: string) => {
    if (was === null || was[field] !== fields[field]) {
      setFirst(node, tag, fields[field], SOURCE_ORDER);
    }
  };
  set('title', 'TITL');
  set('author', 'AUTH');
  set('abbreviation', 'ABBR');
  set('publication', 'PUBL');
  set('text', 'TEXT');
  return node;
}

/**
 * The cross-reference id of the source record a line cites (`2 SOUR @S1@`
 * gives `S1`), or null when the line is not a citation of a source record: a
 * source described in place, as GEDCOM 5.5.1 allows, has no record to cite.
 */
export function citedSource(node: GedcomNode): string | null {
  return node.tag === 'SOUR' ? pointerTarget(node.value) : null;
}

/** The first note written under a citation itself, as opposed to a pointer to a note record. */
function ownNote(node: GedcomNode): GedcomNode | undefined {
  return node.children.find(
    (child) =>
      child.tag === 'NOTE' && pointerTarget(child.value) === null && child.value.trim() !== '',
  );
}

/** Reads a citation: a SOUR line that points at a source record, with what is under it. */
export function readCitation(node: GedcomNode): CitationFields {
  const data = findChild(node, 'DATA');
  const quality = childValue(node, 'QUAY').trim();
  return cleanCitationFields({
    page: childValue(node, 'PAGE'),
    text: data ? childValue(data, 'TEXT') : '',
    quality: /^[0-3]$/.test(quality) ? Number(quality) : null,
    note: ownNote(node)?.value ?? '',
  });
}

/**
 * The structure for a citation of the source record `sourceXref`. With no
 * `original` it is written afresh. With the structure the citation was
 * imported from, only the lines whose field has changed since are rewritten;
 * the rest, and everything the app does not model (media, other programs' own
 * tags such as Ancestry's `_APID`), stay as they were.
 */
export function patchCitation(
  original: GedcomNode | null,
  fields: CitationFields,
  sourceXref: string,
): GedcomNode {
  const node = original ? cloneNode(original) : makeNode('SOUR', pointerTo(sourceXref));
  const was = original ? readCitation(original) : null;
  const differs = (field: keyof CitationFields) => was === null || was[field] !== fields[field];

  if (pointerTarget(node.value) !== sourceXref) {
    node.value = pointerTo(sourceXref);
    touch(node);
  }

  if (differs('page')) setFirst(node, 'PAGE', fields.page, CITATION_ORDER);

  if (differs('text')) {
    let data = findChild(node, 'DATA');
    if (fields.text !== '') {
      if (!data) {
        data = makeNode('DATA');
        insertInOrder(node, data, CITATION_ORDER);
      }
      setFirst(data, 'TEXT', fields.text, DATA_ORDER);
    } else if (data) {
      setFirst(data, 'TEXT', '', DATA_ORDER);
      // A DATA line with nothing left under it says nothing.
      if (data.children.length === 0 && data.value === '') {
        node.children = node.children.filter((child) => child !== data);
      }
    }
  }

  if (differs('quality')) {
    setFirst(node, 'QUAY', fields.quality === null ? '' : String(fields.quality), CITATION_ORDER);
  }

  if (differs('note')) {
    const existing = ownNote(node);
    if (fields.note === '') {
      if (existing) node.children = node.children.filter((child) => child !== existing);
    } else if (!existing) {
      node.children.push(makeNode('NOTE', fields.note));
    } else if (existing.value !== fields.note) {
      existing.value = fields.note;
      touch(existing);
    }
  }
  return node;
}

/**
 * Text that is the same for two citations exactly when they say the same
 * thing in the same words: every line under them, in order. The line itself
 * is left out, so that a citation under a person (level 1) and the same one
 * under an event (level 2) compare as equal. The caller adds the source.
 */
export function citationKey(node: GedcomNode): string {
  const shape = (line: GedcomNode): unknown => [line.tag, line.value, line.children.map(shape)];
  return JSON.stringify(node.children.map(shape));
}
