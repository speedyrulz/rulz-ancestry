/**
 * Value sets shared by the database layer, GEDCOM and the user interface.
 *
 * `Sex` is a closed set that the database enforces. The other sets list the
 * values the app knows how to label; the database stores them as free text so
 * that an imported file can keep a value this list does not have.
 */

/** Male, female, intersex or other, unknown. Matches GEDCOM 7 `SEX`. */
export const SEXES = ['M', 'F', 'X', 'U'] as const;
export type Sex = (typeof SEXES)[number];

export const NAME_TYPES = [
  'birth',
  'married',
  'maiden',
  'aka',
  'immigrant',
  'professional',
  'other',
] as const;
export type NameType = (typeof NAME_TYPES)[number];

/** How a child is linked to a family. */
export const PEDIGREES = ['birth', 'adopted', 'foster', 'step', 'sealing', 'other'] as const;
export type Pedigree = (typeof PEDIGREES)[number];

/** Event types that belong to one person. */
export const PERSON_EVENT_TYPES = [
  'birth',
  'baptism',
  'death',
  'burial',
  'cremation',
  'adoption',
  'residence',
  'occupation',
  'education',
  'census',
  'immigration',
  'emigration',
  'naturalization',
  'military',
  'will',
  'probate',
] as const;

/** Event types that belong to a couple. */
export const FAMILY_EVENT_TYPES = ['marriage', 'engagement', 'divorce', 'annulment'] as const;

export interface NameParts {
  prefix?: string;
  given?: string;
  nickname?: string;
  surname?: string;
  suffix?: string;
}

/** One-line display form of a name, e.g. `Dr. John "Jack" Smith Jr.`. */
export function formatName(name: NameParts): string {
  const nickname = name.nickname ? `"${name.nickname}"` : '';
  return [name.prefix, name.given, nickname, name.surname, name.suffix]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

/**
 * A person's lifespan from the two year labels (see `yearLabel`): "1850–1921",
 * "b. 1850", "d. 1921", or empty when neither is known.
 */
export function formatLifespan(birthYear: string, deathYear: string): string {
  if (birthYear !== '' && deathYear !== '') return `${birthYear}–${deathYear}`;
  if (birthYear !== '') return `b. ${birthYear}`;
  if (deathYear !== '') return `d. ${deathYear}`;
  return '';
}
