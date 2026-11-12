import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addChildOf, addParent, addPartner, addPersonFromDraft } from '../actions';
import { addFamilyEvent, addPersonEvent, deleteEvent, updateEvent } from '../events';
import { setChildPedigree } from '../families';
import {
  addName,
  deleteName,
  deletePerson,
  setPrimaryName,
  updateName,
  updatePerson,
} from '../persons';
import { listPersons, searchPersons } from '../search';
import { backupTree, restoreBackup } from '../backup';
import { cleanUpAfterEach, memoryTree, tempDir, track } from '../testing';
import { createTree, openExistingTree, type Tree } from '../tree';
import { exportGedcom, exportGedcomFile } from './export';
import {
  EXPORT_DEFAULTS,
  bodyOf,
  exportLines,
  file,
  firstDifference,
  ged,
  importText,
  modelOf,
  recordOf,
} from './testing';

cleanUpAfterEach();

/** The id of the one person a search finds. */
function find(tree: Tree, name: string): string {
  const [person, ...others] = searchPersons(tree, name);
  if (!person || others.length > 0) throw new Error(`expected one person named ${name}`);
  return person.id;
}

/** A file with a little of everything, written with some of the liberties real files take. */
const FAMILY = file(
  '5.5.1',
  '0 @SUBM1@ SUBM',
  '1 NAME Someone',
  '0 @I1@ INDI',
  '1 NAME John Henry /Smith/ Jr.',
  '2 GIVN John Henry',
  '2 SURN Smith',
  '2 NSFX Jr.',
  '2 SOUR @S1@',
  '3 PAGE p. 4',
  '3 _APID 1,7602::1',
  '1 NAME Jack /Smith/',
  '2 TYPE aka',
  '1 SEX M',
  '1 FAMS @F1@',
  '1 birt',
  '2 DATE 12 Mar 1881',
  '2 PLAC Boston, Suffolk, Massachusetts, USA',
  '2 SOUR @S1@',
  '3 PAGE p. 5',
  '1 RESI Age: 19; Relation to Head of House: Son',
  '2 DATE 1900',
  '1 _UID 1234ABCD',
  '1 NOTE A long note that some program broke in an odd pl',
  '2 CONC ace, with an address a@b.com that it did not double',
  '2 CONT and a second line',
  '1 DEAT',
  '2 DATE 4 Jul 1950',
  '1 OBJE @O1@',
  '0 @I2@ INDI',
  '1 NAME Mary /Jones/',
  '1 SEX F',
  '1 FAMS @F1@',
  '1 DEAT Y',
  '0 @I3@ INDI',
  '1 NAME Ann /Smith/',
  '1 SEX F',
  '1 FAMC @F1@',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 WIFE @I2@',
  '1 CHIL @I3@',
  '2 _FREL Natural',
  '2 _MREL Natural',
  '1 MARR',
  '2 DATE 1 Jun 1905',
  '2 PLAC York',
  '1 NOTE A family note.',
  '0 @S1@ SOUR',
  '1 TITL Parish register',
  '0 @O1@ OBJE',
  '1 FILE portrait.jpg',
  '2 FORM jpg',
);
const FAMILY_BODY = bodyOf(FAMILY.split('\n').slice(0, -1));

