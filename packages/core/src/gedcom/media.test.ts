import { describe, expect, it } from 'vitest';
import {
  embeddedMediaKey,
  embeddedToRecord,
  isEmbeddedMedia,
  mediaPointer,
  patchMediaRecord,
  readMediaRecord,
} from './media';
import { fresh, ged, one, show } from './testing';

const NOTHING = { title: '', description: '' };
const PHOTO = { reference: 'media/ann.jpg', ext: 'jpg', mime: 'image/jpeg' };

describe('readMediaRecord', () => {
  it('reads a record as GEDCOM 5.5.1 and Ancestry write it', () => {
    const record = one(
      ged(
        '0 @M1@ OBJE',
        '1 FILE C:\\Users\\ann\\Tree Media\\wedding.jpg',
        '2 FORM jpg',
        '3 TYPE photo',
        '2 TITL The wedding, 1921',
        '1 NOTE Taken outside the church.',
        '2 CONT Ann is on the left.',
        '1 _CREA 2015-03-01',
      ),
    );
    expect(readMediaRecord(record)).toEqual({
      file: 'C:\\Users\\ann\\Tree Media\\wedding.jpg',
      format: 'jpg',
      title: 'The wedding, 1921',
      description: 'Taken outside the church.\nAnn is on the left.',
    });
  });

  it('reads a record of GEDCOM 7.0', () => {
    const record = one(
      ged('0 @M1@ OBJE', '1 FILE media/wedding.jpg', '2 FORM image/jpeg', '2 TITL The wedding'),
      '7.0',
    );
    expect(readMediaRecord(record)).toEqual({
      file: 'media/wedding.jpg',
      format: 'image/jpeg',
      title: 'The wedding',
      description: '',
    });
  });

  it('finds the format and the title beside FILE, where older files have them', () => {
    const inPlace = one(
      ged('1 OBJE', '2 FORM jpeg', '2 TITL Ann as a girl', '2 FILE photos/ann.jpg'),
    );
    expect(readMediaRecord(inPlace)).toMatchObject({
      file: 'photos/ann.jpg',
      format: 'jpeg',
      title: 'Ann as a girl',
    });
  });

  it('takes the first title that says something', () => {
    const record = one(ged('0 @M1@ OBJE', '1 FILE a.jpg', '2 TITL', '1 TITL Beside the file'));
    expect(readMediaRecord(record).title).toBe('Beside the file');
  });

  it('does not take a pointer to a note record for a description', () => {
    const record = one(ged('0 @M1@ OBJE', '1 FILE a.jpg', '1 NOTE @N1@'));
    expect(readMediaRecord(record).description).toBe('');
  });

  it('reads a structure that names no file', () => {
    expect(readMediaRecord(one(ged('0 @M1@ OBJE', '1 TITL Lost')))).toEqual({
      file: '',
      format: '',
      title: 'Lost',
      description: '',
    });
  });
});

describe('mediaPointer and isEmbeddedMedia', () => {
  it('tells a pointer from a media item written in place', () => {
    const pointer = one('1 OBJE @M1@');
    const inPlace = one(ged('1 OBJE', '2 FILE a.jpg', '3 FORM jpg'));
    expect(mediaPointer(pointer)).toBe('M1');
    expect(isEmbeddedMedia(pointer)).toBe(false);
    expect(mediaPointer(inPlace)).toBeNull();
    expect(isEmbeddedMedia(inPlace)).toBe(true);
  });

  it('is neither for another tag, a record, or a structure that names no file', () => {
    expect(mediaPointer(one('1 SOUR @S1@'))).toBeNull();
    expect(isEmbeddedMedia(one(ged('0 @M1@ OBJE', '1 FILE a.jpg')))).toBe(false);
    expect(isEmbeddedMedia(one(ged('1 OBJE', '2 TITL No file')))).toBe(false);
    expect(isEmbeddedMedia(one(ged('1 OBJE', '2 FILE')))).toBe(false);
  });
});

describe('embeddedMediaKey', () => {
  it('is the same at another level and differs when a line differs', () => {
    const under = (level: number, title: string) =>
      one(ged(`${level} OBJE`, `${level + 1} FILE a.jpg`, `${level + 1} TITL ${title}`));
    expect(embeddedMediaKey(under(1, 'Ann'))).toBe(embeddedMediaKey(under(2, 'Ann')));
    expect(embeddedMediaKey(under(1, 'Ann'))).not.toBe(embeddedMediaKey(under(1, 'Anne')));
  });
});

