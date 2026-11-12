import { describe, expect, it } from 'vitest';
import {
  patchChildLine,
  patchChildOf,
  patchLiving,
  patchSex,
  readLiving,
  readPedigree,
  readSex,
} from './fields';
import { fresh, ged, one, show } from './testing';

describe('sex', () => {
  it('reads the four known values and anything else as not known', () => {
    expect(readSex(one('1 SEX M'))).toBe('M');
    expect(readSex(one('1 SEX f'))).toBe('F');
    expect(readSex(one('1 SEX X'))).toBe('X');
    expect(readSex(one('1 SEX U'))).toBe('U');
    expect(readSex(one('1 SEX Male'))).toBe('U');
    expect(readSex(one('1 SEX'))).toBe('U');
  });

  it('keeps the imported line while the sex is what the line said', () => {
    const odd = one('1 SEX Male');
    expect(patchSex(odd, 'U')).toBe(odd);
    expect(show(patchSex(odd, 'M') ?? odd)).toBe('1 SEX M');
  });

  it('writes a line for a new person only when the sex is known', () => {
    expect(patchSex(null, 'U')).toBeNull();
    const node = patchSex(null, 'F');
    expect(node && fresh(node)).toBe('1 SEX F');
  });
});

describe('the living flag', () => {
  it('reads only the values the app itself writes', () => {
    expect(readLiving(one('1 _LIVING Y'))).toBe(true);
    expect(readLiving(one('1 _LIVING N'))).toBe(false);
    expect(readLiving(one('1 _LIVING maybe'))).toBeNull();
  });

  it('writes, changes and removes the line', () => {
    expect(patchLiving(null, null)).toBeNull();
    const made = patchLiving(null, true);
    expect(made && fresh(made)).toBe('1 _LIVING Y');

    const original = one('1 _LIVING Y');
    expect(patchLiving(original, true)).toBe(original);
    const changed = patchLiving(original, false);
    expect(changed && show(changed)).toBe('1 _LIVING N');
    expect(patchLiving(original, null)).toBeNull();
  });
});

describe('readPedigree', () => {
  it('reads the standard PEDI line in either version', () => {
    expect(readPedigree(one(ged('1 FAMC @F1@', '2 PEDI adopted')), null)).toBe('adopted');
    expect(readPedigree(one(ged('1 FAMC @F1@', '2 PEDI FOSTER'), '7.0'), null)).toBe('foster');
    expect(
      readPedigree(one(ged('1 FAMC @F1@', '2 PEDI OTHER', '3 PHRASE Step'), '7.0'), null),
    ).toBe('step');
    expect(readPedigree(one(ged('1 FAMC @F1@', '2 PEDI guardian')), null)).toBe('other');
    expect(readPedigree(one('1 FAMC @F1@'), null)).toBe('birth');
    expect(readPedigree(null, null)).toBe('birth');
  });

  it("reads Ancestry's relationship lines under the family's CHIL line", () => {
    const natural = one(ged('1 CHIL @I1@', '2 _FREL Natural', '2 _MREL Natural'));
    expect(readPedigree(null, natural)).toBe('birth');
    const adopted = one(ged('1 CHIL @I1@', '2 _FREL Adopted', '2 _MREL Adopted'));
    expect(readPedigree(one('1 FAMC @F1@'), adopted)).toBe('adopted');
    // The birth child of one parent and the stepchild of the other.
    const mixed = one(ged('1 CHIL @I1@', '2 _FREL Step', '2 _MREL Natural'));
    expect(readPedigree(null, mixed)).toBe('birth');
    const step = one(ged('1 CHIL @I1@', '2 _FREL Step', '2 _MREL Unknown'));
    expect(readPedigree(null, step)).toBe('step');
    expect(readPedigree(null, one('1 CHIL @I1@'))).toBe('birth');
  });

  it('lets the standard line win over the relationship lines', () => {
    const famc = one(ged('1 FAMC @F1@', '2 PEDI foster'));
    const chil = one(ged('1 CHIL @I1@', '2 _FREL Adopted'));
    expect(readPedigree(famc, chil)).toBe('foster');
  });
});

describe('patchChildOf', () => {
  it('writes a new link, with the kind only when it is not birth', () => {
    expect(fresh(patchChildOf(null, 'F1', 'birth', null, '5.5.1'))).toBe('1 FAMC @F1@');
    expect(fresh(patchChildOf(null, 'F1', 'adopted', null, '5.5.1'))).toBe(
      ged('1 FAMC @F1@', '2 PEDI adopted'),
    );
    expect(fresh(patchChildOf(null, 'F1', 'adopted', null, '7.0'), '7.0')).toBe(
      ged('1 FAMC @F1@', '2 PEDI ADOPTED'),
    );
    // "Step" is not in the 7.0 list, so it is written as OTHER with a phrase.
    const step = patchChildOf(null, 'F1', 'step', null, '7.0');
    expect(fresh(step, '7.0')).toBe(ged('1 FAMC @F1@', '2 PEDI OTHER', '3 PHRASE step'));
    expect(readPedigree(step, null)).toBe('step');
  });

  it('keeps an imported link as it was until the kind changes', () => {
    const original = one(ged('1 FAMC @F1@', '2 PEDI Adopted', '2 NOTE By her aunt.'));
    expect(patchChildOf(original, 'F1', 'adopted', 'adopted', '5.5.1')).toBe(original);
    expect(show(patchChildOf(original, 'F1', 'foster', 'adopted', '5.5.1'))).toBe(
      ged('1 FAMC @F1@', '2 PEDI foster', '2 NOTE By her aunt.'),
    );
  });
});

describe('patchChildLine', () => {
  it('brings relationship lines in step with a changed kind, and otherwise changes nothing', () => {
    expect(fresh(patchChildLine(null, 'I1', 'adopted', null))).toBe('1 CHIL @I1@');

    const original = one(ged('1 CHIL @I1@', '2 _FREL Natural', '2 _MREL Natural'));
    expect(patchChildLine(original, 'I1', 'birth', 'birth')).toBe(original);
    const changed = patchChildLine(original, 'I1', 'adopted', 'birth');
    expect(show(changed)).toBe(ged('1 CHIL @I1@', '2 _FREL Adopted', '2 _MREL Adopted'));
    expect(readPedigree(null, changed)).toBe('adopted');

    const plain = one('1 CHIL @I1@');
    expect(patchChildLine(plain, 'I1', 'adopted', 'birth')).toBe(plain);
  });
});
