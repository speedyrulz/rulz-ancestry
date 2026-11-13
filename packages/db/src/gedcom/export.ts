import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  cloneNode,
  convertVersion,
  embeddedMediaKey,
  embeddedToRecord,
  encodeGedcom,
  isEmbeddedMedia,
  localRelativePath,
  makeNode,
  parseFragment,
  patchChildLine,
  patchChildOf,
  patchCitation,
  patchEvent,
  patchLiving,
  cleanNote,
  patchNoteLine,
  patchMediaRecord,
  patchName,
  patchSex,
  patchSource,
  pointerTarget,
  pointerTo,
  readPedigree,
  safeArchiveName,
  touch,
  touchAll,
  writeGedcom,
  type CitationFields,
  type EventFields,
  type EventOwner,
  type GedcomNode,
  type GedcomVersion,
  type MediaFields,
  type MediaFileReference,
  type NameFields,
  type Sex,
  type SourceFields,
} from '@rulz/core';
import { sql } from '../connection';
import { presumedLivingIds } from '../living';
import { mediaFilePath } from '../media';
import type { Tree } from '../tree';
import { writeZip } from '../zip';
import {
  getGedcomSource,
  listEmbeddedMedia,
  listMergedRecords,
  listStoredRecords,
  type PartKind,
  type StoredRecord,
} from './store';

/**
 * Writes a tree as a GEDCOM file.
 *
 * For a tree that was imported, each record is rebuilt from two things: what
 * the tree holds now, and the lines the record was imported from. A name or
 * event that has not changed since the import is written from its original
 * lines; one that has changed gets only the changed lines rewritten; and the
 * lines the app has no model for are put back where they were. So exporting an
 * untouched import in the version it came in gives the same file again, apart
 * from the header, which names this app as the writer.
 *
 * A GEDCOM file names pictures and documents; it does not hold them. With
 * `files`, the export also lists the files the tree holds and the path each is
 * to have in a zip archive beside the GEDCOM file, which is what a GEDZip
 * file is.
 */

export interface GedcomExportOptions {
  version: GedcomVersion;
  /** False leaves out everyone who may be living (see `presumedLivingIds`). */
  includeLiving: boolean;
  /** The app's version number, for the header. */
  appVersion: string;
  /** The moment of the export in Unix milliseconds; defaults to now. */
  now?: number;
  /** The name of the file being written, for the header of a 5.5.1 file. */
  fileName?: string;
  /**
   * True when the files go along in a zip archive. A picture the tree holds
   * is then named by its path in the archive. Without it, a file that came
   * from an imported GEDCOM file keeps the path or address that file gave.
   */
  files?: boolean;
}

/** A file to pack beside the GEDCOM file. */
export interface ExportedFile {
  /** The path the GEDCOM file gives for it, which is its path in the archive. */
  path: string;
  /** Where the file is on disk, in the tree's media folder. */
  source: string;
}

export interface GedcomExportResult {
  /** The file's text. It is written to disk as UTF-8 with a byte-order mark. */
  text: string;
  version: GedcomVersion;
  persons: number;
  families: number;
  /** People left out because they may be living. */
  livingOmitted: number;
  /**
   * Kinds of structure that could not be rewritten for the chosen version and
   * were written as they are, with how many of each. Empty when the file is
   * written in the version it was imported in.
   */
  unconverted: Record<string, number>;
  /** Pictures and documents the file names. */
  media: number;
  /**
   * Of those, the ones that do not go along as files. Without `files` that is
   * every one the tree knows of and does not hold; with it, also one whose
   * file has gone from the media folder.
   */
  mediaNotHeld: number;
  /**
   * Pictures and documents left out because everything they are attached to
   * was left out: the files of people who may be living.
   */
  mediaWithheld: number;
  /** With `files`: the files to pack beside the GEDCOM file. Empty otherwise. */
  files: ExportedFile[];
}

interface PersonRow {
  id: string;
  sex: Sex;
  living: 0 | 1 | null;
  note: string;
}

interface NameRow extends NameFields {
  id: string;
  person_id: string;
}

interface EventRow {
  id: string;
  owner_id: string;
  type: string;
  date_text: string;
  place_text: string;
  description: string;
  note: string;
}

interface FamilyRow {
  id: string;
  partner1_id: string | null;
  partner2_id: string | null;
}

interface ChildRow {
  family_id: string;
  child_id: string;
  pedigree: string;
}

interface SourceRow extends SourceFields {
  id: string;
}

interface CitationRow extends CitationFields {
  id: string;
  source_id: string;
}

interface MediaRow extends MediaFields {
  id: string;
  sha256: string | null;
  ext: string;
  mime: string;
  file_name: string;
  origin: string;
}

interface MediaLinkRow {
  media_id: string;
  person_id: string | null;
  family_id: string | null;
  event_id: string | null;
  citation_id: string | null;
  source_id: string | null;
}

interface CitationLinkRow {
  citation_id: string;
  person_id: string | null;
  family_id: string | null;
  event_id: string | null;
  name_id: string | null;
}

/** The citation each SOUR line under a name or event became; see `StoredPart.c`. */
type Cites = readonly (string | null)[] | undefined;

/** A line under a record that is being put together, with where it goes. */
interface Item {
  /** Sort key: the original line it stands at or after, then the order among lines added there. */
  key: readonly [number, number, number, number];
  node: GedcomNode;
}

