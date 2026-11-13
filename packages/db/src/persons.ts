import { NAME_TYPES, SEXES, cleanNote, newId, type NameType, type Sex } from '@rulz/core';
import { sql } from './connection';
import { pruneFamilies } from './families';
import { NotFoundError, TreeRuleError, type Tree } from './tree';

export interface Person {
  id: string;
  sex: Sex;
  /** True living, false deceased, null not stated. */
  living: boolean | null;
  /** The user's own remark on the person. May have several lines. */
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface PersonName {
  id: string;
  personId: string;
  type: string;
  /** Title before the name, e.g. "Dr." */
  prefix: string;
  given: string;
  nickname: string;
  surname: string;
  /** Text after the name, e.g. "Jr." */
  suffix: string;
  /** The name shown for the person in lists and charts. */
  isPrimary: boolean;
  sortOrder: number;
}

export interface NameInput {
  type?: NameType;
  prefix?: string;
  given?: string;
  nickname?: string;
  surname?: string;
  suffix?: string;
}

export interface NewPerson {
  sex?: Sex;
  living?: boolean | null;
  /** The person's first name record, which becomes their primary name. */
  name?: NameInput;
}

interface PersonRow {
  id: string;
  sex: Sex;
  living: 0 | 1 | null;
  note: string;
  created_at: number;
  updated_at: number;
}

interface NameRow {
  id: string;
  person_id: string;
  type: string;
  prefix: string;
  given: string;
  nickname: string;
  surname: string;
  suffix: string;
  is_primary: 0 | 1;
  sort_order: number;
}

const NAME_COLUMNS =
  'id, person_id, type, prefix, given, nickname, surname, suffix, is_primary, sort_order';

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    sex: row.sex,
    living: row.living === null ? null : row.living === 1,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toName(row: NameRow): PersonName {
  return {
    id: row.id,
    personId: row.person_id,
    type: row.type,
    prefix: row.prefix,
    given: row.given,
    nickname: row.nickname,
    surname: row.surname,
    suffix: row.suffix,
    isPrimary: row.is_primary === 1,
    sortOrder: row.sort_order,
  };
}

function livingFlag(living: boolean | null | undefined): 0 | 1 | null {
  return living === null || living === undefined ? null : living ? 1 : 0;
}

function assertSex(sex: string): asserts sex is Sex {
  if (!(SEXES as readonly string[]).includes(sex)) throw new TreeRuleError(`unknown sex: ${sex}`);
}

function assertNameType(type: string): void {
  if (!(NAME_TYPES as readonly string[]).includes(type)) {
    throw new TreeRuleError(`unknown name type: ${type}`);
  }
}

/** Trims a name part and collapses runs of spaces, so "  Mary   Ann " is stored as "Mary Ann". */
function clean(part: string | undefined): string {
  return (part ?? '').trim().replace(/\s+/g, ' ');
}

export function getPerson(tree: Tree, id: string): Person | null {
  const row = sql(
    tree.db,
    'SELECT id, sex, living, note, created_at, updated_at FROM person WHERE id = ?',
  ).get(id) as PersonRow | undefined;
  return row ? toPerson(row) : null;
}

/** Like {@link getPerson}, but a missing person is an error. */
export function requirePerson(tree: Tree, id: string): Person {
  const person = getPerson(tree, id);
  if (!person) throw new NotFoundError('person', id);
  return person;
}

export function countPersons(tree: Tree): number {
  return sql(tree.db, 'SELECT count(*) FROM person').pluck().get() as number;
}

export function createPerson(tree: Tree, input: NewPerson = {}): Person {
  const sex = input.sex ?? 'U';
  assertSex(sex);
  return tree.transact('Add person', () => {
    const id = newId();
    const now = Date.now();
    sql(
      tree.db,
      'INSERT INTO person (id, sex, living, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, sex, livingFlag(input.living), now, now);
    if (input.name) addName(tree, id, input.name);
    return requirePerson(tree, id);
  });
}

export function updatePerson(
  tree: Tree,
  id: string,
  patch: { sex?: Sex; living?: boolean | null; note?: string },
): Person {
  if (patch.sex !== undefined) assertSex(patch.sex);
  return tree.transact('Edit person', () => {
    const current = requirePerson(tree, id);
    const sex = patch.sex ?? current.sex;
    const living = patch.living === undefined ? current.living : patch.living;
    const note = patch.note === undefined ? current.note : cleanNote(patch.note);
    if (sex === current.sex && living === current.living && note === current.note) return current;
    sql(
      tree.db,
      'UPDATE person SET sex = ?, living = ?, note = ?, updated_at = ? WHERE id = ?',
    ).run(sex, livingFlag(living), note, Date.now(), id);
    return requirePerson(tree, id);
  });
}

/**
 * Deletes a person with their names, their own events and their links to
 * families. A family stays, with that partner or child removed, as long as it
 * still links two people or has events of its own (see `pruneFamilies`).
 * Shared events stay for the other participants.
 */
export function deletePerson(tree: Tree, id: string): void {
  tree.transact('Delete person', () => {
    requirePerson(tree, id);
    // Events this person shares with nobody else would be left without an owner.
    sql(
      tree.db,
      `DELETE FROM event
       WHERE id IN (SELECT event_id FROM event_participant WHERE person_id = @id)
         AND NOT EXISTS (
           SELECT 1 FROM event_participant other
           WHERE other.event_id = event.id AND other.person_id IS NOT @id
         )`,
    ).run({ id });
    const families = sql(
      tree.db,
      `SELECT id FROM family WHERE partner1_id = @id OR partner2_id = @id
       UNION
       SELECT family_id FROM family_child WHERE child_id = @id`,
    )
      .pluck()
      .all({ id }) as string[];
    // Names, family links and event links go with the person (foreign-key cascade).
    sql(tree.db, 'DELETE FROM person WHERE id = ?').run(id);
    pruneFamilies(tree, families);
  });
}

export function listNames(tree: Tree, personId: string): PersonName[] {
  const rows = sql(
    tree.db,
    `SELECT ${NAME_COLUMNS} FROM person_name
     WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id`,
  ).all(personId) as NameRow[];
  return rows.map(toName);
}

function requireName(tree: Tree, nameId: string): PersonName {
  const row = sql(tree.db, `SELECT ${NAME_COLUMNS} FROM person_name WHERE id = ?`).get(nameId) as
    NameRow | undefined;
  if (!row) throw new NotFoundError('name', nameId);
  return toName(row);
}

/** Adds a name. A person's first name is their primary one; pass `primary` to replace it. */
export function addName(
  tree: Tree,
  personId: string,
  input: NameInput & { primary?: boolean },
): PersonName {
  const type = input.type ?? 'birth';
  assertNameType(type);
  return tree.transact('Add name', () => {
    requirePerson(tree, personId);
    const existing = sql(
      tree.db,
      'SELECT count(*) AS n, max(sort_order) AS last FROM person_name WHERE person_id = ?',
    ).get(personId) as { n: number; last: number | null };
    const primary = existing.n === 0 || input.primary === true;
    if (primary) {
      sql(
        tree.db,
        'UPDATE person_name SET is_primary = 0 WHERE person_id = ? AND is_primary = 1',
      ).run(personId);
    }
    const id = newId();
    sql(
      tree.db,
      `INSERT INTO person_name (${NAME_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      personId,
      type,
      clean(input.prefix),
      clean(input.given),
      clean(input.nickname),
      clean(input.surname),
      clean(input.suffix),
      primary ? 1 : 0,
      (existing.last ?? -1) + 1,
    );
    return requireName(tree, id);
  });
}

export function updateName(tree: Tree, nameId: string, patch: NameInput): PersonName {
  if (patch.type !== undefined) assertNameType(patch.type);
  return tree.transact('Edit name', () => {
    const current = requireName(tree, nameId);
    const part = (next: string | undefined, now: string) =>
      next === undefined ? now : clean(next);
    sql(
      tree.db,
      `UPDATE person_name
       SET type = ?, prefix = ?, given = ?, nickname = ?, surname = ?, suffix = ?
       WHERE id = ?`,
    ).run(
      patch.type ?? current.type,
      part(patch.prefix, current.prefix),
      part(patch.given, current.given),
      part(patch.nickname, current.nickname),
      part(patch.surname, current.surname),
      part(patch.suffix, current.suffix),
      nameId,
    );
    return requireName(tree, nameId);
  });
}

/** Makes a name the one shown for its person. */
export function setPrimaryName(tree: Tree, nameId: string): PersonName {
  return tree.transact('Change primary name', () => {
    const name = requireName(tree, nameId);
    if (name.isPrimary) return name;
    sql(
      tree.db,
      'UPDATE person_name SET is_primary = 0 WHERE person_id = ? AND is_primary = 1',
    ).run(name.personId);
    sql(tree.db, 'UPDATE person_name SET is_primary = 1 WHERE id = ?').run(nameId);
    return requireName(tree, nameId);
  });
}

/** Deletes a name. If it was the primary one, the person's next name takes its place. */
export function deleteName(tree: Tree, nameId: string): void {
  tree.transact('Delete name', () => {
    const name = requireName(tree, nameId);
    sql(tree.db, 'DELETE FROM person_name WHERE id = ?').run(nameId);
    if (!name.isPrimary) return;
    const next = sql(
      tree.db,
      'SELECT id FROM person_name WHERE person_id = ? ORDER BY sort_order, id LIMIT 1',
    )
      .pluck()
      .get(name.personId) as string | undefined;
    if (next) sql(tree.db, 'UPDATE person_name SET is_primary = 1 WHERE id = ?').run(next);
  });
}
