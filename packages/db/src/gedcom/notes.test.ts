import { NOTE_MAX } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { addPersonFromDraft } from '../actions';
import { openDatabase } from '../connection';
import { addPersonEvent, listPersonEvents, updateEvent } from '../events';
import { mergePersons } from '../merge';
import { migrate, schemaVersion } from '../migrate';
import { requirePerson, updatePerson } from '../persons';
import { treeMigrations } from '../schema';
import { requireSource, updateSource } from '../sources';
import { cleanUpAfterEach, memoryTree, track, withLaterColumns } from '../testing';
import { TREE_APPLICATION_ID, Tree } from '../tree';
import { importGedcom } from './import';
import { keptLinesOf } from './store';
import {
  ancestryStyleFile,
  bodyOf,
  exportLines,
  file,
  firstDifference,
  importText,
  inputOf,
  recordOf,
} from './testing';

cleanUpAfterEach();

/**
 * A file with a note everywhere the app reads one, and in the places where
 * it does not: a second note, a pointer to a note record, and a family.
 */
const NOTED = file(
  '5.5.1',
  '0 @U1@ SUBM',
  '1 NAME Ann Lee',
  '0 @I1@ INDI',
  '1 NAME Ann /Lee/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1 JAN 1900',
  '2 NOTE Born at home.',
  '2 NOTE A second note of the birth.',
  '1 NOTE Ann kept a diary.',
  '2 CONT It is lost.',
  '2 SOUR @S1@',
  '1 NOTE @N1@',
  '1 NOTE A second note of Ann.',
  '1 FAMS @F1@',
  '0 @I2@ INDI',
  '1 NAME Tom /Lee/',
  '1 FAMS @F1@',
  '0 @F1@ FAM',
  '1 HUSB @I2@',
  '1 WIFE @I1@',
  '1 MARR',
  '2 DATE 1920',
  '2 NOTE In the rain.',
  '1 NOTE A note of the family.',
  '0 @S1@ SOUR',
  '1 TITL Parish register',
  '1 NOTE Seen on film.',
  '2 CONT Hard to read.',
  '1 REPO @R1@',
  '0 @R1@ REPO',
  '1 NAME County archive',
  '0 @N1@ NOTE A note that several people share.',
);
const NOTED_LINES = NOTED.split(/\r\n|\n/).slice(0, -1);

function imported(text = NOTED): { tree: Tree; id: (xref: string) => string } {
  const tree = memoryTree();
  importText(tree, text);
  const id = (xref: string) =>
    tree.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
  return { tree, id };
}

/** Every note of a tree, by what it is a note of. */
function notesOf(tree: Tree): Record<string, string> {
  const found: Record<string, string> = {};
  const people = tree.db
    .prepare(
      `SELECT r.xref AS xref, p.note AS note FROM person p JOIN gedcom_record r ON r.id = p.id`,
    )
    .all() as { xref: string; note: string }[];
  for (const row of people) found[`person ${row.xref}`] = row.note;
  const sources = tree.db
    .prepare(
      `SELECT r.xref AS xref, s.note AS note FROM source s JOIN gedcom_record r ON r.id = s.id`,
    )
    .all() as { xref: string; note: string }[];
  for (const row of sources) found[`source ${row.xref}`] = row.note;
  const events = tree.db
    .prepare(
      `SELECT r.xref AS xref, e.type AS type, e.date_text AS date, e.note AS note
       FROM event e JOIN event_participant ep ON ep.event_id = e.id
       JOIN gedcom_record r ON r.id = coalesce(ep.person_id, ep.family_id)`,
    )
    .all() as { xref: string; type: string; date: string; note: string }[];
  for (const row of events) found[`${row.type} ${row.date} of ${row.xref}`] = row.note;
  return found;
}

describe('importing notes', () => {
  it('reads the first note of a person, an event and a source', () => {
    const { tree, id } = imported();
    expect(notesOf(tree)).toEqual({
      'person I1': 'Ann kept a diary.\nIt is lost.',
      'person I2': '',
      'birth 1 JAN 1900 of I1': 'Born at home.',
      'marriage 1920 of F1': 'In the rain.',
      'source S1': 'Seen on film.\nHard to read.',
    });
    // A pointer to a note record and a second note stay as written.
    expect(keptLinesOf(tree, id('I1'))).toEqual(['1 NOTE @N1@', '1 NOTE A second note of Ann.']);
    // So does the note of a family, which the app has no field for.
    expect(keptLinesOf(tree, id('F1'))).toEqual(['1 NOTE A note of the family.']);
  });

  it('gives the file back when nothing has changed', () => {
    const { tree } = imported();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(NOTED_LINES))).toBeNull();
  });

  it('gives a GEDCOM 7.0 file back too', () => {
    const text = file(
      '7.0',
      '0 @U1@ SUBM',
      '1 NAME Ann Lee',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 BIRT',
      '2 DATE 1 JAN 1900',
      '2 NOTE Born at home.',
      '1 NOTE Ann kept a diary.',
      '2 CONT It is lost.',
      '1 SNOTE @N1@',
      '0 @S1@ SOUR',
      '1 TITL Parish register',
      '1 NOTE Seen on film.',
      '0 @N1@ SNOTE A note that several people share.',
    );
    const { tree } = imported(text);
    expect(notesOf(tree)).toEqual({
      'person I1': 'Ann kept a diary.\nIt is lost.',
      'birth 1 JAN 1900 of I1': 'Born at home.',
      'source S1': 'Seen on film.',
    });
    const lines = text.split(/\r\n|\n/).slice(0, -1);
    expect(
      firstDifference(bodyOf(exportLines(tree, { version: '7.0' })), bodyOf(lines)),
    ).toBeNull();
  });

  it('leaves a note longer than the forms take as it was written', () => {
    const long = 'x'.repeat(NOTE_MAX + 500);
    const text = file(
      '5.5.1',
      '0 @U1@ SUBM',
      '1 NAME Ann Lee',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      `1 NOTE ${long}`,
    );
    const { tree, id } = imported(text);
    expect(requirePerson(tree, id('I1')).note).toHaveLength(NOTE_MAX);
    const lines = text.split(/\r\n|\n/).slice(0, -1);
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(lines))).toBeNull();
  });
});

