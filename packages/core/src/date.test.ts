import { describe, expect, it } from 'vitest';
import { calendarToJdn, describeDate, jdnToCalendar, parseDate, yearLabel } from './date';

/** Gregorian day number worked out independently, from JavaScript's own calendar. */
function jdn(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / 86_400_000 + 2_440_588;
}

describe('calendarToJdn', () => {
  it('matches known Julian Day Numbers', () => {
    expect(calendarToJdn('gregorian', 2000, 1, 1)).toBe(2_451_545);
    expect(calendarToJdn('gregorian', 1970, 1, 1)).toBe(2_440_588);
    // Day zero of the count: 1 January 4713 BC in the Julian calendar.
    expect(calendarToJdn('julian', -4712, 1, 1)).toBe(0);
  });

  it('agrees with the JavaScript calendar across four centuries', () => {
    for (let year = 1600; year <= 2000; year += 7) {
      for (const [month, day] of [
        [1, 1],
        [2, 28],
        [3, 1],
        [12, 31],
      ] as const) {
        expect(calendarToJdn('gregorian', year, month, day)).toBe(jdn(year, month, day));
      }
    }
  });

  it('places the 1582 calendar change correctly', () => {
    // Thursday 4 October 1582 (Julian) was followed by Friday 15 October (Gregorian).
    expect(calendarToJdn('julian', 1582, 10, 5)).toBe(calendarToJdn('gregorian', 1582, 10, 15));
    expect(calendarToJdn('gregorian', 1582, 10, 15)).toBe(2_299_161);
  });
});

describe('jdnToCalendar', () => {
  it('reverses calendarToJdn in both calendars', () => {
    for (const calendar of ['gregorian', 'julian'] as const) {
      for (const date of [
        { year: 2000, month: 2, day: 29 },
        { year: 1881, month: 3, day: 12 },
        { year: 1582, month: 10, day: 15 },
        { year: 1, month: 1, day: 1 },
        { year: -43, month: 3, day: 15 },
      ]) {
        const day = calendarToJdn(calendar, date.year, date.month, date.day);
        expect(jdnToCalendar(calendar, day)).toEqual(date);
      }
    }
  });
});

