import { describe, expect, it } from 'vitest';
import {
  MATCH_POSSIBLE,
  MATCH_STRONG,
  matchBand,
  scoreRecord,
  spanOfDate,
  yearOfDate,
  type MatchSubject,
} from './recordmatch';
import { SECOND_LISTS, labelledCases, type LabelledCase } from './recordmatch.labelled';
import type { EventRecord, PersonRecord, TextRecord } from './records';

// The people below are made up.
const josiah: MatchSubject = {
  sex: 'M',
  names: [{ given: 'Josiah Tobias', surname: 'Marsh' }],
  birth: { min: 1835, max: 1835 },
  death: { min: 1910, max: 1910 },
  birthPlace: 'Ashford, Example County, Vermont',
  deathPlace: 'Millbrook, Example County, Vermont',
  places: ['Ashford, Example County, Vermont', 'Millbrook, Example County, Vermont'],
};

const profile = (changes: Partial<PersonRecord> = {}): PersonRecord => ({
  connectorId: 'example-source',
  key: 'x',
  kind: 'person',
  title: 'Josiah Tobias Marsh',
  url: 'https://example.org/x',
  sex: 'M',
  about: '',
  facts: [
    { type: 'birth', date: '30 NOV 1835', place: 'Ashford, Example County, Vermont' },
    { type: 'death', date: '1910', place: '' },
  ],
  ...changes,
});

const entry = (changes: Partial<EventRecord> = {}): EventRecord => ({
  connectorId: 'example-archive',
  key: 'y',
  kind: 'event',
  title: 'Josiah Tobias Marsh',
  url: 'https://example.org/y',
  role: 'Groom',
  event: 'Marriage',
  date: '21 MAY 1861',
  place: 'Ashford',
  held: 'Civil registration marriages, Example Archive',
  ...changes,
});

const match = (subject: MatchSubject, record: PersonRecord | EventRecord) => {
  const found = scoreRecord(subject, record);
  if (found === null) throw new Error('no score');
  return found;
};

/** A profile with one birth and nothing else, held against Josiah. */
const born = (date: string, subject: MatchSubject = josiah) =>
  match(subject, profile({ facts: [{ type: 'birth', date, place: '' }] }));

describe('the years of a date of a source', () => {
  it('reads a date in the wording of a GEDCOM file', () => {
    expect(spanOfDate('30 NOV 1835')).toEqual({ min: 1835, max: 1835, loose: false });
    expect(spanOfDate('1835')).toEqual({ min: 1835, max: 1835, loose: false });
    expect(spanOfDate('ABT 1910')).toEqual({ min: 1910, max: 1910, loose: true });
    expect(spanOfDate('BEF MAY 1837')).toEqual({ min: null, max: 1837, loose: true });
    expect(spanOfDate('AFT 2 MAY 1837')).toEqual({ min: 1837, max: null, loose: true });
    expect(spanOfDate('BET 1800 AND 1810')).toEqual({ min: 1800, max: 1810, loose: false });
    expect(spanOfDate('FROM JAN 1810 TO 1800')).toEqual({ min: 1800, max: 1810, loose: false });
    expect(spanOfDate('987')).toEqual({ min: 987, max: 987, loose: false });
    for (const none of ['', 'MAR', '12', 'unknown', 'BEF', '18355']) {
      expect(spanOfDate(none), none).toBeNull();
    }
  });

  it('gives the one year of a date, and none for a span', () => {
    expect(yearOfDate('30 NOV 1835')).toBe(1835);
    expect(yearOfDate('ABT 1910')).toBe(1910);
    expect(yearOfDate('BEF 1840')).toBeNull();
    expect(yearOfDate('BET 1800 AND 1810')).toBeNull();
    expect(yearOfDate('')).toBeNull();
  });
});

