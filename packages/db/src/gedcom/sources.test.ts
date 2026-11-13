import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_DIR_NAME, listBackups } from '../backup';
import { openDatabase } from '../connection';
import { addPersonFromDraft } from '../actions';
import { deleteEvent, listFamilyEvents, listPersonEvents } from '../events';
import { migrate, schemaVersion } from '../migrate';
import { listNames } from '../persons';
import { treeMigrations } from '../schema';
import {
  addCitation,
  createSource,
  deleteSource,
  getSource,
  keptLinesOfSource,
  linkCitation,
  listCitations,
  listPersonCitations,
  listSources,
  unlinkCitation,
  updateCitation,
  updateSource,
} from '../sources';
import { cleanUpAfterEach, memoryTree, tempDir, track } from '../testing';
import { TREE_APPLICATION_ID, TREE_FILE_NAME, Tree, openExistingTree } from '../tree';
import { importGedcom } from './import';
import { keptLinesOf, listStoredRecords } from './store';
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
 * One census entry cited for a name, a birth and the person as a whole, a
 * register cited twice, and three lines that cannot become citations.
 */
const CITED = file(
  '5.5.1',
  '0 @U1@ SUBM',
  '1 NAME A tester',
  '0 @I1@ INDI',
  '1 NAME John /Hale/',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 _APID 1,7602::11',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1870',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 _APID 1,7602::11',
  '2 SOUR @S2@',
  '3 PAGE p. 12',
  '3 DATA',
  '4 TEXT John, son of Tom Hale',
  '3 QUAY 3',
  '3 NOTE Hard to read',
  '1 RESI',
  '2 DATE 1900',
  '2 SOUR The family bible',
  '3 TEXT Lived at the farm',
  '2 SOUR @S9@',
  '1 SOUR @S1@',
  '2 PAGE Sheet 4B',
  '2 _APID 1,7602::11',
  '1 NOTE A note',
  '2 SOUR @S2@',
  '1 FAMS @F1@',
  '0 @I2@ INDI',
  '1 NAME Mary /Stone/',
  '1 SEX F',
  '1 FAMS @F1@',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 WIFE @I2@',
  '1 MARR',
  '2 DATE 1895',
  '2 SOUR @S2@',
  '3 PAGE p. 30',
  '1 SOUR @S2@',
  '2 PAGE p. 30',
  '0 @S1@ SOUR',
  '1 TITL 1900 United States Federal Census',
  '1 AUTH Ancestry.com',
  '1 PUBL Ancestry.com Operations Inc',
  '1 REPO @R1@',
  '1 _APID 1,7602::0',
  '0 @S2@ SOUR',
  '1 ABBR Parish register',
  '1 TEXT Baptisms 1850-1880',
  '2 CONT Marriages 1850-1900',
  '0 @R1@ REPO',
  '1 NAME Ancestry.com',
);
const CITED_LINES = CITED.split('\n').slice(0, -1);

interface Imported {
  tree: Tree;
  /** The id of the person, family or source with this cross-reference id. */
  id: (xref: string) => string;
  /** The id of a person's event of one type. */
  event: (xref: string, type: string) => string;
}

function imported(text = CITED): Imported {
  const tree = memoryTree();
  importText(tree, text);
  const id = (xref: string) =>
    tree.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
  const event = (xref: string, type: string) =>
    listPersonEvents(tree, id(xref)).find((entry) => entry.type === type)?.id ?? '';
  return { tree, id, event };
}

/** The lines of one structure of a record: from its first line to the next line at level 1. */
function partOf(record: readonly string[], firstLine: string): string[] {
  const start = record.indexOf(firstLine);
  if (start === -1) return [];
  const end = record.findIndex((line, index) => index > start && line.startsWith('1 '));
  return record.slice(start, end === -1 ? record.length : end);
}

