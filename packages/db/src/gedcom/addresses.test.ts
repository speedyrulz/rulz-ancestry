import { describe, expect, it } from 'vitest';
import { openDatabase } from '../connection';
import { migrate, schemaVersion } from '../migrate';
import { treeMigrations } from '../schema';
import { addCitation, deleteCitation, listPersonCitations, updateCitation } from '../sources';
import { cleanUpAfterEach, memoryTree, track } from '../testing';
import { TREE_APPLICATION_ID, Tree } from '../tree';
import { importGedcom } from './import';
import { bodyOf, exportLines, file, firstDifference, importText, inputOf } from './testing';

cleanUpAfterEach();

/**
 * A census entry with the address of its record, as Ancestry writes it, cited
 * for a name, a birth and the person as a whole; a second entry that differs
 * in its address only; and a citation without one. The addresses are made up.
 */
const LINKED = file(
  '5.5.1',
  '0 @U1@ SUBM',
  '1 NAME A tester',
  '0 @I1@ INDI',
  '1 NAME John /Hale/',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 DATA',
  '4 WWW https://records.example/view?dbid=7602&pid=11',
  '3 _APID 1,7602::11',
  '1 BIRT',
  '2 DATE 1870',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 DATA',
  '4 WWW https://records.example/view?dbid=7602&pid=11',
  '3 _APID 1,7602::11',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 DATA',
  '4 WWW https://records.example/view?dbid=7602&pid=12',
  '3 _APID 1,7602::11',
  '1 SOUR @S1@',
  '2 PAGE Sheet 4B',
  '2 DATA',
  '3 WWW https://records.example/view?dbid=7602&pid=11',
  '2 _APID 1,7602::11',
  '1 SOUR @S1@',
  '2 PAGE Sheet 9',
  '0 @S1@ SOUR',
  '1 TITL 1900 Census',
);
const LINKED_LINES = LINKED.split('\n').slice(0, -1);
const FIRST = 'https://records.example/view?dbid=7602&pid=11';
const SECOND = 'https://records.example/view?dbid=7602&pid=12';

const idOf = (tree: Tree, xref: string) =>
  tree.db.prepare('SELECT id FROM gedcom_record WHERE xref = ?').pluck().get(xref) as string;

/** The citations of the one person, as [place in the source, address, day, how many facts]. */
function cited(tree: Tree): unknown {
  return listPersonCitations(tree, idOf(tree, 'I1'))
    .map((citation) => [citation.page, citation.url, citation.accessedAt, citation.uses.length])
    .sort();
}

describe('the web address of a citation in a GEDCOM file', () => {
  it('is read from the line Ancestry writes', () => {
    const tree = memoryTree();
    importText(tree, LINKED);
    expect(cited(tree)).toEqual([
      ['Sheet 4B', FIRST, '', 3],
      ['Sheet 4B', SECOND, '', 1],
      ['Sheet 9', '', '', 1],
    ]);
  });

  it('is written back line for line when nothing has changed', () => {
    const tree = memoryTree();
    importText(tree, LINKED);
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(LINKED_LINES))).toBeNull();
  });

  it('changes one line in every place the citation stands, and undo puts it back', () => {
    const tree = memoryTree();
    importText(tree, LINKED);
    const first = listPersonCitations(tree, idOf(tree, 'I1')).find((entry) => entry.url === FIRST);
    updateCitation(tree, first?.id ?? '', {
      url: 'https://records.example/new',
      accessedAt: '2026-11-13',
    });
    const lines = bodyOf(exportLines(tree));
    expect(lines.filter((line) => line.endsWith('WWW https://records.example/new'))).toHaveLength(
      3,
    );
    expect(lines.filter((line) => line.endsWith('_RULZ_ACCESSED 13 NOV 2026'))).toHaveLength(3);
    expect(lines.filter((line) => line.endsWith(`WWW ${SECOND}`))).toHaveLength(1);
    // Nothing else of the file has changed.
    expect(
      lines.filter((line) => !line.includes('records.example') && !line.includes('_RULZ_ACCESSED')),
    ).toEqual(bodyOf(LINKED_LINES).filter((line) => !line.includes('records.example')));
    tree.undo();
    expect(firstDifference(bodyOf(exportLines(tree)), bodyOf(LINKED_LINES))).toBeNull();
  });

  it('takes the line away when the address is emptied', () => {
    const tree = memoryTree();
    importText(tree, LINKED);
    const second = listPersonCitations(tree, idOf(tree, 'I1')).find(
      (entry) => entry.url === SECOND,
    );
    updateCitation(tree, second?.id ?? '', { url: '' });
    const text = exportLines(tree).join('\n');
    expect(text).not.toContain(SECOND);
    expect(text).toContain(FIRST);
  });

  it.each(['5.5.1', '7.0'] as const)(
    'comes back from a file the app wrote in GEDCOM %s, with the day it was consulted',
    (version) => {
      const tree = memoryTree();
      importText(tree, LINKED);
      addCitation(
        tree,
        { type: 'person', id: idOf(tree, 'I1') },
        { create: { title: 'A site' } },
        { page: 'Profile 7', url: 'https://site.example/p/7?a=1&b=2', accessedAt: '2026-11-13' },
      );
      const written = exportLines(tree, { version }).join('\n') + '\n';
      expect(written).toContain(
        version === '7.0'
          ? '_WWW https://site.example/p/7?a=1&b=2'
          : ' WWW https://site.example/p/7?a=1&b=2',
      );
      const again = memoryTree();
      importText(again, written);
      const read = listPersonCitations(
        again,
        again.db.prepare('SELECT id FROM person LIMIT 1').pluck().get() as string,
      )
        .map((citation) => [citation.page, citation.url, citation.accessedAt])
        .sort();
      expect(read).toEqual([
        ['Profile 7', 'https://site.example/p/7?a=1&b=2', '2026-11-13'],
        ['Sheet 4B', FIRST, ''],
        ['Sheet 4B', SECOND, ''],
        ['Sheet 9', '', ''],
      ]);
    },
  );
});

