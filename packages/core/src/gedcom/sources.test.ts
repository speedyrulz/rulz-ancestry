import { describe, expect, it } from 'vitest';
import { touchAll } from './node';
import { parseFragment } from './parse';
import {
  citationKey,
  citedSource,
  cleanCitationFields,
  cleanDay,
  cleanSourceFields,
  patchCitation,
  patchSource,
  readCitation,
  readSource,
  webAddressProblem,
  type CitationFields,
  type SourceFields,
} from './sources';
import { writeLines } from './write';

function one(lines: string[], version: '5.5.1' | '7.0' = '5.5.1') {
  const node = parseFragment(lines.join('\n'), version)[0];
  if (!node) throw new Error('nothing parsed');
  return node;
}

function written(
  node: ReturnType<typeof one>,
  level: number,
  version: '5.5.1' | '7.0' = '5.5.1',
): string[] {
  return writeLines([node], level, { version, keepOriginalLines: true });
}

const NO_SOURCE: SourceFields = {
  title: '',
  author: '',
  publication: '',
  abbreviation: '',
  text: '',
  note: '',
};
const NO_CITATION: CitationFields = {
  page: '',
  text: '',
  quality: null,
  note: '',
  url: '',
  accessedAt: '',
};

const ANCESTRY_SOURCE = [
  '0 @S1@ SOUR',
  '1 TITL 1900 United States Federal Census',
  '1 AUTH Ancestry.com',
  '1 PUBL Ancestry.com Operations Inc',
  '2 CONT Provo, UT, USA',
  '1 REPO @R1@',
  '1 _APID 1,7602::0',
];

describe('readSource', () => {
  it('reads the fields the app has and leaves the rest', () => {
    expect(readSource(one(ANCESTRY_SOURCE))).toEqual({
      title: '1900 United States Federal Census',
      author: 'Ancestry.com',
      publication: 'Ancestry.com Operations Inc\nProvo, UT, USA',
      abbreviation: '',
      text: '',
      note: '',
    });
  });

  it('makes a title one line and trims what is around a block of text', () => {
    const source = one([
      '0 @S1@ SOUR',
      '1 TITL  Parish ',
      '2 CONT register',
      '1 TEXT ',
      '2 CONT words ',
    ]);
    expect(readSource(source)).toMatchObject({ title: 'Parish register', text: 'words' });
  });
});

describe('patchSource', () => {
  it('gives the original lines back when nothing has changed', () => {
    const original = one(ANCESTRY_SOURCE);
    const patched = patchSource(original, readSource(original), 'S1');
    expect(written(patched, 0)).toEqual(ANCESTRY_SOURCE);
  });

  it('rewrites only the line of the field that changed', () => {
    const original = one(ANCESTRY_SOURCE);
    const patched = patchSource(
      original,
      { ...readSource(original), author: 'Census Bureau' },
      'S1',
    );
    expect(written(patched, 0)).toEqual([
      '0 @S1@ SOUR',
      '1 TITL 1900 United States Federal Census',
      '1 AUTH Census Bureau',
      '1 PUBL Ancestry.com Operations Inc',
      '2 CONT Provo, UT, USA',
      '1 REPO @R1@',
      '1 _APID 1,7602::0',
    ]);
  });

  it('adds a field in its usual place and removes one that was emptied', () => {
    const original = one(ANCESTRY_SOURCE);
    const patched = patchSource(
      original,
      { ...readSource(original), abbreviation: '1900 census', publication: '' },
      'S1',
    );
    expect(written(patched, 0)).toEqual([
      '0 @S1@ SOUR',
      '1 TITL 1900 United States Federal Census',
      '1 AUTH Ancestry.com',
      '1 ABBR 1900 census',
      '1 REPO @R1@',
      '1 _APID 1,7602::0',
    ]);
  });

  it('writes a new source with its id and only the fields that are filled in', () => {
    const made = patchSource(
      null,
      { ...NO_SOURCE, title: 'Family bible', text: 'Born 1850\nDied 1910' },
      'S7',
    );
    expect(written(made, 0)).toEqual([
      '0 @S7@ SOUR',
      '1 TITL Family bible',
      '1 TEXT Born 1850',
      '2 CONT Died 1910',
    ]);
  });

  it('leaves a second line of the same kind alone', () => {
    const original = one(['0 @S1@ SOUR', '1 TITL One', '1 TEXT first', '1 TEXT second']);
    const patched = patchSource(original, { ...readSource(original), text: 'changed' }, 'S1');
    expect(written(patched, 0)).toEqual([
      '0 @S1@ SOUR',
      '1 TITL One',
      '1 TEXT changed',
      '1 TEXT second',
    ]);
  });
});

