import { PEDIGREES, SEXES, type Sex } from '../model';
import {
  childValue,
  cloneNode,
  findChild,
  makeNode,
  pointerTo,
  setChildValue,
  touch,
  type GedcomNode,
  type GedcomVersion,
} from './node';

/**
 * The single-line facts of a person or family record: sex, the living flag,
 * and how a child is linked to a family.
 */

/** Reads a SEX line. Anything other than the four known values is "not known". */
export function readSex(node: GedcomNode): Sex {
  const value = node.value.trim().toUpperCase();
  return (SEXES as readonly string[]).includes(value) ? (value as Sex) : 'U';
}

/**
 * The SEX line for a person, or null when none is needed: a person who was
 * imported without one and whose sex is still not known.
 */
export function patchSex(original: GedcomNode | null, sex: Sex): GedcomNode | null {
  if (!original) return sex === 'U' ? null : makeNode('SEX', sex);
  if (readSex(original) === sex) return original;
  const node = cloneNode(original);
  node.value = sex;
  touch(node);
  return node;
}

/**
 * GEDCOM has no line for "this person is living". The app writes its own
 * (`1 _LIVING Y` or `N`), so that the setting survives its own export and
 * import. A program that does not know the tag ignores it.
 */
export const LIVING_TAG = '_LIVING';

/** Reads a `_LIVING` line the app wrote. Any other value is left alone and means "not stated". */
export function readLiving(node: GedcomNode): boolean | null {
  const value = node.value.trim().toUpperCase();
  if (value === 'Y') return true;
  if (value === 'N') return false;
  return null;
}

/** The `_LIVING` line for a person, or null when living or deceased is not stated. */
export function patchLiving(
  original: GedcomNode | null,
  living: boolean | null,
): GedcomNode | null {
  if (original && readLiving(original) === living) return original;
  if (living === null) return null;
  const node = original ? cloneNode(original) : makeNode(LIVING_TAG);
  node.value = living ? 'Y' : 'N';
  touch(node);
  return node;
}

const PEDIGREE_SYNONYMS: Readonly<Record<string, string>> = {
  natural: 'birth',
  biological: 'birth',
  adoptive: 'adopted',
  adoption: 'adopted',
  fostered: 'foster',
  stepchild: 'step',
  'step-child': 'step',
  sealed: 'sealing',
};

/** A pedigree word from a file as one of the app's own values, or null when it says nothing. */
function pedigreeWord(text: string): string | null {
  const word = text.trim().toLowerCase();
  if (word === '' || word === 'unknown') return null;
  const known = PEDIGREE_SYNONYMS[word] ?? word;
  return (PEDIGREES as readonly string[]).includes(known) ? known : 'other';
}

function pedigreeFromChildOf(famc: GedcomNode): string | null {
  const pedi = findChild(famc, 'PEDI');
  if (!pedi) return null;
  const word = pedigreeWord(pedi.value);
  if (word !== 'other') return word;
  // GEDCOM 7.0 writes a kind outside its own list as OTHER with a phrase.
  const phrase = pedigreeWord(childValue(pedi, 'PHRASE'));
  return phrase ?? 'other';
}

/**
 * Ancestry and Family Tree Maker do not use PEDI. They put the child's
 * relationship to each parent under the family's CHIL line, as `_FREL` (to the
 * father) and `_MREL` (to the mother). The app keeps one kind of link per
 * family, so a child who is the birth child of either parent counts as a birth
 * child; otherwise the first relationship given is used.
 */
function pedigreeFromChildLine(chil: GedcomNode): string | null {
  const stated = ['_FREL', '_MREL']
    .map((tag) => {
      const line = findChild(chil, tag);
      return line ? pedigreeWord(line.value) : null;
    })
    .filter((word): word is string => word !== null);
  if (stated.length === 0) return null;
  return stated.includes('birth') ? 'birth' : (stated[0] ?? null);
}

/**
 * How a child is linked to a family, from the person's FAMC line and the
 * family's CHIL line; either may be missing. The standard PEDI line wins.
 */
export function readPedigree(famc: GedcomNode | null, chil: GedcomNode | null): string {
  return (
    (famc ? pedigreeFromChildOf(famc) : null) ??
    (chil ? pedigreeFromChildLine(chil) : null) ??
    'birth'
  );
}

const SEVEN_PEDIGREES = new Set(['birth', 'adopted', 'foster', 'sealing', 'other']);

function setPedigreeLine(famc: GedcomNode, pedigree: string, version: GedcomVersion): void {
  if (version === '7.0') {
    const listed = SEVEN_PEDIGREES.has(pedigree);
    const pedi = setChildValue(famc, 'PEDI', listed ? pedigree.toUpperCase() : 'OTHER', []);
    if (!pedi) return;
    pedi.children = pedi.children.filter((child) => child.tag !== 'PHRASE');
    if (!listed) pedi.children.push(makeNode('PHRASE', pedigree));
  } else {
    setChildValue(famc, 'PEDI', pedigree, []);
  }
}

/**
 * The FAMC line of a person record: "this person is a child in that family".
 * `was` is the kind of link the file gave; the PEDI line is only rewritten
 * when the kind has changed since.
 */
export function patchChildOf(
  original: GedcomNode | null,
  familyXref: string,
  pedigree: string,
  was: string | null,
  version: GedcomVersion,
): GedcomNode {
  if (!original) {
    const node = makeNode('FAMC', pointerTo(familyXref));
    if (pedigree !== 'birth') setPedigreeLine(node, pedigree, version);
    return node;
  }
  if (was === pedigree) return original;
  const node = cloneNode(original);
  setPedigreeLine(node, pedigree, version);
  return node;
}

const RELATIONSHIP_LABELS: Readonly<Record<string, string>> = {
  birth: 'Natural',
  adopted: 'Adopted',
  foster: 'Foster',
  step: 'Step',
  sealing: 'Sealing',
  other: 'Other',
};

/**
 * The CHIL line of a family record. Where the file gave the relationship to
 * each parent (`_FREL`, `_MREL`) and the kind of link has changed since, those
 * lines are brought in step with it.
 */
export function patchChildLine(
  original: GedcomNode | null,
  childXref: string,
  pedigree: string,
  was: string | null,
): GedcomNode {
  if (!original) return makeNode('CHIL', pointerTo(childXref));
  if (was === pedigree) return original;
  const hasRelationships = original.children.some(
    (child) => child.tag === '_FREL' || child.tag === '_MREL',
  );
  if (!hasRelationships) return original;
  const node = cloneNode(original);
  const label = RELATIONSHIP_LABELS[pedigree] ?? 'Other';
  for (const child of node.children) {
    if ((child.tag === '_FREL' || child.tag === '_MREL') && child.value !== label) {
      child.value = label;
      touch(child);
    }
  }
  return node;
}