describe('exporting a tree made in the app', () => {
  it('writes a complete 5.5.1 file', () => {
    const tree = memoryTree();
    const john = addPersonFromDraft(tree, {
      given: 'John',
      surname: 'Smith',
      sex: 'M',
      birthDate: '12 March 1881',
      birthPlace: 'Boston',
      deathDate: 'abt 1950',
    });
    const mary = addPartner(tree, john.id, {
      create: { given: 'Mary', surname: 'Jones', sex: 'F' },
    });
    addFamilyEvent(tree, mary.familyId, { type: 'marriage', date: '1905', place: 'York' });
    addChildOf(
      tree,
      john.id,
      { create: { given: 'Ann', surname: 'Smith' } },
      { familyId: mary.familyId, pedigree: 'adopted' },
    );
    addPersonEvent(tree, john.id, { type: 'occupation', description: 'Farmer' });
    addPersonEvent(tree, john.id, { type: 'military', date: '1917' });
    addName(tree, john.id, { type: 'aka', given: 'Jack', nickname: 'Jacko' });
    updatePerson(tree, john.id, { living: false });

    expect(exportLines(tree)).toEqual([
      '0 HEAD',
      '1 SOUR RULZ_ANCESTRY',
      '2 VERS 0.0.0-test',
      '2 NAME RulZ Ancestry',
      '1 DATE 11 NOV 2026',
      '2 TIME 12:34:56',
      '1 SUBM @SUBM1@',
      '1 GEDC',
      '2 VERS 5.5.1',
      '2 FORM LINEAGE-LINKED',
      '1 CHAR UTF-8',
      '0 @SUBM1@ SUBM',
      '1 NAME Not recorded',
      '0 @I1@ INDI',
      '1 NAME John /Smith/',
      '2 GIVN John',
      '2 SURN Smith',
      '1 NAME Jack //',
      '2 TYPE aka',
      '2 GIVN Jack',
      '2 NICK Jacko',
      '1 SEX M',
      '1 _LIVING N',
      '1 BIRT',
      '2 DATE 12 MAR 1881',
      '2 PLAC Boston',
      '1 DEAT',
      '2 DATE ABT 1950',
      '1 OCCU Farmer',
      '1 EVEN',
      '2 TYPE Military',
      '2 DATE 1917',
      '1 FAMS @F1@',
      '0 @I2@ INDI',
      '1 NAME Mary /Jones/',
      '2 GIVN Mary',
      '2 SURN Jones',
      '1 SEX F',
      '1 FAMS @F1@',
      '0 @I3@ INDI',
      '1 NAME Ann /Smith/',
      '2 GIVN Ann',
      '2 SURN Smith',
      '1 FAMC @F1@',
      '2 PEDI adopted',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 MARR',
      '2 DATE 1905',
      '2 PLAC York',
      '1 CHIL @I3@',
      '0 TRLR',
    ]);
  });

  it('writes the same tree as 7.0, with the 7.0 header and forms', () => {
    const tree = memoryTree();
    const ann = addPersonFromDraft(tree, { given: 'Ann', birthDate: 'after the war' });
    addParent(tree, ann.id, { create: { given: 'Eve', sex: 'F' } }, { pedigree: 'step' });
    addName(tree, ann.id, { type: 'married', surname: 'Lee' });
    addPersonEvent(tree, ann.id, { type: 'death', description: 'At sea' });

    expect(exportLines(tree, { version: '7.0' })).toEqual([
      '0 HEAD',
      '1 GEDC',
      '2 VERS 7.0',
      '1 SOUR RULZ_ANCESTRY',
      '2 VERS 0.0.0-test',
      '2 NAME RulZ Ancestry',
      '1 DATE 11 NOV 2026',
      '2 TIME 12:34:56Z',
      '0 @I1@ INDI',
      '1 NAME Ann //',
      '2 GIVN Ann',
      '1 NAME /Lee/',
      '2 TYPE MARRIED',
      '2 SURN Lee',
      '1 BIRT',
      '2 DATE',
      '3 PHRASE after the war',
      '1 DEAT',
      '2 NOTE At sea',
      '1 FAMC @F1@',
      '2 PEDI OTHER',
      '3 PHRASE step',
      '0 @I2@ INDI',
      '1 NAME Eve //',
      '2 GIVN Eve',
      '1 SEX F',
      '1 FAMS @F1@',
      '0 @F1@ FAM',
      '1 WIFE @I2@',
      '1 CHIL @I1@',
      '0 TRLR',
    ]);
  });

  it('gives an empty tree a valid file', () => {
    const tree = memoryTree();
    const result = exportGedcom(tree, { ...EXPORT_DEFAULTS, version: '7.0' });
    expect(result).toMatchObject({ persons: 0, families: 0, livingOmitted: 0, unconverted: {} });
    expect(result.text.endsWith('0 TRLR\r\n')).toBe(true);
  });

  it('reads back as the same tree, in either version', () => {
    for (const version of ['5.5.1', '7.0'] as const) {
      const tree = memoryTree();
      const john = addPersonFromDraft(tree, {
        given: 'John',
        surname: 'van der Berg',
        sex: 'M',
        birthDate: '12 MAR 1881',
        birthPlace: 'Boston',
        living: false,
      });
      addName(tree, john.id, { type: 'professional', prefix: 'Dr.', given: 'J.', suffix: 'MD' });
      addPersonEvent(tree, john.id, { type: 'occupation', date: '1900', description: 'Doctor' });
      addPersonEvent(tree, john.id, { type: 'shipwreck', date: 'BEF 1920', place: 'At sea' });
      const mary = addPartner(tree, john.id, { create: { given: 'Mary', sex: 'F', living: true } });
      addFamilyEvent(tree, mary.familyId, { type: 'marriage', date: 'BET 1904 AND 1906' });
      addChildOf(tree, john.id, { create: { given: 'Ann' } }, { pedigree: 'foster' });
      addChildOf(tree, john.id, { create: { given: 'Bob' } }, { pedigree: 'step' });

      const copy = memoryTree();
      importText(copy, exportLines(tree, { version }).join('\n'));
      expect(modelOf(copy), version).toEqual(modelOf(tree));
    }
  });
});

