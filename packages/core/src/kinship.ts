import type { Sex } from './model';

/**
 * Names for how two people are related: "second cousin once removed",
 * "2nd great-grandmother", "sister-in-law".
 *
 * A blood relationship is described by two counts, taken from the nearest
 * ancestor the two people share: `up` is the number of generations from the
 * first person up to that ancestor, and `down` the number from the ancestor
 * down to the second person. A father is (1, 0), a sister (1, 1), a niece
 * (1, 2), a first cousin (2, 2).
 */

/** How the second person is related to the first by descent. */
export interface BloodRelation {
  up: number;
  down: number;
  /**
   * True when the two lines meet in one shared ancestor, not in a couple: a
   * half-sister, a half first cousin. Always false in a direct line.
   */
  half: boolean;
}

/** How the second person is related to the first. */
export type Relationship =
  | { kind: 'self' }
  | ({ kind: 'blood' } & BloodRelation)
  /** The two are partners. `married` is true when a marriage is recorded for them. */
  | { kind: 'partner'; married: boolean }
  /** The second person is the partner of a blood relative of the first; the counts place that relative. */
  | ({ kind: 'partner-of-relative'; married: boolean; viaSex: Sex } & BloodRelation)
  /** The second person is a blood relative of the first person's partner; the counts start at the partner. */
  | ({ kind: 'relative-of-partner'; married: boolean; viaSex: Sex } & BloodRelation)
  | { kind: 'none' };

type Words = readonly [male: string, female: string, either: string];

function pick(words: Words, sex: Sex): string {
  return sex === 'M' ? words[0] : sex === 'F' ? words[1] : words[2];
}

const ORDINAL_WORDS = [
  '',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

/** "1st", "2nd", "3rd", "11th", "22nd". */
export function ordinal(value: number): string {
  const lastTwo = value % 100;
  const last = value % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : last === 1
        ? 'st'
        : last === 2
          ? 'nd'
          : last === 3
            ? 'rd'
            : 'th';
  return `${value}${suffix}`;
}

/**
 * The prefix for a line of grandparents or grandchildren that is `steps`
 * generations long: 2 gives "grand", 3 "great-grand", 4 "2nd great-grand".
 */
function grandPrefix(steps: number): string {
  if (steps <= 1) return '';
  if (steps === 2) return 'grand';
  if (steps === 3) return 'great-grand';
  return `${ordinal(steps - 2)} great-grand`;
}

const PARENT: Words = ['father', 'mother', 'parent'];
const CHILD: Words = ['son', 'daughter', 'child'];
const SIBLING: Words = ['brother', 'sister', 'sibling'];
const UNCLE: Words = ['uncle', 'aunt', 'aunt or uncle'];
const NEPHEW: Words = ['nephew', 'niece', 'niece or nephew'];

function removed(times: number): string {
  if (times === 0) return '';
  if (times === 1) return ' once removed';
  if (times === 2) return ' twice removed';
  return ` ${times} times removed`;
}

/**
 * The name of a blood relationship, said of the second person: with `up` 2,
 * `down` 0 and a woman, "grandmother".
 */
export function kinshipTerm(relation: BloodRelation, sex: Sex): string {
  const up = Math.max(0, Math.trunc(relation.up));
  const down = Math.max(0, Math.trunc(relation.down));
  if (up === 0 && down === 0) return 'the same person';
  if (down === 0) return `${grandPrefix(up)}${pick(PARENT, sex)}`;
  if (up === 0) return `${grandPrefix(down)}${pick(CHILD, sex)}`;

  const half = relation.half ? 'half-' : '';
  if (up === 1 && down === 1) return `${half}${pick(SIBLING, sex)}`;
  // A brother or sister of an ancestor.
  if (down === 1) return `${half}${grandPrefix(up - 1)}${pick(UNCLE, sex)}`;
  // A descendant of a brother or sister.
  if (up === 1) return `${half}${grandPrefix(down - 1)}${pick(NEPHEW, sex)}`;

  const degree = Math.min(up, down) - 1;
  const word = ORDINAL_WORDS[degree] ?? ordinal(degree);
  return `${relation.half ? 'half ' : ''}${word} cousin${removed(Math.abs(up - down))}`;
}

function partnerWord(sex: Sex, married: boolean): string {
  if (!married) return 'partner';
  return pick(['husband', 'wife', 'spouse'], sex);
}

function withArticle(term: string): string {
  return /^[aeiou]/i.test(term) || /^(8|11|18)/.test(term) ? `an ${term}` : `a ${term}`;
}

const isParent = (r: BloodRelation) => r.up === 1 && r.down === 0;
const isChild = (r: BloodRelation) => r.up === 0 && r.down === 1;
const isSibling = (r: BloodRelation) => r.up === 1 && r.down === 1;

/**
 * The name of any relationship, said of the second person, whose sex is
 * `sex`: "wife", "first cousin", "stepfather", "husband of a first cousin",
 * "wife's grandfather". Empty for `none`.
 */
export function relationshipTerm(relationship: Relationship, sex: Sex): string {
  switch (relationship.kind) {
    case 'self':
      return 'the same person';
    case 'none':
      return '';
    case 'blood':
      return kinshipTerm(relationship, sex);
    case 'partner':
      return partnerWord(sex, relationship.married);
    case 'partner-of-relative': {
      // The partner of a parent, a child or a sibling has a name of its own.
      if (isParent(relationship)) return pick(['stepfather', 'stepmother', 'step-parent'], sex);
      if (isChild(relationship)) {
        return pick(['son-in-law', 'daughter-in-law', 'child-in-law'], sex);
      }
      if (isSibling(relationship) && !relationship.half) {
        return pick(['brother-in-law', 'sister-in-law', 'sibling-in-law'], sex);
      }
      const relative = kinshipTerm(relationship, relationship.viaSex);
      return `${partnerWord(sex, relationship.married)} of ${withArticle(relative)}`;
    }
    case 'relative-of-partner': {
      if (isParent(relationship)) {
        return pick(['father-in-law', 'mother-in-law', 'parent-in-law'], sex);
      }
      if (isChild(relationship)) return pick(['stepson', 'stepdaughter', 'stepchild'], sex);
      if (isSibling(relationship) && !relationship.half) {
        return pick(['brother-in-law', 'sister-in-law', 'sibling-in-law'], sex);
      }
      const partner = partnerWord(relationship.viaSex, relationship.married);
      return `${partner}'s ${kinshipTerm(relationship, sex)}`;
    }
  }
}

/** Orders blood relationships from closest to most distant. */
export function compareCloseness(a: BloodRelation, b: BloodRelation): number {
  return (
    a.up + a.down - (b.up + b.down) ||
    Math.max(a.up, a.down) - Math.max(b.up, b.down) ||
    Number(a.half) - Number(b.half) ||
    a.up - b.up
  );
}