/** The lines of an imported record, read back into nodes. */
interface ParsedRecord {
  stored: StoredRecord;
  /** One per stored part; null for a part whose text could not be read back. */
  nodes: (GedcomNode | null)[];
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

function compareItems(a: Item, b: Item): number {
  for (let index = 0; index < 4; index += 1) {
    const difference = (a.key[index] ?? 0) - (b.key[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

/** The header lines that say when the file was written, in universal time. */
function dateNode(now: number, version: GedcomVersion): GedcomNode {
  const date = new Date(now);
  const two = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return makeNode('DATE', day, [makeNode('TIME', version === '7.0' ? `${time}Z` : time)]);
}

/** Header lines the app writes itself; the originals of these are not carried over. */
const OWN_HEADER_TAGS = new Set(['SOUR', 'DEST', 'DATE', 'GEDC', 'CHAR', 'FILE', 'SUBM']);

/** Hands out cross-reference ids that no record has yet: I1, I2, ... or F1, F2, ... */
class XrefMaker {
  readonly #used: Set<string>;
  readonly #next = new Map<string, number>();

  constructor(used: Iterable<string>) {
    this.#used = new Set(used);
  }

  make(prefix: string): string {
    let number = this.#next.get(prefix) ?? 1;
    while (this.#used.has(`${prefix}${number}`)) number += 1;
    this.#next.set(prefix, number + 1);
    const xref = `${prefix}${number}`;
    this.#used.add(xref);
    return xref;
  }
}

/** Order of the kinds of line in a person record, for lines that have no original place. */
const PERSON_SECTIONS: readonly PartKind[] = [
  'name',
  'sex',
  'living',
  'note',
  'event',
  'child-of',
  'partner-in',
  'citation',
  'media',
];
/** The same for a family record. */
const FAMILY_SECTIONS: readonly PartKind[] = ['partner', 'event', 'child', 'citation', 'media'];

/**
 * Works out where lines go that have no original line of their own (a name
 * added since the import, say): after the last original line of their kind,
 * or, when the record had none of that kind, after the last original line of
 * the kinds that come before it.
 */
class Layout {
  readonly #last = new Map<PartKind, number>();
  readonly #sections: readonly PartKind[];
  readonly #added = new Map<PartKind, number>();
  readonly items: Item[] = [];

  constructor(sections: readonly PartKind[], parsed: ParsedRecord | null) {
    this.#sections = sections;
    parsed?.stored.parts?.forEach((part, index) => {
      if (part.k !== undefined) this.#last.set(part.k, index);
    });
  }

  /** Puts a line where its original stood. */
  at(index: number, node: GedcomNode): void {
    this.items.push({ key: [index, 0, 0, 0], node });
  }

  /** Puts a line that has no original place. */
  add(kind: PartKind, node: GedcomNode): void {
    const section = this.#sections.indexOf(kind);
    let anchor = this.#last.get(kind);
    if (anchor === undefined) {
      anchor = -1;
      for (const earlier of this.#sections.slice(0, section)) {
        anchor = Math.max(anchor, this.#last.get(earlier) ?? -1);
      }
    }
    const order = this.#added.get(kind) ?? 0;
    this.#added.set(kind, order + 1);
    this.items.push({ key: [anchor, 1, section, order], node });
  }

  /** Puts a line after everything else: a line carried over from a record merged into this one. */
  end(node: GedcomNode): void {
    this.items.push({ key: [Number.MAX_SAFE_INTEGER, 0, 0, this.items.length], node });
  }

  nodes(): GedcomNode[] {
    return this.items.sort(compareItems).map((item) => item.node);
  }
}

/** Writes a tree as GEDCOM text. The tree is only read. */
export function exportGedcom(tree: Tree, options: GedcomExportOptions): GedcomExportResult {
  const db = tree.db;
  const target = options.version;
  const now = options.now ?? Date.now();
  const source = getGedcomSource(tree);
  const sourceVersion = source?.version ?? target;
  const sameVersion = sourceVersion === target;

  // What the tree holds now.
  const persons = sql(
    db,
    'SELECT id, sex, living, note FROM person ORDER BY id',
  ).all() as PersonRow[];
  const families = sql(
    db,
    'SELECT id, partner1_id, partner2_id FROM family ORDER BY id',
  ).all() as FamilyRow[];
  const namesOf = groupBy(
    sql(
      db,
      `SELECT id, person_id, type, prefix, given, nickname, surname, suffix FROM person_name
       ORDER BY person_id, is_primary DESC, sort_order, id`,
    ).all() as NameRow[],
    (row) => row.person_id,
  );
  const eventsOf = (owner: 'person_id' | 'family_id') =>
    groupBy(
      sql(
        db,
        `SELECT e.id, ep.${owner} AS owner_id, e.type, e.date_text, e.place_text, e.description,
           e.note
         FROM event_participant ep JOIN event e ON e.id = ep.event_id
         WHERE ep.${owner} IS NOT NULL
         ORDER BY ep.${owner}, ep.sort_order, e.id`,
      ).all() as EventRow[],
      (row) => row.owner_id,
    );
  const personEvents = eventsOf('person_id');
  const familyEvents = eventsOf('family_id');
  const childRows = sql(
    db,
    'SELECT family_id, child_id, pedigree FROM family_child ORDER BY family_id, sort_order, id',
  ).all() as ChildRow[];
  const childrenOf = groupBy(childRows, (row) => row.family_id);
  const parentFamiliesOf = groupBy(
    [...childRows].sort((a, b) =>
      a.family_id < b.family_id ? -1 : a.family_id > b.family_id ? 1 : 0,
    ),
    (row) => row.child_id,
  );
  const partnerFamiliesOf = new Map<string, string[]>();
  for (const family of families) {
    for (const partner of [family.partner1_id, family.partner2_id]) {
      if (partner === null) continue;
      const list = partnerFamiliesOf.get(partner);
      if (list) list.push(family.id);
      else partnerFamiliesOf.set(partner, [family.id]);
    }
  }
  const sources = sql(
    db,
    'SELECT id, title, author, publication, abbreviation, text, note FROM source ORDER BY id',
  ).all() as SourceRow[];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const citationById = new Map(
    (
      sql(
        db,
        'SELECT id, source_id, page, text, quality, note, url, accessed_at AS accessedAt FROM citation',
      ).all() as CitationRow[]
    ).map((citation) => [citation.id, citation]),
  );
  /** The citations of each person, family, event and name, in the order of that owner's list. */
  const citedBy = new Map<string, string[]>();
  for (const link of sql(
    db,
    `SELECT citation_id, person_id, family_id, event_id, name_id FROM citation_link
     ORDER BY sort_order, id`,
  ).all() as CitationLinkRow[]) {
    const owner = link.person_id ?? link.family_id ?? link.event_id ?? link.name_id;
    if (owner === null) continue;
    const list = citedBy.get(owner);
    if (list) list.push(link.citation_id);
    else citedBy.set(owner, [link.citation_id]);
  }
  const mediaRows = sql(
    db,
    'SELECT id, sha256, ext, mime, file_name, title, description, origin FROM media ORDER BY id',
  ).all() as MediaRow[];
  const mediaById = new Map(mediaRows.map((media) => [media.id, media]));
  /** The files of each person, family, event, citation and source, in the order of that owner's list. */
  const mediaOf = new Map<string, string[]>();
  /** How many things each file is attached to. */
  const attachedTo = new Map<string, number>();
  for (const link of sql(
    db,
    `SELECT media_id, person_id, family_id, event_id, citation_id, source_id FROM media_link
     ORDER BY sort_order, id`,
  ).all() as MediaLinkRow[]) {
    const owner =
      link.person_id ?? link.family_id ?? link.event_id ?? link.citation_id ?? link.source_id;
    if (owner === null) continue;
    const list = mediaOf.get(owner);
    if (list) list.push(link.media_id);
    else mediaOf.set(owner, [link.media_id]);
    attachedTo.set(link.media_id, (attachedTo.get(link.media_id) ?? 0) + 1);
  }

  // Who is left out.
  const omitted = options.includeLiving ? new Set<string>() : presumedLivingIds(tree, now);
  const shown = (personId: string | null): personId is string =>
    personId !== null && !omitted.has(personId);
  const exportedFamilies = families.filter(
    (family) =>
      shown(family.partner1_id) ||
      shown(family.partner2_id) ||
      (childrenOf.get(family.id) ?? []).some((child) => shown(child.child_id)),
  );
  const familyShown = new Set(exportedFamilies.map((family) => family.id));

  // The lines everything was imported from.
  const stored = listStoredRecords(tree);
  const parsedById = new Map<string, ParsedRecord>();
  for (const record of stored) {
    if (record.parts === null) continue;
    parsedById.set(record.id, {
      stored: record,
      nodes: record.parts.map((part) => parseFragment(part.t, sourceVersion)[0] ?? null),
    });
  }
  // Records that were merged into another person or family since the import.
  // Their lines are written with the one that is left.
  const mergedRecords = listMergedRecords(tree);
  const absorbedBy = new Map<string, ParsedRecord[]>();
  for (const merged of mergedRecords) {
    const parsed = parsedById.get(merged.id);
    if (!parsed) continue;
    const list = absorbedBy.get(merged.intoId);
    if (list) list.push(parsed);
    else absorbedBy.set(merged.intoId, [parsed]);
  }

  /** The original line of one kind, by "record id/linked id". */
  const originalLine = (kind: PartKind) => {
    const lines = new Map<string, GedcomNode>();
    for (const parsed of parsedById.values()) {
      parsed.stored.parts?.forEach((part, index) => {
        const node = parsed.nodes[index];
        if (part.k === kind && part.r !== undefined && node) {
          lines.set(`${parsed.stored.id}/${part.r}`, node);
        }
      });
    }
    return lines;
  };
  /** The person's FAMC line, by "person id/family id". */
  const childOfLines = originalLine('child-of');
  /** The family's CHIL line, by "family id/person id". */
  const childLines = originalLine('child');
  const pedigreeWas = (familyId: string, childId: string): string | null => {
    const famc = childOfLines.get(`${childId}/${familyId}`) ?? null;
    const chil = childLines.get(`${familyId}/${childId}`) ?? null;
    return famc || chil ? readPedigree(famc, chil) : null;
  };

  // Cross-reference ids: the file's own, and new ones for what was added since.
  const xrefs = new XrefMaker(
    stored.map((record) => record.xref).filter((xref): xref is string => xref !== null),
  );
  const xrefOf = new Map<string, string>();
  /** The file of each media record, by the record's cross-reference id. */
  const mediaIdByXref = new Map<string, string>();
  for (const record of stored) {
    const own =
      record.kind === 'person' ||
      record.kind === 'family' ||
      record.kind === 'source' ||
      record.kind === 'media';
    if (own && record.xref !== null) xrefOf.set(record.id, record.xref);
    if (record.kind === 'media' && record.xref !== null) mediaIdByXref.set(record.xref, record.id);
  }
  for (const person of persons) {
    if (!xrefOf.has(person.id)) xrefOf.set(person.id, xrefs.make('I'));
  }
  for (const family of families) {
    if (!xrefOf.has(family.id)) xrefOf.set(family.id, xrefs.make('F'));
  }
  for (const source of sources) {
    if (!xrefOf.has(source.id)) xrefOf.set(source.id, xrefs.make('S'));
  }
  const xref = (id: string): string => xrefOf.get(id) ?? 'VOID';
  /** The cross-reference id of a file's record; a file that has no record yet gets one when first asked for. */
  const mediaXref = (id: string): string => {
    let made = xrefOf.get(id);
    if (made === undefined) {
      made = xrefs.make('M');
      xrefOf.set(id, made);
    }
    return made;
  };

  // Pictures and documents.
  const withFiles = options.files === true;
  /** The file each media item written in place became, by its wording. */
  const embeddedIds = listEmbeddedMedia(tree);
  const writtenInPlace = new Set(embeddedIds.values());
  /**
   * GEDCOM 7.0 has media records only. A media item written in place stays
   * where it is unless the file is being turned into 7.0 from another version.
   */
  const keepInPlace = sameVersion || target === '5.5.1';
  /** The first structure each media item written in place was read from. */
  const inPlaceModel = new Map<string, GedcomNode>();
  if (embeddedIds.size > 0) {
    const look = (node: GedcomNode): void => {
      if (isEmbeddedMedia(node)) {
        const id = embeddedIds.get(embeddedMediaKey(node));
        if (id !== undefined && !inPlaceModel.has(id)) inPlaceModel.set(id, node);
        return;
      }
      node.children.forEach(look);
    };
    for (const record of stored) {
      if (record.kind === 'source') parseFragment(record.text, sourceVersion).forEach(look);
      else parsedById.get(record.id)?.nodes.forEach((node) => node && look(node));
    }
  }
  /** The file an OBJE line stands for, or null for a line that is kept as written. */
  const mediaIdOf = (node: GedcomNode): string | null => {
    if (node.tag !== 'OBJE') return null;
    const pointer = pointerTarget(node.value);
    if (pointer !== null) return mediaIdByXref.get(pointer) ?? null;
    if (embeddedIds.size === 0 || !isEmbeddedMedia(node)) return null;
    return embeddedIds.get(embeddedMediaKey(node)) ?? null;
  };

  /** The path of each file in the archive, and the paths taken. */
  const archivePaths = new Map<string, string>();
  const takenPaths = new Set<string>(['gedcom.ged']);
  const archivePathOf = (media: MediaRow): string => {
    const known = archivePaths.get(media.id);
    if (known !== undefined) return known;
    // A path the imported file gave is kept when every program can read it,
    // so that a file exported again names its files as before.
    const given = media.origin === '' ? null : localRelativePath(media.origin);
    const name = safeArchiveName(
      media.file_name === '' ? media.title : media.file_name,
      media.ext,
      (media.sha256 ?? media.id).slice(0, 12),
    );
    const wanted = given !== null && /^[A-Za-z0-9._/-]+$/.test(given) ? given : `media/${name}`;
    const dot = wanted.lastIndexOf('.');
    const cut = dot > wanted.lastIndexOf('/') ? dot : wanted.length;
    let path = wanted;
    for (let number = 2; takenPaths.has(path.toLowerCase()); number += 1) {
      path = `${wanted.slice(0, cut)}-${number}${wanted.slice(cut)}`;
    }
    takenPaths.add(path.toLowerCase());
    archivePaths.set(media.id, path);
    return path;
  };
  const filesToPack: ExportedFile[] = [];
  const packed = new Set<string>();
  /**
   * What the FILE line of a picture or document is to say. A file that goes
   * along in the archive is named by its path there. A file added in the app
   * is named the same way even when no archive is written: it has no other
   * name. A file that came from an imported GEDCOM file and does not go along
   * keeps its FILE line as that file wrote it, so nothing is said here. That
   * holds for an empty line too: Ancestry writes `1 FILE` with no value.
   */
  const fromFile = new Set<string>(writtenInPlace);
  for (const record of stored) if (record.kind === 'media') fromFile.add(record.id);
  const fileOf = (media: MediaRow): { file?: MediaFileReference } => {
    const stored = withFiles ? mediaFilePath(tree, media) : null;
    const carried = stored !== null && existsSync(stored);
    if (!carried && fromFile.has(media.id)) return {};
    const path = archivePathOf(media);
    if (carried && !packed.has(media.id)) {
      packed.add(media.id);
      filesToPack.push({ path, source: stored });
    }
    return { file: { reference: path, ext: media.ext, mime: media.mime } };
  };
  /** How many lines were written for each file. */
  const linesFor = new Map<string, number>();

  /**
   * The OBJE line that attaches a file to something: the line it was
   * imported with, a copy of the description a file written in place had, or
   * a pointer to the file's record. Null when the file has gone.
   */
  const mediaLine = (mediaId: string, original: GedcomNode | null): GedcomNode | null => {
    const media = mediaById.get(mediaId);
    if (!media) return null;
    linesFor.set(mediaId, (linesFor.get(mediaId) ?? 0) + 1);
    if (keepInPlace && writtenInPlace.has(mediaId)) {
      let base = original !== null && isEmbeddedMedia(original) ? original : null;
      if (base === null) {
        const model = inPlaceModel.get(mediaId);
        if (model) {
          // Written at another place, and perhaps another level, than it was read from.
          base = cloneNode(model);
          touchAll(base);
        }
      }
      if (base !== null)
        return patchMediaRecord(base, media, { version: target, ...fileOf(media) });
    }
    if (original !== null && pointerTarget(original.value) !== null) return original;
    return makeNode('OBJE', pointerTo(mediaXref(mediaId)));
  };

  /**
   * Brings the OBJE lines under an event, a citation or a source record in
   * step with the tree: a line whose file is no longer attached there goes,
   * a file written in place whose title was edited is rewritten, and files
   * attached since follow the last of them. Lines that never became a file
   * stay as they are.
   */
  const syncMedia = (node: GedcomNode, ownerId: string): void => {
    const wanted = mediaOf.get(ownerId) ?? [];
    if (wanted.length === 0 && !node.children.some((child) => child.tag === 'OBJE')) return;
    const alive = new Set(wanted);
    const done = new Set<string>();
    const children: GedcomNode[] = [];
    let last = -1;
    for (const child of node.children) {
      const id = mediaIdOf(child);
      if (id === null) {
        children.push(child);
        if (child.tag === 'OBJE') last = children.length - 1;
        continue;
      }
      if (!alive.has(id)) continue;
      const line = mediaLine(id, child);
      if (!line) continue;
      done.add(id);
      children.push(line);
      last = children.length - 1;
    }
    const added = wanted
      .filter((id) => !done.has(id))
      .map((id) => mediaLine(id, null))
      .filter((line) => line !== null);
    if (last === -1) children.push(...added);
    else children.splice(last + 1, 0, ...added);
    node.children = children;
  };

  /**
   * The lines each imported citation was first written with. A citation that
   * has since been used for another fact is written there with the same lines,
   * so what the app has no fields for (Ancestry's record number, say) goes
   * along with it.
   */
  const firstWritten = new Map<string, GedcomNode>();
  for (const parsed of parsedById.values()) {
    parsed.stored.parts?.forEach((part, index) => {
      const node = parsed.nodes[index];
      if (!node) return;
      if (part.k === 'citation' && part.r !== undefined) {
        if (!firstWritten.has(part.r)) firstWritten.set(part.r, node);
      } else if (part.c !== undefined) {
        const lines = node.children.filter((child) => child.tag === 'SOUR');
        part.c.forEach((id, place) => {
          const line = lines[place];
          if (id !== null && line && !firstWritten.has(id)) firstWritten.set(id, line);
        });
      }
    });
  }

  /** The SOUR structure for a citation: its original line patched, or a new one. Null when it has gone. */
  const citationNode = (citationId: string, original: GedcomNode | null): GedcomNode | null => {
    const citation = citationById.get(citationId);
    const sourceXref = citation === undefined ? undefined : xrefOf.get(citation.source_id);
    if (citation === undefined || sourceXref === undefined) return null;
    let base = original;
    if (base === null) {
      const model = firstWritten.get(citationId);
      if (model) {
        // Written at another place, and perhaps another level, than it was read from.
        base = cloneNode(model);
        touchAll(base);
      }
    }
    const line = patchCitation(base, citation, sourceXref, target);
    // The scans of the page a citation names stand under it.
    syncMedia(line, citationId);
    return line;
  };

  /**
   * Brings the SOUR lines under a name or event in step with the tree: a line
   * whose citation no longer supports this fact goes, one whose citation was
   * edited is rewritten, and citations added since follow the last of them.
   * Lines that never became a citation stay as they are.
   */
  const cite = (node: GedcomNode, cites: Cites, ownerId: string): void => {
    const wanted = citedBy.get(ownerId) ?? [];
    if (wanted.length === 0 && cites === undefined) return;
    const alive = new Set(wanted);
    const written = new Set<string>();
    const children: GedcomNode[] = [];
    let place = -1;
    let last = -1;
    for (const child of node.children) {
      if (child.tag !== 'SOUR') {
        children.push(child);
        continue;
      }
      place += 1;
      const id = cites?.[place] ?? null;
      if (id === null) {
        children.push(child);
        last = children.length - 1;
        continue;
      }
      if (!alive.has(id) || written.has(id)) continue;
      const line = citationNode(id, child);
      if (!line) continue;
      written.add(id);
      children.push(line);
      last = children.length - 1;
    }
    const added = wanted
      .filter((id) => !written.has(id))
      .map((id) => citationNode(id, null))
      .filter((line) => line !== null);
    if (last === -1) children.push(...added);
    else children.splice(last + 1, 0, ...added);
    node.children = children;
  };

  /** The first line of a record: its original, or a new one. */
  const recordNode = (id: string, tag: string): GedcomNode => {
    const text = parsedById.get(id)?.stored.text;
    const original = text === undefined ? undefined : parseFragment(text, sourceVersion)[0];
    if (original) {
      original.children = [];
      return original;
    }
    const made = makeNode(tag);
    made.xref = xref(id);
    return made;
  };

  /** Lays out names or events: the ones that were imported keep their places, new ones follow. */
  const placeInOrder = <T extends { id: string }>(
    layout: Layout,
    parsed: ParsedRecord | null,
    kind: PartKind,
    rows: readonly T[],
    build: (row: T, original: GedcomNode | null, cites: Cites) => GedcomNode,
    absorbed: readonly ParsedRecord[] = [],
  ): void => {
    const alive = new Set(rows.map((row) => row.id));
    const originals = new Map<string, { node: GedcomNode; cites: Cites }>();
    const places: number[] = [];
    parsed?.stored.parts?.forEach((part, index) => {
      const node = parsed.nodes[index];
      if (part.k !== kind || part.r === undefined || !node || !alive.has(part.r)) return;
      originals.set(part.r, { node, cites: part.c });
      places.push(index);
    });
    // A name or event that came over in a merge keeps the lines it had in its
    // own record (a source under it, say), but has no place in this one.
    for (const other of absorbed) {
      other.stored.parts?.forEach((part, index) => {
        const node = other.nodes[index];
        if (part.k !== kind || part.r === undefined || !node || !alive.has(part.r)) return;
        if (!originals.has(part.r)) originals.set(part.r, { node, cites: part.c });
      });
    }
    // The tree's order decides which comes first (the main name, say); the
    // places are the ones those lines had in the file.
    rows.forEach((row, index) => {
      const original = originals.get(row.id);
      const node = build(row, original?.node ?? null, original?.cites);
      const place = places[index];
      if (place === undefined) layout.add(kind, node);
      else layout.at(place, node);
    });
  };

  const eventFields = (row: EventRow): EventFields => ({
    type: row.type,
    date: row.date_text,
    place: row.place_text,
    description: row.description,
    note: row.note,
  });
  const placeEvents = (
    layout: Layout,
    parsed: ParsedRecord | null,
    rows: readonly EventRow[],
    owner: EventOwner,
    absorbed: readonly ParsedRecord[],
  ): void => {
    placeInOrder(
      layout,
      parsed,
      'event',
      rows,
      (row, original, cites) => {
        const node = patchEvent(original, eventFields(row), owner, target);
        cite(node, cites, row.id);
        syncMedia(node, row.id);
        return node;
      },
      absorbed,
    );
  };

  /**
   * Places the citations of a person or family as a whole: the imported ones
   * where they stood, those of records merged into this one after its own
   * lines, and citations added since after the last of their kind.
   */
  const placeCitations = (
    layout: Layout,
    parsed: ParsedRecord | null,
    absorbed: readonly ParsedRecord[],
    ownerId: string,
  ): void => {
    const wanted = citedBy.get(ownerId) ?? [];
    const alive = new Set(wanted);
    const written = new Set<string>();
    const original = (record: ParsedRecord, put: (node: GedcomNode, index: number) => void) => {
      record.stored.parts?.forEach((part, index) => {
        const node = record.nodes[index];
        if (part.k !== 'citation' || part.r === undefined || !node) return;
        if (!alive.has(part.r) || written.has(part.r)) return;
        const line = citationNode(part.r, node);
        if (!line) return;
        written.add(part.r);
        put(line, index);
      });
    };
    if (parsed) original(parsed, (node, index) => layout.at(index, node));
    for (const other of absorbed) original(other, (node) => layout.end(node));
    for (const id of wanted) {
      if (written.has(id)) continue;
      const line = citationNode(id, null);
      if (line) layout.add('citation', line);
    }
  };

  /**
   * Places the files of a person or family as a whole, in the same way: the
   * imported lines where they stood, those of records merged into this one
   * after its own lines, and files attached since after the last of their kind.
   */
  const placeMedia = (
    layout: Layout,
    parsed: ParsedRecord | null,
    absorbed: readonly ParsedRecord[],
    ownerId: string,
  ): void => {
    const wanted = mediaOf.get(ownerId) ?? [];
    const alive = new Set(wanted);
    const written = new Set<string>();
    const original = (
      record: ParsedRecord,
      once: boolean,
      put: (node: GedcomNode, index: number) => void,
    ) => {
      record.stored.parts?.forEach((part, index) => {
        const node = record.nodes[index];
        if (part.k !== 'media' || part.r === undefined || !node) return;
        if (!alive.has(part.r) || (once && written.has(part.r))) return;
        const line = mediaLine(part.r, node);
        if (!line) return;
        written.add(part.r);
        put(line, index);
      });
    };
    // A record that names a file twice gets both lines back; a file that two
    // merged records had is written once.
    if (parsed) original(parsed, false, (node, index) => layout.at(index, node));
    for (const other of absorbed) original(other, true, (node) => layout.end(node));
    for (const id of wanted) {
      if (written.has(id)) continue;
      const line = mediaLine(id, null);
      if (line) layout.add('media', line);
    }
  };

  /** Puts the kept lines of records merged into this one after its own lines. */
  const placeAbsorbed = (layout: Layout, absorbed: readonly ParsedRecord[]): void => {
    for (const other of absorbed) {
      other.stored.parts?.forEach((part, index) => {
        const node = other.nodes[index];
        if (part.k === undefined && node) layout.end(node);
      });
    }
  };

  /** Puts back the lines the app keeps as written, and returns the places of the bound ones. */
  const placeKept = (layout: Layout, parsed: ParsedRecord | null): void => {
    parsed?.stored.parts?.forEach((part, index) => {
      const node = parsed.nodes[index];
      if (part.k === undefined && node) layout.at(index, node);
    });
  };

  const buildPerson = (person: PersonRow): GedcomNode => {
    const parsed = parsedById.get(person.id) ?? null;
    const record = recordNode(person.id, 'INDI');
    const layout = new Layout(PERSON_SECTIONS, parsed);
    const absorbed = absorbedBy.get(person.id) ?? [];
    placeKept(layout, parsed);
    placeAbsorbed(layout, absorbed);
    placeCitations(layout, parsed, absorbed, person.id);
    placeMedia(layout, parsed, absorbed, person.id);

    placeInOrder(
      layout,
      parsed,
      'name',
      namesOf.get(person.id) ?? [],
      (row, original, cites) => {
        const node = patchName(original, row, target);
        cite(node, cites, row.id);
        return node;
      },
      absorbed,
    );
    placeEvents(layout, parsed, personEvents.get(person.id) ?? [], 'person', absorbed);

    const single = (
      kind: 'sex' | 'living',
      build: (original: GedcomNode | null) => GedcomNode | null,
    ) => {
      const index = parsed?.stored.parts?.findIndex((part) => part.k === kind) ?? -1;
      const original = index === -1 ? null : (parsed?.nodes[index] ?? null);
      const node = build(original);
      if (!node) return;
      if (original) layout.at(index, node);
      else layout.add(kind, node);
    };
    single('sex', (original) => patchSex(original, person.sex));
    single('living', (original) =>
      patchLiving(original, person.living === null ? null : person.living === 1),
    );
    // The note. A record merged into this one may have had a note too. The
    // person took it over if they had none; otherwise it is written after the
    // other lines as it was, with what stands under it.
    const absorbedNotes = absorbed.flatMap((other) =>
      (other.stored.parts ?? []).flatMap((part, index) => {
        const node = other.nodes[index];
        return part.k === 'note' && node ? [node] : [];
      }),
    );
    const ownIndex = parsed?.stored.parts?.findIndex((part) => part.k === 'note') ?? -1;
    const own = ownIndex === -1 ? null : (parsed?.nodes[ownIndex] ?? null);
    const ownIsNote = own !== null && cleanNote(own.value) === person.note;
    const taken = ownIsNote
      ? undefined
      : (absorbedNotes.find((node) => cleanNote(node.value) === person.note) ??
        (own === null ? absorbedNotes[0] : undefined));
    if (taken !== undefined) {
      const line = patchNoteLine(taken, person.note);
      if (line) layout.add('note', line);
    } else {
      const line = patchNoteLine(own, person.note);
      if (line && own) layout.at(ownIndex, line);
      else if (line) layout.add('note', line);
    }
    for (const node of absorbedNotes) if (node !== taken) layout.end(node);

    const link = (
      kind: 'child-of' | 'partner-in',
      familyIds: readonly string[],
      build: (familyId: string, original: GedcomNode | null) => GedcomNode,
    ) => {
      const wanted = new Set(familyIds.filter((id) => familyShown.has(id)));
      parsed?.stored.parts?.forEach((part, index) => {
        const node = parsed.nodes[index];
        if (part.k !== kind || part.r === undefined || !node || !wanted.has(part.r)) return;
        wanted.delete(part.r);
        layout.at(index, build(part.r, node));
      });
      for (const familyId of familyIds) {
        if (wanted.has(familyId)) layout.add(kind, build(familyId, null));
      }
    };
    const parentLinks = parentFamiliesOf.get(person.id) ?? [];
    link(
      'child-of',
      parentLinks.map((row) => row.family_id),
      (familyId, original) => {
        const pedigree = parentLinks.find((row) => row.family_id === familyId)?.pedigree ?? 'birth';
        return patchChildOf(
          original,
          xref(familyId),
          pedigree,
          pedigreeWas(familyId, person.id),
          target,
        );
      },
    );
    link(
      'partner-in',
      partnerFamiliesOf.get(person.id) ?? [],
      (familyId, original) => original ?? makeNode('FAMS', pointerTo(xref(familyId))),
    );

    record.children = layout.nodes();
    return record;
  };

  const buildFamily = (family: FamilyRow): GedcomNode => {
    const parsed = parsedById.get(family.id) ?? null;
    const record = recordNode(family.id, 'FAM');
    const layout = new Layout(FAMILY_SECTIONS, parsed);
    // When a partner is left out as living, what is said of the couple is left out with them.
    const partners = [family.partner1_id, family.partner2_id].filter((id) => id !== null);
    const whole = partners.every((id) => shown(id));
    if (whole) {
      const absorbed = absorbedBy.get(family.id) ?? [];
      placeKept(layout, parsed);
      placeAbsorbed(layout, absorbed);
      placeCitations(layout, parsed, absorbed, family.id);
      placeMedia(layout, parsed, absorbed, family.id);
      placeEvents(layout, parsed, familyEvents.get(family.id) ?? [], 'family', absorbed);
    }

    // Partners: the original lines, then HUSB and WIFE for partners added since.
    const wanted = new Set(partners.filter((id) => shown(id)));
    const tagsUsed = new Set<string>();
    parsed?.stored.parts?.forEach((part, index) => {
      const node = parsed.nodes[index];
      if (part.k !== 'partner' || part.r === undefined || !node || !wanted.has(part.r)) return;
      wanted.delete(part.r);
      tagsUsed.add(node.tag);
      layout.at(index, node);
    });
    for (const [place, id] of [family.partner1_id, family.partner2_id].entries()) {
      if (id === null || !wanted.has(id)) continue;
      const usual = place === 0 ? 'HUSB' : 'WIFE';
      const tag = tagsUsed.has(usual) ? (usual === 'HUSB' ? 'WIFE' : 'HUSB') : usual;
      tagsUsed.add(tag);
      layout.add('partner', makeNode(tag, pointerTo(xref(id))));
    }

    const children = (childrenOf.get(family.id) ?? [])
      .filter((row) => shown(row.child_id))
      .map((row) => ({ id: row.child_id, pedigree: row.pedigree }));
    placeInOrder(layout, parsed, 'child', children, (row, original) =>
      patchChildLine(original, xref(row.id), row.pedigree, pedigreeWas(family.id, row.id)),
    );

    record.children = layout.nodes();
    return record;
  };

  // Put the records in file order, with what was added since after its own kind.
  const personById = new Map(persons.map((person) => [person.id, person]));
  const familyById = new Map(exportedFamilies.map((family) => [family.id, family]));
  const imported = new Set(stored.map((record) => record.id));
  const records: { key: readonly [number, number, number]; node: GedcomNode }[] = [];
  let lastPerson = -1;
  let lastFamily = -1;
  let lastSource = -1;
  let lastMedia = -1;
  let headPosition = -1;
  let head: StoredRecord | null = null;

  for (const record of stored) {
    if (record.kind === 'head') {
      head = record;
      headPosition = record.position;
    } else if (record.kind === 'person') {
      lastPerson = record.position;
      const person = personById.get(record.id);
      if (person && shown(person.id)) {
        records.push({ key: [record.position, 0, 0], node: buildPerson(person) });
      }
    } else if (record.kind === 'family') {
      lastFamily = record.position;
      const family = familyById.get(record.id);
      if (family) records.push({ key: [record.position, 0, 0], node: buildFamily(family) });
    } else if (record.kind === 'source') {
      lastSource = record.position;
      const source = sourceById.get(record.id);
      if (source) {
        const original = parseFragment(record.text, sourceVersion)[0] ?? null;
        const node = patchSource(original, source, xref(source.id));
        syncMedia(node, source.id);
        records.push({ key: [record.position, 0, 0], node });
      }
    } else if (record.kind === 'media') {
      // Written further down, once it is known which files are still pointed at.
      lastMedia = record.position;
    } else {
      parseFragment(record.text, sourceVersion).forEach((node, index) => {
        records.push({ key: [record.position, 0, index], node });
      });
    }
  }
  const afterPeople = lastPerson === -1 ? headPosition : lastPerson;
  const afterFamilies = lastFamily === -1 ? afterPeople : lastFamily;
  const afterSources = lastSource === -1 ? afterFamilies : lastSource;
  let added = 0;
  for (const person of persons) {
    if (imported.has(person.id) || !shown(person.id)) continue;
    records.push({ key: [afterPeople, 1, added], node: buildPerson(person) });
    added += 1;
  }
  for (const family of exportedFamilies) {
    if (imported.has(family.id)) continue;
    records.push({ key: [afterFamilies, 2, added], node: buildFamily(family) });
    added += 1;
  }
  for (const source of sources) {
    if (imported.has(source.id)) continue;
    const node = patchSource(null, source, xref(source.id));
    syncMedia(node, source.id);
    records.push({ key: [afterSources, 3, added], node });
    added += 1;
  }

  // Pictures and documents, now that every line that attaches one is written.
  const afterMedia = lastMedia === -1 ? afterSources : lastMedia;
  /** Files the GEDCOM file names, as a record or in place. */
  const named = new Set<string>();
  /** Cross-reference ids of media records that are left out. */
  const mediaGone = new Set<string>();
  let mediaWithheld = 0;
  /**
   * True for a file that is attached to something, when none of the lines
   * that attach it was written: everything it belongs to was left out, which
   * happens to the pictures of people who may be living.
   */
  const withheld = (id: string): boolean =>
    (attachedTo.get(id) ?? 0) > 0 && (linesFor.get(id) ?? 0) === 0;
  for (const record of stored) {
    if (record.kind !== 'media') continue;
    const media = mediaById.get(record.id);
    if (!media || withheld(media.id)) {
      if (media) mediaWithheld += 1;
      if (record.xref !== null) mediaGone.add(record.xref);
      continue;
    }
    const original = parseFragment(record.text, sourceVersion)[0] ?? null;
    records.push({
      key: [record.position, 0, 0],
      node: patchMediaRecord(original, media, {
        version: target,
        xref: mediaXref(media.id),
        ...fileOf(media),
      }),
    });
    named.add(media.id);
  }
  for (const media of mediaRows) {
    if (imported.has(media.id)) continue;
    if (withheld(media.id)) {
      mediaWithheld += 1;
      continue;
    }
    const inPlace = writtenInPlace.has(media.id);
    named.add(media.id);
    // A file whose description stands in place, under what it belongs to, needs no record.
    if (inPlace && keepInPlace && (linesFor.get(media.id) ?? 0) > 0) continue;
    // A record: for a file added in the app, for a file that was written in
    // place and is now attached to nothing, and for every file written in
    // place when the file is turned into GEDCOM 7.0.
    const model = inPlace ? inPlaceModel.get(media.id) : undefined;
    const base = model ? embeddedToRecord(model, mediaXref(media.id)) : null;
    records.push({
      key: [afterMedia, 4, added],
      node: patchMediaRecord(base, media, {
        version: target,
        xref: mediaXref(media.id),
        ...fileOf(media),
      }),
    });
    added += 1;
  }
  records.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  let body = records.map((record) => record.node);

  // A line that pointed at a record merged into another now points at the one that is left.
  const familyExists = new Set(families.map((family) => family.id));
  const movedTo = new Map<string, string>();
  for (const merged of mergedRecords) {
    const old = parsedById.get(merged.id)?.stored.xref ?? null;
    const exists = personById.has(merged.intoId) || familyExists.has(merged.intoId);
    if (old !== null && exists) movedTo.set(old, xref(merged.intoId));
  }
  if (movedTo.size > 0) {
    const repoint = (node: GedcomNode): void => {
      const next = movedTo.get(pointerTarget(node.value) ?? '');
      if (next !== undefined) {
        node.value = pointerTo(next);
        touch(node);
      }
      node.children.forEach(repoint);
    };
    body.forEach(repoint);
  }

  // Nothing may point at a person or family that was left out, or at a
  // person, family or source that has been deleted since the import.
  const gone = new Set<string>(mediaGone);
  for (const person of persons) if (!shown(person.id)) gone.add(xref(person.id));
  for (const family of families) if (!familyShown.has(family.id)) gone.add(xref(family.id));
  for (const record of stored) {
    if (record.xref === null || movedTo.has(record.xref)) continue;
    const deleted =
      (record.kind === 'person' && !personById.has(record.id)) ||
      (record.kind === 'family' && !familyExists.has(record.id)) ||
      (record.kind === 'source' && !sourceById.has(record.id));
    if (deleted) gone.add(record.xref);
  }
  if (gone.size > 0) {
    const prune = (node: GedcomNode): void => {
      if (node.children.some((child) => gone.has(pointerTarget(child.value) ?? ''))) {
        node.children = node.children.filter(
          (child) => !gone.has(pointerTarget(child.value) ?? ''),
        );
      }
      node.children.forEach(prune);
    };
    body.forEach(prune);
  }

  // The header: this app's own lines, then what the original header had beyond those.
  const originalHead = head === null ? null : (parseFragment(head.text, sourceVersion)[0] ?? null);
  const carried = originalHead?.children.filter((child) => !OWN_HEADER_TAGS.has(child.tag)) ?? [];
  let submitter = originalHead?.children.find((child) => child.tag === 'SUBM') ?? null;
  if (!submitter) {
    // A file may hold a submitter record that its header does not point to.
    const existing = body.find((record) => record.tag === 'SUBM' && record.xref !== null);
    if (existing?.xref) submitter = makeNode('SUBM', pointerTo(existing.xref));
  }
  if (!submitter && target === '5.5.1') {
    // GEDCOM 5.5.1 requires a submitter. The app does not know who the user is.
    const record = makeNode('SUBM', '', [makeNode('NAME', 'Not recorded')]);
    record.xref = xrefs.make('SUBM');
    body = [record, ...body];
    submitter = makeNode('SUBM', pointerTo(record.xref));
  }
  const writer = makeNode('SOUR', 'RULZ_ANCESTRY', [
    makeNode('VERS', options.appVersion),
    makeNode('NAME', 'RulZ Ancestry'),
  ]);
  const header = makeNode('HEAD');
  if (target === '7.0') {
    header.children = [
      makeNode('GEDC', '', [makeNode('VERS', '7.0')]),
      writer,
      dateNode(now, target),
      ...(submitter ? [submitter] : []),
      ...carried,
    ];
  } else {
    header.children = [
      writer,
      dateNode(now, target),
      ...(submitter ? [submitter] : []),
      ...(options.fileName === undefined ? [] : [makeNode('FILE', basename(options.fileName))]),
      makeNode('GEDC', '', [makeNode('VERS', '5.5.1'), makeNode('FORM', 'LINEAGE-LINKED')]),
      makeNode('CHAR', 'UTF-8'),
      ...carried,
    ];
  }

  const all = [header, ...body];
  const conversion = sameVersion ? { unconverted: {} } : convertVersion(all, target);
  all.push(makeNode('TRLR'));

  return {
    text: writeGedcom(all, {
      version: target,
      lineEnding: source?.lineEnding ?? '\r\n',
      keepOriginalLines: sameVersion,
    }),
    version: target,
    persons: persons.filter((person) => shown(person.id)).length,
    families: exportedFamilies.length,
    livingOmitted: omitted.size,
    unconverted: conversion.unconverted,
    media: named.size,
    mediaNotHeld: [...named].filter((id) =>
      withFiles ? !packed.has(id) : mediaById.get(id)?.sha256 === null,
    ).length,
    mediaWithheld,
    files: filesToPack,
  };
}

/** The name of the GEDCOM file inside a GEDZip archive, as the standard gives it. */
const GEDZIP_GEDCOM = 'gedcom.ged';

/**
 * Writes a tree to a GEDCOM file or, with `files`, to a GEDZip file: a zip
 * archive that holds the GEDCOM file and the pictures and documents the tree
 * holds. The file is written under a temporary name and renamed when
 * complete, so a failure never leaves half a file under the name that was
 * asked for.
 */
export function exportGedcomFile(
  tree: Tree,
  file: string,
  options: Omit<GedcomExportOptions, 'fileName'>,
): GedcomExportResult {
  const zipped = options.files === true;
  const result = exportGedcom(tree, { ...options, fileName: zipped ? GEDZIP_GEDCOM : file });
  const staging = `${file}.tmp`;
  try {
    if (zipped) {
      writeZip(staging, [
        { name: GEDZIP_GEDCOM, data: encodeGedcom(result.text) },
        ...result.files.map((packed) => ({ name: packed.path, file: packed.source })),
      ]);
    } else {
      writeFileSync(staging, encodeGedcom(result.text));
    }
    renameSync(staging, file);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  return result;
}
