import { NAME_TYPES } from '../model';
import {
  childValue,
  cloneNode,
  findChild,
  findChildren,
  makeNode,
  setChildValue,
  touch,
  type GedcomNode,
  type GedcomVersion,
} from './node';

/**
 * A personal name: reading one from a GEDCOM NAME structure, and writing one
 * back with as little change to the original lines as possible.
 *
 * GEDCOM writes a name twice: as one value with the surname between slashes
 * (`John /Smith/ Jr.`), and optionally as pieces under it (GIVN, SURN and so
 * on). The value is the main form; the pieces say which part is which.
 */

/** A name as the app stores it. */
export interface NameFields {
  type: string;
  /** Title before the name, e.g. "Dr." */
  prefix: string;
  given: string;
  nickname: string;
  surname: string;
  /** Text after the name, e.g. "Jr." */
  suffix: string;
}

/** The longest text the app's forms accept for a part of a name. */
const LONG = 200;
const SHORT = 100;

/** The usual order of the lines under a NAME line. */
const NAME_ORDER = ['TYPE', 'NPFX', 'GIVN', 'NICK', 'SPFX', 'SURN', 'NSFX'] as const;

const TYPE_SYNONYMS: Readonly<Record<string, string>> = {
  'also known as': 'aka',
  alias: 'aka',
  'birth name': 'birth',
  'maiden name': 'maiden',
  'married name': 'married',
};

/** Trims, joins runs of spaces and cuts to the length the forms accept. */
function clean(text: string, max: number): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, max).trim();
}

/** Every piece with this tag, joined; GEDCOM 7.0 allows a piece to appear more than once. */
function piece(node: GedcomNode, tag: string): string {
  return findChildren(node, tag)
    .map((child) => child.value)
    .join(' ');
}

interface SplitName {
  before: string;
  surname: string;
  after: string;
  /** False when the value has no slashes, so nothing marks the surname. */
  slashes: boolean;
}

/** Splits a NAME value at the slashes around the surname. */
export function splitNameValue(value: string): SplitName {
  const first = value.indexOf('/');
  if (first === -1) return { before: value, surname: '', after: '', slashes: false };
  const second = value.indexOf('/', first + 1);
  if (second === -1) {
    return {
      before: value.slice(0, first),
      surname: value.slice(first + 1),
      after: '',
      slashes: true,
    };
  }
  return {
    before: value.slice(0, first),
    surname: value.slice(first + 1, second),
    after: value.slice(second + 1),
    slashes: true,
  };
}

function readType(node: GedcomNode): string {
  const typeNode = findChild(node, 'TYPE');
  if (!typeNode) return 'birth';
  let type = typeNode.value.trim().toLowerCase();
  if (type === 'other') {
    // GEDCOM 7.0 writes a type outside its own list as OTHER with a phrase.
    const phrase = childValue(typeNode, 'PHRASE').trim().toLowerCase();
    if ((NAME_TYPES as readonly string[]).includes(phrase)) type = phrase;
  }
  type = TYPE_SYNONYMS[type] ?? type;
  if (type === '') return 'birth';
  return (NAME_TYPES as readonly string[]).includes(type) ? type : 'other';
}

/** Reads a NAME structure. */
export function readName(node: GedcomNode): NameFields {
  const value = splitNameValue(node.value);
  const prefix = clean(piece(node, 'NPFX'), SHORT);
  const givenPiece = clean(piece(node, 'GIVN'), LONG);
  const surnamePiece = clean(`${piece(node, 'SPFX')} ${piece(node, 'SURN')}`, LONG);
  const suffixPiece = clean(piece(node, 'NSFX'), SHORT);

  let given = clean(value.before, LONG);
  let surname = '';
  let suffix = suffixPiece;

  if (value.slashes) {
    surname = clean(value.surname, LONG);
    const after = clean(value.after, LONG);
    if (given === '' && after !== '' && suffixPiece === '') {
      // The surname is written first, as in Hungarian or Chinese names, so
      // what follows it is the given name, not a suffix.
      given = givenPiece !== '' ? givenPiece : after;
    } else if (suffixPiece === '') {
      suffix = clean(after, SHORT);
    }
  } else if (givenPiece !== '' || surnamePiece !== '') {
    // No slashes, so only the pieces say which part is the surname.
    given = givenPiece;
    surname = surnamePiece;
  }

  // Some programs put the title in the value as well as in its own piece.
  if (prefix !== '' && given.toLowerCase().startsWith(prefix.toLowerCase())) {
    const rest = given.slice(prefix.length);
    if (rest === '' || rest.startsWith(' ')) given = rest.trim();
  }
  if (given === '') given = givenPiece;

  return {
    type: readType(node),
    prefix,
    given,
    nickname: clean(piece(node, 'NICK'), SHORT),
    surname,
    suffix,
  };
}

/** The NAME value for a name: `Given /Surname/ Suffix`. The title and nickname have their own lines. */
export function formatNameValue(fields: Pick<NameFields, 'given' | 'surname' | 'suffix'>): string {
  if (fields.given === '' && fields.surname === '' && fields.suffix === '') return '';
  return `${fields.given} /${fields.surname}/ ${fields.suffix}`.trim();
}

/**
 * The NAME structure for a name. With no `original` it is written afresh. With
 * the structure the name was imported from, only the lines whose part of the
 * name has changed since are rewritten; the rest, and everything the app does
 * not model (sources, notes, other programs' own tags), stay as they were.
 */
export function patchName(
  original: GedcomNode | null,
  fields: NameFields,
  version: GedcomVersion,
): GedcomNode {
  const node = original ? cloneNode(original) : makeNode('NAME');
  const was = original ? readName(original) : null;
  const differs = (part: keyof NameFields) => was === null || was[part] !== fields[part];
  const has = (tag: string) => findChild(node, tag) !== undefined;

  if (differs('prefix') || differs('given') || differs('surname') || differs('suffix')) {
    const value = formatNameValue(fields);
    if (node.value !== value) {
      node.value = value;
      touch(node);
    }
    if (differs('prefix')) setChildValue(node, 'NPFX', fields.prefix, NAME_ORDER);
    // A piece that the value already carries is only kept in step where the
    // original had it; a new name gets both, as most programs write them.
    if (differs('given') && (was === null || has('GIVN'))) {
      setChildValue(node, 'GIVN', fields.given, NAME_ORDER);
    }
    if (differs('surname')) {
      // The surname is stored whole, so a separate surname prefix no longer applies.
      node.children = node.children.filter((child) => child.tag !== 'SPFX');
      if (was === null || has('SURN')) setChildValue(node, 'SURN', fields.surname, NAME_ORDER);
    }
    if (differs('suffix') && (was === null || has('NSFX'))) {
      setChildValue(node, 'NSFX', fields.suffix, NAME_ORDER);
    }
  }

  if (differs('nickname')) setChildValue(node, 'NICK', fields.nickname, NAME_ORDER);

  // A new birth name needs no TYPE line: birth is what a name is taken to be.
  if (differs('type') && !(was === null && fields.type === 'birth')) {
    const value = version === '7.0' ? fields.type.toUpperCase() : fields.type;
    const typeNode = setChildValue(node, 'TYPE', value, NAME_ORDER);
    if (typeNode) typeNode.children = typeNode.children.filter((child) => child.tag !== 'PHRASE');
  }
  return node;
}
