import { describe, expect, it } from 'vitest';
import { relationshipTerm, type Sex } from '@rulz/core';
import { addChildOf, addPartner, addPersonFromDraft } from './actions';
import { addFamilyEvent } from './events';
import { findRelationship } from './relationship';
import { cleanUpAfterEach, memoryTree } from './testing';
import { NotFoundError, type Tree } from './tree';

cleanUpAfterEach();

/** Builds families by first name, so a test reads like a family tree. */
class Family {
  readonly tree: Tree;
  readonly ids = new Map<string, string>();

  constructor(tree: Tree) {
    this.tree = tree;
  }

  id(name: string): string {
    const id = this.ids.get(name);
    if (id === undefined) throw new Error(`nobody called ${name}`);
    return id;
  }

  person(name: string, sex: Sex = 'U'): string {
    const id = addPersonFromDraft(this.tree, { given: name, surname: 'Test', sex }).id;
    this.ids.set(name, id);
    return id;
  }

  /** Makes two people partners, adding whoever is new. "Tom:M" gives a sex. */
  couple(a: string, b: string, options: { married?: boolean } = {}): string {
    const [first, second] = [a, b].map((entry) => {
      const [name = '', sex = 'U'] = entry.split(':');
      if (!this.ids.has(name)) this.person(name, sex as Sex);
      return this.id(name);
    });
    const familyId = addPartner(this.tree, first ?? '', { existingId: second ?? '' }).familyId;
    if (options.married) addFamilyEvent(this.tree, familyId, { type: 'marriage', date: '1900' });
    return familyId;
  }

  children(familyId: string, parent: string, ...names: string[]): void {
    for (const entry of names) {
      const [name = '', sex = 'U'] = entry.split(':');
      if (!this.ids.has(name)) this.person(name, sex as Sex);
      addChildOf(this.tree, this.id(parent), { existingId: this.id(name) }, { familyId });
    }
  }

  /** How `b` is related to `a`, in words. */
  term(a: string, b: string): string {
    const found = findRelationship(this.tree, this.id(a), this.id(b));
    const sex = this.tree.db
      .prepare('SELECT sex FROM person WHERE id = ?')
      .pluck()
      .get(this.id(b)) as Sex;
    return relationshipTerm(found.relationship, sex);
  }

  names(ids: readonly string[]): string[] {
    const byId = new Map([...this.ids].map(([name, id]) => [id, name]));
    return ids.map((id) => byId.get(id) ?? id);
  }
}

/**
 * Grandparents Gus and Gwen have Frank and Una. Frank and Mary have Adam and
 * Sue; Frank and Nell (not married) have Hal. Una and Ulf have Carl, who with
 * Cora has Cody. Adam is married to Wendy, whose parents are Walt and Wilma
 * and whose brother is Will; Adam and Wendy have Kim.
 */
function bigFamily(tree: Tree): Family {
  const family = new Family(tree);
  family.children(family.couple('Gus:M', 'Gwen:F', { married: true }), 'Gus', 'Frank:M', 'Una:F');
  family.children(family.couple('Frank', 'Mary:F', { married: true }), 'Frank', 'Adam:M', 'Sue:F');
  family.children(family.couple('Frank', 'Nell:F'), 'Frank', 'Hal:M');
  family.children(family.couple('Ulf:M', 'Una', { married: true }), 'Una', 'Carl:M');
  family.children(family.couple('Carl', 'Cora:F', { married: true }), 'Carl', 'Cody:M');
  family.children(
    family.couple('Walt:M', 'Wilma:F', { married: true }),
    'Walt',
    'Wendy:F',
    'Will:M',
  );
  family.children(family.couple('Adam', 'Wendy', { married: true }), 'Adam', 'Kim:F');
  family.person('Stranger');
  return family;
}