describe('editing a note of an imported tree', () => {
  it('rewrites the note of a person and nothing else', () => {
    const { tree, id } = imported();
    updatePerson(tree, id('I1'), { note: 'Ann kept a diary.\nIt was found in 1990.' });
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(NOTED_LINES).map((line) =>
        line === '2 CONT It is lost.' ? '2 CONT It was found in 1990.' : line,
      ),
    );
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(NOTED_LINES))).toBeNull();
  });

  it('takes the line of a cleared note away, with what stood under it', () => {
    const { tree, id } = imported();
    updatePerson(tree, id('I1'), { note: '  ' });
    expect(requirePerson(tree, id('I1')).note).toBe('');
    expect(recordOf(exportLines(tree), '0 @I1@ INDI')).toEqual([
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1 JAN 1900',
      '2 NOTE Born at home.',
      '2 NOTE A second note of the birth.',
      '1 NOTE @N1@',
      '1 NOTE A second note of Ann.',
      '1 FAMS @F1@',
    ]);
  });

  it('rewrites the note of an event', () => {
    const { tree, id } = imported();
    const birth = listPersonEvents(tree, id('I1'))[0];
    expect(birth?.note).toBe('Born at home.');
    updateEvent(tree, birth?.id ?? '', { note: 'Born at the farm.' });
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(NOTED_LINES).map((line) =>
        line === '2 NOTE Born at home.' ? '2 NOTE Born at the farm.' : line,
      ),
    );
    updateEvent(tree, birth?.id ?? '', { note: '' });
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(NOTED_LINES).filter((line) => line !== '2 NOTE Born at home.'),
    );
  });

  it('rewrites the note of a source', () => {
    const { tree, id } = imported();
    updateSource(tree, id('S1'), { note: 'Seen on film.\nEasy to read.' });
    expect(requireSource(tree, id('S1')).note).toBe('Seen on film.\nEasy to read.');
    expect(bodyOf(exportLines(tree))).toEqual(
      bodyOf(NOTED_LINES).map((line) =>
        line === '2 CONT Hard to read.' ? '2 CONT Easy to read.' : line,
      ),
    );
  });

  it('adds a line for a note of someone who had none', () => {
    const { tree, id } = imported();
    updatePerson(tree, id('I2'), { note: 'A carpenter.' });
    expect(recordOf(exportLines(tree), '0 @I2@ INDI')).toEqual([
      '0 @I2@ INDI',
      '1 NAME Tom /Lee/',
      '1 NOTE A carpenter.',
      '1 FAMS @F1@',
    ]);
  });
});

describe('notes of a tree made in the app', () => {
  it('are written to a file and read back from it', () => {
    const tree = memoryTree();
    const ann = addPersonFromDraft(tree, { given: 'Ann', surname: 'Lee' }).id;
    updatePerson(tree, ann, { note: 'First line.\n\nThird line.' });
    addPersonEvent(tree, ann, { type: 'birth', date: '1900', note: 'At home.' });
    const lines = exportLines(tree);
    expect(lines).toEqual(
      expect.arrayContaining([
        '1 NOTE First line.',
        '2 CONT',
        '2 CONT Third line.',
        '2 NOTE At home.',
      ]),
    );

    const again = memoryTree();
    importText(again, `${lines.join('\r\n')}\r\n`);
    const person = again.db.prepare('SELECT id, note FROM person').get() as {
      id: string;
      note: string;
    };
    expect(person.note).toBe('First line.\n\nThird line.');
    expect(listPersonEvents(again, person.id)[0]?.note).toBe('At home.');
  });

  it('keeps an edit of a note that changes nothing out of the undo list', () => {
    const tree = memoryTree();
    const ann = addPersonFromDraft(tree, { given: 'Ann', surname: 'Lee' }).id;
    updatePerson(tree, ann, { note: 'A note.' });
    const before = tree.undoStatus().undo?.id;
    updatePerson(tree, ann, { note: ' A note.\r\n' });
    expect(tree.undoStatus().undo?.id).toBe(before);
  });
});

