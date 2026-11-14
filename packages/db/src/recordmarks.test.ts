import { describe, expect, it } from 'vitest';
import { backupTree, restoreBackup, treeStateToken } from './backup';
import { openDatabase } from './connection';
import { bodyOf, exportLines } from './gedcom/testing';
import { mergePersons } from './merge';
import { migrate, schemaVersion } from './migrate';
import { createPerson, deletePerson } from './persons';
import {
  RECORD_MARK_JSON_MAX,
  RECORD_MARK_LIMIT,
  countRecordMarks,
  declineRecord,
  getRecordMark,
  keepRecord,
  listRecordMarks,
  recordMarkStates,
  removeRecordMark,
  type RecordMarkInput,
} from './recordmarks';
import { treeMigrations } from './schema';
import { cleanUpAfterEach, memoryTree, snapshot, tempDir, track, undoDepth } from './testing';
import { TREE_APPLICATION_ID, Tree, TreeRuleError, createTree, openExistingTree } from './tree';

cleanUpAfterEach();

/** A result of a search of a site that does not exist, as whoever keeps it hands it in. */
const result = (key: string, extra: Partial<RecordMarkInput> = {}): RecordMarkInput => ({
  sourceId: 'example-site',
  key,
  title: `Record ${key}`,
  url: `https://records.example/${key}`,
  recordJson: JSON.stringify({ key, said: 'something' }),
  readAt: 1000,
  markedAt: 2000,
  ...extra,
});

function start() {
  const tree = memoryTree();
  const ada = createPerson(tree, { name: { given: 'Ada', surname: 'Hale' } }).id;
  const mary = createPerson(tree, { name: { given: 'Mary', surname: 'Hale' } }).id;
  return { tree, ada, mary };
}

describe('a result of a search kept for a person', () => {
  it('is kept with the record as it was read, as one step that can be undone', () => {
    const { tree, ada } = start();
    const steps = undoDepth(tree);
    const before = snapshot(tree);

    const mark = keepRecord(tree, ada, result('R-1'));
    expect(mark).toEqual({
      id: expect.any(String),
      personId: ada,
      sourceId: 'example-site',
      key: 'R-1',
      state: 'kept',
      title: 'Record R-1',
      url: 'https://records.example/R-1',
      recordJson: '{"key":"R-1","said":"something"}',
      readAt: 1000,
      markedAt: 2000,
    });
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')).toEqual(mark);
    expect(undoDepth(tree)).toBe(steps + 1);
    expect(tree.undoStatus().undo?.label).toBe('Keep a record for later');

    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(countRecordMarks(tree)).toBe(0);
    tree.redo();
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')).toEqual(mark);
  });

  it('is kept once: keeping it again writes it as it is read now', () => {
    const { tree, ada } = start();
    const first = keepRecord(tree, ada, result('R-1'));
    const second = keepRecord(
      tree,
      ada,
      result('R-1', { recordJson: '{"said":"more"}', readAt: 5000, markedAt: 6000 }),
    );
    expect(second).toMatchObject({
      id: first.id,
      recordJson: '{"said":"more"}',
      readAt: 5000,
      markedAt: 6000,
    });
    expect(countRecordMarks(tree)).toBe(1);
  });

  it('is for one person: the same result may be kept for another, or turned down for them', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, ada, result('R-1'));
    expect(getRecordMark(tree, mary, 'example-site', 'R-1')).toBeNull();
    declineRecord(tree, mary, result('R-1'));
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')?.state).toBe('kept');
    expect(getRecordMark(tree, mary, 'example-site', 'R-1')?.state).toBe('declined');
    // And a result of the same name at another source is another result.
    expect(getRecordMark(tree, ada, 'other-site', 'R-1')).toBeNull();
  });

  it('is refused when the record is too long, and for a person who is not in the tree', () => {
    const { tree, ada } = start();
    expect(() =>
      keepRecord(tree, ada, result('R-1', { recordJson: 'x'.repeat(RECORD_MARK_JSON_MAX + 1) })),
    ).toThrow(TreeRuleError);
    expect(() => keepRecord(tree, '00000000-0000-4000-8000-000000000000', result('R-1'))).toThrow(
      /not found/,
    );
    expect(countRecordMarks(tree)).toBe(0);
    // As long as the tree keeps it is kept.
    keepRecord(tree, ada, result('R-1', { recordJson: 'x'.repeat(RECORD_MARK_JSON_MAX) }));
    expect(countRecordMarks(tree)).toBe(1);
  });

  it('keeps no record at all where there is none to keep, as for a source that bars it', () => {
    const { tree, ada } = start();
    const mark = keepRecord(tree, ada, result('R-1', { title: '', recordJson: null }));
    expect(mark).toMatchObject({ state: 'kept', title: '', recordJson: null });
  });
});

