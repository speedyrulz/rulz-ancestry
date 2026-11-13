import { cleanNote, newId, parseDate, type DateCalendar, type DateQualifier } from '@rulz/core';
import { sql } from './connection';
import { requireFamily } from './families';
import { requirePerson } from './persons';
import { setPlaceLink, type PlaceLink } from './places';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

export interface TreeEvent {
  id: string;
  /** For example "birth" or "marriage"; see the type lists in @rulz/core. */
  type: string;
  /** The date as typed. Empty when no date is known. */
  dateText: string;
  /** How the app read the date; all four are null when there is no date. */
  dateQualifier: DateQualifier | null;
  dateCalendar: DateCalendar | null;
  dateMinJdn: number | null;
  dateMaxJdn: number | null;
  /** The place as typed. */
  placeText: string;
  /** Detail that is not a date or place, e.g. the occupation or the cause of death. */
  description: string;
  /** The user's own remark on the event. May have several lines. */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventInput {
  type: string;
  date?: string;
  place?: string;
  description?: string;
  note?: string;
  /**
   * The gazetteer entry the place was picked from. It is linked to the place
   * text in the same step; every event with that text then shares it.
   */
  placeLink?: PlaceLink;
}

interface EventRow {
  id: string;
  type: string;
  date_text: string;
  date_qualifier: DateQualifier | null;
  date_calendar: DateCalendar | null;
  date_min_jdn: number | null;
  date_max_jdn: number | null;
  place_text: string;
  description: string;
  note: string;
  created_at: number;
  updated_at: number;
}

const EVENT_COLUMNS = `e.id, e.type, e.date_text, e.date_qualifier, e.date_calendar, e.date_min_jdn,
  e.date_max_jdn, e.place_text, e.description, e.note, e.created_at, e.updated_at`;

function toEvent(row: EventRow): TreeEvent {
  return {
    id: row.id,
    type: row.type,
    dateText: row.date_text,
    dateQualifier: row.date_qualifier,
    dateCalendar: row.date_calendar,
    dateMinJdn: row.date_min_jdn,
    dateMaxJdn: row.date_max_jdn,
    placeText: row.place_text,
    description: row.description,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanType(type: string): string {
  const cleaned = type.trim().toLowerCase();
  if (cleaned === '') throw new TreeRuleError('an event needs a type');
  return cleaned;
}

/** The five date columns for a date as typed. */
export function dateColumns(
  text: string,
): [string, string | null, string | null, number | null, number | null] {
  const parsed = parseDate(text);
  if (!parsed) return ['', null, null, null, null];
  return [parsed.text, parsed.qualifier, parsed.calendar, parsed.minJdn, parsed.maxJdn];
}

export function getEvent(tree: Tree, id: string): TreeEvent | null {
  const row = sql(tree.db, `SELECT ${EVENT_COLUMNS} FROM event e WHERE e.id = ?`).get(id) as
    EventRow | undefined;
  return row ? toEvent(row) : null;
}

export function requireEvent(tree: Tree, id: string): TreeEvent {
  const event = getEvent(tree, id);
  if (!event) throw new NotFoundError('event', id);
  return event;
}

function insertEvent(
  tree: Tree,
  input: EventInput,
  owner: { personId: string } | { familyId: string },
): TreeEvent {
  const type = cleanType(input.type);
  const id = newId();
  const now = Date.now();
  const place = (input.place ?? '').trim();
  sql(
    tree.db,
    `INSERT INTO event (id, type, date_text, date_qualifier, date_calendar, date_min_jdn,
       date_max_jdn, place_text, description, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    type,
    ...dateColumns(input.date ?? ''),
    place,
    (input.description ?? '').trim(),
    cleanNote(input.note ?? ''),
    now,
    now,
  );

  const personId = 'personId' in owner ? owner.personId : null;
  const familyId = 'familyId' in owner ? owner.familyId : null;
  // One statement per kind of owner, so each uses that owner's index. A single
  // statement testing both columns scanned every event in the tree.
  const last = sql(
    tree.db,
    personId !== null
      ? 'SELECT max(sort_order) FROM event_participant WHERE person_id = ?'
      : 'SELECT max(sort_order) FROM event_participant WHERE family_id = ?',
  )
    .pluck()
    .get(personId ?? familyId) as number | null;
  sql(
    tree.db,
    `INSERT INTO event_participant (id, event_id, person_id, family_id, role, sort_order)
     VALUES (?, ?, ?, ?, 'principal', ?)`,
  ).run(newId(), id, personId, familyId, (last ?? -1) + 1);
  if (input.placeLink && place !== '') setPlaceLink(tree, place, input.placeLink);
  return requireEvent(tree, id);
}

/** Adds an event that belongs to one person, such as a birth or a residence. */
export function addPersonEvent(tree: Tree, personId: string, input: EventInput): TreeEvent {
  return tree.transact('Add event', () => {
    requirePerson(tree, personId);
    return insertEvent(tree, input, { personId });
  });
}

/** Adds an event that belongs to a couple, such as a marriage. */
export function addFamilyEvent(tree: Tree, familyId: string, input: EventInput): TreeEvent {
  return tree.transact('Add event', () => {
    requireFamily(tree, familyId);
    return insertEvent(tree, input, { familyId });
  });
}

/** Changes the given fields of an event. An empty `date` clears the date. */
export function updateEvent(tree: Tree, id: string, patch: Partial<EventInput>): TreeEvent {
  return tree.transact('Edit event', () => {
    const current = requireEvent(tree, id);
    const type = patch.type === undefined ? current.type : cleanType(patch.type);
    const date = dateColumns(patch.date ?? current.dateText);
    const place = patch.place === undefined ? current.placeText : patch.place.trim();
    const description =
      patch.description === undefined ? current.description : patch.description.trim();
    const note = patch.note === undefined ? current.note : cleanNote(patch.note);
    if (patch.placeLink && place !== '') setPlaceLink(tree, place, patch.placeLink);
    const unchanged =
      type === current.type &&
      date[0] === current.dateText &&
      place === current.placeText &&
      description === current.description &&
      note === current.note;
    if (unchanged) return current;
    sql(
      tree.db,
      `UPDATE event
       SET type = ?, date_text = ?, date_qualifier = ?, date_calendar = ?, date_min_jdn = ?,
           date_max_jdn = ?, place_text = ?, description = ?, note = ?, updated_at = ?
       WHERE id = ?`,
    ).run(type, ...date, place, description, note, Date.now(), id);
    return requireEvent(tree, id);
  });
}

export function deleteEvent(tree: Tree, id: string): void {
  tree.transact('Delete event', () => {
    requireEvent(tree, id);
    sql(tree.db, 'DELETE FROM event WHERE id = ?').run(id);
  });
}

/** A person's own events in the order they were added. Family events are not included. */
export function listPersonEvents(tree: Tree, personId: string): TreeEvent[] {
  const rows = sql(
    tree.db,
    `SELECT ${EVENT_COLUMNS} FROM event_participant ep JOIN event e ON e.id = ep.event_id
     WHERE ep.person_id = ? ORDER BY ep.sort_order, e.id`,
  ).all(personId) as EventRow[];
  return rows.map(toEvent);
}

export function listFamilyEvents(tree: Tree, familyId: string): TreeEvent[] {
  const rows = sql(
    tree.db,
    `SELECT ${EVENT_COLUMNS} FROM event_participant ep JOIN event e ON e.id = ep.event_id
     WHERE ep.family_id = ? ORDER BY ep.sort_order, e.id`,
  ).all(familyId) as EventRow[];
  return rows.map(toEvent);
}
