import { cleanText } from '@rulz/connectors';
import {
  QUERY_FIRST_YEAR,
  compareNames,
  jaroWinkler,
  normalizeName,
  type MatchName,
  type PersonQuery,
} from '@rulz/core';
import { z } from 'zod';

/**
 * The limits on what an AI may ask a source about a person of the tree.
 *
 * A search goes out under the user's name to a source on the internet, and
 * what an AI asks for can come from anywhere: from a record it read, which
 * can hold text written as an instruction. So an AI may not send words of its
 * own choosing. It may ask for the person the session is for, under a name
 * the tree has for them or one that is like it, and for years near the years
 * the tree has:
 *
 * - **The name** must have a given name and a last name, and must fit a name
 *   of the person as two names of one person fit each other in the search for
 *   duplicates (`compareNames`): another spelling, a middle name left out, an
 *   initial. A name that is another name is refused. So is a name that
 *   carries anything along that is not of the person's name: a search must
 *   not send a place, a remark, or the name of someone else with it, and not
 *   in letters hung onto a word, in a row of marks, in accents, or in
 *   characters that are not seen either. A word that is asked for is a word
 *   of the tree's name, or lies a letter or two from one, in Latin, Greek or
 *   Cyrillic letters; in any other script it is asked for as the tree writes
 *   it. What is left to the AI is small: which of the tree's words it leaves
 *   out, those one or two letters, and capital or small letters.
 * - **A year** must lie within {@link QUERY_YEAR_REACH} years of the year the
 *   tree has. Where the tree has no year for the birth or the death, a year
 *   may be asked for that a life can hold, counted from the year the tree
 *   does have: no death before the birth, and none more than
 *   {@link LONGEST_LIFE} years after it. Where the tree has no year at all,
 *   a year must lie at least {@link GUESS_YEARS_AGO} years back.
 *
 * Nothing is sent by this check, and nothing of the tree is said in what it
 * answers beyond the rule that was broken: an AI reads the person's names and
 * years through the tools that give them.
 */

/** How many years to either side of a year of the tree an AI may ask for. */
export const QUERY_YEAR_REACH = 10;

/** The longest a life is taken to last, where the tree gives one end of it only. */
export const LONGEST_LIFE = 120;

/** How far back a year must lie that is asked for where the tree has no year for the person at all. */
export const GUESS_YEARS_AGO = 100;

/** The longest part of a name that is sent, in characters. */
const NAME_PART_MAX = 100;

/** What an AI may send at most as one text, before anything is looked at. */
const RAW_MAX = 1000;

/** What of the person of the tree a question is held against. */
export interface QuerySubject {
  /** Every name the tree has for the person. */
  names: readonly MatchName[];
  /** The year a search of the app would send for the birth; null when the tree gives none. */
  birthYear: number | null;
  deathYear: number | null;
}

/** What a question must look like, for a tool that takes one. */
export const askedQuerySchema = z.strictObject({
  given: z.string().max(RAW_MAX).describe('The given names to ask for, as the tree has them.'),
  surname: z.string().max(RAW_MAX).describe('The last name to ask for, as the tree has it.'),
  birthYear: z
    .number()
    .int()
    .nullable()
    .describe('The year of birth to ask for, near the year the tree has; null to leave it out.'),
  deathYear: z
    .number()
    .int()
    .nullable()
    .describe('The year of death to ask for, near the year the tree has; null to leave it out.'),
});

export type CheckedQuery =
  | { ok: true; query: PersonQuery }
  | {
      ok: false;
      /**
       * `shape`: it is no question. `name`: the name is not like one the tree
       * has for the person. `years`: a year is too far from the tree's, or no
       * year of a life.
       */
      problem: 'shape' | 'name' | 'years';
      message: string;
    };

/**
 * The scripts another spelling of a name may be written in. In any other
 * script a name is asked for as the tree writes it, or not at all: there the
 * app cannot tell a letter of a name from a character that only looks like
 * nothing.
 */
const SCRIPTS = ['Latin', 'Greek', 'Cyrillic'] as const;

/**
 * A letter of one of those scripts, as one character: a letter with an accent
 * in its one composed form. No mark that stands by itself, no modifier
 * letter, and so no character that is not seen (a selector of a variant, a
 * joiner, a filler), since those are marks, or letters of other scripts.
 */
const LETTER = `(?=[\\p{Lu}\\p{Ll}\\p{Lt}\\p{Lo}])[${SCRIPTS.map((script) => `\\p{Script=${script}}`).join('')}]`;

/**
 * A part of a name between two spaces, as it may be asked for when the tree
 * does not write it so itself: letters, with one apostrophe, hyphen or full
 * stop at a time between them ("Jean-Pierre", "J.P.", "J.-P."), an
 * apostrophe before them ("'t"), and one full stop after them ("D."). So
 * punctuation cannot be strung together to say something.
 */
