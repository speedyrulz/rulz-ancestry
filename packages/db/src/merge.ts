import { sql } from './connection';
import { isSelfOrAncestor, pruneFamilies } from './families';
import { getStoredRecord } from './gedcom/store';
import { requirePerson } from './persons';
import { TreeRuleError, type Tree } from './tree';

/**
 * Merges two records of one person into one. Everything the second record
 * has is moved to the first: names, events, parents, partners and children.
 * Nothing is thrown away except exact repeats, so the user can still see both
 * versions of a fact and delete the one that is wrong. The whole merge is one
 * undo step.
 */

export interface MergeResult {
  /** The person who is left. */
  personId: string;
  /** How many names and events were moved to them; exact repeats are not counted. */
  names: number;
  events: number;
  /** How many families were joined because both records had the same partner. */
  families: number;
}

interface EventKey {
  id: string;
  type: string;
  date_text: string;
  place_text: string;
  description: string;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function sameEvent(a: EventKey, b: EventKey): boolean {
  return (
    a.type === b.type &&
    same(a.date_text, b.date_text) &&
    same(a.place_text, b.place_text) &&
    same(a.description, b.description)
  );
}

type Owner = 'person_id' | 'family_id';

/** The lines under a name or an event that the app has fields for. */
const MODELLED_UNDER = {
  name: new Set(['GIVN', 'SURN', 'NPFX', 'NSFX', 'NICK', 'SPFX', 'TYPE', 'CONC', 'CONT']),
  event: new Set(['DATE', 'PLAC', 'TYPE', 'CONC', 'CONT']),
} as const;

/**
 * The names or events of a record that came from a GEDCOM file with lines
 * under them the app has no fields for, such as a source. Those lines exist
 * only in what is kept of the file, under the name or event they belong to,
 * so a merge must not drop such a name or event as a repeat.
 */
function withKeptLines(tree: Tree, recordId: string, kind: 'name' | 'event'): Set<string> {
  const found = new Set<string>();
  for (const id of [recordId, ...mergedInto(tree, recordId)]) {
    for (const part of getStoredRecord(tree, id)?.parts ?? []) {
      if (part.k !== kind || part.r === undefined) continue;
      const lines = part.t.split(/\r?\n/);
      const level = Number.parseInt(lines[0] ?? '', 10);
      const kept = lines.slice(1).some((line) => {
        const words = line.trim().split(/\s+/);
        if (Number.parseInt(words[0] ?? '', 10) !== level + 1) return false;
        const tag = (words[1]?.startsWith('@') ? words[2] : words[1]) ?? '';
        return !MODELLED_UNDER[kind].has(tag.toUpperCase());
      });
      if (kept) found.add(part.r);
    }
  }
  return found;
}

/** True when a name or event has a citation: it then says more than a bare repeat. */
function isCited(tree: Tree, column: 'name_id' | 'event_id', id: string): boolean {
  return (
    sql(tree.db, `SELECT 1 FROM citation_link WHERE ${column} = ? LIMIT 1`).get(id) !== undefined
  );
}

/**
 * Moves the citations of a person or family as a whole to the one that stays.
 * A citation both already had is kept once.
 */
function moveCitations(tree: Tree, owner: Owner, fromId: string, toId: string): void {
  const db = tree.db;
  const present = new Set(
    sql(db, `SELECT citation_id FROM citation_link WHERE ${owner} = ?`)
      .pluck()
      .all(toId) as string[],
  );
  let order =
    (sql(db, `SELECT max(sort_order) FROM citation_link WHERE ${owner} = ?`).pluck().get(toId) as
      number | null) ?? -1;
  const links = sql(
    db,
    `SELECT id, citation_id FROM citation_link WHERE ${owner} = ? ORDER BY sort_order, id`,
  ).all(fromId) as { id: string; citation_id: string }[];
  for (const link of links) {
    if (present.has(link.citation_id)) {
      sql(db, 'DELETE FROM citation_link WHERE id = ?').run(link.id);
      continue;
    }
    order += 1;
    sql(db, `UPDATE citation_link SET ${owner} = ?, sort_order = ? WHERE id = ?`).run(
      toId,
      order,
      link.id,
    );
    present.add(link.citation_id);
  }
}

function eventsOf(tree: Tree, owner: Owner, id: string): (EventKey & { link: string })[] {
  return sql(
    tree.db,
    `SELECT e.id, e.type, e.date_text, e.place_text, e.description, ep.id AS link
     FROM event_participant ep JOIN event e ON e.id = ep.event_id
     WHERE ep.${owner} = ? ORDER BY ep.sort_order, e.id`,
  ).all(id) as (EventKey & { link: string })[];
}

/**
 * Moves the events of one person or family to another. An event the receiver
 * already has, word for word, is dropped, unless the file it came from says
 * more about it. Returns how many were moved.
 */
function moveEvents(tree: Tree, owner: Owner, fromId: string, toId: string): number {
  const db = tree.db;
  const kept = eventsOf(tree, owner, toId);
  const sourced = withKeptLines(tree, fromId, 'event');
  let order =
    (sql(db, `SELECT max(sort_order) FROM event_participant WHERE ${owner} = ?`)
      .pluck()
      .get(toId) as number | null) ?? -1;
  let moved = 0;
  for (const event of eventsOf(tree, owner, fromId)) {
    const more = sourced.has(event.id) || isCited(tree, 'event_id', event.id);
    const repeat = kept.some(
      (other) => other.id === event.id || (sameEvent(other, event) && !more),
    );
    if (repeat) {
      sql(db, 'DELETE FROM event_participant WHERE id = ?').run(event.link);
      // An event nobody takes part in any more goes with its last link.
      sql(
        db,
        `DELETE FROM event WHERE id = @id
           AND NOT EXISTS (SELECT 1 FROM event_participant WHERE event_id = @id)`,
      ).run({ id: event.id });
      continue;
    }
    order += 1;
    sql(db, `UPDATE event_participant SET ${owner} = ?, sort_order = ? WHERE id = ?`).run(
      toId,
      order,
      event.link,
    );
    kept.push(event);
    moved += 1;
  }
  return moved;
}

function recordMerge(tree: Tree, kind: 'person' | 'family', fromId: string, toId: string): void {
  // What was merged into the one that now goes is carried along.
  sql(tree.db, 'UPDATE merged_record SET into_id = ? WHERE into_id = ? AND kind = ?').run(
    toId,
    fromId,
    kind,
  );
  sql(
    tree.db,
    `INSERT INTO merged_record (id, kind, into_id, merged_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET into_id = excluded.into_id, merged_at = excluded.merged_at`,
  ).run(fromId, kind, toId, Date.now());
}

/**
 * Moves the names of `fromId` to `toId`. A name the receiver already has is
 * dropped, unless the file it came from says more about it.
 */
function moveNames(tree: Tree, fromId: string, toId: string): number {
  const db = tree.db;
  interface Row {
    id: string;
    type: string;
    prefix: string;
    given: string;
    nickname: string;
    surname: string;
    suffix: string;
  }
  const namesOf = (personId: string) =>
    sql(
      db,
      `SELECT id, type, prefix, given, nickname, surname, suffix FROM person_name
       WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id`,
    ).all(personId) as Row[];
  const sameName = (a: Row, b: Row): boolean =>
    same(a.prefix, b.prefix) &&
    same(a.given, b.given) &&
    same(a.nickname, b.nickname) &&
    same(a.surname, b.surname) &&
    same(a.suffix, b.suffix);

  const kept = namesOf(toId);
  const sourced = withKeptLines(tree, fromId, 'name');
  let order =
    (sql(db, 'SELECT max(sort_order) FROM person_name WHERE person_id = ?').pluck().get(toId) as
      number | null) ?? -1;
  let moved = 0;
  for (const name of namesOf(fromId)) {
    const more = sourced.has(name.id) || isCited(tree, 'name_id', name.id);
    if (!more && kept.some((other) => sameName(other, name))) {
      sql(db, 'DELETE FROM person_name WHERE id = ?').run(name.id);
      continue;
    }
    order += 1;
    // The receiver's main name stays the main one; it gets one only if it had no name at all.
    sql(
      db,
      'UPDATE person_name SET person_id = ?, is_primary = ?, sort_order = ? WHERE id = ?',
    ).run(toId, kept.length === 0 ? 1 : 0, order, name.id);
    kept.push(name);
    moved += 1;
  }
  return moved;
}

/** Joins the families in which `personId` has the same partner twice. Returns how many went. */
function joinTwinFamilies(tree: Tree, personId: string): number {
  const db = tree.db;
  const families = sql(
    db,
    `SELECT id, partner1_id, partner2_id FROM family
     WHERE (partner1_id = @id OR partner2_id = @id)
       AND partner1_id IS NOT NULL AND partner2_id IS NOT NULL
     ORDER BY created_at, id`,
  ).all({ id: personId }) as { id: string; partner1_id: string; partner2_id: string }[];

  const firstWith = new Map<string, string>();
  let joined = 0;
  for (const family of families) {
    const partnerId = family.partner1_id === personId ? family.partner2_id : family.partner1_id;
    const keptId = firstWith.get(partnerId);
    if (keptId === undefined) {
      firstWith.set(partnerId, family.id);
      continue;
    }
    // Children: one link each, after the children the kept family already has.
    const present = new Set(
      sql(db, 'SELECT child_id FROM family_child WHERE family_id = ?')
        .pluck()
        .all(keptId) as string[],
    );
    let order =
      (sql(db, 'SELECT max(sort_order) FROM family_child WHERE family_id = ?')
        .pluck()
        .get(keptId) as number | null) ?? -1;
    const links = sql(
      db,
      'SELECT id, child_id FROM family_child WHERE family_id = ? ORDER BY sort_order, id',
    ).all(family.id) as { id: string; child_id: string }[];
    for (const link of links) {
      if (present.has(link.child_id)) {
        sql(db, 'DELETE FROM family_child WHERE id = ?').run(link.id);
        continue;
      }
      order += 1;
      sql(db, 'UPDATE family_child SET family_id = ?, sort_order = ? WHERE id = ?').run(
        keptId,
        order,
        link.id,
      );
      present.add(link.child_id);
    }
    moveEvents(tree, 'family_id', family.id, keptId);
    moveCitations(tree, 'family_id', family.id, keptId);
    recordMerge(tree, 'family', family.id, keptId);
    sql(db, 'DELETE FROM family WHERE id = ?').run(family.id);
    joined += 1;
  }
  return joined;
}

/**
 * Why two people cannot be merged, in words for the user, or null when they
 * can. Merging a person with their own ancestor would make them their own
 * ancestor; merging two partners would leave a person married to themself.
 */
export function mergeObstacle(tree: Tree, keepId: string, mergeId: string): string | null {
  if (keepId === mergeId) return 'a person cannot be merged with themself';
  if (isSelfOrAncestor(tree, keepId, mergeId) || isSelfOrAncestor(tree, mergeId, keepId)) {
    return 'a person cannot be merged with their own ancestor or descendant';
  }
  const partners = sql(
    tree.db,
    `SELECT 1 FROM family
     WHERE (partner1_id = @a AND partner2_id = @b) OR (partner1_id = @b AND partner2_id = @a)
     LIMIT 1`,
  ).get({ a: keepId, b: mergeId });
  return partners ? 'two people who are partners of each other cannot be merged' : null;
}

/**
 * Merges `mergeId` into `keepId`. The person kept takes their own sex and
 * living status where those are stated and the other's where they are not.
 * Families in which both had the same partner become one family.
 */
export function mergePersons(tree: Tree, keepId: string, mergeId: string): MergeResult {
  return tree.transact('Merge people', () => {
    const db = tree.db;
    const keep = requirePerson(tree, keepId);
    const gone = requirePerson(tree, mergeId);
    const obstacle = mergeObstacle(tree, keepId, mergeId);
    if (obstacle !== null) throw new TreeRuleError(obstacle);

    const sex = keep.sex === 'U' ? gone.sex : keep.sex;
    // Deceased on either record wins: a death is recorded on purpose.
    const living =
      keep.living === false || gone.living === false ? false : (keep.living ?? gone.living);
    sql(db, 'UPDATE person SET sex = ?, living = ?, updated_at = ? WHERE id = ?').run(
      sex,
      living === null ? null : living ? 1 : 0,
      Date.now(),
      keepId,
    );

    const names = moveNames(tree, mergeId, keepId);
    const events = moveEvents(tree, 'person_id', mergeId, keepId);
    moveCitations(tree, 'person_id', mergeId, keepId);

    // Parents: the kept person joins each family the other was a child of.
    const touched = new Set<string>();
    const childOf = new Set(
      sql(db, 'SELECT family_id FROM family_child WHERE child_id = ?')
        .pluck()
        .all(keepId) as string[],
    );
    const childLinks = sql(db, 'SELECT id, family_id FROM family_child WHERE child_id = ?').all(
      mergeId,
    ) as { id: string; family_id: string }[];
    for (const link of childLinks) {
      touched.add(link.family_id);
      if (childOf.has(link.family_id)) {
        sql(db, 'DELETE FROM family_child WHERE id = ?').run(link.id);
      } else {
        sql(db, 'UPDATE family_child SET child_id = ? WHERE id = ?').run(keepId, link.id);
      }
    }

    // Partners and children: the kept person takes the other's place in each family.
    const partnerIn = sql(db, 'SELECT id FROM family WHERE partner1_id = @id OR partner2_id = @id')
      .pluck()
      .all({ id: mergeId }) as string[];
    partnerIn.forEach((id) => touched.add(id));
    const now = Date.now();
    sql(db, 'UPDATE family SET partner1_id = ?, updated_at = ? WHERE partner1_id = ?').run(
      keepId,
      now,
      mergeId,
    );
    sql(db, 'UPDATE family SET partner2_id = ?, updated_at = ? WHERE partner2_id = ?').run(
      keepId,
      now,
      mergeId,
    );

    recordMerge(tree, 'person', mergeId, keepId);
    // Whatever still points at the merged record (a mark as "different people") goes with it.
    sql(db, 'DELETE FROM person WHERE id = ?').run(mergeId);

    const families = joinTwinFamilies(tree, keepId);
    pruneFamilies(tree, [...touched]);
    return { personId: keepId, names, events, families };
  });
}

/** The ids of the people or families that were merged into this one, oldest merge first. */
export function mergedInto(tree: Tree, id: string): string[] {
  return sql(tree.db, 'SELECT id FROM merged_record WHERE into_id = ? ORDER BY merged_at, id')
    .pluck()
    .all(id) as string[];
}
