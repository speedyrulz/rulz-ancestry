import { jdnToCalendar } from './date';
import type { DaySpan } from './life';

/**
 * The shapes of a search for records outside the tree: what is asked of a
 * source, and what it answers. Every source is read into these, so that the
 * page shows a result of one source like a result of another.
 */

/** What is asked about a person. An empty text and a null year are not asked. */
export interface PersonQuery {
  given: string;
  surname: string;
  birthYear: number | null;
  deathYear: number | null;
}

/**
 * What is asked of a source of texts: newspapers, books. Words are looked for
 * in the text or its description; a year says when it was published, which is
 * not when the person lived.
 */
export interface TextQuery {
  /** The words to look for. */
  words: string;
  /** True when the words must stand together, in this order. */
  phrase: boolean;
  /** Published in this year or later; null when not asked. */
  fromYear: number | null;
  /** Published in this year or earlier; null when not asked. */
  toYear: number | null;
  /** A state of the United States a newspaper was published in, from `US_STATES`; empty when not asked. */
  state: string;
}

/** The longest words a text query may hold, in characters. */
export const TEXT_QUERY_MAX = 200;

/** The widest span of years a text query may ask for. A wider one finds too much to page through. */
export const TEXT_QUERY_YEAR_SPAN = 150;

/** The states a search of newspapers can be kept to. */
export const US_STATES: readonly string[] = [
  'Alabama',
  'Alaska',
  'Arizona',
  'Arkansas',
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'District of Columbia',
  'Florida',
  'Georgia',
  'Hawaii',
  'Idaho',
  'Illinois',
  'Indiana',
  'Iowa',
  'Kansas',
  'Kentucky',
  'Louisiana',
  'Maine',
  'Maryland',
  'Massachusetts',
  'Michigan',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Montana',
  'Nebraska',
  'Nevada',
  'New Hampshire',
  'New Jersey',
  'New Mexico',
  'New York',
  'North Carolina',
  'North Dakota',
  'Ohio',
  'Oklahoma',
  'Oregon',
  'Pennsylvania',
  'Puerto Rico',
  'Rhode Island',
  'South Carolina',
  'South Dakota',
  'Tennessee',
  'Texas',
  'Utah',
  'Vermont',
  'Virginia',
  'Washington',
  'West Virginia',
  'Wisconsin',
  'Wyoming',
];

/** The words of a text query as they are sent: trimmed, with one space between them. */
export function textQueryWords(query: TextQuery): string {
  return query.words.trim().replace(/\s+/g, ' ');
}

/** True when a text query asks nothing: a source is not asked then. */
export function isEmptyTextQuery(query: TextQuery): boolean {
  return textQueryWords(query) === '';
}

/**
 * Why a text query cannot be sent, in words for the user; null when it can.
 * An empty one is not a fault of this kind (see `isEmptyTextQuery`).
 */
export function textQueryProblem(query: TextQuery): string | null {
  const { fromYear, toYear } = query;
  if (fromYear !== null && toYear !== null) {
    if (fromYear > toYear) return 'The first year is after the last.';
    if (toYear - fromYear > TEXT_QUERY_YEAR_SPAN) {
      return `Ask for at most ${TEXT_QUERY_YEAR_SPAN} years at a time.`;
    }
  }
  if (query.state !== '' && !US_STATES.includes(query.state)) return 'This state is not known.';
  return null;
}

/** How many years to either side of a year of a query a record may lie. */
export const QUERY_YEAR_SPREAD = 2;

/** The earliest year a query may name. */
export const QUERY_FIRST_YEAR = 1;

/** Which results of a search are asked for. */
export interface PageRequest {
  /** How many results come before the first that is asked for. */
  offset: number;
  limit: number;
}

export interface Page<T> {
  items: T[];
  /** How many results the source has in all; null when it does not say. */
  total: number | null;
  /** What to ask for to get the results after these; null when there are none. */
  next: PageRequest | null;
  /**
   * How many results of this page were left out: profiles of living people,
   * and private ones, of which a source gives next to nothing.
   */
  hidden: number;
}

