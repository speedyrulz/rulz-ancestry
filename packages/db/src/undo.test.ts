import { describe, expect, it } from 'vitest';
import { addFamilyEvent, addPersonEvent, deleteEvent, updateEvent } from './events';
import {
  addChild,
  createFamily,
  deleteFamily,
  getFamily,
  removeChild,
  setPartners,
} from './families';
import {
  addName,
  countPersons,
  createPerson,
  deleteName,
  deletePerson,
  getPerson,
  listNames,
  setPrimaryName,
  updateName,
  updatePerson,
} from './persons';
import { searchPersons } from './search';
import { cleanUpAfterEach, memoryTree, snapshot, tempDir, track, undoDepth } from './testing';
import { openTree, type Tree } from './tree';

cleanUpAfterEach();

describe('undo and redo', () => {
  it('have nothing to do on a new tree', () => {
    const tree = memoryTree();
    expect(tree.undo()).toBeNull();
    expect(tree.redo()).toBeNull();
    expect(tree.undoStatus()).toEqual({ undo: null, redo: null });
  });

  it('reverse and repeat adding a person, and the search index follows', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { name: { given: 'Ada', surname: 'Lovelace' } });
    expect(tree.undoStatus().undo?.label).toBe('Add person');

    expect(tree.undo()?.label).toBe('Add person');
    expect(getPerson(tree, person.id)).toBeNull();
    expect(searchPersons(tree, 'lovelace')).toEqual([]);
    expect(tree.undoStatus()).toMatchObject({ undo: null, redo: { label: 'Add person' } });

    expect(tree.redo()?.label).toBe('Add person');
    expect(getPerson(tree, person.id)).toEqual(person);
    expect(searchPersons(tree, 'lovelace').map((p) => p.id)).toEqual([person.id]);
    expect(tree.undoStatus()).toMatchObject({ undo: { label: 'Add person' }, redo: null });
  });

  it('put an edited record back exactly as it was', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { sex: 'M', living: true });
    const before = snapshot(tree);

    updatePerson(tree, person.id, { sex: 'F', living: null });
    const after = snapshot(tree);
    expect(after).not.toBe(before);

    tree.undo();
    expect(snapshot(tree)).toBe(before);
    tree.redo();
    expect(snapshot(tree)).toBe(after);
  });

  it('bring back everything that went with a deleted person', () => {
    const tree = memoryTree();
    const father = createPerson(tree, { sex: 'M', name: { given: 'George', surname: 'Evans' } });
    addName(tree, father.id, { type: 'aka', given: 'Geo.' });
    const mother = createPerson(tree, {
      sex: 'F',
      name: { given: 'Christiana', surname: 'Pearson' },
    });
    const child = createPerson(tree, { name: { given: 'Mary Ann', surname: 'Evans' } });
    const family = createFamily(tree, { partner1Id: father.id, partner2Id: mother.id });
    addChild(tree, family.id, child.id);
    const ownFamily = createFamily(tree, { partner1Id: father.id });
    addPersonEvent(tree, father.id, { type: 'birth', date: '1773', place: 'Roston' });
    addPersonEvent(tree, father.id, { type: 'death', date: '1849' });
    addFamilyEvent(tree, family.id, { type: 'marriage', date: '1813' });
    addFamilyEvent(tree, ownFamily.id, { type: 'engagement' });
    const before = snapshot(tree);

    deletePerson(tree, father.id);
    expect(getPerson(tree, father.id)).toBeNull();
    expect(getFamily(tree, family.id)?.partner1Id).toBeNull();
    expect(getFamily(tree, ownFamily.id)).toBeNull();
    expect(searchPersons(tree, 'george')).toEqual([]);
    const after = snapshot(tree);

    expect(tree.undo()?.label).toBe('Delete person');
    expect(snapshot(tree)).toBe(before);
    expect(getFamily(tree, family.id)?.partner1Id).toBe(father.id);
    expect(searchPersons(tree, 'geo').map((p) => p.id)).toEqual([father.id]);
    expect(tree.db.pragma('foreign_key_check')).toEqual([]);

    tree.redo();
    expect(snapshot(tree)).toBe(after);
    expect(tree.db.pragma('foreign_key_check')).toEqual([]);
  });

  it('drop the redo steps once a new change is made', () => {
    const tree = memoryTree();
    createPerson(tree, { name: { given: 'One' } });
    createPerson(tree, { name: { given: 'Two' } });
    tree.undo();
    expect(tree.undoStatus().redo).not.toBeNull();

    createPerson(tree, { name: { given: 'Three' } });
    expect(tree.undoStatus().redo).toBeNull();
    expect(tree.redo()).toBeNull();
    expect(searchPersons(tree, 'two')).toEqual([]);
    expect(countPersons(tree)).toBe(2);
    // The dropped step's log rows went with it.
    expect(
      tree.db
        .prepare('SELECT count(*) FROM change_log WHERE tx_id NOT IN (SELECT id FROM change_tx)')
        .pluck()
        .get(),
    ).toBe(0);

    // A change that changes nothing must not cost the user their redo steps.
    tree.undo();
    tree.transact('Nothing', () => undefined);
    expect(tree.undoStatus().redo?.label).toBe('Add person');
  });

  it('keep numbers as numbers when a row is written back', () => {
    const tree = memoryTree();
    const person = createPerson(tree, { living: true });
    addPersonEvent(tree, person.id, { type: 'birth', date: '1900' });
    deletePerson(tree, person.id);
    tree.undo();

    expect(
      tree.db
        .prepare('SELECT typeof(created_at) AS created, typeof(living) AS living FROM person')
        .get(),
    ).toEqual({ created: 'integer', living: 'integer' });
    expect(
      tree.db
        .prepare('SELECT typeof(date_min_jdn) AS jdn, typeof(date_calendar) AS cal FROM event')
        .get(),
    ).toEqual({ jdn: 'integer', cal: 'text' });
  });

  it('survive closing and reopening the tree', () => {
    const dir = tempDir();
    const first = track(openTree(dir));
    createPerson(first, { name: { given: 'Kept' } });
    createPerson(first, { name: { given: 'Undone' } });
    first.undo();
    first.close();

    const second = track(openTree(dir));
    expect(countPersons(second)).toBe(1);
    expect(second.redo()?.label).toBe('Add person');
    expect(countPersons(second)).toBe(2);
    second.undo();
    second.undo();
    expect(countPersons(second)).toBe(0);
  });
});

