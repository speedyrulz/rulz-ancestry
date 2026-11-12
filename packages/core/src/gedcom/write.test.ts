import { describe, expect, it } from 'vitest';
import { findChild, makeNode, touch } from './node';
import { parseFragment, parseGedcom } from './parse';
import { fresh, ged, one, show } from './testing';
import { writeGedcom, writeLines } from './write';

describe('writeGedcom', () => {
  it('writes records with levels, cross-reference ids and a line ending after every line', () => {
    const person = makeNode('INDI', '', [
      makeNode('NAME', 'John /Smith/', [makeNode('GIVN', 'John')]),
      makeNode('FAMS', '@F1@'),
    ]);
    person.xref = 'I1';
    const text = writeGedcom([makeNode('HEAD'), person, makeNode('TRLR')], { version: '5.5.1' });
    expect(text).toBe(
      [
        '0 HEAD',
        '0 @I1@ INDI',
        '1 NAME John /Smith/',
        '2 GIVN John',
        '1 FAMS @F1@',
        '0 TRLR',
        '',
      ].join('\r\n'),
    );
    expect(writeGedcom([makeNode('HEAD')], { version: '7.0', lineEnding: '\n' })).toBe('0 HEAD\n');
    expect(writeGedcom([], { version: '7.0' })).toBe('');
  });

  it('writes a value with line breaks on CONT lines, including empty ones', () => {
    const note = makeNode('NOTE', 'one\n\nthree');
    expect(fresh(note)).toBe(ged('1 NOTE one', '2 CONT', '2 CONT three'));
    expect(fresh(makeNode('NOTE', '\nsecond'))).toBe(ged('1 NOTE', '2 CONT second'));
  });

  it('doubles @ the way each version asks, and never in a pointer or a calendar marker', () => {
    const note = makeNode('NOTE', '@home or a@b.com\n@again');
    expect(fresh(note, '5.5.1')).toBe(ged('1 NOTE @@home or a@@b.com', '2 CONT @@again'));
    expect(fresh(note, '7.0')).toBe(ged('1 NOTE @@home or a@b.com', '2 CONT @@again'));

    expect(fresh(makeNode('FAMC', '@F1@'), '5.5.1')).toBe('1 FAMC @F1@');
    expect(fresh(makeNode('FAMC', '@F1@'), '7.0')).toBe('1 FAMC @F1@');
    expect(fresh(makeNode('DATE', 'BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1701'), '5.5.1', 2)).toBe(
      '2 DATE BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1701',
    );
  });

  it('reads back what it wrote, for both versions', () => {
    const value = 'tricky @ value with @@ and a@b\n@second line @ end@';
    for (const version of ['5.5.1', '7.0'] as const) {
      const written = fresh(makeNode('NOTE', value), version);
      expect(one(written, version).value).toBe(value);
    }
  });

  it('breaks a long 5.5.1 value onto CONC lines, never at a space, and loses nothing', () => {
    const words = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
    const lines = writeLines([makeNode('NOTE', words)], 1, { version: '5.5.1' });
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(255);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('2 CONC ')).toBe(true);
      // Neither side of a break is a space, so a reader that trims lines loses nothing.
      expect(line.slice('2 CONC '.length).startsWith(' ')).toBe(false);
    }
    for (const line of lines.slice(0, -1)) expect(line.endsWith(' ')).toBe(false);
    expect(one(lines.join('\n')).value).toBe(words);
  });

  it('does not break inside a doubled @ or inside a character made of two code units', () => {
    const emoji = String.fromCodePoint(0x1f600);
    for (const filler of ['@', emoji]) {
      const value = `start ${filler.repeat(400)} end`;
      const lines = writeLines([makeNode('NOTE', value)], 1, { version: '5.5.1' });
      expect(lines.length).toBeGreaterThan(1);
      expect(one(lines.join('\n')).value).toBe(value);
      for (const line of lines) {
        const last = line.charCodeAt(line.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  it('writes a long value on one line in 7.0, which has no CONC', () => {
    const long = 'x'.repeat(1000);
    expect(writeLines([makeNode('NOTE', long)], 1, { version: '7.0' })).toEqual([`1 NOTE ${long}`]);
  });
});

describe('keeping original lines', () => {
  const original = ged(
    '0 @I1@ INDI',
    '1 NAME John /Smith/',
    '2 GIVN John',
    '1 NOTE A note that some program broke in an odd pl',
    '2 CONC ace, with an e-mail address a@b.com that it did not double',
    '2 CONT and a second line',
    '1 birt',
    '2 DATE 12 Mar 1881',
  );

  it('writes an untouched record back exactly, odd spelling and all', () => {
    const [record] = parseFragment(original, '5.5.1');
    expect(record).toBeDefined();
    if (!record) return;
    expect(show(record, '5.5.1', 0)).toBe(original);
    // Written afresh, the same record is tidied up.
    expect(fresh(record, '5.5.1', 0)).toContain('1 BIRT');
    expect(fresh(record, '5.5.1', 0)).toContain('a@@b.com');
  });

  it('rewrites only the node that was changed', () => {
    const [record] = parseFragment(original, '5.5.1');
    if (!record) throw new Error('no record');
    const date = findChild(findChild(record, 'BIRT') ?? record, 'DATE');
    if (!date) throw new Error('no date');
    date.value = '13 MAR 1881';
    touch(date);
    expect(show(record, '5.5.1', 0)).toBe(
      original.replace('2 DATE 12 Mar 1881', '2 DATE 13 MAR 1881'),
    );
  });

  it('reproduces a whole file', () => {
    const file = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', original, '0 TRLR', ''].join('\n');
    const doc = parseGedcom(file);
    expect(
      writeGedcom(doc.records, { version: '5.5.1', lineEnding: '\n', keepOriginalLines: true }),
    ).toBe(file);
  });
});
