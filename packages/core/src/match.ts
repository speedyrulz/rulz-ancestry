import type { Sex } from './model';

/**
 * Scoring of two person records as possible duplicates. Used to list likely
 * duplicates inside one tree; the hints of a later phase build on the same
 * name and date comparisons.
 *
 * Everything here works on plain values, so it runs anywhere and is easy to
 * test. Nothing is merged on the strength of a score: a person decides.
 */

/**
 * Remembers the results of a function of one text. A scan of a tree asks for
 * the same few thousand names millions of times.
 */
function remembered(compute: (text: string) => string): (text: string) => string {
  const cache = new Map<string, string>();
  return (text) => {
    let value = cache.get(text);
    if (value === undefined) {
      value = compute(text);
      if (cache.size >= 50_000) cache.clear();
      cache.set(text, value);
    }
    return value;
  };
}

/** A name reduced to what is compared: lower case, no accents, letters and single spaces only. */
export const normalizeName = remembered((text) =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim(),
);

const SOUNDEX_CODES: Readonly<Record<string, string>> = {
  b: '1',
  f: '1',
  p: '1',
  v: '1',
  c: '2',
  g: '2',
  j: '2',
  k: '2',
  q: '2',
  s: '2',
  x: '2',
  z: '2',
  d: '3',
  t: '3',
  l: '4',
  m: '5',
  n: '5',
  r: '6',
};

/**
 * American Soundex of a word: "Robert" and "Rupert" both give "R163". Used
 * only to decide which records are worth comparing in full, so its bias
 * towards English spelling costs little. Empty for a word with no letters a-z.
 */
export const soundex = remembered((word) => {
  const letters = normalizeName(word).replace(/[^a-z]/g, '');
  const first = letters.charAt(0);
  if (first === '') return '';
  let code = first.toUpperCase();
  let previous = SOUNDEX_CODES[first] ?? '';
  for (const letter of letters.slice(1)) {
    const digit = SOUNDEX_CODES[letter] ?? '';
    if (digit !== '' && digit !== previous) code += digit;
    // H and W do not separate two letters with the same code; a vowel does.
    if (letter !== 'h' && letter !== 'w') previous = digit;
    if (code.length === 4) break;
  }
  return code.padEnd(4, '0');
});

/** Jaro-Winkler similarity of two strings, from 0 (nothing alike) to 1 (equal). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a === '' ? 0 : 1;
  if (a === '' || b === '') return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array<boolean>(a.length).fill(false);
  const matchedB = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(b.length - 1, i + window);
    for (let j = from; j <= to; j += 1) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = true;
      matchedB[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let j = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!matchedA[i]) continue;
    while (!matchedB[j]) j += 1;
    if (a[i] !== b[j]) transpositions += 1;
    j += 1;
  }
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface MatchName {
  given: string;
  surname: string;
}

/** What is compared of one person. Names of relatives are full names, as written. */
export interface MatchCandidate {
  id: string;
  sex: Sex;
  /** Every name recorded for the person, the main one first. */
  names: readonly MatchName[];
  birthYear: number | null;
  deathYear: number | null;
  birthPlace: string;
  deathPlace: string;
  parentIds: readonly string[];
  parentNames: readonly string[];
  partnerIds: readonly string[];
  partnerNames: readonly string[];
}

export interface MatchScore {
  /** 0 to 100. From 50 a pair is worth showing; from 80 it is very likely one person. */
  score: number;
  /** What the score rests on, in words for the user, strongest first. */
  reasons: string[];
}

/** The lowest score at which a pair is listed as a possible duplicate. */
export const DUPLICATE_THRESHOLD = 50;

interface NameScore {
  /** 0 to 1. */
  value: number;
  exact: boolean;
}

function givenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const [firstA = '', ...restA] = a.split(' ');
  const [firstB = '', ...restB] = b.split(' ');
  if (firstA === firstB) {
    // "John" and "John William" agree; "John William" and "John Henry" less so.
    return restA.length > 0 && restB.length > 0 ? 0.85 : 0.95;
  }
  // An initial standing for the name: "J" and "John".
  if ((firstA.length === 1 || firstB.length === 1) && firstA[0] === firstB[0]) return 0.7;
  return jaroWinkler(firstA, firstB) * 0.95;
}

function surnameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const similarity = jaroWinkler(a, b);
  return soundex(a) === soundex(b) ? Math.max(similarity, 0.88) : similarity;
}

function compareNames(a: MatchName, b: MatchName): NameScore | null {
  const givenA = normalizeName(a.given);
  const givenB = normalizeName(b.given);
  const surnameA = normalizeName(a.surname);
  const surnameB = normalizeName(b.surname);
  // A name with only one part says too little unless the other name is just the same.
  if (givenA === '' || givenB === '' || surnameA === '' || surnameB === '') {
    const same = givenA === givenB && surnameA === surnameB && givenA + surnameA !== '';
    return same ? { value: 0.9, exact: true } : null;
  }
  const given = givenSimilarity(givenA, givenB);
  const surname = surnameSimilarity(surnameA, surnameB);
  if (given < 0.7 || surname < 0.85) return null;
  return { value: (given + surname) / 2, exact: given === 1 && surname === 1 };
}

function bestName(a: MatchCandidate, b: MatchCandidate): NameScore | null {
  let best: NameScore | null = null;
  for (const nameA of a.names) {
    for (const nameB of b.names) {
      const score = compareNames(nameA, nameB);
      if (score && (best === null || score.value > best.value)) best = score;
    }
  }
  return best;
}

