import {
  childValue,
  cloneNode,
  findChild,
  insertInOrder,
  makeNode,
  pointerTarget,
  pointerTo,
  structureKey,
  touch,
  type GedcomNode,
  type GedcomVersion,
} from './node';
import { NOTE_MAX, cleanNote, ownNote, readOwnNote, setOwnNote } from './notes';

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
  /** The user's own remark on the source. May have several lines. */
  note: string;
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
  /** The web address of the page or record this is about; empty when there is none. */
  url: string;
  /** The day the page was consulted, as `YYYY-MM-DD`; empty when not stated. */
  accessedAt: string;
}

/** The longest text the app's forms accept. */
export const SOURCE_LIMITS = {
  title: 1000,
  author: 500,
  publication: 5000,
  abbreviation: 200,
  text: 50_000,
  note: NOTE_MAX,
} as const;

export const CITATION_LIMITS = {
  page: 2000,
  text: 50_000,
  note: 20_000,
  url: 2048,
} as const;

/**
 * The line under a citation that holds the day its page was consulted, as a
 * GEDCOM date (`3 _RULZ_ACCESSED 13 NOV 2026`). GEDCOM has no line for this:
 * the DATE under DATA says when the entry was written in the source. The tag
 * is the app's own; other programs keep it or drop it.
 */
export const ACCESSED_TAG = '_RULZ_ACCESSED';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A day as `YYYY-MM-DD` when the text is one that exists; otherwise empty. */
export function cleanDay(text: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // A year below 100 would be read as 19xx.
  date.setUTCFullYear(year);
  const exists =
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return exists ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** `2026-11-13` as a GEDCOM date, `13 NOV 2026`; empty for anything else. */
function dayToGedcom(day: string): string {
  const clean = cleanDay(day);
  if (clean === '') return '';
  const [year, month, date] = clean.split('-').map(Number) as [number, number, number];
  return `${date} ${MONTHS[month - 1]} ${year}`;
}

/** `13 NOV 2026` as `2026-11-13`; empty for anything that is not one whole day. */
function gedcomToDay(text: string): string {
  const match = /^(\d{1,2}) ([A-Z]{3}) (\d{1,4})$/.exec(text.trim().toUpperCase());
  if (!match) return '';
  const month = MONTHS.indexOf(match[2] ?? '');
  if (month === -1) return '';
  return cleanDay(
    `${(match[3] ?? '').padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${(match[1] ?? '').padStart(2, '0')}`,
  );
}

/**
 * Why a text is not a web address the app keeps for a citation, in words for
 * the user; null when it is one, or empty. Only what the user types or the
 * app makes is held to this: an address of an imported file is kept as it is.
 */
export function webAddressProblem(text: string): string | null {
  const typed = text.trim();
  if (typed === '') return null;
  if (typed.length > CITATION_LIMITS.url) return 'This web address is too long.';
  if (/[\s\p{Cc}]/u.test(typed)) return 'A web address has no spaces in it.';
  // Marks that are not seen, and can make an address read as another one.
  if (/\p{Cf}/u.test(typed)) return 'This web address has characters in it that cannot be seen.';
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return 'This is not a web address. It starts with https:// or http://.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'A web address starts with https:// or http://.';
  }
  if (url.username !== '' || url.password !== '') {
    return 'This web address has a user name or a password in it. Leave them out.';
  }
  if (url.hostname === '') return 'This is not a web address.';
  return null;
}

/** The values a citation's quality may have, from least to most trusted. */
export const CITATION_QUALITIES = [0, 1, 2, 3] as const;

/** The usual order of the first lines of a source record the app writes. */
const SOURCE_ORDER = ['TITL', 'AUTH', 'ABBR', 'PUBL', 'TEXT'] as const;
/** The usual order of the lines under a citation. */
const CITATION_ORDER = ['PAGE', 'EVEN', 'DATA', 'QUAY', '_RULZ_ACCESSED'] as const;
const DATA_ORDER = ['DATE', 'TEXT', 'WWW', '_WWW'] as const;

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
    note: cleanNote(fields.note),
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
    url: oneLine(fields.url, CITATION_LIMITS.url),
    accessedAt: cleanDay(fields.accessedAt),
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
    note: readOwnNote(node),
  });
}