/** The citations of a tree by what they say, each with the kinds of fact it supports. */
function citationsOf(tree: Tree): string[] {
  const rows = tree.db
    .prepare(
      `SELECT c.id, (CASE WHEN s.title = '' THEN s.abbreviation ELSE s.title END) AS source, c.page
       FROM citation c JOIN source s ON s.id = c.source_id ORDER BY source, c.page`,
    )
    .all() as { id: string; source: string; page: string }[];
  return rows.map((row) => {
    const kinds = tree.db
      .prepare(
        `SELECT (CASE WHEN person_id IS NOT NULL THEN 'person' WHEN family_id IS NOT NULL THEN 'family'
                      WHEN event_id IS NOT NULL THEN 'event' ELSE 'name' END)
         FROM citation_link WHERE citation_id = ? ORDER BY 1`,
      )
      .pluck()
      .all(row.id) as string[];
    return `${row.source} | ${row.page} | ${kinds.join(',')}`;
  });
}

describe('importing sources and citations', () => {
  it('makes a source of each source record', () => {
    const { tree, id } = imported();
    expect(getSource(tree, id('S1'))).toMatchObject({
      title: '1900 United States Federal Census',
      author: 'Ancestry.com',
      publication: 'Ancestry.com Operations Inc',
      abbreviation: '',
      text: '',
    });
    expect(getSource(tree, id('S2'))).toMatchObject({
      title: '',
      abbreviation: 'Parish register',
      text: 'Baptisms 1850-1880\nMarriages 1850-1900',
    });
    expect(
      listSources(tree).map((source) => [source.title || source.abbreviation, source.citations]),
    ).toEqual([
      ['1900 United States Federal Census', 1],
      ['Parish register', 2],
    ]);
  });

  it('makes one citation of lines that say the same, linked to each fact', () => {
    const { tree } = imported();
    expect(citationsOf(tree)).toEqual([
      '1900 United States Federal Census | Sheet 4B | event,name,person',
      'Parish register | p. 12 | event',
      'Parish register | p. 30 | event,family',
    ]);
  });

  it('reads what a citation says', () => {
    const { tree, event } = imported();
    const birth = listCitations(tree, { type: 'event', id: event('I1', 'birth') });
    expect(birth.map((citation) => citation.page)).toEqual(['Sheet 4B', 'p. 12']);
    expect(birth[1]).toMatchObject({
      sourceTitle: 'Parish register',
      text: 'John, son of Tom Hale',
      quality: 3,
      note: 'Hard to read',
    });
  });

  it('counts what it made, and keeps the lines that are not citations as written', () => {
    const tree = memoryTree();
    const report = importText(tree, CITED);
    expect(report).toMatchObject({
      sources: 2,
      citations: 3,
      keptRecords: { SUBM: 1, REPO: 1 },
      // The citations under people and families are not kept lines, nor is the note of the first person.
      keptLines: 0,
    });
    const john = listStoredRecords(tree).find((record) => record.xref === 'I1');
    expect(keptLinesOf(tree, john?.id ?? '')).toEqual([]);
    // The source under the note stays with it.
    expect(john?.parts?.find((part) => part.k === 'note')?.t).toBe('1 NOTE A note\n2 SOUR @S2@');
    // A source described in place and a pointer to no record of the file stay under their event.
    const residence = john?.parts?.find((part) => part.t.startsWith('1 RESI'));
    expect(residence?.c).toBeUndefined();
    const birth = john?.parts?.find((part) => part.t.startsWith('1 BIRT'));
    expect(birth?.c).toHaveLength(2);
  });

  it('keeps the second of two equal citations of one fact as written', () => {
    const { tree, event } = imported(
      file(
        '5.5.1',
        '0 @I1@ INDI',
        '1 BIRT',
        '2 SOUR @S1@',
        '3 PAGE 1',
        '2 SOUR @S1@',
        '3 PAGE 1',
        '0 @S1@ SOUR',
        '1 TITL Register',
      ),
    );
    expect(listCitations(tree, { type: 'event', id: event('I1', 'birth') })).toHaveLength(1);
    const person = listStoredRecords(tree).find((record) => record.xref === 'I1');
    expect(person?.parts?.[0]?.c?.map((entry) => entry === null)).toEqual([false, true]);
  });

  it('shows the lines of a source the app has no fields for', () => {
    const { tree, id } = imported();
    expect(keptLinesOfSource(tree, id('S1'))).toEqual(['1 REPO @R1@', '1 _APID 1,7602::0']);
    expect(keptLinesOfSource(tree, id('S2'))).toEqual([]);
    expect(keptLinesOfSource(tree, createSource(tree, { title: 'New' }).id)).toEqual([]);
  });
});

