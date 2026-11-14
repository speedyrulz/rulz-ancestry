import type { Sex } from './model';
import type { MatchSubject } from './recordmatch';
import type { EventRecord, ExternalRecord, PersonRecord } from './records';

/**
 * A labelled set of cases for the scoring of search results: a person of a
 * tree, a result, and whether the result is of that person. Used by the test
 * only; nothing of it is part of the app.
 *
 * Every person here is made up. The names and places come from the lists
 * below, which were written for this file, and the rest is drawn by a
 * generator from a seed, so that a run can be repeated. No real tree was
 * looked at.
 *
 * What such a set can show is whether the scoring keeps the cases apart that
 * it was built to keep apart, and whether a later change makes that worse. It
 * cannot show how often the scoring is right for real records: how the cases
 * are spread is the choice of whoever wrote the generator, and the same hand
 * wrote the scoring.
 */

export interface LabelledCase {
  /** What kind of case it is, for the report of a failure. */
  kind: string;
  subject: MatchSubject;
  record: ExternalRecord;
  /** Whether the record is of the person. */
  same: boolean;
  /**
   * True for a record that cannot be of the person on its face: before the
   * birth, the other sex. Such a one must never be shown as fitting.
   */
  never?: boolean;
  /**
   * True for a pair that nothing in the record tells apart from the person,
   * although it is someone else: two of one name, born in one year in one
   * town. The scoring is bound to take it for a fit; it is here so that the
   * figures do not flatter.
   */
  undecidable?: boolean;
}

/** The names and places a set is drawn from. */
export interface NameLists {
  givenM: readonly string[];
  givenF: readonly string[];
  surnames: readonly string[];
  /** Towns, two to a county, each written "town, county, state". */
  places: readonly string[];
}

/** The lists the points were set with. */
export const FIRST_LISTS: NameLists = {
  givenM: ['Josiah', 'Tobias', 'Ambrose', 'Lucius', 'Silas', 'Barnaby', 'Phineas', 'Ezekiel'],
  givenF: ['Henrietta', 'Lavinia', 'Octavia', 'Mehitabel', 'Clarissa', 'Drusilla', 'Philippa'],
  surnames: [
    'Marsh',
    'Fenwick',
    'Tolliver',
    'Brackett',
    'Quimby',
    'Hallowell',
    'Winslow',
    'Garrick',
    'Dunmore',
    'Thackwell',
    'Penhallow',
    'Crowhurst',
  ],
  places: [
    'Ashford, Example County, Vermont',
    'Millbrook, Example County, Vermont',
    'Stonehaven, Sample County, Maine',
    'Larkfield, Sample County, Maine',
    'Voorbeeldstad, Noord-Voorbeeld, Nederland',
    'Proefdorp, Noord-Voorbeeld, Nederland',
  ],
};

/**
 * Other names and places, which no case was drawn from while the points were
 * set. A set made from them shows whether the scoring leans on the first
 * lists; the kinds of case are the same, so it shows no more than that.
 */
export const SECOND_LISTS: NameLists = {
  givenM: ['Cornelis', 'Leander', 'Thaddeus', 'Gideon', 'Horatio', 'Jasper', 'Willem'],
  givenF: ['Wilhelmina', 'Theodora', 'Cordelia', 'Geertruida', 'Rosalind', 'Seraphina'],
  surnames: [
    'Ravenscroft',
    'Oakhampton',
    'van Voorbeeld',
    'de Proef',
    'Lindqvist',
    'Harrowgate',
    'Bellweather',
    'Kingsmere',
    'Ostrander',
    'Whitlock',
  ],
  places: [
    'Fernley, Model County, Nebraska',
    'Greywater, Model County, Nebraska',
    'Northfold, Pattern County, Kansas',
    'Elmstead, Pattern County, Kansas',
    'Voorbeeldburg, Oost-Voorbeeld, Nederland',
    'Proefwijk, Oost-Voorbeeld, Nederland',
  ],
};

/** A small generator of numbers from a seed (mulberry32), so that a set can be made again. */
function numbersFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A surname as a clerk might have written it: a letter doubled, dropped or changed. */
function misspelt(surname: string, pick: number): string {
  const ways = [
    (name: string) => name.replace(/ll/, 'l'),
    (name: string) => name.replace(/ck/, 'k'),
    (name: string) => name.replace(/w/, 'u'),
    (name: string) => `${name}e`,
    (name: string) => name.replace(/y$/, 'ey'),
    (name: string) => name.replace(/([aeiou])([^aeiou ])/, '$1$2$2'),
  ];
  for (let index = 0; index < ways.length; index += 1) {
    const changed = ways[(pick + index) % ways.length]?.(surname) ?? surname;
    if (changed !== surname) return changed;
  }
  return `${surname}s`;
}

