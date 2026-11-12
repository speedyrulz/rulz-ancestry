import { compareCloseness, type BloodRelation, type Relationship, type Sex } from '@rulz/core';
import { sql } from './connection';
import { getChildIds } from './families';
import { requirePerson } from './persons';
import type { Tree } from './tree';

/**
 * Works out how two people of a tree are related.
 *
 * A blood relationship is found from the ancestors the two share. Among
 * those, only the nearest count: an ancestor one of whose children is also a
 * shared ancestor adds nothing, because the two are already related through
 * that child. Each nearest shared ancestor, or couple, is one relationship;
 * two people can have several (cousins twice over), and the closest is given
 * first.
 *
 * Where there is no blood relationship, a partnership is looked for: the two
 * are partners, or one is the partner of a blood relative of the other.
 * Anything further (the brother of a sister-in-law) is reported as none.
 */

export interface RelationshipResult {
  /** How the second person is related to the first. */
  relationship: Relationship;
  /**
   * For a blood relationship: the people who link the two, from the first
   * person up to a shared ancestor and down to the second. Otherwise empty.
   */
  path: string[];
  /** The nearest shared ancestors the relationship runs through: one, or a couple. */
  commonAncestorIds: string[];
  /** For a relationship through a partnership: the relative or partner in between. */
  viaId: string | null;
  /** Further blood relationships between the two, closest first. */
  others: BloodRelation[];
}

interface Step {
  depth: number;
  /** The child through whom this ancestor was reached, or null for the person themself. */
  child: string | null;
}

/** How many generations up the search goes. Far more than any recorded line. */
const MAX_DEPTH = 80;

/** A person and all their ancestors, each with the shortest distance to them. */
function ancestorsOf(tree: Tree, personId: string): Map<string, Step> {
  const parentsOf = sql(
    tree.db,
    `SELECT parent.id FROM family_child fc
       JOIN family f ON f.id = fc.family_id
       JOIN person parent ON parent.id IN (f.partner1_id, f.partner2_id)
     WHERE fc.child_id = ?
     ORDER BY fc.pedigree <> 'birth', fc.id, parent.id = f.partner2_id`,
  ).pluck();
  const found = new Map<string, Step>([[personId, { depth: 0, child: null }]]);
  let level = [personId];
  for (let depth = 1; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const childId of level) {
      for (const parentId of parentsOf.all(childId) as string[]) {
        if (found.has(parentId)) continue;
        found.set(parentId, { depth, child: childId });
        next.push(parentId);
      }
    }
    level = next;
  }
  return found;
}

/** The line from an ancestor down to the person whose map this is, ancestor first. */
function lineDown(map: Map<string, Step>, ancestorId: string): string[] {
  const line: string[] = [];
  let current: string | null = ancestorId;
  while (current !== null && line.length <= MAX_DEPTH) {
    line.push(current);
    current = map.get(current)?.child ?? null;
  }
  return line;
}

interface Blood extends BloodRelation {
  commonAncestorIds: string[];
  path: string[];
}

/** Every blood relationship between two people, closest first. */
function bloodRelations(tree: Tree, aId: string, bId: string): Blood[] {
  const above = ancestorsOf(tree, aId);
  const below = ancestorsOf(tree, bId);
  const shared = [...above.keys()].filter((id) => below.has(id));
  if (shared.length === 0) return [];
  const sharedSet = new Set(shared);
  const nearest = shared.filter(
    (id) => !getChildIds(tree, id).some((childId) => sharedSet.has(childId)),
  );

  // Two nearest ancestors reached through the same child on both sides are a couple.
  const groups = new Map<string, string[]>();
  for (const id of nearest) {
    const up = above.get(id);
    const down = below.get(id);
    if (!up || !down) continue;
    const collateral = up.depth > 0 && down.depth > 0;
    const key = collateral ? `${up.child ?? ''}|${down.child ?? ''}` : `direct|${id}`;
    const group = groups.get(key);
    if (group) group.push(id);
    else groups.set(key, [id]);
  }

  const relations: Blood[] = [];
  for (const ids of groups.values()) {
    const first = ids[0];
    if (first === undefined) continue;
    const up = above.get(first)?.depth ?? 0;
    const down = below.get(first)?.depth ?? 0;
    const toA = lineDown(above, first).reverse();
    const toB = lineDown(below, first).slice(1);
    relations.push({
      up,
      down,
      half: up > 0 && down > 0 && ids.length < 2,
      commonAncestorIds: ids,
      path: [...toA, ...toB],
    });
  }
  return relations.sort(compareCloseness);
}