describe('exporting sources and citations', () => {
  it('gives the file back when nothing has changed', () => {
    const { tree } = imported();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(CITED_LINES))).toBeNull();
  });

  it('rewrites one line of every place an edited citation stands', () => {
    const { tree, event } = imported();
    const census = listCitations(tree, { type: 'event', id: event('I1', 'birth') })[0];
    updateCitation(tree, census?.id ?? '', { page: 'Sheet 5A' });
    const expected = CITED_LINES.map((line) => line.replace('PAGE Sheet 4B', 'PAGE Sheet 5A'));
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(expected))).toBeNull();
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(CITED_LINES))).toBeNull();
  });

  it('rewrites one line of an edited source', () => {
    const { tree, id } = imported();
    updateSource(tree, id('S1'), { author: 'Census Bureau' });
    const expected = CITED_LINES.map((line) =>
      line === '1 AUTH Ancestry.com' ? '1 AUTH Census Bureau' : line,
    );
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(expected))).toBeNull();
  });

  it('drops the lines of a citation that was taken away from a fact, there only', () => {
    const { tree, id, event } = imported();
    const birth = { type: 'event', id: event('I1', 'birth') } as const;
    const census = listCitations(tree, birth)[0];
    unlinkCitation(tree, census?.id ?? '', birth);
    expect(recordOf(exportLines(tree), '0 @I1@ INDI')).toEqual([
      '0 @I1@ INDI',
      '1 NAME John /Hale/',
      '2 SOUR @S1@',
      '3 PAGE Sheet 4B',
      '3 _APID 1,7602::11',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1870',
      '2 SOUR @S2@',
      '3 PAGE p. 12',
      '3 DATA',
      '4 TEXT John, son of Tom Hale',
      '3 QUAY 3',
      '3 NOTE Hard to read',
      '1 RESI',
      '2 DATE 1900',
      '2 SOUR The family bible',
      '3 TEXT Lived at the farm',
      '2 SOUR @S9@',
      '1 SOUR @S1@',
      '2 PAGE Sheet 4B',
      '2 _APID 1,7602::11',
      '1 NOTE A note',
      '2 SOUR @S2@',
      '1 FAMS @F1@',
    ]);

    // Taken away from the person as a whole too, its line under the person goes.
    unlinkCitation(tree, census?.id ?? '', { type: 'person', id: id('I1') });
    const lines = recordOf(exportLines(tree), '0 @I1@ INDI');
    expect(lines.filter((line) => line.includes('SOUR @S1@'))).toEqual(['2 SOUR @S1@']);
  });

  it('writes a citation used for another fact with the lines it came with', () => {
    const { tree, id, event } = imported();
    const census = listCitations(tree, { type: 'event', id: event('I1', 'birth') })[0];
    linkCitation(tree, census?.id ?? '', { type: 'event', id: event('I1', 'residence') });
    linkCitation(tree, census?.id ?? '', { type: 'person', id: id('I2') });
    const lines = exportLines(tree);
    expect(partOf(recordOf(lines, '0 @I1@ INDI'), '1 RESI')).toEqual([
      '1 RESI',
      '2 DATE 1900',
      '2 SOUR The family bible',
      '3 TEXT Lived at the farm',
      '2 SOUR @S9@',
      '2 SOUR @S1@',
      '3 PAGE Sheet 4B',
      '3 _APID 1,7602::11',
    ]);
    expect(recordOf(lines, '0 @I2@ INDI')).toEqual([
      '0 @I2@ INDI',
      '1 NAME Mary /Stone/',
      '1 SEX F',
      '1 FAMS @F1@',
      '1 SOUR @S1@',
      '2 PAGE Sheet 4B',
      '2 _APID 1,7602::11',
    ]);
  });

  it('writes a source and a citation added in the app', () => {
    const { tree, id, event } = imported();
    const death = { type: 'event', id: event('I1', 'residence') } as const;
    addCitation(
      tree,
      death,
      { create: { title: 'Family bible', author: 'The Hales' } },
      {
        page: 'Inside cover',
        text: 'Moved to the farm\nin 1899',
        quality: 2,
      },
    );
    const nameId = listNames(tree, id('I2'))[0]?.id ?? '';
    addCitation(tree, { type: 'name', id: nameId }, { sourceId: id('S2') }, { page: 'p. 31' });
    const marriageId = listFamilyEvents(tree, id('F1'))[0]?.id ?? '';
    addCitation(
      tree,
      { type: 'event', id: marriageId },
      { sourceId: id('S2') },
      { note: 'Also here' },
    );
    addCitation(tree, { type: 'family', id: id('F1') }, { sourceId: id('S1') });

    const lines = exportLines(tree);
    // The new source follows the file's own sources; its id is the first one free.
    expect(lines.slice(lines.indexOf('0 @S2@ SOUR'))).toEqual([
      '0 @S2@ SOUR',
      '1 ABBR Parish register',
      '1 TEXT Baptisms 1850-1880',
      '2 CONT Marriages 1850-1900',
      '0 @S3@ SOUR',
      '1 TITL Family bible',
      '1 AUTH The Hales',
      '0 @R1@ REPO',
      '1 NAME Ancestry.com',
      '0 TRLR',
    ]);
    expect(partOf(recordOf(lines, '0 @I1@ INDI'), '1 RESI')).toEqual([
      '1 RESI',
      '2 DATE 1900',
      '2 SOUR The family bible',
      '3 TEXT Lived at the farm',
      '2 SOUR @S9@',
      '2 SOUR @S3@',
      '3 PAGE Inside cover',
      '3 DATA',
      '4 TEXT Moved to the farm',
      '5 CONT in 1899',
      '3 QUAY 2',
    ]);
    expect(recordOf(lines, '0 @I2@ INDI')).toEqual([
      '0 @I2@ INDI',
      '1 NAME Mary /Stone/',
      '2 SOUR @S2@',
      '3 PAGE p. 31',
      '1 SEX F',
      '1 FAMS @F1@',
    ]);
    expect(recordOf(lines, '0 @F1@ FAM')).toEqual([
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 MARR',
      '2 DATE 1895',
      '2 SOUR @S2@',
      '3 PAGE p. 30',
      '2 SOUR @S2@',
      '3 NOTE Also here',
      '1 SOUR @S2@',
      '2 PAGE p. 30',
      '1 SOUR @S1@',
    ]);

    // What was written reads back as the same sources and citations.
    const again = memoryTree();
    importText(again, `${lines.join('\n')}\n`);
    expect(citationsOf(again)).toEqual(citationsOf(tree));
    expect(listSources(again).map((source) => source.title)).toContain('Family bible');
  });

  it('leaves out a deleted source and every line that pointed at it', () => {
    const { tree, id } = imported();
    deleteSource(tree, id('S2'));
    const lines = exportLines(tree);
    expect(lines.filter((line) => line.includes('@S2@'))).toEqual([]);
    expect(recordOf(lines, '0 @F1@ FAM')).toEqual([
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 MARR',
      '2 DATE 1895',
    ]);
    // The note stays; only its line that cited the source goes.
    expect(lines).toContain('1 NOTE A note');
    expect(lines.filter((line) => line.includes('@S1@'))).toHaveLength(4);

    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(CITED_LINES))).toBeNull();
  });

  it('leaves out the citations of a deleted event, and has them again after undo', () => {
    const { tree, event } = imported();
    deleteEvent(tree, event('I1', 'birth'));
    expect(citationsOf(tree)).toEqual([
      '1900 United States Federal Census | Sheet 4B | name,person',
      'Parish register | p. 30 | event,family',
    ]);
    expect(exportLines(tree)).not.toContain('3 PAGE p. 12');
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(CITED_LINES))).toBeNull();
  });

  it('writes the sources of a tree that was never imported', () => {
    const tree = memoryTree();
    const personId = addPersonFromDraft(tree, {
      given: 'Ann',
      surname: 'Lee',
      birthDate: '1850',
    }).id;
    const birthId = listPersonEvents(tree, personId)[0]?.id ?? '';
    const citation = addCitation(
      tree,
      { type: 'event', id: birthId },
      { create: { title: 'Register' } },
      {
        page: 'p. 2',
      },
    );
    linkCitation(tree, citation.id, { type: 'person', id: personId });
    createSource(tree, { title: 'Not cited yet' });
    expect(bodyOf(exportLines(tree)).slice(1)).toEqual([
      '1 NAME Not recorded',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '2 GIVN Ann',
      '2 SURN Lee',
      '1 BIRT',
      '2 DATE 1850',
      '2 SOUR @S1@',
      '3 PAGE p. 2',
      '1 SOUR @S1@',
      '2 PAGE p. 2',
      '0 @S1@ SOUR',
      '1 TITL Register',
      '0 @S2@ SOUR',
      '1 TITL Not cited yet',
      '0 TRLR',
    ]);
  });

  it('keeps the same sources and citations when the file is written in the other version', () => {
    const { tree } = imported();
    const seven = exportLines(tree, { version: '7.0' });
    // A source described in place has no form in 7.0; it becomes a citation of no record.
    expect(seven).toContain('2 SOUR @VOID@');
    const again = memoryTree();
    importText(again, `${seven.join('\n')}\n`);
    expect(citationsOf(again)).toEqual(citationsOf(tree));
    expect(listSources(again).map((source) => source.title || source.abbreviation)).toEqual(
      listSources(tree).map((source) => source.title || source.abbreviation),
    );
  });

  it('writes sources and citations in GEDCOM 7.0 as well', () => {
    const text = file(
      '7.0',
      '0 @I1@ INDI',
      '1 NAME John /Hale/',
      '1 BIRT',
      '2 DATE 1870',
      '2 SOUR @S1@',
      '3 PAGE p. 12',
      '3 DATA',
      '4 TEXT John, son of Tom',
      '3 QUAY 2',
      '3 SNOTE @N1@',
      '0 @S1@ SOUR',
      '1 TITL Register',
      '0 @N1@ SNOTE A shared note',
    );
    const { tree, event } = imported(text);
    const original = text.split('\n').slice(0, -1);
    expect(
      firstDifference(bodyOf(exportLines(tree, { version: '7.0' })), bodyOf(original)),
    ).toBeNull();
    const birth = listCitations(tree, { type: 'event', id: event('I1', 'birth') })[0];
    updateCitation(tree, birth?.id ?? '', { quality: 3, note: 'Seen in person' });
    expect(recordOf(exportLines(tree, { version: '7.0' }), '0 @I1@ INDI')).toEqual([
      '0 @I1@ INDI',
      '1 NAME John /Hale/',
      '1 BIRT',
      '2 DATE 1870',
      '2 SOUR @S1@',
      '3 PAGE p. 12',
      '3 DATA',
      '4 TEXT John, son of Tom',
      '3 QUAY 3',
      '3 SNOTE @N1@',
      '3 NOTE Seen in person',
    ]);
  });
});