/**
 * Sets the value of the first child with `tag`, adding one (in `order`) when
 * there is none. An empty value removes that first child. Further children
 * with the same tag are left alone: a citation may quote a source twice.
 */
export function setFirst(
  parent: GedcomNode,
  tag: string,
  value: string,
  order: readonly string[],
): void {
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
 * everything the app does not model (the repository, further notes, other
 * programs' own tags), stay as they were.
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
  if (was === null || was.note !== fields.note) setOwnNote(node, fields.note);
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

/** Reads a citation: a SOUR line that points at a source record, with what is under it. */
export function readCitation(node: GedcomNode): CitationFields {
  const data = findChild(node, 'DATA');
  const quality = childValue(node, 'QUAY').trim();
  return cleanCitationFields({
    page: childValue(node, 'PAGE'),
    text: data ? childValue(data, 'TEXT') : '',
    quality: /^[0-3]$/.test(quality) ? Number(quality) : null,
    note: ownNote(node)?.value ?? '',
    // Ancestry writes the address of a record as a WWW line under DATA.
    url: data ? childValue(data, addressTag(data) ?? 'WWW') : '',
    accessedAt: gedcomToDay(childValue(node, ACCESSED_TAG)),
  });
}

/**
 * Sets the first line with `tag` under a citation's DATA line, making the
 * DATA line when it is needed and removing it when nothing is left under it.
 */
/**
 * The tag of the line under DATA that holds the web address. GEDCOM 7.0 has
 * no WWW line at this place, so the app writes `_WWW` there; a file that has
 * WWW all the same (Ancestry's) is read too.
 */
function addressTag(data: GedcomNode): string | null {
  return data.children.find((child) => child.tag === 'WWW' || child.tag === '_WWW')?.tag ?? null;
}

function setInData(node: GedcomNode, tag: string, value: string): void {
  let data = findChild(node, 'DATA');
  if (value !== '') {
    if (!data) {
      data = makeNode('DATA');
      insertInOrder(node, data, CITATION_ORDER);
    }
    setFirst(data, tag, value, DATA_ORDER);
  } else if (data) {
    setFirst(data, tag, '', DATA_ORDER);
    // A DATA line with nothing left under it says nothing.
    if (data.children.length === 0 && data.value === '') {
      node.children = node.children.filter((child) => child !== data);
    }
  }
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
  version: GedcomVersion = '5.5.1',
): GedcomNode {
  const node = original ? cloneNode(original) : makeNode('SOUR', pointerTo(sourceXref));
  const was = original ? readCitation(original) : null;
  const differs = (field: keyof CitationFields) => was === null || was[field] !== fields[field];

  if (pointerTarget(node.value) !== sourceXref) {
    node.value = pointerTo(sourceXref);
    touch(node);
  }

  if (differs('page')) setFirst(node, 'PAGE', fields.page, CITATION_ORDER);

  if (differs('text')) setInData(node, 'TEXT', fields.text);
  if (differs('url')) {
    const data = findChild(node, 'DATA');
    const tag = (data ? addressTag(data) : null) ?? (version === '7.0' ? '_WWW' : 'WWW');
    if (fields.url === '' && data) {
      // An emptied address takes every address line with it. A second one
      // left behind would be read as the address the next time.
      data.children = data.children.filter((child) => child.tag !== 'WWW' && child.tag !== '_WWW');
    }
    setInData(node, tag, fields.url);
  }

  if (differs('quality')) {
    setFirst(node, 'QUAY', fields.quality === null ? '' : String(fields.quality), CITATION_ORDER);
  }

  if (differs('note')) setOwnNote(node, fields.note);
  if (differs('accessedAt')) {
    setFirst(node, ACCESSED_TAG, dayToGedcom(fields.accessedAt), CITATION_ORDER);
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
  return structureKey(node);
}
