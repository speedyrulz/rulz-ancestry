import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  LIVING_TAG,
  MAX_ISSUES,
  VOID_POINTER,
  cleanNote,
  decodeGedcom,
  isEventTag,
  isOwnNote,
  localRelativePath,
  newId,
  parseGedcom,
  pointerTarget,
  rawLines,
  readEvent,
  readLiving,
  readMediaRecord,
  readName,
  readPedigree,
  readSex,
  readSource,
  writeLines,
  type EventFields,
  type GedcomDocument,
  type GedcomIssue,
  type GedcomNode,
  type GedcomVersion,
  type MediaRecordFields,
  type NameFields,
  type Sex,
  type SourceFields,
} from '@rulz/core';
import { sql } from '../connection';
import { dateColumns } from '../events';
import { MAX_MEDIA_BYTES, holdNamedFiles, type MediaFileSource, type NamedFile } from '../media';
import type { Tree } from '../tree';
import { ZipError, ZipReader } from '../zip';
import { CitationLoader } from './citations';
import { MediaLoader, insertNamedMedia } from './medialoader';
import { GEDCOM_META, type PartKind, type RecordKind, type StoredPart } from './store';

/**
 * Loads a GEDCOM file into an empty tree.
 *
 * People, their names and events, families and the links between them go into
 * the tree's own tables, and so do sources, the lines that cite them, and the
 * pictures and documents the file names. Everything else in the file (notes,
 * other programs' own tags) is kept as written beside them, so that an export gives the file back with
 * nothing lost. The lines of what did go into the tables are kept too: the
 * export writes an unchanged name, event, source or citation from them.
 *
 * The file is read completely and checked before anything is written, and the
 * writing is one database transaction: the tree ends up holding the whole file
 * or nothing.
 */

/** The file cannot be imported at all; the message says why, for the user. */
export class GedcomFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GedcomFileError';
  }
}

/** Larger files are refused: the whole file is held in memory while it is read. */
export const MAX_GEDCOM_BYTES = 256 * 1024 * 1024;

/** A GEDCOM file that has been read from disk and parsed, ready to import. */
export interface GedcomInput {
  document: GedcomDocument;
  /** The file's name, without its folder. */
  fileName: string;
  /** The character set the file was read as. */
  encoding: string;
  lineEnding: string;
  /** Things the reader had to assume about the character set. */
  decodingIssues: string[];
  /**
   * Where the files the GEDCOM file names can be had from: the zip archive it
   * came in. Left out for a GEDCOM file on its own, which only names them.
   */
  files?: MediaFileSource;
  /** Lets go of the archive. Call it when the import is over, whether it worked or not. */
  close?: () => void;
}

export interface GedcomImportReport {
  fileName: string;
  version: GedcomVersion;
  /** What the file's header gives as its version; empty when it gives none. */
  declaredVersion: string;
  encoding: string;
  persons: number;
  names: number;
  families: number;
  events: number;
  sources: number;
  /** Citations of those sources. One that the file repeats under several facts is counted once. */
  citations: number;
  /** Pictures and documents the file names. One that it describes again under several people is counted once. */
  media: number;
  /** How many of those files came with the GEDCOM file, in a zip archive, and are now in the tree. */
  mediaHeld: number;
  /** Records the app keeps as written because it has no tables for them yet, counted by tag. */
  keptRecords: Record<string, number>;
  /** Lines under people and families (each with what is below it) that are kept as written. */
  keptLines: number;
  /** The first issues found in the file; a line number of 0 means the file as a whole. */
  issues: GedcomIssue[];
  /** How many issues were found in all. */
  issueCount: number;
  durationMs: number;
}

/**
 * Reads and parses a GEDCOM file. Throws {@link GedcomFileError} when the file
 * cannot be read or is not GEDCOM at all; smaller problems are left for the
 * import to report.
 */
