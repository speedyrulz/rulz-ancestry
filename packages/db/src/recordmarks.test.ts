import { describe, expect, it } from 'vitest';
import { backupTree, restoreBackup, treeStateToken } from './backup';
import { openDatabase } from './connection';
import { bodyOf, exportLines } from './gedcom/testing';
import { mergePersons } from './merge';
import { migrate, schemaVersion } from './migrate';
import { createPerson, deletePerson } from './persons';
import {
  RECORD_MARK_AI_JSON_MAX,
  RECORD_MARK_JSON_MAX,
  RECORD_MARK_LIMIT,
  countRecordMarks,
  declineRecord,
  getRecordMark,
  keepRecord,
  listRecordMarks,
  recordMarkStates,
  recordMarkStatesFor,
  recordPartOf,
  removeRecordMark,
  type RecordMarkInput,
} from './recordmarks';
import { treeMigrations } from './schema';
import {
  cleanUpAfterEach,
  memoryTree,
  snapshot,
  tempDir,
  track,
  undoDepth,
  withLaterColumns,
} from './testing';
import { TREE_APPLICATION_ID, Tree, TreeRuleError, createTree, openExistingTree } from './tree';

cleanUpAfterEach();

describe('Open Archives forms of a record', () => {
  const oa = (key: string, extra: Partial<RecordMarkInput> = {}) =>
    result(key, { sourceId: 'open-archives', ...extra });
  const live = 'zz:123/person1';
  const pack = 'zz:123/_BRIDE';

  it('recognizes only valid forms and carries marks in either direction for one person', () => {
    const { tree, ada, mary } = start();
    expect(recordPartOf('open-archives', live)).toBe('zz:123');
    expect(recordPartOf('open-archives', 'zz:123/_bad')).toBe('zz:123/_bad');
    expect(recordPartOf('example-site', live)).toBe(live);
    keepRecord(tree, ada, oa(live));
    expect(getRecordMark(tree, ada, 'open-archives', pack)?.state).toBe('kept');
    expect(getRecordMark(tree, mary, 'open-archives', pack)).toBeNull();
    declineRecord(tree, mary, oa(pack));
    expect(getRecordMark(tree, mary, 'open-archives', live)?.state).toBe('declined');
    expect(getRecordMark(tree, mary, 'example-site', live)).toBeNull();
  });

  it('rewrites a single other form in one undoable step and unmarks across forms', () => {
    const { tree, ada } = start();
    const first = keepRecord(tree, ada, oa(live));
    const before = snapshot(tree);
    const next = declineRecord(tree, ada, oa(pack, { title: 'New title', readAt: 42 }));
    expect(next).toMatchObject({
      id: first.id,
      key: pack,
      state: 'declined',
      title: 'New title',
      readAt: 42,
      recordJson: null,
    });
    expect(countRecordMarks(tree)).toBe(1);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(removeRecordMark(tree, ada, 'open-archives', pack)).toBe('kept');
    expect(countRecordMarks(tree)).toBe(0);
  });

  it('allows a single other-form rewrite at the mark limit', () => {
    const { tree, ada } = start();
    keepRecord(tree, ada, oa(live));
    tree.db.exec("UPDATE change_state SET mode = 'replay'");
    const insert = tree.db
      .prepare(`INSERT INTO record_mark (id, person_id, source_id, record_key, state, read_at, marked_at)
      VALUES (?, ?, 'example-site', ?, 'declined', 0, 0)`);
    for (let index = 1; index < RECORD_MARK_LIMIT; index += 1)
      insert.run(`fill-${index}`, ada, `fill-${index}`);
    tree.db.exec("UPDATE change_state SET mode = 'idle'");
    expect(declineRecord(tree, ada, oa(pack)).key).toBe(pack);
    expect(countRecordMarks(tree)).toBe(RECORD_MARK_LIMIT);
  });

  it('prefers exact marks, otherwise kept wins, and multiple other marks are not rewritten', () => {
    const { tree, ada } = start();
    declineRecord(tree, ada, oa(live));
    keepRecord(tree, ada, oa('zz:123/person2'));
    expect(getRecordMark(tree, ada, 'open-archives', pack)?.state).toBe('kept');
    declineRecord(tree, ada, oa(pack));
    expect(countRecordMarks(tree)).toBe(3);
    expect(getRecordMark(tree, ada, 'open-archives', pack)?.state).toBe('declined');
    expect(getRecordMark(tree, ada, 'open-archives', live)?.state).toBe('declined');
  });

  it('merges across forms without losing a mark, and restores the original marks on undo', () => {
    const { tree, ada, mary } = start();
    declineRecord(tree, ada, oa(pack));
    keepRecord(tree, mary, oa(live));
    const before = snapshot(tree);
    mergePersons(tree, ada, mary);
    // Different keys do not clash: the marks sit side by side, each exact for its own key.
    expect(countRecordMarks(tree)).toBe(2);
    expect(getRecordMark(tree, ada, 'open-archives', pack)?.state).toBe('declined');
    expect(getRecordMark(tree, ada, 'open-archives', live)?.state).toBe('kept');
    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('keeps a live and a pack mark of one record that the merged person holds', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, mary, oa('zz:123/person2'));
    declineRecord(tree, mary, oa(live));
    // With two live marks the pack mark is written beside them, not over one.
    keepRecord(tree, mary, oa(pack));
    expect(countRecordMarks(tree)).toBe(3);
    mergePersons(tree, ada, mary);
    expect(countRecordMarks(tree)).toBe(3);
    expect([...recordMarkStates(tree, ada, 'open-archives')].sort()).toEqual([
      [pack, 'kept'],
      [live, 'declined'],
      ['zz:123/person2', 'kept'],
    ]);
  });

  it('keeps several live turn-downs beside an incoming kept pack mark', () => {
    const { tree, ada, mary } = start();
    declineRecord(tree, ada, oa('zz:123/person1'));
    declineRecord(tree, ada, oa('zz:123/person2'));
    keepRecord(tree, mary, oa(pack));
    mergePersons(tree, ada, mary);
    expect(countRecordMarks(tree)).toBe(3);
    expect(getRecordMark(tree, ada, 'open-archives', pack)?.state).toBe('kept');
    expect(getRecordMark(tree, ada, 'open-archives', 'zz:123/person1')?.state).toBe('declined');
    expect(getRecordMark(tree, ada, 'open-archives', 'zz:123/person2')?.state).toBe('declined');
  });

  it('answers a batch of keys as getRecordMark does', () => {
    const { tree, ada } = start();
    declineRecord(tree, ada, oa('zz:1/person1'));
    keepRecord(tree, ada, oa('zz:1/person2'));
    keepRecord(tree, ada, oa('zz:2/person1'));
    declineRecord(tree, ada, oa('zz:2/_BRIDE'));
    declineRecord(tree, ada, oa('zz:3/person1'));
    keepRecord(tree, ada, result('plain'));
    const keys = [
      'zz:1/_BRIDE', // other form, kept wins
      'zz:2/person1', // exact first
      'zz:2/_BRIDE',
      'zz:3/_GROOM', // other form, declined
      'zz:4/_BRIDE', // nothing
      'zz:1/person9', // same form, not the other one
      'plain',
    ];
    const batch = recordMarkStatesFor(tree, ada, 'open-archives', keys);
    for (const key of keys) {
      expect(batch.get(key) ?? null).toBe(
        getRecordMark(tree, ada, 'open-archives', key)?.state ?? null,
      );
    }
    expect(batch.get('zz:1/_BRIDE')).toBe('kept');
    expect(batch.get('zz:3/_GROOM')).toBe('declined');
    // Another source: exact key only, and a person with no marks has none.
    const other = recordMarkStatesFor(tree, ada, 'example-site', ['plain', 'zz:1/_BRIDE']);
    expect([...other]).toEqual([['plain', 'kept']]);
    expect(recordMarkStatesFor(tree, start().ada, 'open-archives', keys).size).toBe(0);
  });

  it('unmarks a pack result shown as marked by two live marks, in one undoable step', () => {
    const { tree, ada } = start();
    declineRecord(tree, ada, oa('zz:123/person1'));
    keepRecord(tree, ada, oa('zz:123/person2'));
    const before = snapshot(tree);
    const steps = undoDepth(tree);
    expect(removeRecordMark(tree, ada, 'open-archives', pack)).toBe('kept');
    expect(countRecordMarks(tree)).toBe(0);
    expect(undoDepth(tree)).toBe(steps + 1);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(countRecordMarks(tree)).toBe(2);
  });
});

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
      aiJson: null,
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

