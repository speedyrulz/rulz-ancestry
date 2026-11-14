import { describe, expect, it } from 'vitest';
import { QUOTE_MAX, findQuote } from './quote';
import type { SharedRecord } from './record';

function recordOf(fields: Record<string, string>): SharedRecord {
  return {
    sourceId: 'open-archives',
    sourceName: 'Open Archives',
    attribution: 'Open Archives',
    kind: 'event',
    sex: null,
    url: 'https://www.openarchieven.nl/abc:123/en',
    fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
  };
}

const marriage = recordOf({
  title: 'Jan de Vries',
  role: 'Groom',
  event: 'Marriage',
  date: '12 MAY 1875',
  place: 'Amsterdam, Noord-Holland',
  held: 'Civil registration marriages, Municipal archive',
});

const code = (...points: number[]) => String.fromCodePoint(...points);

describe('looking a quote up in a record', () => {
  it('finds the whole of a text, however short', () => {
    expect(findQuote('Groom', marriage)).toEqual({ found: true, field: 'role', text: 'Groom' });
    expect(findQuote('de', recordOf({ title: 'de' }))).toEqual({
      found: true,
      field: 'title',
      text: 'de',
    });
    expect(findQuote('7', recordOf({ date: '7' }))).toMatchObject({ found: true, field: 'date' });
  });

  it('finds whole words of a text, from four characters on', () => {
    expect(findQuote('1875', marriage)).toEqual({ found: true, field: 'date', text: '1875' });
    expect(findQuote('MAY 1875', marriage)).toMatchObject({ found: true, text: 'MAY 1875' });
    expect(findQuote('de Vries', marriage)).toMatchObject({ found: true, field: 'title' });
    expect(findQuote('Noord-Holland', marriage)).toMatchObject({ found: true, field: 'place' });
  });

  it('does not take a part of a text that is shorter than four characters', () => {
    for (const quote of ['de', 'Jan', '12', 'MAY']) {
      expect(findQuote(quote, marriage), quote).toEqual({ found: false, why: 'too-short' });
    }
  });

  it('does not find a part of a word, or of a number', () => {
    for (const quote of ['sterd', 'Amster', '875', 'Vrie', 'arriage', 'Holl']) {
      expect(findQuote(quote, marriage).found, quote).toBe(false);
    }
    expect(findQuote('1850', recordOf({ date: '18501' }))).toEqual({
      found: false,
      why: 'not-in-record',
    });
    expect(findQuote('1850', recordOf({ date: 'A1850' }))).toMatchObject({ found: false });
  });

  it('does not find a quote that runs from one text into the next', () => {
    expect(findQuote('Groom Marriage', marriage)).toEqual({ found: false, why: 'not-in-record' });
    expect(findQuote('Jan de Vries Groom', marriage)).toMatchObject({ found: false });
  });

  it('does not find words that are not there', () => {
    expect(findQuote('Rotterdam', marriage)).toEqual({ found: false, why: 'not-in-record' });
    expect(findQuote('12 MAY 1876', marriage)).toMatchObject({ found: false });
    expect(findQuote('Jan Vries', marriage)).toMatchObject({ found: false });
  });

  it('takes capitals and small letters as the same, and gives the words as the record has them', () => {
    expect(findQuote('AMSTERDAM', marriage)).toEqual({
      found: true,
      field: 'place',
      text: 'Amsterdam',
    });
    expect(findQuote('12 may 1875', marriage)).toMatchObject({ found: true, text: '12 MAY 1875' });
  });

  it('takes a run of white space as one space', () => {
    expect(findQuote('  Jan \t de\n Vries ', marriage)).toEqual({
      found: true,
      field: 'title',
      text: 'Jan de Vries',
    });
    expect(findQuote(`civil${code(0xa0)}registration`, marriage)).toMatchObject({ found: true });
  });

  it('does not count what stands around a quote and is no letter and no number', () => {
    const curly = `${code(0x201c)}Jan de Vries.${code(0x201d)}`;
    expect(findQuote(curly, marriage)).toMatchObject({ found: true, text: 'Jan de Vries' });
    expect(findQuote('"Amsterdam",', marriage)).toMatchObject({ found: true, text: 'Amsterdam' });
    expect(findQuote('(1875)', marriage)).toMatchObject({ found: true, text: '1875' });
  });

  it('takes the curly and the straight form of a mark as the same', () => {
    const record = recordOf({
      title: `Sjoerd ${code(0x2019)}t Hart`,
      date: `1850${code(0x2013)}1860`,
    });

    expect(findQuote("Sjoerd 't Hart", record)).toMatchObject({ found: true, field: 'title' });
    expect(findQuote('1850-1860', record)).toEqual({
      found: true,
      field: 'date',
      text: `1850${code(0x2013)}1860`,
    });
  });

  it('takes the forms of one letter as the same, and a letter with an accent as another', () => {
    const record = recordOf({ title: `Ren${code(0xe9)}e Dubois`, date: '1850' });

    // The same letter, written as a letter and a mark.
    expect(findQuote(`Rene${code(0x301)}e Dubois`, record)).toMatchObject({ found: true });
    // Wide numbers.
    expect(findQuote(code(0xff11, 0xff18, 0xff15, 0xff10), record)).toMatchObject({
      found: true,
      text: '1850',
    });
    expect(findQuote('Renee Dubois', record)).toEqual({ found: false, why: 'not-in-record' });
  });

  it('takes a text the quote is the whole of before one it is a part of', () => {
    const record = recordOf({ title: 'Marriage of Jan de Vries', event: 'Marriage' });

    expect(findQuote('Marriage', record)).toMatchObject({ found: true, field: 'event' });
    expect(findQuote('Marriage of Jan', record)).toMatchObject({ found: true, field: 'title' });
  });

  it('finds the whole of a text that was cut, and gives it with the mark of the cut', () => {
    const cut = `A long description that was cut${code(0x2026)}`;
    const record = recordOf({ about: cut });

    expect(findQuote('A long description that was cut', record)).toEqual({
      found: true,
      field: 'about',
      text: cut,
    });
  });

  it('does not take a word that stands where a text was cut as a whole word', () => {
    const record = recordOf({ about: `He was born in the year 1850${code(0x2026)}` });

    // The text may have gone on: "18501".
    expect(findQuote('1850', record)).toEqual({ found: false, why: 'not-in-record' });
    expect(findQuote('year 1850', record)).toMatchObject({ found: false });
    expect(findQuote('born in the year', record)).toMatchObject({ found: true });
    expect(findQuote('1850', recordOf({ about: 'born 1850...' }))).toMatchObject({ found: false });
  });

  it('takes a character that stands for several whole or not at all', () => {
    const half = code(0xbd);
    const record = recordOf({ about: `Age 1${half}, of 185${half} acres`, held: `${half} acre` });

    // The forms of the half are "1", a stroke and "2": none of these quotes is in the record.
    for (const quote of ['Age 11', '1851', '2 acres', '2 acre']) {
      expect(findQuote(quote, record), quote).toEqual({ found: false, why: 'not-in-record' });
    }
    expect(findQuote(`185${half} acres`, record)).toEqual({
      found: true,
      field: 'about',
      text: `185${half} acres`,
    });
    // Two letters written as one are found, and given as the record has them.
    const joined = recordOf({ held: `Gra${code(0xfb01)}sch museum of the north` });
    expect(findQuote('grafisch museum', joined)).toEqual({
      found: true,
      field: 'held',
      text: `Gra${code(0xfb01)}sch museum`,
    });
  });

  it('takes an accent that stands alone, and a double prime, as the marks they are used for', () => {
    const record = recordOf({
      title: `Pier O${code(0xb4)}Brien of Sneek`,
      about: `called ${code(0x2033)}the long one${code(0x2033)} in the village`,
    });

    expect(findQuote("O'Brien", record)).toMatchObject({ found: true, field: 'title' });
    expect(findQuote('"the long one" in the village', record)).toMatchObject({
      found: true,
      field: 'about',
    });
  });

  it('does not take a quote without a letter or a number, one that is too long, or one that is no text', () => {
    for (const quote of ['', '   ', '...', '"', code(0x2014)]) {
      expect(findQuote(quote, marriage), quote).toEqual({ found: false, why: 'empty' });
    }
    for (const quote of [null, undefined, 1875, ['1875'], { quote: '1875' }]) {
      expect(findQuote(quote, marriage)).toEqual({ found: false, why: 'empty' });
    }
    expect(findQuote('a'.repeat(QUOTE_MAX + 1), marriage)).toEqual({
      found: false,
      why: 'too-long',
    });
  });

  it('finds nothing in a record without texts', () => {
    expect(findQuote('Marriage', recordOf({}))).toEqual({ found: false, why: 'not-in-record' });
    expect(findQuote('Marriage', recordOf({ title: '...' }))).toMatchObject({ found: false });
  });

  it('says only that the words are there, not that the reason drawn from them holds', () => {
    // A source can hold a sentence written to be quoted. It is found: the user judges it.
    const record = recordOf({ about: 'This is surely the Jan de Vries you are looking for' });

    expect(findQuote('surely the Jan de Vries you are looking for', record).found).toBe(true);
  });
});
