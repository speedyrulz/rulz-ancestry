/**
 * Genealogical dates.
 *
 * A date is kept exactly as the user typed it. Next to that text the app stores
 * a range of Julian Day Numbers (JDN, a count of days used by astronomers), so
 * that dates can be sorted and compared whatever their precision or calendar:
 * "Mar 1881" covers 31 days, "BEF 1900" has no first day.
 *
 * The parser accepts the GEDCOM 5.5.1 and 7.0 date forms and the usual ways
 * people write dates in English. Text it cannot read is not an error: it is
 * stored as a phrase with no range.
 */

export type DateCalendar = 'gregorian' | 'julian' | 'hebrew' | 'french-republican' | 'other';

export type DateQualifier =
  | 'exact'
  | 'about'
  | 'calculated'
  | 'estimated'
  | 'interpreted'
  | 'before'
  | 'after'
  | 'between'
  | 'from'
  | 'to'
  | 'from-to'
  | 'phrase';

export interface ParsedDate {
  /** The text as typed, with surrounding spaces removed. */
  text: string;
  qualifier: DateQualifier;
  /** Null when the text is a phrase. */
  calendar: DateCalendar | null;
  /** First day the date can mean, or null when it is open-ended or unknown. */
  minJdn: number | null;
  /** Last day the date can mean, or null when it is open-ended or unknown. */
  maxJdn: number | null;
}

export interface CalendarDate {
  /** Astronomical year: 1 BC is 0, 2 BC is -1. */
  year: number;
  month: number;
  day: number;
}

type DayCalendar = 'gregorian' | 'julian';

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Julian Day Number of a Gregorian or Julian calendar date (proleptic, astronomical years). */
export function calendarToJdn(
  calendar: DayCalendar,
  year: number,
  month: number,
  day: number,
): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const days = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4);
  return calendar === 'gregorian'
    ? days - Math.floor(y / 100) + Math.floor(y / 400) - 32045
    : days - 32083;
}

/** The calendar date of a Julian Day Number (Richards' algorithm). */
export function jdnToCalendar(calendar: DayCalendar, jdn: number): CalendarDate {
  let f = jdn + 1401;
  if (calendar === 'gregorian') {
    f += Math.floor((Math.floor((4 * jdn + 274277) / 146097) * 3) / 4) - 38;
  }
  const e = 4 * f + 3;
  const g = Math.floor(mod(e, 1461) / 4);
  const h = 5 * g + 2;
  const day = Math.floor(mod(h, 153) / 5) + 1;
  const month = mod(Math.floor(h / 153) + 2, 12) + 1;
  const year = Math.floor(e / 1461) - 4716 + Math.floor((14 - month) / 12);
  return { year, month, day };
}