describe('a result turned down for a person', () => {
  it('holds its title and address, and nothing of the record', () => {
    const { tree, ada } = start();
    const mark = declineRecord(tree, ada, result('R-1'));
    expect(mark).toMatchObject({
      state: 'declined',
      title: 'Record R-1',
      url: 'https://records.example/R-1',
      recordJson: null,
    });
    expect(tree.undoStatus().undo?.label).toBe('Turn a record down');
  });

  it('loses what was kept of it, and gets it back when the turning-down is undone', () => {
    const { tree, ada } = start();
    const kept = keepRecord(tree, ada, result('R-1'));
    const declined = declineRecord(tree, ada, result('R-1', { markedAt: 3000 }));
    expect(declined).toMatchObject({
      id: kept.id,
      state: 'declined',
      recordJson: null,
      markedAt: 3000,
    });
    tree.undo();
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')).toEqual(kept);
  });

  it('can be kept after all', () => {
    const { tree, ada } = start();
    declineRecord(tree, ada, result('R-1'));
    expect(keepRecord(tree, ada, result('R-1'))).toMatchObject({
      state: 'kept',
      recordJson: '{"key":"R-1","said":"something"}',
    });
    expect(countRecordMarks(tree)).toBe(1);
  });
});

describe('taking a mark away', () => {
  it('says what the mark was, and can be undone', () => {
    const { tree, ada } = start();
    const kept = keepRecord(tree, ada, result('R-1'));
    declineRecord(tree, ada, result('R-2'));

    expect(removeRecordMark(tree, ada, 'example-site', 'R-1')).toBe('kept');
    expect(tree.undoStatus().undo?.label).toBe('Remove a kept record');
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')).toBeNull();
    tree.undo();
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')).toEqual(kept);

    expect(removeRecordMark(tree, ada, 'example-site', 'R-2')).toBe('declined');
    expect(tree.undoStatus().undo?.label).toBe('Allow a record again');
  });

  it('does nothing, and leaves no step, where there is no mark', () => {
    const { tree, ada } = start();
    const steps = undoDepth(tree);
    expect(removeRecordMark(tree, ada, 'example-site', 'R-1')).toBeNull();
    expect(undoDepth(tree)).toBe(steps);
  });
});

describe('the marks of a tree', () => {
  it('are listed by kind, the latest first, for everyone or for one person', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, ada, result('R-1', { markedAt: 100 }));
    keepRecord(tree, mary, result('R-2', { markedAt: 300 }));
    keepRecord(tree, ada, result('R-3', { markedAt: 200 }));
    declineRecord(tree, ada, result('R-4', { markedAt: 400 }));
    const keys = (page: Parameters<typeof listRecordMarks>[1]) =>
      listRecordMarks(tree, page).map((mark) => mark.key);

    expect(keys({ state: 'kept', offset: 0, limit: 10 })).toEqual(['R-2', 'R-3', 'R-1']);
    expect(keys({ state: 'kept', personId: ada, offset: 0, limit: 10 })).toEqual(['R-3', 'R-1']);
    expect(keys({ state: 'kept', offset: 1, limit: 1 })).toEqual(['R-3']);
    expect(keys({ state: 'declined', offset: 0, limit: 10 })).toEqual(['R-4']);
    expect(keys({ state: 'declined', personId: mary, offset: 0, limit: 10 })).toEqual([]);

    expect(countRecordMarks(tree)).toBe(4);
    expect(countRecordMarks(tree, 'kept')).toBe(3);
    expect(countRecordMarks(tree, 'kept', ada)).toBe(2);
    expect(countRecordMarks(tree, 'declined', mary)).toBe(0);
  });

  it('are found for the results of one source and one person', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, ada, result('R-1'));
    declineRecord(tree, ada, result('R-2'));
    keepRecord(tree, ada, result('R-3', { sourceId: 'other-site' }));
    declineRecord(tree, mary, result('R-1'));
    expect([...recordMarkStates(tree, ada, 'example-site')].sort()).toEqual([
      ['R-1', 'kept'],
      ['R-2', 'declined'],
    ]);
    expect([...recordMarkStates(tree, mary, 'example-site')]).toEqual([['R-1', 'declined']]);
  });

  it('are no more than the tree takes', () => {
    const { tree, ada } = start();
    // Filled as a load fills a tree: five thousand steps would take long, and prove nothing more.
    tree.db.exec("UPDATE change_state SET mode = 'replay'");
    const insert = tree.db.prepare(
      `INSERT INTO record_mark (id, person_id, source_id, record_key, state, read_at, marked_at)
       VALUES (?, ?, 'example-site', ?, 'declined', 0, 0)`,
    );
    for (let index = 0; index < RECORD_MARK_LIMIT; index += 1) {
      insert.run(`id-${index}`, ada, `K-${index}`);
    }
    tree.db.exec("UPDATE change_state SET mode = 'idle'");

    expect(() => keepRecord(tree, ada, result('R-1'))).toThrow(TreeRuleError);
    expect(() => declineRecord(tree, ada, result('R-1'))).toThrow(/at most/);
    // One that has a mark already can still be kept: no row is added.
    expect(keepRecord(tree, ada, result('K-7')).state).toBe('kept');
    expect(countRecordMarks(tree)).toBe(RECORD_MARK_LIMIT);
  });

  it('cannot be written outside a step of the tree', () => {
    const { tree, ada } = start();
    expect(() =>
      tree.db
        .prepare(
          `INSERT INTO record_mark (id, person_id, source_id, record_key, state, read_at, marked_at)
           VALUES ('x', ?, 's', 'k', 'kept', 0, 0)`,
        )
        .run(ada),
    ).toThrow(/change transaction/);
  });
});