/** A tree as the app made them before a citation had an address: schema version 8. */
function olderTree(): Tree {
  const db = openDatabase(':memory:');
  db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
  migrate(db, treeMigrations.slice(0, 8));
  db.prepare(
    "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
  ).run();
  return track(new Tree(db, null));
}

describe('a tree imported before a citation had a web address', () => {
  it('is given the same addresses as a fresh import of the file', () => {
    const older = olderTree();
    importGedcom(older, inputOf(LINKED), { addresses: false });
    expect(schemaVersion(older.db)).toBe(8);
    migrate(older.db, treeMigrations);
    expect(schemaVersion(older.db)).toBe(treeMigrations.length);

    const fresh = memoryTree();
    importText(fresh, LINKED);
    expect(cited(older)).toEqual(cited(fresh));
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(LINKED_LINES))).toBeNull();
    // The upgrade is not an edit.
    expect(older.undoStatus().undo).toBeNull();
  });

  it('reads tags written in small letters as a fresh import does', () => {
    const small = LINKED.replaceAll(' WWW ', ' www ');
    const older = olderTree();
    importGedcom(older, inputOf(small), { addresses: false });
    migrate(older.db, treeMigrations);
    const fresh = memoryTree();
    importText(fresh, small);
    expect(cited(older)).toEqual(cited(fresh));
    expect(cited(older)).toContainEqual(['Sheet 4B', FIRST, '', 3]);
    expect(exportLines(older).join('\n')).toContain(FIRST);
  });

  it('gives its address back to a citation that undo brings back', () => {
    const older = olderTree();
    importGedcom(older, inputOf(LINKED), { addresses: false });
    // Before the upgrade: the citation of the second record is deleted.
    const second = older.db
      .prepare(
        `SELECT c.id FROM citation c WHERE (SELECT count(*) FROM citation_link l
           WHERE l.citation_id = c.id) = 1 AND c.page = 'Sheet 4B'`,
      )
      .pluck()
      .get() as string;
    older.transact('Delete citation', () => {
      older.db.prepare('DELETE FROM citation WHERE id = ?').run(second);
    });
    migrate(older.db, treeMigrations);
    expect(exportLines(older).join('\n')).not.toContain(SECOND);

    older.undo();
    expect(cited(older)).toContainEqual(['Sheet 4B', SECOND, '', 1]);
    expect(firstDifference(bodyOf(exportLines(older)), bodyOf(LINKED_LINES))).toBeNull();
  });

  it('leaves alone a tree that was never imported, and one whose citation has gone', () => {
    const empty = olderTree();
    migrate(empty.db, treeMigrations);
    expect(schemaVersion(empty.db)).toBe(treeMigrations.length);

    const older = olderTree();
    importGedcom(older, inputOf(LINKED), { addresses: false });
    migrate(older.db, treeMigrations);
    const first = listPersonCitations(older, idOf(older, 'I1')).find(
      (entry) => entry.url === FIRST,
    );
    deleteCitation(older, first?.id ?? '');
    expect(exportLines(older).join('\n')).not.toContain(FIRST);
  });
});
