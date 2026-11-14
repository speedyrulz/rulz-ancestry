import { describe, expect, it } from 'vitest';
import {
  agrees,
  canCiteFor,
  canTakeDate,
  canTakePlace,
  conflicts,
  isEventOf,
  recordFacts,
  relateDates,
  relatePlaces,
  type DateRelation,
  type PlaceRelation,
} from './recordcompare';
import type { EventRecord, PersonRecord, TextRecord } from './records';

const base = {
  connectorId: 'example',
  key: 'Example-1',
  title: 'Josiah Marsh',
  url: 'https://records.example/Example-1',
};

function person(facts: PersonRecord['facts']): PersonRecord {
  return { ...base, kind: 'person', sex: 'M', facts, about: '' };
}

function event(role: string, what: string, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    ...base,
    kind: 'event',
    role,
    event: what,
    date: '21 MAY 1872',
    place: 'Voorbeeldstad',
    held: '',
    ...extra,
  };
}

describe('what a record says of the person', () => {
  it('reads the birth and the death of a profile, the first of each', () => {
    expect(
      recordFacts(
        person([
          { type: 'birth', date: '12 MAR 1850', place: ' Ashford, Vermont ' },
          { type: 'death', date: 'ABT 1912', place: '' },
          { type: 'birth', date: '1851', place: 'Millbrook' },
        ]),
      ),
    ).toEqual([
      { type: 'birth', date: '12 MAR 1850', place: 'Ashford, Vermont' },
      { type: 'death', date: 'ABT 1912', place: '' },
    ]);
  });

  it('leaves out a date it cannot read, and a fact that says nothing', () => {
    expect(
      recordFacts(
        person([
          { type: 'birth', date: 'in the spring', place: 'Ashford' },
          { type: 'death', date: '', place: '' },
        ]),
      ),
    ).toEqual([{ type: 'birth', date: '', place: 'Ashford' }]);
    expect(recordFacts(person([]))).toEqual([]);
  });

  it('reads a record of an event by the part the person has in it', () => {
    const typeOf = (role: string, what: string) =>
      recordFacts(event(role, what)).map((fact) => fact.type);
    // The one who was born, baptized, buried, or who died.
    expect(typeOf('Child', 'Birth')).toEqual(['birth']);
    expect(typeOf('Kind', 'Geboorte')).toEqual(['birth']);
    expect(typeOf('Deceased', 'Death')).toEqual(['death']);
    expect(typeOf('Overledene', 'Overlijden')).toEqual(['death']);
    // A baptism is no birth, and a burial no death.
    expect(typeOf('Baptized', 'Baptism')).toEqual(['baptism']);
    expect(typeOf('Dopeling', 'Doop')).toEqual(['baptism']);
    expect(typeOf('Child', 'Baptism')).toEqual(['baptism']);
    expect(typeOf('Child', 'Christening')).toEqual(['baptism']);
    expect(typeOf('Deceased', 'Burial')).toEqual(['burial']);
    expect(typeOf('Overledene', 'Begraven')).toEqual(['burial']);
    // Anyone else a record names: its date is not theirs.
    for (const [role, what] of [
      ['Bride', 'Marriage'],
      ['Groom', 'Marriage'],
      ['Father', 'Birth'],
      ['Mother', 'Baptism'],
      ['Witness', 'Death'],
      ['Informant', 'Death'],
      ['Child', 'Marriage'],
      ['Child', 'Death'],
      ['Deceased', 'Marriage'],
      ['', 'Birth'],
      ['Child', ''],
    ] as const) {
      expect(typeOf(role, what), `${role} in ${what}`).toEqual([]);
    }
  });

  it('gives the date and the place of the event', () => {
    expect(recordFacts(event('Dopeling', 'Doop'))).toEqual([
      { type: 'baptism', date: '21 MAY 1872', place: 'Voorbeeldstad' },
    ]);
    expect(recordFacts(event('Child', 'Birth', { date: '', place: '' }))).toEqual([]);
  });

  it('reads nothing from a text', () => {
    const text: TextRecord = { ...base, kind: 'text', date: '1903', by: '', about: '' };
    expect(recordFacts(text)).toEqual([]);
  });
});

