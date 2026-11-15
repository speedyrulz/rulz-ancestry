import type { TextQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient } from '../../http';
import { papersPastManifest } from './manifest';
import {
  PAPERS_PAST_LAST_OFFSET,
  papersPastConnector,
  papersPastSearchParams,
  papersPastWords,
  papersPastYears,
  parsePapersPastSearch,
} from './search';

// The articles below are made up. The shape follows DigitalNZ's Records API
// documentation (result_count and results); it was not seen in a real answer.
const article = {
  id: 90000001,
  title: 'Mr Hemi Rangi at the sale',
  display_date: '12 March 1895',
  date: ['1895-03-12T00:00:00.000Z'],
  publisher: ['Ada Pembury Press'],
  collection_title: ['Papers Past', 'Wairarapa Daily Times'],
  landing_url: 'https://paperspast.natlib.govt.nz/newspapers/WDT18950312.2.9',
};

const answer = (results: unknown[], count: unknown = results.length) => ({
  search: { result_count: count, results },
});

const asked = { offset: 0, limit: 20 };

const query = (changes: Partial<TextQuery> = {}): TextQuery => ({
  words: 'Hemi Rangi',
  phrase: true,
  fromYear: 1890,
  toYear: 1900,
  state: 'Vermont',
  ...changes,
});

describe('papersPastWords', () => {
  const words = (text: string, phrase = false) => papersPastWords(query({ words: text, phrase }));

  it('takes out what the search reads as commands', () => {
    expect(words('date:1895 TO 1900')).toBe('date 1895 to 1900');
    expect(words('[1895 TO 1900]')).toBe('1895 to 1900');
    expect(words('(Hemi OR Rangi)')).toBe('hemi or rangi');
    expect(words('Hemi~2 Rangi^3 +sale !wool /fair/')).toBe('hemi 2 rangi 3 sale wool fair');
    expect(words('Hemi AND Rangi NOT sale')).toBe('hemi and rangi not sale');
    expect(words('"Hemi Rangi"')).toBe('hemi rangi');
  });

  it('keeps letters, marks, apostrophes, full stops, commas and inner hyphens', () => {
    expect(words("O'Brien, J. Smith-Jones Müller")).toBe("o'brien, j. smith-jones müller");
    expect(words('-Hemi Rangi- --')).toBe('hemi rangi');
  });

  it('wraps a phrase in quotation marks after cleaning, and nothing is a phrase of nothing', () => {
    expect(words('Hemi "Rangi"', true)).toBe('"hemi rangi"');
    expect(words('"" ~ ()', true)).toBe('');
  });
});

describe('papersPastYears', () => {
  const years = (from: number | null, to: number | null) =>
    papersPastYears(query({ fromYear: from, toYear: to }), 2026);

  it('gives a closed range', () => {
    expect(years(1890, 1900)).toBe('[1890 TO 1900]');
    expect(years(1895, 1895)).toBe('[1895 TO 1895]');
  });

  it('closes a range with one end by the first year of the papers or this year', () => {
    expect(years(1890, null)).toBe('[1890 TO 2026]');
    expect(years(null, 1900)).toBe('[1839 TO 1900]');
  });

  it('sends none for none, or for years that are not years', () => {
    expect(years(null, null)).toBeNull();
    expect(years(0, 99_999)).toBeNull();
  });

  it('keeps a range that is in order, even before the papers began', () => {
    expect(years(1700, null)).toBe('[1700 TO 2026]');
  });

  it('refuses years outside the collection', () => {
    for (const [from, to] of [
      [1900, 1890],
      [1850, 1800],
      [null, 1700],
      [2100, null],
    ] as const) {
      expect(() => years(from, to)).toThrow(ConnectorError);
    }
    expect(() => years(null, 1700)).toThrow(
      'Papers Past holds no newspapers from those years (it starts in 1839).',
    );
  });
});