interface PartnerRow {
  familyId: string;
  partnerId: string;
}

function partnersOf(tree: Tree, personId: string): PartnerRow[] {
  return sql(
    tree.db,
    `SELECT id AS familyId, CASE WHEN partner1_id = @id THEN partner2_id ELSE partner1_id END AS partnerId
     FROM family
     WHERE (partner1_id = @id AND partner2_id IS NOT NULL)
        OR (partner2_id = @id AND partner1_id IS NOT NULL)
     ORDER BY created_at, id`,
  ).all({ id: personId }) as PartnerRow[];
}

function isMarried(tree: Tree, familyId: string): boolean {
  return (
    sql(
      tree.db,
      `SELECT 1 FROM event_participant ep JOIN event e ON e.id = ep.event_id
       WHERE ep.family_id = ? AND e.type = 'marriage' LIMIT 1`,
    ).get(familyId) !== undefined
  );
}

function sexOf(tree: Tree, personId: string): Sex {
  return requirePerson(tree, personId).sex;
}

/** How `bId` is related to `aId`: "b is a's ...". Both must exist. */
export function findRelationship(tree: Tree, aId: string, bId: string): RelationshipResult {
  requirePerson(tree, aId);
  requirePerson(tree, bId);
  const nothing = { path: [], commonAncestorIds: [], viaId: null, others: [] };
  if (aId === bId) return { relationship: { kind: 'self' }, ...nothing };

  return tree.db.transaction((): RelationshipResult => {
    const blood = bloodRelations(tree, aId, bId);
    const closest = blood[0];
    if (closest) {
      return {
        relationship: { kind: 'blood', up: closest.up, down: closest.down, half: closest.half },
        path: closest.path,
        commonAncestorIds: closest.commonAncestorIds,
        viaId: null,
        others: blood.slice(1, 6).map(({ up, down, half }) => ({ up, down, half })),
      };
    }

    const partnersOfA = partnersOf(tree, aId);
    const couple = partnersOfA.find((row) => row.partnerId === bId);
    if (couple) {
      return {
        relationship: { kind: 'partner', married: isMarried(tree, couple.familyId) },
        ...nothing,
      };
    }

    // Through one partnership: b is the partner of a's relative, or a relative of a's partner.
    let best: { relationship: Relationship; relation: BloodRelation; viaId: string } | null = null;
    const consider = (
      kind: 'partner-of-relative' | 'relative-of-partner',
      viaId: string,
      familyId: string,
      relation: Blood | undefined,
    ): void => {
      if (!relation) return;
      if (best !== null && compareCloseness(relation, best.relation) >= 0) return;
      const { up, down, half } = relation;
      best = {
        relation,
        viaId,
        relationship: {
          kind,
          up,
          down,
          half,
          married: isMarried(tree, familyId),
          viaSex: sexOf(tree, viaId),
        },
      };
    };
    for (const row of partnersOf(tree, bId)) {
      consider(
        'partner-of-relative',
        row.partnerId,
        row.familyId,
        bloodRelations(tree, aId, row.partnerId)[0],
      );
    }
    for (const row of partnersOfA) {
      consider(
        'relative-of-partner',
        row.partnerId,
        row.familyId,
        bloodRelations(tree, row.partnerId, bId)[0],
      );
    }
    const through = best as { relationship: Relationship; viaId: string } | null;
    if (through) return { ...nothing, relationship: through.relationship, viaId: through.viaId };
    return { relationship: { kind: 'none' }, ...nothing };
  })();
}