describe('parseDate', () => {
  it('returns null for empty text', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('   ')).toBeNull();
  });

  it('keeps the text as typed', () => {
    expect(parseDate('  abt  1850 ')?.text).toBe('abt  1850');
  });

  it('reads a full date written in the common ways', () => {
    const day = jdn(1881, 3, 12);
    for (const text of [
      '12 MAR 1881',
      '12 Mar 1881',
      '12 March 1881',
      '12th March 1881',
      'March 12, 1881',
      'Mar. 12 1881',
      '1881-03-12',
      '@#DGREGORIAN@ 12 MAR 1881',
      'GREGORIAN 12 MAR 1881',
    ]) {
      expect(parseDate(text), text).toEqual({
        text,
        qualifier: 'exact',
        calendar: 'gregorian',
        minJdn: day,
        maxJdn: day,
      });
    }
  });

  it('gives a month or a year the range of days it covers', () => {
    expect(parseDate('Mar 1881')).toMatchObject({
      qualifier: 'exact',
      minJdn: jdn(1881, 3, 1),
      maxJdn: jdn(1881, 3, 31),
    });
    expect(parseDate('1881-03')).toMatchObject({
      minJdn: jdn(1881, 3, 1),
      maxJdn: jdn(1881, 3, 31),
    });
    expect(parseDate('1881')).toMatchObject({
      minJdn: jdn(1881, 1, 1),
      maxJdn: jdn(1881, 12, 31),
    });
    expect(parseDate('850')).toMatchObject({ minJdn: calendarToJdn('gregorian', 850, 1, 1) });
  });

  it('applies leap-year rules per calendar', () => {
    expect(parseDate('Feb 1900')?.maxJdn).toBe(jdn(1900, 2, 28));
    expect(parseDate('Feb 2000')?.maxJdn).toBe(jdn(2000, 2, 29));
    // 1900 is a leap year in the Julian calendar.
    expect(parseDate('@#DJULIAN@ FEB 1900')?.maxJdn).toBe(calendarToJdn('julian', 1900, 2, 29));
    expect(parseDate('29 Feb 1900')?.qualifier).toBe('phrase');
    expect(parseDate('@#DJULIAN@ 29 FEB 1900')?.qualifier).toBe('exact');
  });

  it('reads approximate dates', () => {
    for (const text of ['ABT 1850', 'abt. 1850', 'about 1850', 'c. 1850', 'c1850', 'ca 1850']) {
      expect(parseDate(text), text).toMatchObject({
        qualifier: 'about',
        minJdn: jdn(1850, 1, 1),
        maxJdn: jdn(1850, 12, 31),
      });
    }
    expect(parseDate('circa March 1850')).toMatchObject({
      qualifier: 'about',
      minJdn: jdn(1850, 3, 1),
    });
    expect(parseDate('~1850')?.qualifier).toBe('about');
    expect(parseDate('EST 1850')?.qualifier).toBe('estimated');
    expect(parseDate('CAL 1850')?.qualifier).toBe('calculated');
  });

  it('leaves one side open for before and after', () => {
    expect(parseDate('BEF 1900')).toMatchObject({
      qualifier: 'before',
      minJdn: null,
      maxJdn: jdn(1899, 12, 31),
    });
    expect(parseDate('before 12 Mar 1881')).toMatchObject({
      minJdn: null,
      maxJdn: jdn(1881, 3, 11),
    });
    expect(parseDate('AFT 1900')).toMatchObject({
      qualifier: 'after',
      minJdn: jdn(1901, 1, 1),
      maxJdn: null,
    });
    // "APR" and "AUG" must not be mistaken for "AFT".
    expect(parseDate('Apr 1900')?.qualifier).toBe('exact');
    expect(parseDate('Aug 1900')?.qualifier).toBe('exact');
  });

  it('reads ranges and periods', () => {
    const range = { minJdn: jdn(1900, 1, 1), maxJdn: jdn(1905, 12, 31) };
    expect(parseDate('BET 1900 AND 1905')).toMatchObject({ qualifier: 'between', ...range });
    expect(parseDate('between 1900 and 1905')).toMatchObject({ qualifier: 'between', ...range });
    expect(parseDate('1900-1905')).toMatchObject({ qualifier: 'between', ...range });
    expect(parseDate('1900–1905')).toMatchObject({ qualifier: 'between', ...range });
    expect(parseDate('BET 1905 AND 1900')).toMatchObject({ qualifier: 'between', ...range });
    expect(parseDate('between 3 Jan 1900 and Mar 1905')).toMatchObject({
      minJdn: jdn(1900, 1, 3),
      maxJdn: jdn(1905, 3, 31),
    });
    expect(parseDate('FROM 1900 TO 1905')).toMatchObject({ qualifier: 'from-to', ...range });
    expect(parseDate('Oct 1900 to 1905')).toMatchObject({
      qualifier: 'from-to',
      minJdn: jdn(1900, 10, 1),
    });
    expect(parseDate('FROM 1900')).toMatchObject({
      qualifier: 'from',
      minJdn: jdn(1900, 1, 1),
      maxJdn: null,
    });
    expect(parseDate('TO 1905')).toMatchObject({
      qualifier: 'to',
      minJdn: null,
      maxJdn: jdn(1905, 12, 31),
    });
  });

  it('reads an ISO year and month as a month, not a range', () => {
    expect(parseDate('1850-12')).toMatchObject({
      qualifier: 'exact',
      minJdn: jdn(1850, 12, 1),
      maxJdn: jdn(1850, 12, 31),
    });
  });

  it('converts Julian calendar dates', () => {
    // George Washington: 11 February 1731/32 Old Style is 22 February 1732 New Style.
    const newStyle = jdn(1732, 2, 22);
    expect(parseDate('@#DJULIAN@ 11 FEB 1732')).toMatchObject({
      calendar: 'julian',
      minJdn: newStyle,
      maxJdn: newStyle,
    });
    expect(parseDate('JULIAN 11 FEB 1732')).toMatchObject({
      calendar: 'julian',
      minJdn: newStyle,
    });
    expect(parseDate('11 Feb 1731/32')).toMatchObject({ calendar: 'julian', minJdn: newStyle });
    expect(parseDate('11 Feb 1731/2')?.minJdn).toBe(newStyle);
    expect(parseDate('25 Mar 1699/00')?.minJdn).toBe(calendarToJdn('julian', 1700, 3, 25));
    // The second year must follow the first.
    expect(parseDate('11 Feb 1731/35')?.qualifier).toBe('phrase');
  });

  it('reads years before the common era', () => {
    const start = calendarToJdn('gregorian', -43, 1, 1);
    for (const text of ['44 BC', '44 B.C.', '44 BCE', '44BC']) {
      expect(parseDate(text), text).toMatchObject({ qualifier: 'exact', minJdn: start });
    }
    expect(parseDate('15 Mar 44 BC')?.minJdn).toBe(calendarToJdn('gregorian', -43, 3, 15));
    // December must not be read as "before Christ".
    expect(parseDate('12 Dec 1900')?.minJdn).toBe(jdn(1900, 12, 12));
  });

  it('records calendars it cannot convert yet without a range', () => {
    expect(parseDate('@#DHEBREW@ 5 TSH 5661')).toEqual({
      text: '@#DHEBREW@ 5 TSH 5661',
      qualifier: 'exact',
      calendar: 'hebrew',
      minJdn: null,
      maxJdn: null,
    });
    expect(parseDate('ABT @#DFRENCH R@ 1 VEND 3')).toMatchObject({
      qualifier: 'about',
      calendar: 'french-republican',
      minJdn: null,
    });
    expect(parseDate('@#DROMAN@ 700')?.calendar).toBe('other');
  });

  it('reads an interpreted date and ignores its explanation', () => {
    expect(parseDate('INT 1881 (the year of the fire)')).toMatchObject({
      qualifier: 'interpreted',
      minJdn: jdn(1881, 1, 1),
      maxJdn: jdn(1881, 12, 31),
    });
  });

  it('stores text it cannot read as a phrase', () => {
    for (const text of [
      '(sometime in spring)',
      'after the war',
      '31 Feb 1900',
      '12 Foo 1881',
      // Day/month order is ambiguous, and a two-digit year has no century.
      '12/03/1881',
      '12 Mar 81',
      '1881-13-01',
      '0',
    ]) {
      expect(parseDate(text), text).toEqual({
        text,
        qualifier: 'phrase',
        calendar: null,
        minJdn: null,
        maxJdn: null,
      });
    }
  });
});