export function readGedcomFile(file: string): GedcomInput {
  let bytes: Buffer;
  try {
    const size = statSync(file).size;
    // "PK" starts every zip file, and a GEDZip file (.gdz) is a zip file.
    const start = Buffer.alloc(2);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, start, 0, 2, 0);
    } finally {
      closeSync(fd);
    }
    if (size >= 2 && start[0] === 0x50 && start[1] === 0x4b) return readGedzipFile(file);
    if (size > MAX_GEDCOM_BYTES) {
      throw new GedcomFileError(
        `the file is larger than ${MAX_GEDCOM_BYTES / (1024 * 1024)} MB, which is more than the app can import`,
      );
    }
    bytes = readFileSync(file);
  } catch (error) {
    if (error instanceof GedcomFileError) throw error;
    throw new GedcomFileError(`the file cannot be read: ${(error as Error).message}`);
  }
  return parseGedcomBytes(bytes, basename(file));
}

/** The name of the GEDCOM file inside a GEDZip archive. */
const GEDZIP_GEDCOM = 'gedcom.ged';

/**
 * Reads a GEDZip file: a zip archive that holds a GEDCOM file and the
 * pictures and documents it names. The standard calls the GEDCOM file
 * `gedcom.ged`; an archive made by hand, which holds one `.ged` file under
 * another name, is read as well.
 *
 * Nothing is unpacked here. The input carries a way to get at a file by the
 * path the GEDCOM file gives for it, and only a path that stays inside the
 * archive is looked up.
 */
function readGedzipFile(file: string): GedcomInput {
  let zip: ZipReader;
  try {
    zip = ZipReader.open(file);
  } catch (error) {
    throw new GedcomFileError((error as Error).message);
  }
  try {
    let entry = zip.find(GEDZIP_GEDCOM);
    if (!entry) {
      const found = zip.entries.filter((candidate) => /\.ged$/i.test(candidate.name));
      if (found.length > 1) {
        throw new GedcomFileError(
          'this zip file holds several GEDCOM files; unzip it and import the one you want',
        );
      }
      entry = found[0];
    }
    if (!entry) {
      throw new GedcomFileError('this zip file holds no GEDCOM file (a file called gedcom.ged)');
    }
    if (entry.size > MAX_GEDCOM_BYTES) {
      throw new GedcomFileError(
        `the GEDCOM file in this zip file is larger than ${MAX_GEDCOM_BYTES / (1024 * 1024)} MB, which is more than the app can import`,
      );
    }
    const input = parseGedcomBytes(zip.read(entry, MAX_GEDCOM_BYTES), basename(file));
    // Paths in the GEDCOM file count from the folder it is in.
    const folder = entry.name.slice(0, entry.name.lastIndexOf('/') + 1);
    const archive = zip;
    input.files = {
      open(reference) {
        const path = localRelativePath(reference);
        if (path === null) return null;
        let found = archive.find(folder + path);
        if (!found && path.includes('%')) {
          try {
            found = archive.find(folder + decodeURIComponent(path));
          } catch {
            // Not an encoded path after all.
          }
        }
        if (!found) return null;
        return {
          fileName: found.name.slice(found.name.lastIndexOf('/') + 1),
          read: archive.reader(found, MAX_MEDIA_BYTES),
        };
      },
    };
    input.close = () => {
      archive.close();
    };
    return input;
  } catch (error) {
    zip.close();
    if (error instanceof ZipError) throw new GedcomFileError(error.message);
    throw error;
  }
}

/** Decodes and parses the bytes of a GEDCOM file. */
function parseGedcomBytes(bytes: Buffer, fileName: string): GedcomInput {
  if (bytes.length === 0) throw new GedcomFileError('the file is empty');
  const decoded = decodeGedcom(bytes);
  const document = parseGedcom(decoded.text);
  const recognised = document.records.some(
    (record) => record.tag === 'HEAD' || record.tag === 'INDI' || record.tag === 'FAM',
  );
  if (!recognised) {
    throw new GedcomFileError('this is not a GEDCOM file: it has no header, people or families');
  }
  return {
    document,
    fileName,
    encoding: decoded.encoding,
    lineEnding: decoded.lineEnding,
    decodingIssues: decoded.issues,
  };
}

