import type { TextQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient } from '../../http';
import { locManifest } from './manifest';
import { locConnector, locSearchParams, locWords, parseLocSearch } from './search';

// The newspapers below are made up. The shape is the Library's, as the service
// answered on 2026-11-13; only the fields the connector reads are kept.
const first = {
  id: 'http://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
  title: 'Image 8 of The Ashford gazette (Ashford, Vt.), May 1, 1903',
  url: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8&q=josiah+marsh',
  date: '1903-05-01',
  description: ['The start of the text of the page, which is not where the words stand'],
  image_url: ['https://tile.loc.gov/image-services/iiif/example/full/pct:6.25/0/default.jpg'],
};

const second = {
  id: 'http://www.loc.gov/resource/sn99000002/1910-04-27/ed-2/?sp=1',
  title: 'Image 1 of Example County journal (Ashford, Vt.), April 27, 1910',
  date: '1910-04-27',
};

const answer = (results: unknown[], of: unknown = results.length) => ({
  pagination: { current: 1, from: 1, of, next: null, total: 1 },
  results,
});

const page = { offset: 0, limit: 20 };

const query = (changes: Partial<TextQuery> = {}): TextQuery => ({
  words: 'Josiah Marsh',
  phrase: true,
  fromYear: 1850,
  toYear: 1913,
  state: '',
  ...changes,
});

describe('parseLocSearch', () => {
  it('reads a page of a newspaper into a record, with a link of its own making', () => {
    expect(parseLocSearch(answer([first, second]), page)).toEqual({
      items: [
        {
          connectorId: 'loc',
          key: 'sn99000001/1903-05-01/ed-1/seq-8',
          kind: 'text',
          title: 'Image 8 of The Ashford gazette (Ashford, Vt.), May 1, 1903',
          // Not the link of the answer: that one carries the words of the search.
          url: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
          date: '1 MAY 1903',
          by: '',
        },
        {
          connectorId: 'loc',
          key: 'sn99000002/1910-04-27/ed-2/seq-1',
          kind: 'text',
          title: 'Image 1 of Example County journal (Ashford, Vt.), April 27, 1910',
          url: 'https://www.loc.gov/resource/sn99000002/1910-04-27/ed-2/?sp=1',
          date: '27 APR 1910',
          by: '',
        },
      ],
      total: 2,
      next: null,
      hidden: 0,
    });
  });

  it('leaves out what is no page of a newspaper at the Library', () => {
    const odd = [
      null,
      'text',
      {},
      { id: 7 },
      { id: 'not an address' },
      { id: 'https://elsewhere.example/resource/sn99000001/1903-05-01/ed-1/?sp=8' },
      { id: 'https://www.loc.gov.elsewhere.example/resource/sn99000001/1903-05-01/ed-1/?sp=8' },
      { id: 'https://www.loc.gov/item/sn99000001/' },
      { id: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/' },
      { id: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=0' },
      { id: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8x' },
      { id: 'https://www.loc.gov/resource/../etc/1903-05-01/ed-1/?sp=8' },
      { id: 'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/extra/?sp=8' },
    ];
    const read = parseLocSearch(answer([...odd, first], 40), { offset: 0, limit: 20 });
    expect(read.items.map((record) => record.key)).toEqual(['sn99000001/1903-05-01/ed-1/seq-8']);
    expect(read.hidden).toBe(0);
  });

  it('shows text of the Library as text, cut and cleared of control characters', () => {
    const [record] = parseLocSearch(
      answer([{ ...first, title: `<b>Image</b>\u0000 8\n of ${'x'.repeat(400)}` }]),
      page,
    ).items;
    expect(record?.title.startsWith('<b>Image</b> 8 of xxx')).toBe(true);
    expect(record?.title.length).toBeLessThanOrEqual(200);
    // A page without a title is named by what the app knows of it.
    const [bare] = parseLocSearch(answer([{ id: first.id }]), page).items;
    expect(bare?.title).toBe('Image 8 of sn99000001, 1903-05-01');
    // A date that is none is not given.
    const [undated] = parseLocSearch(
      answer([{ id: 'https://www.loc.gov/resource/sn99000001/1903-13-01/ed-1/?sp=8' }]),
      page,
    ).items;
    expect(undated?.date).toBe('');
  });

  it('shows a page once, and takes no more than was asked for', () => {
    expect(parseLocSearch(answer([first, first, second]), page).items).toHaveLength(2);
    expect(parseLocSearch(answer([first, second], 2), { offset: 0, limit: 1 }).items).toHaveLength(
      1,
    );
  });

  it('says whether there is more, and stops asking far down the list', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: `https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=${index + 1}`,
    }));
    expect(parseLocSearch(answer(many, 381), page).next).toEqual({ offset: 20, limit: 20 });
    expect(parseLocSearch(answer(many, 20), page).next).toBeNull();
    // Without a count, a full page means there may be more.
    expect(parseLocSearch(answer(many, 'many'), page)).toMatchObject({
      total: null,
      next: { offset: 20, limit: 20 },
    });
    expect(parseLocSearch(answer(many, 99_999), { offset: 1000, limit: 20 }).next).toBeNull();
    expect(parseLocSearch(answer([], 0), page)).toMatchObject({ items: [], total: 0, next: null });
  });

  it('goes on to the next page after a page that came short', () => {
    const half = Array.from({ length: 10 }, (_, index) => ({
      id: `https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=${index + 1}`,
    }));
    // Ten came where twenty were asked for, of a hundred: the next are those of the second page.
    const next = parseLocSearch(answer(half, 100), page).next;
    expect(next).toEqual({ offset: 20, limit: 20 });
    expect(locSearchParams(query(), next ?? page)).toMatchObject({ sp: 2 });
    // Without a count, a short page is the last.
    expect(parseLocSearch(answer(half, 'many'), page).next).toBeNull();
  });

  it('refuses an answer that is not one', () => {
    for (const data of [null, [], 'text', {}, { results: 'none' }, { pagination: { of: 3 } }]) {
      expect(() => parseLocSearch(data, page)).toThrow(ConnectorError);
    }
  });
});

