import { parseDate, type ParsedDate } from './date';
import { normalizeName } from './match';
import { partOf } from './recordmatch';
import type { ExternalRecord } from './records';

/**
 * A result of a search for records set beside the person of the tree: what
 * the record says of the person's own birth, baptism, death or burial, and
 * how each date and place stands to what the tree has.
 *
 * Nothing here decides anything. It says how two values stand to each other,
 * and which of them the user may choose to take over. A value of the tree is
 * never offered to be replaced by one that says less.
 */

/** The events of a person that a record can say something of, and that can be taken over. */
export const TAKE_TYPES = ['birth', 'baptism', 'death', 'burial'] as const;
export type TakeType = (typeof TAKE_TYPES)[number];

/** What a record says of one event of the person. An empty text is not said. */
export interface RecordFact {
  type: TakeType;
  /** In the wording of a GEDCOM file; empty when not given, or when the app cannot read it as a date. */
  date: string;
  place: string;
}

const BAPTISM_WORDS = ['baptism', 'christening', 'doop'];
const BURIAL_WORDS = ['burial', 'begraven', 'begrafenis'];

/** A date as the app reads it; null when the text is empty or no date the app can place in time. */
function read(date: string): ParsedDate | null {
  const parsed = date.trim() === '' ? null : parseDate(date);
  return parsed === null || (parsed.minJdn === null && parsed.maxJdn === null) ? null : parsed;
}

/**
 * What a record says of the person's own events. A profile says of a birth
 * and a death. A record of an event says of one, and only when the person is
 * the one who was born, baptized, buried or who died: of a bride, a parent
 * or a witness it says none of these, and nothing is taken from it.
 */
export function recordFacts(record: ExternalRecord): RecordFact[] {
  const fact = (type: TakeType, date: string, place: string): RecordFact[] => {
    const said = { type, date: read(date) === null ? '' : date.trim(), place: place.trim() };
    return said.date === '' && said.place === '' ? [] : [said];
  };
  if (record.kind === 'person') {
    return (['birth', 'death'] as const).flatMap((type) => {
      // The first of its kind, as the score reads it.
      const first = record.facts.find((entry) => entry.type === type);
      return first === undefined ? [] : fact(type, first.date, first.place);
    });
  }
  if (record.kind !== 'event') return [];
  const part = partOf(record);
  const event = normalizeName(record.event);
  const is = (words: readonly string[]) => words.some((word) => event.includes(word));
  if (part === 'born')
    return fact(is(BAPTISM_WORDS) ? 'baptism' : 'birth', record.date, record.place);
  if (part === 'died')
    return fact(is(BURIAL_WORDS) ? 'burial' : 'death', record.date, record.place);
  return [];
}

/**
 * True when what a record says of an event of this type can be set beside an
 * event of the tree of that type. A file from another program often keeps a
 * baptism as a christening; the two are one rite, and a record of a baptism
 * is set beside either, so that no second event is made for it.
 */
export function isEventOf(type: TakeType, eventType: string): boolean {
  return eventType === type || (type === 'baptism' && eventType === 'christening');
}

/**
 * How a date of a record stands to the date of the tree:
 * - "same": both can mean the same days, and are as sure of them;
 * - "more-exact": the record's days lie within the tree's, or the tree says "about" and the record does not;
 * - "closer-about": the record's days lie within the tree's, but the record says "about" and the tree does not;
 * - "less-exact": the tree's days lie within the record's, or the record says "about" and the tree does not;
 * - "overlaps": some days of the one are days of the other, and neither lies within the other;
 * - "differs": no day of the one is a day of the other;
 * - "unreadable": the tree has words the app cannot read as a date;
 * - "record-only", "tree-only", "neither": who says anything at all.
 */
export type DateRelation =
  | 'same'
  | 'more-exact'
  | 'closer-about'
  | 'less-exact'
  | 'overlaps'
  | 'differs'
  | 'unreadable'
  | 'record-only'
  | 'tree-only'
  | 'neither';

const LOOSE = new Set(['about', 'calculated', 'estimated']);

export function relateDates(tree: string, record: string): DateRelation {
  const ofRecord = read(record);
  if (tree.trim() === '') return ofRecord === null ? 'neither' : 'record-only';
  if (ofRecord === null) return 'tree-only';
  const ofTree = read(tree);
  if (ofTree === null) return 'unreadable';
  const first = (date: ParsedDate) => date.minJdn ?? -Infinity;
  const last = (date: ParsedDate) => date.maxJdn ?? Infinity;
  const [treeLoose, recordLoose] = [LOOSE.has(ofTree.qualifier), LOOSE.has(ofRecord.qualifier)];
  if (first(ofTree) === first(ofRecord) && last(ofTree) === last(ofRecord)) {
    return treeLoose === recordLoose ? 'same' : treeLoose ? 'more-exact' : 'less-exact';
  }
  if (first(ofRecord) >= first(ofTree) && last(ofRecord) <= last(ofTree)) {
    // "About 12 March 1850" names closer days than "1850", and is less sure of them.
    return recordLoose && !treeLoose ? 'closer-about' : 'more-exact';
  }
  if (first(ofTree) >= first(ofRecord) && last(ofTree) <= last(ofRecord)) return 'less-exact';
  return first(ofRecord) <= last(ofTree) && first(ofTree) <= last(ofRecord)
    ? 'overlaps'
    : 'differs';
}