/**
 * A long, varied editing session. After each step the whole tree is recorded;
 * undo must then walk back through exactly those states, and redo forward
 * through them again.
 */
function editingSession(tree: Tree): (() => void)[] {
  const ids: Record<string, string> = {};
  const nameOf = (key: string, index: number) => listNames(tree, ids[key]!)[index]!.id;
  return [
    () =>
      (ids['a'] = createPerson(tree, { sex: 'M', name: { given: 'Albert', surname: 'Stone' } }).id),
    () =>
      (ids['b'] = createPerson(tree, {
        sex: 'F',
        name: { given: 'Beatrice', surname: 'Hill' },
      }).id),
    () => (ids['fam'] = createFamily(tree, { partner1Id: ids['a']!, partner2Id: ids['b']! }).id),
    () =>
      (ids['marriage'] = addFamilyEvent(tree, ids['fam']!, {
        type: 'marriage',
        date: '1 May 1900',
      }).id),
    () => (ids['c'] = createPerson(tree, { name: { given: 'Clara', surname: 'Stone' } }).id),
    () => addChild(tree, ids['fam']!, ids['c']!),
    () =>
      (ids['birth'] = addPersonEvent(tree, ids['c']!, {
        type: 'birth',
        date: 'abt 1902',
        place: 'Leeds',
      }).id),
    () =>
      addName(tree, ids['b']!, {
        type: 'married',
        given: 'Beatrice',
        surname: 'Stone',
        primary: true,
      }),
    () => updateName(tree, nameOf('a', 0), { given: 'Albert Edward', suffix: 'Sr.' }),
    () => updateEvent(tree, ids['birth']!, { date: '3 Feb 1902', place: 'Leeds, Yorkshire' }),
    () => updatePerson(tree, ids['c']!, { sex: 'F', living: false }),
    () => setPrimaryName(tree, nameOf('b', 1)),
    () => (ids['d'] = createPerson(tree, { name: { given: 'David' } }).id),
    () =>
      tree.transact('Add David to the family', () => {
        addChild(tree, ids['fam']!, ids['d']!, { pedigree: 'adopted' });
        addPersonEvent(tree, ids['d']!, { type: 'adoption', date: '1910' });
      }),
    () => removeChild(tree, ids['fam']!, ids['c']!),
    () => setPartners(tree, ids['fam']!, { partner2Id: null }),
    () => deleteName(tree, nameOf('b', 0)),
    () => deleteEvent(tree, ids['marriage']!),
    // The family goes before Albert does: deleting him would leave only David
    // in it, and a family with one person and no events is removed with him.
    () => deleteFamily(tree, ids['fam']!),
    () => deletePerson(tree, ids['a']!),
    () => deletePerson(tree, ids['d']!),
  ];
}