interface Made {
  given: string;
  middle: string;
  surname: string;
  sex: Sex;
  born: number;
  died: number;
  bornAt: string;
  diedAt: string;
}

function subjectOf(person: Made): MatchSubject {
  return {
    sex: person.sex,
    names: [{ given: `${person.given} ${person.middle}`.trim(), surname: person.surname }],
    birth: { min: person.born, max: person.born },
    death: { min: person.died, max: person.died },
    birthPlace: person.bornAt,
    deathPlace: person.diedAt,
    places: [...new Set([person.bornAt, person.diedAt])],
  };
}

interface Dates {
  /** A year, or a date in the wording of a GEDCOM file. */
  born?: number | string;
  died?: number | string;
  bornAt?: string;
  diedAt?: string;
}

function profile(name: string, dates: Dates, sex: 'M' | 'F' | null): PersonRecord {
  return {
    connectorId: 'example-source',
    key: 'x',
    kind: 'person',
    title: name,
    url: 'https://example.org/x',
    sex,
    about: '',
    facts: [
      ...(dates.born === undefined
        ? []
        : [{ type: 'birth' as const, date: String(dates.born), place: dates.bornAt ?? '' }]),
      ...(dates.died === undefined
        ? []
        : [{ type: 'death' as const, date: String(dates.died), place: dates.diedAt ?? '' }]),
    ],
  };
}

function entry(
  name: string,
  role: string,
  event: string,
  year: number,
  place: string,
): EventRecord {
  return {
    connectorId: 'example-archive',
    key: 'y',
    kind: 'event',
    title: name,
    url: 'https://example.org/y',
    role,
    event,
    date: String(year),
    place,
    held: 'Civil registration, Example Archive',
  };
}

/** What stands after the town in a place: its county and its state. */
const countyOf = (place: string) => place.split(',').slice(1).join(',');

/**
 * The cases of one made-up person: results that are of them, in the ways a
 * source words and misspells them, and results of others that a search for
 * their name brings up.
 */
