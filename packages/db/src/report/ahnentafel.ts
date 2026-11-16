import {
  ordinal,
  shownPerson,
  personLabel,
  personSpan,
  slotGeneration,
  type AncestorSlot,
  type Block,
  type Inline,
  type KeyValueRow,
  type ReportDocument,
  type ReportSection,
} from '@rulz/core';
import { getAncestorSlots, getParentFamilyId } from '../charts';
import { listFamilyEvents, listPersonEvents, type TreeEvent } from '../events';
import { listFamiliesAsPartner } from '../families';
import { sortEventsForDisplay } from '../personpage';
import { getPersonSummary } from '../search';
import { NotFoundError, type Tree } from '../tree';
import { requireGenerations } from './chart';
import { metadataOf, plural, type ReportBuild } from './familygroup';
import { ReportFilter, ReportRefusedError, type ReportPrivacy } from './filter';

/**
 * The Ahnentafel: one person's ancestors as a numbered list. The person is 1;
 * the first parent recorded of person n is 2n (the father, where the parents
 * are recorded as father and mother) and the second is 2n + 1. The list is
 * grouped by generation.
 *
 * Someone who is an ancestor by more than one line (pedigree collapse) is
 * written out once, at the lowest number. Each later number only says "see"
 * and that number, and the ancestors of the later number are not repeated:
 * they are the ancestors of the lowest one.
 *
 * Every person is read through the {@link ReportFilter}. A person it hides is
 * a row that says "Living" and nothing more is read about them, and a marriage
 * is said only when neither partner is hidden.
 */

const BIRTH = ['birth'];
const CHRISTENING = ['baptism', 'christening'];
const DEATH = ['death'];
const BURIAL = ['burial', 'cremation'];
const MARRIAGE = ['marriage'];

/** What the generation of ancestors is called: "Parents", "Grandparents", "2nd great-grandparents". */
function generationName(generation: number): string {
  if (generation === 1) return 'The person';
  if (generation === 2) return 'Parents';
  if (generation === 3) return 'Grandparents';
  if (generation === 4) return 'Great-grandparents';
  return `${ordinal(generation - 3)} great-grandparents`;
}

/** The date and place of an event as one piece of text, or a note that neither is recorded. */
function whenAndWhere(event: TreeEvent): string {
  const text = [event.dateText, event.placeText].filter((part) => part !== '').join(', ');
  return text === '' ? 'Date and place not recorded' : text;
}

/**
 * The first event of the given types as "date, place", or, when there is none,
 * the first of the fallback types ("chr." for a christening, "bur." for a burial).
 */
function lifeEvent(
  events: readonly TreeEvent[],
  types: readonly string[],
  fallbackTypes: readonly string[],
  fallbackLabel: string,
): Inline {
  const main = events.find((event) => types.includes(event.type));
  if (main !== undefined) return [whenAndWhere(main)];
  const other = events.find((event) => fallbackTypes.includes(event.type));
  return other === undefined ? [] : [`${fallbackLabel} ${whenAndWhere(other)}`];
}

/** One line of the list, before it is turned into a table row. */
interface Entry {
  slot: number;
  personId: string;
  /** The lowest number this person has, when it is not this one. */
  seeSlot: number | null;
}

/** The table rows of one generation. */
function rowOf(
  tree: Tree,
  filter: ReportFilter,
  entry: Entry,
  marriage: (entry: Entry) => Inline,
): Inline[] {
  const number: Inline = [String(entry.slot)];
  // The years are in the columns beside the name, so the name is not given them twice.
  const shown = filter.person(tree, entry.personId);
  const person = personSpan(shown.living ? shown : shownPerson(shown.name));
  if (entry.seeSlot !== null) {
    return [number, [person, `, see ${entry.seeSlot}`], [], [], []];
  }
  if (filter.hides(entry.personId)) return [number, [person], [], [], []];
  const events = sortEventsForDisplay(listPersonEvents(tree, entry.personId));
  return [
    number,
    [person],
    lifeEvent(events, BIRTH, CHRISTENING, 'chr.'),
    lifeEvent(events, DEATH, BURIAL, 'bur.'),
    marriage(entry),
  ];
}

/** "date, place (to 7)" for each marriage of the couple, joined by line breaks. */
function marriageLines(tree: Tree, familyId: string, toNumber: number): Inline {
  const events = sortEventsForDisplay(listFamilyEvents(tree, familyId)).filter((event) =>
    MARRIAGE.includes(event.type),
  );
  return events.flatMap((event, index) => [
    ...(index === 0 ? [] : ['\n']),
    `${whenAndWhere(event)} (to ${toNumber})`,
  ]);
}

/**
 * Builds the Ahnentafel of one person. Throws a {@link ReportRefusedError}
 * when the filter is on and the person is living, since nothing of the
 * person or of their line could then be shown.
 */