function daysInMonth(calendar: DayCalendar, year: number, month: number): number {
  if (month === 2) {
    const leap =
      calendar === 'julian'
        ? mod(year, 4) === 0
        : mod(year, 4) === 0 && (mod(year, 100) !== 0 || mod(year, 400) === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

/** GEDCOM 5.5.1 escapes (`@#DJULIAN@`) and GEDCOM 7 keywords (`JULIAN`). */
const CALENDAR_KEYWORDS: Readonly<Record<string, DateCalendar>> = {
  GREGORIAN: 'gregorian',
  JULIAN: 'julian',
  HEBREW: 'hebrew',
  'FRENCH R': 'french-republican',
  FRENCH_R: 'french-republican',
};

interface SimpleDate {
  calendar: DateCalendar;
  /** First and last day, or null when the calendar cannot be converted yet. */
  range: readonly [number, number] | null;
}

function resolveYear(
  digits: string,
  dualDigits: string | undefined,
  bc: boolean,
): { year: number; dual: boolean } | null {
  // "12 Mar 81" could be 81, 1881 or 1981, so a short year is only read with BC.
  if (!bc && digits.length < 3) return null;
  let value = Number(digits);
  if (value === 0) return null;
  let dual = false;
  if (dualDigits !== undefined) {
    // "1731/32": the year under the old 25 March new year, then the modern one.
    if (bc || !String(value + 1).endsWith(dualDigits)) return null;
    value += 1;
    dual = true;
  }
  return { year: bc ? 1 - value : value, dual };
}

/** Parses one date with no qualifier, e.g. `12 MAR 1881` or `@#DJULIAN@ FEB 1700`. */
function parseSimple(input: string): SimpleDate | null {
  let s = input.trim();
  let calendar: DateCalendar = 'gregorian';
  let explicitCalendar = false;

  const escape =
    /^@#D([A-Z_ ]+)@ ?/.exec(s) ?? /^(GREGORIAN|JULIAN|HEBREW|FRENCH_R)(?: |$)/.exec(s);
  if (escape) {
    calendar = CALENDAR_KEYWORDS[escape[1] ?? ''] ?? 'other';
    explicitCalendar = true;
    s = s.slice(escape[0].length).trim();
  }
  if (s === '') return null;
  if (calendar !== 'gregorian' && calendar !== 'julian') return { calendar, range: null };

  s = s
    .replace(/,/g, ' ')
    .replace(/(\d)(?:ST|ND|RD|TH)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  let bc = false;
  const era = /(?<=\d) ?B\.? ?C\.?(?:E\.?)?$/.exec(s);
  if (era) {
    bc = true;
    s = s.slice(0, era.index);
  }

  let yearDigits: string | undefined;
  let dualDigits: string | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s))) {
    // ISO 8601: 1881-03-12 or 1881-03.
    yearDigits = m[1];
    month = Number(m[2]);
    if (m[3] !== undefined) day = Number(m[3]);
  } else if ((m = /^(\d{1,2}) ([A-Z]+)\.? (\d{1,4})(?:\/(\d{1,4}))?$/.exec(s))) {
    // 12 MAR 1881
    day = Number(m[1]);
    month = MONTHS[m[2] ?? ''] ?? 0;
    yearDigits = m[3];
    dualDigits = m[4];
  } else if ((m = /^([A-Z]+)\.? (\d{1,2}) (\d{1,4})(?:\/(\d{1,4}))?$/.exec(s))) {
    // MARCH 12 1881 (the comma is already gone)
    month = MONTHS[m[1] ?? ''] ?? 0;
    day = Number(m[2]);
    yearDigits = m[3];
    dualDigits = m[4];
  } else if ((m = /^([A-Z]+)\.? (\d{1,4})(?:\/(\d{1,4}))?$/.exec(s))) {
    // MAR 1881
    month = MONTHS[m[1] ?? ''] ?? 0;
    yearDigits = m[2];
    dualDigits = m[3];
  } else if ((m = /^(\d{1,4})(?:\/(\d{1,4}))?$/.exec(s))) {
    // 1881
    yearDigits = m[1];
    dualDigits = m[2];
  } else {
    return null;
  }

  const resolved = resolveYear(yearDigits ?? '', dualDigits, bc);
  if (!resolved) return null;
  const { year } = resolved;
  // A dual year is only written for dates in the Julian calendar.
  const cal: DayCalendar =
    calendar === 'julian' || (resolved.dual && !explicitCalendar) ? 'julian' : 'gregorian';

  if (month === undefined) {
    return {
      calendar: cal,
      range: [calendarToJdn(cal, year, 1, 1), calendarToJdn(cal, year, 12, 31)],
    };
  }
  if (month < 1 || month > 12) return null;
  const lastDay = daysInMonth(cal, year, month);
  if (day === undefined) {
    return {
      calendar: cal,
      range: [calendarToJdn(cal, year, month, 1), calendarToJdn(cal, year, month, lastDay)],
    };
  }
  if (day < 1 || day > lastDay) return null;
  const jdn = calendarToJdn(cal, year, month, day);
  return { calendar: cal, range: [jdn, jdn] };
}

/** Words that can come before a single date. Longer words are listed first. */
const PREFIXES: readonly (readonly [RegExp, DateQualifier])[] = [
  [/^(?:CALCULATED|CAL)\.?(?: |(?=\d))/, 'calculated'],
  [/^(?:ESTIMATED|EST)\.?(?: |(?=\d))/, 'estimated'],
  [/^(?:ABOUT|ABT|CIRCA|CA|C)\.?(?: |(?=\d))/, 'about'],
  [/^~ ?/, 'about'],
  [/^(?:BEFORE|BEF)\.?(?: |(?=\d))/, 'before'],
  [/^(?:AFTER|AFT)\.?(?: |(?=\d))/, 'after'],
];

function phrase(text: string): ParsedDate {
  return { text, qualifier: 'phrase', calendar: null, minJdn: null, maxJdn: null };
}

function single(text: string, qualifier: DateQualifier, body: string): ParsedDate {
  const date = parseSimple(body);
  if (!date) return phrase(text);
  const base = { text, qualifier, calendar: date.calendar };
  if (!date.range) return { ...base, minJdn: null, maxJdn: null };
  const [min, max] = date.range;
  switch (qualifier) {
    case 'before':
      return { ...base, minJdn: null, maxJdn: min - 1 };
    case 'after':
      return { ...base, minJdn: max + 1, maxJdn: null };
    case 'from':
      return { ...base, minJdn: min, maxJdn: null };
    case 'to':
      return { ...base, minJdn: null, maxJdn: max };
    default:
      return { ...base, minJdn: min, maxJdn: max };
  }
}

function pair(text: string, qualifier: DateQualifier, first: string, second: string): ParsedDate {
  const a = parseSimple(first);
  const b = parseSimple(second);
  if (!a || !b) return phrase(text);
  const base = { text, qualifier, calendar: a.calendar };
  if (!a.range || !b.range) return { ...base, minJdn: null, maxJdn: null };
  // Take the outer bounds, so a pair typed in the wrong order still gives a range.
  return {
    ...base,
    minJdn: Math.min(a.range[0], b.range[0]),
    maxJdn: Math.max(a.range[1], b.range[1]),
  };
}

/**
 * Reads a date as typed. Returns null for empty text, and a `phrase` result
 * (no calendar, no range) for text that is not a recognised date.
 */
export function parseDate(input: string): ParsedDate | null {
  const text = input.trim();
  if (text === '') return null;

  const s = text.toUpperCase().replace(/\s+/g, ' ');
  if (s.startsWith('(') && s.endsWith(')')) return phrase(text);

  let m: RegExpExecArray | null;
  // GEDCOM: INT 1881 (as read from a damaged page)
  if ((m = /^INT\.? (.+?)(?: \(.*\))?$/.exec(s))) return single(text, 'interpreted', m[1] ?? '');
  if ((m = /^(?:BETWEEN|BET\.?|BTW\.?) (.+?) (?:AND|&) (.+)$/.exec(s))) {
    return pair(text, 'between', m[1] ?? '', m[2] ?? '');
  }
  if ((m = /^FROM (.+?) TO (.+)$/.exec(s))) return pair(text, 'from-to', m[1] ?? '', m[2] ?? '');
  if ((m = /^FROM (.+)$/.exec(s))) return single(text, 'from', m[1] ?? '');
  if ((m = /^TO (.+)$/.exec(s))) return single(text, 'to', m[1] ?? '');
  // 1850-1855. A two-digit second part is an ISO month (1850-12), handled below.
  if ((m = /^(\d{3,4}) ?[-–—] ?(\d{3,4})$/.exec(s))) {
    return pair(text, 'between', m[1] ?? '', m[2] ?? '');
  }
  if ((m = /^(.+?) [–—] (.+)$/.exec(s))) return pair(text, 'between', m[1] ?? '', m[2] ?? '');
  if ((m = /^(.+?) TO (.+)$/.exec(s))) return pair(text, 'from-to', m[1] ?? '', m[2] ?? '');

  for (const [pattern, qualifier] of PREFIXES) {
    const prefix = pattern.exec(s);
    if (prefix) return single(text, qualifier, s.slice(prefix[0].length));
  }
  return single(text, 'exact', s);
}

/** The parts of a stored date that say what it means; the typed text is not needed. */
export type DateReading = Pick<ParsedDate, 'qualifier' | 'calendar' | 'minJdn' | 'maxJdn'>;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function yearText(year: number): string {
  // Astronomical years: 0 is 1 BC.
  return year > 0 ? String(year) : `${1 - year} BC`;
}

function dayText(calendar: DayCalendar, jdn: number): string {
  const { year, month, day } = jdnToCalendar(calendar, jdn);
  return `${day} ${MONTH_NAMES[month - 1] ?? ''} ${yearText(year)}`;
}

/** A range as the largest unit it exactly covers: a day, a month, a year, or two days. */
function spanText(calendar: DayCalendar, min: number, max: number): string {
  const first = jdnToCalendar(calendar, min);
  const last = jdnToCalendar(calendar, max);
  if (min === max) return dayText(calendar, min);
  if (first.year === last.year && first.day === 1) {
    const wholeMonth =
      first.month === last.month && last.day === daysInMonth(calendar, last.year, last.month);
    if (wholeMonth) return `${MONTH_NAMES[first.month - 1] ?? ''} ${yearText(first.year)}`;
    if (first.month === 1 && last.month === 12 && last.day === 31) return yearText(first.year);
  }
  return `${dayText(calendar, min)} to ${dayText(calendar, max)}`;
}

const UNCONVERTED_CALENDARS: Readonly<Record<string, string>> = {
  hebrew: 'a Hebrew calendar date (not converted yet, so it does not sort)',
  'french-republican': 'a French Republican calendar date (not converted yet, so it does not sort)',
  other: 'a date in a calendar the app does not know (it does not sort)',
};

/**
 * Says in plain words how the app read a date, so the person who typed it can
 * check: "BEF 1900" gives "before 1 January 1900". Returns null for a phrase,
 * which is text the app keeps but does not read as a date.
 */
export function describeDate(date: DateReading): string | null {
  if (date.qualifier === 'phrase' || date.calendar === null) return null;
  if (date.calendar !== 'gregorian' && date.calendar !== 'julian') {
    return UNCONVERTED_CALENDARS[date.calendar] ?? null;
  }
  const calendar = date.calendar;
  const { minJdn: min, maxJdn: max } = date;
  const suffix = calendar === 'julian' ? ' (Julian calendar)' : '';

  let text: string | null = null;
  if (min !== null && max !== null) {
    switch (date.qualifier) {
      case 'between':
        text = `between ${dayText(calendar, min)} and ${dayText(calendar, max)}`;
        break;
      case 'from-to':
        text = `from ${dayText(calendar, min)} to ${dayText(calendar, max)}`;
        break;
      case 'about':
      case 'calculated':
      case 'estimated':
        text = `${date.qualifier} ${spanText(calendar, min, max)}`;
        break;
      default:
        text = spanText(calendar, min, max);
    }
  } else if (max !== null) {
    // "BEF 1900" ends on 31 December 1899; "TO 1900" ends on 31 December 1900.
    text =
      date.qualifier === 'before'
        ? `before ${dayText(calendar, max + 1)}`
        : `until ${dayText(calendar, max)}`;
  } else if (min !== null) {
    text =
      date.qualifier === 'after'
        ? `after ${dayText(calendar, min - 1)}`
        : `from ${dayText(calendar, min)}`;
  }
  return text === null ? null : text + suffix;
}

/**
 * The year of a date in the short form used in lists and lifespans: "1881",
 * "c. 1850", "bef. 1900". Empty when the date has no year the app can read.
 */
export function yearLabel(date: DateReading): string {
  if (date.calendar !== 'gregorian' && date.calendar !== 'julian') return '';
  const calendar = date.calendar;
  const yearOf = (jdn: number) => jdnToCalendar(calendar, jdn).year;
  const { minJdn: min, maxJdn: max } = date;

  if (min !== null && max !== null) {
    const first = yearOf(min);
    const last = yearOf(max);
    if (first !== last) return `c. ${yearText(Math.round((first + last) / 2))}`;
    const approximate =
      date.qualifier === 'about' ||
      date.qualifier === 'calculated' ||
      date.qualifier === 'estimated';
    return approximate ? `c. ${yearText(first)}` : yearText(first);
  }
  if (max !== null) {
    return date.qualifier === 'before'
      ? `bef. ${yearText(yearOf(max + 1))}`
      : yearText(yearOf(max));
  }
  if (min !== null) {
    return date.qualifier === 'after' ? `aft. ${yearText(yearOf(min - 1))}` : yearText(yearOf(min));
  }
  return '';
}