describe('the fit of a person a source knows', () => {
  it('is strong when the name and the dates agree, and says why', () => {
    expect(match(josiah, profile())).toEqual({
      score: 96,
      band: 'strong',
      reasons: ['Same name', 'Born in the same year', 'Same place', 'Died in the same year'],
      doubts: [],
    });
  });

  it('is possible on the name alone: there is nothing else to go by', () => {
    const found = match(josiah, profile({ facts: [], sex: null }));
    expect(found).toEqual({ score: 50, band: 'possible', reasons: ['Same name'], doubts: [] });
    // Also when the source leaves a middle name out.
    expect(match(josiah, profile({ title: 'Josiah Marsh', facts: [] }))).toMatchObject({
      score: 50,
      reasons: ['Similar name'],
    });
    // A name that is only like the other is little to go by.
    expect(match(josiah, profile({ title: 'J. Marsh', facts: [] }))).toMatchObject({
      band: 'weak',
      doubts: [],
    });
  });

  it('takes a name written another way for the same name', () => {
    for (const title of [
      'Josiah Marsh',
      'J. Marsh',
      'Josiah T. Marsh',
      'JOSIAH MARSH',
      'Josiah Marsch',
      'Josiah Fenwick (born Marsh)',
      // What stands before and after a name is no part of it.
      'Josiah Tobias Marsh Jr',
      'Josiah Marsh Sr.',
      'Dr. Josiah Marsh',
      'Rev. Josiah T. Marsh III',
    ]) {
      expect(match(josiah, profile({ title })).band, title).toBe('strong');
    }
  });

  it('does not fit another name, whatever else agrees', () => {
    for (const title of [
      'Tobias Fenwick',
      'Henrietta Marsh',
      'Josiah Fenwick',
      'Marsh',
      '',
      // A middle name that begins like the surname is no surname.
      'Josiah Marshall Brackett',
      'Josiah Marsh Brackett',
    ]) {
      expect(match(josiah, profile({ title })), title).toEqual({
        score: 0,
        band: 'unlikely',
        reasons: [],
        doubts: ['Another name'],
      });
    }
  });

  it('reads the small words of a surname as no part of it', () => {
    const hendrik: MatchSubject = {
      ...josiah,
      names: [{ given: 'Hendrik', surname: 'van Voorbeeld' }],
    };
    const name = (title: string, subject = hendrik) =>
      match(subject, profile({ title })).reasons[0];
    expect(name('Hendrik van Voorbeeld')).toBe('Same name');
    expect(name('Hendrik Voorbeeld')).toBe('Same name');
    expect(name('Hendrik Jan van Voorbeeld')).toBe('Similar name');
    expect(match(hendrik, profile({ title: 'Jan van Voorbeeld' })).band).toBe('unlikely');
    // And the other way round: the tree has the bare name, the source the full one.
    const bare: MatchSubject = { ...josiah, names: [{ given: 'Hendrik', surname: 'Voorbeeld' }] };
    expect(name('Hendrik van der Voorbeeld', bare)).toBe('Same name');
    // A name at birth of several words, beside another surname of now.
    const etta: MatchSubject = { ...josiah, names: [{ given: 'Etta', surname: 'van Marsh' }] };
    expect(name('Etta Fenwick (born van Marsh)', etta)).toBe('Same name');
  });

  it('goes by any of the names the tree has for the person', () => {
    const two: MatchSubject = {
      ...josiah,
      names: [
        { given: 'Henrietta', surname: 'Marsh' },
        { given: 'Henrietta', surname: 'Fenwick' },
      ],
    };
    expect(match(two, profile({ title: 'Henrietta Fenwick', sex: null })).reasons[0]).toBe(
      'Same name',
    );
  });

  it('counts years that lie apart against a fit, the more the further', () => {
    expect(born('1835')).toMatchObject({ score: 75, band: 'strong' });
    expect(born('1836')).toMatchObject({ score: 68, reasons: ['Same name', 'Born a year apart'] });
    expect(born('1837')).toMatchObject({ score: 60 });
    expect(born('1839')).toMatchObject({ score: 50, doubts: ['Born 4 years apart'] });
    expect(born('1843')).toMatchObject({ score: 35, band: 'weak' });
    expect(born('1863')).toMatchObject({
      score: 5,
      band: 'unlikely',
      doubts: ['Born 28 years apart'],
    });
  });

  it('claims no more of a date than either side knows', () => {
    // "About" a year is not that year.
    expect(born('ABT 1835')).toMatchObject({
      score: 68,
      reasons: ['Same name', 'Born in about the same year'],
    });
    // A date of the tree that spans ten years agrees with any of them, and says less.
    const tenYears: MatchSubject = { ...josiah, birth: { min: 1830, max: 1840 } };
    expect(born('1831', tenYears)).toMatchObject({
      score: 59,
      reasons: ['Same name', 'Born within the years the tree gives'],
    });
    expect(born('1841', tenYears).reasons[1]).toBe('Born a year apart');
    // One that spans a century says next to nothing, and is no strong fit.
    const century: MatchSubject = { ...josiah, birth: { min: 1800, max: 1900 } };
    expect(born('1849', century)).toMatchObject({ score: 54, band: 'possible' });
    // The same when it is the source that gives a span.
    expect(born('BET 1830 AND 1840')).toMatchObject({
      reasons: ['Same name', 'Born within the years the record gives'],
    });
  });

  it('lets a date that is open to one side speak against a fit, and never for it', () => {
    // "Before 1860" is true of 1835, and of a thousand other years.
    expect(born('BEF 1860')).toEqual({
      score: 50,
      band: 'possible',
      reasons: ['Same name'],
      doubts: [],
    });
    expect(born('AFT 1835')).toMatchObject({ score: 50, doubts: [] });
    expect(born('BEF 1830')).toMatchObject({ score: 50, doubts: ['Born 5 years apart'] });
    expect(born('AFT 1850')).toMatchObject({ band: 'unlikely', doubts: ['Born 15 years apart'] });
  });

  it('counts one birth and one death, however many a source gives', () => {
    const twice = match(
      josiah,
      profile({
        facts: [
          { type: 'birth', date: '1835', place: '' },
          { type: 'birth', date: '1835', place: '' },
        ],
      }),
    );
    expect(twice).toMatchObject({ score: 75, reasons: ['Same name', 'Born in the same year'] });
  });

  it('leaves out what either side does not say', () => {
    const bare: MatchSubject = { ...josiah, birth: null, death: null, birthPlace: '', places: [] };
    expect(match(bare, profile())).toMatchObject({ score: 50, reasons: ['Same name'], doubts: [] });
    // A sex that is not known is no other sex.
    expect(match({ ...josiah, sex: 'U' }, profile({ sex: 'F' })).doubts).toEqual([]);
    expect(match(josiah, profile({ sex: null })).doubts).toEqual([]);
  });

  it('does not fit the other sex', () => {
    expect(match(josiah, profile({ sex: 'F' }))).toMatchObject({
      score: 51,
      doubts: ['The other sex'],
    });
    expect(match(josiah, profile({ sex: 'F', facts: [] })).band).toBe('unlikely');
  });

  it('takes only the same town for the same place', () => {
    const at = (place: string) =>
      match(josiah, profile({ facts: [{ type: 'birth', date: '1835', place }] }));
    expect(at('Ashford, Vermont')).toMatchObject({ score: 81 });
    expect(at('Ashford Example County Vermont')).toMatchObject({ score: 81 });
    expect(at('Millbrook')).toMatchObject({
      score: 79,
      reasons: ['Same name', 'Born in the same year', 'A place the tree names for this person'],
    });
    expect(at('Stonehaven, Maine')).toMatchObject({ score: 72, doubts: ['Another place'] });
    // Another town of the same county is another town: it speaks neither for nor against.
    const oneTown: MatchSubject = { ...josiah, places: [josiah.birthPlace] };
    const nextTown = match(
      oneTown,
      profile({
        facts: [{ type: 'birth', date: '1835', place: 'Larkfield, Example County, Vermont' }],
      }),
    );
    expect(nextTown).toEqual({
      score: 75,
      band: 'strong',
      reasons: ['Same name', 'Born in the same year'],
      doubts: [],
    });
  });
});

