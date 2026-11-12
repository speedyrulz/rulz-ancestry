import { describe, expect, it } from 'vitest';
import {
  compareCloseness,
  kinshipTerm,
  ordinal,
  relationshipTerm,
  type BloodRelation,
} from './kinship';
import type { Sex } from './model';

const term = (up: number, down: number, sex: Sex = 'U', half = false): string =>
  kinshipTerm({ up, down, half }, sex);

describe('ordinal', () => {
  it('writes a number with its ending', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
    ]);
  });
});

describe('kinshipTerm', () => {
  it('names ancestors, counting the greats from the second on', () => {
    expect(term(1, 0, 'M')).toBe('father');
    expect(term(1, 0, 'F')).toBe('mother');
    expect(term(1, 0)).toBe('parent');
    expect(term(2, 0, 'F')).toBe('grandmother');
    expect(term(3, 0, 'M')).toBe('great-grandfather');
    expect(term(4, 0, 'M')).toBe('2nd great-grandfather');
    expect(term(5, 0, 'F')).toBe('3rd great-grandmother');
    expect(term(14, 0)).toBe('12th great-grandparent');
  });

  it('names descendants the same way', () => {
    expect(term(0, 1, 'F')).toBe('daughter');
    expect(term(0, 1, 'M')).toBe('son');
    expect(term(0, 2, 'X')).toBe('grandchild');
    expect(term(0, 3, 'M')).toBe('great-grandson');
    expect(term(0, 4, 'F')).toBe('2nd great-granddaughter');
  });

  it('names brothers and sisters, and half ones', () => {
    expect(term(1, 1, 'M')).toBe('brother');
    expect(term(1, 1, 'F')).toBe('sister');
    expect(term(1, 1)).toBe('sibling');
    expect(term(1, 1, 'F', true)).toBe('half-sister');
  });

  it('names the brothers and sisters of ancestors', () => {
    expect(term(2, 1, 'M')).toBe('uncle');
    expect(term(2, 1, 'F')).toBe('aunt');
    expect(term(2, 1)).toBe('aunt or uncle');
    expect(term(3, 1, 'F')).toBe('grandaunt');
    expect(term(4, 1, 'M')).toBe('great-granduncle');
    expect(term(5, 1, 'F')).toBe('2nd great-grandaunt');
    expect(term(2, 1, 'M', true)).toBe('half-uncle');
  });

  it('names the descendants of brothers and sisters', () => {
    expect(term(1, 2, 'M')).toBe('nephew');
    expect(term(1, 2, 'F')).toBe('niece');
    expect(term(1, 2)).toBe('niece or nephew');
    expect(term(1, 3, 'F')).toBe('grandniece');
    expect(term(1, 4, 'M')).toBe('great-grandnephew');
    expect(term(1, 5, 'M')).toBe('2nd great-grandnephew');
  });

  it('names cousins by degree and by generations apart', () => {
    expect(term(2, 2)).toBe('first cousin');
    expect(term(3, 3)).toBe('second cousin');
    expect(term(4, 4)).toBe('third cousin');
    expect(term(2, 3)).toBe('first cousin once removed');
    expect(term(3, 2)).toBe('first cousin once removed');
    expect(term(4, 2)).toBe('first cousin twice removed');
    expect(term(2, 5)).toBe('first cousin 3 times removed');
    expect(term(3, 4)).toBe('second cousin once removed');
    expect(term(11, 11)).toBe('tenth cousin');
    expect(term(12, 12)).toBe('11th cousin');
    expect(term(2, 2, 'F', true)).toBe('half first cousin');
  });

  it('says so when both counts are zero', () => {
    expect(term(0, 0)).toBe('the same person');
  });
});

describe('relationshipTerm', () => {
  const blood = (up: number, down: number, half = false): BloodRelation => ({ up, down, half });

  it('names partners, as husband and wife only when a marriage is recorded', () => {
    expect(relationshipTerm({ kind: 'partner', married: true }, 'F')).toBe('wife');
    expect(relationshipTerm({ kind: 'partner', married: true }, 'M')).toBe('husband');
    expect(relationshipTerm({ kind: 'partner', married: true }, 'U')).toBe('spouse');
    expect(relationshipTerm({ kind: 'partner', married: false }, 'F')).toBe('partner');
  });

  it('gives the partner of a parent, a child or a sibling its own name', () => {
    const of = (relation: BloodRelation, sex: Sex) =>
      relationshipTerm(
        { kind: 'partner-of-relative', married: true, viaSex: 'U', ...relation },
        sex,
      );
    expect(of(blood(1, 0), 'F')).toBe('stepmother');
    expect(of(blood(1, 0), 'M')).toBe('stepfather');
    expect(of(blood(0, 1), 'M')).toBe('son-in-law');
    expect(of(blood(0, 1), 'F')).toBe('daughter-in-law');
    expect(of(blood(1, 1), 'F')).toBe('sister-in-law');
  });

  it('describes the partner of any other relative', () => {
    expect(
      relationshipTerm(
        { kind: 'partner-of-relative', married: true, viaSex: 'F', ...blood(2, 2) },
        'M',
      ),
    ).toBe('husband of a first cousin');
    expect(
      relationshipTerm(
        { kind: 'partner-of-relative', married: true, viaSex: 'M', ...blood(2, 1) },
        'F',
      ),
    ).toBe('wife of an uncle');
    expect(
      relationshipTerm(
        { kind: 'partner-of-relative', married: false, viaSex: 'F', ...blood(1, 2) },
        'M',
      ),
    ).toBe('partner of a niece');
  });

  it('names the close relatives of a partner, and describes the others', () => {
    const of = (relation: BloodRelation, sex: Sex, married = true, viaSex: Sex = 'F') =>
      relationshipTerm({ kind: 'relative-of-partner', married, viaSex, ...relation }, sex);
    expect(of(blood(1, 0), 'M')).toBe('father-in-law');
    expect(of(blood(1, 0), 'F')).toBe('mother-in-law');
    expect(of(blood(0, 1), 'F')).toBe('stepdaughter');
    expect(of(blood(1, 1), 'M')).toBe('brother-in-law');
    expect(of(blood(2, 0), 'M')).toBe("wife's grandfather");
    expect(of(blood(2, 2), 'F', false)).toBe("partner's first cousin");
    expect(of(blood(1, 1, true), 'M', true, 'M')).toBe("husband's half-brother");
  });

  it('passes a blood relationship through, and has nothing to say of none', () => {
    expect(relationshipTerm({ kind: 'blood', ...blood(2, 0) }, 'F')).toBe('grandmother');
    expect(relationshipTerm({ kind: 'self' }, 'F')).toBe('the same person');
    expect(relationshipTerm({ kind: 'none' }, 'F')).toBe('');
  });
});

describe('compareCloseness', () => {
  it('puts the closest relationship first', () => {
    const relations: BloodRelation[] = [
      { up: 3, down: 3, half: false },
      { up: 2, down: 2, half: true },
      { up: 1, down: 1, half: false },
      { up: 2, down: 2, half: false },
      { up: 1, down: 3, half: false },
    ];
    expect(
      relations.sort(compareCloseness).map((r) => `${r.up}-${r.down}${r.half ? 'h' : ''}`),
    ).toEqual(['1-1', '2-2', '2-2h', '1-3', '3-3']);
  });
});