describe('a date of a record beside the date of the tree', () => {
  const cases: [tree: string, record: string, relation: DateRelation][] = [
    ['', '', 'neither'],
    ['', '1850', 'record-only'],
    ['1850', '', 'tree-only'],
    ['1850', 'in the spring', 'tree-only'],
    ['', 'in the spring', 'neither'],
    ['1850', '1850', 'same'],
    ['12 MAR 1850', '12 March 1850', 'same'],
    ['ABT 1850', 'ABT 1850', 'same'],
    // "About" a year is less sure than the year, though both name the same days.
    ['ABT 1850', '1850', 'more-exact'],
    ['1850', 'ABT 1850', 'less-exact'],
    ['EST 1850', '1850', 'more-exact'],
    // A day within a year, a month within a year, a day within a month.
    ['1850', '12 MAR 1850', 'more-exact'],
    ['MAR 1850', '12 MAR 1850', 'more-exact'],
    ['12 MAR 1850', '1850', 'less-exact'],
    ['BET 1848 AND 1852', '1850', 'more-exact'],
    ['1850', 'BET 1848 AND 1852', 'less-exact'],
    // Open to one side.
    ['BEF 1860', '1850', 'more-exact'],
    ['1850', 'BEF 1860', 'less-exact'],
    ['AFT 1860', '1850', 'differs'],
    ['1850', 'AFT 1860', 'differs'],
    // Apart: both cannot be right.
    ['1850', '1851', 'differs'],
    ['12 MAR 1850', '13 MAR 1850', 'differs'],
    ['ABT 1850', '1852', 'differs'],
    // Some days of the one are days of the other, and neither lies within the other.
    ['BET 1848 AND 1850', 'BET 1850 AND 1852', 'overlaps'],
    ['BET 1849 AND 1850', 'BET 1845 AND 1849', 'overlaps'],
    ['BEF 1860', 'AFT 1850', 'overlaps'],
    // A year of another calendar begins and ends on other days.
    ['@#DJULIAN@ 1700', '1700', 'overlaps'],
    // Closer days that the record is less sure of are not called more exact.
    ['1850', 'ABT 12 MAR 1850', 'closer-about'],
    ['BET 1840 AND 1860', 'EST 1850', 'closer-about'],
    ['ABT 1850', 'ABT 12 MAR 1850', 'more-exact'],
    ['ABT 12 MAR 1850', '1850', 'less-exact'],
    // Words the tree keeps that are no date.
    ['in the spring', '1850', 'unreadable'],
  ];
  it.each(cases)('tree "%s", record "%s": %s', (tree, record, relation) => {
    expect(relateDates(tree, record)).toBe(relation);
  });

  it('offers a date that adds something or says something else, never one that says less', () => {
    const taken = (
      [
        'same',
        'more-exact',
        'closer-about',
        'less-exact',
        'overlaps',
        'differs',
        'unreadable',
        'record-only',
        'tree-only',
        'neither',
      ] as const
    ).filter(canTakeDate);
    expect(taken).toEqual([
      'more-exact',
      'closer-about',
      'overlaps',
      'differs',
      'unreadable',
      'record-only',
    ]);
  });
});