describe('exporting an imported tree in the version it came in', () => {
  it('gives the file back line for line, apart from the header', () => {
    const tree = memoryTree();
    expect(importText(tree, FAMILY).issues).toEqual([]);
    const lines = exportLines(tree);
    expect(firstDifference(bodyOf(lines), FAMILY_BODY)).toBeNull();
    // The header names this app as the writer, and points to the submitter the file has.
    expect(lines.slice(0, 12)).toEqual([
      '0 HEAD',
      '1 SOUR RULZ_ANCESTRY',
      '2 VERS 0.0.0-test',
      '2 NAME RulZ Ancestry',
      '1 DATE 11 NOV 2026',
      '2 TIME 12:34:56',
      '1 SUBM @SUBM1@',
      '1 GEDC',
      '2 VERS 5.5.1',
      '2 FORM LINEAGE-LINKED',
      '1 CHAR UTF-8',
      '0 @SUBM1@ SUBM',
    ]);
  });

  it('carries over what the original header had beyond the lines the app writes itself', () => {
    const tree = memoryTree();
    importText(
      tree,
      ged(
        '0 HEAD',
        '1 SOUR Ancestry.com Family Trees',
        '2 _TREE My tree',
        '1 SUBM @U1@',
        '1 GEDC',
        '2 VERS 5.5.1',
        '1 CHAR UTF-8',
        '1 LANG English',
        '1 COPR Mine',
        '1 _CUSTOM kept',
        '0 @U1@ SUBM',
        '1 NAME Me',
        '0 TRLR',
      ),
    );
    const lines = exportLines(tree, { fileName: 'C:/somewhere/out.ged' });
    expect(lines.slice(4)).toEqual([
      '1 DATE 11 NOV 2026',
      '2 TIME 12:34:56',
      '1 SUBM @U1@',
      '1 FILE out.ged',
      '1 GEDC',
      '2 VERS 5.5.1',
      '2 FORM LINEAGE-LINKED',
      '1 CHAR UTF-8',
      '1 LANG English',
      '1 COPR Mine',
      '1 _CUSTOM kept',
      '0 @U1@ SUBM',
      '1 NAME Me',
      '0 TRLR',
    ]);
  });

  it('uses the line ending of the file it came from', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    expect(exportGedcom(tree, EXPORT_DEFAULTS).text).not.toContain('\r');
    const windows = memoryTree();
    importText(windows, FAMILY.replaceAll('\n', '\r\n'));
    expect(exportGedcom(windows, EXPORT_DEFAULTS).text.split('\r\n')).toHaveLength(
      // The header the app writes is six lines longer than the one in the test file.
      FAMILY.split('\n').length + 6,
    );
  });

  it('still gives the file back after the tree was closed, reopened and restored from a backup', () => {
    const dir = join(tempDir(), 'Tree');
    const tree = track(createTree(dir, { name: 'Tree' }));
    importText(tree, FAMILY);
    const backup = backupTree(tree).created;
    tree.close();

    const reopened = track(openExistingTree(dir));
    expect(firstDifference(bodyOf(exportLines(reopened)), FAMILY_BODY)).toBeNull();
    deletePerson(reopened, find(reopened, 'ann'));
    expect(exportLines(reopened)).not.toContain('0 @I3@ INDI');
    reopened.close();

    // What was kept of the file is part of the tree file, so a backup holds it too.
    restoreBackup(dir, backup?.name ?? '');
    const restored = track(openExistingTree(dir));
    expect(firstDifference(bodyOf(exportLines(restored)), FAMILY_BODY)).toBeNull();
  });

  it('gives a 7.0 file back line for line as well', () => {
    const seven = file(
      '7.0',
      '0 @I1@ INDI',
      '1 NAME Zoë /Čapek/',
      '2 TYPE OTHER',
      '3 PHRASE Stage name',
      '1 SEX X',
      '1 BIRT',
      '2 DATE',
      '3 PHRASE around harvest time',
      '1 NOTE @@handle and a@b',
      '2 LANG en',
      '1 SNOTE @N1@',
      '1 FAMC @F1@',
      '2 PEDI ADOPTED',
      '1 UID 8f1c2b9e',
      '0 @F1@ FAM',
      '1 HUSB @VOID@',
      '1 CHIL @I1@',
      '1 NO MARR',
      '0 @N1@ SNOTE A shared note',
      '1 MIME text/plain',
    );
    const tree = memoryTree();
    expect(importText(tree, seven).issues).toEqual([]);
    const lines = exportLines(tree, { version: '7.0' });
    expect(firstDifference(bodyOf(lines), bodyOf(seven.split('\n').slice(0, -1)))).toBeNull();
  });
});

