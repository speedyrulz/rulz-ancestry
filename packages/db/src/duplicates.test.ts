import { describe, expect, it } from 'vitest';
import { addChildOf, addParent, addPartner, addPersonFromDraft, type PersonDraft } from './actions';
import { findDuplicates, isMarkedNotDuplicate, markNotDuplicate } from './duplicates';
import { addPersonEvent } from './events';
import { addName, deletePerson } from './persons';
import { cleanUpAfterEach, memoryTree, snapshot } from './testing';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

cleanUpAfterEach();

function add(tree: Tree, given: string, surname: string, extra: PersonDraft = {}): string {
  return addPersonFromDraft(tree, { given, surname, ...extra }).id;
}

const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

describe('findDuplicates', () => {
  it('finds the same person entered twice and says why', () => {
    const tree = memoryTree();
    const first = add(tree, 'Mary Ann', 'Hartley', {
      birthDate: '3 May 1850',
      birthPlace: 'Leeds, England',
    });
    const second = add(tree, 'Mary Ann', 'Hartley', { birthDate: 'abt 1850', birthPlace: 'Leeds' });
    add(tree, 'Thomas', 'Hartley', { birthDate: '1850' });
    add(tree, 'Mary Ann', 'Booth', { birthDate: '1850' });

    const scan = findDuplicates(tree);
    expect(scan.persons).toBe(4);
    expect(scan.total).toBe(1);
    expect(scan.truncated).toBe(false);
    const [aId, bId] = pairOf(first, second);
    expect(scan.pairs).toEqual([
      {
        aId,
        bId,
        score: 80,
        reasons: ['Same name', 'Born in the same year', 'Same place of birth'],
      },
    ]);
  });

  it('lists the likeliest pair first and honours the limit', () => {
    const tree = memoryTree();
    add(tree, 'John', 'Carr');
    add(tree, 'John', 'Carr');
    const strongA = add(tree, 'Ellen', 'Carr', { birthDate: '1820', deathDate: '1890' });
    const strongB = add(tree, 'Ellen', 'Carr', { birthDate: '1820', deathDate: '1890' });

    const scan = findDuplicates(tree);
    expect(scan.pairs.map((pair) => pair.score)).toEqual([85, 50]);
    expect([scan.pairs[0]?.aId, scan.pairs[0]?.bId]).toEqual(pairOf(strongA, strongB));

    const limited = findDuplicates(tree, { limit: 1 });
    expect(limited.pairs).toHaveLength(1);
    expect(limited.total).toBe(2);
  });

  it('never offers a parent and child, or two partners', () => {
    const tree = memoryTree();
    const father = add(tree, 'William', 'Stott', { sex: 'M' });
    addChildOf(tree, father, { create: { given: 'William', surname: 'Stott', sex: 'M' } });
    const cousin = add(tree, 'Alex', 'Stott');
    addPartner(tree, cousin, { create: { given: 'Alex', surname: 'Stott' } });
    expect(findDuplicates(tree).pairs).toEqual([]);
  });

  it('uses a baptism where no birth is recorded, and every name a person has', () => {
    const tree = memoryTree();
    const first = add(tree, 'Hannah', 'Lund', { birthDate: '1811' });
    const second = add(tree, 'Hannah', 'Sykes');
    addPersonEvent(tree, second, { type: 'baptism', date: '2 Feb 1811' });
    expect(findDuplicates(tree).pairs).toEqual([]);

    addName(tree, second, { given: 'Hannah', surname: 'Lund', type: 'maiden' });
    const scan = findDuplicates(tree);
    expect([scan.pairs[0]?.aId, scan.pairs[0]?.bId]).toEqual(pairOf(first, second));
    expect(scan.pairs[0]?.reasons).toEqual(['Same name', 'Born in the same year']);
  });

  it('counts parents with the same names, as when a branch was entered twice', () => {
    const tree = memoryTree();
    const first = add(tree, 'Ruth', 'Ingham');
    const second = add(tree, 'Ruth', 'Ingham');
    addParent(tree, first, { create: { given: 'Seth', surname: 'Ingham', sex: 'M' } });
    addParent(tree, second, { create: { given: 'Seth', surname: 'Ingham', sex: 'M' } });
    const scan = findDuplicates(tree);
    // The two Ruths, and their two fathers.
    expect(scan.total).toBe(2);
    const ruths = scan.pairs.find((pair) => pair.aId === pairOf(first, second)[0]);
    expect(ruths?.reasons).toEqual(['Same name', 'A parent with the same name']);
    expect(ruths?.score).toBe(60);
  });

  it('leaves out a pair once it is marked as two different people', () => {
    const tree = memoryTree();
    const first = add(tree, 'Amos', 'Kaye');
    const second = add(tree, 'Amos', 'Kaye');
    expect(findDuplicates(tree).total).toBe(1);
    expect(isMarkedNotDuplicate(tree, first, second)).toBe(false);

    const before = snapshot(tree);
    markNotDuplicate(tree, second, first);
    expect(findDuplicates(tree).total).toBe(0);
    expect(isMarkedNotDuplicate(tree, first, second)).toBe(true);
    expect(tree.undoStatus().undo?.label).toBe('Mark as different people');

    // Marking the same pair again changes nothing and leaves no undo step.
    markNotDuplicate(tree, first, second);
    expect(tree.db.prepare('SELECT count(*) FROM not_duplicate').pluck().get()).toBe(1);
    expect(tree.undoStatus().undo?.label).toBe('Mark as different people');

    tree.undo();
    expect(snapshot(tree)).toBe(before);
    expect(findDuplicates(tree).total).toBe(1);
    tree.redo();
    expect(findDuplicates(tree).total).toBe(0);

    // The mark goes with either person.
    deletePerson(tree, first);
    expect(tree.db.prepare('SELECT count(*) FROM not_duplicate').pluck().get()).toBe(0);
  });

  it('refuses to mark a person against themself or against nobody', () => {
    const tree = memoryTree();
    const only = add(tree, 'Amos', 'Kaye');
    expect(() => markNotDuplicate(tree, only, only)).toThrow(TreeRuleError);
    expect(() => markNotDuplicate(tree, only, '00000000-0000-7000-8000-000000000000')).toThrow(
      NotFoundError,
    );
  });

  it('stops early in a tree too large to compare whole, and says so', () => {
    const tree = memoryTree();
    tree.transact('Add many', () => {
      for (let index = 0; index < 30; index += 1) add(tree, 'Jane', 'Shaw');
    });
    const whole = findDuplicates(tree);
    expect(whole.total).toBe((30 * 29) / 2);
    expect(whole.pairs).toHaveLength(200);
    expect(whole.truncated).toBe(false);

    const cut = findDuplicates(tree, { maxComparisons: 100 });
    expect(cut.truncated).toBe(true);
    expect(cut.total).toBe(100);
  });

  it('compares a 5,000-person tree in a few seconds', { timeout: 60_000 }, () => {
    const tree = memoryTree();
    const surnames = [
      'Ackroyd',
      'Bairstow',
      'Crabtree',
      'Dewhirst',
      'Earnshaw',
      'Firth',
      'Greenwood',
      'Holroyd',
    ];
    const givens = [
      'John',
      'Mary',
      'William',
      'Ann',
      'Thomas',
      'Sarah',
      'James',
      'Hannah',
      'Joseph',
      'Martha',
    ];
    tree.transact('Add many', () => {
      for (let index = 0; index < 5000; index += 1) {
        add(tree, givens[index % givens.length] ?? '', surnames[index % surnames.length] ?? '', {
          birthDate: String(1700 + (index % 250)),
        });
      }
    });
    const started = performance.now();
    const scan = findDuplicates(tree);
    const elapsed = performance.now() - started;
    expect(scan.persons).toBe(5000);
    expect(scan.truncated).toBe(false);
    expect(scan.pairs.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10_000);
  });
});
