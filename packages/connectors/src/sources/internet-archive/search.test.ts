import type { TextQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient } from '../../http';
import { internetArchiveManifest } from './manifest';
import {
  internetArchiveConnector,
  internetArchiveSearchParams,
  internetArchiveWords,
  parseInternetArchiveSearch,
} from './search';

// The books below are made up. The shape is the Archive's, as the service
// answered on 2026-11-13.
const book = {
  identifier: 'marshfamily00exam',
  title: 'Marsh family.',
  creator: 'Fenwick, Henrietta.',
  year: 1930,
  publisher: '[Ashford, 1930]',
};

const answer = (docs: unknown[], numFound: unknown = docs.length) => ({
  responseHeader: { status: 0, QTime: 3, params: {} },
  response: { numFound, start: 0, docs },
});

const page = { offset: 0, limit: 20 };

const query = (changes: Partial<TextQuery> = {}): TextQuery => ({
  words: 'Marsh family',
  phrase: true,
  fromYear: 1850,
  toYear: 1913,
  state: 'Vermont',
  ...changes,
});

describe('parseInternetArchiveSearch', () => {
  it('reads an item into a record, with a link of its own making', () => {
    expect(parseInternetArchiveSearch(answer([book]), page)).toEqual({
      items: [
        {
          connectorId: 'internet-archive',
          key: 'marshfamily00exam',
          kind: 'text',
          title: 'Marsh family.',
          url: 'https://archive.org/details/marshfamily00exam',
          date: '1930',
          by: 'Fenwick, Henrietta.',
          about: '',
        },
      ],
      total: 1,
      next: null,
      hidden: 0,
    });
  });

  it('reads what an item leaves out or gives as a list', () => {
    const [bare, listed, published] = parseInternetArchiveSearch(
      answer([
        { identifier: 'gov.example.556440' },
        {
          identifier: 'a-b_c.1',
          title: ['One title', 'Another'],
          creator: ['Marsh, Josiah', 'Fenwick, Etta', 7, ''],
          year: '1885',
        },
        { identifier: 'pub1', title: 'T', publisher: 'Ashford : Example Press', year: 99_999 },
      ]),
      page,
    ).items;
    expect(bare).toMatchObject({ title: 'gov.example.556440', date: '', by: '' });
    expect(listed).toMatchObject({
      title: 'One title; Another',
      by: 'Marsh, Josiah; Fenwick, Etta',
      date: '1885',
    });
    expect(published).toMatchObject({ by: 'Ashford : Example Press', date: '' });
  });

  it('leaves out an item whose name is no name of the Archive', () => {
    const odd = [
      null,
      {},
      { identifier: 7 },
      { identifier: '' },
      { identifier: '../etc' },
      { identifier: 'a/b' },
      { identifier: 'a b' },
      { identifier: 'a?b=c' },
      { identifier: '.hidden' },
      { identifier: 'x'.repeat(101) },
    ];
    const read = parseInternetArchiveSearch(answer([...odd, book], 30), page);
    expect(read.items.map((record) => record.key)).toEqual(['marshfamily00exam']);
  });

  it('shows text of the Archive as text, cut and cleared of control characters', () => {
    const [record] = parseInternetArchiveSearch(
      answer([{ ...book, title: `<i>Marsh</i>\u0007\n family ${'x'.repeat(400)}` }]),
      page,
    ).items;
    expect(record?.title.startsWith('<i>Marsh</i> family xxx')).toBe(true);
    expect(record?.title.length).toBeLessThanOrEqual(200);
  });

  it('says whether there is more, and stops asking far down the list', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ identifier: `item${index}` }));
    expect(parseInternetArchiveSearch(answer(many, 90), page).next).toEqual({
      offset: 20,
      limit: 20,
    });
    expect(parseInternetArchiveSearch(answer(many, 20), page).next).toBeNull();
    expect(
      parseInternetArchiveSearch(answer(many, 99_999), { offset: 1000, limit: 20 }).next,
    ).toBeNull();
    expect(parseInternetArchiveSearch(answer([book, book]), page).items).toHaveLength(1);
  });

  it('goes on to the next page after a page that came short', () => {
    const half = Array.from({ length: 10 }, (_, index) => ({ identifier: `item${index}` }));
    const next = parseInternetArchiveSearch(answer(half, 100), page).next;
    expect(next).toEqual({ offset: 20, limit: 20 });
    expect(internetArchiveSearchParams(query(), next ?? page)).toMatchObject({ page: 2 });
  });

  it('refuses an answer that is not one', () => {
    for (const data of [null, [], {}, { response: {} }, { response: { docs: 'none' } }]) {
      expect(() => parseInternetArchiveSearch(data, page)).toThrow(ConnectorError);
    }
  });
});

