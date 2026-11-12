import { describe, expect, it } from 'vitest';
import {
  addChildOf,
  addParent,
  addPartner,
  addPersonFromDraft,
  unlinkChild,
  unlinkPartner,
} from './actions';
import { addFamilyEvent, listPersonEvents } from './events';
import {
  getFamily,
  getParents,
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
} from './families';
import { countPersons, createPerson, listNames } from './persons';
import { cleanUpAfterEach, memoryTree, snapshot, undoDepth } from './testing';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

cleanUpAfterEach();

function person(tree: Tree, given: string, sex: 'M' | 'F' | 'U' = 'U') {
  return createPerson(tree, { sex, name: { given, surname: 'Test' } });
}

describe('addPersonFromDraft', () => {
  it('adds the name, birth and death as one undo step', () => {
    const tree = memoryTree();
    const before = snapshot(tree);
    const added = addPersonFromDraft(tree, {
      given: '  Ada ',
      surname: 'Lovelace',
      sex: 'F',
      birthDate: '10 Dec 1815',
      birthPlace: 'London',
      deathDate: '27 Nov 1852',
    });

    expect(added.sex).toBe('F');
    expect(listNames(tree, added.id)).toMatchObject([
      { given: 'Ada', surname: 'Lovelace', isPrimary: true },
    ]);
    expect(listPersonEvents(tree, added.id)).toMatchObject([
      { type: 'birth', dateText: '10 Dec 1815', placeText: 'London' },
      { type: 'death', dateText: '27 Nov 1852', placeText: '' },
    ]);
    expect(undoDepth(tree)).toBe(1);
    expect(tree.undoStatus().undo?.label).toBe('Add person');

    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('adds no birth or death when their fields are empty', () => {
    const tree = memoryTree();
    const added = addPersonFromDraft(tree, { surname: 'Smith', birthDate: '  ', deathPlace: '' });
    expect(listPersonEvents(tree, added.id)).toEqual([]);
  });

  it('needs a given name or a surname', () => {
    const tree = memoryTree();
    expect(() => addPersonFromDraft(tree, { given: ' ', birthDate: '1850' })).toThrow(
      TreeRuleError,
    );
    expect(countPersons(tree)).toBe(0);
    expect(undoDepth(tree)).toBe(0);
  });
});

describe('addParent', () => {
  it('puts a new father and mother in one family, each as its own undo step', () => {
    const tree = memoryTree();
    const child = person(tree, 'Child');
    const steps = undoDepth(tree);

    const father = addParent(tree, child.id, { create: { given: 'Dad', sex: 'M' } });
    expect(tree.undoStatus().undo?.label).toBe('Add father');
    const mother = addParent(tree, child.id, { create: { given: 'Mum', sex: 'F' } });
    expect(tree.undoStatus().undo?.label).toBe('Add mother');

    expect(mother.familyId).toBe(father.familyId);
    expect(getFamily(tree, father.familyId)).toMatchObject({
      partner1Id: father.personId,
      partner2Id: mother.personId,
    });
    expect(getParents(tree, child.id).map((link) => link.parentId)).toEqual([
      father.personId,
      mother.personId,
    ]);
    expect(undoDepth(tree)).toBe(steps + 2);

    tree.undo();
    expect(getParents(tree, child.id).map((link) => link.parentId)).toEqual([father.personId]);
    expect(countPersons(tree)).toBe(2);
    tree.undo();
    expect(getParents(tree, child.id)).toEqual([]);
    expect(countPersons(tree)).toBe(1);
    expect(tree.info().families).toBe(0);
  });

  it('puts a mother who is added first in the second place', () => {
    const tree = memoryTree();
    const child = person(tree, 'Child');
    const mother = addParent(tree, child.id, { create: { given: 'Mum', sex: 'F' } });
    expect(getFamily(tree, mother.familyId)).toMatchObject({
      partner1Id: null,
      partner2Id: mother.personId,
    });
    const other = addParent(tree, child.id, { create: { given: 'Parent' } });
    expect(tree.undoStatus().undo?.label).toBe('Add parent');
    expect(getFamily(tree, mother.familyId)?.partner1Id).toBe(other.personId);
  });

  it('links someone who is already in the tree', () => {
    const tree = memoryTree();
    const child = person(tree, 'Child');
    const dad = person(tree, 'Dad', 'M');
    const link = addParent(tree, child.id, { existingId: dad.id });
    expect(link.personId).toBe(dad.id);
    expect(countPersons(tree)).toBe(2);
    expect(tree.undoStatus().undo?.label).toBe('Add father');
  });

  it('starts a second set of parents when the first is full', () => {
    const tree = memoryTree();
    const child = person(tree, 'Child');
    const first = addParent(tree, child.id, { create: { given: 'Dad', sex: 'M' } });
    addParent(tree, child.id, { create: { given: 'Mum', sex: 'F' } });
    const adoptive = addParent(
      tree,
      child.id,
      { create: { given: 'Adoptive', sex: 'F' } },
      { pedigree: 'adopted' },
    );

    expect(adoptive.familyId).not.toBe(first.familyId);
    expect(listFamiliesAsChild(tree, child.id).map((link) => link.pedigree)).toEqual([
      'birth',
      'adopted',
    ]);
  });

  it('adds to the family that was asked for', () => {
    const tree = memoryTree();
    const child = person(tree, 'Child');
    const birth = addParent(tree, child.id, { create: { given: 'Birth mother', sex: 'F' } });
    addParent(tree, child.id, { create: { given: 'Birth father', sex: 'M' } });
    const step = addParent(tree, child.id, { create: { given: 'Step mother', sex: 'F' } });

    const stepFather = addParent(
      tree,
      child.id,
      { create: { given: 'Step father', sex: 'M' } },
      { familyId: step.familyId },
    );
    expect(stepFather.familyId).toBe(step.familyId);
    expect(() =>
      addParent(tree, child.id, { create: { given: 'Third' } }, { familyId: birth.familyId }),
    ).toThrow(/already has two parents/);

    const stranger = person(tree, 'Stranger');
    expect(() =>
      addParent(tree, stranger.id, { create: { given: 'X' } }, { familyId: birth.familyId }),
    ).toThrow(/not a child of that family/);
  });

  it('refuses a loop, a repeat or the person themself, and leaves nothing behind', () => {
    const tree = memoryTree();
    const grandmother = person(tree, 'Grandmother', 'F');
    const mother = addChildOf(tree, grandmother.id, { create: { given: 'Mother', sex: 'F' } });
    const child = addChildOf(tree, mother.personId, { create: { given: 'Child' } });
    const before = snapshot(tree);
    const steps = undoDepth(tree);

    // The grandmother cannot be the child of her own grandchild.
    expect(() => addParent(tree, grandmother.id, { existingId: child.personId })).toThrow(
      TreeRuleError,
    );
    expect(() => addParent(tree, child.personId, { existingId: mother.personId })).toThrow(
      /already a parent/,
    );
    expect(() => addParent(tree, child.personId, { existingId: child.personId })).toThrow(
      /their own parent/,
    );
    expect(() =>
      addParent(tree, '00000000-0000-7000-8000-000000000000', { create: { given: 'Nobody' } }),
    ).toThrow(NotFoundError);

    expect(snapshot(tree)).toBe(before);
    expect(undoDepth(tree)).toBe(steps);
  });
});

describe('addPartner', () => {
  it('makes a family for the couple, the man first', () => {
    const tree = memoryTree();
    const wife = person(tree, 'Wife', 'F');
    const link = addPartner(tree, wife.id, { create: { given: 'Husband', sex: 'M' } });
    expect(getFamily(tree, link.familyId)).toMatchObject({
      partner1Id: link.personId,
      partner2Id: wife.id,
    });
    expect(tree.undoStatus().undo?.label).toBe('Add partner');

    const one = person(tree, 'One');
    const second = addPartner(tree, one.id, { create: { given: 'Two' } });
    expect(getFamily(tree, second.familyId)).toMatchObject({
      partner1Id: one.id,
      partner2Id: second.personId,
    });
  });

  it('gives a person a separate family for each partner', () => {
    const tree = memoryTree();
    const husband = person(tree, 'Husband', 'M');
    const first = addPartner(tree, husband.id, { create: { given: 'First wife', sex: 'F' } });
    const second = addPartner(tree, husband.id, { create: { given: 'Second wife', sex: 'F' } });
    expect(second.familyId).not.toBe(first.familyId);
    expect(listFamiliesAsPartner(tree, husband.id)).toHaveLength(2);
  });

  it('fills the free place in a family that already has children', () => {
    const tree = memoryTree();
    const mother = person(tree, 'Mother', 'F');
    const child = addChildOf(tree, mother.id, { create: { given: 'Child' } });
    const father = addPartner(
      tree,
      mother.id,
      { create: { given: 'Father', sex: 'M' } },
      { familyId: child.familyId },
    );
    expect(father.familyId).toBe(child.familyId);
    expect(getParents(tree, child.personId).map((link) => link.parentId)).toEqual([
      father.personId,
      mother.id,
    ]);
    expect(() =>
      addPartner(tree, mother.id, { create: { given: 'Third' } }, { familyId: child.familyId }),
    ).toThrow(/already has two partners/);
  });

  it('refuses the same couple twice and a person as their own partner', () => {
    const tree = memoryTree();
    const a = person(tree, 'A');
    const b = person(tree, 'B');
    addPartner(tree, a.id, { existingId: b.id });
    const before = snapshot(tree);
    expect(() => addPartner(tree, b.id, { existingId: a.id })).toThrow(/already partners/);
    expect(() => addPartner(tree, a.id, { existingId: a.id })).toThrow(/their own partner/);
    expect(snapshot(tree)).toBe(before);
  });
});

describe('addChildOf', () => {
  it('keeps children with no known second parent in one family', () => {
    const tree = memoryTree();
    const father = person(tree, 'Father', 'M');
    const first = addChildOf(tree, father.id, { create: { given: 'First' } });
    const second = addChildOf(tree, father.id, { create: { given: 'Second' } });

    expect(second.familyId).toBe(first.familyId);
    expect(getFamily(tree, first.familyId)).toMatchObject({
      partner1Id: father.id,
      partner2Id: null,
    });
    expect(listChildren(tree, first.familyId).map((child) => child.childId)).toEqual([
      first.personId,
      second.personId,
    ]);
    expect(tree.undoStatus().undo?.label).toBe('Add child');
  });

  it('adds to the couple that was asked for, with the kind of link given', () => {
    const tree = memoryTree();
    const father = person(tree, 'Father', 'M');
    const couple = addPartner(tree, father.id, { create: { given: 'Mother', sex: 'F' } });
    const child = addChildOf(
      tree,
      father.id,
      { create: { given: 'Adopted child' } },
      { familyId: couple.familyId, pedigree: 'adopted' },
    );
    expect(child.familyId).toBe(couple.familyId);
    expect(listChildren(tree, couple.familyId)).toMatchObject([{ pedigree: 'adopted' }]);

    const stranger = person(tree, 'Stranger');
    expect(() =>
      addChildOf(tree, stranger.id, { create: { given: 'X' } }, { familyId: couple.familyId }),
    ).toThrow(/not a partner in that family/);
  });

  it('refuses an ancestor as a child and rolls the whole step back', () => {
    const tree = memoryTree();
    const parent = person(tree, 'Parent');
    const child = addChildOf(tree, parent.id, { create: { given: 'Child' } });
    const before = snapshot(tree);
    expect(() => addChildOf(tree, child.personId, { existingId: parent.id })).toThrow(
      TreeRuleError,
    );
    expect(() => addChildOf(tree, parent.id, { existingId: parent.id })).toThrow(/their own child/);
    // The same child cannot be added to the same family twice.
    expect(() => addChildOf(tree, parent.id, { existingId: child.personId })).toThrow(
      TreeRuleError,
    );
    expect(snapshot(tree)).toBe(before);
  });
});

describe('unlinkChild and unlinkPartner', () => {
  it('removes a child but keeps the couple', () => {
    const tree = memoryTree();
    const father = person(tree, 'Father', 'M');
    const couple = addPartner(tree, father.id, { create: { given: 'Mother', sex: 'F' } });
    const child = addChildOf(
      tree,
      father.id,
      { create: { given: 'Child' } },
      { familyId: couple.familyId },
    );
    const before = snapshot(tree);

    unlinkChild(tree, couple.familyId, child.personId);
    expect(listChildren(tree, couple.familyId)).toEqual([]);
    expect(getFamily(tree, couple.familyId)).not.toBeNull();
    expect(countPersons(tree)).toBe(3);
    expect(tree.undoStatus().undo?.label).toBe('Remove child from family');

    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('removes the family with the last link, in the same undo step', () => {
    const tree = memoryTree();
    const father = person(tree, 'Father', 'M');
    const child = addChildOf(tree, father.id, { create: { given: 'Child' } });
    const before = snapshot(tree);
    const steps = undoDepth(tree);

    unlinkChild(tree, child.familyId, child.personId);
    expect(getFamily(tree, child.familyId)).toBeNull();
    expect(undoDepth(tree)).toBe(steps + 1);
    tree.undo();
    expect(snapshot(tree)).toBe(before);
  });

  it('removes a partner and leaves the children with the other one', () => {
    const tree = memoryTree();
    const father = person(tree, 'Father', 'M');
    const couple = addPartner(tree, father.id, { create: { given: 'Mother', sex: 'F' } });
    const child = addChildOf(
      tree,
      father.id,
      { create: { given: 'Child' } },
      { familyId: couple.familyId },
    );

    unlinkPartner(tree, couple.familyId, couple.personId);
    expect(getFamily(tree, couple.familyId)).toMatchObject({
      partner1Id: father.id,
      partner2Id: null,
    });
    expect(getParents(tree, child.personId).map((link) => link.parentId)).toEqual([father.id]);
    expect(tree.undoStatus().undo?.label).toBe('Remove partner from family');
  });

  it('removes a couple with no children, unless the family has an event', () => {
    const tree = memoryTree();
    const a = person(tree, 'A');
    const plain = addPartner(tree, a.id, { create: { given: 'B' } });
    unlinkPartner(tree, plain.familyId, plain.personId);
    expect(getFamily(tree, plain.familyId)).toBeNull();

    const married = addPartner(tree, a.id, { create: { given: 'C' } });
    addFamilyEvent(tree, married.familyId, { type: 'marriage', date: '1850' });
    unlinkPartner(tree, married.familyId, married.personId);
    expect(getFamily(tree, married.familyId)).toMatchObject({
      partner1Id: a.id,
      partner2Id: null,
    });
    expect(countPersons(tree)).toBe(3);
  });

  it('reports a link that does not exist', () => {
    const tree = memoryTree();
    const a = person(tree, 'A');
    const couple = addPartner(tree, a.id, { create: { given: 'B' } });
    const stranger = person(tree, 'Stranger');
    expect(() => unlinkPartner(tree, couple.familyId, stranger.id)).toThrow(NotFoundError);
    expect(() => unlinkChild(tree, couple.familyId, stranger.id)).toThrow(NotFoundError);
  });
});
