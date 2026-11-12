import type { Pedigree, Sex } from '@rulz/core';
import { addPersonEvent } from './events';
import {
  addChild,
  createFamily,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  pruneFamilies,
  removeChild,
  requireFamily,
  setPartners,
  type Family,
} from './families';
import { createPerson, requirePerson, type Person } from './persons';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

/**
 * The edits the screens offer that touch more than one record: adding a person
 * with their birth and death, and linking relatives. Each one is a single undo
 * step, so "Add father" is undone in one go, not as three separate changes.
 */

/** What the "add person" form collects. */
export interface PersonDraft {
  given?: string;
  surname?: string;
  sex?: Sex;
  living?: boolean | null;
  birthDate?: string;
  birthPlace?: string;
  deathDate?: string;
  deathPlace?: string;
}

/** Someone already in the tree, or the details of someone to add. */
export type PersonRef = { existingId: string } | { create: PersonDraft };

/** The person and family an edit ended up linking. */
export interface RelativeLink {
  personId: string;
  familyId: string;
}

type Slot = 'partner1Id' | 'partner2Id';

function filled(text: string | undefined): boolean {
  return text !== undefined && text.trim() !== '';
}

function insertDraft(tree: Tree, draft: PersonDraft): Person {
  if (!filled(draft.given) && !filled(draft.surname)) {
    throw new TreeRuleError('a new person needs a given name or a surname');
  }
  const person = createPerson(tree, {
    ...(draft.sex === undefined ? {} : { sex: draft.sex }),
    ...(draft.living === undefined ? {} : { living: draft.living }),
    name: { given: draft.given ?? '', surname: draft.surname ?? '' },
  });
  if (filled(draft.birthDate) || filled(draft.birthPlace)) {
    addPersonEvent(tree, person.id, {
      type: 'birth',
      date: draft.birthDate ?? '',
      place: draft.birthPlace ?? '',
    });
  }
  if (filled(draft.deathDate) || filled(draft.deathPlace)) {
    addPersonEvent(tree, person.id, {
      type: 'death',
      date: draft.deathDate ?? '',
      place: draft.deathPlace ?? '',
    });
  }
  return person;
}

/** Adds a person with their name and, when given, a birth and a death. */
export function addPersonFromDraft(tree: Tree, draft: PersonDraft): Person {
  return tree.transact('Add person', () => insertDraft(tree, draft));
}

function resolve(tree: Tree, ref: PersonRef): Person {
  return 'existingId' in ref ? requirePerson(tree, ref.existingId) : insertDraft(tree, ref.create);
}

/** The sex of the person a reference names, read before anything is changed. */
function sexOf(tree: Tree, ref: PersonRef): Sex {
  if ('create' in ref) return ref.create.sex ?? 'U';
  return requirePerson(tree, ref.existingId).sex;
}

/** GEDCOM convention: the man is partner 1 and the woman partner 2. Otherwise first come, first. */
function freeSlot(family: Family, sex: Sex): Slot | null {
  const free1 = family.partner1Id === null;
  const free2 = family.partner2Id === null;
  if (sex === 'F') return free2 ? 'partner2Id' : free1 ? 'partner1Id' : null;
  return free1 ? 'partner1Id' : free2 ? 'partner2Id' : null;
}

function orderPartners(a: Person, b: Person): [Person, Person] {
  const swap = (a.sex === 'F' && b.sex !== 'F') || (b.sex === 'M' && a.sex !== 'M');
  return swap ? [b, a] : [a, b];
}

function createSingleParentFamily(tree: Tree, parent: Person): Family {
  return createFamily(
    tree,
    parent.sex === 'F' ? { partner2Id: parent.id } : { partner1Id: parent.id },
  );
}

function isPartner(family: Family, personId: string): boolean {
  return family.partner1Id === personId || family.partner2Id === personId;
}

/**
 * Makes `parent` a parent of `childId`. Without `familyId` the parent joins the
 * child's first set of parents that has a free place; if there is none, a new
 * family is made, which is how a second set of parents (adoptive, step) is
 * added. `pedigree` applies only when a new family is made.
 */
