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

/** One result of a search. All of its texts are plain text, never HTML. */
export interface ExternalRecord {
  /** The source's id, as in its manifest. */
  connectorId: string;
  /** What the source calls the record. With the source's id it names the record for good. */
  key: string;
  kind: 'person';
  /** The line the record is shown under: for a person, their name. */
  title: string;
  /** The record's page at the source, for the user's browser. Always HTTPS, on the source's own site. */
  url: string;
  sex: 'M' | 'F' | null;
  facts: ExternalFact[];
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
