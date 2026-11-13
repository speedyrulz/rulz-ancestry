import { describe, expect, it } from 'vitest';
import { addChildOf, addParent, addPartner, addPersonFromDraft } from './actions';
import { addFamilyEvent, addPersonEvent } from './events';
import { getPersonLife, type LifeEntry } from './life';
import { linkPlace } from './places';
import { cleanUpAfterEach, memoryTree } from './testing';

cleanUpAfterEach();

const AMES = {
  geonamesId: 4846834,
  name: 'Ames, Story County, Iowa, USA',
  lat: 42.03471,
  lon: -93.61994,
};

/** One line of a life in short: "birth", "marriage with John", "birth of child Ann". */
function told(entry: LifeEntry): string {
  const who = entry.person?.name?.given ?? 'someone';
  if (entry.kind === 'own') return entry.event.type;
  if (entry.kind === 'family') return `${entry.event.type} with ${who}`;
  return `${entry.event.type} of ${entry.relation ?? ''} ${who}`;
}

function lines(life: { entries: LifeEntry[] } | null): string[] {
  return (life?.entries ?? []).map(told);
}

describe('getPersonLife', () => {
  it('returns null for someone who is not in the tree', () => {
    expect(getPersonLife(memoryTree(), '00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('tells a life in order, with what happened close by', () => {
    const tree = memoryTree();
    const mary = addPersonFromDraft(tree, {
      given: 'Mary',
      sex: 'F',
      birthDate: '22 Nov 1819',
      deathDate: '22 Dec 1880',
    });
    addPersonEvent(tree, mary.id, { type: 'residence', date: '1851' });
    addPersonEvent(tree, mary.id, { type: 'occupation' });

    const father = addParent(tree, mary.id, {
      create: { given: 'Robert', sex: 'M', birthDate: '1773', deathDate: '31 May 1849' },
    });
    addParent(tree, mary.id, { create: { given: 'Christiana', sex: 'F', deathDate: '1836' } });
    addChildOf(
      tree,
      father.personId,
      { create: { given: 'Isaac', sex: 'M', birthDate: '1816', deathDate: '1890' } },
      { familyId: father.familyId },
    );
    addChildOf(
      tree,
      father.personId,
      { create: { given: 'Tom', sex: 'M', birthDate: '1821', deathDate: '1821' } },
      { familyId: father.familyId },
    );

    const john = addPartner(tree, mary.id, {
      create: { given: 'John', sex: 'M', deathDate: '1924' },
    });
    addFamilyEvent(tree, john.familyId, { type: 'marriage', date: '6 May 1880' });
    addChildOf(
      tree,
      mary.id,
      { create: { given: 'Ann', sex: 'F', birthDate: '1845', deathDate: '1846' } },
      { familyId: john.familyId },
    );

    expect(lines(getPersonLife(tree, mary.id))).toEqual([
      'birth',
      // Isaac was born before her and died after her; Tom lived within her life.
      'birth of sibling Tom',
      'death of sibling Tom',
      'death of parent Christiana',
      'birth of child Ann',
      'death of child Ann',
      'death of parent Robert',
      'residence',
      'marriage with John',
      'death',
      // No date: after the dated ones. John died after her.
      'occupation',
    ]);
  });

  it('says how old the person was', () => {
    const tree = memoryTree();
    const mary = addPersonFromDraft(tree, { given: 'Mary', sex: 'F', birthDate: '22 Nov 1819' });
    addPersonEvent(tree, mary.id, { type: 'residence', date: '1851' });
    addPersonEvent(tree, mary.id, { type: 'death', date: '22 Dec 1880' });
    addPersonEvent(tree, mary.id, { type: 'burial' });
    const life = getPersonLife(tree, mary.id);
    expect(life?.entries.map((entry) => [entry.event.type, entry.age])).toEqual([
      ['birth', null],
      ['residence', { min: 31, max: 32 }],
      ['death', { min: 61, max: 61 }],
      ['burial', null],
    ]);
  });

  it('counts every dated event of a relative when the person has no dates of their own', () => {
    const tree = memoryTree();
    const mary = addPersonFromDraft(tree, { given: 'Mary', sex: 'F' });
    addChildOf(tree, mary.id, { create: { given: 'Ann', sex: 'F', birthDate: '1845' } });
    addChildOf(tree, mary.id, { create: { given: 'Ben', sex: 'M' } });
    const life = getPersonLife(tree, mary.id);
    expect(lines(life)).toEqual(['birth of child Ann']);
    expect(life?.entries[0]?.age).toBeNull();
  });

  it('counts an event whose date can lie within the life, and leaves an open side open', () => {
    const tree = memoryTree();
    // Born at some time before 1900: nothing says how long before.
    const mary = addPersonFromDraft(tree, {
      given: 'Mary',
      sex: 'F',
      birthDate: 'BEF 1900',
      deathDate: 'ABT 1950',
    });
    const father = addParent(tree, mary.id, {
      create: { given: 'Robert', sex: 'M', deathDate: '1890' },
    });
    const sibling = (given: string, birthDate: string, deathDate?: string) =>
      addChildOf(
        tree,
        father.personId,
        { create: { given, sex: 'M', birthDate, ...(deathDate ? { deathDate } : {}) } },
        { familyId: father.familyId },
      );
    sibling('Early', '1880');
    sibling('Edge', 'BET 1949 AND 1951');
    sibling('Late', '1952', '1953');
    sibling('Open', '1890', 'AFT 1940');
    expect(lines(getPersonLife(tree, mary.id))).toEqual([
      'birth of sibling Early',
      // Both in 1890: a parent is told of before a brother.
      'death of parent Robert',
      'birth of sibling Open',
      'birth',
      'death of sibling Open',
      'birth of sibling Edge',
      'death',
    ]);

    const tom = addPersonFromDraft(tree, { given: 'Tom', sex: 'M', birthDate: '1900' });
    const mother = addParent(tree, tom.id, { create: { given: 'Jane', sex: 'F' } });
    addChildOf(
      tree,
      mother.personId,
      {
        create: { given: 'Twin', sex: 'M', birthDate: 'BET 1899 AND 1901', deathDate: 'BEF 1899' },
      },
      { familyId: mother.familyId },
    );
    // The person's own birth comes before what happened in their life.
    expect(lines(getPersonLife(tree, tom.id))).toEqual(['birth', 'birth of sibling Twin']);
  });

  it('gives a couple event without a partner, and tells of nobody twice', () => {
    const tree = memoryTree();
    const mary = addPersonFromDraft(tree, { given: 'Mary', sex: 'F', birthDate: '1819' });
    const john = addPartner(tree, mary.id, {
      create: { given: 'John', sex: 'M', deathDate: '1870' },
    });
    addFamilyEvent(tree, john.familyId, { type: 'marriage', date: '1840' });
    // John is also a child of her parents, as a wrongly merged tree can have it.
    const father = addParent(tree, mary.id, { create: { given: 'Robert', sex: 'M' } });
    addChildOf(tree, father.personId, { existingId: john.personId }, { familyId: father.familyId });
    // A family with a child and no partner.
    const child = addChildOf(tree, mary.id, { create: { given: 'Ann', sex: 'F' } });
    addFamilyEvent(tree, child.familyId, { type: 'divorce', date: '1865' });

    expect(lines(getPersonLife(tree, mary.id))).toEqual([
      'birth',
      'marriage with John',
      'divorce with someone',
      'death of partner John',
    ]);
  });

  it('says where an event lies when its place is linked, whatever the case of the text', () => {
    const tree = memoryTree();
    const mary = addPersonFromDraft(tree, {
      given: 'Mary',
      sex: 'F',
      birthDate: '1819',
      birthPlace: 'Ames, Iowa',
    });
    addPersonEvent(tree, mary.id, { type: 'residence', date: '1851', place: 'AMES, IOWA' });
    addPersonEvent(tree, mary.id, { type: 'residence', date: '1861', place: 'Elsewhere' });
    addPersonEvent(tree, mary.id, { type: 'residence', date: '1871' });
    linkPlace(tree, 'Ames, Iowa', AMES);

    const life = getPersonLife(tree, mary.id);
    expect(life?.entries.map((entry) => entry.place)).toEqual([AMES, AMES, null, null]);
  });
});
