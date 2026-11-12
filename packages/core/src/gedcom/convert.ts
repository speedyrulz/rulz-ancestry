import { toGedcomDate } from '../date';
import { conformEvent, type EventOwner } from './events';
import {
  VOID_POINTER,
  childValue,
  findChild,
  makeNode,
  pointerTarget,
  pointerTo,
  touch,
  type GedcomNode,
  type GedcomVersion,
} from './node';

/**
 * Rewrites records read from one GEDCOM version in the grammar of the other.
 *
 * This is for the parts of a file the app keeps as written because it has no
 * model for them yet: sources, notes, media and other programs' own tags.
 * (What the app does model is written for the right version from the start.)
 * It covers the differences that are a plain change of spelling: tags that
 * were renamed or dropped, values that changed case, dates, and note records.
 * A structure it has no rule for is written as it is.
 *
 * Every rule leaves text that is already in the target form alone, so running
 * a conversion twice gives the same result as running it once.
 */

/** Tags of GEDCOM 5.5.1 that GEDCOM 7.0 no longer has. They are kept under a tag of the app's own. */
const ONLY_IN_FIVE = new Set(['AFN', 'RFN', 'RIN', 'FONE', 'ROMN', 'SUBN', 'BLOB']);

/** Tags that GEDCOM 7.0 added. In a 5.5.1 file they are kept under a tag of the app's own. */
const ONLY_IN_SEVEN = new Set([
  'PHRASE',
  'TRAN',
  'MIME',
  'CROP',
  'EXID',
  'UID',
  'CREA',
  'NO',
  'SDATE',
  'INIL',
  'SCHMA',
  'TAG',
]);

const SEVEN_PEDI = new Set(['ADOPTED', 'BIRTH', 'FOSTER', 'SEALING', 'OTHER']);
const SEVEN_NAME_TYPE = new Set([
  'AKA',
  'BIRTH',
  'IMMIGRANT',
  'MAIDEN',
  'MARRIED',
  'PROFESSIONAL',
  'OTHER',
]);
const SEVEN_MEDI = new Set([
  'AUDIO',
  'BOOK',
  'CARD',
  'ELECTRONIC',
  'FICHE',
  'FILM',
  'MAGAZINE',
  'MANUSCRIPT',
  'MAP',
  'NEWSPAPER',
  'PHOTO',
  'TOMBSTONE',
  'VIDEO',
  'OTHER',
]);
const SEVEN_ROLE = new Set([
  'CHIL',
  'CLERGY',
  'FATH',
  'FRIEND',
  'GODP',
  'HUSB',
  'MOTH',
  'MULTIPLE',
  'NGHBR',
  'OFFICIATOR',
  'PARENT',
  'SPOU',
  'WIFE',
  'WITN',
  'OTHER',
]);
/** The only roles GEDCOM 5.5.1 names; any other is written in brackets. */
const FIVE_ROLE = new Set(['CHIL', 'HUSB', 'WIFE', 'MOTH', 'FATH', 'SPOU']);