const ANCESTRY_CITATION = [
  '2 SOUR @S1@',
  '3 PAGE Year: 1900; Census Place: Boston; Roll: 12',
  '3 _APID 1,7602::123',
];

const FULL_CITATION = [
  '2 SOUR @S1@',
  '3 PAGE p. 4',
  '3 DATA',
  '4 DATE 1 JAN 1900',
  '4 TEXT John, son of Tom',
  '5 CONT and Mary',
  '3 QUAY 3',
  '3 NOTE @N1@',
  '3 NOTE Hard to read',
];

describe('citedSource', () => {
  it('gives the id of the source record a line points at', () => {
    expect(citedSource(one(ANCESTRY_CITATION))).toBe('S1');
  });

  it('gives nothing for a source described in place, or for another tag', () => {
    expect(citedSource(one(['2 SOUR The family bible', '3 TEXT Born 1850']))).toBeNull();
    expect(citedSource(one(['2 NOTE @N1@']))).toBeNull();
  });
});

describe('readCitation', () => {
  it('reads the place in the source, the words, the quality and the note', () => {
    expect(readCitation(one(FULL_CITATION))).toEqual({
      page: 'p. 4',
      text: 'John, son of Tom\nand Mary',
      quality: 3,
      note: 'Hard to read',
      url: '',
      accessedAt: '',
    });
  });

  it('reads what is not there as empty, and an unknown quality as not stated', () => {
    expect(readCitation(one(['2 SOUR @S1@', '3 QUAY high']))).toEqual(NO_CITATION);
  });
});