function casesOf(person: Made, next: () => number, lists: NameLists): LabelledCase[] {
  const subject = subjectOf(person);
  const sex = person.sex === 'M' || person.sex === 'F' ? person.sex : null;
  const full = `${person.given} ${person.middle} ${person.surname}`.replace(/\s+/g, ' ');
  const short = `${person.given} ${person.surname}`;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  // A town of another county, and the other town of the county of birth.
  const elsewhere = pick(
    lists.places.filter((place) => countyOf(place) !== countyOf(person.bornAt)),
  );
  const nextTown =
    lists.places.find(
      (place) => place !== person.bornAt && countyOf(place) === countyOf(person.bornAt),
    ) ?? elsewhere;
  const otherGiven = pick(
    (person.sex === 'F' ? lists.givenF : lists.givenM).filter((name) => name !== person.given),
  );
  const otherSurname = pick(lists.surnames.filter((name) => name !== person.surname));
  const yes = (kind: string, record: ExternalRecord): LabelledCase => ({
    kind,
    subject,
    record,
    same: true,
  });
  const no = (
    kind: string,
    record: ExternalRecord,
    extra: Partial<LabelledCase> = {},
  ): LabelledCase => ({ kind, subject, record, same: false, ...extra });

  return [
    // --- Of the person.
    yes(
      'a profile with the same name and dates',
      profile(
        full,
        { born: person.born, died: person.died, bornAt: person.bornAt, diedAt: person.diedAt },
        sex,
      ),
    ),
    yes(
      'a profile with the surname misspelt and the birth a year off',
      profile(
        `${person.given} ${misspelt(person.surname, Math.floor(next() * 6))}`,
        { born: person.born + (next() < 0.5 ? 1 : -1), died: person.died },
        sex,
      ),
    ),
    yes(
      'a profile with an initial for the given name, and the birth alone',
      profile(`${person.given[0] ?? ''}. ${person.surname}`, { born: person.born }, null),
    ),
    yes('a profile with the name and nothing else', profile(short, {}, null)),
    yes(
      'a profile with the death two years off and no place',
      profile(short, { born: person.born, died: person.died + 2 }, sex),
    ),
    yes(
      'a profile with a suffix after the name',
      profile(`${full} Jr`, { born: person.born, died: person.died }, sex),
    ),
    yes(
      'a profile with a title before the name',
      profile(`Dr. ${short}`, { born: person.born, bornAt: person.bornAt }, sex),
    ),
    yes(
      'a profile whose birth the source gives as before a year',
      profile(short, { born: `BEF ${person.born + 3}`, died: person.died }, sex),
    ),
    yes(
      'a profile whose dates the source gives as about a year',
      profile(short, { born: `ABT ${person.born}`, died: `ABT ${person.died}` }, sex),
    ),
    yes('the record of the birth', entry(short, 'Child', 'Birth', person.born, person.bornAt)),
    yes('the record of the death', entry(short, 'Deceased', 'Death', person.died, person.diedAt)),
    yes(
      'the record of the marriage',
      entry(
        short,
        person.sex === 'F' ? 'Bride' : 'Groom',
        'Marriage',
        person.born + 22 + Math.floor(next() * 12),
        person.bornAt,
      ),
    ),
    yes(
      'a record that names the person as a witness',
      entry(
        short,
        'Witness',
        'Marriage',
        Math.min(person.died, person.born + 30 + Math.floor(next() * 20)),
        elsewhere,
      ),
    ),
    yes(
      'a record of a marriage that names the person as a child',
      entry(short, 'Child', 'Marriage', person.born + 4, person.bornAt),
    ),

    // --- Of someone else.
    no(
      'a namesake a generation later',
      profile(
        short,
        { born: person.born + 28, died: person.died + 28, bornAt: person.bornAt },
        sex,
      ),
    ),
    no(
      'a namesake of another century',
      profile(short, { born: person.born - 120, died: person.died - 120 }, sex),
    ),
    no(
      'a namesake born six years later',
      profile(short, { born: person.born + 6, died: person.died + 9, bornAt: person.bornAt }, sex),
    ),
    no(
      'a namesake born in the same year elsewhere, who died much later',
      profile(short, { born: person.born, died: person.died + 21, bornAt: elsewhere }, sex),
    ),
    no(
      'a namesake born two years apart in the next town, who died much later',
      profile(short, { born: person.born + 2, died: person.died + 14, bornAt: nextTown }, sex),
    ),
    no(
      'a namesake the source says was born after a much later year',
      profile(short, { born: `AFT ${person.born + 30}` }, sex),
      { never: true },
    ),
    no(
      'someone whose middle name begins like the surname',
      profile(
        `${person.given} ${person.surname.split(' ').at(-1) ?? ''}all ${otherSurname}`,
        { born: person.born, bornAt: person.bornAt },
        sex,
      ),
    ),
    no(
      'a brother or sister',
      profile(
        `${otherGiven} ${person.surname}`,
        { born: person.born + 2, died: person.died, bornAt: person.bornAt },
        sex,
      ),
    ),
    no(
      'someone of the same given name and another family',
      profile(`${person.given} ${otherSurname}`, { born: person.born, died: person.died }, sex),
    ),
    no(
      'a child of the same name, born a generation later',
      entry(short, 'Child', 'Birth', person.born + 30, person.bornAt),
    ),
    no(
      'a witness of the same name, before the person was born',
      entry(short, 'Witness', 'Marriage', person.born - 20, person.bornAt),
      { never: true },
    ),
    no(
      'someone of the same name who died long after',
      entry(short, 'Deceased', 'Death', person.died + 40, person.diedAt),
      { never: true },
    ),
    ...(sex === null
      ? []
      : [
          no(
            'a bride or groom of the same name and the other sex',
            entry(
              short,
              sex === 'F' ? 'Groom' : 'Bride',
              'Marriage',
              person.born + 25,
              person.bornAt,
            ),
            { never: true },
          ),
        ]),
    // One in twenty: two of one name, born in one year in one town. Nothing
    // tells them apart, and the set says so.
    ...(next() < 0.05
      ? [
          no(
            'a namesake born in the same year in the same town',
            profile(short, { born: person.born, bornAt: person.bornAt }, sex),
            { undecidable: true },
          ),
        ]
      : []),
  ];
}

/** A labelled set of cases, the same for the same seed and the same lists. */
export function labelledCases(
  seed: number,
  people = 60,
  lists: NameLists = FIRST_LISTS,
): LabelledCase[] {
  const next = numbersFrom(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const cases: LabelledCase[] = [];
  for (let index = 0; index < people; index += 1) {
    const sex: Sex = next() < 0.5 ? 'M' : 'F';
    const givens = sex === 'F' ? lists.givenF : lists.givenM;
    const given = pick(givens);
    const born = 1700 + Math.floor(next() * 200);
    const bornAt = pick(lists.places);
    cases.push(
      ...casesOf(
        {
          given,
          middle: next() < 0.4 ? pick(givens.filter((name) => name !== given)) : '',
          surname: pick(lists.surnames),
          sex,
          born,
          died: born + 35 + Math.floor(next() * 55),
          bornAt,
          diedAt: next() < 0.6 ? bornAt : pick(lists.places),
        },
        next,
        lists,
      ),
    );
  }
  return cases;
}
