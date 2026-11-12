import { describe, expect, it } from 'vitest';
import type { DescendantNode, Sex } from '@rulz/core';
import { addChildOf, addParent, addPartner, addPersonFromDraft } from './actions';
import { getAncestorSlots, getChartData, getDescendantTree } from './charts';
import { deletePerson } from './persons';
import { cleanUpAfterEach, memoryTree } from './testing';
import type { Tree } from './tree';

cleanUpAfterEach();

function add(tree: Tree, given: string, sex: Sex = 'U'): string {
  return addPersonFromDraft(tree, { given, surname: 'Hale', sex }).id;
}

function parent(tree: Tree, childId: string, given: string, sex: Sex): string {
  return addParent(tree, childId, { create: { given, surname: 'Hale', sex } }).personId;
}

/** A person with both parents and all four grandparents. Returns ids by name. */
function threeGenerations(tree: Tree): Record<string, string> {
  const me = add(tree, 'Me', 'M');
  const father = parent(tree, me, 'Father', 'M');
  const mother = parent(tree, me, 'Mother', 'F');
  return {
    me,
    father,
    mother,
    fatherFather: parent(tree, father, 'FatherFather', 'M'),
    fatherMother: parent(tree, father, 'FatherMother', 'F'),
    motherFather: parent(tree, mother, 'MotherFather', 'M'),
    motherMother: parent(tree, mother, 'MotherMother', 'F'),
  };
}

describe('getAncestorSlots', () => {
  it('numbers ancestors as an Ahnentafel does: father 2, mother 3, their parents 4 to 7', () => {
    const tree = memoryTree();
    const ids = threeGenerations(tree);
    const slots = getAncestorSlots(tree, ids['me'] ?? '', 4);
    expect(slots.map((entry) => [entry.slot, entry.personId])).toEqual([
      [1, ids['me']],
      [2, ids['father']],
      [3, ids['mother']],
      [4, ids['fatherFather']],
      [5, ids['fatherMother']],
      [6, ids['motherFather']],
      [7, ids['motherMother']],
    ]);
    expect(slots.every((entry) => !entry.more)).toBe(true);
  });

  it('stops at the generation asked for and marks who has parents beyond it', () => {
    const tree = memoryTree();
    const ids = threeGenerations(tree);
    const slots = getAncestorSlots(tree, ids['me'] ?? '', 1);
    expect(slots.map((entry) => [entry.slot, entry.more])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);
    expect(getAncestorSlots(tree, ids['me'] ?? '', 0)).toEqual([
      { slot: 1, personId: ids['me'], more: true },
    ]);
  });

  it('leaves the slot of an unknown parent empty', () => {
    const tree = memoryTree();
    const me = add(tree, 'Me');
    const mother = parent(tree, me, 'Mother', 'F');
    expect(getAncestorSlots(tree, me, 3).map((entry) => [entry.slot, entry.personId])).toEqual([
      [1, me],
      [3, mother],
    ]);
  });

  it('follows the birth parents of a person who also has adoptive parents', () => {
    const tree = memoryTree();
    const me = add(tree, 'Me');
    const adoptiveFather = add(tree, 'Adoptive', 'M');
    const adoptive = addPartner(tree, adoptiveFather, {
      create: { given: 'AdoptiveMother', surname: 'Hale', sex: 'F' },
    });
    addChildOf(
      tree,
      adoptiveFather,
      { existingId: me },
      { familyId: adoptive.familyId, pedigree: 'adopted' },
    );
    const birthFather = add(tree, 'Birth', 'M');
    addChildOf(tree, birthFather, { existingId: me });
    expect(getAncestorSlots(tree, me, 1).map((entry) => entry.personId)).toEqual([me, birthFather]);
  });
});

function shape(node: DescendantNode, name: (id: string) => string): unknown {
  return {
    who: name(node.personId),
    ...(node.more ? { more: true } : {}),
    unions: node.unions.map((union) => ({
      partner: union.partnerId === null ? null : name(union.partnerId),
      children: union.children.map((child) => shape(child, name)),
    })),
  };
}

