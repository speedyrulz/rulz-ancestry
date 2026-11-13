import { PLACE_TEXT_MAX, fitsTypedPlace, foldPlace, newId } from '@rulz/core';
import { sql } from './connection';
import { TreeRuleError, type Tree } from './tree';

/**
 * The places of a tree: the distinct texts its events give as their place,
 * and for each the gazetteer entry it is linked to, if any. See the note on
 * the `place` table in `schema/008-places.ts`.
 */

/** Where a place text lies: the gazetteer entry it is linked to. */
export interface PlaceLink {
  /** The number GeoNames gives the place; null when the coordinates come from elsewhere. */
  geonamesId: number | null;
  /** The gazetteer's own name for the place, written out in full. */
  name: string;
  lat: number;
  lon: number;
}

/** One place of the tree. */
export interface TreePlace {
  /** The place as typed. */
  text: string;
  /** How many events give this place. */
  events: number;
  link: PlaceLink | null;
}

export interface PlaceListOptions {
  /** Only places whose text holds this. */
  query?: string;
  /** Only linked places (true) or only places without a link (false). */
  linked?: boolean;
  offset?: number;
  limit?: number;
}

interface PlaceRow {
  text: string;
  events: number;
  place_id: string | null;
  geonames_id: number | null;
  name: string | null;
  lat: number | null;
  lon: number | null;
}

function toPlace(row: PlaceRow): TreePlace {
  return {
    text: row.text,
    events: row.events,
    link:
      row.place_id === null || row.lat === null || row.lon === null
        ? null
        : { geonamesId: row.geonames_id, name: row.name ?? '', lat: row.lat, lon: row.lon },
  };
}

function cleanText(text: string): string {
  return text.trim();
}

function checkLink(link: PlaceLink): void {
  const fine =
    Number.isFinite(link.lat) &&
    Number.isFinite(link.lon) &&
    Math.abs(link.lat) <= 90 &&
    Math.abs(link.lon) <= 180 &&
    (link.geonamesId === null || (Number.isInteger(link.geonamesId) && link.geonamesId > 0));
  if (!fine) throw new TreeRuleError('these are not the coordinates of a place');
}

/** The gazetteer entry a place text is linked to, or null. Upper and lower case do not matter. */
export function getPlaceLink(tree: Tree, text: string): PlaceLink | null {
  const row = sql(tree.db, 'SELECT geonames_id, name, lat, lon FROM place WHERE text = ?').get(
    cleanText(text),
  ) as { geonames_id: number | null; name: string; lat: number; lon: number } | undefined;
  return row ? { geonamesId: row.geonames_id, name: row.name, lat: row.lat, lon: row.lon } : null;
}

/**
 * Links a place text to a gazetteer entry, or replaces the link it has. For
 * use inside a change transaction; returns whether anything changed.
 */
export function setPlaceLink(tree: Tree, text: string, link: PlaceLink): boolean {
  const place = cleanText(text);
  if (place === '') throw new TreeRuleError('a place without a name cannot be linked');
  if (place.length > PLACE_TEXT_MAX) throw new TreeRuleError('this place name is too long');
  checkLink(link);
  const name = link.name.trim().slice(0, PLACE_TEXT_MAX);
  const current = getPlaceLink(tree, place);
  if (
    current !== null &&
    current.geonamesId === link.geonamesId &&
    current.name === name &&
    current.lat === link.lat &&
    current.lon === link.lon
  ) {
    return false;
  }
  const now = Date.now();
  if (current === null) {
    sql(
      tree.db,
      `INSERT INTO place (id, text, geonames_id, name, lat, lon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), place, link.geonamesId, name, link.lat, link.lon, now, now);
  } else {
    sql(
      tree.db,
      'UPDATE place SET geonames_id = ?, name = ?, lat = ?, lon = ?, updated_at = ? WHERE text = ?',
    ).run(link.geonamesId, name, link.lat, link.lon, now, place);
  }
  return true;
}

/** Links a place text to a gazetteer entry. Every event with that place shares the link. */
export function linkPlace(tree: Tree, text: string, link: PlaceLink): void {
  tree.transact('Link place', () => {
    setPlaceLink(tree, text, link);
  });
}

/** Takes the link of a place text away. The events keep their place as typed. */
export function unlinkPlace(tree: Tree, text: string): void {
  tree.transact('Unlink place', () => {
    sql(tree.db, 'DELETE FROM place WHERE text = ?').run(cleanText(text));
  });
}

const LIKE_ESCAPE = /[\\%_]/g;

function filterOf(options: PlaceListOptions): { where: string; having: string; args: string[] } {
  const query = (options.query ?? '').trim();
  const args: string[] = [];
  let where = "e.place_text <> ''";
  if (query !== '') {
    where += " AND e.place_text LIKE ? ESCAPE '\\'";
    args.push(`%${query.replace(LIKE_ESCAPE, (ch) => `\\${ch}`)}%`);
  }
  const having =
    options.linked === undefined
      ? ''
      : options.linked
        ? 'HAVING p.id IS NOT NULL'
        : 'HAVING p.id IS NULL';
  return { where, having, args };
}

/**
 * The grouping of events into places. Texts that differ only in upper and
 * lower case are one place, shown in the spelling that sorts first.
 */
function groupedPlaces(filter: { where: string; having: string }): string {
  return `SELECT min(e.place_text) AS text, count(*) AS events, p.id AS place_id,
            p.geonames_id, p.name, p.lat, p.lon
          FROM event e LEFT JOIN place p ON p.text = e.place_text
          WHERE ${filter.where}
          GROUP BY e.place_text COLLATE NOCASE
          ${filter.having}`;
}

/** The places of the tree in the order of the alphabet. */
export function listPlaces(tree: Tree, options: PlaceListOptions = {}): TreePlace[] {
  const filter = filterOf(options);
  const limit = Math.max(0, Math.min(options.limit ?? 100, 1000));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = sql(
    tree.db,
    `${groupedPlaces(filter)} ORDER BY e.place_text COLLATE NOCASE LIMIT ? OFFSET ?`,
  ).all(...filter.args, limit, offset) as PlaceRow[];
  return rows.map(toPlace);
}

/** How many places {@link listPlaces} has to give with these options. */
export function countPlaces(tree: Tree, options: PlaceListOptions = {}): number {
  const filter = filterOf(options);
  return sql(tree.db, `SELECT count(*) FROM (${groupedPlaces(filter)})`)
    .pluck()
    .get(...filter.args) as number;
}

/**
 * The places of the tree that fit what is being typed, best first: those
 * that start with it before those in which a later word does, and of equals
 * the one more events give. Accents and case do not matter.
 */
export function suggestTreePlaces(tree: Tree, typed: string, limit = 8): TreePlace[] {
  const folded = foldPlace(typed);
  if (folded === '') return [];
  const rows = sql(
    tree.db,
    groupedPlaces({ where: "e.place_text <> ''", having: '' }),
  ).all() as PlaceRow[];
  const fitting: { row: PlaceRow; fit: number }[] = [];
  for (const row of rows) {
    const fit = fitsTypedPlace(foldPlace(row.text), folded);
    if (fit > 0) fitting.push({ row, fit });
  }
  fitting.sort(
    (a, b) =>
      b.fit - a.fit ||
      b.row.events - a.row.events ||
      a.row.text.localeCompare(b.row.text, 'en', { sensitivity: 'base' }),
  );
  return fitting.slice(0, Math.max(0, limit)).map((entry) => toPlace(entry.row));
}