/**
 * How a place of a record stands to the place of the tree. A place is read
 * by its parts, which commas divide; the words alone do not tell one town
 * from another of the same name, so nothing is said of that.
 * - "same": the same parts;
 * - "fuller": every part of the tree's place is a part of the record's, which says more;
 * - "shorter": every part of the record's place is a part of the tree's, which says more;
 * - "alike": the two begin alike and the rest is written differently
 *   ("Ashford, VT" and "Ashford, Vermont", and also two towns of one name);
 * - "alike-less": as "alike", and the record's place is the shorter of the two;
 * - "differs": they do not begin alike, and neither holds the other;
 * - "record-only", "tree-only", "neither": who says anything at all.
 */
export type PlaceRelation =
  | 'same'
  | 'fuller'
  | 'shorter'
  | 'alike'
  | 'alike-less'
  | 'differs'
  | 'record-only'
  | 'tree-only'
  | 'neither';

/** The parts of a place as it is written, without those that say nothing. */
function partsOf(place: string): string[] {
  return place
    .split(',')
    .map((part) => normalizeName(part))
    .filter((part) => part !== '');
}

/**
 * True when one place says nothing the other does not: each of its parts is
 * a part of the other, or it is the first parts of the other written without
 * commas ("Ashford Vermont" within "Ashford, Vermont, USA").
 */
function within(parts: readonly string[], others: readonly string[]): boolean {
  if (parts.every((part) => others.includes(part))) return true;
  const whole = parts.join(' ');
  return others.some((_, index) => others.slice(0, index + 1).join(' ') === whole);
}

export function relatePlaces(tree: string, record: string): PlaceRelation {
  const [treeParts, recordParts] = [partsOf(tree), partsOf(record)];
  if (treeParts.length === 0) return recordParts.length === 0 ? 'neither' : 'record-only';
  if (recordParts.length === 0) return 'tree-only';
  const [ofTree, ofRecord] = [treeParts.join(' '), recordParts.join(' ')];
  const [treeWithin, recordWithin] = [
    within(treeParts, recordParts),
    within(recordParts, treeParts),
  ];
  if (ofTree === ofRecord || (treeWithin && recordWithin)) return 'same';
  if (treeWithin) return 'fuller';
  if (recordWithin) return 'shorter';
  const alike =
    treeParts[0] === recordParts[0] ||
    ofRecord.startsWith(`${ofTree} `) ||
    ofTree.startsWith(`${ofRecord} `);
  if (!alike) return 'differs';
  const words = (text: string) => text.split(' ').length;
  return words(ofRecord) < words(ofTree) ? 'alike-less' : 'alike';
}

/**
 * True when the record's date may be taken over: the tree has none, or the
 * record's says more or something else. Where the two agree as far as each
 * goes, the one that says less is never offered.
 */
export function canTakeDate(relation: DateRelation): boolean {
  return (
    relation === 'record-only' ||
    relation === 'more-exact' ||
    relation === 'closer-about' ||
    relation === 'overlaps' ||
    relation === 'differs' ||
    relation === 'unreadable'
  );
}

/** True when the record's place may be taken over. A shorter place is never offered in place of a longer one that begins alike. */
export function canTakePlace(relation: PlaceRelation): boolean {
  return (
    relation === 'record-only' ||
    relation === 'fuller' ||
    relation === 'alike' ||
    relation === 'differs'
  );
}

/**
 * True when record and tree say the same of a date or a place, as far as
 * each goes.
 */
export function agrees(relation: DateRelation | PlaceRelation): boolean {
  return (
    relation === 'same' ||
    relation === 'more-exact' ||
    relation === 'closer-about' ||
    relation === 'less-exact' ||
    relation === 'fuller' ||
    relation === 'shorter'
  );
}

/** True when record and tree cannot both be right of a date or a place as they stand. */
export function conflicts(relation: DateRelation | PlaceRelation): boolean {
  return relation === 'differs';
}

/**
 * True when a record can be cited for an event of the tree with nothing
 * taken over: it agrees with the event's date or its place, and says nothing
 * against the other.
 */
export function canCiteFor(date: DateRelation, place: PlaceRelation): boolean {
  return (agrees(date) || agrees(place)) && !conflicts(date) && !conflicts(place);
}
