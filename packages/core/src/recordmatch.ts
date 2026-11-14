import { compareNames, normalizeName, type MatchName } from './match';
import type { Sex } from './model';
import type { EventRecord, ExternalRecord, PersonRecord } from './records';

/**
 * How well a result of a search for records fits the person of the tree it
 * was searched for. A source answers with everyone of a name; this says which
 * of them may be the person, and why.
 *
 * It is a help for the eye and nothing more. Nothing is attached, merged or
 * hidden on the strength of a score: a person decides. A score is worked out
 * on the user's PC from the tree and from what the source already sent, so
 * nothing is sent to anyone for it.
 *
 * The score is a sum of points for what agrees and against what does not, set
 * by hand as those of `scoreDuplicate` are. A labelled set of made-up cases
 * (`recordmatch.labelled.ts`) measures how the bands hold; see the test.
 */

/** A span of years: a date of the tree can mean any day between two. */
export interface YearSpan {
  min: number;
  max: number;
}

/** What is compared of the person of the tree. */
export interface MatchSubject {
  sex: Sex;
  /** Every name recorded for the person, the main one first. */
  names: readonly MatchName[];
  /** The years the birth can lie in; null when the tree does not say. */
  birth: YearSpan | null;
  death: YearSpan | null;
  birthPlace: string;
  deathPlace: string;
  /** Every place the tree names for the person, of whatever event. */
  places: readonly string[];
}

/**
 * How a score is to be read:
 * - "strong": the name and at least a date agree, and nothing speaks against it;
 * - "possible": the name fits, and there is little else to go by;
 * - "weak": the name is only like the other, or something speaks against it;
 * - "unlikely": the name is another, or the record cannot be of this person.
 */
export type MatchBand = 'strong' | 'possible' | 'weak' | 'unlikely';

export interface RecordMatch {
  /** 0 to 100. */
  score: number;
  band: MatchBand;
  /** What speaks for the record being of the person, in words, strongest first. */
  reasons: string[];
  /** What speaks against it. */
  doubts: string[];
}

/** From this score a result is a strong match, and from the next a possible one. */
export const MATCH_STRONG = 75;
export const MATCH_POSSIBLE = 50;
export const MATCH_WEAK = 30;

/**
 * How long a life is taken to last at most, where the tree gives one end of
 * it only. It is an assumption, and the words of a doubt say so.
 */
const LONGEST_LIFE = 105;
/** The youngest a bride, a groom, a parent or a witness is taken to be. */
const ADULT = 14;

export function matchBand(score: number): MatchBand {
  if (score >= MATCH_STRONG) return 'strong';
  if (score >= MATCH_POSSIBLE) return 'possible';
  return score >= MATCH_WEAK ? 'weak' : 'unlikely';
}

/**
 * The years a date of a source can lie in. An end that is null is open:
 * "before 1860" has no first year. `loose` is true when the source itself
 * says the date is not exact ("about", "before", "after").
 */
export interface DateSpan {
  min: number | null;
  max: number | null;
  loose: boolean;
}

/**
 * Reads a date in the wording of a GEDCOM file, as the connectors write one:
 * "16 FEB 1816", "ABT 1835", "BEF MAY 1837", "BET 1800 AND 1810". Null when
 * it names no year.
 */
export function spanOfDate(date: string): DateSpan | null {
  const text = date.trim().toUpperCase();
  const two = /^(?:BET|FROM)\s(?:.*\s)?(\d{3,4})\s(?:AND|TO)\s(?:.*\s)?(\d{3,4})$/.exec(text);
  if (two !== null) {
    const [first, second] = [Number(two[1]), Number(two[2])];
    return { min: Math.min(first, second), max: Math.max(first, second), loose: false };
  }
  const one = /^(?:(ABT|CAL|EST|BEF|AFT)\s)?(?:.*\s)?(\d{3,4})$/.exec(text);
  if (one === null) return null;
  const year = Number(one[2]);
  if (one[1] === 'BEF') return { min: null, max: year, loose: true };
  if (one[1] === 'AFT') return { min: year, max: null, loose: true };
  return { min: year, max: year, loose: one[1] !== undefined };
}

/** The one year of a date; null when the date names none, or more than one. */
export function yearOfDate(date: string): number | null {
  const span = spanOfDate(date);
  return span !== null && span.min !== null && span.min === span.max ? span.min : null;
}

/** Words that stand before a name and are no part of it. */
const TITLES = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'miss',
  'rev',
  'sir',
  'capt',
  'col',
  'gen',
  'prof',
]);
/** Words that stand after a name and are no part of it. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'junior', 'senior', 'esq']);
/** Small words of a surname that one source writes and another leaves out: "van Gogh", "Gogh". */
const PARTICLES = new Set([
  'van',
  'de',
  'der',
  'den',
  'ten',
  'ter',
  'te',
  'von',
  'zu',
  'le',
  'la',
  'du',
  'di',
  'da',
  'del',
  'della',
  'dos',
  'das',
  'op',
  'het',
]);

