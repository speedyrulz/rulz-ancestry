import type { AncestorSlot, DescendantNode, DescendantUnion } from '@rulz/core';
import { sql } from './connection';
import { getPersonSummary, type PersonSummary } from './search';
import type { Tree } from './tree';

/**
 * Reads what the charts draw: a person's ancestors by Ahnentafel slot and
 * their descendants as a tree. Where each box goes is worked out in
 * `@rulz/core` (chart.ts); this file only says who is related to whom.
 */

/** The most generations a chart reads in one direction. */
export const MAX_CHART_GENERATIONS = 10;
/** The most people a descendant chart holds; a larger family is cut off and says so. */
export const MAX_CHART_DESCENDANTS = 1000;

export interface ChartRequest {
  /** Generations of ancestors to read: 0 for none, 1 for parents, 2 for grandparents. */
  ancestors: number;
  /** Generations of descendants to read: 0 for none, 1 for children. */
  descendants: number;
}

export interface ChartData {
  rootId: string;
  /** The person, then their ancestors. Empty when no ancestors were asked for. */
  ancestors: AncestorSlot[];
  descendants: DescendantNode;
  /** Everyone named in `ancestors` and `descendants`, each once. */
  persons: PersonSummary[];
  /** True when the descendants were cut off at {@link MAX_CHART_DESCENDANTS}. */
  truncated: boolean;
}

function clampGenerations(value: number): number {
  return Math.min(Math.max(0, Math.trunc(value)), MAX_CHART_GENERATIONS);
}

/**
 * The person and their ancestors for `generations` generations. A person with
 * several sets of parents is shown with their birth parents, or with the
 * first set recorded when none is marked as birth. The same ancestor appears
 * in two slots when two lines of the pedigree meet.
 */
export function getAncestorSlots(tree: Tree, rootId: string, generations: number): AncestorSlot[] {
  const depth = clampGenerations(generations);
  const parentsOf = sql(
    tree.db,
    `SELECT f.partner1_id AS first, f.partner2_id AS second
     FROM family_child fc JOIN family f ON f.id = fc.family_id
     WHERE fc.child_id = ? AND (f.partner1_id IS NOT NULL OR f.partner2_id IS NOT NULL)
     ORDER BY fc.pedigree <> 'birth', fc.id
     LIMIT 1`,
  );
  type Parents = { first: string | null; second: string | null } | undefined;

  const slots: AncestorSlot[] = [];
  let level: { slot: number; personId: string }[] = [{ slot: 1, personId: rootId }];
  for (let generation = 0; generation <= depth && level.length > 0; generation += 1) {
    const next: { slot: number; personId: string }[] = [];
    for (const entry of level) {
      const parents = parentsOf.get(entry.personId) as Parents;
      const last = generation === depth;
      slots.push({ ...entry, more: last && parents !== undefined });
      if (last || !parents) continue;
      if (parents.first !== null) next.push({ slot: entry.slot * 2, personId: parents.first });
      if (parents.second !== null) {
        next.push({ slot: entry.slot * 2 + 1, personId: parents.second });
      }
    }
    level = next;
  }
  return slots;
}

/**
 * The person and their descendants for `generations` generations, with each
 * partnership and its children in the order they are recorded. `truncated`
 * is true when the tree was cut off at `maxNodes` people.
 */
export function getDescendantTree(
  tree: Tree,
  rootId: string,
  generations: number,
  maxNodes: number = MAX_CHART_DESCENDANTS,
): { root: DescendantNode; truncated: boolean } {
  const depth = clampGenerations(generations);
  const familiesOf = sql(
    tree.db,
    `SELECT id, partner1_id AS first, partner2_id AS second FROM family
     WHERE partner1_id = @id OR partner2_id = @id ORDER BY created_at, id`,
  );
  const childrenOf = sql(
    tree.db,
    'SELECT child_id FROM family_child WHERE family_id = ? ORDER BY sort_order, id',
  ).pluck();
  const hasChildren = sql(
    tree.db,
    `SELECT 1 FROM family f JOIN family_child fc ON fc.family_id = f.id
     WHERE f.partner1_id = @id OR f.partner2_id = @id LIMIT 1`,
  );
  type FamilyRow = { id: string; first: string | null; second: string | null };

  let count = 0;
  let truncated = false;
  const build = (personId: string, generation: number): DescendantNode => {
    count += 1;
    if (generation === depth || truncated) {
      return { personId, unions: [], more: hasChildren.get({ id: personId }) !== undefined };
    }
    const unions: DescendantUnion[] = [];
    let more = false;
    for (const family of familiesOf.all({ id: personId }) as FamilyRow[]) {
      const partnerId = family.first === personId ? family.second : family.first;
      const children: DescendantNode[] = [];
      for (const childId of childrenOf.all(family.id) as string[]) {
        if (count >= maxNodes) {
          truncated = true;
          more = true;
          break;
        }
        children.push(build(childId, generation + 1));
      }
      if (partnerId !== null || children.length > 0) unions.push({ partnerId, children });
    }
    return { personId, unions, more };
  };
  const root = build(rootId, 0);
  return { root, truncated };
}

/** Everything a chart of one person needs, read in one go. Null when the person does not exist. */
export function getChartData(tree: Tree, rootId: string, request: ChartRequest): ChartData | null {
  if (getPersonSummary(tree, rootId) === null) return null;
  return tree.db.transaction((): ChartData => {
    const ancestors =
      request.ancestors > 0 ? getAncestorSlots(tree, rootId, request.ancestors) : [];
    const { root, truncated } = getDescendantTree(tree, rootId, request.descendants);

    const ids = new Set<string>([rootId]);
    for (const entry of ancestors) ids.add(entry.personId);
    const walk = (node: DescendantNode): void => {
      ids.add(node.personId);
      for (const union of node.unions) {
        if (union.partnerId !== null) ids.add(union.partnerId);
        union.children.forEach(walk);
      }
    };
    walk(root);

    const persons: PersonSummary[] = [];
    for (const id of ids) {
      const summary = getPersonSummary(tree, id);
      if (summary) persons.push(summary);
    }
    return { rootId, ancestors, descendants: root, persons, truncated };
  })();
}
