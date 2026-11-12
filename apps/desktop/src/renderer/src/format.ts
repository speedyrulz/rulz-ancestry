import {
  FAMILY_EVENT_TYPES,
  PERSON_EVENT_TYPES,
  formatLifespan,
  formatName,
  type NameType,
  type Pedigree,
  type Sex,
} from '@rulz/core';
import type { PersonDraft, PersonSummary } from '../../shared/ipc';

/** Shown where a person has no name recorded. */
export const NO_NAME = 'Name not recorded';

type Named = Pick<PersonSummary, 'name'>;

/** A person's name as written in a sentence or a heading: "Dr. John Smith Jr." */
export function fullName(person: Named): string {
  const text = person.name ? formatName(person.name) : '';
  return text === '' ? NO_NAME : text;
}

/** A person's name as an index lists it: "Smith, John". */
export function listName(person: Named): string {
  const name = person.name;
  if (!name) return NO_NAME;
  const rest = formatName({ ...name, surname: '' });
  if (name.surname === '') return rest === '' ? NO_NAME : rest;
  return rest === '' ? name.surname : `${name.surname}, ${rest}`;
}

/** "1850–1921", "b. 1850", "d. 1921" or empty. */
export function lifespan(person: Pick<PersonSummary, 'birth' | 'death'>): string {
  return formatLifespan(person.birth?.year ?? '', person.death?.year ?? '');
}

export const SEX_LABELS: Readonly<Record<Sex, string>> = {
  M: 'Male',
  F: 'Female',
  X: 'Other',
  U: 'Not known',
};

export const NAME_TYPE_LABELS: Readonly<Record<NameType, string>> = {
  birth: 'Birth name',
  married: 'Married name',
  maiden: 'Maiden name',
  aka: 'Also known as',
  immigrant: 'Name after immigration',
  professional: 'Professional name',
  other: 'Other name',
};

export const PEDIGREE_LABELS: Readonly<Record<Pedigree, string>> = {
  birth: 'Birth',
  adopted: 'Adopted',
  foster: 'Foster',
  step: 'Step',
  sealing: 'Sealing',
  other: 'Other',
};

/**
 * A stored value such as an event type as a label: "naturalization" becomes
 * "Naturalization". Values the app has no fixed label for (an imported file
 * may hold any) are shown the same way.
 */
export function labelOf(value: string, labels: Readonly<Record<string, string>> = {}): string {
  const known = labels[value];
  if (known !== undefined) return known;
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text === '' ? 'Not stated' : text.charAt(0).toUpperCase() + text.slice(1);
}

export const PERSON_EVENT_OPTIONS: readonly string[] = PERSON_EVENT_TYPES;
export const FAMILY_EVENT_OPTIONS: readonly string[] = FAMILY_EVENT_TYPES;

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A moment (Unix milliseconds) in the user's own date and time format. */
export function formatWhen(at: number): string {
  return WHEN.format(new Date(at));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1 person", "2 people". */
export function countOf(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** The fields of the "add person" form. */
export interface PersonFieldsValue {
  given: string;
  surname: string;
  sex: Sex;
  birthDate: string;
  birthPlace: string;
  deathDate: string;
  deathPlace: string;
}

export const EMPTY_PERSON: PersonFieldsValue = {
  given: '',
  surname: '',
  sex: 'U',
  birthDate: '',
  birthPlace: '',
  deathDate: '',
  deathPlace: '',
};

/** What the form holds as a draft for the main process: only the fields that were filled in. */
export function toDraft(value: PersonFieldsValue): PersonDraft {
  const draft: PersonDraft = { sex: value.sex };
  const fields = [
    'given',
    'surname',
    'birthDate',
    'birthPlace',
    'deathDate',
    'deathPlace',
  ] as const;
  for (const field of fields) {
    const text = value[field].trim();
    if (text !== '') draft[field] = text;
  }
  return draft;
}