describe('patchCitation', () => {
  it('gives the original lines back when nothing has changed', () => {
    for (const lines of [ANCESTRY_CITATION, FULL_CITATION]) {
      const original = one(lines);
      expect(written(patchCitation(original, readCitation(original), 'S1'), 2)).toEqual(lines);
    }
  });

  it('rewrites only the line of the field that changed', () => {
    const original = one(ANCESTRY_CITATION);
    const patched = patchCitation(original, { ...readCitation(original), page: 'Sheet 4B' }, 'S1');
    expect(written(patched, 2)).toEqual(['2 SOUR @S1@', '3 PAGE Sheet 4B', '3 _APID 1,7602::123']);
  });

  it('adds the words, the quality and a note where they belong', () => {
    const original = one(ANCESTRY_CITATION);
    const patched = patchCitation(
      original,
      { ...readCitation(original), text: 'John Smith, head', quality: 2, note: 'Checked twice' },
      'S1',
    );
    expect(written(patched, 2)).toEqual([
      '2 SOUR @S1@',
      '3 PAGE Year: 1900; Census Place: Boston; Roll: 12',
      '3 DATA',
      '4 TEXT John Smith, head',
      '3 QUAY 2',
      '3 _APID 1,7602::123',
      '3 NOTE Checked twice',
    ]);
  });

  it('removes the lines of fields that were emptied, and a DATA line left with nothing', () => {
    const original = one(['2 SOUR @S1@', '3 PAGE p. 4', '3 DATA', '4 TEXT words', '3 QUAY 1']);
    const patched = patchCitation(original, NO_CITATION, 'S1');
    expect(written(patched, 2)).toEqual(['2 SOUR @S1@']);
  });

  it('keeps a DATA line that still holds a date, and a note that points at a record', () => {
    const original = one(FULL_CITATION);
    const patched = patchCitation(
      original,
      { ...readCitation(original), text: '', note: '' },
      'S1',
    );
    expect(written(patched, 2)).toEqual([
      '2 SOUR @S1@',
      '3 PAGE p. 4',
      '3 DATA',
      '4 DATE 1 JAN 1900',
      '3 QUAY 3',
      '3 NOTE @N1@',
    ]);
  });

  it('writes a new citation with only what is filled in', () => {
    expect(written(patchCitation(null, NO_CITATION, 'S9'), 1)).toEqual(['1 SOUR @S9@']);
    const made = patchCitation(
      null,
      { ...NO_CITATION, page: 'p. 1', text: 'a\nb', quality: 0, note: 'n' },
      'S9',
    );
    expect(written(made, 2)).toEqual([
      '2 SOUR @S9@',
      '3 PAGE p. 1',
      '3 DATA',
      '4 TEXT a',
      '5 CONT b',
      '3 QUAY 0',
      '3 NOTE n',
    ]);
  });

  it('writes a copy at another level once it is marked as changed', () => {
    const copy = patchCitation(one(ANCESTRY_CITATION), readCitation(one(ANCESTRY_CITATION)), 'S1');
    touchAll(copy);
    expect(written(copy, 1)).toEqual([
      '1 SOUR @S1@',
      '2 PAGE Year: 1900; Census Place: Boston; Roll: 12',
      '2 _APID 1,7602::123',
    ]);
  });

  it('reads the same in GEDCOM 7.0', () => {
    const lines = [
      '2 SOUR @S1@',
      '3 PAGE p. 4',
      '3 DATA',
      '4 TEXT words',
      '3 QUAY 2',
      '3 SNOTE @N1@',
    ];
    const original = one(lines, '7.0');
    expect(readCitation(original)).toEqual({
      ...NO_CITATION,
      page: 'p. 4',
      text: 'words',
      quality: 2,
    });
    expect(written(patchCitation(original, readCitation(original), 'S1'), 2, '7.0')).toEqual(lines);
  });
});