/**
 * The words of a name that are compared: without a title before it, a suffix
 * after it, or the small words of a surname. What is left when all of it is
 * such a word is kept as it is.
 */
function wordsOf(text: string): string[] {
  let words = normalizeName(text)
    .split(' ')
    .filter((word) => word !== '');
  while (words.length > 1 && TITLES.has(words[0] ?? '')) words = words.slice(1);
  while (words.length > 1 && SUFFIXES.has(words.at(-1) ?? '')) words = words.slice(0, -1);
  const plain = words.filter((word) => !PARTICLES.has(word));
  return plain.length === 0 ? words : plain;
}

interface NameFit {
  value: number;
  exact: boolean;
}

/**
 * How well a record's name fits one name of the tree; null when it does not.
 * A source gives a name as one line ("Hendrik Vincent van Gogh"), and the
 * tree in two parts; the line is cut where the tree's surname would begin.
 * WikiTree adds the name at birth in brackets ("Etta Marsh (born Fenwick)"),
 * which is tried as the surname too.
 */
function fitOfName(own: MatchName, title: string): NameFit | null {
  const given = wordsOf(own.given).join(' ');
  const surname = wordsOf(own.surname);
  const tree = { given, surname: surname.join(' ') };
  const words = wordsOf(title.replace(/\([^)]*\)/g, ' '));
  if (words.length === 0) return null;
  const cut = Math.max(0, words.length - Math.max(1, surname.length));
  const candidates: MatchName[] = [
    // A line of one word is taken for a surname.
    { given: words.slice(0, cut).join(' '), surname: words.slice(cut).join(' ') },
  ];
  const born = wordsOf(/\(born ([^)]+)\)/i.exec(title)?.[1] ?? '');
  if (born.length > 0) {
    // The given names are what stands before the surname of now, which is one word as a rule.
    const before = words.length > 1 ? words.slice(0, -1) : words;
    candidates.push({ given: before.join(' '), surname: born.join(' ') });
  }
  let best: NameFit | null = null;
  for (const candidate of candidates) {
    const fit = compareNames(tree, candidate);
    if (fit !== null && (best === null || fit.value > best.value)) best = fit;
  }
  return best;
}

/** The best fit of a record's name with any name of the person; null when none fits. */
function nameFit(subject: MatchSubject, title: string): NameFit | null {
  let best: NameFit | null = null;
  for (const name of subject.names) {
    const fit = fitOfName(name, title);
    if (fit !== null && (best === null || fit.value > best.value)) best = fit;
  }
  return best;
}

/**
 * The points a name is worth. A name that is the same, or the same but for a
 * middle name that one side leaves out, is worth the most: with nothing else
 * to go by, such a result is a possible fit. A name that is only like the
 * other is worth less, by how unlike it is.
 */
function pointsOf(name: NameFit): number {
  return name.value >= 0.95 ? 50 : 50 * name.value;
}

/** Points, and the words for them: a reason for, or a doubt against. */
interface Verdict {
  points: number;
  reason?: string;
  doubt?: string;
}

const NOTHING: Verdict = { points: 0 };

function apart(gap: number): string {
  return gap === 1 ? 'a year apart' : `${gap} years apart`;
}

/** The most points a year can be worth, and the least it can cost, for a birth and for a death. */
const BIRTH = { full: 25, near: [18, 10], far: [0, -15, -45] } as const;
const DEATH = { full: 15, near: [10, 6], far: [-5, -15, -40] } as const;

/**
 * Points and words for the year of a birth or a death in a record beside the
 * years the tree gives. Years that agree are worth the more, the more exactly
 * both sides know them: "born between 1800 and 1900" agrees with any year of
 * a century and says little. A date that is open to one side ("before 1860")
 * can only speak against a fit, never for it.
 */