describe('a long editing session', () => {
  it('can be undone and redone one step at a time, in both directions, twice', () => {
    const tree = memoryTree();
    const states = [snapshot(tree)];
    for (const step of editingSession(tree)) {
      step();
      states.push(snapshot(tree));
    }
    const steps = states.length - 1;
    expect(undoDepth(tree)).toBe(steps);
    // Every step really changed something, or the comparison below would prove little.
    expect(new Set(states).size).toBe(states.length);

    for (let round = 0; round < 2; round++) {
      for (let i = steps - 1; i >= 0; i--) {
        expect(tree.undo(), `undo to state ${i}`).not.toBeNull();
        expect(snapshot(tree), `after undo to state ${i}`).toBe(states[i]);
      }
      expect(tree.undo()).toBeNull();
      expect(tree.info()).toMatchObject({ persons: 0, families: 0, events: 0 });

      for (let i = 1; i <= steps; i++) {
        expect(tree.redo(), `redo to state ${i}`).not.toBeNull();
        expect(snapshot(tree), `after redo to state ${i}`).toBe(states[i]);
      }
      expect(tree.redo()).toBeNull();
    }
    expect(tree.db.pragma('foreign_key_check')).toEqual([]);
    expect(tree.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});

describe('a large tree', () => {
  it('takes 10,000 people with names, events and families without slowing down as it grows', () => {
    const tree = memoryTree();
    const couples = 5000;
    const started = performance.now();
    let halfway = started;
    tree.transact('Import', () => {
      let previousFamily: string | null = null;
      for (let i = 0; i < couples; i++) {
        if (i === couples / 2) halfway = performance.now();
        const husband = createPerson(tree, {
          sex: 'M',
          name: { given: `Adam${i}`, surname: `Family${i % 500}` },
        });
        const wife = createPerson(tree, {
          sex: 'F',
          name: { given: `Eve${i}`, surname: `Maiden${i % 700}` },
        });
        addPersonEvent(tree, husband.id, {
          type: 'birth',
          date: `${1500 + (i % 400)}`,
          place: 'Somewhere',
        });
        addPersonEvent(tree, husband.id, { type: 'death', date: `ABT ${1560 + (i % 400)}` });
        addPersonEvent(tree, wife.id, { type: 'birth', date: `12 MAR ${1502 + (i % 400)}` });
        // Each couple's husband is a child of the couple before, so the line is 5,000 generations deep.
        if (previousFamily) addChild(tree, previousFamily, husband.id);
        const family = createFamily(tree, { partner1Id: husband.id, partner2Id: wife.id });
        addFamilyEvent(tree, family.id, { type: 'marriage', date: `${1525 + (i % 400)}` });
        previousFamily = family.id;
      }
    });
    const finished = performance.now();

    expect(tree.info()).toMatchObject({ persons: 10_000, families: 5000, events: 20_000 });
    expect(searchPersons(tree, 'adam4999 family499')).toHaveLength(1);
    expect(undoDepth(tree)).toBe(1);
    // The whole load takes 5 to 7 seconds on a developer PC. Rather than a time limit,
    // which depends on the machine, compare the two halves: if every write costs the
    // same they take about as long as each other. A lookup that scans the whole tree
    // on every write makes the second half take three times the first; two such
    // lookups once took this load to 89 seconds.
    const firstHalf = halfway - started;
    const secondHalf = finished - halfway;
    expect(secondHalf / firstHalf).toBeLessThan(2);

    tree.undo();
    expect(tree.info()).toMatchObject({ persons: 0, families: 0, events: 0 });
    expect(tree.db.prepare('SELECT count(*) FROM search_doc').pluck().get()).toBe(0);
  }, 180_000);
});