describe('the fit of a record of an event', () => {
  it('reads the birth of the record of a birth, and the death of that of a death', () => {
    expect(
      match(josiah, entry({ role: 'Child', event: 'Birth', date: '1 DEC 1835' })),
    ).toMatchObject({
      score: 81,
      band: 'strong',
      reasons: ['Same name', 'Born in the same year', 'Same place'],
    });
    expect(
      match(josiah, entry({ role: 'Deceased', event: 'Death', date: '1911', place: 'Millbrook' })),
    ).toMatchObject({ score: 66, reasons: ['Same name', 'Died a year apart', 'Same place'] });
    // In Dutch, as an archive may word it.
    expect(
      match(josiah, entry({ role: 'Overledene', event: 'Overlijden', date: '1910', place: '' })),
    ).toMatchObject({ score: 65 });
  });

  it('takes a bride or a groom for an adult of that sex, in the years the person lived', () => {
    expect(match(josiah, entry())).toMatchObject({
      score: 66,
      band: 'possible',
      reasons: [
        'Same name',
        'From the years the person lived in',
        'A place the tree names for this person',
      ],
    });
    expect(match(josiah, entry({ date: '1845' })).doubts).toEqual(['The person was a child then']);
    expect(match(josiah, entry({ role: 'Bride' })).doubts).toContain('The other sex');
  });

  it('rates only the record of the own birth or death as a strong fit', () => {
    const witness = match(
      josiah,
      entry({ role: 'Witness', date: '1870', place: 'Ashford, Example County, Vermont' }),
    );
    expect(witness.band).toBe('possible');
    expect(witness.score).toBeLessThan(MATCH_STRONG);
    // Not a parent in the record of a child's birth either: the birth is the child's.
    const father = match(josiah, entry({ role: 'Father', event: 'Birth', date: '1835' }));
    expect(father.reasons).not.toContain('Born in the same year');
    expect(father.doubts).toEqual(['The person was a child then']);
  });

  it('lets a record name a child, who need not be grown', () => {
    // A marriage that names the children of the pair, a register of a household.
    const named = match(josiah, entry({ role: 'Child', event: 'Marriage', date: '1840' }));
    expect(named.doubts).toEqual([]);
    expect(named.reasons).toContain('From the years the person lived in');
    expect(match(josiah, entry({ role: 'Kind', event: 'Huwelijk', date: '1840' })).doubts).toEqual(
      [],
    );
    // Not before they were born, all the same.
    expect(match(josiah, entry({ role: 'Child', event: 'Marriage', date: '1820' })).doubts).toEqual(
      ['The record is from before the birth'],
    );
  });

  it('does not fit a record from before the birth or from after the death', () => {
    expect(match(josiah, entry({ role: 'Witness', date: '1820' }))).toMatchObject({
      band: 'unlikely',
      doubts: ['The record is from before the birth'],
    });
    expect(match(josiah, entry({ role: 'Witness', date: '1930' }))).toMatchObject({
      band: 'unlikely',
      doubts: ['The record is from after the death'],
    });
    // A year either way is allowed for.
    expect(match(josiah, entry({ role: 'Witness', date: '1911' })).doubts).toEqual([]);
  });

  it('does not word a reckoned end of a life as one the tree knows', () => {
    const noDeath: MatchSubject = { ...josiah, death: null };
    expect(match(noDeath, entry({ role: 'Witness', date: '1900' }))).toMatchObject({
      reasons: expect.arrayContaining(['From years the person may have lived in']) as string[],
      doubts: [],
    });
    expect(match(noDeath, entry({ role: 'Witness', date: '1960' })).doubts).toEqual([
      'More than 105 years after the birth',
    ]);
    const noBirth: MatchSubject = { ...josiah, birth: null };
    expect(match(noBirth, entry({ role: 'Witness', date: '1790' })).doubts).toEqual([
      'More than 105 years before the death',
    ]);
    // Without a birth, nobody can be called a child.
    expect(match(noBirth, entry({ date: '1820' })).doubts).toEqual([]);
    const undated: MatchSubject = { ...josiah, birth: null, death: null };
    expect(match(undated, entry({ date: '1500' }))).toMatchObject({ doubts: [] });
  });
});