/** A tree as the app made them before sources had tables: schema version 3. */
function olderTree(location: string): Tree {
  const inMemory = location === ':memory:';
  const db = openDatabase(inMemory ? location : join(location, TREE_FILE_NAME));
  db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
  migrate(db, treeMigrations.slice(0, 3));
  db.prepare(
    "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
  ).run();
  return track(new Tree(db, inMemory ? null : location));
}

/** Everything about sources and citations that must not depend on how the rows were made. */
function sourcesModel(tree: Tree): unknown {
  const db = tree.db;
  const xref = (id: string | null) =>
    id === null
      ? null
      : ((db.prepare('SELECT xref FROM gedcom_record WHERE id = ?').pluck().get(id) as
          string | undefined) ?? '?');
  const said = (citationId: string) =>
    JSON.stringify(
      db
        .prepare(
          `SELECT s.title, s.abbreviation, c.page, c.text, c.quality, c.note
           FROM citation c JOIN source s ON s.id = c.source_id WHERE c.id = ?`,
        )
        .get(citationId),
    );
  interface LinkRow {
    citation_id: string;
    sort_order: number;
    person_id: string | null;
    family_id: string | null;
    event: string | null;
    event_owner: string | null;
    name: string | null;
    name_owner: string | null;
  }
  const links = (
    db
      .prepare(
        `SELECT cl.citation_id, cl.sort_order, cl.person_id, cl.family_id, e.type AS event,
                (SELECT coalesce(ep.person_id, ep.family_id) FROM event_participant ep
                 WHERE ep.event_id = cl.event_id LIMIT 1) AS event_owner,
                n.given AS name, n.person_id AS name_owner
         FROM citation_link cl LEFT JOIN event e ON e.id = cl.event_id
           LEFT JOIN person_name n ON n.id = cl.name_id`,
      )
      .all() as LinkRow[]
  )
    .map((row) =>
      JSON.stringify({
        citation: said(row.citation_id),
        order: row.sort_order,
        person: xref(row.person_id),
        family: xref(row.family_id),
        event: row.event,
        eventOwner: xref(row.event_owner),
        name: row.name,
        nameOwner: xref(row.name_owner),
      }),
    )
    .sort();
  return {
    sources: db
      .prepare(
        'SELECT title, author, publication, abbreviation, text FROM source ORDER BY title, abbreviation',
      )
      .all(),
    citations: db.prepare('SELECT count(*) FROM citation').pluck().get(),
    links,
    records: listStoredRecords(tree).map((record) => ({
      kind: record.kind,
      xref: record.xref,
      text: record.text,
      parts:
        record.parts?.map((part) => ({
          kind: part.k ?? null,
          text: part.t,
          citation: part.k === 'citation' && part.r !== undefined ? said(part.r) : null,
          cites: part.c?.map((id) => (id === null ? null : said(id))) ?? null,
        })) ?? null,
    })),
  };
}

