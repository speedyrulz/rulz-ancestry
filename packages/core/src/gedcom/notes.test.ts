import { describe, expect, it } from 'vitest';
import { patchEvent, readEvent } from './events';
import { writeLines } from './write';
import { NOTE_MAX, cleanNote, isOwnNote, patchNoteLine, readOwnNote, setOwnNote } from './notes';
import { patchSource, readSource } from './sources';
import { one as oneOf } from './testing';

const one = (lines: readonly string[]) => oneOf(lines.join('\n'));

function written(node: ReturnType<typeof one>, level: number): string[] {
  return writeLines([node], level, { version: '5.5.1', keepOriginalLines: true });
}

describe('cleanNote', () => {
  it('makes line ends the same, trims, and cuts to the length the forms take', () => {
    expect(cleanNote('  one\r\ntwo\rthree \n')).toBe('one\ntwo\nthree');
    expect(cleanNote('x'.repeat(NOTE_MAX + 1))).toHaveLength(NOTE_MAX);
    expect(cleanNote(' \n ')).toBe('');
  });
});

describe('the note of a structure', () => {
  const BIRTH = [
    '1 BIRT',
    '2 DATE 1900',
    '2 NOTE @N1@',
    '2 NOTE',
    '2 NOTE Born at home.',
    '3 CONT In winter.',
    '3 SOUR @S1@',
    '2 NOTE A second note.',
  ];

  it('is the first NOTE line with text of its own', () => {
    const birth = one(BIRTH);
    expect(birth.children.map(isOwnNote)).toEqual([false, false, false, true, true]);
    expect(readOwnNote(birth)).toBe('Born at home.\nIn winter.');
    expect(readOwnNote(one(['1 BIRT', '2 NOTE @N1@']))).toBe('');
  });

  it('is rewritten in place, with what stands under it', () => {
    const birth = one(BIRTH);
    setOwnNote(birth, 'Born at the farm.');
    expect(written(birth, 1)).toEqual([
      '1 BIRT',
      '2 DATE 1900',
      '2 NOTE @N1@',
      '2 NOTE',
      '2 NOTE Born at the farm.',
      '3 SOUR @S1@',
      '2 NOTE A second note.',
    ]);
  });

  it('goes when it is cleared, and the next note is then the note', () => {
    const birth = one(BIRTH);
    setOwnNote(birth, '');
    expect(written(birth, 1)).toEqual([
      '1 BIRT',
      '2 DATE 1900',
      '2 NOTE @N1@',
      '2 NOTE',
      '2 NOTE A second note.',
    ]);
    expect(readOwnNote(birth)).toBe('A second note.');
  });

  it('is added after the other lines when there was none', () => {
    const birth = one(['1 BIRT', '2 DATE 1900']);
    setOwnNote(birth, 'One line.\nAnother.');
    expect(written(birth, 1)).toEqual([
      '1 BIRT',
      '2 DATE 1900',
      '2 NOTE One line.',
      '3 CONT Another.',
    ]);
  });
});

describe('patchNoteLine', () => {
  it('gives the original line back while the note is the same', () => {
    const original = one(['1 NOTE  Kept a diary.', '2 CONT It is lost. ']);
    expect(patchNoteLine(original, 'Kept a diary.\nIt is lost.')).toBe(original);
  });

  it('writes a changed note, and none for an empty one', () => {
    const original = one(['1 NOTE Kept a diary.', '2 SOUR @S1@']);
    const patched = patchNoteLine(original, 'Kept two diaries.');
    expect(patched && written(patched, 1)).toEqual(['1 NOTE Kept two diaries.', '2 SOUR @S1@']);
    expect(patchNoteLine(original, '')).toBeNull();
    const made = patchNoteLine(null, 'New.');
    expect(made && written(made, 1)).toEqual(['1 NOTE New.']);
  });
});

describe('the note of an event and of a source', () => {
  it('is read with the event and written back only when it changed', () => {
    const lines = ['1 BIRT', '2 DATE 1900', '2 NOTE Born at home.'];
    const original = one(lines);
    const fields = readEvent(original, 'person');
    expect(fields?.note).toBe('Born at home.');
    if (!fields) return;
    expect(written(patchEvent(original, fields, 'person', '5.5.1'), 1)).toEqual(lines);
    expect(
      written(patchEvent(original, { ...fields, note: 'At the farm.' }, 'person', '5.5.1'), 1),
    ).toEqual(['1 BIRT', '2 DATE 1900', '2 NOTE At the farm.']);
    expect(written(patchEvent(null, { ...fields, note: 'New.' }, 'person', '5.5.1'), 1)).toEqual([
      '1 BIRT',
      '2 DATE 1900',
      '2 NOTE New.',
    ]);
  });

  it('is read with the source and written back only when it changed', () => {
    const lines = ['0 @S1@ SOUR', '1 TITL Register', '1 NOTE Seen on film.', '1 REPO @R1@'];
    const original = one(lines);
    const fields = readSource(original);
    expect(fields.note).toBe('Seen on film.');
    expect(written(patchSource(original, fields, 'S1'), 0)).toEqual(lines);
    expect(written(patchSource(original, { ...fields, note: '' }, 'S1'), 0)).toEqual([
      '0 @S1@ SOUR',
      '1 TITL Register',
      '1 REPO @R1@',
    ]);
    expect(written(patchSource(null, { ...fields, note: 'Mine.' }, 'S9'), 0)).toEqual([
      '0 @S9@ SOUR',
      '1 TITL Register',
      '1 NOTE Mine.',
    ]);
  });
});