describe('exporting an imported tree after edits', () => {
  it('rewrites only the lines of what was changed', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    const john = find(tree, 'john henry');
    const names = tree.db
      .prepare('SELECT id FROM person_name WHERE person_id = ? ORDER BY sort_order')
      .pluck()
      .all(john) as string[];
    updateName(tree, names[0] ?? '', { given: 'Jon Henry' });
    const birth = tree.db
      .prepare(
        `SELECT e.id FROM event e JOIN event_participant ep ON ep.event_id = e.id
         WHERE ep.person_id = ? AND e.type = 'birth'`,
      )
      .pluck()
      .get(john) as string;
    updateEvent(tree, birth, { place: 'Salem' });

    const expected = FAMILY_BODY.map((line) =>
      line === '1 NAME John Henry /Smith/ Jr.'
        ? '1 NAME Jon Henry /Smith/ Jr.'
        : line === '2 GIVN John Henry'
          ? '2 GIVN Jon Henry'
          : line === '2 PLAC Boston, Suffolk, Massachusetts, USA'
            ? '2 PLAC Salem'
            : line,
    );
    expect(firstDifference(bodyOf(exportLines(tree)), expected)).toBeNull();

    // Undoing the edits brings the export back to the original file.
    tree.undo();
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), FAMILY_BODY)).toBeNull();
  });

  it('puts added names, events and links after the original ones of their kind', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    const john = find(tree, 'john henry');
    addName(tree, john, { type: 'immigrant', given: 'Johann', surname: 'Schmidt' });
    addPersonEvent(tree, john, { type: 'burial', date: '7 Jul 1950' });
    updatePerson(tree, john, { living: false });
    addParent(tree, john, { create: { given: 'Peter', surname: 'Smith', sex: 'M' } });

    const lines = exportLines(tree);
    expect(recordOf(lines, '0 @I1@ INDI').filter((line) => line.startsWith('1 '))).toEqual([
      '1 NAME John Henry /Smith/ Jr.',
      '1 NAME Jack /Smith/',
      '1 NAME Johann /Schmidt/',
      '1 SEX M',
      '1 _LIVING N',
      '1 FAMS @F1@',
      '1 birt',
      '1 RESI Age: 19; Relation to Head of House: Son',
      '1 _UID 1234ABCD',
      '1 NOTE A long note that some program broke in an odd pl',
      '1 DEAT',
      '1 BURI',
      '1 FAMC @F2@',
      '1 OBJE @O1@',
    ]);
    // The new person and family follow the imported ones, with ids no record has yet.
    expect(lines.filter((line) => line.startsWith('0 '))).toEqual([
      '0 HEAD',
      '0 @SUBM1@ SUBM',
      '0 @I1@ INDI',
      '0 @I2@ INDI',
      '0 @I3@ INDI',
      '0 @I4@ INDI',
      '0 @F1@ FAM',
      '0 @F2@ FAM',
      '0 @S1@ SOUR',
      '0 @O1@ OBJE',
      '0 TRLR',
    ]);
    expect(recordOf(lines, '0 @F2@ FAM')).toEqual(['0 @F2@ FAM', '1 HUSB @I4@', '1 CHIL @I1@']);
  });

  it('writes the main name first when another name is made the main one', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    const john = find(tree, 'john henry');
    const aka = tree.db
      .prepare("SELECT id FROM person_name WHERE person_id = ? AND type = 'aka'")
      .pluck()
      .get(john) as string;
    setPrimaryName(tree, aka);
    const names = recordOf(exportLines(tree), '0 @I1@ INDI').filter((line) =>
      line.startsWith('1 NAME'),
    );
    expect(names).toEqual(['1 NAME Jack /Smith/', '1 NAME John Henry /Smith/ Jr.']);
  });

  it('leaves out what was deleted, with every link to it, and has it back after undo', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    const john = find(tree, 'john henry');
    const death = tree.db
      .prepare(
        `SELECT e.id FROM event e JOIN event_participant ep ON ep.event_id = e.id
         WHERE ep.person_id = ? AND e.type = 'death'`,
      )
      .pluck()
      .get(john) as string;
    deleteEvent(tree, death);
    const aka = tree.db
      .prepare("SELECT id FROM person_name WHERE person_id = ? AND type = 'aka'")
      .pluck()
      .get(john) as string;
    deleteName(tree, aka);
    deletePerson(tree, find(tree, 'ann'));

    const lines = exportLines(tree);
    expect(lines).not.toContain('0 @I3@ INDI');
    expect(lines).not.toContain('1 CHIL @I3@');
    expect(lines).not.toContain('2 _FREL Natural');
    expect(lines).not.toContain('1 NAME Jack /Smith/');
    expect(lines).not.toContain('2 DATE 4 Jul 1950');
    expect(recordOf(lines, '0 @F1@ FAM')).toEqual([
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 MARR',
      '2 DATE 1 Jun 1905',
      '2 PLAC York',
      '1 NOTE A family note.',
    ]);

    tree.undo();
    tree.undo();
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), FAMILY_BODY)).toBeNull();
  });

  it('writes a changed kind of child link where the file kept it', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    const family = tree.db.prepare('SELECT id FROM family').pluck().get() as string;
    setChildPedigree(tree, family, find(tree, 'ann'), 'adopted');
    const lines = exportLines(tree);
    expect(recordOf(lines, '0 @I3@ INDI').slice(-2)).toEqual(['1 FAMC @F1@', '2 PEDI adopted']);
    expect(recordOf(lines, '0 @F1@ FAM').slice(3, 6)).toEqual([
      '1 CHIL @I3@',
      '2 _FREL Adopted',
      '2 _MREL Adopted',
    ]);
  });
});