describe('locSearchParams', () => {
  it('sends the words, the years and the state, and nothing else of a tree', () => {
    expect(locSearchParams(query({ state: 'New York' }), page)).toEqual({
      dl: 'page',
      ops: 'PHRASE',
      qs: 'Josiah Marsh',
      searchType: 'advanced',
      start_date: '1850-01-01',
      end_date: '1913-12-31',
      location_state: 'new york',
      fo: 'json',
      at: 'results,pagination',
      c: 20,
      sp: 1,
    });
  });

  it('leaves out what is not asked', () => {
    const params = locSearchParams(
      query({ words: '  Marsh   Ashford ', phrase: false, fromYear: null, toYear: null }),
      page,
    );
    expect(params).toMatchObject({ ops: 'AND', qs: 'Marsh Ashford' });
    expect(params['start_date']).toBeUndefined();
    expect(params['end_date']).toBeUndefined();
    expect(params['location_state']).toBeUndefined();
    expect(locSearchParams(query({ fromYear: 987, toYear: null }), page)['start_date']).toBe(
      '0987-01-01',
    );
  });

  it('sends what is typed as words, and no sign that could be a command', () => {
    const typed = [
      ['smith" OR "jones', 'smith OR jones'],
      ['title:(marsh) AND -fenwick*', 'title marsh AND -fenwick'],
      ['Mary-Ann O’Hara, Jr.', 'Mary-Ann O’Hara, Jr.'],
      ["O'Hara ~2 ^5 [1900 TO 1910] \\ / ?", "O'Hara 2 5 1900 TO 1910"],
      ['Müller  Søren', 'Müller Søren'],
    ] as const;
    for (const [words, sent] of typed) {
      expect(locWords(query({ words })), words).toBe(sent);
      expect(String(locSearchParams(query({ words }), page)['qs'])).not.toMatch(/["():*?~^[\]\\/]/);
    }
  });

  it('asks for whole pages of results, within limits', () => {
    expect(locSearchParams(query(), { offset: 40, limit: 20 })).toMatchObject({ c: 20, sp: 3 });
    expect(locSearchParams(query(), { offset: 45, limit: 20 })).toMatchObject({ c: 20, sp: 3 });
    expect(locSearchParams(query(), { offset: -5, limit: 0 })).toMatchObject({ c: 1, sp: 1 });
    expect(locSearchParams(query(), { offset: 99_999, limit: 5000 })).toMatchObject({
      c: 100,
      sp: 11,
    });
  });
});

describe('locConnector', () => {
  const setup = (data: unknown) => {
    const asked: string[] = [];
    const http = new HttpClient({
      fetch: (url) => {
        asked.push(url);
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
      userAgent: 'RulZAncestry/test',
    });
    return { connector: locConnector(http.for(locManifest)), asked };
  };

  it('asks the collection of newspapers, at the Library only', async () => {
    const { connector, asked } = setup(answer([first], 1));
    const found = await connector.searchTexts(query(), page);
    expect(found.page.items).toHaveLength(1);
    expect(found.cached).toBe(false);
    const url = new URL(asked[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://www.loc.gov/collections/chronicling-america/');
    expect(url.searchParams.get('qs')).toBe('Josiah Marsh');
    expect(url.searchParams.get('fo')).toBe('json');
    // The same search again is answered from memory.
    expect((await connector.searchTexts(query(), page)).cached).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('sends nothing for no words', async () => {
    const { connector, asked } = setup(answer([]));
    for (const words of ['  ', '"()" *']) {
      await expect(connector.searchTexts(query({ words }), page)).rejects.toThrow(ConnectorError);
    }
    expect(asked).toHaveLength(0);
  });

  it('needs the client of its own source', () => {
    const http = new HttpClient({
      fetch: () => Promise.reject(new Error('nothing may be asked')),
      userAgent: 'RulZAncestry/test',
    });
    expect(() => locConnector(http.for({ ...locManifest, id: 'other' }))).toThrow();
  });
});
