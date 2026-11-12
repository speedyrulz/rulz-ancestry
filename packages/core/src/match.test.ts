import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_THRESHOLD,
  blockingKeys,
  jaroWinkler,
  normalizeName,
  scoreDuplicate,
  soundex,
  type MatchCandidate,
} from './match';

let nextId = 0;

/** "Given|Surname", or "Given Surname" with the last word as the surname. */
function splitName(name: string): { given: string; surname: string } {
  if (name.includes('|')) {
    const [given = '', surname = ''] = name.split('|');
    return { given, surname };
  }
  const words = name.split(' ');
  return { given: words.slice(0, -1).join(' '), surname: words.at(-1) ?? '' };
}

function person(fields: Partial<MatchCandidate> & { name?: string }): MatchCandidate {
  nextId += 1;
  return {
    id: `p${nextId}`,
    sex: 'U',
    names: [splitName(fields.name ?? 'John Smith')],
    birthYear: null,
    deathYear: null,
    birthPlace: '',
    deathPlace: '',
    parentIds: [],
    parentNames: [],
    partnerIds: [],
    partnerNames: [],
    ...fields,
  };
}

describe('normalizeName', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalizeName('  Müller-Lüdenscheidt ')).toBe('muller ludenscheidt');
    expect(normalizeName("O'Brien")).toBe('o brien');
    expect(normalizeName('JOSÉ  María')).toBe('jose maria');
    expect(normalizeName(' . ')).toBe('');
  });
});

describe('soundex', () => {
  it('gives the standard codes', () => {
    const codes = Object.fromEntries(
      ['Robert', 'Rupert', 'Rubin', 'Ashcraft', 'Ashcroft', 'Tymczak', 'Pfister', 'Honeyman'].map(
        (name) => [name, soundex(name)],
      ),
    );
    expect(codes).toEqual({
      Robert: 'R163',
      Rupert: 'R163',
      Rubin: 'R150',
      Ashcraft: 'A261',
      Ashcroft: 'A261',
      Tymczak: 'T522',
      Pfister: 'P236',
      Honeyman: 'H555',
    });
  });

  it('ignores accents and has nothing for a word without letters', () => {
    expect(soundex('Müller')).toBe(soundex('Muller'));
    expect(soundex('')).toBe('');
    expect(soundex('123')).toBe('');
  });
});

describe('jaroWinkler', () => {
  it('matches the published examples', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 3);
  });

  it('is 1 for equal text and 0 for nothing in common', () => {
    expect(jaroWinkler('smith', 'smith')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('', 'smith')).toBe(0);
    expect(jaroWinkler('', '')).toBe(0);
  });
});

