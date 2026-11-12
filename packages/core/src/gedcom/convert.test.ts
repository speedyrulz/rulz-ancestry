import { describe, expect, it } from 'vitest';
import { convertVersion } from './convert';
import type { GedcomVersion } from './node';
import { parseFragment } from './parse';
import { ged } from './testing';
import { writeLines } from './write';

/** Converts GEDCOM text from one version to the other and returns it as text. */
function convert(text: string, from: GedcomVersion, to: GedcomVersion): string {
  const records = parseFragment(text, from);
  convertVersion(records, to);
  return writeLines(records, 0, { version: to }).join('\n');
}

const toSeven = (text: string) => convert(text, '5.5.1', '7.0');
const toFive = (text: string) => convert(text, '7.0', '5.5.1');

describe('converting 5.5.1 to 7.0', () => {
  it('turns note records and links to them into shared notes', () => {
    expect(
      toSeven(
        ged('0 @N1@ NOTE A note of its own', '0 @I1@ INDI', '1 NOTE @N1@', '1 NOTE Written here'),
      ),
    ).toBe(
      ged('0 @N1@ SNOTE A note of its own', '0 @I1@ INDI', '1 SNOTE @N1@', '1 NOTE Written here'),
    );
  });

  it('rewrites dates everywhere, not only in events', () => {
    expect(
      toSeven(
        ged(
          '0 @I1@ INDI',
          '1 BIRT',
          '2 DATE @#DJULIAN@ 3 Feb 1700',
          '2 SOUR @S1@',
          '3 DATA',
          '4 DATE (about harvest)',
          '1 CHAN',
          '2 DATE 11 FEB 1731/32',
        ),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 DATE JULIAN 3 FEB 1700',
        '2 SOUR @S1@',
        '3 DATA',
        '4 DATE',
        '5 PHRASE about harvest',
        '1 CHAN',
        '2 DATE JULIAN 11 FEB 1732',
        '3 PHRASE 11 FEB 1731/32',
      ),
    );
  });

  it('writes values from fixed lists in capitals, or as OTHER with a phrase', () => {
    expect(
      toSeven(
        ged(
          '0 @I1@ INDI',
          '1 NAME A /B/',
          '2 TYPE married',
          '1 NAME C /D/',
          '2 TYPE religious',
          '1 SEX f',
          '1 RESN privacy',
          '1 FAMC @F1@',
          '2 PEDI adopted',
          '2 STAT proven',
          '1 FAMC @F2@',
          '2 PEDI step',
        ),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 NAME A /B/',
        '2 TYPE MARRIED',
        '1 NAME C /D/',
        '2 TYPE OTHER',
        '3 PHRASE religious',
        '1 SEX F',
        '1 RESN PRIVACY',
        '1 FAMC @F1@',
        '2 PEDI ADOPTED',
        '2 STAT PROVEN',
        '1 FAMC @F2@',
        '2 PEDI OTHER',
        '3 PHRASE step',
      ),
    );
  });

  it('keeps tags that 7.0 dropped under a tag of the app’s own', () => {
    expect(
      toSeven(ged('0 @I1@ INDI', '1 RIN 12', '1 AFN 1234-AB', '1 NAME A /B/', '2 ROMN A /B/')),
    ).toBe(ged('0 @I1@ INDI', '1 _RIN 12', '1 _AFN 1234-AB', '1 NAME A /B/', '2 _ROMN A /B/'));
  });

  it('writes a file format as a media type, and the kind of medium as MEDI', () => {
    expect(
      toSeven(
        ged('0 @O1@ OBJE', '1 FILE photo.JPG', '2 FORM jpg', '3 TYPE photo', '2 TITL Portrait'),
      ),
    ).toBe(
      ged(
        '0 @O1@ OBJE',
        '1 FILE photo.JPG',
        '2 FORM image/jpeg',
        '3 MEDI PHOTO',
        '2 TITL Portrait',
      ),
    );
  });

  it('counts what it has no rule for and leaves it as it is', () => {
    const records = parseFragment(
      ged('0 @I1@ INDI', '1 OBJE', '2 FILE a.xyz', '2 FORM xyz'),
      '5.5.1',
    );
    const result = convertVersion(records, '7.0');
    expect(result.unconverted).toEqual({
      'media item described in place': 1,
      'file format': 1,
    });
    expect(writeLines(records, 0, { version: '7.0' })).toEqual([
      '0 @I1@ INDI',
      '1 OBJE',
      '2 FILE a.xyz',
      '2 FORM xyz',
    ]);
  });

  it('gives a source described in place the pointer to nothing that 7.0 requires', () => {
    expect(
      toSeven(
        ged('0 @I1@ INDI', '1 BIRT', '2 SOUR Family bible', '3 TEXT Born at home', '3 QUAY 2'),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 SOUR @VOID@',
        '3 PAGE Family bible',
        '3 QUAY 2',
        '3 DATA',
        '4 TEXT Born at home',
      ),
    );
  });

  it('moves text on an event line into a note', () => {
    expect(toSeven(ged('0 @I1@ INDI', '1 DEAT Age: 79', '2 DATE 1950', '1 OCCU Farmer'))).toBe(
      ged('0 @I1@ INDI', '1 DEAT', '2 DATE 1950', '2 NOTE Age: 79', '1 OCCU Farmer'),
    );
  });

  it('converts language names, ages given as a word, and the relation of an associated person', () => {
    expect(
      toSeven(
        ged(
          '0 @U1@ SUBM',
          '1 LANG German',
          '0 @I1@ INDI',
          '1 DEAT',
          '2 AGE INFANT',
          '1 ASSO @I2@',
          '2 RELA Godfather',
        ),
      ),
    ).toBe(
      ged(
        '0 @U1@ SUBM',
        '1 LANG de',
        '0 @I1@ INDI',
        '1 DEAT',
        '2 AGE < 1y',
        '3 PHRASE INFANT',
        '1 ASSO @I2@',
        '2 ROLE OTHER',
        '3 PHRASE Godfather',
      ),
    );
  });

  it('renames cross-reference ids that 7.0 does not allow, and every pointer to them', () => {
    expect(
      toSeven(
        ged(
          '0 @i-1@ INDI',
          '1 FAMS @fam.1@',
          '0 @I_1@ INDI',
          '0 @fam.1@ FAM',
          '1 HUSB @i-1@',
          '1 WIFE @I_1@',
        ),
      ),
    ).toBe(
      ged(
        '0 @I_1_2@ INDI',
        '1 FAMS @FAM_1@',
        '0 @I_1@ INDI',
        '0 @FAM_1@ FAM',
        '1 HUSB @I_1_2@',
        '1 WIFE @I_1@',
      ),
    );
  });
});

