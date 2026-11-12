import {
  DUPLICATE_THRESHOLD,
  blockingKeys,
  formatName,
  jdnToCalendar,
  newId,
  normalizeName,
  scoreDuplicate,
  type MatchCandidate,
  type Sex,
} from '@rulz/core';
import { sql } from './connection';
import { requirePerson } from './persons';
import { TreeRuleError, type Tree } from './tree';

/**
 * Finds people in a tree who may have been entered twice. The comparison
 * itself is `scoreDuplicate` in `@rulz/core`; this file reads the tree into
 * the form it compares, decides which pairs are worth comparing, and
 * remembers the pairs the user has said are different people.
 */

export interface DuplicatePair {
  aId: string;
  bId: string;
  /** 50 to 100; see `scoreDuplicate`. */
  score: number;
  /** What the score rests on, in words for the user. */
  reasons: string[];
}

export interface DuplicateScan {
  /** The likeliest pairs, best first. */
  pairs: DuplicatePair[];
  /** How many pairs reached the threshold, including those beyond the limit. */
  total: number;
  /** How many people were looked at. */
  persons: number;
  /** True when the scan stopped early because the tree has very many people of one surname. */
  truncated: boolean;
}

export interface DuplicateOptions {
  /** The most pairs to return. */
  limit?: number;
  /** The most pairs to compare in full before stopping. */
  maxComparisons?: number;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_COMPARISONS = 4_000_000;
/** A group of people who share a surname key is split further once it is larger than this. */
const LARGE_GROUP = 300;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface Draft {
  id: string;
  sex: Sex;
  names: { given: string; surname: string }[];
  birthYear: number | null;
  deathYear: number | null;
  birthPlace: string;
  deathPlace: string;
  parentIds: string[];
  partnerIds: string[];
}

function yearOf(calendar: string | null, min: number | null, max: number | null): number | null {
  const jdn = min ?? max;
  if (jdn === null || (calendar !== 'gregorian' && calendar !== 'julian')) return null;
  return jdnToCalendar(calendar, jdn).year;
}

/** Everyone in the tree in the form the comparison takes. */
function readCandidates(tree: Tree): MatchCandidate[] {
  const db = tree.db;
  const drafts = new Map<string, Draft>();
  for (const row of sql(db, 'SELECT id, sex FROM person ORDER BY id').all() as {
    id: string;
    sex: Sex;
  }[]) {
    drafts.set(row.id, {
      ...row,
      names: [],
      birthYear: null,
      deathYear: null,
      birthPlace: '',
      deathPlace: '',
      parentIds: [],
      partnerIds: [],
    });
  }

  const names = sql(
    db,
    `SELECT person_id, given, surname FROM person_name
     ORDER BY person_id, is_primary DESC, sort_order, id`,
  ).all() as { person_id: string; given: string; surname: string }[];
  for (const row of names) {
    drafts.get(row.person_id)?.names.push({ given: row.given, surname: row.surname });
  }

  // The first birth and death recorded; a baptism or burial stands in where there is none.
  const events = sql(
    db,
    `SELECT ep.person_id, e.type, e.date_calendar, e.date_min_jdn, e.date_max_jdn, e.place_text
     FROM event_participant ep JOIN event e ON e.id = ep.event_id
     WHERE ep.person_id IS NOT NULL AND e.type IN ('birth', 'baptism', 'death', 'burial')
     ORDER BY ep.person_id, e.type IN ('baptism', 'burial'), ep.sort_order, e.id`,
  ).all() as {
    person_id: string;
    type: string;
    date_calendar: string | null;
    date_min_jdn: number | null;
    date_max_jdn: number | null;
    place_text: string;
  }[];
  for (const row of events) {
    const draft = drafts.get(row.person_id);
    if (!draft) continue;
    const year = yearOf(row.date_calendar, row.date_min_jdn, row.date_max_jdn);
    if (row.type === 'birth' || row.type === 'baptism') {
      draft.birthYear ??= year;
      if (draft.birthPlace === '') draft.birthPlace = row.place_text;
    } else {
      draft.deathYear ??= year;
      if (draft.deathPlace === '') draft.deathPlace = row.place_text;
    }
  }

  const families = sql(db, 'SELECT id, partner1_id, partner2_id FROM family').all() as {
    id: string;
    partner1_id: string | null;
    partner2_id: string | null;
  }[];
  const partnersOfFamily = new Map<string, string[]>();
  for (const family of families) {
    const partners = [family.partner1_id, family.partner2_id].filter((id) => id !== null);
    partnersOfFamily.set(family.id, partners);
    const [first, second] = partners;
    if (first !== undefined && second !== undefined) {
      drafts.get(first)?.partnerIds.push(second);
      drafts.get(second)?.partnerIds.push(first);
    }
  }
  const links = sql(db, 'SELECT family_id, child_id FROM family_child').all() as {
    family_id: string;
    child_id: string;
  }[];
  for (const link of links) {
    drafts.get(link.child_id)?.parentIds.push(...(partnersOfFamily.get(link.family_id) ?? []));
  }

  const fullName = (id: string): string => {
    const name = drafts.get(id)?.names[0];
    return name ? formatName(name) : '';
  };
  return [...drafts.values()].map((draft) => ({
    ...draft,
    parentNames: draft.parentIds.map(fullName),
    partnerNames: draft.partnerIds.map(fullName),
  }));
}

function notDuplicateKeys(tree: Tree): Set<string> {
  const rows = sql(tree.db, 'SELECT person_a, person_b FROM not_duplicate').all() as {
    person_a: string;
    person_b: string;
  }[];
  return new Set(rows.map((row) => pairKey(row.person_a, row.person_b)));
}

/**
 * Lists the pairs of people most likely to be one person entered twice. Pairs
 * the user has marked as different people are left out. Nothing is changed.
 */
export function findDuplicates(tree: Tree, options: DuplicateOptions = {}): DuplicateScan {
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));
  const maxComparisons = options.maxComparisons ?? DEFAULT_MAX_COMPARISONS;
  const candidates = readCandidates(tree);
  const dismissed = notDuplicateKeys(tree);

  interface Entry {
    candidate: MatchCandidate;
    keys: string[];
  }
  // A group of very many people (a common surname) is split by the first
  // letter of the given name, which keeps the number of pairs in hand. Inside
  // such a group a pair like Catherine and Katherine is then not compared.
  const keysOfName = candidates.map((candidate) =>
    candidate.names.map((name) => ({
      keys: blockingKeys({ names: [name] }),
      initial: normalizeName(name.given).charAt(0),
    })),
  );
  const sizes = new Map<string, number>();
  for (const names of keysOfName) {
    for (const key of new Set(names.flatMap((name) => name.keys))) {
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
  }
  const finalKeys = (index: number): string[] => {
    const keys = new Set<string>();
    for (const name of keysOfName[index] ?? []) {
      for (const key of name.keys) {
        keys.add((sizes.get(key) ?? 0) > LARGE_GROUP ? `${key}/${name.initial}` : key);
      }
    }
    return [...keys].sort();
  };

  const blocks = new Map<string, Entry[]>();
  for (const [index, candidate] of candidates.entries()) {
    const entry: Entry = { candidate, keys: finalKeys(index) };
    for (const key of entry.keys) {
      const block = blocks.get(key);
      if (block) block.push(entry);
      else blocks.set(key, [entry]);
    }
  }
  /** Two people who share several groups are compared in the first of them only. */
  const firstShared = (a: Entry, b: Entry): string | undefined =>
    a.keys.find((key) => b.keys.includes(key));

  const pairs: DuplicatePair[] = [];
  let comparisons = 0;
  let truncated = false;
  // Small groups first, so that a cut-off scan has covered the most surnames.
  const ordered = [...blocks.entries()].sort((a, b) => a[1].length - b[1].length);
  scan: for (const [blockKey, block] of ordered) {
    for (let i = 0; i < block.length; i += 1) {
      for (let j = i + 1; j < block.length; j += 1) {
        const first = block[i];
        const second = block[j];
        if (!first || !second || firstShared(first, second) !== blockKey) continue;
        const a = first.candidate;
        const b = second.candidate;
        if (dismissed.size > 0 && dismissed.has(pairKey(a.id, b.id))) continue;
        comparisons += 1;
        if (comparisons > maxComparisons) {
          truncated = true;
          break scan;
        }
        const result = scoreDuplicate(a, b);
        if (result && result.score >= DUPLICATE_THRESHOLD) {
          const [aId, bId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
          pairs.push({ aId, bId, score: result.score, reasons: result.reasons });
        }
      }
    }
  }

  pairs.sort((x, y) => y.score - x.score || (x.aId < y.aId ? -1 : x.aId > y.aId ? 1 : 0));
  return {
    pairs: pairs.slice(0, limit),
    total: pairs.length,
    persons: candidates.length,
    truncated,
  };
}

/** Records that two people are not the same person, so the pair is not offered again. */
export function markNotDuplicate(tree: Tree, aId: string, bId: string): void {
  if (aId === bId) throw new TreeRuleError('a person cannot be compared with themself');
  const [first, second] = aId < bId ? [aId, bId] : [bId, aId];
  tree.transact('Mark as different people', () => {
    requirePerson(tree, first);
    requirePerson(tree, second);
    sql(
      tree.db,
      `INSERT INTO not_duplicate (id, person_a, person_b, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (person_a, person_b) DO NOTHING`,
    ).run(newId(), first, second, Date.now());
  });
}

/** True when the user has marked the two as different people. */
export function isMarkedNotDuplicate(tree: Tree, aId: string, bId: string): boolean {
  const [first, second] = aId < bId ? [aId, bId] : [bId, aId];
  return (
    sql(tree.db, 'SELECT 1 FROM not_duplicate WHERE person_a = ? AND person_b = ?').get(
      first,
      second,
    ) !== undefined
  );
}
