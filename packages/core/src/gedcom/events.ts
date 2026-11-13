import { toGedcomDate } from '../date';
import {
  childValue,
  cloneNode,
  findChild,
  insertInOrder,
  makeNode,
  setChildValue,
  touch,
  type GedcomNode,
  type GedcomVersion,
} from './node';
import { readOwnNote, setOwnNote } from './notes';

/**
 * Events and attributes: reading one from a GEDCOM structure such as BIRT or
 * OCCU, and writing one back with as little change to the original lines as
 * possible.
 */

export type EventOwner = 'person' | 'family';

/** An event as the app stores it. */
export interface EventFields {
  /** For example "birth". Lower case. */
  type: string;
  /** The date as written; empty when there is none. */
  date: string;
  place: string;
  description: string;
  /** The user's own remark on the event. May have several lines. */
  note: string;
}

interface TagDef {
  tag: string;
  type: string;
  /**
   * True when the line's own value is free text, as in `1 OCCU Farmer`. False
   * for events, where the standard allows only `Y` there ("this happened").
   */
  text: boolean;
}

const event = (tag: string, type: string): TagDef => ({ tag, type, text: false });
const attribute = (tag: string, type: string): TagDef => ({ tag, type, text: true });

/** The standard tags of a person's events and attributes, GEDCOM 5.5.1 and 7.0 alike. */
const PERSON_TAGS: readonly TagDef[] = [
  event('BIRT', 'birth'),
  event('CHR', 'christening'),
  event('BAPM', 'baptism'),
  event('DEAT', 'death'),
  event('BURI', 'burial'),
  event('CREM', 'cremation'),
  event('ADOP', 'adoption'),
  event('BARM', 'bar mitzvah'),
  event('BASM', 'bas mitzvah'),
  event('BLES', 'blessing'),
  event('CHRA', 'adult christening'),
  event('CONF', 'confirmation'),
  event('FCOM', 'first communion'),
  event('ORDN', 'ordination'),
  event('NATU', 'naturalization'),
  event('EMIG', 'emigration'),
  event('IMMI', 'immigration'),
  event('CENS', 'census'),
  event('PROB', 'probate'),
  event('WILL', 'will'),
  event('GRAD', 'graduation'),
  event('RETI', 'retirement'),
  attribute('RESI', 'residence'),
  attribute('OCCU', 'occupation'),
  attribute('EDUC', 'education'),
  attribute('RELI', 'religion'),
  attribute('NATI', 'nationality'),
  attribute('TITL', 'title'),
  attribute('CAST', 'caste'),
  attribute('DSCR', 'physical description'),
  attribute('IDNO', 'id number'),
  attribute('SSN', 'social security number'),
  attribute('PROP', 'property'),
  attribute('NCHI', 'number of children'),
  attribute('NMR', 'number of marriages'),
];

/** The standard tags of a couple's events and attributes. */
const FAMILY_TAGS: readonly TagDef[] = [
  event('MARR', 'marriage'),
  event('ENGA', 'engagement'),
  event('DIV', 'divorce'),
  event('ANUL', 'annulment'),
  event('MARB', 'marriage banns'),
  event('MARC', 'marriage contract'),
  event('MARL', 'marriage license'),
  event('MARS', 'marriage settlement'),
  event('DIVF', 'divorce filing'),
  event('CENS', 'census'),
  attribute('RESI', 'residence'),
  attribute('NCHI', 'number of children'),
];

/**
 * Tags that Ancestry, Family Tree Maker and others add for events the standard
 * has no tag for. They are read as events; the app itself writes such an event
 * the standard way, as `EVEN` with a `TYPE` line.
 */
const PERSON_VENDOR_TAGS: readonly TagDef[] = [
  attribute('_MILT', 'military'),
  attribute('_MILI', 'military'),
  attribute('_DEG', 'degree'),
  attribute('_FUN', 'funeral'),
  attribute('_MDCL', 'medical'),
  attribute('_ELEC', 'election'),
  attribute('_EXCM', 'excommunication'),
  attribute('_HEIG', 'height'),
  attribute('_WEIG', 'weight'),
  attribute('_ORIG', 'origin'),
  attribute('_DEST', 'destination'),
  attribute('_EMPLOY', 'employment'),
  attribute('_MISN', 'mission'),
  attribute('_NAMS', 'namesake'),
  attribute('_CIRC', 'circumcision'),
];
const FAMILY_VENDOR_TAGS: readonly TagDef[] = [attribute('_SEPR', 'separation')];

function byTag(defs: readonly TagDef[]): Map<string, TagDef> {
  return new Map(defs.map((def) => [def.tag, def]));
}

function byType(defs: readonly TagDef[]): Map<string, TagDef> {
  const map = new Map<string, TagDef>();
  for (const def of defs) if (!map.has(def.type)) map.set(def.type, def);
  return map;
}

const READ: Readonly<Record<EventOwner, Map<string, TagDef>>> = {
  person: byTag([...PERSON_TAGS, ...PERSON_VENDOR_TAGS]),
  family: byTag([...FAMILY_TAGS, ...FAMILY_VENDOR_TAGS]),
};
const WRITE: Readonly<Record<EventOwner, Map<string, TagDef>>> = {
  person: byType(PERSON_TAGS),
  family: byType(FAMILY_TAGS),
};

/** The tags whose event type is given by a TYPE line under them. */
function isGeneric(tag: string): boolean {
  return tag === 'EVEN' || tag === 'FACT';
}

