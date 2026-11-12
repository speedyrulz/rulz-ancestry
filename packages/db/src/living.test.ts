import { describe, expect, it } from 'vitest';
import { addPartner, addPersonFromDraft } from './actions';
import { addFamilyEvent, addPersonEvent } from './events';
import { PRESUMED_LIVING_YEARS, presumedLivingIds } from './living';
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
