import type { Sex } from '@rulz/core';
import { sql } from './connection';
import type { Tree } from './tree';

/** What a list or a search result shows for one person. */
export interface PersonSummary {
  id: string;
  sex: Sex;
  living: boolean | null;
  /** The primary name, or null for a person with no name recorded. */
  name: {
    prefix: string;
    given: string;
    nickname: string;
    surname: string;
    suffix: string;
  } | null;
  /** The first birth event recorded, if any. */
  birth: { dateText: string; placeText: string } | null;
  /** The first death event recorded, if any. */
  death: { dateText: string; placeText: string } | null;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

interface SummaryRow {
  id: string;
  sex: Sex;
  living: 0 | 1 | null;
  name_id: string | null;
  prefix: string | null;
  given: string | null;
  nickname: string | null;
  surname: string | null;
  suffix: string | null;
  birth_id: string | null;
  birth_date: string | null;
  birth_place: string | null;
  death_id: string | null;
  death_date: string | null;
  death_place: string | null;
}

const firstEvent = (type: 'birth' | 'death') => `(
  SELECT e.id FROM event_participant ep JOIN event e ON e.id = ep.event_id
  WHERE ep.person_id = p.id AND e.type = '${type}'
  ORDER BY ep.sort_order, e.id LIMIT 1
)`;

const SUMMARY_SELECT = `
  SELECT p.id, p.sex, p.living,
         n.id AS name_id, n.prefix, n.given, n.nickname, n.surname, n.suffix,
         b.id AS birth_id, b.date_text AS birth_date, b.place_text AS birth_place,
         d.id AS death_id, d.date_text AS death_date, d.place_text AS death_place
  FROM person p
    LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
    LEFT JOIN event b ON b.id = ${firstEvent('birth')}
    LEFT JOIN event d ON d.id = ${firstEvent('death')}`;

function toSummary(row: SummaryRow): PersonSummary {
  return {
    id: row.id,
    sex: row.sex,
    living: row.living === null ? null : row.living === 1,
    name:
      row.name_id === null
        ? null
        : {
            prefix: row.prefix ?? '',
            given: row.given ?? '',
            nickname: row.nickname ?? '',
            surname: row.surname ?? '',
            suffix: row.suffix ?? '',
          },
    birth:
      row.birth_id === null
        ? null
        : { dateText: row.birth_date ?? '', placeText: row.birth_place ?? '' },
    death:
      row.death_id === null
        ? null
        : { dateText: row.death_date ?? '', placeText: row.death_place ?? '' },
  };
}

function page(options: PageOptions): [number, number] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  return [limit, offset];
}

export function getPersonSummary(tree: Tree, id: string): PersonSummary | null {
  const row = sql(tree.db, `${SUMMARY_SELECT} WHERE p.id = ?`).get(id) as SummaryRow | undefined;
  return row ? toSummary(row) : null;
}

/** Everyone in the tree by surname, then given name. People with no name come last. */
export function listPersons(tree: Tree, options: PageOptions = {}): PersonSummary[] {
  const rows = sql(
    tree.db,
    `${SUMMARY_SELECT}
     ORDER BY n.id IS NULL, n.surname COLLATE NOCASE, n.given COLLATE NOCASE, p.id
     LIMIT ? OFFSET ?`,
  ).all(...page(options)) as SummaryRow[];
  return rows.map(toSummary);
}

/**
 * Turns what the user typed into a full-text query: every word must appear,
 * and each word also matches longer words that start with it, so "joh smi"
 * finds John Smith while it is still being typed. Words are quoted, so nothing
 * the user types is read as search syntax.
 */
export function toFtsQuery(input: string): string {
  const words = input.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(0, 12)
    .map((word) => `"${word}"*`)
    .join(' ');
}

/**
 * Finds people by any of their names, best match first. Case and accents are
 * ignored. A person who matches through several names is listed once.
 */
export function searchPersons(
  tree: Tree,
  query: string,
  options: PageOptions = {},
): PersonSummary[] {
  const fts = toFtsQuery(query);
  if (fts === '') return [];
  const rows = sql(
    tree.db,
    `WITH hit AS MATERIALIZED (
       SELECT rowid AS doc_id, rank AS score FROM search_fts WHERE search_fts MATCH ?
     ),
     best AS (
       SELECT doc.person_id AS person_id, min(hit.score) AS score
       FROM hit JOIN search_doc doc ON doc.id = hit.doc_id
       WHERE doc.person_id IS NOT NULL
       GROUP BY doc.person_id
     )
     ${SUMMARY_SELECT}
       JOIN best ON best.person_id = p.id
     ORDER BY best.score, n.surname COLLATE NOCASE, n.given COLLATE NOCASE, p.id
     LIMIT ? OFFSET ?`,
  ).all(fts, ...page(options)) as SummaryRow[];
  return rows.map(toSummary);
}