describe('getDescendantTree', () => {
  function family(tree: Tree) {
    const names = new Map<string, string>();
    const make = (given: string, sex: Sex = 'U') => {
      const id = add(tree, given, sex);
      names.set(id, given);
      return id;
    };
    const root = make('Root', 'M');
    const wife = make('Wife', 'F');
    const first = addPartner(tree, root, { existingId: wife }).familyId;
    const kids = ['Ann', 'Ben'].map((given) => {
      const id = make(given);
      addChildOf(tree, root, { existingId: id }, { familyId: first });
      return id;
    });
    const solo = make('Cat');
    addChildOf(tree, root, { existingId: solo });
    const grandchild = make('Dee');
    addChildOf(tree, kids[0] ?? '', { existingId: grandchild });
    return { root, wife, kids, solo, grandchild, name: (id: string) => names.get(id) ?? id };
  }

  it('reads each partnership with its children, in the order recorded', () => {
    const tree = memoryTree();
    const { root, name } = family(tree);
    const result = getDescendantTree(tree, root, 5);
    expect(result.truncated).toBe(false);
    expect(shape(result.root, name)).toEqual({
      who: 'Root',
      unions: [
        {
          partner: 'Wife',
          children: [
            { who: 'Ann', unions: [{ partner: null, children: [{ who: 'Dee', unions: [] }] }] },
            { who: 'Ben', unions: [] },
          ],
        },
        { partner: null, children: [{ who: 'Cat', unions: [] }] },
      ],
    });
  });

  it('stops at the generation asked for and marks who has children beyond it', () => {
    const tree = memoryTree();
    const { root, name } = family(tree);
    expect(shape(getDescendantTree(tree, root, 1).root, name)).toEqual({
      who: 'Root',
      unions: [
        {
          partner: 'Wife',
          children: [
            { who: 'Ann', more: true, unions: [] },
            { who: 'Ben', unions: [] },
          ],
        },
        { partner: null, children: [{ who: 'Cat', unions: [] }] },
      ],
    });
    expect(shape(getDescendantTree(tree, root, 0).root, name)).toEqual({
      who: 'Root',
      more: true,
      unions: [],
    });
  });

  it('cuts a very large family off and says so', () => {
    const tree = memoryTree();
    const { root } = family(tree);
    const result = getDescendantTree(tree, root, 5, 3);
    expect(result.truncated).toBe(true);
    const count = (node: DescendantNode): number =>
      1 +
      node.unions.reduce(
        (sum, union) => sum + union.children.map(count).reduce((a, b) => a + b, 0),
        0,
      );
    expect(count(result.root)).toBeLessThanOrEqual(3);
    expect(result.root.more).toBe(true);
  });
});

describe('getChartData', () => {
  it('reads both directions and names everyone once', () => {
    const tree = memoryTree();
    const ids = threeGenerations(tree);
    const me = ids['me'] ?? '';
    const child = addChildOf(tree, me, { create: { given: 'Child', surname: 'Hale' } }).personId;
    const data = getChartData(tree, me, { ancestors: 2, descendants: 2 });
    expect(data?.rootId).toBe(me);
    expect(data?.ancestors).toHaveLength(7);
    expect(data?.descendants.unions[0]?.children[0]?.personId).toBe(child);
    const listed = data?.persons.map((person) => person.id) ?? [];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...Object.values(ids), child].sort());
    expect(data?.persons.find((person) => person.id === me)?.name?.given).toBe('Me');
    expect(data?.truncated).toBe(false);
  });

  it('reads no ancestors when none are asked for', () => {
    const tree = memoryTree();
    const ids = threeGenerations(tree);
    const data = getChartData(tree, ids['me'] ?? '', { ancestors: 0, descendants: 1 });
    expect(data?.ancestors).toEqual([]);
    expect(data?.persons.map((person) => person.id)).toEqual([ids['me']]);
  });

  it('has nothing for a person who is not in the tree', () => {
    const tree = memoryTree();
    const gone = add(tree, 'Gone');
    deletePerson(tree, gone);
    expect(getChartData(tree, gone, { ancestors: 3, descendants: 3 })).toBeNull();
  });
});