function yearsVerdict(
  word: 'Born' | 'Died',
  record: DateSpan,
  tree: YearSpan,
  scale: typeof BIRTH | typeof DEATH,
): Verdict {
  const gap =
    record.max !== null && record.max < tree.min
      ? tree.min - record.max
      : record.min !== null && record.min > tree.max
        ? record.min - tree.max
        : 0;
  if (gap > 0) {
    if (gap <= 2) return { points: scale.near[gap - 1] ?? 0, reason: `${word} ${apart(gap)}` };
    const points = gap <= 5 ? scale.far[0] : gap <= 10 ? scale.far[1] : scale.far[2];
    return { points, doubt: `${word} ${apart(gap)}` };
  }
  if (record.min === null || record.max === null) return NOTHING;
  const ofRecord = record.max - record.min;
  const ofTree = tree.max - tree.min;
  const width = Math.max(ofRecord, ofTree);
  if (width === 0 && !record.loose) {
    return { points: scale.full, reason: `${word} in the same year` };
  }
  if (width <= 2) {
    return { points: Math.round(scale.full * 0.7), reason: `${word} in about the same year` };
  }
  return {
    points: Math.round(scale.full * (width <= 10 ? 0.35 : 0.15)),
    reason: `${word} within the years the ${ofTree >= ofRecord ? 'tree' : 'record'} gives`,
  };
}

/**
 * Points and words for the year of a record that names the person, who was
 * alive then. Where the tree gives one end of the life only, the other is
 * reckoned from it, and the words say so: the tree knows no such date.
 */
function aliveVerdict(
  year: number,
  subject: MatchSubject,
  adult: boolean,
  points: number,
): Verdict {
  const { birth, death } = subject;
  if (birth === null && death === null) return NOTHING;
  // A year either way is allowed for: an event is not always registered in
  // its year, and a year of the tree can be a year off.
  if (birth !== null && year < birth.min - 1) {
    return { points: -45, doubt: 'The record is from before the birth' };
  }
  if (birth === null && death !== null && year < death.min - LONGEST_LIFE) {
    return { points: -35, doubt: `More than ${LONGEST_LIFE} years before the death` };
  }
  if (death !== null && year > death.max + 1) {
    return { points: -35, doubt: 'The record is from after the death' };
  }
  if (death === null && birth !== null && year > birth.max + LONGEST_LIFE) {
    return { points: -35, doubt: `More than ${LONGEST_LIFE} years after the birth` };
  }
  if (adult && birth !== null && year < birth.min + ADULT - 1) {
    return { points: -30, doubt: 'The person was a child then' };
  }
  return birth !== null && death !== null
    ? { points, reason: 'From the years the person lived in' }
    : { points: Math.round(points / 2), reason: 'From years the person may have lived in' };
}

/** What a person is in a record of an event, as far as the score cares. */
export type Part = 'born' | 'died' | 'married' | 'child' | 'named';

const BIRTH_EVENTS = ['birth', 'baptism', 'christening', 'geboorte', 'doop'];
const DEATH_EVENTS = ['death', 'burial', 'overlijden', 'begraven', 'begrafenis'];
const MARRIAGE_EVENTS = ['marriage', 'huwelijk', 'trouwen', 'ondertrouw'];
const CHILD_ROLES = /^(child|kind|baptized|dopeling|born|geborene)$/;

/**
 * The part a person has in a record: the one who was born, the one who died,
 * one of the two who married, a child that a record of something else names
 * (a marriage that names the children of the pair, a register of a
 * household), or someone the record only names (a parent, a witness). Only
 * the first two say something of the person's own dates.
 */
export function partOf(record: EventRecord): Part {
  const role = normalizeName(record.role);
  const event = normalizeName(record.event);
  const is = (words: readonly string[]) => words.some((word) => event.includes(word));
  if (CHILD_ROLES.test(role)) return is(BIRTH_EVENTS) ? 'born' : 'child';
  if (is(DEATH_EVENTS) && /^(deceased|overledene)$/.test(role)) return 'died';
  if (is(MARRIAGE_EVENTS) && /^(bride|groom|bruid|bruidegom)$/.test(role)) return 'married';
  return 'named';
}

/** The town of a place as it is written: what stands before the first comma. */
function townOf(place: string): string {
  return normalizeName(place.split(',')[0] ?? '');
}

/**
 * Whether two places are one town. "Same" when the towns are written alike;
 * "near" when the towns differ and something else agrees (a county, a state);
 * "other" when nothing agrees; null when either is not given.
 */
function comparePlaces(a: string, b: string): 'same' | 'near' | 'other' | null {
  const [townA, townB] = [townOf(a), townOf(b)];
  if (townA === '' || townB === '') return null;
  // A place written without commas begins with its town.
  if (townA === townB || townA.startsWith(`${townB} `) || townB.startsWith(`${townA} `)) {
    return 'same';
  }
  const words = new Set(normalizeName(b).split(' '));
  return normalizeName(a)
    .split(' ')
    .some((word) => word.length > 2 && words.has(word))
    ? 'near'
    : 'other';
}

/**
 * Points and words for a place of a record beside the places of the tree.
 * Only the same town speaks for a fit: two towns of one county are two
 * places. People move, so another place speaks against a fit only a little.
 */