describe('a place of a record beside the place of the tree', () => {
  const cases: [tree: string, record: string, relation: PlaceRelation][] = [
    ['', '', 'neither'],
    ['', 'Ashford, Vermont', 'record-only'],
    ['Ashford, Vermont', '', 'tree-only'],
    ['Ashford, Vermont', 'ashford,  vermont', 'same'],
    ['Ashford Vermont', 'Ashford, Vermont', 'same'],
    ['Vermont, Ashford', 'Ashford, Vermont', 'same'],
    // Every part of the one is a part of the other.
    ['Ashford', 'Ashford, Vermont', 'fuller'],
    ['Vermont', 'Ashford, Vermont', 'fuller'],
    ['Ashford, Vermont', 'Ashford, Example County, Vermont, USA', 'fuller'],
    ['Ashford Vermont', 'Ashford, Vermont, USA', 'fuller'],
    ['Ashford, Example County, Vermont', 'Ashford, Vermont', 'shorter'],
    ['Ashford, Vermont', 'Vermont', 'shorter'],
    ['Ashford, Vermont, USA', 'Ashford Vermont', 'shorter'],
    // They begin alike, and the words do not tell whether the rest is the same place.
    ['Ashford, VT', 'Ashford, Vermont', 'alike'],
    ['Ashford, Vermont', 'Ashford, Maine', 'alike'],
    ['Ashford, New Hampshire', 'Ashford, NH, USA', 'alike'],
    ['Ashford', 'Ashford Hill, Example County', 'alike'],
    ['Ashford', 'Ashford Township, Vermont', 'alike'],
    // The same, and the record is the shorter: it is not offered.
    ['Ashford, Vermont, USA', 'Ashford, VT', 'alike-less'],
    ['Ashford, Example County, Vermont, USA', 'Ashford, VT', 'alike-less'],
    ['Ashford, Example County', 'Ashford, Vermont', 'alike-less'],
    ['Ashford Hill, Example County', 'Ashford', 'alike-less'],
    ['Millbrook, Vermont', 'Ashford, Vermont', 'differs'],
    // The words of the tree are all in the record, and it is another town.
    ['Ashford', 'New Ashford, Vermont', 'differs'],
    ['Larkfield, Maine', 'Ashford, Vermont', 'differs'],
    ['St. Millbrook, Vermont', 'Saint Millbrook, VT', 'differs'],
  ];
  it.each(cases)('tree "%s", record "%s": %s', (tree, record, relation) => {
    expect(relatePlaces(tree, record)).toBe(relation);
  });

  it('offers a place that adds something or says something else, never one that says less', () => {
    const taken = (
      [
        'same',
        'fuller',
        'shorter',
        'alike',
        'alike-less',
        'differs',
        'record-only',
        'tree-only',
        'neither',
      ] as const
    ).filter(canTakePlace);
    expect(taken).toEqual(['fuller', 'alike', 'differs', 'record-only']);
  });
});

describe('a record that agrees', () => {
  it('is one that says the same, as far as each side goes', () => {
    expect(
      (['same', 'more-exact', 'closer-about', 'less-exact', 'fuller', 'shorter'] as const).every(
        agrees,
      ),
    ).toBe(true);
    // Two places that begin alike may be two towns of one name: that is no agreement.
    expect(
      (
        [
          'alike',
          'alike-less',
          'overlaps',
          'differs',
          'unreadable',
          'record-only',
          'tree-only',
          'neither',
        ] as const
      ).some(agrees),
    ).toBe(false);
    expect((['differs'] as const).every(conflicts)).toBe(true);
    expect(
      (['alike', 'overlaps', 'unreadable', 'same', 'record-only'] as const).some(conflicts),
    ).toBe(false);
  });

  it('can be cited for an event when one of date and place agrees and the other does not differ', () => {
    expect(canCiteFor('same', 'same')).toBe(true);
    expect(canCiteFor('same', 'tree-only')).toBe(true);
    expect(canCiteFor('more-exact', 'alike')).toBe(true);
    expect(canCiteFor('record-only', 'shorter')).toBe(true);
    expect(canCiteFor('overlaps', 'same')).toBe(true);
    // The same place and another year: the record says something else of this event.
    expect(canCiteFor('differs', 'same')).toBe(false);
    expect(canCiteFor('same', 'differs')).toBe(false);
    // Nothing agrees.
    expect(canCiteFor('record-only', 'alike')).toBe(false);
    expect(canCiteFor('unreadable', 'record-only')).toBe(false);
    expect(canCiteFor('overlaps', 'alike-less')).toBe(false);
  });
});

describe('the event of the tree a fact is set beside', () => {
  it('is one of its own type, and for a baptism a christening too', () => {
    expect(isEventOf('birth', 'birth')).toBe(true);
    expect(isEventOf('baptism', 'baptism')).toBe(true);
    expect(isEventOf('baptism', 'christening')).toBe(true);
    // Another rite, and another event.
    expect(isEventOf('baptism', 'adult christening')).toBe(false);
    expect(isEventOf('baptism', 'birth')).toBe(false);
    expect(isEventOf('birth', 'christening')).toBe(false);
    expect(isEventOf('burial', 'cremation')).toBe(false);
    expect(isEventOf('death', 'burial')).toBe(false);
  });
});
