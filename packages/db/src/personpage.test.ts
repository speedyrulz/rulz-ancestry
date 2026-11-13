import { describe, expect, it } from 'vitest';
import { addChildOf, addParent, addPartner, addPersonFromDraft } from './actions';
import { addFamilyEvent, addPersonEvent, type TreeEvent } from './events';
import { setChildPedigree } from './families';
import { addName } from './persons';
import { getPersonPage, sortEventsForDisplay } from './personpage';
import { cleanUpAfterEach, memoryTree } from './testing';

cleanUpAfterEach();

function event(type: string, day: number | null, id: string): TreeEvent {
  return {
    id,
    type,
    dateText: day === null ? '' : 'a date',
    dateQualifier: day === null ? null : 'exact',
    dateCalendar: day === null ? null : 'gregorian',
    dateMinJdn: day,
    dateMaxJdn: day,
    placeText: '',
    description: '',
    note: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('sortEventsForDisplay', () => {
  it('orders a life: undated birth, dated events by date, other undated, undated death', () => {
    const sorted = sortEventsForDisplay([
      event('burial', null, 'burial'),
      event('residence', null, 'residence-undated'),
      event('death', 300, 'death'),
      event('occupation', 200, 'occupation'),
      event('birth', null, 'birth'),
      event('residence', 100, 'residence'),
      event('census', null, 'census-undated'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual([
      'birth',
      'residence',
      'occupation',
      'death',
      'residence-undated',
      'census-undated',
      'burial',
    ]);
  });

  it('uses the end of an open-ended date, and keeps entry order for ties', () => {
    const before1900: TreeEvent = { ...event('residence', null, 'before'), dateMaxJdn: 150 };
    before1900.dateText = 'BEF 1900';
    const sorted = sortEventsForDisplay([
      event('census', 200, 'second-at-200'),
      before1900,
      event('census', 200, 'third-at-200'),
      event('census', 100, 'first'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['first', 'before', 'second-at-200', 'third-at-200']);
  });
});

describe('getPersonPage', () => {
  it('returns null for someone who is not in the tree', () => {
    expect(getPersonPage(memoryTree(), '00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('shows a person with no relatives', () => {
    const tree = memoryTree();
    const ada = addPersonFromDraft(tree, { given: 'Ada', surname: 'Lovelace', sex: 'F' });
    expect(getPersonPage(tree, ada.id)).toMatchObject({
      person: { id: ada.id, sex: 'F', living: null },
      summary: { id: ada.id, name: { given: 'Ada', surname: 'Lovelace' } },
      names: [{ given: 'Ada', surname: 'Lovelace', isPrimary: true }],
      events: [],
      parentFamilies: [],
      partnerFamilies: [],
    });
  });

  it('gathers names, events in life order, parents, siblings, partners and children', () => {
    const tree = memoryTree();
    const mary = addPersonFromDraft(tree, {
      given: 'Mary',
      surname: 'Evans',
      sex: 'F',
      deathDate: '22 Dec 1880',
      birthDate: '22 Nov 1819',
    });
    addName(tree, mary.id, { type: 'married', given: 'Mary', surname: 'Cross' });
    addPersonEvent(tree, mary.id, { type: 'residence', date: '1851', place: 'Coventry' });

    const father = addParent(tree, mary.id, {
      create: { given: 'Robert', surname: 'Evans', sex: 'M' },
    });
    const mother = addParent(tree, mary.id, { create: { given: 'Christiana', sex: 'F' } });
    const brother = addChildOf(
      tree,
      father.personId,
      { create: { given: 'Isaac', surname: 'Evans', sex: 'M' } },
      { familyId: father.familyId },
    );

    const husband = addPartner(tree, mary.id, {
      create: { given: 'John', surname: 'Cross', sex: 'M' },
    });
    addFamilyEvent(tree, husband.familyId, { type: 'marriage', date: '6 May 1880' });
    const child = addChildOf(
      tree,
      mary.id,
      { create: { given: 'Child', surname: 'Cross' } },
      { familyId: husband.familyId },
    );
    setChildPedigree(tree, husband.familyId, child.personId, 'adopted');
    // A second family: a child whose other parent is not known.
    const other = addChildOf(tree, mary.id, { create: { given: 'Other', surname: 'Evans' } });

    const page = getPersonPage(tree, mary.id);
    expect(page?.names.map((name) => name.surname)).toEqual(['Evans', 'Cross']);
    expect(page?.events.map((e) => e.type)).toEqual(['birth', 'residence', 'death']);
    expect(page?.summary).toMatchObject({
      birth: { year: '1819' },
      death: { year: '1880' },
    });

    expect(page?.parentFamilies).toHaveLength(1);
    expect(page?.parentFamilies[0]).toMatchObject({
      familyId: father.familyId,
      pedigree: 'birth',
      parents: [{ id: father.personId }, { id: mother.personId }],
      siblings: [{ id: brother.personId, name: { given: 'Isaac' } }],
    });

    expect(page?.partnerFamilies).toHaveLength(2);
    expect(page?.partnerFamilies[0]).toMatchObject({
      familyId: husband.familyId,
      partner: { id: husband.personId, name: { given: 'John', surname: 'Cross' } },
      events: [{ type: 'marriage', dateText: '6 May 1880' }],
      children: [{ person: { id: child.personId }, pedigree: 'adopted' }],
    });
    expect(page?.partnerFamilies[1]).toMatchObject({
      familyId: other.familyId,
      partner: null,
      events: [],
      children: [{ person: { id: other.personId }, pedigree: 'birth' }],
    });

    // From the husband's side, Mary is the partner.
    expect(getPersonPage(tree, husband.personId)?.partnerFamilies[0]?.partner?.id).toBe(mary.id);
    // From the brother's side, Mary is the sibling.
    expect(getPersonPage(tree, brother.personId)?.parentFamilies[0]?.siblings).toMatchObject([
      { id: mary.id },
    ]);
  });
});