describe('papersPastSearchParams', () => {
  it('asks records.json for the collection, the years, a few fields and a page', () => {
    expect(papersPastSearchParams(query(), asked, 2026)).toEqual({
      text: '"hemi rangi"',
      'and[primary_collection][]': 'Papers Past',
      'and[year][]': '[1890 TO 1900]',
      fields: 'id,title,display_date,date,publisher,collection_title,landing_url',
      per_page: 20,
      page: 1,
    });
  });

  it('sends no year clause, no state, no key and no text of the article', () => {
    const params = papersPastSearchParams(query({ fromYear: null, toYear: null }), asked, 2026);
    expect(Object.keys(params)).not.toContain('and[year][]');
    const sent = JSON.stringify(params).toLowerCase();
    expect(sent).not.toContain('state');
    expect(sent).not.toContain('vermont');
    expect(sent).not.toContain('api_key');
    expect(String(params['fields'])).not.toMatch(/fulltext|description/);
  });

  it('counts pages from 1 by the offset, and stops asking far on', () => {
    const at = (offset: number) => papersPastSearchParams(query(), { offset, limit: 20 }, 2026);
    expect(at(0)['page']).toBe(1);
    expect(at(19)['page']).toBe(1);
    expect(at(20)['page']).toBe(2);
    expect(at(60)['page']).toBe(4);
    expect(at(-5)['page']).toBe(1);
    expect(at(10_000)['page']).toBe(PAPERS_PAST_LAST_OFFSET / 20 + 1);
    expect(papersPastSearchParams(query(), { offset: 0, limit: 500 }, 2026)['per_page']).toBe(20);
  });
});

describe('parsePapersPastSearch', () => {
  it('reads an article into a record, with the newspaper that is not Papers Past', () => {
    expect(parsePapersPastSearch(answer([article], 1), asked)).toEqual({
      items: [
        {
          connectorId: 'papers-past',
          key: '90000001',
          kind: 'text',
          title: 'Mr Hemi Rangi at the sale',
          url: 'https://paperspast.natlib.govt.nz/newspapers/WDT18950312.2.9',
          date: '12 MAR 1895',
          by: 'Wairarapa Daily Times',
          about: '',
        },
      ],
      total: 1,
      next: null,
      hidden: 0,
    });
  });

  it('also reads the count and results at the top of an answer', () => {
    const page = parsePapersPastSearch({ result_count: 3, results: [article] }, asked);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('takes the newspaper from the publisher when the collection names none', () => {
    const items = parsePapersPastSearch(
      answer([
        { ...article, id: '90000002', collection_title: ['Papers Past'] },
        { ...article, id: '90000003', collection_title: 'Otago Chronicle' },
        { ...article, id: '90000004', collection_title: [], publisher: [] },
      ]),
      asked,
    ).items;
    expect(items.map((item) => item.by)).toEqual(['Ada Pembury Press', 'Otago Chronicle', '']);
  });

  it('gives the date in GEDCOM words, from the written date or the stamp', () => {
    const items = parsePapersPastSearch(
      answer([
        { ...article, id: '1', display_date: '1895' },
        { ...article, id: '2', display_date: 'March 1895' },
        { ...article, id: '3', display_date: 'sometime', date: ['1901-07-04T00:00:00.000Z'] },
        { ...article, id: '4', display_date: undefined, date: [] },
      ]),
      asked,
    ).items;
    expect(items.map((item) => item.date)).toEqual(['1895', 'MAR 1895', '4 JUL 1901', '']);
  });

  it('leaves out what has no usable number or no page on Papers Past', () => {
    const results = [
      { ...article, id: 'abc' },
      { ...article, id: '' },
      { ...article, id: '1234567890123456' },
      { ...article, id: 1.5 },
      { ...article, id: null },
      { ...article, id: '90000005', landing_url: 'http://paperspast.natlib.govt.nz/x' },
      {
        ...article,
        id: '90000006',
        landing_url: 'https://paperspast.natlib.govt.nz.evil.example/x',
      },
      { ...article, id: '90000007', landing_url: 'https://evil.example/paperspast.natlib.govt.nz' },
      { ...article, id: '90000008', landing_url: 'https://user@paperspast.natlib.govt.nz/x' },
      { ...article, id: '90000009', landing_url: 'https://natlib.govt.nz/x' },
      { ...article, id: '90000010', landing_url: undefined },
      'not an object',
      { ...article, id: 90000011 },
      { ...article, id: '90000011' },
    ];
    const page = parsePapersPastSearch(answer(results, 50), { offset: 0, limit: 20 });
    expect(page.items.map((item) => item.key)).toEqual(['90000011']);
  });

  it('gives an article without a heading a name of its own', () => {
    const [item] = parsePapersPastSearch(answer([{ ...article, title: '  ' }]), asked).items;
    expect(item?.title).toBe('Papers Past item 90000001');
    const [long] = parsePapersPastSearch(
      answer([{ ...article, title: 'x'.repeat(900) }]),
      asked,
    ).items;
    expect(long?.title.length).toBeLessThanOrEqual(500);
  });

  it('reads an answer that is not one as a fault', () => {
    for (const bad of [null, 'no', [], {}, { search: {} }, { results: 'x' }]) {
      expect(() => parsePapersPastSearch(bad, asked)).toThrow(ConnectorError);
    }
  });

  it('knows when there is another page', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ ...article, id: 100 + index }));
    expect(parsePapersPastSearch(answer(many, 45), asked).next).toEqual({ offset: 20, limit: 20 });
    expect(parsePapersPastSearch(answer(many, 45), { offset: 40, limit: 20 }).next).toBeNull();
    expect(parsePapersPastSearch(answer(many, 20), asked).next).toBeNull();
    expect(parsePapersPastSearch(answer([], 45), asked).next).toBeNull();
    const far = { offset: PAPERS_PAST_LAST_OFFSET, limit: 20 };
    expect(parsePapersPastSearch(answer(many, 99_999), far).next).toBeNull();
    expect(parsePapersPastSearch({ results: many }, asked).next).toEqual({ offset: 20, limit: 20 });
  });
});

