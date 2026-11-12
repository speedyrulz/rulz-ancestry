import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupTree, treeStateToken } from '../backup';
import { getParents } from '../families';
import { getPersonPage } from '../personpage';
import { createPerson } from '../persons';
import { countSearchPersons, listPersons, searchPersons } from '../search';
import { cleanUpAfterEach, memoryTree, tempDir, track, undoDepth } from '../testing';
import { createTree, TreeRuleError } from '../tree';
import { GedcomFileError, importGedcom, importGedcomFile, readGedcomFile } from './import';
import { getGedcomSource, getStoredRecord, listStoredRecords } from './store';
import { file, ged, importText, modelOf } from './testing';

cleanUpAfterEach();

const SMALL = file(
  '5.5.1',
  '0 @I1@ INDI',
  '1 NAME John Henry /Smith/ Jr.',
  '2 GIVN John Henry',
  '2 SURN Smith',
  '2 NSFX Jr.',
  '2 SOUR @S1@',
  '3 PAGE p. 4',
  '1 NAME Jack /Smith/',
  '2 TYPE aka',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 12 Mar 1881',
  '2 PLAC Boston, Massachusetts',
  '1 OCCU Farmer',
  '2 DATE 1900',
  '1 _UID 1234ABCD',
  '1 FAMS @F1@',
  '0 @I2@ INDI',
  '1 NAME Mary /Jones/',
  '1 SEX F',
  '1 DEAT Y',
  '1 FAMS @F1@',
  '0 @I3@ INDI',
  '1 NAME Ann /Smith/',
  '1 SEX F',
  '1 FAMC @F1@',
  '2 PEDI adopted',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 WIFE @I2@',
  '1 CHIL @I3@',
  '1 MARR',
  '2 DATE 1 JUN 1905',
  '2 PLAC York',
  '1 NOTE A family note.',
  '0 @S1@ SOUR',
  '1 TITL Parish register',
);

