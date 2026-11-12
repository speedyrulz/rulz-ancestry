import { PEDIGREES, newId, type Pedigree } from '@rulz/core';
import { sql } from './connection';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

export interface Family {
  id: string;
  partner1Id: string | null;
  partner2Id: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FamilyChild {
  id: string;
  familyId: string;
  childId: string;
  pedigree: string;
  sortOrder: number;
}

/** A person's link to one parent. */
export interface ParentLink {
  parentId: string;
  familyId: string;
  pedigree: string;
}

interface FamilyRow {
  id: string;
  partner1_id: string | null;
  partner2_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ChildRow {
  id: string;
  family_id: string;
  child_id: string;
  pedigree: string;
  sort_order: number;
}

const FAMILY_COLUMNS = 'id, partner1_id, partner2_id, created_at, updated_at';
const CHILD_COLUMNS = 'id, family_id, child_id, pedigree, sort_order';

function toFamily(row: FamilyRow): Family {
  return {
    id: row.id,
    partner1Id: row.partner1_id,
    partner2Id: row.partner2_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChild(row: ChildRow): FamilyChild {
  return {
    id: row.id,
    familyId: row.family_id,
    childId: row.child_id,
    pedigree: row.pedigree,
    sortOrder: row.sort_order,
  };
}

function assertPersonExists(tree: Tree, id: string): void {
  if (!sql(tree.db, 'SELECT 1 FROM person WHERE id = ?').get(id)) {
    throw new NotFoundError('person', id);
  }
}

export function getFamily(tree: Tree, id: string): Family | null {
  const row = sql(tree.db, `SELECT ${FAMILY_COLUMNS} FROM family WHERE id = ?`).get(id) as
    FamilyRow | undefined;
  return row ? toFamily(row) : null;
}

export function requireFamily(tree: Tree, id: string): Family {
  const family = getFamily(tree, id);
  if (!family) throw new NotFoundError('family', id);
  return family;
}

/**
 * True when `ancestorId` is `personId` or one of their ancestors through any
 * kind of parent link. Used to stop a person becoming their own ancestor,
 * which would make every chart loop for ever.
 */
export function isSelfOrAncestor(tree: Tree, ancestorId: string, personId: string): boolean {
  if (ancestorId === personId) return true;
  // Someone with no children is nobody's ancestor. This answers the common
  // case, linking a newly added person, without walking the whole line.
  const hasChildren = sql(
    tree.db,
    `SELECT 1 FROM family f
     WHERE (f.partner1_id = @id OR f.partner2_id = @id)
       AND EXISTS (SELECT 1 FROM family_child fc WHERE fc.family_id = f.id)
     LIMIT 1`,
  ).get({ id: ancestorId });
  if (!hasChildren) return false;

  const found = sql(
    tree.db,
    `WITH RECURSIVE line(id) AS (
       VALUES (?)
       UNION
       SELECT f.partner1_id FROM line
         JOIN family_child fc ON fc.child_id = line.id
         JOIN family f ON f.id = fc.family_id
       WHERE f.partner1_id IS NOT NULL
       UNION
       SELECT f.partner2_id FROM line
         JOIN family_child fc ON fc.child_id = line.id
         JOIN family f ON f.id = fc.family_id
       WHERE f.partner2_id IS NOT NULL
     )
     SELECT 1 FROM line WHERE id = ? LIMIT 1`,
  ).get(personId, ancestorId);
  return found !== undefined;
}

function assertPartnersAllowed(
  tree: Tree,
  familyId: string | null,
  partner1Id: string | null,
  partner2Id: string | null,
): void {
  if (partner1Id !== null && partner1Id === partner2Id) {
    throw new TreeRuleError('a person cannot be both partners of a family');
  }
  for (const partnerId of [partner1Id, partner2Id]) {
    if (partnerId === null) continue;
    assertPersonExists(tree, partnerId);
    if (familyId === null) continue;
    for (const child of listChildren(tree, familyId)) {
      if (isSelfOrAncestor(tree, child.childId, partnerId)) {
        throw new TreeRuleError('a person cannot be a parent of their own ancestor or of themself');
      }
    }
  }
}

export function createFamily(
  tree: Tree,
  input: { partner1Id?: string | null; partner2Id?: string | null } = {},
): Family {
  const partner1Id = input.partner1Id ?? null;
  const partner2Id = input.partner2Id ?? null;
  return tree.transact('Add family', () => {
    assertPartnersAllowed(tree, null, partner1Id, partner2Id);
    const id = newId();
    const now = Date.now();
    sql(tree.db, `INSERT INTO family (${FAMILY_COLUMNS}) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      partner1Id,
      partner2Id,
      now,
      now,
    );
    return requireFamily(tree, id);
  });
}

/** Sets or clears partners. A partner left out of `patch` is not changed; null clears one. */
export function setPartners(
  tree: Tree,
  familyId: string,
  patch: { partner1Id?: string | null; partner2Id?: string | null },
): Family {
  return tree.transact('Edit family', () => {
    const current = requireFamily(tree, familyId);
    const partner1Id = patch.partner1Id === undefined ? current.partner1Id : patch.partner1Id;
    const partner2Id = patch.partner2Id === undefined ? current.partner2Id : patch.partner2Id;
    if (partner1Id === current.partner1Id && partner2Id === current.partner2Id) return current;
    assertPartnersAllowed(tree, familyId, partner1Id, partner2Id);
    sql(
      tree.db,
      'UPDATE family SET partner1_id = ?, partner2_id = ?, updated_at = ? WHERE id = ?',
    ).run(partner1Id, partner2Id, Date.now(), familyId);
    return requireFamily(tree, familyId);
  });
}

/** Deletes a family with its child links and its own events. The people stay. */
export function deleteFamily(tree: Tree, id: string): void {
  tree.transact('Delete family', () => {
    requireFamily(tree, id);
    removeFamily(tree, id);
  });
}

function removeFamily(tree: Tree, id: string): void {
  sql(
    tree.db,
    `DELETE FROM event
     WHERE id IN (SELECT event_id FROM event_participant WHERE family_id = @id)
       AND NOT EXISTS (
         SELECT 1 FROM event_participant other
         WHERE other.event_id = event.id AND other.family_id IS NOT @id
       )`,
  ).run({ id });
  sql(tree.db, 'DELETE FROM family WHERE id = ?').run(id);
}

/** Removes the given families that have no partner and no child left. */
export function deleteEmptyFamilies(tree: Tree, familyIds: readonly string[]): void {
  const isEmpty = sql(
    tree.db,
    `SELECT 1 FROM family f
     WHERE f.id = ? AND f.partner1_id IS NULL AND f.partner2_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM family_child fc WHERE fc.family_id = f.id)`,
  );
  tree.transact('Delete empty families', () => {
    for (const id of familyIds) {
      if (isEmpty.get(id)) removeFamily(tree, id);
    }
  });
}

export function listChildren(tree: Tree, familyId: string): FamilyChild[] {
  const rows = sql(
    tree.db,
    `SELECT ${CHILD_COLUMNS} FROM family_child WHERE family_id = ? ORDER BY sort_order, id`,
  ).all(familyId) as ChildRow[];
  return rows.map(toChild);
}

export function addChild(
  tree: Tree,
  familyId: string,
  childId: string,
  options: { pedigree?: Pedigree } = {},
): FamilyChild {
  const pedigree = options.pedigree ?? 'birth';
  if (!(PEDIGREES as readonly string[]).includes(pedigree)) {
    throw new TreeRuleError(`unknown pedigree: ${pedigree}`);
  }
  return tree.transact('Add child', () => {
    const family = requireFamily(tree, familyId);
    assertPersonExists(tree, childId);
    const existing = listChildren(tree, familyId);
    if (existing.some((child) => child.childId === childId)) {
      throw new TreeRuleError('this person is already a child of the family');
    }
    for (const partnerId of [family.partner1Id, family.partner2Id]) {
      if (partnerId !== null && isSelfOrAncestor(tree, childId, partnerId)) {
        throw new TreeRuleError(
          'a person cannot be a child of their own descendant or of themself',
        );
      }
    }
    const id = newId();
    const sortOrder = existing.reduce((last, child) => Math.max(last, child.sortOrder), -1) + 1;
    sql(tree.db, `INSERT INTO family_child (${CHILD_COLUMNS}) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      familyId,
      childId,
      pedigree,
      sortOrder,
    );
    return { id, familyId, childId, pedigree, sortOrder };
  });
}

export function removeChild(tree: Tree, familyId: string, childId: string): void {
  tree.transact('Remove child', () => {
    const result = sql(
      tree.db,
      'DELETE FROM family_child WHERE family_id = ? AND child_id = ?',
    ).run(familyId, childId);
    if (result.changes === 0) throw new NotFoundError('child link', `${familyId}/${childId}`);
  });
}

/** The families in which a person is a partner, oldest first. */
export function listFamiliesAsPartner(tree: Tree, personId: string): Family[] {
  const rows = sql(
    tree.db,
    `SELECT ${FAMILY_COLUMNS} FROM family
     WHERE partner1_id = @personId OR partner2_id = @personId ORDER BY created_at, id`,
  ).all({ personId }) as FamilyRow[];
  return rows.map(toFamily);
}

/** The families in which a person is a child. Usually one; more with adoption or step-parents. */
export function listFamiliesAsChild(tree: Tree, personId: string): FamilyChild[] {
  const rows = sql(
    tree.db,
    `SELECT ${CHILD_COLUMNS} FROM family_child WHERE child_id = ? ORDER BY id`,
  ).all(personId) as ChildRow[];
  return rows.map(toChild);
}

export function getParents(tree: Tree, personId: string): ParentLink[] {
  return sql(
    tree.db,
    `SELECT parent.id AS parentId, fc.family_id AS familyId, fc.pedigree AS pedigree
     FROM family_child fc
       JOIN family f ON f.id = fc.family_id
       JOIN person parent ON parent.id IN (f.partner1_id, f.partner2_id)
     WHERE fc.child_id = ?
     ORDER BY fc.id, parent.id = f.partner2_id`,
  ).all(personId) as ParentLink[];
}

/** Ids of a person's children across all their families, without repeats. */
export function getChildIds(tree: Tree, personId: string): string[] {
  return sql(
    tree.db,
    `SELECT fc.child_id FROM family f
       JOIN family_child fc ON fc.family_id = f.id
     WHERE f.partner1_id = @personId OR f.partner2_id = @personId
     GROUP BY fc.child_id
     ORDER BY min(f.created_at), min(fc.sort_order), fc.child_id`,
  )
    .pluck()
    .all({ personId }) as string[];
}