describe('a text', () => {
  it('gets no score: nothing in it says whom it is about', () => {
    const text: TextRecord = {
      connectorId: 'example-source',
      key: 'z',
      kind: 'text',
      title: 'Josiah Marsh, his life',
      url: 'https://example.org/z',
      date: '1911',
      by: '',
      about: '',
    };
    expect(scoreRecord(josiah, text)).toBeNull();
  });
});

describe('matchBand', () => {
  it('names the bands by the score', () => {
    expect([100, 75, 74, 50, 49, 30, 29, 0].map(matchBand)).toEqual([
      'strong',
      'strong',
      'possible',
      'possible',
      'weak',
      'weak',
      'unlikely',
      'unlikely',
    ]);
  });
});

/**
 * How the bands hold on a labelled set: how much of what is shown as fitting
 * is right, and how much of what is right is shown.
 */
function measure(cases: readonly LabelledCase[]) {
  const scored = cases.map((item) => ({
    ...item,
    score: scoreRecord(item.subject, item.record)?.score ?? 0,
  }));
  const share = (part: number, whole: number) =>
    whole === 0 ? 1 : Math.round((part / whole) * 1000) / 1000;
  const at = (least: number) => {
    const shown = scored.filter((item) => item.score >= least);
    const right = shown.filter((item) => item.same).length;
    return {
      shown: shown.length,
      right,
      precision: share(right, shown.length),
      recall: share(right, scored.filter((item) => item.same).length),
    };
  };
  /** The kinds of the cases that meet a test, each with how many there are. */
  const kinds = (test: (item: (typeof scored)[number]) => boolean) =>
    Object.fromEntries(
      [
        ...scored
          .filter(test)
          .reduce(
            (counts, item) => counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1),
            new Map<string, number>(),
          ),
      ].sort(([a], [b]) => a.localeCompare(b)),
    );
  return {
    cases: scored.length,
    same: scored.filter((item) => item.same).length,
    strong: at(MATCH_STRONG),
    possible: at(MATCH_POSSIBLE),
    // What is shown as a strong fit and is someone else.
    strongAndWrong: kinds((item) => !item.same && item.score >= MATCH_STRONG),
    // What is shown as a possible fit at least and is someone else.
    shownAndWrong: kinds((item) => !item.same && item.score >= MATCH_POSSIBLE),
    // What is of the person and not shown as fitting.
    missed: kinds((item) => item.same && item.score < MATCH_POSSIBLE),
    // What cannot be of the person and is shown as fitting.
    neverShown: scored.filter((item) => item.never === true && item.score >= MATCH_POSSIBLE).length,
    // Strong fits that are wrong although something in the record could tell.
    strongWrongDecidable: scored.filter(
      (item) => !item.same && item.score >= MATCH_STRONG && item.undecidable !== true,
    ).length,
  };
}

