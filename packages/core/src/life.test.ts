import { describe, expect, it } from 'vitest';
import { calendarToJdn, parseDate } from './date';
import { ageRange, formatAge, type DaySpan } from './life';

function span(text: string): DaySpan {
  const date = parseDate(text);
  if (!date) throw new Error(`not a date: ${text}`);
  return { minJdn: date.minJdn, maxJdn: date.maxJdn };
}

describe('ageRange', () => {
  it('counts whole years between two days', () => {
    expect(ageRange(span('12 MAR 1850'), span('11 MAR 1873'))).toEqual({ min: 22, max: 22 });
    expect(ageRange(span('12 MAR 1850'), span('12 MAR 1873'))).toEqual({ min: 23, max: 23 });
    expect(ageRange(span('12 MAR 1850'), span('12 MAR 1850'))).toEqual({ min: 0, max: 0 });
  });

  it('gives a range when a date names only a year', () => {
    expect(ageRange(span('1850'), span('1873'))).toEqual({ min: 22, max: 23 });
    expect(ageRange(span('12 MAR 1850'), span('1873'))).toEqual({ min: 22, max: 23 });
    expect(ageRange(span('1850'), span('1 JAN 1873'))).toEqual({ min: 22, max: 23 });
  });

  it('gives the whole of a period', () => {
    expect(ageRange(span('1 JAN 1850'), span('FROM 1870 TO 1895'))).toEqual({ min: 20, max: 45 });
  });

  it('never gives less than nothing for the year of the birth', () => {
    expect(ageRange(span('1850'), span('1850'))).toEqual({ min: 0, max: 0 });
    expect(ageRange(span('JUN 1850'), span('1850'))).toEqual({ min: 0, max: 0 });
  });

  it('has no answer for an open-ended or missing date', () => {
    expect(ageRange(span('BEF 1850'), span('1873'))).toBeNull();
    expect(ageRange(span('1850'), span('AFT 1873'))).toBeNull();
    expect(ageRange({ minJdn: null, maxJdn: null }, span('1873'))).toBeNull();
  });

  it('has no answer for a day before the birth or beyond a lifetime', () => {
    expect(ageRange(span('1850'), span('1849'))).toBeNull();
    expect(ageRange(span('1850'), span('1990'))).toBeNull();
    const day = calendarToJdn('gregorian', 1850, 1, 1);
    expect(ageRange({ minJdn: day, maxJdn: day }, { minJdn: day - 1, maxJdn: day - 1 })).toBeNull();
  });
});

describe('formatAge', () => {
  it('writes one age, two neighbours and a range', () => {
    expect(formatAge({ min: 23, max: 23 })).toBe('age 23');
    expect(formatAge({ min: 22, max: 23 })).toBe('age 22 or 23');
    expect(formatAge({ min: 20, max: 45 })).toBe('age 20 to 45');
  });
});