describe('what an AI said of a kept result', () => {
  /** What whoever keeps a proposed record hands in: this module does not look inside. */
  const said = JSON.stringify({ v: 1, verdict: 'fits', reasons: [{ quote: 'something' }] });

  it('is kept with the record in the same step, and goes and comes back with it', () => {
    const { tree, ada } = start();
    const before = snapshot(tree);
    const steps = undoDepth(tree);

    const mark = keepRecord(tree, ada, result('R-1', { aiJson: said }));
    expect(mark.aiJson).toBe(said);
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')?.aiJson).toBe(said);
    expect(listRecordMarks(tree, { state: 'kept', offset: 0, limit: 10 })[0]?.aiJson).toBe(said);
    expect(undoDepth(tree)).toBe(steps + 1);

    tree.undo();
    expect(snapshot(tree)).toBe(before);
    tree.redo();
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')?.aiJson).toBe(said);
  });

  it('does not stay beside another reading: keeping the result again without it takes it away', () => {
    const { tree, ada } = start();
    keepRecord(tree, ada, result('R-1', { aiJson: said }));

    const again = keepRecord(tree, ada, result('R-1', { recordJson: '{"said":"otherwise"}' }));
    expect(again).toMatchObject({ recordJson: '{"said":"otherwise"}', aiJson: null });

    tree.undo();
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')?.aiJson).toBe(said);
  });

  it('does not stay with a result that is turned down, and is not written for one', () => {
    const { tree, ada } = start();
    keepRecord(tree, ada, result('R-1', { aiJson: said }));
    expect(declineRecord(tree, ada, result('R-1')).aiJson).toBeNull();
    expect(declineRecord(tree, ada, result('R-2', { aiJson: said })).aiJson).toBeNull();
    // The file itself refuses it for a result that is not kept.
    expect(() =>
      tree.transact('By hand', () =>
        tree.db.prepare("UPDATE record_mark SET ai_json = '{}' WHERE record_key = 'R-2'").run(),
      ),
    ).toThrow(/CHECK/);
  });

  it('is refused when it is too long, and nothing is kept then', () => {
    const { tree, ada } = start();
    const long = 'x'.repeat(RECORD_MARK_AI_JSON_MAX + 1);
    expect(() => keepRecord(tree, ada, result('R-1', { aiJson: long }))).toThrow(TreeRuleError);
    expect(countRecordMarks(tree)).toBe(0);
    expect(keepRecord(tree, ada, result('R-1', { aiJson: long.slice(1) })).aiJson).toHaveLength(
      RECORD_MARK_AI_JSON_MAX,
    );
  });

  it('moves with the mark when two people are merged, and back when that is undone', () => {
    const { tree, ada, mary } = start();
    keepRecord(tree, mary, result('R-1', { aiJson: said }));
    const before = snapshot(tree);

    mergePersons(tree, ada, mary);
    expect(getRecordMark(tree, ada, 'example-site', 'R-1')?.aiJson).toBe(said);

    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('is not written to a GEDCOM file', () => {
    const { tree, ada } = start();
    keepRecord(tree, ada, result('R-1', { aiJson: said }));
    expect(bodyOf(exportLines(tree)).join('\n')).not.toContain('verdict');
  });
});

describe('a tree made before an AI could say something of a kept result', () => {
  it('gains the column, empty, and its earlier steps can still be undone and redone', () => {
    const db = openDatabase(':memory:');
    db.pragma(`application_id = ${TREE_APPLICATION_ID}`);
    migrate(db, treeMigrations.slice(0, 10));
    db.prepare(
      "INSERT INTO tree_meta (key, value) VALUES ('id', 'older'), ('name', 'Older'), ('created_at', '0')",
    ).run();
    const older = track(new Tree(db, null));
    expect(schemaVersion(older.db)).toBe(10);
    let ada = '';
    // As a build before this one did it: the steps it left know no such column.
    withLaterColumns(older, () => {
      ada = createPerson(older, { name: { given: 'Ada', surname: 'Hale' } }).id;
      keepRecord(older, ada, result('R-1'));
      declineRecord(older, ada, result('R-1'));
    });
    const steps = undoDepth(older);

    migrate(older.db, treeMigrations);
    expect(schemaVersion(older.db)).toBe(treeMigrations.length);
    // The upgrade is not an edit.
    expect(undoDepth(older)).toBe(steps);
    expect(getRecordMark(older, ada, 'example-site', 'R-1')).toMatchObject({
      state: 'declined',
      aiJson: null,
    });

    // A step from before the upgrade is undone and redone as it was.
    older.undo();
    expect(getRecordMark(older, ada, 'example-site', 'R-1')).toMatchObject({
      state: 'kept',
      recordJson: '{"key":"R-1","said":"something"}',
      aiJson: null,
    });
    older.undo();
    expect(countRecordMarks(older)).toBe(0);
    older.redo();
    expect(getRecordMark(older, ada, 'example-site', 'R-1')?.aiJson).toBeNull();

    // And a step of today is logged with the new column.
    const said = '{"v":1}';
    keepRecord(older, ada, result('R-2', { aiJson: said }));
    older.undo();
    older.redo();
    expect(getRecordMark(older, ada, 'example-site', 'R-2')?.aiJson).toBe(said);
  });
});