const NAME_TOKEN = new RegExp(`^['’]?(?:${LETTER})+(?:(?:['’-]|\\.-?)(?:${LETTER})+)*\\.?$`, 'u');

/** Each of the scripts, as a test of a whole word. */
const SCRIPT_WORDS = SCRIPTS.map((script) => new RegExp(`^\\p{Script=${script}}+$`, 'u'));

/** Which of the scripts a word is written in, all of it; -1 when in none, or in more than one. */
const scriptOf = (word: string): number => SCRIPT_WORDS.findIndex((all) => all.test(word));

/** From this likeness on, a word that is asked for can count as a word of the name. */
const WORD_LIKE = 0.85;

/** Letters that are written as two letters where the letter itself is not at hand. */
const WRITTEN_OUT: readonly (readonly [string, string])[] = [
  ['ä', 'ae'],
  ['ö', 'oe'],
  ['ü', 'ue'],
  ['ß', 'ss'],
  ['å', 'aa'],
  ['ø', 'oe'],
  ['æ', 'ae'],
];

/** A word with those letters written out, so that "kühn" and "kuehn" are one word. */
const writtenOut = (word: string): string =>
  WRITTEN_OUT.reduce((text, [letter, letters]) => text.split(letter).join(letters), word);

/** The parts of a name between its spaces, as they are written. */
const tokensOf = (text: string): string[] => text.split(/\s+/u).filter((token) => token !== '');

/** The words of a name that are compared: lower case, with their accents. */
const wordsOf = (text: string): string[] =>
  text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word !== '');

/** How many letters must be put in, taken out or changed to make one word of the other. */
function lettersApart(a: string, b: string): number {
  const from = Array.from(a);
  const to = Array.from(b);
  let row = to.map((_, at) => at + 1);
  for (let i = 0; i < from.length; i += 1) {
    let diagonal = i;
    let left = i + 1;
    const next: number[] = [];
    for (let j = 0; j < to.length; j += 1) {
      const above = row[j] ?? 0;
      left = Math.min(above + 1, left + 1, diagonal + (from[i] === to[j] ? 0 : 1));
      next.push(left);
      diagonal = above;
    }
    row = next;
  }
  return from.length === 0 ? to.length : (row[row.length - 1] ?? from.length);
}

/**
 * True when a word that is asked for is another spelling of a word of the
 * tree's name. The likeness of two names alone is not enough: it counts the
 * letters two words begin with for much, so a word with a long tail of other
 * letters would pass. So the words must also lie few letters apart, an accent
 * counting as a letter: two letters, one for a word of three or four, and
 * none for a shorter word. A letter that is written out as two ("ü" as "ue")
 * is the same letter. Both words must be in the same script, all of each, so
 * that no letter is changed for one of another script that looks like it.
 */
function alike(mine: string, word: string): boolean {
  const shorter = Math.min(Array.from(mine).length, Array.from(word).length);
  const reach = shorter < 3 ? 0 : shorter < 5 ? 1 : 2;
  const script = scriptOf(word);
  if (reach === 0 || script === -1 || script !== scriptOf(mine)) return false;
  const near = (a: string, b: string): boolean =>
    jaroWinkler(normalizeName(a), normalizeName(b)) >= WORD_LIKE && lettersApart(a, b) <= reach;
  return near(mine, word) || near(writtenOut(mine), writtenOut(word));
}

/**
 * True when a part of a name that is asked for holds nothing but the tree's
 * own name: every word of it is a word of the tree's name, or another
 * spelling of one, each word of the tree's name standing for one word at
 * most. So a name cannot carry anything along: not a place, not another
 * person, not letters hung onto a word, not a row of marks.
 *
 * A part between two spaces that the tree writes just so is taken as it
 * stands, whatever it is written with. Any other must be written as a name
 * is ({@link NAME_TOKEN}), in Latin, Greek or Cyrillic letters that are no
 * other form of a letter. For a given name an initial that is asked for
 * stands for the word of the tree it begins; an initial of the tree stands
 * for itself only.
 */
function partFits(asked: string, own: string, initials: boolean): boolean {
  const asWritten = new Set(tokensOf(own.normalize('NFC')).map((token) => token.toLowerCase()));
  const left = wordsOf(own);
  for (const token of tokensOf(asked)) {
    if (
      !asWritten.has(token.toLowerCase()) &&
      (!NAME_TOKEN.test(token) || token.normalize('NFKC') !== token)
    ) {
      return false;
    }
    for (const word of wordsOf(token)) {
      const plain = normalizeName(word);
      let at = left.indexOf(word);
      if (at === -1) at = left.findIndex((mine) => alike(mine, word));
      if (at === -1 && initials && plain.length === 1 && Array.from(word).length === 1) {
        at = left.findIndex((mine) => normalizeName(mine).startsWith(plain));
      }
      if (at === -1) return false;
      left.splice(at, 1);
    }
  }
  return true;
}