function placeVerdict(place: string, own: string, others: readonly string[]): Verdict {
  if (place.trim() === '') return NOTHING;
  const beside = comparePlaces(place, own);
  if (beside === 'same') return { points: 6, reason: 'Same place' };
  if (others.some((other) => comparePlaces(place, other) === 'same')) {
    return { points: 4, reason: 'A place the tree names for this person' };
  }
  return beside === 'other' ? { points: -3, doubt: 'Another place' } : NOTHING;
}

function finish(verdicts: readonly Verdict[], name: NameFit, most = 100): RecordMatch {
  const total = Math.round(
    Math.min(
      most,
      Math.max(0, pointsOf(name) + verdicts.reduce((sum, { points }) => sum + points, 0)),
    ),
  );
  return {
    score: total,
    band: matchBand(total),
    reasons: [
      name.exact ? 'Same name' : 'Similar name',
      ...verdicts.map(({ reason }) => reason).filter((text) => text !== undefined),
    ],
    doubts: verdicts.map(({ doubt }) => doubt).filter((text) => text !== undefined),
  };
}

const ANOTHER_NAME: RecordMatch = {
  score: 0,
  band: 'unlikely',
  reasons: [],
  doubts: ['Another name'],
};

const OTHER_SEX: Verdict = { points: -45, doubt: 'The other sex' };

const known = (sex: Sex | null): sex is 'M' | 'F' => sex === 'M' || sex === 'F';

function scorePerson(subject: MatchSubject, record: PersonRecord): RecordMatch {
  const name = nameFit(subject, record.title);
  if (name === null) return ANOTHER_NAME;
  const verdicts: Verdict[] = [];
  if (known(subject.sex) && known(record.sex) && subject.sex !== record.sex) {
    verdicts.push(OTHER_SEX);
  }
  for (const type of ['birth', 'death'] as const) {
    // The first of its kind: a source that gives two births is counted once.
    const fact = record.facts.find((entry) => entry.type === type);
    if (fact === undefined) continue;
    const span = spanOfDate(fact.date);
    const tree = type === 'birth' ? subject.birth : subject.death;
    if (span !== null && tree !== null) {
      verdicts.push(
        type === 'birth'
          ? yearsVerdict('Born', span, tree, BIRTH)
          : yearsVerdict('Died', span, tree, DEATH),
      );
    }
    verdicts.push(
      placeVerdict(
        fact.place,
        type === 'birth' ? subject.birthPlace : subject.deathPlace,
        subject.places,
      ),
    );
  }
  return finish(verdicts, name);
}

function scoreEvent(subject: MatchSubject, record: EventRecord): RecordMatch {
  const name = nameFit(subject, record.title);
  if (name === null) return ANOTHER_NAME;
  const verdicts: Verdict[] = [];
  const part = partOf(record);
  // A bride is a woman and a groom a man, whatever else the record leaves out.
  const role = normalizeName(record.role);
  const sexOfRole = /^(bride|bruid)$/.test(role)
    ? 'F'
    : /^(groom|bruidegom)$/.test(role)
      ? 'M'
      : null;
  if (sexOfRole !== null && known(subject.sex) && subject.sex !== sexOfRole) {
    verdicts.push(OTHER_SEX);
  }
  const span = spanOfDate(record.date);
  const year = yearOfDate(record.date);
  if (part === 'born' && subject.birth !== null && span !== null) {
    verdicts.push(yearsVerdict('Born', span, subject.birth, BIRTH));
  } else if (part === 'died' && subject.death !== null && span !== null) {
    verdicts.push(yearsVerdict('Died', span, subject.death, DEATH));
  } else if (year !== null) {
    // Someone a record names was alive then; and no child, unless the record
    // is of their own birth or death, or names them as a child.
    const adult = part === 'married' || part === 'named';
    verdicts.push(aliveVerdict(year, subject, adult, part === 'married' ? 12 : 8));
  }
  const own = part === 'born' ? subject.birthPlace : part === 'died' ? subject.deathPlace : '';
  verdicts.push(placeVerdict(record.place, own, subject.places));
  // Only the record of a person's own birth or death can be a strong fit. Any
  // other says that someone of that name lived then, and many of one name did.
  const ofTheirOwn = part === 'born' || part === 'died';
  return finish(verdicts, name, ofTheirOwn ? 100 : MATCH_STRONG - 1);
}

/**
 * How well a result fits the person it was searched for. Null for a text: a
 * page of a newspaper or a book was found by its words, and nothing in the
 * result says whom it is about.
 */
export function scoreRecord(subject: MatchSubject, record: ExternalRecord): RecordMatch | null {
  if (record.kind === 'person') return scorePerson(subject, record);
  if (record.kind === 'event') return scoreEvent(subject, record);
  return null;
}