describe('exporting in the other version', () => {
  it('writes an imported 5.5.1 tree as 7.0', () => {
    const tree = memoryTree();
    importText(tree, FAMILY);
    const result = exportGedcom(tree, { ...EXPORT_DEFAULTS, version: '7.0' });
    expect(result.unconverted).toEqual({});
    const lines = result.text.split('\n').slice(0, -1);
    expect(recordOf(lines, '0 @I1@ INDI')).toEqual([
      '0 @I1@ INDI',
      '1 NAME John Henry /Smith/ Jr.',
      '2 GIVN John Henry',
      '2 SURN Smith',
      '2 NSFX Jr.',
      '2 SOUR @S1@',
      '3 PAGE p. 4',
      '3 _APID 1,7602::1',
      '1 NAME Jack /Smith/',
      '2 TYPE AKA',
      '1 SEX M',
      '1 FAMS @F1@',
      '1 BIRT',
      '2 DATE 12 MAR 1881',
      '2 PLAC Boston, Suffolk, Massachusetts, USA',
      '2 SOUR @S1@',
      '3 PAGE p. 5',
      '1 RESI Age: 19; Relation to Head of House: Son',
      '2 DATE 1900',
      '1 _UID 1234ABCD',
      // 7.0 has no CONC, and doubles @ only at the start of a line.
      '1 NOTE A long note that some program broke in an odd place, with an address a@b.com that it did not double',
      '2 CONT and a second line',
      '1 DEAT',
      '2 DATE 4 JUL 1950',
      '1 OBJE @O1@',
    ]);
    expect(recordOf(lines, '0 @O1@ OBJE')).toEqual([
      '0 @O1@ OBJE',
      '1 FILE portrait.jpg',
      '2 FORM image/jpeg',
    ]);
    expect(lines.slice(0, 3)).toEqual(['0 HEAD', '1 GEDC', '2 VERS 7.0']);
    expect(lines).toContain('1 SUBM @SUBM1@');

    // Read back, the 7.0 file holds the same people, families and events.
    const copy = memoryTree();
    expect(importText(copy, result.text).issues).toEqual([]);
    const upper = (model: unknown) => JSON.stringify(model).toUpperCase();
    expect(upper(modelOf(copy))).toBe(upper(modelOf(tree)));
  });

  it('says what it could not rewrite for the other version', () => {
    const tree = memoryTree();
    importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME A /B/',
        '1 OBJE',
        '2 FILE a.xyz',
        '2 FORM xyz',
        '1 NOTE See the picture',
        '2 OBJE',
        '3 TITL Under a note, which the app keeps as written',
      ),
    );
    // The first picture is a file of the tree and becomes a record, as 7.0
    // wants. Its format is one 7.0 has no name for. The second names no file
    // and stays as it was written.
    expect(exportGedcom(tree, { ...EXPORT_DEFAULTS, version: '7.0' }).unconverted).toEqual({
      'media item described in place': 1,
      'file format': 1,
    });
    expect(exportGedcom(tree, EXPORT_DEFAULTS).unconverted).toEqual({});
  });

  it('writes an imported 7.0 tree as 5.5.1', () => {
    const tree = memoryTree();
    importText(
      tree,
      file(
        '7.0',
        '0 @I1@ INDI',
        '1 NAME Ann /Lee/',
        '2 TYPE MARRIED',
        '1 BIRT',
        '2 DATE',
        '3 PHRASE around harvest time',
        '1 SNOTE @N1@',
        '1 FAMC @F1@',
        '2 PEDI FOSTER',
        '0 @F1@ FAM',
        '1 HUSB @VOID@',
        '1 CHIL @I1@',
        '0 @N1@ SNOTE A shared note',
      ),
    );
    expect(bodyOf(exportLines(tree))).toEqual([
      '0 @SUBM1@ SUBM',
      '1 NAME Not recorded',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '2 TYPE married',
      '1 BIRT',
      '2 DATE (around harvest time)',
      '1 NOTE @N1@',
      '1 FAMC @F1@',
      '2 PEDI foster',
      '0 @F1@ FAM',
      '1 CHIL @I1@',
      '0 @N1@ NOTE A shared note',
      '0 TRLR',
    ]);
  });
});