describe('importGedcom', () => {
  it('turns people, names, events and families into the tree, and counts what it did', () => {
    const tree = memoryTree();
    const report = importText(tree, SMALL);
    expect(report).toMatchObject({
      fileName: 'test.ged',
      version: '5.5.1',
      declaredVersion: '5.5.1',
      encoding: 'UTF-8',
      persons: 3,
      names: 4,
      families: 1,
      events: 4,
      sources: 1,
      citations: 1,
      keptRecords: {},
      // The _UID line of the first person and the note of the family.
      keptLines: 2,
      issues: [],
      issueCount: 0,
    });

    expect(modelOf(tree)).toEqual({
      persons: [
        {
          sex: 'M',
          living: null,
          names: [
            {
              type: 'birth',
              prefix: '',
              given: 'John Henry',
              nickname: '',
              surname: 'Smith',
              suffix: 'Jr.',
              main: 1,
            },
            {
              type: 'aka',
              prefix: '',
              given: 'Jack',
              nickname: '',
              surname: 'Smith',
              suffix: '',
              main: 0,
            },
          ],
          events: [
            { type: 'birth', date: '12 Mar 1881', place: 'Boston, Massachusetts', description: '' },
            { type: 'occupation', date: '1900', place: '', description: 'Farmer' },
          ],
        },
        {
          sex: 'F',
          living: null,
          names: [
            {
              type: 'birth',
              prefix: '',
              given: 'Mary',
              nickname: '',
              surname: 'Jones',
              suffix: '',
              main: 1,
            },
          ],
          events: [{ type: 'death', date: '', place: '', description: '' }],
        },
        {
          sex: 'F',
          living: null,
          names: [
            {
              type: 'birth',
              prefix: '',
              given: 'Ann',
              nickname: '',
              surname: 'Smith',
              suffix: '',
              main: 1,
            },
          ],
          events: [],
        },
      ],
      families: [
        {
          partner1: 0,
          partner2: 1,
          children: [{ person: 2, pedigree: 'adopted' }],
          events: [{ type: 'marriage', date: '1 JUN 1905', place: 'York', description: '' }],
        },
      ],
    });
  });

  it('reads dates into day numbers, so imported people sort and show a lifespan', () => {
    const tree = memoryTree();
    importText(tree, SMALL);
    const john = listPersons(tree).find((person) => person.name?.given === 'John Henry');
    expect(john?.birth).toEqual({
      dateText: '12 Mar 1881',
      placeText: 'Boston, Massachusetts',
      year: '1881',
    });
    const page = john && getPersonPage(tree, john.id);
    expect(page?.partnerFamilies[0]?.partner?.name?.given).toBe('Mary');
    expect(page?.partnerFamilies[0]?.children.map((child) => child.pedigree)).toEqual(['adopted']);
    expect(page?.partnerFamilies[0]?.events[0]?.dateMinJdn).not.toBeNull();
  });

  it('makes imported people findable by any of their names', () => {
    const tree = memoryTree();
    importText(tree, SMALL);
    expect(countSearchPersons(tree, 'jack')).toBe(1);
    expect(
      searchPersons(tree, 'smith')
        .map((person) => person.name?.given)
        .sort(),
    ).toEqual(['Ann', 'John Henry']);
  });

  it('keeps every record and every line of the file, in order', () => {
    const tree = memoryTree();
    importText(tree, SMALL);
    const stored = listStoredRecords(tree);
    expect(stored.map((record) => `${record.kind} ${record.tag} ${record.xref ?? '-'}`)).toEqual([
      'head HEAD -',
      'person INDI I1',
      'person INDI I2',
      'person INDI I3',
      'family FAM F1',
      'source SOUR S1',
    ]);
    // Put together again, the stored text is the file (without its trailer).
    const text = stored
      .map((record) => [record.text, ...(record.parts ?? []).map((part) => part.t)].join('\n'))
      .join('\n');
    expect(`${text}\n0 TRLR\n`).toBe(SMALL);

    const john = stored[1];
    expect(john?.parts?.map((part) => part.k ?? 'kept')).toEqual([
      'name',
      'name',
      'sex',
      'event',
      'event',
      'kept',
      'partner-in',
    ]);
    expect(john && getStoredRecord(tree, john.id)?.xref).toBe('I1');
    expect(getStoredRecord(tree, 'nobody')).toBeNull();
  });

  it('records which file the tree came from', () => {
    const tree = memoryTree();
    expect(getGedcomSource(tree)).toBeNull();
    importText(tree, SMALL);
    expect(getGedcomSource(tree)).toMatchObject({
      version: '5.5.1',
      encoding: 'UTF-8',
      lineEnding: '\n',
      fileName: 'test.ged',
    });
  });

  it('is the starting point of the tree: nothing to undo, but a backup is due', () => {
    const tree = memoryTree();
    createPerson(tree, { name: { given: 'Old' } });
    tree.undo();
    expect(treeStateToken(tree.db)).not.toBeNull();

    const empty = memoryTree();
    expect(treeStateToken(empty.db)).toBeNull();
    importText(empty, SMALL);
    expect(undoDepth(empty)).toBe(0);
    expect(empty.undoStatus()).toEqual({ undo: null, redo: null });
    expect(treeStateToken(empty.db)).toMatch(/^loaded \d+\/$/);

    // An edit after the import is an ordinary undoable step.
    createPerson(empty, { name: { given: 'New' } });
    expect(empty.undoStatus().undo?.label).toBe('Add person');
    expect(treeStateToken(empty.db)).toMatch(/^loaded \d+\/1:\d+:0$/);
  });

  it('makes a tree on disk that is backed up when it closes', () => {
    const dir = join(tempDir(), 'Imported');
    const tree = track(createTree(dir, { name: 'Imported' }));
    importText(tree, SMALL);
    expect(backupTree(tree).created).not.toBeNull();
    // Nothing changed since, so no second backup is made.
    expect(backupTree(tree).created).toBeNull();
  });

  it('refuses a tree that already has people in it, and changes nothing', () => {
    const tree = memoryTree();
    createPerson(tree, { name: { given: 'Already', surname: 'Here' } });
    expect(() => importText(tree, SMALL)).toThrow(TreeRuleError);
    expect(listPersons(tree)).toHaveLength(1);
    expect(listStoredRecords(tree)).toEqual([]);
    expect(tree.undoStatus().undo?.label).toBe('Add person');

    const twice = memoryTree();
    importText(twice, SMALL);
    expect(() => importText(twice, SMALL)).toThrow(/still empty/);
  });

  it('clears the history of an empty tree that had people added and removed', () => {
    const tree = memoryTree();
    createPerson(tree, { name: { given: 'Gone' } });
    tree.undo();
    importText(tree, SMALL);
    expect(tree.undoStatus()).toEqual({ undo: null, redo: null });
    expect(listPersons(tree)).toHaveLength(3);
  });
});