/** A line under a record while the import decides what it becomes. */
interface PartDraft {
  node: GedcomNode;
  kind?: PartKind;
  ref?: string;
  name?: NameFields;
  event?: EventFields;
  /** For a name or event: the citation each SOUR line under it became. */
  cites?: (string | null)[];
}

interface SourceDraft {
  id: string;
  fields: SourceFields;
}

interface MediaDraft {
  id: string;
  fields: MediaRecordFields;
}

export interface GedcomImportOptions {
  /**
   * False keeps source records and the lines citing them as written, which is
   * what the app did before sources had tables (schema version 4). Only the
   * tests of that migration ask for it. It leaves pictures and documents as
   * written too, since they had no tables then either.
   */
  sources?: boolean;
  /**
   * False keeps media records and the lines that name files as written, which
   * is what the app did before they had rows (schema version 6). Only the
   * tests of that migration ask for it.
   */
  media?: boolean;
  /**
   * False keeps the notes of people, events and sources as written, which is
   * what the app did before notes were fields (schema version 7). Only the
   * tests of that migration ask for it, and the tests of earlier ones, which
   * get it by turning off `sources` or `media`.
   */
  notes?: boolean;
}

interface PersonDraft {
  id: string;
  xref: string;
  record: GedcomNode;
  sex: Sex;
  living: boolean | null;
  note: string;
  parts: PartDraft[];
  /** The person's FAMC line for each family, by the family's id. */
  childOf: Map<string, PartDraft>;
}

interface FamilyDraft {
  id: string;
  xref: string;
  record: GedcomNode;
  partner1: string | null;
  partner2: string | null;
  /** Children in the order the family lists them, by person id. */
  children: string[];
  parts: PartDraft[];
  /** The family's CHIL line for each child, by the person's id. */
  childLines: Map<string, PartDraft>;
}

class IssueList {
  readonly list: GedcomIssue[];
  count: number;

  constructor(found: readonly GedcomIssue[], count: number) {
    this.list = [...found];
    this.count = count;
  }

  add(line: number, message: string): void {
    this.count += 1;
    if (this.list.length < MAX_ISSUES) this.list.push({ line, message });
  }
}

function textOf(node: GedcomNode, level: number, version: GedcomVersion): string {
  return (rawLines(node) ?? writeLines([node], level, { version })).join('\n');
}

/** True for a link that deliberately points at nothing (GEDCOM 7.0) and needs no remark. */
function isVoid(node: GedcomNode): boolean {
  return node.value.trim() === VOID_POINTER;
}

/** Puts a person in a free partner place of a family, trying `first` before the other. */
function seatPartner(family: FamilyDraft, personId: string, first: 1 | 2): boolean {
  const order = first === 1 ? ([1, 2] as const) : ([2, 1] as const);
  for (const seat of order) {
    if (seat === 1 && family.partner1 === null) {
      family.partner1 = personId;
      return true;
    }
    if (seat === 2 && family.partner2 === null) {
      family.partner2 = personId;
      return true;
    }
  }
  return false;
}

/**
 * Finds people who would be their own ancestor and takes out the child link
 * that closes each loop, so charts can walk the tree without guarding against
 * one. The lines of a link that is taken out are kept as written.
 */