describe('scoreDuplicate', () => {
  it('scores the same name alone as just worth showing', () => {
    const result = scoreDuplicate(person({}), person({}));
    expect(result?.score).toBe(DUPLICATE_THRESHOLD);
    expect(result?.reasons).toEqual(['Same name']);
  });

  it('scores the same name, year and place as very likely', () => {
    const a = person({ birthYear: 1850, birthPlace: 'Leeds, Yorkshire, England', deathYear: 1921 });
    const b = person({ birthYear: 1850, birthPlace: 'Leeds, England', deathYear: 1921 });
    const result = scoreDuplicate(a, b);
    expect(result?.score).toBeGreaterThanOrEqual(80);
    expect(result?.reasons).toEqual([
      'Same name',
      'Born in the same year',
      'Died in the same year',
      'Same place of birth',
    ]);
  });

  it('accepts a year or two between the dates, for less', () => {
    const exact = scoreDuplicate(person({ birthYear: 1850 }), person({ birthYear: 1850 }));
    const near = scoreDuplicate(person({ birthYear: 1850 }), person({ birthYear: 1851 }));
    const far = scoreDuplicate(person({ birthYear: 1850 }), person({ birthYear: 1858 }));
    expect(near?.reasons).toContain('Born a year apart');
    expect(exact?.score ?? 0).toBeGreaterThan(near?.score ?? 0);
    expect(near?.score ?? 0).toBeGreaterThan(far?.score ?? 0);
    expect(far?.score ?? 100).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('rules out people who cannot be the same', () => {
    expect(scoreDuplicate(person({ sex: 'M' }), person({ sex: 'F' }))).toBeNull();
    expect(scoreDuplicate(person({ birthYear: 1800 }), person({ birthYear: 1830 }))).toBeNull();
    expect(scoreDuplicate(person({ deathYear: 1900 }), person({ deathYear: 1950 }))).toBeNull();
    expect(
      scoreDuplicate(person({ name: 'John Smith' }), person({ name: 'Mary Jones' })),
    ).toBeNull();

    const parent = person({});
    expect(scoreDuplicate(parent, person({ parentIds: [parent.id] }))).toBeNull();
    const partner = person({});
    expect(scoreDuplicate(partner, person({ partnerIds: [partner.id] }))).toBeNull();
    expect(scoreDuplicate(parent, parent)).toBeNull();
  });

  it('accepts a sex that is not known on one side', () => {
    expect(scoreDuplicate(person({ sex: 'M' }), person({ sex: 'U' }))).not.toBeNull();
  });

  it('reads an initial as the name it may stand for', () => {
    const result = scoreDuplicate(
      person({ name: 'J Smith', birthYear: 1850 }),
      person({ name: 'John Smith', birthYear: 1850 }),
    );
    expect(result?.reasons[0]).toBe('Similar name');
    expect(result?.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('finds a spelling variant of both names', () => {
    const result = scoreDuplicate(
      person({ name: 'Catherine Meyer', birthYear: 1850 }),
      person({ name: 'Katharine Meier', birthYear: 1850 }),
    );
    expect(result?.score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('compares every name a person has', () => {
    const married = person({
      names: [
        { given: 'Mary', surname: 'Jones' },
        { given: 'Mary', surname: 'Smith' },
      ],
    });
    expect(scoreDuplicate(married, person({ name: 'Mary Smith' }))?.reasons).toContain('Same name');
  });

  it('tells two children of one family apart by their years of birth', () => {
    const georg = person({ name: 'Johann Georg|Bauer', birthYear: 1801, parentIds: ['f', 'm'] });
    const peter = person({ name: 'Johann Peter|Bauer', birthYear: 1804, parentIds: ['f', 'm'] });
    const result = scoreDuplicate(georg, peter);
    expect(result?.score).toBeLessThan(DUPLICATE_THRESHOLD);
    expect(result?.reasons).toContain('Children of the same parents, born in different years');

    const twice = scoreDuplicate(
      person({ birthYear: 1801, parentIds: ['f', 'm'] }),
      person({ birthYear: 1801, parentIds: ['f', 'm'] }),
    );
    expect(twice?.reasons).toContain('Same parents');
    expect(twice?.score).toBeGreaterThanOrEqual(80);
  });

  it('counts relatives with the same names, as when a whole branch was entered twice', () => {
    const a = person({ parentNames: ['Thomas Smith', 'Ann Lee'], partnerNames: ['Mary Hill'] });
    const b = person({ parentNames: ['thomas smith'], partnerNames: ['Mary  Hill'] });
    const result = scoreDuplicate(a, b);
    expect(result?.reasons).toEqual([
      'Same name',
      'A parent with the same name',
      'A partner with the same name',
    ]);
    expect(result?.score).toBe(68);
  });

  it('needs the same whole name when a part of it is missing', () => {
    expect(scoreDuplicate(person({ name: '|Smith' }), person({ name: '|Smith' }))).not.toBeNull();
    expect(scoreDuplicate(person({ name: '|Smith' }), person({ name: 'John|Smith' }))).toBeNull();
    expect(scoreDuplicate(person({ name: '|' }), person({ name: '|' }))).toBeNull();
  });
});

describe('blockingKeys', () => {
  const keys = (given: string, surname: string) => blockingKeys({ names: [{ given, surname }] });
  const share = (a: string[], b: string[]) => a.some((key) => b.includes(key));

  it('puts the usual spelling variants of a surname in one group', () => {
    expect(share(keys('Ann', 'Meyer'), keys('Ann', 'Meier'))).toBe(true);
    expect(share(keys('Ann', 'Thompson'), keys('Ann', 'Thomson'))).toBe(true);
    expect(share(keys('Ann', 'Kramer'), keys('Ann', 'Cramer'))).toBe(true);
    expect(share(keys('Ann', 'Smith'), keys('Ann', 'Jones'))).toBe(false);
  });

  it('groups a name with a part missing by the whole of it', () => {
    expect(share(keys('', 'Smith'), keys('', 'smith'))).toBe(true);
    expect(share(keys('', 'Smith'), keys('John', 'Smith'))).toBe(false);
    expect(keys('', '')).toEqual([]);
  });
});