describe('leaving out living people', () => {
  /** Grandparents long dead, a deceased father, a living mother and two children. */
  function household(): Tree {
    const tree = memoryTree();
    importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME Old /Smith/',
        '1 BIRT',
        '2 DATE 1850',
        '1 FAMS @F1@',
        '0 @I2@ INDI',
        '1 NAME Father /Smith/',
        '1 DEAT Y',
        '1 FAMC @F1@',
        '1 FAMS @F2@',
        '0 @I3@ INDI',
        '1 NAME Mother /Jones/',
        '1 BIRT',
        '2 DATE 1960',
        '1 FAMS @F2@',
        '1 ASSO @I5@',
        '2 RELA Friend',
        '0 @I4@ INDI',
        '1 NAME Child /Smith/',
        '1 FAMC @F2@',
        '1 ASSO @I2@',
        '2 RELA Father',
        '0 @I5@ INDI',
        '1 NAME Undated /Person/',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 CHIL @I2@',
        '0 @F2@ FAM',
        '1 HUSB @I2@',
        '1 WIFE @I3@',
        '1 CHIL @I4@',
        '1 MARR',
        '2 DATE 1985',
        '1 NOTE Private.',
      ),
    );
    return tree;
  }

  it('includes everyone when asked to', () => {
    const result = exportGedcom(household(), EXPORT_DEFAULTS);
    expect(result).toMatchObject({ persons: 5, families: 2, livingOmitted: 0 });
  });

  it('leaves out anyone who may be living, and everything that points at them', () => {
    const tree = household();
    const result = exportGedcom(tree, { ...EXPORT_DEFAULTS, includeLiving: false });
    expect(result).toMatchObject({ persons: 2, families: 2, livingOmitted: 3 });
    const lines = result.text.split('\n').slice(0, -1);
    expect(bodyOf(lines)).toEqual([
      '0 @SUBM1@ SUBM',
      '1 NAME Not recorded',
      '0 @I1@ INDI',
      '1 NAME Old /Smith/',
      '1 BIRT',
      '2 DATE 1850',
      '1 FAMS @F1@',
      '0 @I2@ INDI',
      '1 NAME Father /Smith/',
      '1 DEAT Y',
      '1 FAMC @F1@',
      '1 FAMS @F2@',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 CHIL @I2@',
      // The couple's marriage and note concern the living partner too.
      '0 @F2@ FAM',
      '1 HUSB @I2@',
      '0 TRLR',
    ]);
    expect(result.text).not.toMatch(/Mother|Child|Undated|Private|1985/);
  });

  it('goes by the living flag when it is set', () => {
    const tree = household();
    const people = listPersons(tree);
    const id = (given: string) => people.find((person) => person.name?.given === given)?.id ?? '';
    updatePerson(tree, id('Undated'), { living: false });
    updatePerson(tree, id('Old'), { living: true });
    const result = exportGedcom(tree, { ...EXPORT_DEFAULTS, includeLiving: false });
    expect(result.livingOmitted).toBe(3);
    expect(result.text).toMatch(/Undated/);
    expect(result.text).not.toMatch(/Old \/Smith/);
    // The father is still in his parents' family, so the family is written, without the parent.
    expect(recordOf(result.text.split('\n'), '0 @F1@ FAM')).toEqual(['0 @F1@ FAM', '1 CHIL @I2@']);

    // A family nobody is left in is not written, and nothing points at it.
    updatePerson(tree, id('Father'), { living: true });
    const fewer = exportGedcom(tree, { ...EXPORT_DEFAULTS, includeLiving: false });
    expect(fewer).toMatchObject({ persons: 1, families: 0, livingOmitted: 4 });
    expect(fewer.text).not.toMatch(/ FAM|FAMC|FAMS/);
  });
});

describe('exportGedcomFile', () => {
  it('writes UTF-8 with a byte-order mark, under the name asked for and no other', () => {
    const tree = memoryTree();
    addPersonFromDraft(tree, { given: 'Zoë', surname: 'Čapek' });
    const dir = tempDir();
    const path = join(dir, 'out.ged');
    const result = exportGedcomFile(tree, path, EXPORT_DEFAULTS);
    expect(result.persons).toBe(1);

    const bytes = readFileSync(path);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    expect(text).toContain('1 NAME Zoë /Čapek/');
    expect(text).toContain('1 FILE out.ged');
    expect(readdirSync(dir)).toEqual(['out.ged']);
  });

  it('leaves no file behind when it cannot write', () => {
    const tree = memoryTree();
    const path = join(tempDir(), 'no-such-folder', 'out.ged');
    expect(() => exportGedcomFile(tree, path, EXPORT_DEFAULTS)).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
