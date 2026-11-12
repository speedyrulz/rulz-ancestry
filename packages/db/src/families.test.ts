import { describe, expect, it } from 'vitest';
import { addFamilyEvent, getEvent, listFamilyEvents } from './events';
import {
  addChild,
  createFamily,
  deleteFamily,
  getChildIds,
  getFamily,
  getParents,
  isSelfOrAncestor,
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  removeChild,
  setPartners,
} from './families';
import { countPersons, createPerson } from './persons';
import { cleanUpAfterEach, memoryTree, undoDepth } from './testing';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

cleanUpAfterEach();

const MISSING = '00000000-0000-7000-8000-000000000000';

/** Three generations: grandparents, their son and his wife, and two grandchildren. */
function threeGenerations(tree: Tree) {
  const grandfather = createPerson(tree, { sex: 'M' });
  const grandmother = createPerson(tree, { sex: 'F' });
  const father = createPerson(tree, { sex: 'M' });
  const mother = createPerson(tree, { sex: 'F' });
  const son = createPerson(tree, { sex: 'M' });
  const daughter = createPerson(tree, { sex: 'F' });
  const elders = createFamily(tree, { partner1Id: grandfather.id, partner2Id: grandmother.id });
  addChild(tree, elders.id, father.id);
  const parents = createFamily(tree, { partner1Id: father.id, partner2Id: mother.id });
  addChild(tree, parents.id, son.id);
  addChild(tree, parents.id, daughter.id);
  return { grandfather, grandmother, father, mother, son, daughter, elders, parents };
}

