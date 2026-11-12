import { calendarToJdn } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import {
  addFamilyEvent,
  addPersonEvent,
  deleteEvent,
  getEvent,
  listFamilyEvents,
  listPersonEvents,
  updateEvent,
} from './events';
import { createFamily } from './families';
import { createPerson } from './persons';
import { cleanUpAfterEach, memoryTree, undoDepth } from './testing';
import { NotFoundError, TreeRuleError } from './tree';

cleanUpAfterEach();

const MISSING = '00000000-0000-7000-8000-000000000000';

describe('events', () => {
  it('stores the date as typed together with how it was read', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    const birth = addPersonEvent(tree, person.id, {
      type: 'Birth',
      date: ' abt Mar 1881 ',
      place: ' Springfield, Sangamon, Illinois ',
    });

    expect(birth).toMatchObject({
      type: 'birth',
      dateText: 'abt Mar 1881',
      dateQualifier: 'about',
      dateCalendar: 'gregorian',
      dateMinJdn: calendarToJdn('gregorian', 1881, 3, 1),
      dateMaxJdn: calendarToJdn('gregorian', 1881, 3, 31),
      placeText: 'Springfield, Sangamon, Illinois',
      description: '',
    });
    expect(getEvent(tree, birth.id)).toEqual(birth);
  });

  it('keeps a date it cannot read, and an event with no date at all', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    const vague = addPersonEvent(tree, person.id, { type: 'death', date: 'after the war' });
    expect(vague).toMatchObject({
      dateText: 'after the war',
      dateQualifier: 'phrase',
      dateCalendar: null,
      dateMinJdn: null,
      dateMaxJdn: null,
    });

    const undated = addPersonEvent(tree, person.id, {
      type: 'occupation',
      description: 'Blacksmith',
    });
    expect(undated).toMatchObject({
      dateText: '',
      dateQualifier: null,
      dateCalendar: null,
      description: 'Blacksmith',
    });
  });

  it('lists the events of a person in the order they were added', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    const other = createPerson(tree);
    addPersonEvent(tree, person.id, { type: 'death', date: '1950' });
    addPersonEvent(tree, other.id, { type: 'birth', date: '1800' });
    addPersonEvent(tree, person.id, { type: 'birth', date: '1880' });
    addPersonEvent(tree, person.id, { type: 'residence', date: '1910' });

    expect(listPersonEvents(tree, person.id).map((e) => e.type)).toEqual([
      'death',
      'birth',
      'residence',
    ]);
    expect(listPersonEvents(tree, other.id)).toHaveLength(1);
  });

  it('keeps the events of a couple apart from the events of each partner', () => {
    const tree = memoryTree();
    const a = createPerson(tree);
    const b = createPerson(tree);
    const family = createFamily(tree, { partner1Id: a.id, partner2Id: b.id });
    const marriage = addFamilyEvent(tree, family.id, { type: 'marriage', date: '4 Jun 1920' });

    expect(listFamilyEvents(tree, family.id)).toEqual([marriage]);
    expect(listPersonEvents(tree, a.id)).toEqual([]);
    expect(
      tree.db.prepare('SELECT person_id, family_id, role, sort_order FROM event_participant').all(),
    ).toEqual([{ person_id: null, family_id: family.id, role: 'principal', sort_order: 0 }]);
  });

  it('reads the date again when it is edited, and can clear it', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    const event = addPersonEvent(tree, person.id, { type: 'birth', date: '1881', place: 'Leeds' });

    const edited = updateEvent(tree, event.id, { date: '12 Mar 1881' });
    const day = calendarToJdn('gregorian', 1881, 3, 12);
    expect(edited).toMatchObject({
      dateText: '12 Mar 1881',
      dateQualifier: 'exact',
      dateMinJdn: day,
      dateMaxJdn: day,
      placeText: 'Leeds',
    });

    const cleared = updateEvent(tree, event.id, { date: '', place: 'York', type: 'baptism' });
    expect(cleared).toMatchObject({
      type: 'baptism',
      dateText: '',
      dateQualifier: null,
      dateMinJdn: null,
      placeText: 'York',
    });
  });

  it('does not make an undo step for an edit that changes nothing', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    const event = addPersonEvent(tree, person.id, { type: 'birth', date: '1881' });
    const depth = undoDepth(tree);
    expect(updateEvent(tree, event.id, { date: '1881', type: 'birth' })).toEqual(event);
    expect(undoDepth(tree)).toBe(depth);
  });

  it('deletes an event together with its link to the person', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    const event = addPersonEvent(tree, person.id, { type: 'birth' });
    deleteEvent(tree, event.id);
    expect(getEvent(tree, event.id)).toBeNull();
    expect(listPersonEvents(tree, person.id)).toEqual([]);
    expect(tree.db.prepare('SELECT count(*) FROM event_participant').pluck().get()).toBe(0);
  });

  it('rejects an event with no type or no owner', () => {
    const tree = memoryTree();
    const person = createPerson(tree);
    expect(() => addPersonEvent(tree, person.id, { type: '  ' })).toThrow(TreeRuleError);
    expect(() => addPersonEvent(tree, MISSING, { type: 'birth' })).toThrow(NotFoundError);
    expect(() => addFamilyEvent(tree, MISSING, { type: 'marriage' })).toThrow(NotFoundError);
    expect(() => updateEvent(tree, MISSING, { date: '1900' })).toThrow(NotFoundError);
    expect(() => deleteEvent(tree, MISSING)).toThrow(NotFoundError);
    expect(tree.info().events).toBe(0);
  });
});
