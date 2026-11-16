import { describe, expect, it } from 'vitest';
import { addPartner, addPersonFromDraft } from './actions';
import { addFamilyEvent, addPersonEvent } from './events';
import { PRESUMED_LIVING_YEARS, livingReason, presumedLivingIds } from './living';
import { updatePerson } from './persons';
import { cleanUpAfterEach, memoryTree } from './testing';
import type { Tree } from './tree';

cleanUpAfterEach();

/** The day the tests take as today. */
const NOW = Date.UTC(2026, 10, 11);

function add(tree: Tree, given: string, events: { type: string; date?: string }[] = []): string {
  const person = addPersonFromDraft(tree, { given });
  for (const event of events) addPersonEvent(tree, person.id, event);
  return person.id;
}

describe('presumedLivingIds', () => {
  it('takes someone with nothing to show a death as possibly living', () => {
    const tree = memoryTree();
    const undated = add(tree, 'Undated');
    const young = add(tree, 'Young', [{ type: 'birth', date: '1990' }]);
    const recent = add(tree, 'Recent', [{ type: 'residence', date: 'abt 1950' }]);
    expect(presumedLivingIds(tree, NOW)).toEqual(new Set([undated, young, recent]));
  });

  it('takes someone as deceased when a death, burial, cremation or probate is recorded', () => {
    const tree = memoryTree();
    for (const type of ['death', 'burial', 'cremation', 'probate']) {
      // Even with no date: the event itself says the person has died.
      add(tree, type, [{ type }]);
    }
    // A will is made by the living.
    const will = add(tree, 'will', [{ type: 'will', date: '2001' }]);
    expect(presumedLivingIds(tree, NOW)).toEqual(new Set([will]));
  });

  it(`takes someone as deceased when an event of theirs is more than ${PRESUMED_LIVING_YEARS} years old`, () => {
    const tree = memoryTree();
    add(tree, 'Old birth', [{ type: 'birth', date: '1850' }]);
    add(tree, 'Old census', [{ type: 'census', date: 'bef 1900' }]);
    add(tree, 'Old range', [{ type: 'residence', date: 'BET 1880 AND 1890' }]);
    const edge = add(tree, 'Just inside', [{ type: 'birth', date: '1 JAN 1917' }]);
    // "After 1850" could be last year, and a date that cannot be read says nothing.
    const after = add(tree, 'After', [{ type: 'residence', date: 'aft 1850' }]);
    const from = add(tree, 'From', [{ type: 'residence', date: 'from 1850' }]);
    const phrase = add(tree, 'Phrase', [{ type: 'birth', date: 'long ago' }]);
    expect(presumedLivingIds(tree, NOW)).toEqual(new Set([edge, after, from, phrase]));
  });

  it('counts an old event of a couple for both partners, but not for their children', () => {
    const tree = memoryTree();
    const husband = add(tree, 'Husband');
    const wife = addPartner(tree, husband, { create: { given: 'Wife' } });
    addFamilyEvent(tree, wife.familyId, { type: 'marriage', date: '1875' });
    const single = add(tree, 'Single');
    const modern = addPartner(tree, single, { create: { given: 'Modern' } });
    addFamilyEvent(tree, modern.familyId, { type: 'marriage', date: '1995' });
    expect(presumedLivingIds(tree, NOW)).toEqual(new Set([single, modern.personId]));
  });

  it('goes by the living flag when it is set, whatever the events say', () => {
    const tree = memoryTree();
    const flagged = add(tree, 'Flagged living', [{ type: 'birth', date: '1850' }]);
    updatePerson(tree, flagged, { living: true });
    const deceased = add(tree, 'Flagged deceased');
    updatePerson(tree, deceased, { living: false });
    expect(presumedLivingIds(tree, NOW)).toEqual(new Set([flagged]));
  });

  it('moves with the calendar', () => {
    const tree = memoryTree();
    const person = add(tree, 'Born 1917', [{ type: 'birth', date: '1917' }]);
    expect(presumedLivingIds(tree, NOW).has(person)).toBe(true);
    expect(presumedLivingIds(tree, Date.UTC(2028, 0, 2)).has(person)).toBe(false);
  });
});

describe('livingReason', () => {
  const reasonOf = (tree: Tree, id: string) => livingReason(tree, id, NOW)?.reason;

  it('says why each kind of person is taken as living or deceased', () => {
    const tree = memoryTree();
    const flaggedLiving = add(tree, 'Flagged living', [{ type: 'birth', date: '1850' }]);
    updatePerson(tree, flaggedLiving, { living: true });
    const flaggedDeceased = add(tree, 'Flagged deceased');
    updatePerson(tree, flaggedDeceased, { living: false });
    const died = add(tree, 'Died', [{ type: 'death' }]);
    const bornLongAgo = add(tree, 'Old', [{ type: 'birth', date: '1850' }]);
    const eventLongAgo = add(tree, 'Census', [{ type: 'census', date: '1880' }]);
    const young = add(tree, 'Young', [{ type: 'birth', date: '1990' }]);
    const undated = add(tree, 'Undated');

    expect(livingReason(tree, flaggedLiving, NOW)).toEqual({
      living: true,
      reason: 'marked-living',
      text: 'Marked living by hand',
    });
    expect(reasonOf(tree, flaggedDeceased)).toBe('marked-deceased');
    expect(livingReason(tree, died, NOW)?.text).toBe('Deceased: death recorded');
    expect(livingReason(tree, bornLongAgo, NOW)).toMatchObject({
      living: false,
      text: 'Deceased: born more than 110 years ago',
    });
    expect(reasonOf(tree, eventLongAgo)).toBe('event-long-ago');
    expect(livingReason(tree, young, NOW)).toMatchObject({
      living: true,
      text: 'Presumed living: no death recorded and born less than 110 years ago',
    });
    expect(reasonOf(tree, undated)).toBe('nothing-shows-death');
    expect(livingReason(tree, '00000000-0000-7000-8000-000000000000', NOW)).toBeNull();
  });

  it('agrees with presumedLivingIds for every person, couple events included', () => {
    const tree = memoryTree();
    add(tree, 'A', [{ type: 'birth', date: '1990' }]);
    add(tree, 'B', [{ type: 'burial' }]);
    const husband = add(tree, 'Husband');
    const wife = addPartner(tree, husband, { create: { given: 'Wife' } });
    addFamilyEvent(tree, wife.familyId, { type: 'marriage', date: '1875' });
    const flagged = add(tree, 'Flagged', [{ type: 'death', date: '1900' }]);
    updatePerson(tree, flagged, { living: true });
    const living = presumedLivingIds(tree, NOW);
    for (const id of [husband, wife.personId, flagged]) {
      expect(livingReason(tree, id, NOW)?.living, id).toBe(living.has(id));
    }
    expect(reasonOf(tree, husband)).toBe('event-long-ago');
  });
});