describe('internetArchiveSearchParams', () => {
  it('sends the words, and neither the years nor the state', () => {
    expect(internetArchiveSearchParams(query(), page)).toEqual({
      q: '("marsh family") AND mediatype:texts',
      'fl[0]': 'identifier',
      'fl[1]': 'title',
      'fl[2]': 'creator',
      'fl[3]': 'year',
      'fl[4]': 'publisher',
      rows: 20,
      page: 1,
      output: 'json',
    });
    expect(
      internetArchiveSearchParams(query({ phrase: false }), { offset: 40, limit: 20 }),
    ).toMatchObject({
      q: '(marsh family) AND mediatype:texts',
      page: 3,
    });
  });

  it('lets nothing that is typed be a command to the search', () => {
    const typed = [
      ['Marsh" OR collection:(everything', 'marsh or collection everything'],
      ['marsh AND NOT fenwick', 'marsh and not fenwick'],
      ['title:marsh^5 ~2 *', 'title marsh 5 2'],
      ['[1800 TO 1900]', '1800 to 1900'],
      ["O'Hara, J. \\ / ()", "o'hara, j."],
      ['Müller  Søren', 'müller søren'],
    ] as const;
    for (const [words, sent] of typed) {
      expect(internetArchiveWords(query({ words })), words).toBe(sent);
    }
    expect(internetArchiveSearchParams(query({ words: 'a") OR (b' }), page)['q']).toBe(
      '("a or b") AND mediatype:texts',
    );
  });
});

describe('internetArchiveConnector', () => {
  const setup = (data: unknown) => {
    const asked: string[] = [];
    const http = new HttpClient({
      fetch: (url) => {
        asked.push(url);
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
      userAgent: 'RulZAncestry/test',
    });
    return { connector: internetArchiveConnector(http.for(internetArchiveManifest)), asked };
  };

  it('asks the search of the Archive, and nothing else', async () => {
    const { connector, asked } = setup(answer([book]));
    const found = await connector.searchTexts(query(), page);
    expect(found.page.items).toHaveLength(1);
    const url = new URL(asked[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://archive.org/advancedsearch.php');
    expect(url.searchParams.get('q')).toBe('("marsh family") AND mediatype:texts');
    expect(url.searchParams.get('output')).toBe('json');
    expect(url.search).not.toContain('1850');
    expect(url.search.toLowerCase()).not.toContain('vermont');
  });

  it('sends nothing when no word is left to ask for', async () => {
    const { connector, asked } = setup(answer([]));
    for (const words of ['', '  ', '"()" *']) {
      await expect(connector.searchTexts(query({ words }), page)).rejects.toThrow(ConnectorError);
    }
    expect(asked).toHaveLength(0);
  });

  it('needs the client of its own source', () => {
    const http = new HttpClient({
      fetch: () => Promise.reject(new Error('nothing may be asked')),
      userAgent: 'RulZAncestry/test',
    });
    expect(() =>
      internetArchiveConnector(http.for({ ...internetArchiveManifest, id: 'other' })),
    ).toThrow();
  });
});
