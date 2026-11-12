import { describe, expect, it } from 'vitest';
import { findChild, pointerTarget, rawLines } from './node';
import { MAX_ISSUES, parseFragment, parseGedcom } from './parse';
import { ged } from './testing';

const SMALL = ged(
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '2 FORM LINEAGE-LINKED',
  '1 CHAR UTF-8',
  '0 @I1@ INDI',
  '1 NAME John /Smith/',
  '2 GIVN John',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 12 MAR 1881',
  '2 PLAC Boston',
  '1 FAMS @F1@',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '0 TRLR',
);

describe('parseGedcom', () => {
  it('reads records, their lines and what belongs under each line', () => {
    const doc = parseGedcom(SMALL);
    expect(doc.version).toBe('5.5.1');
    expect(doc.declaredVersion).toBe('5.5.1');
    expect(doc.issues).toEqual([]);
    expect(doc.records.map((record) => `${record.xref ?? '-'} ${record.tag}`)).toEqual([
      '- HEAD',
      'I1 INDI',
      'F1 FAM',
      '- TRLR',
    ]);

    const person = doc.records[1];
    expect(person?.children.map((child) => child.tag)).toEqual(['NAME', 'SEX', 'BIRT', 'FAMS']);
    const birth = person && findChild(person, 'BIRT');
    expect(birth?.value).toBe('');
    expect(birth?.children.map((child) => [child.tag, child.value])).toEqual([
      ['DATE', '12 MAR 1881'],
      ['PLAC', 'Boston'],
    ]);
    expect(birth?.line).toBe(10);
    expect(pointerTarget(person?.children[3]?.value ?? '')).toBe('F1');
  });

  it('keeps the original lines of every node', () => {
    const doc = parseGedcom(SMALL);
    const all = doc.records.flatMap((record) => rawLines(record) ?? []);
    expect(all.join('\n')).toBe(SMALL);
  });

  it('accepts any line ending, a byte-order mark, blank lines and indented lines', () => {
    const messy =
      String.fromCharCode(0xfeff) +
      [
        '0 HEAD',
        '  1 GEDC',
        '    2 VERS 5.5.1',
        '',
        '0 @I1@ INDI',
        '\t1 NAME A /B/',
        '0 TRLR',
      ].join('\r');
    const doc = parseGedcom(messy);
    expect(doc.issues).toEqual([]);
    expect(doc.records.map((record) => record.tag)).toEqual(['HEAD', 'INDI', 'TRLR']);
    expect(doc.records[1]?.children[0]?.value).toBe('A /B/');
    expect(parseGedcom(SMALL.replaceAll('\n', '\r\n')).records).toHaveLength(4);
  });

  it('joins CONT with a line break and CONC without one, keeping spaces', () => {
    const [note] = parseFragment(
      ged('1 NOTE First line', '2 CONT Second', '2 CONC  half', '2 CONT', '2 CONT Last'),
      '5.5.1',
    );
    expect(note?.value).toBe('First line\nSecond half\n\nLast');
    expect(note?.children).toEqual([]);
    expect(note?.raw).toHaveLength(5);
  });

  it('reads tags in any letter case', () => {
    const [name] = parseFragment(ged('1 name John /Smith/', '2 givn John'), '5.5.1');
    expect(name?.tag).toBe('NAME');
    expect(name?.children[0]?.tag).toBe('GIVN');
    // The line as written is kept.
    expect(name?.raw).toEqual(['1 name John /Smith/']);
  });

  it('undoes the doubling of @ in the way each version doubles it', () => {
    const five = parseFragment('1 NOTE mail me at a@@b.com or @@home', '5.5.1')[0];
    expect(five?.value).toBe('mail me at a@b.com or @home');

    const seven = parseFragment('1 NOTE @@me and a@@b', '7.0')[0];
    expect(seven?.value).toBe('@me and a@@b');

    // A pointer and a calendar marker are not doubled, so they are left alone.
    expect(parseFragment('1 FAMC @F1@', '5.5.1')[0]?.value).toBe('@F1@');
    expect(parseFragment('2 DATE @#DJULIAN@ 1700', '5.5.1')[0]?.value).toBe('@#DJULIAN@ 1700');
  });

  it('recognises GEDCOM 7.0 from the header', () => {
    const doc = parseGedcom(ged('0 HEAD', '1 GEDC', '2 VERS 7.0.14', '0 TRLR'));
    expect(doc.version).toBe('7.0');
    expect(doc.declaredVersion).toBe('7.0.14');
    // A version line elsewhere in the header is not the GEDCOM version.
    const other = parseGedcom(
      ged('0 HEAD', '1 SOUR X', '2 VERS 7.1', '1 GEDC', '2 VERS 5.5', '0 TRLR'),
    );
    expect(other.version).toBe('5.5.1');
    expect(other.declaredVersion).toBe('5.5');
  });

  it('reads a line with no level number as more of the line above, and says so', () => {
    const doc = parseGedcom(
      ged(
        '0 HEAD',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @N1@ NOTE A long note that',
        'was broken',
        '0 TRLR',
      ),
    );
    expect(doc.records[1]?.value).toBe('A long note that\nwas broken');
    expect(doc.issues).toEqual([
      { line: 5, message: 'line has no level number; read as more of the line above' },
    ]);
  });

  it('reads a line that skips a level as one level deeper, and says so', () => {
    const doc = parseGedcom(
      ged('0 HEAD', '1 GEDC', '2 VERS 5.5.1', '0 @I1@ INDI', '1 BIRT', '3 DATE 1881', '0 TRLR'),
    );
    const birth = doc.records[1]?.children[0];
    expect(birth?.children[0]?.tag).toBe('DATE');
    expect(doc.issues[0]?.line).toBe(6);
  });

  it('reports a missing header, a missing trailer and records after the trailer', () => {
    const none = parseGedcom('0 @I1@ INDI\n1 NAME A /B/');
    expect(none.issues.map((issue) => issue.message)).toEqual([
      'the file has no header (HEAD) record',
      'the file has no trailer (TRLR) line; it may be cut short',
    ]);
    const after = parseGedcom(ged('0 HEAD', '1 GEDC', '2 VERS 7.0', '0 TRLR', '0 @I1@ INDI'));
    expect(after.issues.map((issue) => issue.message)).toEqual([
      'there are records after the trailer (TRLR) line',
    ]);
    expect(after.records).toHaveLength(3);
  });

  it('never throws on text that is not GEDCOM, and stops listing issues at the limit', () => {
    const junk = Array.from({ length: MAX_ISSUES + 50 }, (_, index) => `line ${index}`).join('\n');
    const doc = parseGedcom(junk);
    expect(doc.records).toEqual([]);
    expect(doc.lineCount).toBe(0);
    expect(doc.issues).toHaveLength(MAX_ISSUES);
    expect(doc.issueCount).toBeGreaterThan(MAX_ISSUES);
    expect(parseGedcom('').records).toEqual([]);
  });
});

describe('parseFragment', () => {
  it('reads a stored piece that does not start at level 0', () => {
    const nodes = parseFragment(ged('1 BIRT', '2 DATE 1881', '1 DEAT Y'), '5.5.1');
    expect(nodes.map((node) => node.tag)).toEqual(['BIRT', 'DEAT']);
    expect(nodes[0]?.children[0]?.value).toBe('1881');
    expect(parseFragment('', '5.5.1')).toEqual([]);
  });
});
