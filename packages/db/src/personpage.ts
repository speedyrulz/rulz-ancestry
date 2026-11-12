import { listFamilyEvents, listPersonEvents, type TreeEvent } from './events';
import {
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  requireFamily,
} from './families';
import { getPerson, listNames, type Person, type PersonName } from './persons';
import { getPersonSummary, type PersonSummary } from './search';
import type { Tree } from './tree';

/** A family in which the person is a child. */
export interface ParentFamily {
  familyId: string;
  /** How the person is linked to these parents, e.g. "birth" or "adopted". */
  pedigree: string;
  /** The known parents, partner 1 first. None, one or two. */
  parents: PersonSummary[];
  /** The family's other children, in the order they were added. */
  siblings: PersonSummary[];
}

/** A family in which the person is a partner. */
export interface PartnerFamily {
  familyId: string;
  /** The other partner, or null when not known. */
  partner: PersonSummary | null;
  /** The couple's own events, such as their marriage. */
  events: TreeEvent[];
  children: { person: PersonSummary; pedigree: string }[];
}

/** Everything the person page shows, read in one go. */
export interface PersonPage {
  person: Person;
  summary: PersonSummary;
  names: PersonName[];
  /** The person's own events, in the order of a life story (see `sortEventsForDisplay`). */
  events: TreeEvent[];
  parentFamilies: ParentFamily[];
  partnerFamilies: PartnerFamily[];
}

const FIRST_IN_LIFE = new Set(['birth']);
const LAST_IN_LIFE = new Set(['death', 'burial', 'cremation', 'will', 'probate']);

/**
 * Orders events as a life story: dated events by date, a birth with no date
 * first, a death or burial with no date last, and other undated events after
 * the dated ones. Events that tie keep the order they were entered in.
 */
export function sortEventsForDisplay(events: readonly TreeEvent[]): TreeEvent[] {
  const key = (event: TreeEvent): [number, number] => {
    const day = event.dateMinJdn ?? event.dateMaxJdn;
    if (day !== null) return [1, day];
    if (FIRST_IN_LIFE.has(event.type)) return [0, 0];
    return [LAST_IN_LIFE.has(event.type) ? 3 : 2, 0];
  };
  return events
    .map((event, index) => ({ event, index, key: key(event) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
    .map((entry) => entry.event);
}

function summaries(tree: Tree, ids: readonly (string | null)[]): PersonSummary[] {
  return ids
    .map((id) => (id === null ? null : getPersonSummary(tree, id)))
    .filter((summary): summary is PersonSummary => summary !== null);
}

/** Reads a person with their names, events, parents, partners and children. */
export function getPersonPage(tree: Tree, id: string): PersonPage | null {
  const person = getPerson(tree, id);
  const summary = getPersonSummary(tree, id);
  if (!person || !summary) return null;

  // One consistent picture, even though it takes many small reads.
  return tree.db.transaction((): PersonPage => {
    const parentFamilies = listFamiliesAsChild(tree, id).map((link): ParentFamily => {
      const family = requireFamily(tree, link.familyId);
      return {
        familyId: family.id,
        pedigree: link.pedigree,
        parents: summaries(tree, [family.partner1Id, family.partner2Id]),
        siblings: summaries(
          tree,
          listChildren(tree, family.id)
            .map((child) => child.childId)
            .filter((childId) => childId !== id),
        ),
      };
    });

    const partnerFamilies = listFamiliesAsPartner(tree, id).map((family): PartnerFamily => {
      const partnerId = family.partner1Id === id ? family.partner2Id : family.partner1Id;
      const children = listChildren(tree, family.id).flatMap((child) => {
        const childSummary = getPersonSummary(tree, child.childId);
        return childSummary ? [{ person: childSummary, pedigree: child.pedigree }] : [];
      });
      return {
        familyId: family.id,
        partner: partnerId === null ? null : getPersonSummary(tree, partnerId),
        events: sortEventsForDisplay(listFamilyEvents(tree, family.id)),
        children,
      };
    });

    return {
      person,
      summary,
      names: listNames(tree, id),
      events: sortEventsForDisplay(listPersonEvents(tree, id)),
      parentFamilies,
      partnerFamilies,
    };
  })();
}
