import { describe, expect, it } from 'vitest';
import { NAME_TYPES } from '../model';
import { formatNameValue, patchName, readName, splitNameValue, type NameFields } from './names';
import { fresh, ged, one, show } from './testing';

const EMPTY: NameFields = {
  type: 'birth',
  prefix: '',
  given: '',
  nickname: '',
  surname: '',
  suffix: '',
};
const name = (fields: Partial<NameFields>): NameFields => ({ ...EMPTY, ...fields });

describe('splitNameValue', () => {
  it('finds the surname between the slashes', () => {
    expect(splitNameValue('John /Smith/ Jr.')).toEqual({
      before: 'John ',
      surname: 'Smith',
      after: ' Jr.',
      slashes: true,
    });
    expect(splitNameValue('John Smith').slashes).toBe(false);
    // A missing closing slash: the rest is the surname.
    expect(splitNameValue('John /Smith').surname).toBe('Smith');
  });
});

describe('readName', () => {
  it('reads the value alone', () => {
    expect(readName(one('1 NAME John Henry /Smith/'))).toEqual(
      name({ given: 'John Henry', surname: 'Smith' }),
    );
    expect(readName(one('1 NAME John /Smith/ Jr.'))).toEqual(
      name({ given: 'John', surname: 'Smith', suffix: 'Jr.' }),
    );
    expect(readName(one('1 NAME /Smith/'))).toEqual(name({ surname: 'Smith' }));
    expect(readName(one('1 NAME John //'))).toEqual(name({ given: 'John' }));
    expect(readName(one('1 NAME   John   Henry  /Smith/'))).toEqual(
      name({ given: 'John Henry', surname: 'Smith' }),
    );
    expect(readName(one('1 NAME'))).toEqual(EMPTY);
  });

  it('reads the pieces as Ancestry and most programs write them', () => {
    const node = one(
      ged(
        '1 NAME Dr. John /Smith/ Jr.',
        '2 NPFX Dr.',
        '2 GIVN John',
        '2 NICK Jack',
        '2 SURN Smith',
        '2 NSFX Jr.',
        '2 TYPE married',
      ),
    );
    expect(readName(node)).toEqual({
      type: 'married',
      prefix: 'Dr.',
      given: 'John',
      nickname: 'Jack',
      surname: 'Smith',
      suffix: 'Jr.',
    });
    // The same name from a program that leaves the title out of the value.
    expect(readName(one(ged('1 NAME John /Smith/', '2 NPFX Dr.'))).given).toBe('John');
  });

  it('keeps a surname with its prefix whole, as the value has it', () => {
    const node = one(
      ged('1 NAME Jan /van der Berg/', '2 GIVN Jan', '2 SPFX van der', '2 SURN Berg'),
    );
    expect(readName(node)).toEqual(name({ given: 'Jan', surname: 'van der Berg' }));
  });

  it('uses the pieces when the value has no slashes', () => {
    expect(readName(one(ged('1 NAME John Smith', '2 GIVN John', '2 SURN Smith')))).toEqual(
      name({ given: 'John', surname: 'Smith' }),
    );
    expect(readName(one(ged('1 NAME Jan Berg', '2 SPFX van der', '2 SURN Berg'))).surname).toBe(
      'van der Berg',
    );
    // With nothing to mark the surname, the whole value is the given name.
    expect(readName(one('1 NAME John Smith'))).toEqual(name({ given: 'John Smith' }));
  });

  it('reads a name written surname first', () => {
    expect(readName(one('1 NAME /Wang/ Wei'))).toEqual(name({ given: 'Wei', surname: 'Wang' }));
    expect(readName(one(ged('1 NAME /Nagy/ István', '2 GIVN István', '2 SURN Nagy')))).toEqual(
      name({ given: 'István', surname: 'Nagy' }),
    );
  });

  it('reads the type in either version, and anything else as "other"', () => {
    expect(readName(one(ged('1 NAME A /B/', '2 TYPE MAIDEN'), '7.0')).type).toBe('maiden');
    expect(readName(one(ged('1 NAME A /B/', '2 TYPE aka'))).type).toBe('aka');
    expect(readName(one(ged('1 NAME A /B/', '2 TYPE Also Known As'))).type).toBe('aka');
    expect(readName(one(ged('1 NAME A /B/', '2 TYPE religious'))).type).toBe('other');
    expect(
      readName(one(ged('1 NAME A /B/', '2 TYPE OTHER', '3 PHRASE Professional'), '7.0')).type,
    ).toBe('professional');
    expect(readName(one(ged('1 NAME A /B/', '2 TYPE'))).type).toBe('birth');
  });

  it('cuts a part that is longer than the app allows', () => {
    const long = 'x'.repeat(300);
    const read = readName(one(`1 NAME ${long} /${long}/`));
    expect(read.given).toHaveLength(200);
    expect(read.surname).toHaveLength(200);
  });
});

describe('formatNameValue', () => {
  it('writes given name, surname in slashes, then suffix', () => {
    expect(formatNameValue({ given: 'John', surname: 'Smith', suffix: 'Jr.' })).toBe(
      'John /Smith/ Jr.',
    );
    expect(formatNameValue({ given: 'John', surname: '', suffix: '' })).toBe('John //');
    expect(formatNameValue({ given: '', surname: 'Smith', suffix: '' })).toBe('/Smith/');
    expect(formatNameValue({ given: '', surname: '', suffix: '' })).toBe('');
  });
});