describe('importing files that break the rules', () => {
  it('makes a link that only one side of the file states, and says so', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME Father /A/',
        '1 SEX M',
        '1 FAMS @F1@',
        '0 @I2@ INDI',
        '1 NAME Child /A/',
        '1 FAMC @F1@',
        '0 @I3@ INDI',
        '1 NAME Mother /B/',
        '1 SEX F',
        // The family lists nobody; the people list the family.
        '1 FAMS @F1@',
        '0 @F1@ FAM',
      ),
    );
    expect(modelOf(tree)).toMatchObject({
      families: [{ partner1: 0, partner2: 2, children: [{ person: 1, pedigree: 'birth' }] }],
    });
    expect(report.issues.map((issue) => issue.message)).toEqual([
      "family @F1@ does not list @I1@ as a partner; the link is made from the person's side",
      "family @F1@ does not list @I2@ as a child; the link is made from the person's side",
      "family @F1@ does not list @I3@ as a partner; the link is made from the person's side",
    ]);
    expect(report.issues[0]?.line).toBe(9);
  });

  it('keeps lines that point at nothing, lists them, and leaves out repeated ones', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME A /A/',
        '1 FAMS @F9@',
        '1 FAMC @F1@',
        '0 @F1@ FAM',
        '1 HUSB @I9@',
        '1 CHIL @I1@',
        '1 CHIL @I1@',
        '1 CHIL @I8@',
      ),
    );
    expect(report.issues.map((issue) => issue.message)).toEqual([
      'HUSB @I9@ is not a person in this file; the line is kept as written',
      '@I1@ is listed twice as a child of family @F1@; the second line is left out',
      'CHIL @I8@ is not a person in this file; the line is kept as written',
      'FAMS @F9@ is not a family in this file; the line is kept as written',
    ]);
    const [, person, family] = listStoredRecords(tree);
    expect(person?.parts?.map((part) => part.k ?? 'kept')).toEqual(['name', 'kept', 'child-of']);
    expect(family?.parts?.map((part) => [part.k ?? 'kept', part.t])).toEqual([
      ['kept', '1 HUSB @I9@'],
      ['child', '1 CHIL @I1@'],
      ['kept', '1 CHIL @I8@'],
    ]);
  });

  it('seats two partners with the same tag, and keeps a third as written', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '0 @I2@ INDI',
        '0 @I3@ INDI',
        '0 @F1@ FAM',
        '1 WIFE @I1@',
        '1 WIFE @I2@',
        '1 WIFE @I3@',
        '1 WIFE @I1@',
      ),
    );
    expect(modelOf(tree)).toMatchObject({ families: [{ partner1: 1, partner2: 0 }] });
    expect(report.issues.map((issue) => issue.message)).toEqual([
      'family @F1@ lists more than two partners; this line is kept as written',
      '@I1@ is listed twice as a partner of family @F1@; the second line is left out',
    ]);
  });

  it('does not let anyone become their own ancestor', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file(
        '5.5.1',
        // I1 is the parent of I2, I2 of I3, and I3 is given as the parent of I1.
        '0 @I1@ INDI',
        '1 NAME One /Loop/',
        '1 FAMS @F1@',
        '1 FAMC @F3@',
        '0 @I2@ INDI',
        '1 NAME Two /Loop/',
        '1 FAMC @F1@',
        '1 FAMS @F2@',
        '0 @I3@ INDI',
        '1 NAME Three /Loop/',
        '1 FAMC @F2@',
        '1 FAMS @F3@',
        // And I4 is given as their own parent.
        '0 @I4@ INDI',
        '1 FAMS @F4@',
        '1 FAMC @F4@',
        '0 @F1@ FAM',
        '1 HUSB @I1@',
        '1 CHIL @I2@',
        '0 @F2@ FAM',
        '1 HUSB @I2@',
        '1 CHIL @I3@',
        '0 @F3@ FAM',
        '1 HUSB @I3@',
        '1 CHIL @I1@',
        '0 @F4@ FAM',
        '1 HUSB @I4@',
        '1 CHIL @I4@',
      ),
    );
    expect(report.issueCount).toBe(2);
    expect(report.issues[0]?.message).toMatch(/would make someone their own ancestor/);

    // Two of the three links of the loop are made; no walk up the tree goes round.
    const links = tree.db.prepare('SELECT count(*) FROM family_child').pluck().get();
    expect(links).toBe(2);
    for (const person of listPersons(tree)) {
      const seen = new Set<string>();
      let line = [person.id];
      while (line.length > 0) {
        for (const id of line) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
        line = line.flatMap((id) => getParents(tree, id).map((parent) => parent.parentId));
      }
    }
    // The lines of the link that was not made are still kept.
    const text = listStoredRecords(tree)
      .flatMap((record) => record.parts ?? [])
      .filter((part) => part.k === undefined)
      .map((part) => part.t);
    expect(text).toContain('1 FAMC @F4@');
    expect(text).toContain('1 CHIL @I4@');
  });

  it('keeps a record whose id an earlier record has, and a person record with no id', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 NAME First /A/',
        '0 @I1@ INDI',
        '1 NAME Second /A/',
        '0 INDI',
        '1 NAME None /A/',
      ),
    );
    expect(report.persons).toBe(1);
    expect(report.keptRecords).toEqual({ INDI: 2 });
    expect(report.issues.map((issue) => issue.message)).toEqual([
      'the id @I1@ is used by an earlier record; this record is kept as written',
      'a person record has no id; it is kept as written',
    ]);
    expect(listStoredRecords(tree).map((record) => record.xref)).toEqual([null, 'I1', null, null]);
  });

  it('keeps a name line with nothing in it as written, without making a name of it', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file('5.5.1', '0 @I1@ INDI', '1 NAME', '1 NAME //', '1 NAME Ann //'),
    );
    expect(report.names).toBe(1);
    expect(listPersons(tree)[0]?.name?.given).toBe('Ann');
  });

  it("passes on the parser's and the decoder's issues, and counts those beyond the list", () => {
    const tree = memoryTree();
    const input = {
      ...{ fileName: 'x.ged', encoding: 'Windows-1252', lineEnding: '\n' },
      document: {
        version: '5.5.1' as const,
        declaredVersion: '',
        records: [],
        issues: [{ line: 3, message: 'from the parser' }],
        issueCount: 500,
        lineCount: 0,
      },
      decodingIssues: ['from the decoder'],
    };
    const report = importGedcom(tree, input);
    expect(report.issues).toEqual([
      { line: 0, message: 'from the decoder' },
      { line: 3, message: 'from the parser' },
    ]);
    expect(report.issueCount).toBe(501);
  });
});