describe('the web address of a citation, and the day it was consulted', () => {
  // The address is made up; the shape is what Ancestry writes.
  const WITH_ADDRESS = [
    '2 SOUR @S1@',
    '3 PAGE Year: 1900; Roll: 12',
    '3 DATA',
    '4 WWW https://records.example/view?id=12&pid=7',
    '3 _APID 1,7602::123',
  ];

  it('reads the address Ancestry writes under DATA', () => {
    const read = readCitation(one(WITH_ADDRESS));
    expect(read.url).toBe('https://records.example/view?id=12&pid=7');
    expect(read.accessedAt).toBe('');
  });

  it('gives the lines of a file back when nothing has changed', () => {
    const original = one(WITH_ADDRESS);
    expect(written(patchCitation(original, readCitation(original), 'S1'), 2)).toEqual(WITH_ADDRESS);
  });

  it('keeps an address of a file as it is written, even one that is no address', () => {
    const lines = ['2 SOUR @S1@', '3 DATA', '4 WWW www.example.org/a page'];
    const original = one(lines);
    expect(readCitation(original).url).toBe('www.example.org/a page');
    expect(written(patchCitation(original, readCitation(original), 'S1'), 2)).toEqual(lines);
  });

  it('writes a new citation with its address and the day', () => {
    const made = patchCitation(
      null,
      { ...NO_CITATION, page: 'p. 1', url: 'https://example.org/r/1', accessedAt: '2026-11-03' },
      'S9',
    );
    expect(written(made, 2)).toEqual([
      '2 SOUR @S9@',
      '3 PAGE p. 1',
      '3 DATA',
      '4 WWW https://example.org/r/1',
      '3 _RULZ_ACCESSED 3 NOV 2026',
    ]);
    expect(readCitation(made)).toEqual({
      ...NO_CITATION,
      page: 'p. 1',
      url: 'https://example.org/r/1',
      accessedAt: '2026-11-03',
    });
  });

  it('writes the address under a tag of its own in GEDCOM 7.0, which has no WWW there', () => {
    const fields = { ...NO_CITATION, text: 'words', url: 'https://example.org/r/1' };
    const made = patchCitation(null, fields, 'S9', '7.0');
    expect(written(made, 2, '7.0')).toEqual([
      '2 SOUR @S9@',
      '3 DATA',
      '4 TEXT words',
      '4 _WWW https://example.org/r/1',
    ]);
    expect(readCitation(made).url).toBe('https://example.org/r/1');
    // A line that is there keeps its tag, whichever it is.
    const changed = patchCitation(
      one(WITH_ADDRESS, '7.0'),
      { ...readCitation(one(WITH_ADDRESS, '7.0')), url: 'https://example.org/other' },
      'S1',
      '7.0',
    );
    expect(written(changed, 2, '7.0')).toContain('4 WWW https://example.org/other');
  });

  it('changes only the line of the address, and takes an emptied one away with its DATA line', () => {
    const original = one(WITH_ADDRESS);
    const changed = patchCitation(
      original,
      { ...readCitation(original), url: 'https://example.org/new' },
      'S1',
    );
    expect(written(changed, 2)).toEqual([
      WITH_ADDRESS[0],
      WITH_ADDRESS[1],
      '3 DATA',
      '4 WWW https://example.org/new',
      WITH_ADDRESS[4],
    ]);
    const emptied = patchCitation(original, { ...readCitation(original), url: '' }, 'S1');
    expect(written(emptied, 2)).toEqual([WITH_ADDRESS[0], WITH_ADDRESS[1], WITH_ADDRESS[4]]);
  });

  it('takes every address line away when the address is emptied', () => {
    const original = one([
      '2 SOUR @S1@',
      '3 DATA',
      '4 DATE 1900',
      '4 WWW https://example.org/one',
      '4 WWW https://example.org/two',
    ]);
    // Changing the first leaves the second alone.
    const changed = patchCitation(
      original,
      { ...readCitation(original), url: 'https://example.org/new' },
      'S1',
    );
    expect(written(changed, 2)).toEqual([
      '2 SOUR @S1@',
      '3 DATA',
      '4 DATE 1900',
      '4 WWW https://example.org/new',
      '4 WWW https://example.org/two',
    ]);
    const emptied = patchCitation(original, { ...readCitation(original), url: '' }, 'S1');
    expect(written(emptied, 2)).toEqual(['2 SOUR @S1@', '3 DATA', '4 DATE 1900']);
    expect(readCitation(emptied).url).toBe('');
  });

  it('adds, changes and removes the day', () => {
    const original = one(WITH_ADDRESS);
    const dated = patchCitation(
      original,
      { ...readCitation(original), accessedAt: '2026-01-31' },
      'S1',
    );
    expect(written(dated, 2)).toContain('3 _RULZ_ACCESSED 31 JAN 2026');
    expect(readCitation(dated).accessedAt).toBe('2026-01-31');
    const cleared = patchCitation(dated, { ...readCitation(dated), accessedAt: '' }, 'S1');
    expect(written(cleared, 2).join('\n')).not.toContain('_RULZ_ACCESSED');
  });

  it('reads a day only when it is one whole day', () => {
    const day = (value: string) =>
      readCitation(one(['2 SOUR @S1@', `3 _RULZ_ACCESSED ${value}`])).accessedAt;
    expect(day('3 nov 2026')).toBe('2026-11-03');
    expect(day('NOV 2026')).toBe('');
    expect(day('ABT 3 NOV 2026')).toBe('');
    expect(day('31 FEB 2026')).toBe('');
  });

  it('tells two citations apart that differ in their address only', () => {
    const other = WITH_ADDRESS.map((line) => line.replace('id=12', 'id=13'));
    expect(citationKey(one(WITH_ADDRESS))).not.toBe(citationKey(one(other)));
  });
});