describe('papersPastConnector', () => {
  const setup = (data: unknown, key = false) => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const http = new HttpClient({
      fetch: (url, init) => {
        sent.push({ url, headers: init.headers });
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
      userAgent: 'RulZAncestry/test',
      keyOf: () => (key ? { kind: 'key', value: 'canary-key-0123456789' } : { kind: 'none' }),
      memory: { load: () => null, save: () => undefined },
    });
    return { connector: papersPastConnector(http.for(papersPastManifest)), sent };
  };

  it('asks records.json of DigitalNZ and sends no header without a key', async () => {
    const { connector, sent } = setup(answer([article], 1));
    const found = await connector.searchTexts(query(), asked);
    expect(found.page.items).toHaveLength(1);
    const url = new URL(sent[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.digitalnz.org/v3/records.json');
    expect(url.searchParams.get('text')).toBe('"hemi rangi"');
    expect(url.searchParams.get('and[primary_collection][]')).toBe('Papers Past');
    expect(url.searchParams.get('and[year][]')).toBe('[1890 TO 1900]');
    expect(url.searchParams.get('per_page')).toBe('20');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.search.toLowerCase()).not.toContain('vermont');
    expect(url.search).not.toContain('state');
    expect(Object.keys(sent[0]?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'authentication-token',
    );
  });

  it('sends a saved key in the header and not in the address', async () => {
    const { connector, sent } = setup(answer([article], 1), true);
    await connector.searchTexts(query(), asked);
    expect(sent[0]?.headers['authentication-token']).toBe('canary-key-0123456789');
    expect(sent[0]?.url).not.toContain('canary-key');
  });

  it('asks the page the offset falls on', async () => {
    const { connector, sent } = setup(answer([article], 100));
    await connector.searchTexts(query(), { offset: 40, limit: 20 });
    expect(new URL(sent[0]?.url ?? '').searchParams.get('page')).toBe('3');
  });

  it('refuses a query with no words, without asking', async () => {
    const { connector, sent } = setup(answer([]));
    await expect(connector.searchTexts(query({ words: ' ~ "" ' }), asked)).rejects.toThrow(
      ConnectorError,
    );
    expect(sent).toEqual([]);
  });

  it('refuses years outside the collection, without asking', async () => {
    const { connector, sent } = setup(answer([]));
    await expect(
      connector.searchTexts(query({ fromYear: null, toYear: 1700 }), asked),
    ).rejects.toMatchObject({ kind: 'refused' });
    expect(sent).toEqual([]);
  });

  it('is made only for the client of its own source', () => {
    const http = new HttpClient({
      fetch: () => Promise.reject(new Error('nothing may be asked')),
      userAgent: 'RulZAncestry/test',
    });
    expect(() => papersPastConnector(http.for(papersPastManifest))).not.toThrow();
  });
});