/** Parses text that is expected to be a date, so the helpers below get a non-null value. */
function read(text: string) {
  const parsed = parseDate(text);
  if (!parsed) throw new Error(`no date in "${text}"`);
  return parsed;
}

describe('describeDate', () => {
  it('names the largest unit a date exactly covers', () => {
    expect(describeDate(read('12 Mar 1881'))).toBe('12 March 1881');
    expect(describeDate(read('mar 1881'))).toBe('March 1881');
    expect(describeDate(read('1881'))).toBe('1881');
    expect(describeDate(read('Feb 1900'))).toBe('February 1900');
    expect(describeDate(read('1881-03-12'))).toBe('12 March 1881');
  });

  it('keeps the qualifier in words', () => {
    expect(describeDate(read('abt 1850'))).toBe('about 1850');
    expect(describeDate(read('EST 1850'))).toBe('estimated 1850');
    expect(describeDate(read('CAL Mar 1850'))).toBe('calculated March 1850');
    expect(describeDate(read('INT 1881 (torn page)'))).toBe('1881');
  });

  it('gives the exact boundary of an open-ended date', () => {
    expect(describeDate(read('BEF 1900'))).toBe('before 1 January 1900');
    expect(describeDate(read('AFT 1900'))).toBe('after 31 December 1900');
    expect(describeDate(read('aft 12 Mar 1881'))).toBe('after 12 March 1881');
    expect(describeDate(read('FROM 1850'))).toBe('from 1 January 1850');
    expect(describeDate(read('TO 1855'))).toBe('until 31 December 1855');
  });

  it('gives both ends of a range', () => {
    expect(describeDate(read('BET 1850 AND 1855'))).toBe(
      'between 1 January 1850 and 31 December 1855',
    );
    expect(describeDate(read('FROM Mar 1850 TO 12 Apr 1851'))).toBe(
      'from 1 March 1850 to 12 April 1851',
    );
  });

  it('says when a date is in the Julian calendar or before year 1', () => {
    expect(describeDate(read('@#DJULIAN@ 4 Oct 1582'))).toBe('4 October 1582 (Julian calendar)');
    expect(describeDate(read('11 Feb 1731/32'))).toBe('11 February 1732 (Julian calendar)');
    expect(describeDate(read('44 BC'))).toBe('44 BC');
  });

  it('explains a calendar it cannot convert, and returns null for a phrase', () => {
    expect(describeDate(read('@#DHEBREW@ 5 TSH 5600'))).toMatch(/^a Hebrew calendar date/);
    expect(describeDate(read('@#DFRENCH R@ 1 VEND 3'))).toMatch(/^a French Republican calendar/);
    expect(describeDate(read('after the war'))).toBeNull();
    expect(describeDate(read('12/03/1881'))).toBeNull();
  });
});

describe('yearLabel', () => {
  it('gives the year of a date in its short list form', () => {
    const cases: [string, string][] = [
      ['12 Mar 1881', '1881'],
      ['Mar 1881', '1881'],
      ['1881', '1881'],
      ['abt 1850', 'c. 1850'],
      ['EST 12 Mar 1850', 'c. 1850'],
      ['BEF 1900', 'bef. 1900'],
      ['AFT 1900', 'aft. 1900'],
      ['bef 12 Mar 1881', 'bef. 1881'],
      ['FROM 1850', '1850'],
      ['TO 1855', '1855'],
      ['BET 1850 AND 1855', 'c. 1853'],
      ['BET Jan 1850 AND Mar 1850', '1850'],
      ['44 BC', '44 BC'],
      ['@#DJULIAN@ 25 Dec 1700', '1700'],
    ];
    for (const [text, label] of cases) expect(yearLabel(read(text)), text).toBe(label);
  });

  it('is empty when there is no year to read', () => {
    expect(yearLabel(read('after the war'))).toBe('');
    expect(yearLabel(read('@#DHEBREW@ 5 TSH 5600'))).toBe('');
  });
});