describe('a tree imported before sources had tables', () => {
  it('holds its sources as lines kept as written', () => {
    const tree = olderTree(':memory:');
    const report = importGedcom(tree, inputOf(CITED), { sources: false });
    expect(schemaVersion(tree.db)).toBe(3);
    expect(report).toMatchObject({
      sources: 0,
      citations: 0,
      keptRecords: { SUBM: 1, SOUR: 2, REPO: 1 },
    });
    expect(report.keptLines).toBe(3);
  });

  it('is given the same sources and citations as a fresh import of the file', () => {
    for (const text of [CITED, ancestryStyleFile(60)]) {
      const older = olderTree(':memory:');
      importGedcom(older, inputOf(text), { sources: false });
      migrate(older.db, treeMigrations);
      expect(schemaVersion(older.db)).toBe(treeMigrations.length);

      const fresh = memoryTree();
      importText(fresh, text);
      expect(sourcesModel(older)).toEqual(sourcesModel(fresh));

      const original = text.split(/\r\n|\n/).slice(0, -1);
      expect(firstDifference(bodyOf(exportLines(older)), bodyOf(original))).toBeNull();
    }
  });

  it('can be edited like any other once upgraded', () => {
    const older = olderTree(':memory:');
    importGedcom(older, inputOf(CITED), { sources: false });
    migrate(older.db, treeMigrations);
    // Nothing was put in the change log by the upgrade.
    expect(older.undoStatus().undo).toBeNull();

    const id = (xref: string) =>
      older.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    const census = listPersonCitations(older, id('I1'))[0];
    expect(census).toMatchObject({ page: 'Sheet 4B' });
    expect(census?.uses.map((use) => use.type)).toEqual(['person', 'name', 'event']);
    updateCitation(older, census?.id ?? '', { page: 'Sheet 5A' });
    const expected = CITED_LINES.map((line) => line.replace('PAGE Sheet 4B', 'PAGE Sheet 5A'));
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(expected))).toBeNull();
    older.undo();
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(CITED_LINES))).toBeNull();
  });

  it('gives the citations of a merged record to the person who is left, and skips a deleted one', () => {
    const older = olderTree(':memory:');
    importGedcom(
      older,
      inputOf(
        file(
          '5.5.1',
          '0 @I1@ INDI',
          '1 NAME Ann /Lee/',
          '0 @I2@ INDI',
          '1 NAME Annie /Lee/',
          '2 SOUR @S1@',
          '3 PAGE 1',
          '1 SOUR @S1@',
          '2 PAGE 2',
          '0 @I3@ INDI',
          '1 NAME Tom /Lee/',
          '1 SOUR @S1@',
          '2 PAGE 3',
          '0 @S1@ SOUR',
          '1 TITL Register',
        ),
      ),
      { sources: false },
    );
    const id = (xref: string) =>
      older.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;
    // What a merge of the second record into the first did at that version.
    older.transact('Merge people', () => {
      older.db
        .prepare(
          'UPDATE person_name SET person_id = ?, is_primary = 0, sort_order = 1 WHERE person_id = ?',
        )
        .run(id('I1'), id('I2'));
      older.db
        .prepare(
          "INSERT INTO merged_record (id, kind, into_id, merged_at) VALUES (?, 'person', ?, 1)",
        )
        .run(id('I2'), id('I1'));
      older.db.prepare('DELETE FROM person WHERE id = ?').run(id('I2'));
    });
    older.transact('Delete person', () => {
      older.db.prepare('DELETE FROM person WHERE id = ?').run(id('I3'));
    });

    migrate(older.db, treeMigrations);
    expect(citationsOf(older)).toEqual(['Register | 1 | name', 'Register | 2 | person']);
    expect(listPersonCitations(older, id('I1')).map((citation) => citation.page)).toEqual([
      '2',
      '1',
    ]);
    expect(recordOf(exportLines(older), '0 @I1@ INDI')).toEqual([
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 NAME Annie /Lee/',
      '2 SOUR @S1@',
      '3 PAGE 1',
      '1 SOUR @S1@',
      '2 PAGE 2',
    ]);

    // The deleted person comes back with the lines they had, kept as written.
    older.undo();
    expect(recordOf(exportLines(older), '0 @I3@ INDI')).toEqual([
      '0 @I3@ INDI',
      '1 NAME Tom /Lee/',
      '1 SOUR @S1@',
      '2 PAGE 3',
    ]);
    expect(citationsOf(older)).toHaveLength(2);
  });

  it('is copied to its backups folder before it is upgraded', () => {
    const dir = tempDir();
    const older = olderTree(dir);
    importGedcom(older, inputOf(CITED), { sources: false });
    older.close();
    expect(listBackups(dir)).toEqual([]);

    const tree = track(openExistingTree(dir));
    expect(tree.info().schemaVersion).toBe(treeMigrations.length);
    expect(tree.info().sources).toBe(2);

    const backups = listBackups(dir);
    expect(backups).toHaveLength(1);
    const copy = openDatabase(join(dir, BACKUP_DIR_NAME, backups[0]?.name ?? ''));
    try {
      expect(schemaVersion(copy)).toBe(3);
      // The submitter, the repository and the two sources, still as lines kept as written.
      const kept = copy.prepare("SELECT count(*) FROM gedcom_record WHERE kind = 'kept'");
      expect(kept.pluck().get()).toBe(4);
    } finally {
      copy.close();
    }

    // Opening it again changes nothing more.
    tree.close();
    const again = track(openExistingTree(dir));
    expect(listBackups(dir)).toHaveLength(1);
    expect(citationsOf(again)).toHaveLength(3);
  });

  it('is left alone when it was never imported', () => {
    const older = olderTree(':memory:');
    migrate(older.db, treeMigrations);
    expect(older.info()).toMatchObject({ schemaVersion: treeMigrations.length, sources: 0 });
    expect(createSource(older, { title: 'First' }).title).toBe('First');
  });
});