describe('patchName', () => {
  it('writes a new name with its pieces', () => {
    const node = patchName(
      null,
      {
        type: 'married',
        prefix: 'Dr.',
        given: 'Mary Ann',
        nickname: 'Polly',
        surname: 'Jones',
        suffix: 'PhD',
      },
      '5.5.1',
    );
    expect(fresh(node)).toBe(
      ged(
        '1 NAME Mary Ann /Jones/ PhD',
        '2 TYPE married',
        '2 NPFX Dr.',
        '2 GIVN Mary Ann',
        '2 NICK Polly',
        '2 SURN Jones',
        '2 NSFX PhD',
      ),
    );
    expect(fresh(patchName(null, name({ given: 'Ann', type: 'maiden' }), '7.0'))).toBe(
      ged('1 NAME Ann //', '2 TYPE MAIDEN', '2 GIVN Ann'),
    );
    // A birth name needs no TYPE line, and empty parts get no line.
    expect(fresh(patchName(null, name({ surname: 'Smith' }), '5.5.1'))).toBe(
      ged('1 NAME /Smith/', '2 SURN Smith'),
    );
  });

  it('reads back exactly what it wrote, for every kind of name', () => {
    const parts = [
      {},
      { given: 'John' },
      { surname: 'Smith' },
      { given: 'John', surname: 'Smith' },
      { given: 'John', surname: 'Smith', suffix: 'Jr.' },
      { prefix: 'Dr.', given: 'John', surname: 'Smith' },
      { prefix: 'Dr.', surname: 'Smith' },
      { nickname: 'Jack' },
      { prefix: 'Sir', given: 'John', nickname: 'Jack', surname: 'van der Berg', suffix: 'III' },
    ];
    for (const version of ['5.5.1', '7.0'] as const) {
      for (const type of NAME_TYPES) {
        for (const part of parts) {
          const fields = name({ ...part, type });
          const written = fresh(patchName(null, fields, version), version);
          expect(readName(one(written, version)), written).toEqual(fields);
        }
      }
    }
  });

  const imported = ged(
    '1 NAME Jan /van der Berg/',
    '2 GIVN Jan',
    '2 SPFX van der',
    '2 SURN Berg',
    '2 SOUR @S1@',
    '3 PAGE p. 12',
    '2 _MARNM Jansen',
  );

  it('leaves a name that has not changed exactly as it was imported', () => {
    const original = one(imported);
    const node = patchName(original, readName(original), '5.5.1');
    expect(show(node)).toBe(imported);
  });

  it('rewrites only the lines of the part that changed, and keeps the rest', () => {
    const original = one(imported);
    const was = readName(original);

    const given = patchName(original, { ...was, given: 'Johannes' }, '5.5.1');
    expect(show(given)).toBe(
      imported
        .replace('1 NAME Jan /van der Berg/', '1 NAME Johannes /van der Berg/')
        .replace('2 GIVN Jan', '2 GIVN Johannes'),
    );
    expect(readName(given)).toEqual({ ...was, given: 'Johannes' });

    const nickname = patchName(original, { ...was, nickname: 'Hans' }, '5.5.1');
    expect(show(nickname)).toBe(imported.replace('2 SPFX van der', '2 NICK Hans\n2 SPFX van der'));

    const type = patchName(original, { ...was, type: 'immigrant' }, '5.5.1');
    expect(show(type)).toBe(imported.replace('2 GIVN Jan', '2 TYPE immigrant\n2 GIVN Jan'));
  });

  it('writes a changed surname whole and drops the separate surname prefix', () => {
    const original = one(imported);
    const node = patchName(original, { ...readName(original), surname: 'Bergen' }, '5.5.1');
    expect(show(node)).toBe(
      ged(
        '1 NAME Jan /Bergen/',
        '2 GIVN Jan',
        '2 SURN Bergen',
        '2 SOUR @S1@',
        '3 PAGE p. 12',
        '2 _MARNM Jansen',
      ),
    );
  });

  it('does not add pieces to a name that was imported without them', () => {
    const original = one('1 NAME John /Smith/');
    const was = readName(original);
    expect(show(patchName(original, { ...was, given: 'Jon', suffix: 'Sr.' }, '5.5.1'))).toBe(
      '1 NAME Jon /Smith/ Sr.',
    );
    // A title cannot be carried by the value, so it does get its own line.
    const titled = patchName(original, { ...was, prefix: 'Rev.' }, '5.5.1');
    expect(show(titled)).toBe(ged('1 NAME John /Smith/', '2 NPFX Rev.'));
    expect(readName(titled)).toEqual({ ...was, prefix: 'Rev.' });
  });

  it('removes the line of a part that was cleared', () => {
    const original = one(
      ged('1 NAME John /Smith/ Jr.', '2 GIVN John', '2 SURN Smith', '2 NSFX Jr.'),
    );
    const node = patchName(original, { ...readName(original), suffix: '' }, '5.5.1');
    expect(show(node)).toBe(ged('1 NAME John /Smith/', '2 GIVN John', '2 SURN Smith'));
  });

  it('keeps an imported type line when the type is set back to what it was', () => {
    const original = one(ged('1 NAME A /B/', '2 TYPE Also Known As'));
    expect(show(patchName(original, readName(original), '5.5.1'))).toBe(
      ged('1 NAME A /B/', '2 TYPE Also Known As'),
    );
    const changed = patchName(original, { ...readName(original), type: 'birth' }, '7.0');
    expect(fresh(changed, '7.0')).toBe(ged('1 NAME A /B/', '2 TYPE BIRTH'));
  });
});