function breakLoops(
  persons: ReadonlyMap<string, PersonDraft>,
  families: readonly FamilyDraft[],
  issues: IssueList,
): void {
  const familiesOfChild = new Map<string, FamilyDraft[]>();
  for (const family of families) {
    for (const childId of family.children) {
      const list = familiesOfChild.get(childId);
      if (list) list.push(family);
      else familiesOfChild.set(childId, [family]);
    }
  }
  /** The links from a person up to each parent: the family, and the parent in it. */
  const linksUp = (personId: string): [FamilyDraft, string][] =>
    (familiesOfChild.get(personId) ?? []).flatMap((family) =>
      [family.partner1, family.partner2]
        .filter((parent): parent is string => parent !== null)
        .map((parent): [FamilyDraft, string] => [family, parent]),
    );

  const ON_PATH = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  for (const start of persons.keys()) {
    if (state.has(start)) continue;
    // Walks up from the person through parents, grandparents and so on,
    // without recursion, because a line of descent can be very long.
    const path = [{ id: start, links: linksUp(start), next: 0 }];
    state.set(start, ON_PATH);
    while (path.length > 0) {
      const top = path[path.length - 1];
      if (!top) break;
      const link = top.links[top.next];
      if (!link) {
        state.set(top.id, DONE);
        path.pop();
        continue;
      }
      top.next += 1;
      const [family, parentId] = link;
      if (!family.children.includes(top.id)) continue;
      const seen = state.get(parentId);
      if (seen === ON_PATH) {
        // The parent is the person themself or one of their descendants.
        family.children = family.children.filter((id) => id !== top.id);
        const person = persons.get(top.id);
        const famc = person?.childOf.get(family.id);
        const chil = family.childLines.get(top.id);
        for (const part of [famc, chil]) {
          if (!part) continue;
          delete part.kind;
          delete part.ref;
        }
        person?.childOf.delete(family.id);
        family.childLines.delete(top.id);
        issues.add(
          (chil ?? famc)?.node.line ?? family.record.line,
          `@${person?.xref ?? '?'}@ as a child of family @${family.xref}@ would make someone their own ancestor; the link is not made, and its lines are kept as written`,
        );
      } else if (seen === undefined) {
        state.set(parentId, ON_PATH);
        path.push({ id: parentId, links: linksUp(parentId), next: 0 });
      }
    }
  }
}