/** A birth or a death as a record gives it. */
export interface ExternalFact {
  type: 'birth' | 'death';
  /** The date in the wording of a GEDCOM file ("ABT 1835", "16 FEB 1816"); empty when not given. */
  date: string;
  /** The place as the source writes it; empty when not given. */
  place: string;
}

/** What every result of a search has. All of its texts are plain text, never HTML. */
interface RecordBase {
  /** The source's id, as in its manifest. */
  connectorId: string;
  /** What the source calls the record. With the source's id it names the record for good. */
  key: string;
  /** The line the record is shown under: for a person, their name. */
  title: string;
  /** The record's page at the source, for the user's browser. Always HTTPS, on the source's own site. */
  url: string;
}

/** A person, as a source that keeps people knows them. */
export interface PersonRecord extends RecordBase {
  kind: 'person';
  sex: 'M' | 'F' | null;
  facts: ExternalFact[];
  /** What the source says of the person in a few words ("Dutch painter"); empty when it says nothing. */
  about: string;
}

/**
 * A record of an event that names a person in some role: the child of a
 * birth record, the bride or a witness of a marriage record. It is a record
 * of the event, not a profile of the person, and its date and place are
 * those of the event.
 */
export interface EventRecord extends RecordBase {
  kind: 'event';
  /** What the person is in the record, as the source says: "Bride", "Father of bride". */
  role: string;
  /** What the record is of, as the source says: "Marriage", "Birth". */
  event: string;
  /** When the event was, in the wording of a GEDCOM file; empty when not given. */
  date: string;
  /** Where the event was; empty when not given. */
  place: string;
  /** What kind of record it is and who keeps it: "Civil registration marriages, Municipal archive The Hague". */
  held: string;
}

/**
 * A text: a page of a newspaper, a book. It was found by its words; whether it
 * is about the person is for the user to read.
 */
export interface TextRecord extends RecordBase {
  kind: 'text';
  /** When it was published, in the wording of a GEDCOM file; empty when not given. */
  date: string;
  /** Who wrote or published it, as the source says; empty when not given. */
  by: string;
}

/** One result of a search. */
export type ExternalRecord = PersonRecord | EventRecord | TextRecord;

/**
 * How many years back an event must lie before the people it names are taken
 * to have died. The same span as the rule for the people of a tree.
 */
export const PRESUMED_DEAD_AFTER_YEARS = 110;

/**
 * True when an event of a year lies more than that many years back for
 * certain, on whatever day of the year it was: an event of the last day of
 * 1916 is not 110 years back on any day of 2026.
 */
export function isLongAgo(year: number, thisYear: number): boolean {
  return Number.isInteger(year) && year < thisYear - PRESUMED_DEAD_AFTER_YEARS;
}

/** True when a query asks nothing: a source is not asked then. */
export function isEmptyQuery(query: PersonQuery): boolean {
  return query.given.trim() === '' && query.surname.trim() === '';
}

/**
 * The year to ask a source for, of a date of the tree. A date that can mean
 * days of several years gives the year in their middle; a date that is open
 * to one side ("before 1850") gives none.
 */
export function queryYear(span: DaySpan): number | null {
  if (span.minJdn === null || span.maxJdn === null) return null;
  const middle = Math.floor((span.minJdn + span.maxJdn) / 2);
  const year = jdnToCalendar('gregorian', middle).year;
  return year >= QUERY_FIRST_YEAR ? year : null;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * A date a source gives as numbers, in the wording of a GEDCOM file. A month
 * or a day of 0 is one the source does not know. Empty when the year is not
 * known, or when the numbers are no date.
 */
export function externalDate(
  year: number,
  month: number,
  day: number,
  qualifier: 'about' | 'before' | 'after' | null = null,
): string {
  const whole = [year, month, day].every((part) => Number.isInteger(part));
  if (!whole || year < 1 || year > 9999 || month < 0 || month > 12 || day < 0 || day > 31) {
    return '';
  }
  const name = MONTHS[month - 1];
  const parts = [
    qualifier === 'about'
      ? 'ABT'
      : qualifier === 'before'
        ? 'BEF'
        : qualifier === 'after'
          ? 'AFT'
          : '',
    name !== undefined && day > 0 ? String(day) : '',
    name ?? '',
    String(year),
  ];
  return parts.filter((part) => part !== '').join(' ');
}
