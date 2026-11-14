import { cleanText } from '@rulz/connectors';
import {
  FAMILY_EVENT_TYPES,
  NAME_TYPES,
  PERSON_EVENT_TYPES,
  PLACE_TEXT_MAX,
  formatName,
  toGedcomDate,
  type Sex,
} from '@rulz/core';
import {
  getPerson,
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  listFamilyEvents,
  listNames,
  listPersonEvents,
  presumedLivingIds,
  requireFamily,
  searchPersons,
  sortEventsForDisplay,
  type Tree,
  type TreeEvent,
} from '@rulz/db';

/**
 * What the optional AI assistant may read of the open tree. These are the
 * only readers of a tree the assistant's tools have, so what they leave out
 * never reaches an AI service:
 *
 * - **A person who may be living** is never given: not their name, their
 *   dates, their places, their sex or their id. Where they are a relative of
 *   someone who is given, they stand as "Living person" and nothing more. A
 *   search of the tree leaves them out and does not say how many it left out,
 *   since a count would say that a living person of that name is in the tree.
 *   Asked for by id, they get the answer of someone who is not in the tree.
 * - **Free text of the user** is never given: notes, the description of an
 *   event, a date typed as a phrase. Such a text can name anyone, and no rule
 *   can take the living people out of it. A date is written anew by the app
 *   from what it reads in the text. Names and places are given as they stand:
 *   they are what a record is held against.
 * - **An event of a couple** is not given while the other partner may be
 *   living: their wedding is the living partner's wedding too.
 * - Sources, citations, pictures and documents, and the lines kept of a
 *   GEDCOM file are not read here at all.
 *
 * What is given is cleaned as a text of a source is: one line, no control
 * characters, cut at a length. A tree can come from someone else's file.
 */

/** What stands for a relative who may be living. */
export const LIVING_LABEL = 'Living person';

/** What a search of the tree says with every answer. */
export const LIVING_NOTE =
  'People who may be living are never listed, and this search does not say whether it left anyone out.';

/** The most people one answer of a search of the tree lists. */
export const FIND_LIMIT = 25;

/** How many matches of a search are read at a time: the most the search of a tree gives in one go. */
const FIND_SCAN = 500;

const NAME_MAX = 200;
/** A longer text than this is no date. */
const DATE_READ_MAX = 250;

/** One day, month or year as the app writes it: "12 MAR 1881", "JULIAN FEB 1700", "44 BCE". */
const ONE_DATE =
  '(?:JULIAN )?(?:\\d{1,2} )?(?:(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC) )?\\d{1,4}(?: BCE)?';

/** A date as the app writes it, and nothing beside it. */
const WRITTEN_DATE = new RegExp(
  `^(?:(?:(?:ABT|CAL|EST|BEF|AFT|FROM|TO) )?${ONE_DATE}|BET ${ONE_DATE} AND ${ONE_DATE}|FROM ${ONE_DATE} TO ${ONE_DATE})$`,
);

/** A name of a person of the tree. */
export interface ToolName {
  /** What kind of name it is ("birth", "married"); empty when the tree holds no kind the app knows. */
  type: string;
  prefix: string;
  given: string;
  nickname: string;
  surname: string;
  suffix: string;
}

/** An event of the tree: what it is, when and where. Never its description or its note. */
export interface ToolEvent {
  /** "birth", "marriage"; "event" for a kind the app has no name for. */
  type: string;
  /** The date as the tree has it; empty when there is none, or when it is a phrase and no date. */
  date: string;
  place: string;
}

/** A person in one line: who they are, and when and where they were born and died. */
export interface ToolPersonLine {
  id: string;
  /** The main name in full; empty for a person without a name. */
  name: string;
  sex: Sex;
  birth: Omit<ToolEvent, 'type'> | null;
  death: Omit<ToolEvent, 'type'> | null;
}

/** A person of the tree with every name and every event of their own. */
export interface ToolPerson {
  id: string;
  sex: Sex;
  /** Every name, the main one first. */
  names: ToolName[];
  /** The person's own events, in the order of a life. */
  events: ToolEvent[];
}

/** A relative: a person in one line, or no more than that they may be living. */
export type ToolRelative =
  { living: true; label: typeof LIVING_LABEL } | ({ living: false } & ToolPersonLine);