export function buildAhnentafel(
  tree: Tree,
  personId: string,
  generations: number,
  privacy: ReportPrivacy,
): ReportBuild {
  requireGenerations('ahnentafel', generations);
  if (getPersonSummary(tree, personId) === null) throw new NotFoundError('person', personId);
  const filter = new ReportFilter(privacy);
  if (filter.hides(personId)) {
    throw new ReportRefusedError(
      'This Ahnentafel is of someone who may be living, so nothing about them can be shown. ' +
        'Include living people to make it.',
    );
  }

  // One consistent picture, even though it takes many small reads.
  return tree.db.transaction((): ReportBuild => {
    const slots: AncestorSlot[] = getAncestorSlots(tree, personId, generations - 1).sort(
      (a, b) => a.slot - b.slot,
    );
    const bySlot = new Map(slots.map((slot) => [slot.slot, slot]));

    // The lowest number of each person. Whoever comes from a repeated person is left to that person's line.
    const lowest = new Map<string, number>();
    const entries: Entry[] = [];
    const skipped = new Set<number>();
    for (const slot of slots) {
      if (slot.slot > 1 && skipped.has(Math.floor(slot.slot / 2))) {
        skipped.add(slot.slot);
        continue;
      }
      // A hidden person is never recognised as a repeat: each of their numbers is its own row
      // that says only "Living", and their ancestors are written out under each. A "see" or a
      // gap in the numbers would tell the reader that two "Living" rows are one person. Their
      // ancestors are dead and shown as their own status says, and repeat as any others do.
      if (filter.hides(slot.personId)) {
        entries.push({ slot: slot.slot, personId: slot.personId, seeSlot: null });
        continue;
      }
      const first = lowest.get(slot.personId);
      if (first === undefined) {
        lowest.set(slot.personId, slot.slot);
        entries.push({ slot: slot.slot, personId: slot.personId, seeSlot: null });
      } else {
        skipped.add(slot.slot);
        entries.push({ slot: slot.slot, personId: slot.personId, seeSlot: first });
      }
    }
    const repeated = entries.filter((entry) => entry.seeSlot !== null).length;

    // A couple's marriage goes on both partners' rows, when both are listed and neither is hidden.
    const familyOf = new Map<number, string | null>();
    const marriage = (entry: Entry): Inline => {
      if (entry.slot === 1) return rootMarriages(tree, filter, personId);
      const partner = bySlot.get(entry.slot ^ 1);
      const child = bySlot.get(Math.floor(entry.slot / 2));
      if (partner === undefined || child === undefined) return [];
      if (filter.hides(entry.personId) || filter.hides(partner.personId)) return [];
      let familyId = familyOf.get(child.slot);
      if (familyId === undefined) {
        familyId = getParentFamilyId(tree, child.personId);
        familyOf.set(child.slot, familyId);
      }
      if (familyId === null) return [];
      return marriageLines(tree, familyId, lowest.get(partner.personId) ?? partner.slot);
    };

    const byGeneration = new Map<number, Entry[]>();
    for (const entry of entries) {
      const generation = slotGeneration(entry.slot) + 1;
      byGeneration.set(generation, [...(byGeneration.get(generation) ?? []), entry]);
    }

    const about: Block[] = [
      {
        kind: 'paragraph',
        content: [
          'The person is number 1. The first parent recorded of person n is number 2n and the second is 2n + 1, ' +
            'so the father is 2n and the mother 2n + 1 where the parents are recorded in that order.',
        ],
      },
    ];
    if (repeated > 0) {
      about.push({
        kind: 'paragraph',
        content: [
          'Someone who is an ancestor by more than one line is written out once, at the lowest number. ' +
            'The other numbers say "see" and that number, and their ancestors are not repeated.',
        ],
      });
    }
    const sections: ReportSection[] = [{ title: 'About the numbers', blocks: about }];
    for (const [generation, list] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
      const name = generationName(generation);
      sections.push({
        title: `Generation ${generation}: ${name}`,
        blocks: [
          {
            kind: 'table',
            caption: '',
            head: ['No.', 'Name', 'Born', 'Died', 'Married'],
            rows: list.map((entry) => rowOf(tree, filter, entry, marriage)),
          },
        ],
      });
    }
    if (byGeneration.size === 1) {
      sections.push({
        title: 'Ancestors',
        blocks: [{ kind: 'paragraph', content: ['No parents are recorded for this person.'] }],
      });
    }

    // One person can have several numbers, so the rows that say "Living" are counted, not people.
    for (const entry of entries) filter.countLivingPlace(entry.personId);
    const omissions = { ...filter.omissions(), livingOmitted: filter.livingPlaces };
    const who = personLabel(filter.person(tree, personId));
    const rows: KeyValueRow[] = [
      {
        label: 'Generations',
        value: [
          `${generations}: the person and ${generations - 1} generation${generations === 2 ? '' : 's'} of ancestors.`,
        ],
      },
      {
        label: 'People listed',
        value: [
          `${plural(entries.length - repeated, 'person', 'people')}${repeated > 0 ? `, and ${plural(repeated, 'number that refers', 'numbers that refer')} to someone listed above` : ''}.`,
        ],
      },
      ...metadataOf(filter.includeLiving, omissions, 'entries'),
    ];
    const model: ReportDocument = {
      title: `Ahnentafel: ${who}`,
      metadata: rows,
      sections,
    };
    return { model, ...omissions };
  })();
}

/**
 * The person's own marriages: the partner, and where and when. A hidden
 * partner is only "Living", and the marriage is left out with them.
 */
function rootMarriages(tree: Tree, filter: ReportFilter, personId: string): Inline {
  const lines: Inline[] = [];
  for (const family of listFamiliesAsPartner(tree, personId)) {
    const otherId = family.partner1Id === personId ? family.partner2Id : family.partner1Id;
    if (otherId === null) continue;
    if (filter.hides(otherId)) {
      lines.push([personSpan(filter.person(tree, otherId))]);
      filter.countLivingPlace(otherId);
      continue;
    }
    const events = sortEventsForDisplay(listFamilyEvents(tree, family.id)).filter((event) =>
      MARRIAGE.includes(event.type),
    );
    const partner = personSpan(filter.person(tree, otherId));
    if (events.length === 0) {
      lines.push([partner]);
      continue;
    }
    for (const event of events) lines.push([partner, `: ${whenAndWhere(event)}`]);
  }
  return lines.flatMap((line, index) => (index === 0 ? line : ['\n', ...line]));
}