describe('patchMediaRecord', () => {
  const lines = [
    '0 @M1@ OBJE',
    '1 FILE C:\\Media\\wedding.jpg',
    '2 FORM jpg',
    '2 TITL The wedding',
    '1 _CREA 2015-03-01',
    '1 NOTE Outside the church',
  ];

  it('gives the record back when nothing has changed', () => {
    const original = one(ged(...lines));
    const patched = patchMediaRecord(original, readMediaRecord(original), { version: '5.5.1' });
    expect(show(patched, '5.5.1', 0)).toBe(ged(...lines));
    expect(patched).not.toBe(original);
  });

  it('rewrites only the line of the field that changed', () => {
    const original = one(ged(...lines));
    const patched = patchMediaRecord(
      original,
      { title: 'The wedding, 1921', description: 'Outside the church' },
      { version: '5.5.1' },
    );
    expect(show(patched, '5.5.1', 0)).toBe(
      ged(
        ...lines.map((line) => (line === '2 TITL The wedding' ? '2 TITL The wedding, 1921' : line)),
      ),
    );
    expect(patched.children[0]?.raw).not.toBeNull();
  });

  it('takes a title and a description away', () => {
    const patched = patchMediaRecord(one(ged(...lines)), NOTHING, { version: '5.5.1' });
    expect(show(patched, '5.5.1', 0)).toBe(
      ged('0 @M1@ OBJE', '1 FILE C:\\Media\\wedding.jpg', '2 FORM jpg', '1 _CREA 2015-03-01'),
    );
  });

  it('adds a title under FILE in a record, and beside FILE in place in 5.5.1', () => {
    const record = one(ged('0 @M1@ OBJE', '1 FILE a.jpg', '2 FORM jpg'));
    expect(
      show(
        patchMediaRecord(record, { title: 'Ann', description: '' }, { version: '5.5.1' }),
        '5.5.1',
        0,
      ),
    ).toBe(ged('0 @M1@ OBJE', '1 FILE a.jpg', '2 FORM jpg', '2 TITL Ann'));

    const inPlace = one(ged('1 OBJE', '2 FILE a.jpg', '3 FORM jpg', '2 _PRIM Y'));
    expect(
      show(patchMediaRecord(inPlace, { title: 'Ann', description: '' }, { version: '5.5.1' })),
    ).toBe(ged('1 OBJE', '2 FILE a.jpg', '3 FORM jpg', '2 TITL Ann', '2 _PRIM Y'));
  });

  it('changes a title where it stands', () => {
    const inPlace = one(ged('1 OBJE', '2 FORM jpg', '2 TITL Ann', '2 FILE a.jpg'));
    expect(
      show(patchMediaRecord(inPlace, { title: 'Ann Lee', description: '' }, { version: '5.5.1' })),
    ).toBe(ged('1 OBJE', '2 FORM jpg', '2 TITL Ann Lee', '2 FILE a.jpg'));
  });

  it('writes a new record for each version', () => {
    const fields = { title: 'Ann', description: 'Two lines\nof text' };
    expect(
      fresh(
        patchMediaRecord(null, fields, { version: '5.5.1', xref: 'M7', file: PHOTO }),
        '5.5.1',
        0,
      ),
    ).toBe(
      ged(
        '0 @M7@ OBJE',
        '1 FILE media/ann.jpg',
        '2 FORM jpg',
        '2 TITL Ann',
        '1 NOTE Two lines',
        '2 CONT of text',
      ),
    );
    expect(
      fresh(patchMediaRecord(null, NOTHING, { version: '7.0', xref: 'M7', file: PHOTO }), '7.0', 0),
    ).toBe(ged('0 @M7@ OBJE', '1 FILE media/ann.jpg', '2 FORM image/jpeg'));
  });

  it('names a format even for a file of no known kind', () => {
    const unknown = { reference: 'media/notes', ext: '', mime: '' };
    const five = patchMediaRecord(null, NOTHING, { version: '5.5.1', xref: 'M1', file: unknown });
    const seven = patchMediaRecord(null, NOTHING, { version: '7.0', xref: 'M1', file: unknown });
    expect(fresh(five, '5.5.1', 0)).toContain('2 FORM bin');
    expect(fresh(seven, '7.0', 0)).toContain('2 FORM application/octet-stream');
  });

  it('makes a record name another file and leaves its format alone', () => {
    const original = one(ged(...lines));
    const patched = patchMediaRecord(original, readMediaRecord(original), {
      version: '5.5.1',
      file: PHOTO,
    });
    expect(show(patched, '5.5.1', 0)).toBe(
      ged(...lines.map((line) => (line.startsWith('1 FILE') ? '1 FILE media/ann.jpg' : line))),
    );
  });

  it('leaves the FILE line alone when it names that file already', () => {
    const original = one(ged('0 @M1@ OBJE', '1 FILE media/ann.jpg', '2 FORM image/jpeg'), '7.0');
    const patched = patchMediaRecord(original, NOTHING, { version: '7.0', file: PHOTO });
    expect(patched.children[0]?.raw).not.toBeNull();
  });
});

describe('embeddedToRecord', () => {
  it('moves the format and the title under FILE and keeps the rest', () => {
    const inPlace = one(
      ged('2 OBJE', '3 FORM jpg', '3 TITL Ann', '3 FILE photos/ann.jpg', '3 _PRIM Y'),
    );
    expect(fresh(embeddedToRecord(inPlace, 'M3'), '5.5.1', 0)).toBe(
      ged('0 @M3@ OBJE', '1 FILE photos/ann.jpg', '2 FORM jpg', '2 TITL Ann', '1 _PRIM Y'),
    );
    // The structure it was made from is not changed.
    expect(show(inPlace, '5.5.1', 2)).toContain('3 FORM jpg');
  });

  it('leaves alone what is under FILE already', () => {
    const inPlace = one(ged('1 OBJE', '2 FILE a.jpg', '3 FORM jpg', '2 TITL Ann'));
    expect(fresh(embeddedToRecord(inPlace, 'M1'), '5.5.1', 0)).toBe(
      ged('0 @M1@ OBJE', '1 FILE a.jpg', '2 FORM jpg', '2 TITL Ann'),
    );
  });
});
