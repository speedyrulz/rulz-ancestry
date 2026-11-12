import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  convertVersion,
  encodeGedcom,
  makeNode,
  parseFragment,
  patchChildLine,
  patchChildOf,
  patchEvent,
  patchLiving,
  patchName,
  patchSex,
  pointerTarget,
  pointerTo,
  readPedigree,
  writeGedcom,
  type EventFields,
  type EventOwner,
  type GedcomNode,
  type GedcomVersion,
  type NameFields,
  type Sex,
} from '@rulz/core';
import { sql } from '../connection';
import { presumedLivingIds } from '../living';
import type { Tree } from '../tree';
import { getGedcomSource, listStoredRecords, type PartKind, type StoredRecord } from './store';

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
}

interface PersonRow {
  id: string;
  sex: Sex;
  living: 0 | 1 | null;
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
  'event',
  'child-of',
  'partner-in',
];
/** The same for a family record. */
const FAMILY_SECTIONS: readonly PartKind[] = ['partner', 'event', 'child'];

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
  const persons = sql(db, 'SELECT id, sex, living FROM person ORDER BY id').all() as PersonRow[];
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
        `SELECT e.id, ep.${owner} AS owner_id, e.type, e.date_text, e.place_text, e.description
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
  for (const record of stored) {
    if ((record.kind === 'person' || record.kind === 'family') && record.xref !== null) {
      xrefOf.set(record.id, record.xref);
    }
  }
  for (const person of persons) {
    if (!xrefOf.has(person.id)) xrefOf.set(person.id, xrefs.make('I'));
  }
  for (const family of families) {
    if (!xrefOf.has(family.id)) xrefOf.set(family.id, xrefs.make('F'));
  }
  const xref = (id: string): string => xrefOf.get(id) ?? 'VOID';

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
    build: (row: T, original: GedcomNode | null) => GedcomNode,
  ): void => {
    const alive = new Set(rows.map((row) => row.id));
    const originals = new Map<string, GedcomNode>();
    const places: number[] = [];
    parsed?.stored.parts?.forEach((part, index) => {
      const node = parsed.nodes[index];
      if (part.k !== kind || part.r === undefined || !node || !alive.has(part.r)) return;
      originals.set(part.r, node);
      places.push(index);
    });
    // The tree's order decides which comes first (the main name, say); the
    // places are the ones those lines had in the file.
    rows.forEach((row, index) => {
      const node = build(row, originals.get(row.id) ?? null);
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
  });
  const placeEvents = (
    layout: Layout,
    parsed: ParsedRecord | null,
    rows: readonly EventRow[],
    owner: EventOwner,
  ): void => {
    placeInOrder(layout, parsed, 'event', rows, (row, original) =>
      patchEvent(original, eventFields(row), owner, target),
    );
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
    placeKept(layout, parsed);

    placeInOrder(layout, parsed, 'name', namesOf.get(person.id) ?? [], (row, original) =>
      patchName(original, row, target),
    );
    placeEvents(layout, parsed, personEvents.get(person.id) ?? [], 'person');

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
      placeKept(layout, parsed);
      placeEvents(layout, parsed, familyEvents.get(family.id) ?? [], 'family');
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
    } else {
      parseFragment(record.text, sourceVersion).forEach((node, index) => {
        records.push({ key: [record.position, 0, index], node });
      });
    }
  }
  const afterPeople = lastPerson === -1 ? headPosition : lastPerson;
  const afterFamilies = lastFamily === -1 ? afterPeople : lastFamily;
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
  records.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  let body = records.map((record) => record.node);

  // Nothing may point at a person or family that was left out.
  const gone = new Set<string>();
  for (const person of persons) if (!shown(person.id)) gone.add(xref(person.id));
  for (const family of families) if (!familyShown.has(family.id)) gone.add(xref(family.id));
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
  };
}

/**
 * Writes a tree to a GEDCOM file. The file is written under a temporary name
 * and renamed when complete, so a failure never leaves half a file under the
 * name that was asked for.
 */
export function exportGedcomFile(
  tree: Tree,
  file: string,
  options: Omit<GedcomExportOptions, 'fileName'>,
): GedcomExportResult {
  const result = exportGedcom(tree, { ...options, fileName: file });
  const staging = `${file}.tmp`;
  try {
    writeFileSync(staging, encodeGedcom(result.text));
    renameSync(staging, file);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  return result;
}