describe('families', () => {
  it('creates a family with two, one or no known partners', () => {
    const tree = memoryTree();
    const a = createPerson(tree);
    const b = createPerson(tree);
    expect(createFamily(tree, { partner1Id: a.id, partner2Id: b.id })).toMatchObject({
      partner1Id: a.id,
      partner2Id: b.id,
    });
    expect(createFamily(tree, { partner2Id: b.id })).toMatchObject({
      partner1Id: null,
      partner2Id: b.id,
    });
    expect(createFamily(tree)).toMatchObject({ partner1Id: null, partner2Id: null });
  });

  it('rejects partners that do not make sense', () => {
    const tree = memoryTree();
    const a = createPerson(tree);
    expect(() => createFamily(tree, { partner1Id: a.id, partner2Id: a.id })).toThrow(TreeRuleError);
    expect(() => createFamily(tree, { partner1Id: MISSING })).toThrow(NotFoundError);
    expect(tree.info().families).toBe(0);
  });

  it('changes and clears partners', () => {
    const tree = memoryTree();
    const a = createPerson(tree);
    const b = createPerson(tree);
    const c = createPerson(tree);
    const family = createFamily(tree, { partner1Id: a.id, partner2Id: b.id });

    expect(setPartners(tree, family.id, { partner2Id: c.id })).toMatchObject({
      partner1Id: a.id,
      partner2Id: c.id,
    });
    expect(setPartners(tree, family.id, { partner1Id: null })).toMatchObject({
      partner1Id: null,
      partner2Id: c.id,
    });
    expect(() => setPartners(tree, family.id, { partner1Id: c.id })).toThrow(TreeRuleError);

    const depth = undoDepth(tree);
    setPartners(tree, family.id, { partner2Id: c.id });
    expect(undoDepth(tree)).toBe(depth);
  });

  it('lists children in the order they were added, with their pedigree', () => {
    const tree = memoryTree();
    const { parents, son, daughter } = threeGenerations(tree);
    const adopted = createPerson(tree);
    addChild(tree, parents.id, adopted.id, { pedigree: 'adopted' });

    expect(listChildren(tree, parents.id).map((c) => [c.childId, c.pedigree, c.sortOrder])).toEqual(
      [
        [son.id, 'birth', 0],
        [daughter.id, 'birth', 1],
        [adopted.id, 'adopted', 2],
      ],
    );
    expect(() => addChild(tree, parents.id, son.id)).toThrow(/already a child/);
    expect(() => addChild(tree, parents.id, adopted.id, { pedigree: 'x' as never })).toThrow(
      TreeRuleError,
    );
    expect(() => addChild(tree, MISSING, son.id)).toThrow(NotFoundError);
    expect(() => addChild(tree, parents.id, MISSING)).toThrow(NotFoundError);
  });

  it('answers who the parents and children of a person are', () => {
    const tree = memoryTree();
    const t = threeGenerations(tree);

    expect(getParents(tree, t.son.id)).toEqual([
      { parentId: t.father.id, familyId: t.parents.id, pedigree: 'birth' },
      { parentId: t.mother.id, familyId: t.parents.id, pedigree: 'birth' },
    ]);
    expect(getParents(tree, t.grandfather.id)).toEqual([]);
    expect(getChildIds(tree, t.father.id)).toEqual([t.son.id, t.daughter.id]);
    expect(getChildIds(tree, t.son.id)).toEqual([]);
    expect(listFamiliesAsPartner(tree, t.father.id).map((f) => f.id)).toEqual([t.parents.id]);
    expect(listFamiliesAsChild(tree, t.father.id).map((f) => f.familyId)).toEqual([t.elders.id]);
  });

  it('lists a child of two families of the same parent once', () => {
    const tree = memoryTree();
    const parent = createPerson(tree);
    const child = createPerson(tree);
    addChild(tree, createFamily(tree, { partner1Id: parent.id }).id, child.id);
    addChild(tree, createFamily(tree, { partner2Id: parent.id }).id, child.id, {
      pedigree: 'adopted',
    });
    expect(getChildIds(tree, parent.id)).toEqual([child.id]);
    expect(getParents(tree, child.id).map((p) => p.pedigree)).toEqual(['birth', 'adopted']);
  });

  it('follows ancestry through every generation', () => {
    const tree = memoryTree();
    const t = threeGenerations(tree);
    expect(isSelfOrAncestor(tree, t.grandmother.id, t.daughter.id)).toBe(true);
    expect(isSelfOrAncestor(tree, t.daughter.id, t.daughter.id)).toBe(true);
    expect(isSelfOrAncestor(tree, t.daughter.id, t.grandmother.id)).toBe(false);
    expect(isSelfOrAncestor(tree, t.mother.id, t.father.id)).toBe(false);
  });

  it('never lets a person become their own ancestor', () => {
    const tree = memoryTree();
    const t = threeGenerations(tree);

    // A person as a child of their own family, child or grandchild.
    expect(() => addChild(tree, t.parents.id, t.father.id)).toThrow(TreeRuleError);
    const sonsFamily = createFamily(tree, { partner1Id: t.son.id });
    expect(() => addChild(tree, sonsFamily.id, t.father.id)).toThrow(TreeRuleError);
    expect(() => addChild(tree, sonsFamily.id, t.grandmother.id)).toThrow(TreeRuleError);

    // A person as a partner in the family they, or an ancestor of theirs, is a child of.
    expect(() => setPartners(tree, t.elders.id, { partner1Id: t.father.id })).toThrow(
      TreeRuleError,
    );
    expect(() => setPartners(tree, t.elders.id, { partner2Id: t.daughter.id })).toThrow(
      TreeRuleError,
    );

    // Unrelated people are still fine.
    const stranger = createPerson(tree);
    expect(addChild(tree, sonsFamily.id, stranger.id).childId).toBe(stranger.id);
    expect(getParents(tree, t.father.id)).toHaveLength(2);
  });

  it('removes a child link without touching the person', () => {
    const tree = memoryTree();
    const t = threeGenerations(tree);
    removeChild(tree, t.parents.id, t.son.id);
    expect(listChildren(tree, t.parents.id).map((c) => c.childId)).toEqual([t.daughter.id]);
    expect(getParents(tree, t.son.id)).toEqual([]);
    expect(() => removeChild(tree, t.parents.id, t.son.id)).toThrow(NotFoundError);
    expect(countPersons(tree)).toBe(6);
  });

  it('deletes a family with its links and events but keeps the people', () => {
    const tree = memoryTree();
    const t = threeGenerations(tree);
    const marriage = addFamilyEvent(tree, t.parents.id, { type: 'marriage', date: '4 Jun 1920' });
    expect(listFamilyEvents(tree, t.parents.id)).toHaveLength(1);

    deleteFamily(tree, t.parents.id);

    expect(getFamily(tree, t.parents.id)).toBeNull();
    expect(getEvent(tree, marriage.id)).toBeNull();
    expect(getParents(tree, t.son.id)).toEqual([]);
    expect(countPersons(tree)).toBe(6);
    expect(getFamily(tree, t.elders.id)).not.toBeNull();
    expect(() => deleteFamily(tree, t.parents.id)).toThrow(NotFoundError);
  });
});