describe('findRelationship', () => {
  it('names the direct line in both directions', () => {
    const family = bigFamily(memoryTree());
    expect(family.term('Adam', 'Frank')).toBe('father');
    expect(family.term('Adam', 'Mary')).toBe('mother');
    expect(family.term('Frank', 'Adam')).toBe('son');
    expect(family.term('Adam', 'Gwen')).toBe('grandmother');
    expect(family.term('Gus', 'Kim')).toBe('great-granddaughter');
    expect(family.term('Kim', 'Gus')).toBe('great-grandfather');
  });

  it('tells full brothers and sisters from half ones', () => {
    const family = bigFamily(memoryTree());
    expect(family.term('Adam', 'Sue')).toBe('sister');
    expect(family.term('Adam', 'Hal')).toBe('half-brother');
    expect(family.term('Hal', 'Sue')).toBe('half-sister');
  });

  it('names uncles, nephews and cousins', () => {
    const family = bigFamily(memoryTree());
    expect(family.term('Adam', 'Una')).toBe('aunt');
    expect(family.term('Una', 'Adam')).toBe('nephew');
    expect(family.term('Adam', 'Carl')).toBe('first cousin');
    expect(family.term('Adam', 'Cody')).toBe('first cousin once removed');
    expect(family.term('Cody', 'Adam')).toBe('first cousin once removed');
    expect(family.term('Kim', 'Cody')).toBe('second cousin');
    expect(family.term('Kim', 'Una')).toBe('grandaunt');
    expect(family.term('Hal', 'Carl')).toBe('first cousin');
  });

  it('gives the people who link the two, through the ancestors they share', () => {
    const family = bigFamily(memoryTree());
    const found = findRelationship(family.tree, family.id('Adam'), family.id('Carl'));
    expect(found.relationship).toEqual({ kind: 'blood', up: 2, down: 2, half: false });
    expect(family.names(found.commonAncestorIds).sort()).toEqual(['Gus', 'Gwen']);
    const path = family.names(found.path);
    expect(path).toHaveLength(5);
    expect([path[0], path[1], path[3], path[4]]).toEqual(['Adam', 'Frank', 'Una', 'Carl']);
    expect(['Gus', 'Gwen']).toContain(path[2]);
    expect(found.others).toEqual([]);
    expect(found.viaId).toBeNull();

    const direct = findRelationship(family.tree, family.id('Kim'), family.id('Gus'));
    expect(family.names(direct.path)).toEqual(['Kim', 'Adam', 'Frank', 'Gus']);
    expect(family.names(direct.commonAncestorIds)).toEqual(['Gus']);
  });

  it('names partners, as husband and wife only when a marriage is recorded', () => {
    const family = bigFamily(memoryTree());
    expect(family.term('Adam', 'Wendy')).toBe('wife');
    expect(family.term('Wendy', 'Adam')).toBe('husband');
    expect(family.term('Frank', 'Nell')).toBe('partner');
  });

  it('names relatives by marriage, one partnership away', () => {
    const family = bigFamily(memoryTree());
    expect(family.term('Adam', 'Walt')).toBe('father-in-law');
    expect(family.term('Walt', 'Adam')).toBe('son-in-law');
    expect(family.term('Adam', 'Will')).toBe('brother-in-law');
    expect(family.term('Will', 'Adam')).toBe('brother-in-law');
    expect(family.term('Adam', 'Nell')).toBe('stepmother');
    expect(family.term('Nell', 'Adam')).toBe('stepson');
    expect(family.term('Adam', 'Ulf')).toBe('husband of an aunt');
    expect(family.term('Adam', 'Cora')).toBe('wife of a first cousin');
    expect(family.term('Wendy', 'Gus')).toBe("husband's grandfather");
    expect(family.term('Mary', 'Hal')).toBe('stepson');

    const found = findRelationship(family.tree, family.id('Adam'), family.id('Cora'));
    expect(family.names([found.viaId ?? ''])).toEqual(['Carl']);
    expect(found.path).toEqual([]);
  });

  it('finds no relationship further away than that, and none with a stranger', () => {
    const family = bigFamily(memoryTree());
    expect(findRelationship(family.tree, family.id('Sue'), family.id('Will')).relationship).toEqual(
      {
        kind: 'none',
      },
    );
    expect(family.term('Adam', 'Stranger')).toBe('');
  });

  it('knows a person from themself', () => {
    const family = bigFamily(memoryTree());
    expect(
      findRelationship(family.tree, family.id('Adam'), family.id('Adam')).relationship,
    ).toEqual({
      kind: 'self',
    });
  });

  it('reports every way two people are related, the closest first', () => {
    // Two brothers marry two sisters: their children are cousins twice over.
    const family = new Family(memoryTree());
    family.children(family.couple('Pa:M', 'Ma:F'), 'Pa', 'Bob:M', 'Bill:M');
    family.children(family.couple('Qa:M', 'Qe:F'), 'Qa', 'Sal:F', 'Sara:F');
    family.children(family.couple('Bob', 'Sal'), 'Bob', 'Xan');
    family.children(family.couple('Bill', 'Sara'), 'Bill', 'Yul');
    const found = findRelationship(family.tree, family.id('Xan'), family.id('Yul'));
    expect(found.relationship).toEqual({ kind: 'blood', up: 2, down: 2, half: false });
    expect(found.others).toEqual([{ up: 2, down: 2, half: false }]);
  });

  it('gives the blood relationship of two cousins who are also partners', () => {
    const family = bigFamily(memoryTree());
    family.couple('Sue', 'Carl', { married: true });
    expect(family.term('Sue', 'Carl')).toBe('first cousin');
  });

  it('follows adoptive parents like any others', () => {
    const family = new Family(memoryTree());
    const parents = family.couple('Dad:M', 'Mum:F');
    family.children(parents, 'Dad', 'Own:F');
    family.person('Adopted', 'M');
    addChildOf(
      family.tree,
      family.id('Dad'),
      { existingId: family.id('Adopted') },
      {
        familyId: parents,
        pedigree: 'adopted',
      },
    );
    expect(family.term('Own', 'Adopted')).toBe('brother');
  });

  it('needs both people to be in the tree', () => {
    const family = bigFamily(memoryTree());
    expect(() =>
      findRelationship(family.tree, family.id('Adam'), '00000000-0000-7000-8000-000000000000'),
    ).toThrow(NotFoundError);
  });
});