/** A couple the person is one of. */
export interface ToolCouple {
  /** The other partner; null when the tree does not know them. */
  partner: ToolRelative | null;
  /** The couple's own events, such as their marriage. None while the partner may be living. */
  events: ToolEvent[];
  children: ToolRelative[];
}

export interface ToolRelatives {
  parents: ToolRelative[];
  /** Everyone who shares a parent family with the person. */
  siblings: ToolRelative[];
  couples: ToolCouple[];
}

export interface ToolFound {
  people: ToolPersonLine[];
  /** True when there are more matches after these. */
  more: boolean;
  note: typeof LIVING_NOTE;
}

/**
 * A tool gives nothing of a person. There is one answer for someone who is
 * not in the tree and for someone who may be living: two answers would say
 * of an id that a living person of the tree has it.
 */
export interface ToolRefusal {
  ok: false;
  reason: 'not-given';
  message: string;
}

export type ToolAnswer<T> = { ok: true; value: T } | ToolRefusal;

export const NOT_GIVEN: ToolRefusal = {
  ok: false,
  reason: 'not-given',
  message:
    'Nothing is given of this person: they are not in the tree, or they may be living. Nothing about living people is given.',
};

const EVENT_TYPES = new Set<string>([...PERSON_EVENT_TYPES, ...FAMILY_EVENT_TYPES]);
const KNOWN_NAME_TYPES = new Set<string>(NAME_TYPES);

/**
 * The date of an event in the wording of a GEDCOM file ("12 MAR 1881", "ABT
 * 1850"), which is how a record gives its dates too. The app writes it anew
 * from what it reads in the text: the text itself is never given, and what
 * the tree's file says of how the text was read is not believed. A text the
 * app cannot read as a date is a phrase the user typed, and gives nothing.
 */
function dateOf(text: unknown): string {
  if (typeof text !== 'string' || text.length > DATE_READ_MAX) return '';
  // The form of GEDCOM 7.0 keeps wording that goes with a date ("INT 1881 (as
  // on the stone)") apart from the date, so the date comes without it.
  const written = toGedcomDate(text, '7.0').value;
  // And only what is a date and nothing else is given: a date of a calendar
  // the app cannot read is written with the text that stood after its name.
  return WRITTEN_DATE.test(written) ? written : '';
}

/** An event as a tool gives it; null when it has neither a date nor a place to give. */
function eventOf(event: TreeEvent): ToolEvent | null {
  const date = dateOf(event.dateText);
  const place = cleanText(event.placeText, PLACE_TEXT_MAX);
  if (date === '' && place === '') return null;
  return { type: EVENT_TYPES.has(event.type) ? event.type : 'event', date, place };
}

function eventsOf(events: readonly TreeEvent[]): ToolEvent[] {
  return sortEventsForDisplay(events).flatMap((event) => eventOf(event) ?? []);
}

function namesOf(tree: Tree, personId: string): ToolName[] {
  return [...listNames(tree, personId)]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
    .map((name) => ({
      type: KNOWN_NAME_TYPES.has(name.type) ? name.type : '',
      prefix: cleanText(name.prefix, NAME_MAX),
      given: cleanText(name.given, NAME_MAX),
      nickname: cleanText(name.nickname, NAME_MAX),
      surname: cleanText(name.surname, NAME_MAX),
      suffix: cleanText(name.suffix, NAME_MAX),
    }));
}

/** A person in one line; null when they are not in the tree. The caller has seen that they are not living. */
function lineOf(tree: Tree, personId: string): ToolPersonLine | null {
  const person = getPerson(tree, personId);
  if (person === null) return null;
  const main = namesOf(tree, personId)[0];
  const events = listPersonEvents(tree, personId);
  const vital = (type: 'birth' | 'death'): Omit<ToolEvent, 'type'> | null => {
    const event = events.find((entry) => entry.type === type);
    const given = event === undefined ? null : eventOf(event);
    return given === null ? null : { date: given.date, place: given.place };
  };
  return {
    id: person.id,
    name: main === undefined ? '' : cleanText(formatName(main), NAME_MAX * 2),
    sex: person.sex,
    birth: vital('birth'),
    death: vital('death'),
  };
}

/**
 * Finds people of the tree by any of their names, best match first, as the
 * search box of the app does. People who may be living are left out.
 */