export function addParent(
  tree: Tree,
  childId: string,
  parent: PersonRef,
  options: { familyId?: string; pedigree?: Pedigree } = {},
): RelativeLink {
  const sex = sexOf(tree, parent);
  const label = sex === 'M' ? 'Add father' : sex === 'F' ? 'Add mother' : 'Add parent';
  return tree.transact(label, () => {
    requirePerson(tree, childId);
    const person = resolve(tree, parent);
    if (person.id === childId) throw new TreeRuleError('a person cannot be their own parent');

    const childFamilies = listFamiliesAsChild(tree, childId).map((link) =>
      requireFamily(tree, link.familyId),
    );
    if (childFamilies.some((family) => isPartner(family, person.id))) {
      throw new TreeRuleError('this person is already a parent of that child');
    }

    let family: Family | undefined;
    if (options.familyId !== undefined) {
      family = childFamilies.find((candidate) => candidate.id === options.familyId);
      if (!family) throw new TreeRuleError('the person is not a child of that family');
    } else {
      family = childFamilies.find((candidate) => freeSlot(candidate, person.sex) !== null);
    }

    if (family) {
      const slot = freeSlot(family, person.sex);
      if (slot === null) throw new TreeRuleError('that family already has two parents');
      setPartners(tree, family.id, { [slot]: person.id });
    } else {
      family = createSingleParentFamily(tree, person);
      addChild(
        tree,
        family.id,
        childId,
        options.pedigree === undefined ? {} : { pedigree: options.pedigree },
      );
    }
    return { personId: person.id, familyId: family.id };
  });
}

/**
 * Makes two people partners. With `familyId`, the partner takes the free place
 * in that family of `personId` (one with children and an unknown partner);
 * without it, a new family is made for the couple.
 */
export function addPartner(
  tree: Tree,
  personId: string,
  partner: PersonRef,
  options: { familyId?: string } = {},
): RelativeLink {
  return tree.transact('Add partner', () => {
    const person = requirePerson(tree, personId);
    const other = resolve(tree, partner);
    if (other.id === personId) throw new TreeRuleError('a person cannot be their own partner');

    const families = listFamiliesAsPartner(tree, personId);
    if (families.some((family) => isPartner(family, other.id))) {
      throw new TreeRuleError('these two people are already partners');
    }

    if (options.familyId !== undefined) {
      const family = families.find((candidate) => candidate.id === options.familyId);
      if (!family) throw new TreeRuleError('the person is not a partner in that family');
      const slot = freeSlot(family, other.sex);
      if (slot === null) throw new TreeRuleError('that family already has two partners');
      setPartners(tree, family.id, { [slot]: other.id });
      return { personId: other.id, familyId: family.id };
    }

    const [first, second] = orderPartners(person, other);
    const family = createFamily(tree, { partner1Id: first.id, partner2Id: second.id });
    return { personId: other.id, familyId: family.id };
  });
}

/**
 * Makes `child` a child of `parentId`. With `familyId`, the child joins that
 * family of the parent. Without it, the child joins the parent's family with
 * no other partner, which is made if the parent has none.
 */
export function addChildOf(
  tree: Tree,
  parentId: string,
  child: PersonRef,
  options: { familyId?: string; pedigree?: Pedigree } = {},
): RelativeLink {
  return tree.transact('Add child', () => {
    const parent = requirePerson(tree, parentId);
    const person = resolve(tree, child);
    if (person.id === parentId) throw new TreeRuleError('a person cannot be their own child');

    const families = listFamiliesAsPartner(tree, parentId);
    let family: Family | undefined;
    if (options.familyId !== undefined) {
      family = families.find((candidate) => candidate.id === options.familyId);
      if (!family) throw new TreeRuleError('the person is not a partner in that family');
    } else {
      family =
        families.find(
          (candidate) => candidate.partner1Id === null || candidate.partner2Id === null,
        ) ?? createSingleParentFamily(tree, parent);
    }
    addChild(
      tree,
      family.id,
      person.id,
      options.pedigree === undefined ? {} : { pedigree: options.pedigree },
    );
    return { personId: person.id, familyId: family.id };
  });
}

/**
 * Takes a child out of a family. The child and the parents stay in the tree.
 * The family goes too if it no longer links anybody (see `pruneFamilies`).
 */
export function unlinkChild(tree: Tree, familyId: string, childId: string): void {
  tree.transact('Remove child from family', () => {
    removeChild(tree, familyId, childId);
    pruneFamilies(tree, [familyId]);
  });
}

/**
 * Takes a partner out of a family. Both people stay in the tree, and the
 * family's children stay with the other partner. The family goes too if it no
 * longer links anybody.
 */
export function unlinkPartner(tree: Tree, familyId: string, personId: string): void {
  tree.transact('Remove partner from family', () => {
    const family = requireFamily(tree, familyId);
    if (!isPartner(family, personId)) {
      throw new NotFoundError('partner link', `${familyId}/${personId}`);
    }
    setPartners(
      tree,
      familyId,
      family.partner1Id === personId ? { partner1Id: null } : { partner2Id: null },
    );
    pruneFamilies(tree, [familyId]);
  });
}