describe('marks and the people they are for', () => {
  it('go with a person who is deleted, and come back when that is undone', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, ada, result('R-1'));
    declineRecord(tree, ada, result('R-2'));
    keepRecord(tree, mary, result('R-3'));
    const before = snapshot(tree);

    deletePerson(tree, ada);
    expect(countRecordMarks(tree)).toBe(1);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('move to the person who stays when two are merged, and back when that is undone', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, mary, result('R-1'));
    declineRecord(tree, mary, result('R-2'));
    // Both have a mark of these: that of the person who stays counts.
    keepRecord(tree, ada, result('R-3', { title: 'As Ada has it' }));
    keepRecord(tree, mary, result('R-3', { title: 'As Mary has it' }));
    keepRecord(tree, ada, result('R-4'));
    declineRecord(tree, mary, result('R-4'));
    declineRecord(tree, ada, result('R-5', { title: 'As Ada has it' }));
    declineRecord(tree, mary, result('R-5', { title: 'As Mary has it' }));
    // But what was kept for the one who goes is not lost to a turning-down.
    declineRecord(tree, ada, result('R-6'));
    keepRecord(tree, mary, result('R-6', { title: 'As Mary has it' }));
    const before = snapshot(tree);

    mergePersons(tree, ada, mary);
    expect([...recordMarkStates(tree, ada, 'example-site')].sort()).toEqual([
      ['R-1', 'kept'],
      ['R-2', 'declined'],
      ['R-3', 'kept'],
      ['R-4', 'kept'],
      ['R-5', 'declined'],
      ['R-6', 'kept'],
    ]);
    expect(countRecordMarks(tree)).toBe(6);
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')?.recordJson).toBe(
      '{"key":"R-1","said":"something"}',
    );
    expect(getRecordMark(tree, ada, 'example-site', 'R-3')?.title).toBe('As Ada has it');
    expect(getRecordMark(tree, ada, 'example-site', 'R-5')?.title).toBe('As Ada has it');
    expect(getRecordMark(tree, ada, 'example-site', 'R-6')).toMatchObject({
      title: 'As Mary has it',
      recordJson: '{"key":"R-6","said":"something"}',
    });

    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });
});

describe('marks and what leaves the tree', () => {
  it('are not written to a GEDCOM file', () => {
    const { tree, ada } = start();
    const before = bodyOf(exportLines(tree));
    keepRecord(tree, ada, result('R-1'));
    declineRecord(tree, ada, result('R-2'));
    const after = bodyOf(exportLines(tree));
    expect(after).toEqual(before);
    expect(after.join('\n')).not.toContain('R-1');
  });

  it('are a change of the tree: a backup is made for them, and brings them back', () => {
    const dir = `${tempDir()}/Family`;
    const tree = track(createTree(dir, { name: 'Family' }));
    const ada = createPerson(tree, { name: { given: 'Ada', surname: 'Hale' } }).id;
    expect(backupTree(tree, { now: 1_000_000 }).created).not.toBeNull();
    const token = treeStateToken(tree.db);

    keepRecord(tree, ada, result('R-1'));
    expect(treeStateToken(tree.db)).not.toBe(token);
    const backup = backupTree(tree, { now: 2_000_000 }).created;
    expect(backup).not.toBeNull();

    removeRecordMark(tree, ada, 'example-site', 'R-1');
    tree.close();
    restoreBackup(dir, backup?.name ?? '');
    const restored = track(openExistingTree(dir));
    expect(getRecordMark(restored, ada, 'example-site', 'R-1')).toMatchObject({ state: 'kept' });
  });
});

describe('a tree made before results could be kept', () => {
  it('gains the table, empty, and can keep results at once', () => {
    const db = openDatabase(':memory:');
    db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
    migrate(db, treeMigrations.slice(0, 9));
    db.prepare(
      "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
    ).run();
    const older = track(new Tree(db, null));
    expect(schemaVersion(older.db)).toBe(9);

    migrate(older.db, treeMigrations);
    expect(schemaVersion(older.db)).toBe(treeMigrations.length);
    // The upgrade is not an edit.
    expect(undoDepth(older)).toBe(0);
    expect(countRecordMarks(older)).toBe(0);
    const ada = createPerson(older, { name: { given: 'Ada', surname: 'Hale' } }).id;
    expect(keepRecord(older, ada, result('R-1')).state).toBe('kept');
  });
});