/** True when a line under a person or family record is an event or attribute the app reads. */
export function isEventTag(tag: string, owner: EventOwner): boolean {
  return isGeneric(tag) || READ[owner].has(tag);
}

/** True when the tag is an event in the strict sense: its own value may only be `Y`. */
function isFlagTag(tag: string, owner: EventOwner): boolean {
  const def = READ[owner].get(tag);
  return def !== undefined && !def.text;
}

/** The usual order of the first lines under an event. */
const EVENT_ORDER = ['TYPE', 'DATE', 'PLAC'] as const;

/** The longest text the app's forms accept. */
const TYPE_MAX = 60;
const DATE_MAX = 200;
const PLACE_MAX = 500;

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** Reads an event or attribute structure. Returns null for a tag that is neither. */
export function readEvent(node: GedcomNode, owner: EventOwner): EventFields | null {
  const def = READ[owner].get(node.tag);
  const generic = isGeneric(node.tag);
  if (!def && !generic) return null;

  let type: string;
  if (generic) {
    const stated = oneLine(childValue(node, 'TYPE'), TYPE_MAX).toLowerCase();
    type = stated !== '' ? stated : node.tag === 'EVEN' ? 'event' : 'fact';
  } else {
    type = def?.type ?? '';
  }

  const dateNode = findChild(node, 'DATE');
  let date = dateNode ? oneLine(dateNode.value, DATE_MAX) : '';
  // GEDCOM 7.0 writes a date it cannot express as an empty DATE with a PHRASE.
  if (dateNode && date === '') date = oneLine(childValue(dateNode, 'PHRASE'), DATE_MAX);

  const value = node.value.trim();
  const flagOnly = !generic && def !== undefined && !def.text && /^y(?:es)?$/i.test(value);

  return {
    type,
    date,
    place: oneLine(childValue(node, 'PLAC'), PLACE_MAX),
    description: flagOnly ? '' : value,
    note: readOwnNote(node),
  };
}

/** "military service" as the text of a TYPE line: "Military service". */
function typeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function setDate(node: GedcomNode, text: string, version: GedcomVersion): void {
  if (text === '') {
    node.children = node.children.filter((child) => child.tag !== 'DATE');
    return;
  }
  const written = toGedcomDate(text, version);
  let date = findChild(node, 'DATE');
  if (!date) {
    date = makeNode('DATE', written.value);
    insertInOrder(node, date, EVENT_ORDER);
  } else if (date.value !== written.value) {
    date.value = written.value;
    touch(date);
  }
  // A phrase belonged to the date as it was; the new date brings its own, if any.
  date.children = date.children.filter((child) => child.tag !== 'PHRASE');
  if (written.phrase !== null) date.children.unshift(makeNode('PHRASE', written.phrase));
}

/**
 * GEDCOM 7.0 allows no text on the line of an event such as BIRT, only `Y`.
 * Text found there is moved to a note under the event, so the file stays valid
 * and nothing is lost.
 */
export function conformEvent(node: GedcomNode, owner: EventOwner, version: GedcomVersion): void {
  if (version !== '7.0' || !isFlagTag(node.tag, owner)) return;
  const value = node.value.trim();
  if (value === '' || /^y$/i.test(value)) return;
  node.children.push(makeNode('NOTE', node.value));
  node.value = '';
  touch(node);
}

/**
 * The structure for an event. With no `original` it is written afresh. With
 * the structure the event was imported from, only the lines whose part of the
 * event has changed since are rewritten; the rest, and everything the app does
 * not model (sources, further notes, age, cause and so on), stay as they were.
 */
export function patchEvent(
  original: GedcomNode | null,
  fields: EventFields,
  owner: EventOwner,
  version: GedcomVersion,
): GedcomNode {
  const was = original ? readEvent(original, owner) : null;
  const standard = WRITE[owner].get(fields.type);
  const node = original ? cloneNode(original) : makeNode(standard ? standard.tag : 'EVEN');
  let changed = was === null;

  if (was === null || was.type !== fields.type) {
    changed = true;
    if (standard) {
      if (node.tag !== standard.tag) {
        // The TYPE line of a generic event named its type; a standard tag does that itself.
        if (isGeneric(node.tag)) {
          node.children = node.children.filter((child) => child.tag !== 'TYPE');
        }
        node.tag = standard.tag;
        touch(node);
      }
    } else {
      if (!isGeneric(node.tag)) {
        node.tag = 'EVEN';
        touch(node);
      }
      setChildValue(node, 'TYPE', typeLabel(fields.type), EVENT_ORDER);
    }
  }

  if (was === null || was.description !== fields.description) {
    changed = true;
    let value = fields.description;
    const bare = fields.date === '' && fields.place === '' && node.children.length === 0;
    // An event with nothing known about it still says that it happened.
    if (value === '' && bare && isFlagTag(node.tag, owner)) value = 'Y';
    if (node.value !== value) {
      node.value = value;
      touch(node);
    }
  }

  if (was === null || was.date !== fields.date) {
    changed = true;
    setDate(node, fields.date, version);
  }
  if (was === null || was.place !== fields.place) {
    changed = true;
    setChildValue(node, 'PLAC', fields.place, EVENT_ORDER);
  }
  if (was === null || was.note !== fields.note) {
    changed = true;
    setOwnNote(node, fields.note);
  }

  if (changed) conformEvent(node, owner, version);
  return node;
}