describe('cleanDay', () => {
  it('takes a day that exists and nothing else', () => {
    expect(cleanDay(' 2026-11-13 ')).toBe('2026-11-13');
    expect(cleanDay('2024-02-29')).toBe('2024-02-29');
    expect(cleanDay('2026-02-29')).toBe('');
    expect(cleanDay('2026-13-01')).toBe('');
    expect(cleanDay('0000-01-01')).toBe('');
    expect(cleanDay('0050-01-01')).toBe('0050-01-01');
    expect(cleanDay('13 NOV 2026')).toBe('');
    expect(cleanDay('')).toBe('');
  });
});

describe('webAddressProblem', () => {
  it('takes an address of the web, and an empty field', () => {
    for (const address of [
      '',
      '  ',
      'https://example.org',
      'http://example.org/a?b=c&utm_source=x#d',
      ' https://example.org/caf%C3%A9 ',
      'https://xn--bcher-kva.example/',
    ]) {
      expect(webAddressProblem(address), address).toBeNull();
    }
  });

  it('says why anything else is not one', () => {
    for (const address of [
      'example.org',
      'www.example.org/page',
      'ftp://example.org/file',
      'file:///C:/notes.txt',
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://',
      'https://user:secret@example.org/',
      'https://user@example.org/',
      'https://example.org/a b',
      'https://example.org/a\nb',
      // Marks that are not seen: a zero-width space, and one that turns the reading order.
      `https://example.org/a${String.fromCharCode(0x200b)}b`,
      `https://example.org/${String.fromCharCode(0x202e)}moc.elpmaxe`,
      `https://example.org/${'a'.repeat(2100)}`,
    ]) {
      expect(webAddressProblem(address), address).toEqual(expect.any(String));
    }
  });
});

describe('citationKey', () => {
  it('is the same for the same words at another level, and differs when a line differs', () => {
    const underName = one(ANCESTRY_CITATION);
    const underPerson = one([
      '1 SOUR @S1@',
      '2 PAGE Year: 1900; Census Place: Boston; Roll: 12',
      '2 _APID 1,7602::123',
    ]);
    const other = one([
      '2 SOUR @S1@',
      '3 PAGE Year: 1900; Census Place: Boston; Roll: 12',
      '3 _APID 1,7602::124',
    ]);
    expect(citationKey(underName)).toBe(citationKey(underPerson));
    expect(citationKey(underName)).not.toBe(citationKey(other));
  });
});

describe('cleaning what a form sends', () => {
  it('trims, joins the spaces of one-line fields and keeps the lines of the others', () => {
    expect(
      cleanSourceFields({
        title: '  Parish\n register ',
        author: ' A.  B. ',
        publication: ' London\r\n1850 ',
        abbreviation: '',
        text: '\n words \n',
        note: ' a remark\r\nof two lines ',
      }),
    ).toEqual({
      title: 'Parish register',
      author: 'A. B.',
      publication: 'London\n1850',
      abbreviation: '',
      text: 'words',
      note: 'a remark\nof two lines',
    });
  });

  it('treats a quality outside 0 to 3 as not stated', () => {
    expect(cleanCitationFields({ ...NO_CITATION, quality: 7 }).quality).toBeNull();
    expect(cleanCitationFields({ ...NO_CITATION, quality: 0 }).quality).toBe(0);
  });

  it('keeps an address on one line and a day only when it is one', () => {
    const clean = cleanCitationFields({
      ...NO_CITATION,
      url: ' https://example.org/a\n ',
      accessedAt: 'yesterday',
    });
    expect(clean.url).toBe('https://example.org/a');
    expect(clean.accessedAt).toBe('');
  });
});