export function findPeople(
  tree: Tree,
  query: string,
  page: { limit?: number; offset?: number } = {},
  now: number = Date.now(),
): ToolFound {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? FIND_LIMIT) || 1, 1), FIND_LIMIT);
  const offset = Math.max(Math.trunc(page.offset ?? 0) || 0, 0);
  const words = typeof query === 'string' ? query.slice(0, NAME_MAX) : '';
  return tree.db.transaction((): ToolFound => {
    const living = presumedLivingIds(tree, now);
    // The matches are read a page at a time until there are enough of people
    // who are not living, or no more. So how many living people match, and
    // where they stand among the matches, changes nothing of the answer.
    const matches: string[] = [];
    for (let at = 0; matches.length <= offset + limit; at += FIND_SCAN) {
      const batch = searchPersons(tree, words, { limit: FIND_SCAN, offset: at });
      for (const match of batch) if (!living.has(match.id)) matches.push(match.id);
      if (batch.length < FIND_SCAN) break;
    }
    return {
      people: matches.slice(offset, offset + limit).flatMap((id) => lineOf(tree, id) ?? []),
      more: matches.length > offset + limit,
      note: LIVING_NOTE,
    };
  })();
}

/** Reads a person of the tree with their names and their own events. */
export function readPerson(
  tree: Tree,
  personId: string,
  now: number = Date.now(),
): ToolAnswer<ToolPerson> {
  return tree.db.transaction((): ToolAnswer<ToolPerson> => {
    const person = typeof personId === 'string' ? getPerson(tree, personId) : null;
    if (person === null || presumedLivingIds(tree, now).has(person.id)) return NOT_GIVEN;
    return {
      ok: true,
      value: {
        id: person.id,
        sex: person.sex,
        names: namesOf(tree, person.id),
        events: eventsOf(listPersonEvents(tree, person.id)),
      },
    };
  })();
}

/**
 * Reads who is close to a person of the tree: their parents, their brothers
 * and sisters, and the couples they are one of with the children of each.
 * Each relative is a person in one line, or "Living person".
 */
export function readRelatives(
  tree: Tree,
  personId: string,
  now: number = Date.now(),
): ToolAnswer<ToolRelatives> {
  return tree.db.transaction((): ToolAnswer<ToolRelatives> => {
    const person = typeof personId === 'string' ? getPerson(tree, personId) : null;
    const living = presumedLivingIds(tree, now);
    if (person === null || living.has(person.id)) return NOT_GIVEN;

    const relative = (id: string): ToolRelative | null => {
      if (living.has(id)) return { living: true, label: LIVING_LABEL };
      const line = lineOf(tree, id);
      return line === null ? null : { living: false, ...line };
    };
    /**
     * Each person once, in the order they were first named, and those who
     * may be living after the others: where one stands among their brothers
     * and sisters would say about when they were born.
     */
    const relatives = (ids: readonly (string | null)[]): ToolRelative[] =>
      [...new Set(ids.filter((id): id is string => id !== null && id !== person.id))]
        .flatMap((id) => relative(id) ?? [])
        // The sort keeps the order of what ranks the same.
        .sort((a, b) => Number(a.living) - Number(b.living));

    const parentFamilies = listFamiliesAsChild(tree, person.id).map((link) =>
      requireFamily(tree, link.familyId),
    );
    const couples = listFamiliesAsPartner(tree, person.id).map((family): ToolCouple => {
      const partnerId = family.partner1Id === person.id ? family.partner2Id : family.partner1Id;
      const partner = partnerId === null || partnerId === person.id ? null : relative(partnerId);
      return {
        partner,
        // The wedding of a couple is the wedding of both: not given while one may be living.
        events: partner?.living === true ? [] : eventsOf(listFamilyEvents(tree, family.id)),
        children: relatives(listChildren(tree, family.id).map((child) => child.childId)),
      };
    });
    return {
      ok: true,
      value: {
        parents: relatives(
          parentFamilies.flatMap((family) => [family.partner1Id, family.partner2Id]),
        ),
        siblings: relatives(
          parentFamilies.flatMap((family) =>
            listChildren(tree, family.id).map((child) => child.childId),
          ),
        ),
        couples,
      },
    };
  })();
}