const fail = (problem: 'shape' | 'name' | 'years', message: string): CheckedQuery => ({
  ok: false,
  problem,
  message,
});

/**
 * Checks what an AI asks a source about a person. `asked` is what the AI
 * sent, as it came; `thisYear` is the year of today. What comes back is what
 * may be sent: the name cleaned to one line, and the years.
 */
export function checkQuery(asked: unknown, subject: QuerySubject, thisYear: number): CheckedQuery {
  const parsed = askedQuerySchema.safeParse(asked);
  if (!parsed.success) {
    return fail(
      'shape',
      'This is no question: it needs a given name, a last name, and a year of birth and of death, each of which may be null.',
    );
  }
  // Cleaned without a cut: a name that was cut is not the name that was asked for.
  // Each letter in its one composed form, so that what is sent is what was compared.
  const given = cleanText(parsed.data.given, RAW_MAX + 1).normalize('NFC');
  const surname = cleanText(parsed.data.surname, RAW_MAX + 1).normalize('NFC');
  if (given.length > NAME_PART_MAX || surname.length > NAME_PART_MAX) {
    return fail('name', 'A name asked for is too long.');
  }
  // A part that is punctuation only is no name either.
  if (normalizeName(given) === '' || normalizeName(surname) === '') {
    return fail('name', 'Ask for a given name and a last name.');
  }
  const name: MatchName = { given, surname };
  /** A name with its letters written out ("ß" as "ss"), which the comparison of names does not do itself. */
  const spelled = (of: MatchName): MatchName => ({
    given: writtenOut(of.given.normalize('NFC').toLowerCase()),
    surname: writtenOut(of.surname.normalize('NFC').toLowerCase()),
  });
  const fits = (own: MatchName) =>
    (compareNames(own, name) !== null || compareNames(spelled(own), spelled(name)) !== null) &&
    // As a whole the names are alike; and nothing rides along that is not of the name.
    partFits(given, own.given, true) &&
    partFits(surname, own.surname, false);
  if (!subject.names.some(fits)) {
    return fail(
      'name',
      'This name is not like a name the tree has for this person. Ask for one of their names as the tree writes it, or for another spelling that differs by a letter or two. Add nothing to it.',
    );
  }

  const { birthYear, deathYear } = parsed.data;
  for (const year of [birthYear, deathYear]) {
    if (year !== null && (year < QUERY_FIRST_YEAR || year > thisYear)) {
      return fail('years', 'A year asked for must be a year up to this one.');
    }
  }
  const near = (year: number | null, own: number | null) =>
    year === null || own === null || Math.abs(year - own) <= QUERY_YEAR_REACH;
  if (!near(birthYear, subject.birthYear) || !near(deathYear, subject.deathYear)) {
    return fail(
      'years',
      `A year asked for must lie within ${QUERY_YEAR_REACH} years of the year the tree has for this person.`,
    );
  }
  // Neither as the years were asked for, nor against the year the tree has for the other end.
  if (
    (birthYear !== null && deathYear !== null && deathYear < birthYear) ||
    (birthYear !== null && subject.deathYear !== null && subject.deathYear < birthYear) ||
    (deathYear !== null && subject.birthYear !== null && deathYear < subject.birthYear)
  ) {
    return fail('years', 'The year of death is before the year of birth.');
  }
  const guessed =
    (birthYear !== null && subject.birthYear === null) ||
    (deathYear !== null && subject.deathYear === null);
  // Where the tree has no year at all, nothing says when the person lived. A
  // year of the last hundred would be a search among people who may be living.
  if (guessed && subject.birthYear === null && subject.deathYear === null) {
    for (const year of [birthYear, deathYear]) {
      if (year !== null && year > thisYear - GUESS_YEARS_AGO) {
        return fail(
          'years',
          `The tree has no year for this person, so a year asked for must lie at least ${GUESS_YEARS_AGO} years back. Ask without years.`,
        );
      }
    }
  }
  // A year the tree does not have is held against the other end of the life,
  // as the tree has it where it has it: not as it was asked for.
  const birth = subject.birthYear ?? birthYear;
  const death = subject.deathYear ?? deathYear;
  if (guessed && birth !== null && death !== null) {
    if (death < birth || death > birth + LONGEST_LIFE) {
      return fail(
        'years',
        `The years asked for are not the years of one life: the death is before the birth, or more than ${LONGEST_LIFE} years after it.`,
      );
    }
  }
  return { ok: true, query: { given, surname, birthYear, deathYear } };
}
