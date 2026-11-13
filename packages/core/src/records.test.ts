import { describe, expect, it } from 'vitest';
import { calendarToJdn } from './date';
import {
  TEXT_QUERY_YEAR_SPAN,
  US_STATES,
  externalDate,
  isEmptyQuery,
  isEmptyTextQuery,
  queryYear,
  textQueryProblem,
  textQueryWords,
  type TextQuery,
} from './records';

const day = (year: number, month: number, date: number) =>
  calendarToJdn('gregorian', year, month, date);

describe('queryYear', () => {
  it('gives the year of a full date and of a year', () => {
    expect(queryYear({ minJdn: day(1835, 11, 30), maxJdn: day(1835, 11, 30) })).toBe(1835);
    expect(queryYear({ minJdn: day(1835, 1, 1), maxJdn: day(1835, 12, 31) })).toBe(1835);
  });

  it('gives the middle year of a period', () => {
    expect(queryYear({ minJdn: day(1830, 1, 1), maxJdn: day(1840, 12, 31) })).toBe(1835);
  });

  it('gives none for a date that is open to one side, or unknown', () => {
    expect(queryYear({ minJdn: null, maxJdn: day(1850, 1, 1) })).toBeNull();
    expect(queryYear({ minJdn: day(1850, 1, 1), maxJdn: null })).toBeNull();
    expect(queryYear({ minJdn: null, maxJdn: null })).toBeNull();
  });
});

describe('externalDate', () => {
  it('writes what is known of a date', () => {
    expect(externalDate(1816, 2, 16)).toBe('16 FEB 1816');
    expect(externalDate(1854, 8, 0)).toBe('AUG 1854');
    expect(externalDate(1837, 0, 0)).toBe('1837');
    // A day without a month says nothing.
    expect(externalDate(1837, 0, 12)).toBe('1837');
  });

  it('says how sure the date is', () => {
    expect(externalDate(1837, 0, 0, 'about')).toBe('ABT 1837');
    expect(externalDate(1837, 5, 0, 'before')).toBe('BEF MAY 1837');
    expect(externalDate(1837, 5, 2, 'after')).toBe('AFT 2 MAY 1837');
  });

  it('gives nothing for numbers that are no date', () => {
    expect(externalDate(0, 0, 0)).toBe('');
    expect(externalDate(1837, 13, 1)).toBe('');
    expect(externalDate(1837, 1, 32)).toBe('');
    expect(externalDate(1837.5, 1, 1)).toBe('');
    expect(externalDate(Number.NaN, 1, 1)).toBe('');
  });
});

describe('isEmptyQuery', () => {
  it('needs a name', () => {
    expect(isEmptyQuery({ given: ' ', surname: '', birthYear: 1835, deathYear: null })).toBe(true);
    expect(isEmptyQuery({ given: '', surname: 'Marsh', birthYear: null, deathYear: null })).toBe(
      false,
    );
  });
});

describe('a query for texts', () => {
  const query = (changes: Partial<TextQuery> = {}): TextQuery => ({
    words: 'Josiah Marsh',
    phrase: true,
    fromYear: 1850,
    toYear: 1911,
    state: '',
    ...changes,
  });

  it('sends its words trimmed, with one space between them', () => {
    expect(textQueryWords(query({ words: '  Josiah \t  Marsh\n' }))).toBe('Josiah Marsh');
    expect(isEmptyTextQuery(query({ words: ' \n ' }))).toBe(true);
    expect(isEmptyTextQuery(query())).toBe(false);
  });

  it('needs years in order, and not too many of them', () => {
    expect(textQueryProblem(query())).toBeNull();
    expect(textQueryProblem(query({ fromYear: null, toYear: null }))).toBeNull();
    expect(textQueryProblem(query({ fromYear: 1700, toYear: null }))).toBeNull();
    expect(textQueryProblem(query({ fromYear: 1900, toYear: 1900 }))).toBeNull();
    expect(textQueryProblem(query({ fromYear: 1901, toYear: 1900 }))).toEqual(expect.any(String));
    expect(
      textQueryProblem(query({ fromYear: 1800, toYear: 1800 + TEXT_QUERY_YEAR_SPAN })),
    ).toBeNull();
    expect(
      textQueryProblem(query({ fromYear: 1800, toYear: 1801 + TEXT_QUERY_YEAR_SPAN })),
    ).toEqual(expect.any(String));
  });

  it('knows the states a search can be kept to, and no other', () => {
    expect(US_STATES).toHaveLength(52);
    expect(new Set(US_STATES).size).toBe(52);
    expect(textQueryProblem(query({ state: 'Vermont' }))).toBeNull();
    expect(textQueryProblem(query({ state: 'vermont' }))).toEqual(expect.any(String));
    expect(textQueryProblem(query({ state: 'Atlantis' }))).toEqual(expect.any(String));
  });
});
