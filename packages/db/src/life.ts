import { ageRange, type AgeRange } from '@rulz/core';
import { listFamilyEvents, listPersonEvents, type TreeEvent } from './events';
import {
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  requireFamily,
} from './families';
import { sortEventsForDisplay } from './personpage';
import { getPerson } from './persons';
import { getPlaceLink, type PlaceLink } from './places';
import { getPersonSummary, type PersonSummary } from './search';
import type { Tree } from './tree';

/** How someone is related to the person a life is told of. */
export type LifeRelation = 'parent' | 'partner' | 'child' | 'sibling';

/** One line of a life: something that happened to the person, or close to them. */
export interface LifeEntry {
  /**
   * `own`: an event of the person. `family`: an event of a couple the person
   * is one of, such as their marriage. `relative`: the birth or the death of
   * someone close, within the person's lifetime.
   */
  kind: 'own' | 'family' | 'relative';
  event: TreeEvent;
  /** `partner` for a couple's event, the relative's relation for theirs, null for the person's own. */
  relation: LifeRelation | null;
  /** The other partner of a couple's event when known, or the relative. Null for the person's own. */
  person: PersonSummary | null;
  /** Where the event's place lies, when its text is linked. */
  place: PlaceLink | null;
  /** How old the person was. Null when it cannot be told, and for their own birth. */
  age: AgeRange | null;
}

/** A person's life in order, for the timeline and the map. */
export interface PersonLife {
  entries: LifeEntry[];
}

const day = (event: TreeEvent): number | null => event.dateMinJdn ?? event.dateMaxJdn;

/** The first event of a type that has a date, as the person's summary picks its birth and death. */
function firstDated(events: readonly TreeEvent[], type: string): TreeEvent | null {
  return events.find((event) => event.type === type && day(event) !== null) ?? null;
}

/**
 * Reads a person's life: their own events, the events of the couples they are
 * one of, and what happened close to them while they lived: the births of
 * their brothers, sisters and children, and the deaths of their parents,
 * partners, brothers, sisters and children. An event of a relative counts
 * only when it has a date, and that date can lie within the person's life:
 * not wholly before the first day their birth can mean, nor wholly after the
 * last day their death can mean, where those are known. Null for someone who is
 * not in the tree.
 */
export function getPersonLife(tree: Tree, id: string): PersonLife | null {
  if (!getPerson(tree, id)) return null;

  return tree.db.transaction((): PersonLife => {
    const own = listPersonEvents(tree, id);
    const birth = firstDated(own, 'birth');
    const death = firstDated(own, 'death');
    // The life runs from the first day the birth can mean to the last day the death
    // can mean. "Before 1900" has no first day, so it leaves that side open.
    const from = birth?.dateMinJdn ?? null;
    const until = death?.dateMaxJdn ?? null;

    const links = new Map<string, PlaceLink | null>();
    const placeOf = (text: string): PlaceLink | null => {
      if (text.trim() === '') return null;
      const key = text.trim().toLowerCase();
      if (!links.has(key)) links.set(key, getPlaceLink(tree, text));
      return links.get(key) ?? null;
    };

    const entries = new Map<string, LifeEntry>();
    const add = (
      kind: LifeEntry['kind'],
      event: TreeEvent,
      relation: LifeRelation | null,
      person: PersonSummary | null,
    ): void => {
      if (entries.has(event.id)) return;
      const age =
        birth === null || event.id === birth.id
          ? null
          : ageRange(
              { minJdn: birth.dateMinJdn, maxJdn: birth.dateMaxJdn },
              { minJdn: event.dateMinJdn, maxJdn: event.dateMaxJdn },
            );
      entries.set(event.id, {
        kind,
        event,
        relation,
        person,
        place: placeOf(event.placeText),
        age,
      });
    };

    // An event counts unless its date rules it out: its last possible day lies before
    // the life, or its first after it.
    const inLifetime = (event: TreeEvent): boolean => {
      if (day(event) === null) return false;
      const startsInTime = until === null || event.dateMinJdn === null || event.dateMinJdn <= until;
      const endsInTime = from === null || event.dateMaxJdn === null || event.dateMaxJdn >= from;
      return startsInTime && endsInTime;
    };
    const seen = new Set<string>([id]);
    const addRelative = (
      relativeId: string | null,
      relation: LifeRelation,
      types: readonly string[],
    ): void => {
      if (relativeId === null || seen.has(relativeId)) return;
      seen.add(relativeId);
      const summary = getPersonSummary(tree, relativeId);
      if (!summary) return;
      const events = listPersonEvents(tree, relativeId);
      for (const type of types) {
        const event = firstDated(events, type);
        if (event && inLifetime(event)) add('relative', event, relation, summary);
      }
    };

    for (const event of own) add('own', event, null, null);

    const partnerFamilies = listFamiliesAsPartner(tree, id);
    for (const family of partnerFamilies) {
      const partnerId = family.partner1Id === id ? family.partner2Id : family.partner1Id;
      const partner = partnerId === null ? null : getPersonSummary(tree, partnerId);
      for (const event of listFamilyEvents(tree, family.id))
        add('family', event, 'partner', partner);
    }
    // Someone who is two things to the person, a partner and a cousin say, is told of once,
    // as the closest: a partner, then a child, a parent, a brother or sister.
    for (const family of partnerFamilies) {
      addRelative(family.partner1Id === id ? family.partner2Id : family.partner1Id, 'partner', [
        'death',
      ]);
    }
    for (const family of partnerFamilies) {
      for (const child of listChildren(tree, family.id)) {
        addRelative(child.childId, 'child', ['birth', 'death']);
      }
    }
    const parentFamilies = listFamiliesAsChild(tree, id).map((link) =>
      requireFamily(tree, link.familyId),
    );
    for (const family of parentFamilies) {
      addRelative(family.partner1Id, 'parent', ['death']);
      addRelative(family.partner2Id, 'parent', ['death']);
    }
    for (const family of parentFamilies) {
      for (const child of listChildren(tree, family.id)) {
        addRelative(child.childId, 'sibling', ['birth', 'death']);
      }
    }

    const all = [...entries.values()];
    const order = sortEventsForDisplay(all.map((entry) => entry.event));
    const told = order.flatMap((event) => entries.get(event.id) ?? []);
    // A brother born "1820" sorts before a birth on 5 June 1820, by the first day
    // each can mean. Whatever of the family is told of happened in the person's
    // life, so their own birth comes first.
    const born =
      birth === null || from === null ? -1 : told.findIndex((e) => e.event.id === birth.id);
    const early = told.findIndex((entry) => entry.kind === 'relative');
    if (born > early && early >= 0) told.splice(early, 0, ...told.splice(born, 1));
    return { entries: told };
  })();
}