describe('importing GEDCOM 7.0', () => {
  it('reads the 7.0 forms of names, kinds of link, dates and the living flag', () => {
    const tree = memoryTree();
    const report = importText(
      tree,
      file(
        '7.0',
        '0 @I1@ INDI',
        '1 NAME Zoë /Čapek/',
        '2 TYPE MAIDEN',
        '1 SEX X',
        '1 _LIVING Y',
        '1 BIRT',
        '2 DATE',
        '3 PHRASE around harvest time',
        '1 DEAT',
        '2 DATE JULIAN 3 FEB 1700',
        '1 NOTE @@handle and a@b',
        '1 FAMC @F1@',
        '2 PEDI OTHER',
        '3 PHRASE Step',
        '0 @F1@ FAM',
        '1 HUSB @VOID@',
        '1 CHIL @I1@',
        '0 @N1@ SNOTE A shared note',
      ),
    );
    expect(report.version).toBe('7.0');
    expect(report.issues).toEqual([]);
    expect(report.keptRecords).toEqual({ SNOTE: 1 });
    expect(modelOf(tree)).toEqual({
      persons: [
        {
          sex: 'X',
          living: 1,
          names: [
            {
              type: 'maiden',
              prefix: '',
              given: 'Zoë',
              nickname: '',
              surname: 'Čapek',
              suffix: '',
              main: 1,
            },
          ],
          events: [
            { type: 'birth', date: 'around harvest time', place: '', description: '' },
            { type: 'death', date: 'JULIAN 3 FEB 1700', place: '', description: '' },
          ],
        },
      ],
      families: [
        { partner1: null, partner2: null, children: [{ person: 0, pedigree: 'step' }], events: [] },
      ],
    });
    const death = tree.db
      .prepare("SELECT date_calendar, date_min_jdn FROM event WHERE type = 'death'")
      .get() as { date_calendar: string; date_min_jdn: number };
    expect(death.date_calendar).toBe('julian');
    expect(death.date_min_jdn).toBeGreaterThan(0);
  });
});