describe('converting 7.0 to 5.5.1', () => {
  it('turns shared notes back into note records', () => {
    expect(
      toFive(ged('0 @N1@ SNOTE A note', '0 @I1@ INDI', '1 SNOTE @N1@', '1 SNOTE @VOID@')),
    ).toBe(ged('0 @N1@ NOTE A note', '0 @I1@ INDI', '1 NOTE @N1@'));
  });

  it('rewrites dates, folding a phrase into the date where 5.5.1 has a form for it', () => {
    expect(
      toFive(
        ged(
          '0 @I1@ INDI',
          '1 BIRT',
          '2 DATE JULIAN 3 FEB 1700',
          '1 DEAT',
          '2 DATE',
          '3 PHRASE about harvest',
          '1 BURI',
          '2 DATE 44 BCE',
          '3 PHRASE long ago',
        ),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 DATE @#DJULIAN@ 3 FEB 1700',
        '1 DEAT',
        '2 DATE (about harvest)',
        '1 BURI',
        '2 DATE 44 B.C.',
        '3 _PHRASE long ago',
      ),
    );
  });

  it('writes values from fixed lists in lower case, with a phrase taking the place of OTHER', () => {
    expect(
      toFive(
        ged(
          '0 @I1@ INDI',
          '1 NAME A /B/',
          '2 TYPE MARRIED',
          '1 NAME C /D/',
          '2 TYPE OTHER',
          '3 PHRASE religious',
          '1 FAMC @F1@',
          '2 PEDI OTHER',
          '3 PHRASE step',
          '2 STAT PROVEN',
        ),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 NAME A /B/',
        '2 TYPE married',
        '1 NAME C /D/',
        '2 TYPE religious',
        '1 FAMC @F1@',
        '2 PEDI step',
        '2 STAT proven',
      ),
    );
  });

  it('keeps tags that 7.0 added under a tag of the app’s own', () => {
    expect(
      toFive(
        ged(
          '0 @I1@ INDI',
          '1 UID 8f1c',
          '1 EXID 123',
          '2 TYPE http://example.com',
          '1 NO MARR',
          '1 NOTE Hallo',
          '2 LANG de',
          '2 TRAN Hello',
          '3 LANG en',
        ),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 _UID 8f1c',
        '1 _EXID 123',
        '2 TYPE http://example.com',
        '1 _NO MARR',
        '1 NOTE Hallo',
        '2 _LANG de',
        '2 _TRAN Hello',
        '3 _LANG en',
      ),
    );
  });

  it('writes a media type as a file format', () => {
    expect(toFive(ged('0 @O1@ OBJE', '1 FILE a.jpg', '2 FORM image/jpeg', '3 MEDI PHOTO'))).toBe(
      ged('0 @O1@ OBJE', '1 FILE a.jpg', '2 FORM jpg', '3 TYPE photo'),
    );
    expect(toFive(ged('0 @O1@ OBJE', '1 FILE a.xyz', '2 FORM application/x-thing'))).toBe(
      ged('0 @O1@ OBJE', '1 FILE a.xyz', '2 FORM x-thing'),
    );
  });

  it('describes a source in place where 7.0 pointed to nothing, and drops other such links', () => {
    expect(
      toFive(
        ged(
          '0 @I1@ INDI',
          '1 BIRT',
          '2 SOUR @VOID@',
          '3 PAGE Family bible',
          '3 DATA',
          '4 TEXT Born at home',
          '1 FAMC @VOID@',
          '0 @F1@ FAM',
          '1 HUSB @VOID@',
          '1 WIFE @I1@',
        ),
      ),
    ).toBe(
      ged(
        '0 @I1@ INDI',
        '1 BIRT',
        '2 SOUR Family bible',
        '3 TEXT Born at home',
        '0 @F1@ FAM',
        '1 WIFE @I1@',
      ),
    );
  });

  it('converts language tags and roles', () => {
    expect(
      toFive(
        ged(
          '0 @U1@ SUBM',
          '1 LANG de-AT',
          '0 @I1@ INDI',
          '1 ASSO @I2@',
          '2 ROLE OTHER',
          '3 PHRASE Godfather',
          '1 ASSO @I3@',
          '2 ROLE WITN',
          '1 BIRT',
          '2 SOUR @S1@',
          '3 EVEN BIRT',
          '4 ROLE CLERGY',
          '4 ROLE MOTH',
        ),
      ),
    ).toBe(
      ged(
        '0 @U1@ SUBM',
        '1 LANG German',
        '0 @I1@ INDI',
        '1 ASSO @I2@',
        '2 RELA Godfather',
        '1 ASSO @I3@',
        '2 RELA witn',
        '1 BIRT',
        '2 SOUR @S1@',
        '3 EVEN BIRT',
        '4 ROLE (clergy)',
        '4 ROLE MOTH',
      ),
    );
  });
});

