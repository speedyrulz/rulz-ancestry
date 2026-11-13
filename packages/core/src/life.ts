import { jdnToCalendar } from './date';

/** The first and the last day a date can mean; null where it is open-ended or unknown. */
export interface DaySpan {
  minJdn: number | null;
  maxJdn: number | null;
}

/** How old someone was, in whole years: at least `min`, at most `max`. */
export interface AgeRange {
  min: number;
  max: number;
}

/** Nobody is known to have lived longer; an age above this says the dates are wrong. */
const OLDEST = 125;

function fullYears(fromJdn: number, toJdn: number): number {
  const from = jdnToCalendar('gregorian', fromJdn);
  const to = jdnToCalendar('gregorian', toJdn);
  const before = to.month < from.month || (to.month === from.month && to.day < from.day);
  return to.year - from.year - (before ? 1 : 0);
}

/**
 * The age of someone born at `birth` on the day of `at`. A date that names
 * only a year, or is given as "about", leaves a year or more of doubt, so the
 * answer is a range. Null when either date is open-ended or unknown, when the
 * day lies before the birth, and when the age is beyond any lifetime.
 */
export function ageRange(birth: DaySpan, at: DaySpan): AgeRange | null {
  if (birth.minJdn === null || birth.maxJdn === null) return null;
  if (at.minJdn === null || at.maxJdn === null) return null;
  if (at.maxJdn < birth.minJdn) return null;
  const max = fullYears(birth.minJdn, at.maxJdn);
  const min = Math.min(max, Math.max(0, fullYears(birth.maxJdn, at.minJdn)));
  return max > OLDEST ? null : { min, max };
}

/** An age in words: "age 23", "age 22 or 23", "age 20 to 45". */
export function formatAge(age: AgeRange): string {
  if (age.min === age.max) return `age ${age.min}`;
  return age.max - age.min === 1 ? `age ${age.min} or ${age.max}` : `age ${age.min} to ${age.max}`;
}