describe('the scoring, measured on labelled cases of made-up people', () => {
  // Two sets. The first was looked at while the points were set. The second
  // is drawn from other names and places, with another seed; its kinds of
  // case are the same, so it is a second draw and no independent trial.
  const first = measure(labelledCases(1835));
  const second = measure(labelledCases(1910, 120, SECOND_LISTS));

  it('is wrong about a strong fit only where nothing in a record could tell', () => {
    for (const set of [first, second]) {
      expect(set.strongWrongDecidable).toBe(0);
      expect(set.strong.precision).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('shows nearly all that is of the person as a possible fit at least', () => {
    for (const set of [first, second]) {
      expect(set.possible.recall).toBeGreaterThanOrEqual(0.95);
      expect(set.possible.precision).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('never shows as fitting what cannot be of the person', () => {
    expect([first.neverShown, second.neverShown]).toEqual([0, 0]);
  });

  it('gives these figures; a change that makes them worse must be meant', () => {
    expect({ first, second }).toMatchInlineSnapshot(`
      {
        "first": {
          "cases": 1624,
          "missed": {},
          "neverShown": 0,
          "possible": {
            "precision": 0.995,
            "recall": 1,
            "right": 840,
            "shown": 844,
          },
          "same": 840,
          "shownAndWrong": {
            "a namesake born in the same year in the same town": 4,
          },
          "strong": {
            "precision": 0.991,
            "recall": 0.5,
            "right": 420,
            "shown": 424,
          },
          "strongAndWrong": {
            "a namesake born in the same year in the same town": 4,
          },
          "strongWrongDecidable": 0,
        },
        "second": {
          "cases": 3246,
          "missed": {},
          "neverShown": 0,
          "possible": {
            "precision": 0.996,
            "recall": 1,
            "right": 1680,
            "shown": 1686,
          },
          "same": 1680,
          "shownAndWrong": {
            "a namesake born in the same year in the same town": 6,
          },
          "strong": {
            "precision": 0.993,
            "recall": 0.5,
            "right": 840,
            "shown": 846,
          },
          "strongAndWrong": {
            "a namesake born in the same year in the same town": 6,
          },
          "strongWrongDecidable": 0,
        },
      }
    `);
  });
});