describe('convertVersion', () => {
  const FIVE = ged(
    '0 @N1@ NOTE A note with an address a@b.com',
    '1 CONT and a second line',
    '0 @I1@ INDI',
    '1 NAME John /Smith/',
    '2 TYPE aka',
    '1 SEX M',
    '1 BIRT',
    '2 DATE @#DJULIAN@ 3 FEB 1700',
    '2 SOUR @S1@',
    '3 PAGE 12',
    '1 DEAT Age: 79',
    '1 FAMC @F1@',
    '2 PEDI adopted',
    '1 NOTE @N1@',
    '1 RIN 5',
    '0 @O1@ OBJE',
    '1 FILE a.png',
    '2 FORM png',
    '3 TYPE photo',
  );

  it('changes nothing when run again on its own result', () => {
    for (const [from, to] of [
      ['5.5.1', '7.0'],
      ['7.0', '5.5.1'],
    ] as const) {
      const source = from === '5.5.1' ? FIVE : toSeven(FIVE);
      const once = convert(source, from, to);
      expect(convert(once, to, to), `${from} to ${to}`).toBe(once);
    }
  });

  it('brings the plain parts of a 5.5.1 file back unchanged after a trip through 7.0', () => {
    const plain = ged(
      '0 @N1@ NOTE A note',
      '0 @I1@ INDI',
      '1 NAME John /Smith/',
      '2 TYPE aka',
      '1 SEX M',
      '1 BIRT',
      '2 DATE @#DJULIAN@ 3 FEB 1700',
      '1 DEAT',
      '2 DATE (about harvest)',
      '1 FAMC @F1@',
      '2 PEDI adopted',
      '1 NOTE @N1@',
      '0 @O1@ OBJE',
      '1 FILE a.png',
      '2 FORM png',
      '3 TYPE photo',
    );
    expect(toFive(toSeven(plain))).toBe(plain);
  });
});