/** A tree as the app made them before notes were fields: schema version 6. */
function olderTree(): Tree {
  const db = openDatabase(':memory:');
  db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
  migrate(db, treeMigrations.slice(0, 6));
  db.prepare(
    "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
  ).run();
  return track(new Tree(db, null));
}

describe('a tree imported before notes were fields', () => {
  it('holds its notes as lines kept as written', () => {
    const older = olderTree();
    const report = importGedcom(older, inputOf(NOTED), { notes: false });
    expect(schemaVersion(older.db)).toBe(6);
    // Three lines under Ann and one under the family.
    expect(report.keptLines).toBe(4);
  });

  it('is given the same notes as a fresh import of the file', () => {
    for (const text of [NOTED, ancestryStyleFile(60)]) {
      const older = olderTree();
      importGedcom(older, inputOf(text), { notes: false });
      migrate(older.db, treeMigrations);
      expect(schemaVersion(older.db)).toBe(treeMigrations.length);

      const fresh = memoryTree();
      importText(fresh, text);
      expect(notesOf(older)).toEqual(notesOf(fresh));
      const parts = (tree: Tree) =>
        (
          tree.db.prepare('SELECT parts FROM gedcom_record ORDER BY position').pluck().all() as (
            string | null
          )[]
        ).map((value) =>
          value === null
            ? null
            : (JSON.parse(value) as { k?: string; t: string }[]).map((part) => [part.k, part.t]),
        );
      expect(parts(older)).toEqual(parts(fresh));

      const original = text.split(/\r\n|\n/).slice(0, -1);
      expect(firstDifference(bodyOf(exportLines(older)), bodyOf(original))).toBeNull();
      // The upgrade is not an edit.
      expect(older.undoStatus().undo).toBeNull();
    }
  });

  it('can be edited like any other once upgraded', () => {
    const older = olderTree();
    importGedcom(older, inputOf(NOTED), { notes: false });
    migrate(older.db, treeMigrations);
    const ann = older.db.prepare("SELECT id FROM gedcom_record WHERE xref = 'I1'").pluck().get();
    updatePerson(older, ann as string, { note: 'Ann kept a diary.' });
    expect(exportLines(older)).not.toContain('2 CONT It is lost.');
    older.undo();
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(NOTED_LINES))).toBeNull();
  });

  it('gives a note back to an event and a source that are brought back by undo', () => {
    const older = olderTree();
    importGedcom(older, inputOf(NOTED), { notes: false });
    const id = (xref: string) =>
      older.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    // Before the upgrade: the birth and the source are deleted.
    older.transact('Delete event', () => {
      older.db
        .prepare(
          `DELETE FROM event WHERE id IN (SELECT event_id FROM event_participant WHERE person_id = ?)`,
        )
        .run(id('I1'));
    });
    older.transact('Delete source', () => {
      older.db.prepare('DELETE FROM source WHERE id = ?').run(id('S1'));
    });
    migrate(older.db, treeMigrations);
    older.undo();
    older.undo();
    expect(notesOf(older)).toMatchObject({
      'birth 1 JAN 1900 of I1': 'Born at home.',
      'source S1': 'Seen on film.\nHard to read.',
    });
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(NOTED_LINES))).toBeNull();
  });

  it('reads the notes of the events of a record that was merged into another', () => {
    const older = olderTree();
    importGedcom(
      older,
      inputOf(
        file(
          '5.5.1',
          '0 @U1@ SUBM',
          '1 NAME Ann Lee',
          '0 @I1@ INDI',
          '1 NAME Ann /Lee/',
          '0 @I2@ INDI',
          '1 NAME Annie /Lee/',
          '1 NOTE Second record.',
          '1 DEAT',
          '2 DATE 1950',
          '2 NOTE Died at sea.',
        ),
      ),
      { notes: false },
    );
    const id = (xref: string) =>
      older.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    withLaterColumns(older, () => {
      mergePersons(older, id('I1'), id('I2'));
    });
    migrate(older.db, treeMigrations);
    expect(listPersonEvents(older, id('I1'))[0]?.note).toBe('Died at sea.');
    expect(exportLines(older)).toEqual(
      expect.arrayContaining(['1 NOTE Second record.', '2 NOTE Died at sea.']),
    );
  });

  it('leaves the note of a record that was merged into another as a kept line', () => {
    const older = olderTree();
    importGedcom(older, inputOf(NOTED), { notes: false });
    const id = (xref: string) =>
      older.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    let twin = '';
    withLaterColumns(older, () => {
      twin = addPersonFromDraft(older, { given: 'Ann', surname: 'Lee', sex: 'F' }).id;
      mergePersons(older, twin, id('I1'));
    });
    migrate(older.db, treeMigrations);
    expect(requirePerson(older, twin).note).toBe('');
    expect(keptLinesOf(older, twin)).toEqual([
      '1 NOTE Ann kept a diary.\n2 CONT It is lost.\n2 SOUR @S1@',
      '1 NOTE @N1@',
      '1 NOTE A second note of Ann.',
    ]);
    expect(exportLines(older)).toContain('1 NOTE Ann kept a diary.');
  });
});
