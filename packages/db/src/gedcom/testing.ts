import { parseGedcom } from '@rulz/core';
import type { Tree } from '../tree';
import { exportGedcom, type GedcomExportOptions } from './export';
import { importGedcom, type GedcomImportReport, type GedcomInput } from './import';

/** Helpers shared by the GEDCOM unit tests. Not part of the public API. */

/** Joins lines the way the tests write GEDCOM text. */
export function ged(...lines: string[]): string {
  return lines.join('\n');
}

/** A minimal header for a file of the given version. */
export function header(version: '5.5.1' | '7.0' = '5.5.1'): string {
  return version === '7.0'
    ? ged('0 HEAD', '1 GEDC', '2 VERS 7.0')
    : ged('0 HEAD', '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8');
}

/** A whole file: header, the given lines, trailer. */
export function file(version: '5.5.1' | '7.0', ...lines: string[]): string {
  return ged(header(version), ...lines, '0 TRLR', '');
}

export function inputOf(text: string, fileName = 'test.ged'): GedcomInput {
  return {
    document: parseGedcom(text),
    fileName,
    encoding: 'UTF-8',
    lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
    decodingIssues: [],
  };
}

export function importText(tree: Tree, text: string): GedcomImportReport {
  return importGedcom(tree, inputOf(text));
}

export const EXPORT_DEFAULTS: GedcomExportOptions = {
  version: '5.5.1',
  includeLiving: true,
  appVersion: '0.0.0-test',
  now: Date.UTC(2026, 10, 11, 12, 34, 56),
};

/** Exports a tree and returns the file's lines. */
export function exportLines(tree: Tree, options: Partial<GedcomExportOptions> = {}): string[] {
  const text = exportGedcom(tree, { ...EXPORT_DEFAULTS, ...options }).text;
  return text.split(/\r\n|\n/).slice(0, -1);
}

/** The lines of a file after its header record: from the second level 0 line on. */
export function bodyOf(lines: readonly string[]): string[] {
  const start = lines.findIndex((line, index) => index > 0 && line.startsWith('0 '));
  return start === -1 ? [] : lines.slice(start);
}

/** The lines of one record of a file, found by its first line. */
export function recordOf(lines: readonly string[], firstLine: string): string[] {
  const start = lines.indexOf(firstLine);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && line.startsWith('0 '));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/**
 * Says where two lists of lines first differ, or returns null when they are
 * the same. Comparing 300,000 lines with `toEqual` works, but its report of a
 * failure is unreadable.
 */
export function firstDifference(
  actual: readonly string[],
  expected: readonly string[],
): string | null {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== expected[index]) {
      return `line ${index + 1}: expected ${JSON.stringify(expected[index])}, got ${JSON.stringify(actual[index])}`;
    }
  }
  return null;
}

/**
 * What a tree holds, without ids, so that two trees can be compared: people in
 * the order they were added, each with names, events and the families they
 * belong to; families with their partners, children and events.
 */
export function modelOf(tree: Tree): unknown {
  const db = tree.db;
  const personIds = db.prepare('SELECT id FROM person ORDER BY id').pluck().all() as string[];
  const number = new Map(personIds.map((id, index) => [id, index]));
  const events = (column: 'person_id' | 'family_id', id: string) =>
    db
      .prepare(
        `SELECT e.type, e.date_text AS date, e.place_text AS place, e.description
         FROM event_participant ep JOIN event e ON e.id = ep.event_id
         WHERE ep.${column} = ? ORDER BY ep.sort_order, e.id`,
      )
      .all(id);
  const persons = db
    .prepare('SELECT id, sex, living FROM person ORDER BY id')
    .all()
    .map((row) => {
      const person = row as { id: string; sex: string; living: number | null };
      return {
        sex: person.sex,
        living: person.living,
        names: db
          .prepare(
            `SELECT type, prefix, given, nickname, surname, suffix, is_primary AS main
             FROM person_name WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id`,
          )
          .all(person.id),
        events: events('person_id', person.id),
      };
    });
  const families = db
    .prepare('SELECT id, partner1_id, partner2_id FROM family ORDER BY id')
    .all()
    .map((row) => {
      const family = row as { id: string; partner1_id: string | null; partner2_id: string | null };
      return {
        partner1: family.partner1_id === null ? null : number.get(family.partner1_id),
        partner2: family.partner2_id === null ? null : number.get(family.partner2_id),
        children: (
          db
            .prepare(
              'SELECT child_id, pedigree FROM family_child WHERE family_id = ? ORDER BY sort_order, id',
            )
            .all(family.id) as { child_id: string; pedigree: string }[]
        ).map((child) => ({ person: number.get(child.child_id), pedigree: child.pedigree })),
        events: events('family_id', family.id),
      };
    });
  return { persons, families };
}

export { ancestryStyleFile } from './sample';