/** File formats as GEDCOM 5.5.1 names them, and the media types GEDCOM 7.0 uses instead. */
const MEDIA_TYPES: readonly (readonly [string, string])[] = [
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['bmp', 'image/bmp'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['htm', 'text/html'],
  ['html', 'text/html'],
  ['rtf', 'application/rtf'],
  ['doc', 'application/msword'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['avi', 'video/x-msvideo'],
  ['mpg', 'video/mpeg'],
  ['mpeg', 'video/mpeg'],
];

/** Language names of GEDCOM 5.5.1 and the language tags GEDCOM 7.0 uses instead. */
const LANGUAGES: readonly (readonly [string, string])[] = [
  ['Afrikaans', 'af'],
  ['Albanian', 'sq'],
  ['Arabic', 'ar'],
  ['Armenian', 'hy'],
  ['Belorusian', 'be'],
  ['Bulgarian', 'bg'],
  ['Catalan', 'ca'],
  ['Czech', 'cs'],
  ['Danish', 'da'],
  ['Dutch', 'nl'],
  ['English', 'en'],
  ['Esperanto', 'eo'],
  ['Estonian', 'et'],
  ['Faroese', 'fo'],
  ['Finnish', 'fi'],
  ['French', 'fr'],
  ['Georgian', 'ka'],
  ['German', 'de'],
  ['Greek', 'el'],
  ['Hebrew', 'he'],
  ['Hindi', 'hi'],
  ['Hungarian', 'hu'],
  ['Icelandic', 'is'],
  ['Indonesian', 'id'],
  ['Italian', 'it'],
  ['Japanese', 'ja'],
  ['Korean', 'ko'],
  ['Latvian', 'lv'],
  ['Lithuanian', 'lt'],
  ['Macedonian', 'mk'],
  ['Norwegian', 'no'],
  ['Persian', 'fa'],
  ['Polish', 'pl'],
  ['Portuguese', 'pt'],
  ['Romanian', 'ro'],
  ['Russian', 'ru'],
  ['Serb', 'sr'],
  ['Slovak', 'sk'],
  ['Slovene', 'sl'],
  ['Spanish', 'es'],
  ['Swedish', 'sv'],
  ['Thai', 'th'],
  ['Turkish', 'tr'],
  ['Ukrainian', 'uk'],
  ['Vietnamese', 'vi'],
  ['Yiddish', 'yi'],
];

const LDS_ORDINANCES = new Set(['BAPL', 'CONL', 'ENDL', 'SLGC', 'SLGS', 'INIL']);

function retag(node: GedcomNode, tag: string): void {
  if (node.tag === tag) return;
  node.tag = tag;
  touch(node);
}

function setValue(node: GedcomNode, value: string): void {
  if (node.value === value) return;
  node.value = value;
  touch(node);
}

function removeChildren(node: GedcomNode, tag: string): void {
  if (node.children.some((child) => child.tag === tag)) {
    node.children = node.children.filter((child) => child.tag !== tag);
  }
}

/**
 * Writes a value from a fixed list the GEDCOM 7.0 way: in capitals, and as
 * OTHER with the original wording in a PHRASE line when it is not in the list.
 */
function enumToSeven(node: GedcomNode, allowed: ReadonlySet<string>, phrase: boolean): void {
  const stated = node.value
    .trim()
    .replace(/^\((.*)\)$/, '$1')
    .trim();
  if (stated === '') return;
  const upper = stated.toUpperCase();
  if (allowed.has(upper)) {
    setValue(node, upper);
  } else if (phrase) {
    setValue(node, 'OTHER');
    if (!findChild(node, 'PHRASE')) node.children.unshift(makeNode('PHRASE', stated));
  }
}

/** Writes a value from a fixed list the GEDCOM 5.5.1 way: lower case, with a phrase taking the place of OTHER. */
function enumToFive(node: GedcomNode): void {
  const stated = node.value.trim();
  if (stated === '') return;
  const phrase = childValue(node, 'PHRASE').trim();
  if (stated.toUpperCase() === 'OTHER' && phrase !== '') {
    setValue(node, phrase);
    removeChildren(node, 'PHRASE');
  } else {
    setValue(node, stated.toLowerCase());
  }
}

function ownerOf(record: GedcomNode): EventOwner | null {
  if (record.tag === 'INDI') return 'person';
  if (record.tag === 'FAM') return 'family';
  return null;
}

interface Context {
  /** The record being converted, which decides how its events are read. */
  record: GedcomNode;
  result: ConvertResult;
}

export interface ConvertResult {
  /**
   * Kinds of structure that were written as they are because the app has no
   * rule to convert them, with how many of each. The file is still complete,
   * but a strict reader of the target version may not accept these.
   */
  unconverted: Record<string, number>;
}

function count(result: ConvertResult, what: string): void {
  result.unconverted[what] = (result.unconverted[what] ?? 0) + 1;
}

/** Converts one node for GEDCOM 7.0. Returns false when the node should be left out. */
function toSeven(node: GedcomNode, parent: GedcomNode | null, context: Context): boolean {
  const pointer = pointerTarget(node.value);

  if (ONLY_IN_FIVE.has(node.tag)) retag(node, `_${node.tag}`);
  if (node.tag === 'EMAI') retag(node, 'EMAIL');

  switch (node.tag) {
    case 'NOTE':
      // A note of its own is a "shared note" in 7.0, both the record and links to it.
      if (pointer !== null || (parent === null && node.xref !== null)) retag(node, 'SNOTE');
      break;
    case 'DATE': {
      if (node.value.trim() === '') break;
      const written = toGedcomDate(node.value, '7.0');
      setValue(node, written.value);
      if (written.phrase !== null && !findChild(node, 'PHRASE')) {
        node.children.unshift(makeNode('PHRASE', written.phrase));
      }
      break;
    }
    case 'SEX':
      setValue(node, node.value.trim().toUpperCase());
      break;
    case 'PEDI':
      enumToSeven(node, SEVEN_PEDI, true);
      break;
    case 'RESN':
      setValue(node, node.value.trim().toUpperCase());
      break;
    case 'STAT':
      if (parent?.tag === 'FAMC') setValue(node, node.value.trim().toUpperCase());
      else if (parent && LDS_ORDINANCES.has(parent.tag)) {
        setValue(node, node.value.trim().toUpperCase().replace('DNS/CAN', 'DNS_CAN'));
      }
      break;
    case 'MEDI':
      enumToSeven(node, SEVEN_MEDI, true);
      break;
    case 'ROLE':
      enumToSeven(node, SEVEN_ROLE, true);
      break;
    case 'ADOP':
      if (parent?.tag === 'FAMC') setValue(node, node.value.trim().toUpperCase());
      break;
    case 'TYPE':
      if (parent?.tag === 'NAME') enumToSeven(node, SEVEN_NAME_TYPE, true);
      // Under a file's format, 5.5.1 names the kind of medium with TYPE; 7.0 uses MEDI.
      else if (parent?.tag === 'FORM') {
        retag(node, 'MEDI');
        enumToSeven(node, SEVEN_MEDI, true);
      }
      break;
    case 'FORM':
      if (parent?.tag === 'FILE' || parent?.tag === 'OBJE') {
        const stated = node.value.trim().toLowerCase();
        const known = MEDIA_TYPES.find(([extension]) => extension === stated);
        if (known) setValue(node, known[1]);
        else if (stated !== '' && !stated.includes('/')) count(context.result, 'file format');
      }
      break;
    case 'LANG': {
      const stated = node.value.trim().toLowerCase();
      const known = LANGUAGES.find(([name]) => name.toLowerCase() === stated);
      if (known) setValue(node, known[1]);
      break;
    }
    case 'AGE': {
      const keyword = node.value.trim().toUpperCase();
      const ages: Readonly<Record<string, string>> = {
        CHILD: '< 8y',
        INFANT: '< 1y',
        STILLBORN: '0y',
      };
      const age = ages[keyword];
      if (age !== undefined) {
        if (!findChild(node, 'PHRASE'))
          node.children.unshift(makeNode('PHRASE', node.value.trim()));
        setValue(node, age);
      }
      break;
    }
    case 'RELA':
      // "Godfather" as the relation of an associated person: a role with a phrase in 7.0.
      if (parent?.tag === 'ASSO') {
        const stated = node.value.trim();
        retag(node, 'ROLE');
        setValue(node, 'OTHER');
        if (stated !== '') node.children.unshift(makeNode('PHRASE', stated));
      }
      break;
    case 'SOUR':
      // A source described in place, with no source record: 7.0 needs a pointer.
      if (parent !== null && parent.tag !== 'HEAD' && pointer === null && node.value !== '') {
        const described = node.value;
        setValue(node, VOID_POINTER);
        const texts = node.children.filter((child) => child.tag === 'TEXT');
        node.children = node.children.filter((child) => child.tag !== 'TEXT');
        node.children.unshift(makeNode('PAGE', described));
        if (texts.length > 0) node.children.push(makeNode('DATA', '', texts));
      }
      break;
    case 'OBJE':
      // A media item described in place: 7.0 only has media records.
      if (parent !== null && pointer === null)
        count(context.result, 'media item described in place');
      break;
    default:
      break;
  }

  const owner = parent === context.record ? ownerOf(context.record) : null;
  if (owner !== null) conformEvent(node, owner, '7.0');
  return true;
}

/** Converts one node for GEDCOM 5.5.1. Returns false when the node should be left out. */
function toFive(node: GedcomNode, parent: GedcomNode | null): boolean {
  // 5.5.1 has no "link to nothing". A source keeps what was said of it; any other such link goes.
  if (node.value.trim() === VOID_POINTER) {
    if (node.tag !== 'SOUR') return false;
    const page = findChild(node, 'PAGE');
    setValue(node, page && page.value !== '' ? page.value : 'Source not named');
    if (page) node.children = node.children.filter((child) => child !== page);
    const data = findChild(node, 'DATA');
    if (data) {
      const texts = data.children.filter((child) => child.tag === 'TEXT');
      data.children = data.children.filter((child) => child.tag !== 'TEXT');
      node.children.push(...texts);
      if (data.children.length === 0)
        node.children = node.children.filter((child) => child !== data);
    }
  }

  if (node.tag === 'SNOTE') retag(node, 'NOTE');

  switch (node.tag) {
    case 'DATE': {
      const phrase = findChild(node, 'PHRASE');
      if (node.value.trim() === '') {
        if (phrase && phrase.value.trim() !== '') {
          setValue(node, toGedcomDate(`(${phrase.value.trim()})`, '5.5.1').value);
          removeChildren(node, 'PHRASE');
        }
      } else {
        setValue(node, toGedcomDate(node.value, '5.5.1').value);
      }
      break;
    }
    case 'PEDI':
    case 'RESN':
    case 'MEDI':
      enumToFive(node);
      break;
    case 'STAT':
      if (parent?.tag === 'FAMC') enumToFive(node);
      break;
    case 'TYPE':
      if (parent?.tag === 'NAME') enumToFive(node);
      break;
    case 'ROLE': {
      const phrase = childValue(node, 'PHRASE').trim();
      const stated = node.value.trim().toUpperCase();
      if (parent?.tag === 'ASSO') {
        // 5.5.1 gives the relation of an associated person in words.
        retag(node, 'RELA');
        setValue(node, phrase !== '' ? phrase : stated.toLowerCase());
        removeChildren(node, 'PHRASE');
      } else if (!FIVE_ROLE.has(stated) && stated !== '' && !stated.startsWith('(')) {
        setValue(node, `(${phrase !== '' ? phrase : stated.toLowerCase()})`);
        removeChildren(node, 'PHRASE');
      }
      break;
    }
    case 'FORM':
      if (parent?.tag === 'FILE' || parent?.tag === 'OBJE') {
        const stated = node.value.trim().toLowerCase();
        if (stated.includes('/')) {
          const known = MEDIA_TYPES.find(([, type]) => type === stated);
          setValue(node, known ? known[0] : stated.slice(stated.indexOf('/') + 1));
        }
        for (const child of node.children) {
          if (child.tag === 'MEDI') {
            retag(child, 'TYPE');
            enumToFive(child);
          }
        }
      }
      break;
    case 'LANG':
      if (parent?.tag === 'HEAD' || parent?.tag === 'SUBM') {
        const stated = node.value.trim().toLowerCase().split('-')[0] ?? '';
        const known = LANGUAGES.find(([, tag]) => tag === stated);
        if (known) setValue(node, known[0]);
      } else {
        // 5.5.1 only states a language for the whole file or for a submitter.
        retag(node, '_LANG');
      }
      break;
    default:
      break;
  }

  if (ONLY_IN_SEVEN.has(node.tag)) retag(node, `_${node.tag}`);
  return true;
}

function convertNode(
  node: GedcomNode,
  parent: GedcomNode | null,
  to: GedcomVersion,
  context: Context,
): boolean {
  const keep = to === '7.0' ? toSeven(node, parent, context) : toFive(node, parent);
  if (!keep) return false;
  const kept = node.children.filter((child) => convertNode(child, node, to, context));
  if (kept.length !== node.children.length) node.children = kept;
  return true;
}

/** A cross-reference id as GEDCOM 7.0 allows it: capitals, digits and underscores only. */
function sevenXref(xref: string): string {
  const cleaned = xref.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return cleaned === '' || cleaned === 'VOID' ? `X${cleaned}` : cleaned;
}

/** Renames cross-reference ids that GEDCOM 7.0 does not allow, in the records and in every pointer to them. */
function renameXrefs(records: readonly GedcomNode[]): void {
  const taken = new Set<string>();
  const renamed = new Map<string, string>();
  // Ids that are already valid keep their names, so they are claimed first.
  for (const record of records) {
    if (record.xref !== null && sevenXref(record.xref) === record.xref) taken.add(record.xref);
  }
  for (const record of records) {
    if (record.xref === null || taken.has(record.xref) || renamed.has(record.xref)) continue;
    const base = sevenXref(record.xref);
    let candidate = base;
    for (let copy = 2; taken.has(candidate); copy += 1) candidate = `${base}_${copy}`;
    taken.add(candidate);
    renamed.set(record.xref, candidate);
  }
  if (renamed.size === 0) return;

  const fix = (node: GedcomNode, top: boolean): void => {
    if (top && node.xref !== null) {
      const name = renamed.get(node.xref);
      if (name !== undefined) {
        node.xref = name;
        touch(node);
      }
    }
    const target = pointerTarget(node.value);
    const name = target === null ? undefined : renamed.get(target);
    if (name !== undefined) setValue(node, pointerTo(name));
    for (const child of node.children) fix(child, false);
  };
  for (const record of records) fix(record, true);
}

/**
 * Rewrites records in place in the grammar of the version `to`. The header is
 * not this function's business: the exporter writes a new one.
 */
export function convertVersion(records: GedcomNode[], to: GedcomVersion): ConvertResult {
  const result: ConvertResult = { unconverted: {} };
  if (to === '7.0') renameXrefs(records);
  for (const record of records) convertNode(record, null, to, { record, result });
  return result;
}