function placesAgree(a: string, b: string): boolean | null {
  const wordsA = normalizeName(a).split(' ').filter(Boolean);
  const wordsB = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (wordsA.length === 0 || wordsB.size === 0) return null;
  // The first word is usually the town or parish, the most telling part.
  if (wordsB.has(wordsA[0] ?? '')) return true;
  const shared = wordsA.filter((word) => wordsB.has(word)).length;
  return shared / Math.min(wordsA.length, wordsB.size) >= 0.5;
}

function shares(a: readonly string[], b: readonly string[]): boolean {
  return a.some((value) => b.includes(value));
}

function sharesName(a: readonly string[], b: readonly string[]): boolean {
  const names = new Set(b.map(normalizeName).filter((name) => name !== ''));
  return a.some((name) => names.has(normalizeName(name)));
}

/**
 * Scores two records as one person. Null means they cannot sensibly be the
 * same: the names are too different, the sexes differ, the years are far
 * apart, or one is the other's parent or partner.
 */
export function scoreDuplicate(a: MatchCandidate, b: MatchCandidate): MatchScore | null {
  if (a.id === b.id) return null;
  if ((a.sex === 'M' && b.sex === 'F') || (a.sex === 'F' && b.sex === 'M')) return null;
  if (a.parentIds.includes(b.id) || b.parentIds.includes(a.id)) return null;
  if (a.partnerIds.includes(b.id) || b.partnerIds.includes(a.id)) return null;

  // The years are the cheapest thing to compare, and rule out most pairs of a
  // large family with one surname, so they are looked at before the names.
  const birthGap =
    a.birthYear === null || b.birthYear === null ? null : Math.abs(a.birthYear - b.birthYear);
  const deathGap =
    a.deathYear === null || b.deathYear === null ? null : Math.abs(a.deathYear - b.deathYear);
  if ((birthGap !== null && birthGap > 10) || (deathGap !== null && deathGap > 10)) return null;

  const name = bestName(a, b);
  if (!name) return null;

  const strong: string[] = [name.exact ? 'Same name' : 'Similar name'];
  const weak: string[] = [];
  let score = 50 * name.value;

  if (birthGap !== null) {
    if (birthGap === 0) {
      score += 25;
      strong.push('Born in the same year');
    } else if (birthGap <= 2) {
      score += birthGap === 1 ? 20 : 12;
      strong.push(`Born ${birthGap === 1 ? 'a year' : '2 years'} apart`);
    } else if (birthGap <= 5) {
      score += 2;
      weak.push(`Born ${birthGap} years apart`);
    } else {
      score -= 12;
      weak.push(`Born ${birthGap} years apart`);
    }
  }

  if (deathGap !== null) {
    if (deathGap === 0) {
      score += 10;
      strong.push('Died in the same year');
    } else if (deathGap <= 2) {
      score += 5;
      strong.push(`Died ${deathGap === 1 ? 'a year' : '2 years'} apart`);
    } else {
      score -= 6;
      weak.push(`Died ${deathGap} years apart`);
    }
  }

  const birthPlace = placesAgree(a.birthPlace, b.birthPlace);
  if (birthPlace === true) {
    score += 5;
    strong.push('Same place of birth');
  } else if (birthPlace === false) {
    score -= 4;
    weak.push('Different places of birth');
  }
  const deathPlace = placesAgree(a.deathPlace, b.deathPlace);
  if (deathPlace === true) {
    score += 3;
    strong.push('Same place of death');
  }

  if (shares(a.parentIds, b.parentIds)) {
    // Children of the same parents: one person entered twice, or two children
    // with a family name in common. The years of birth tell them apart.
    if (birthGap !== null && birthGap > 0) {
      score -= 30;
      weak.push('Children of the same parents, born in different years');
    } else {
      score += 10;
      strong.push('Same parents');
    }
  } else if (sharesName(a.parentNames, b.parentNames)) {
    score += 10;
    strong.push('A parent with the same name');
  }

  if (shares(a.partnerIds, b.partnerIds)) {
    score += 10;
    strong.push('Same partner');
  } else if (sharesName(a.partnerNames, b.partnerNames)) {
    score += 8;
    strong.push('A partner with the same name');
  }

  return {
    score: Math.round(Math.min(100, Math.max(0, score))),
    reasons: [...strong, ...weak],
  };
}

/**
 * The groups a record is compared within. Two records are compared in full
 * only when they share a key, which keeps a scan of a large tree short. The
 * keys are built from the surname alone, three ways, so that the usual
 * spelling differences still land two records in one group:
 *
 * - by sound (Soundex): Meyer and Meier;
 * - by its first four letters: Thompson and Thomson, which Soundex separates;
 * - without its first letter: Kramer and Cramer.
 *
 * A name with a part missing is grouped by the whole of what there is. A pair
 * whose surnames differ in some other way is not compared and so not found.
 */
export function blockingKeys(candidate: Pick<MatchCandidate, 'names'>): string[] {
  const keys = new Set<string>();
  for (const name of candidate.names) {
    const given = normalizeName(name.given);
    const surname = normalizeName(name.surname);
    if (given === '' && surname === '') continue;
    if (given === '' || surname === '') {
      keys.add(`=${given}|${surname}`);
      continue;
    }
    const sound = soundex(surname);
    keys.add(`s:${sound === '' ? surname : sound}`);
    keys.add(`p:${surname.slice(0, 4)}`);
    if (surname.length > 3) keys.add(`t:${surname.slice(1)}`);
  }
  return [...keys];
}