describe('readGedcomFile', () => {
  it('reads a file from disk in the character set it is in', () => {
    const path = join(tempDir(), 'ansel.ged');
    const text = '0 HEAD\r\n1 GEDC\r\n2 VERS 5.5.1\r\n1 CHAR ANSEL\r\n0 @I1@ INDI\r\n1 NAME Ren';
    // In ANSEL, E2 before a letter puts an acute accent on it.
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from(text, 'latin1'),
        Buffer.from([0xe2]),
        Buffer.from('e /Muller/\r\n0 TRLR\r\n', 'latin1'),
      ]),
    );
    const input = readGedcomFile(path);
    expect(input).toMatchObject({ fileName: 'ansel.ged', encoding: 'ANSEL', lineEnding: '\r\n' });

    const tree = memoryTree();
    const report = importGedcomFile(tree, path);
    expect(report.encoding).toBe('ANSEL');
    expect(listPersons(tree)[0]?.name?.given).toBe('René');
  });

  it('refuses what is not a GEDCOM file, with a reason a person can act on', () => {
    const dir = tempDir();
    const write = (name: string, content: string | Buffer) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    expect(() => readGedcomFile(join(dir, 'missing.ged'))).toThrow(GedcomFileError);
    expect(() => readGedcomFile(join(dir, 'missing.ged'))).toThrow(/cannot be read/);
    expect(() => readGedcomFile(write('empty.ged', ''))).toThrow(/is empty/);
    expect(() => readGedcomFile(write('letter.ged', 'Dear John,\n1 thing and\n2 others'))).toThrow(
      /not a GEDCOM file/,
    );
    expect(() => readGedcomFile(write('tree.gdz', Buffer.from([0x50, 0x4b, 3, 4, 0, 0])))).toThrow(
      /zip file/,
    );
  });

  it('accepts a file that has people but no header', () => {
    const path = join(tempDir(), 'bare.ged');
    writeFileSync(path, ged('0 @I1@ INDI', '1 NAME A /B/', '0 TRLR'));
    const tree = memoryTree();
    const report = importGedcomFile(tree, path);
    expect(report.persons).toBe(1);
    expect(report.issues.map((issue) => issue.message)).toEqual([
      'the file has no header (HEAD) record',
    ]);
  });
});