/** Loads a parsed GEDCOM file into `tree`, which must be empty. */
export function importGedcom(
  tree: Tree,
  input: GedcomInput,
  options: GedcomImportOptions = {},
): GedcomImportReport {
  const started = Date.now();
  const modelSources = options.sources !== false;
  const modelMedia = modelSources && options.media !== false;
  const modelNotes = modelMedia && options.notes !== false;
  const doc = input.document;
  const version = doc.version;
  const issues = new IssueList([], 0);
  for (const message of input.decodingIssues) issues.add(0, message);
  for (const issue of doc.issues) issues.add(issue.line, issue.message);
  // The parser lists only the first of its issues; count the rest too.
  issues.count += doc.issueCount - doc.issues.length;

  // 1. Tell people and families from the records that are kept as written.
  const persons = new Map<string, PersonDraft>();
  const families = new Map<string, FamilyDraft>();
  const personByNode = new Map<GedcomNode, PersonDraft>();
  const familyByNode = new Map<GedcomNode, FamilyDraft>();
  const sourceByNode = new Map<GedcomNode, SourceDraft>();
  /** The id of each source, by its cross-reference id in the file. */
  const sourceIds = new Map<string, string>();
  const mediaByNode = new Map<GedcomNode, MediaDraft>();
  /** The id of each media record's file, by the record's cross-reference id in the file. */
  const mediaIds = new Map<string, string>();
  const usedXrefs = new Set<string>();
  /** Records whose cross-reference id an earlier record already has. */
  const repeated = new Set<GedcomNode>();

  for (const record of doc.records) {
    if (record.xref !== null) {
      if (usedXrefs.has(record.xref)) {
        repeated.add(record);
        issues.add(
          record.line,
          `the id @${record.xref}@ is used by an earlier record; this record is kept as written`,
        );
        continue;
      }
      usedXrefs.add(record.xref);
    }
    if (record.tag === 'INDI') {
      if (record.xref === null) {
        issues.add(record.line, 'a person record has no id; it is kept as written');
        continue;
      }
      const sexLine = record.children.find((child) => child.tag === 'SEX');
      const livingLine = record.children.find(
        (child) => child.tag === LIVING_TAG && readLiving(child) !== null,
      );
      const draft: PersonDraft = {
        id: newId(),
        xref: record.xref,
        record,
        sex: sexLine ? readSex(sexLine) : 'U',
        living: livingLine ? readLiving(livingLine) : null,
        note: '',
        parts: [],
        childOf: new Map(),
      };
      persons.set(record.xref, draft);
      personByNode.set(record, draft);
    } else if (record.tag === 'FAM') {
      if (record.xref === null) {
        issues.add(record.line, 'a family record has no id; it is kept as written');
        continue;
      }
      const draft: FamilyDraft = {
        id: newId(),
        xref: record.xref,
        record,
        partner1: null,
        partner2: null,
        children: [],
        parts: [],
        childLines: new Map(),
      };
      families.set(record.xref, draft);
      familyByNode.set(record, draft);
    } else if (record.tag === 'SOUR' && record.xref !== null && modelSources) {
      // A source record without an id cannot be cited; it is kept as written.
      const draft: SourceDraft = { id: newId(), fields: readSource(record) };
      sourceByNode.set(record, draft);
      sourceIds.set(record.xref, draft.id);
    } else if (record.tag === 'OBJE' && record.xref !== null && modelMedia) {
      // A media record without an id cannot be pointed at; it is kept as written.
      const draft: MediaDraft = { id: newId(), fields: readMediaRecord(record) };
      mediaByNode.set(record, draft);
      mediaIds.set(record.xref, draft.id);
    }
  }

  // 2. Families: who the partners and children are, as the family records say.
  for (const family of families.values()) {
    for (const node of family.record.children) {
      const part: PartDraft = { node };
      family.parts.push(part);
      const target = pointerTarget(node.value);

      if (node.tag === 'HUSB' || node.tag === 'WIFE') {
        const person = target === null ? undefined : persons.get(target);
        if (!person) {
          if (!isVoid(node)) {
            issues.add(
              node.line,
              `${node.tag} ${node.value} is not a person in this file; the line is kept as written`,
            );
          }
        } else if (family.partner1 === person.id || family.partner2 === person.id) {
          family.parts.pop();
          issues.add(
            node.line,
            `@${person.xref}@ is listed twice as a partner of family @${family.xref}@; the second line is left out`,
          );
        } else if (seatPartner(family, person.id, node.tag === 'HUSB' ? 1 : 2)) {
          part.kind = 'partner';
          part.ref = person.id;
        } else {
          issues.add(
            node.line,
            `family @${family.xref}@ lists more than two partners; this line is kept as written`,
          );
        }
      } else if (node.tag === 'CHIL') {
        const person = target === null ? undefined : persons.get(target);
        if (!person) {
          if (!isVoid(node)) {
            issues.add(
              node.line,
              `CHIL ${node.value} is not a person in this file; the line is kept as written`,
            );
          }
        } else if (family.children.includes(person.id)) {
          family.parts.pop();
          issues.add(
            node.line,
            `@${person.xref}@ is listed twice as a child of family @${family.xref}@; the second line is left out`,
          );
        } else {
          family.children.push(person.id);
          family.childLines.set(person.id, part);
          part.kind = 'child';
          part.ref = person.id;
        }
      } else if (isEventTag(node.tag, 'family')) {
        const event = readEvent(node, 'family');
        if (event) {
          part.kind = 'event';
          part.event = event;
        }
      }
    }
  }

  // 3. People: names, events, and the family links as the person records say.
  for (const person of persons.values()) {
    let sexSeen = false;
    let livingSeen = false;
    for (const node of person.record.children) {
      const part: PartDraft = { node };
      person.parts.push(part);

      if (node.tag === 'NAME') {
        const name = readName(node);
        const blank = name.prefix + name.given + name.nickname + name.surname + name.suffix === '';
        // A NAME line with nothing in it is not a name; it is kept as written.
        if (!blank) {
          part.kind = 'name';
          part.name = name;
        }
      } else if (node.tag === 'SEX' && !sexSeen) {
        sexSeen = true;
        part.kind = 'sex';
      } else if (node.tag === LIVING_TAG && !livingSeen && readLiving(node) !== null) {
        livingSeen = true;
        part.kind = 'living';
      } else if (
        modelNotes &&
        isOwnNote(node) &&
        person.note === '' &&
        cleanNote(node.value) !== ''
      ) {
        // The first note is the person's note; a second one is kept as written.
        person.note = cleanNote(node.value);
        part.kind = 'note';
      } else if (node.tag === 'FAMC' || node.tag === 'FAMS') {
        const target = pointerTarget(node.value);
        const family = target === null ? undefined : families.get(target);
        if (!family) {
          if (!isVoid(node)) {
            issues.add(
              node.line,
              `${node.tag} ${node.value} is not a family in this file; the line is kept as written`,
            );
          }
        } else if (node.tag === 'FAMC') {
          if (person.childOf.has(family.id)) continue;
          if (!family.children.includes(person.id)) {
            family.children.push(person.id);
            issues.add(
              node.line,
              `family @${family.xref}@ does not list @${person.xref}@ as a child; the link is made from the person's side`,
            );
          }
          person.childOf.set(family.id, part);
          part.kind = 'child-of';
          part.ref = family.id;
        } else {
          const linked = person.parts.some(
            (other) => other.kind === 'partner-in' && other.ref === family.id,
          );
          if (linked) continue;
          let partner = family.partner1 === person.id || family.partner2 === person.id;
          if (!partner && seatPartner(family, person.id, person.sex === 'F' ? 2 : 1)) {
            partner = true;
            issues.add(
              node.line,
              `family @${family.xref}@ does not list @${person.xref}@ as a partner; the link is made from the person's side`,
            );
          }
          if (partner) {
            part.kind = 'partner-in';
            part.ref = family.id;
          } else {
            issues.add(
              node.line,
              `family @${family.xref}@ already has two other partners; this line is kept as written`,
            );
          }
        }
      } else if (isEventTag(node.tag, 'person')) {
        const event = readEvent(node, 'person');
        if (event) {
          part.kind = 'event';
          part.event = event;
        }
      }
    }
  }

  // 4. Nobody may be their own ancestor.
  const familyList = [...families.values()];
  const personById = new Map([...persons.values()].map((person) => [person.id, person]));
  breakLoops(personById, familyList, issues);

  // 5. Write everything in one go.
  const report: GedcomImportReport = {
    fileName: input.fileName,
    version,
    declaredVersion: doc.declaredVersion,
    encoding: input.encoding,
    persons: persons.size,
    names: 0,
    families: families.size,
    events: 0,
    sources: sourceByNode.size,
    citations: 0,
    media: 0,
    mediaHeld: 0,
    keptRecords: {},
    keptLines: 0,
    issues: [],
    issueCount: 0,
    durationMs: 0,
  };

  tree.load(() => {
    const db = tree.db;
    const now = Date.now();
    const insertPerson = sql(
      db,
      modelNotes
        ? 'INSERT INTO person (id, sex, living, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO person (id, sex, living, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insertName = sql(
      db,
      `INSERT INTO person_name (id, person_id, type, prefix, given, nickname, surname, suffix,
         is_primary, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = sql(
      db,
      `INSERT INTO event (id, type, date_text, date_qualifier, date_calendar, date_min_jdn,
         date_max_jdn, place_text, description, created_at, updated_at${modelNotes ? ', note' : ''})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${modelNotes ? ', ?' : ''})`,
    );
    const insertParticipant = sql(
      db,
      `INSERT INTO event_participant (id, event_id, person_id, family_id, role, sort_order)
       VALUES (?, ?, ?, ?, 'principal', ?)`,
    );
    const insertFamily = sql(
      db,
      'INSERT INTO family (id, partner1_id, partner2_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insertChild = sql(
      db,
      'INSERT INTO family_child (id, family_id, child_id, pedigree, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    const insertRecord = sql(
      db,
      'INSERT INTO gedcom_record (id, position, tag, xref, kind, text, parts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    const addEvent = (
      event: EventFields,
      personId: string | null,
      familyId: string | null,
      order: number,
    ): string => {
      const id = newId();
      insertEvent.run(
        id,
        event.type,
        ...dateColumns(event.date),
        event.place,
        event.description,
        now,
        now,
        ...(modelNotes ? [event.note] : []),
      );
      insertParticipant.run(newId(), id, personId, familyId, order);
      report.events += 1;
      return id;
    };

    // Media records first of all: the lines that point at them need their ids.
    for (const item of mediaByNode.values()) insertNamedMedia(db, item.id, item.fields, now);
    const media = modelMedia ? new MediaLoader(db, mediaIds, now) : null;

    // Then sources: the lines that cite them need their ids.
    for (const source of sourceByNode.values()) {
      const fields = source.fields;
      sql(
        db,
        `INSERT INTO source (id, title, author, publication, abbreviation, text, created_at,
           updated_at${modelNotes ? ', note' : ''})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?${modelNotes ? ', ?' : ''})`,
      ).run(
        source.id,
        fields.title,
        fields.author,
        fields.publication,
        fields.abbreviation,
        fields.text,
        now,
        now,
        ...(modelNotes ? [fields.note] : []),
      );
    }
    for (const [record, source] of sourceByNode) {
      media?.attachChildren(record, { source: source.id });
    }
    const citations = new CitationLoader(db, sourceIds, now);
    /** Makes citations of the SOUR lines under a name or event that has just been stored. */
    const cite = (part: PartDraft, owner: { name: string } | { event: string }): void => {
      if (sourceIds.size === 0) return;
      const cites = citations.citeChildren(part.node, owner);
      if (cites === undefined) return;
      part.cites = cites;
      // A scan of the page a citation names belongs to the citation.
      media?.attachUnderCitations(part.node, cites);
    };
    /**
     * Makes a citation of a SOUR line that stands directly under a person or
     * family, and attaches a file from an OBJE line that stands there.
     */
    const whole = (part: PartDraft, owner: { person: string } | { family: string }): void => {
      if (part.kind !== undefined) return;
      if (part.node.tag === 'SOUR' && sourceIds.size > 0) {
        const id = citations.cite(part.node, owner);
        if (id === null) return;
        part.kind = 'citation';
        part.ref = id;
        media?.attachChildren(part.node, { citation: id });
      } else if (part.node.tag === 'OBJE' && media) {
        const id = media.attach(part.node, owner);
        if (id === null) return;
        part.kind = 'media';
        part.ref = id;
      }
    };

    for (const person of persons.values()) {
      insertPerson.run(
        person.id,
        person.sex,
        person.living === null ? null : person.living ? 1 : 0,
        ...(modelNotes ? [person.note] : []),
        now,
        now,
      );
      let names = 0;
      let events = 0;
      for (const part of person.parts) {
        if (part.kind === 'name' && part.name) {
          const name = part.name;
          part.ref = newId();
          insertName.run(
            part.ref,
            person.id,
            name.type,
            name.prefix,
            name.given,
            name.nickname,
            name.surname,
            name.suffix,
            names === 0 ? 1 : 0,
            names,
          );
          names += 1;
          cite(part, { name: part.ref });
        } else if (part.kind === 'event' && part.event) {
          part.ref = addEvent(part.event, person.id, null, events);
          events += 1;
          cite(part, { event: part.ref });
          media?.attachChildren(part.node, { event: part.ref });
        } else {
          whole(part, { person: person.id });
        }
      }
      report.names += names;
    }

    for (const family of familyList) {
      insertFamily.run(family.id, family.partner1, family.partner2, now, now);
      family.children.forEach((childId, index) => {
        const famc = personById.get(childId)?.childOf.get(family.id)?.node ?? null;
        const chil = family.childLines.get(childId)?.node ?? null;
        insertChild.run(newId(), family.id, childId, readPedigree(famc, chil), index);
      });
      let events = 0;
      for (const part of family.parts) {
        if (part.kind === 'event' && part.event) {
          part.ref = addEvent(part.event, null, family.id, events);
          events += 1;
          cite(part, { event: part.ref });
          media?.attachChildren(part.node, { event: part.ref });
        } else {
          whole(part, { family: family.id });
        }
      }
    }
    report.citations = citations.citations;
    report.media = mediaByNode.size + (media?.embedded.length ?? 0);

    const storeParts = (parts: readonly PartDraft[]): string => {
      const stored = parts.map((part): StoredPart => {
        const text = textOf(part.node, 1, version);
        if (part.kind === undefined) {
          report.keptLines += 1;
          return { t: text };
        }
        const made: StoredPart =
          part.ref === undefined
            ? { k: part.kind, t: text }
            : { k: part.kind, r: part.ref, t: text };
        if (part.cites !== undefined) made.c = part.cites;
        return made;
      });
      return JSON.stringify(stored);
    };

    let position = 0;
    let headStored = false;
    for (const record of doc.records) {
      if (record.tag === 'TRLR') continue;
      const person = personByNode.get(record);
      const family = familyByNode.get(record);
      const source = sourceByNode.get(record);
      const item = mediaByNode.get(record);
      const xref = repeated.has(record) ? null : record.xref;
      let id: string;
      let kind: RecordKind;
      let text: string;
      let parts: string | null = null;
      if (person) {
        id = person.id;
        kind = 'person';
        text = (record.raw ?? [`0 @${person.xref}@ INDI`]).join('\n');
        parts = storeParts(person.parts);
      } else if (family) {
        id = family.id;
        kind = 'family';
        text = (record.raw ?? [`0 @${family.xref}@ FAM`]).join('\n');
        parts = storeParts(family.parts);
      } else if (source) {
        id = source.id;
        kind = 'source';
        text = textOf(record, 0, version);
      } else if (item) {
        id = item.id;
        kind = 'media';
        text = textOf(record, 0, version);
      } else {
        id = newId();
        kind = record.tag === 'HEAD' && !headStored ? 'head' : 'kept';
        if (kind === 'head') headStored = true;
        else report.keptRecords[record.tag] = (report.keptRecords[record.tag] ?? 0) + 1;
        text = textOf(record, 0, version);
      }
      insertRecord.run(id, position, record.tag, xref, kind, text, parts);
      position += 1;
    }

    tree.setMeta(GEDCOM_META.version, version);
    tree.setMeta(GEDCOM_META.encoding, input.encoding);
    tree.setMeta(GEDCOM_META.lineEnding, input.lineEnding);
    tree.setMeta(GEDCOM_META.fileName, input.fileName);
    tree.setMeta(GEDCOM_META.importedAt, String(now));

    // The files themselves, when the GEDCOM file came with them in a zip archive.
    if (input.files !== undefined) {
      const named: NamedFile[] = [
        ...[...mediaByNode.values()].map((draft) => ({
          id: draft.id,
          reference: draft.fields.file,
        })),
        ...(media?.embedded ?? []).map((made) => ({ id: made.id, reference: made.file })),
      ].filter((file) => file.reference !== '');
      const taken = holdNamedFiles(tree, named, input.files);
      report.mediaHeld = taken.held;
      for (const problem of taken.problems) issues.add(0, problem);
    }
  });

  report.issues = issues.list;
  report.issueCount = issues.count;
  report.durationMs = Date.now() - started;
  return report;
}

/** Reads a GEDCOM file from disk and loads it into `tree`, which must be empty. */
export function importGedcomFile(tree: Tree, file: string): GedcomImportReport {
  const input = readGedcomFile(file);
  try {
    return importGedcom(tree, input);
  } finally {
    input.close?.();
  }
}
