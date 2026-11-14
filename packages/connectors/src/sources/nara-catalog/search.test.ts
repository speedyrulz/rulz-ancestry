import type { TextQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient, HttpError } from '../../http';
import { naraCatalogManifest } from './manifest';
import { naraCatalogConnector, naraSearchParams, naraWords, parseNaraSearch } from './search';

// The descriptions below are made up. The shape is the one the Archives'
// getting-started guide and example scripts show; it was not seen in a real
// answer, because the connector was written without a key.
const hit = (record: unknown) => ({ _index: 'descriptions', _id: 'x', _source: { record } });

const file = {
  naId: 90000001,
  title: 'Pension file of Josiah Marsh',
  levelOfDescription: 'fileUnit',
  coverageStartDate: { year: 1862, logicalDate: '1862-01-01' },
  coverageEndDate: { year: 1910, logicalDate: '1910-12-31' },
};

const answer = (
  records: unknown[],
  total: unknown = { value: records.length, relation: 'eq' },
) => ({
  statusCode: 200,
  body: { hits: { total, hits: records.map(hit) } },
});

const page = { offset: 0, limit: 20 };

const query = (changes: Partial<TextQuery> = {}): TextQuery => ({
  words: 'Josiah Marsh',
  phrase: true,
  fromYear: 1835,
  toYear: 1911,
  state: 'Vermont',
  ...changes,
});

/** A key that is none: it only has to be found again wherever it must not be. */
const CANARY = 'canary-key-0123456789';

describe('parseNaraSearch', () => {
  it('reads a description into a record, with a link of its own making', () => {
    expect(parseNaraSearch(answer([file]), page)).toEqual({
      items: [
        {
          connectorId: 'nara-catalog',
          key: '90000001',
          kind: 'text',
          title: 'Pension file of Josiah Marsh',
          url: 'https://catalog.archives.gov/id/90000001',
          date: '',
          by: '',
          about: 'File unit, 1862–1910',
        },
      ],
      total: 1,
      next: null,
      hidden: 0,
    });
  });

  it('reads what a description leaves out or gives in another way', () => {
    const records = parseNaraSearch(
      answer([
        { naId: '90000002' },
        {
          naId: 90000003,
          title: 'A series',
          levelOfDescription: 'series',
          inclusiveStartDate: { year: '1917' },
        },
        { naId: 90000004, levelOfDescription: 'somethingNew', productionDates: [{ year: 1944 }] },
        { naId: 90000005, coverageStartDate: { year: 1900 }, coverageEndDate: { year: 1900 } },
        { naId: 90000006, coverageStartDate: { year: 99_999 }, inclusiveEndDate: 'long ago' },
      ]),
      page,
    ).items;
    expect(records.map((record) => [record.title, record.date, record.about])).toEqual([
      ['National Archives Identifier 90000002', '', ''],
      ['A series', '', 'Series, 1917'],
      ['National Archives Identifier 90000004', '', 'somethingNew, 1944'],
      ['National Archives Identifier 90000005', '', '1900'],
      ['National Archives Identifier 90000006', '', ''],
    ]);
  });

  it('leaves out what is no description it can name, and shows one once', () => {
    const odd = [
      null,
      {},
      { naId: 0 },
      { naId: -5 },
      { naId: 1.5 },
      { naId: '12/../3' },
      { naId: '12?x=1' },
      { naId: 'abc' },
      { title: 'No number' },
    ];
    const read = parseNaraSearch(
      {
        statusCode: 200,
        body: {
          hits: {
            total: 40,
            hits: [...odd.map(hit), { _source: 'none' }, { record: file }, hit(file), hit(file)],
          },
        },
      },
      page,
    );
    expect(read.items.map((record) => record.key)).toEqual(['90000001']);
    // The count can come as a plain number too.
    expect(read.total).toBe(40);
  });

  it('shows text of the catalog as text, cut and cleared of control characters', () => {
    const [record] = parseNaraSearch(
      answer([{ ...file, title: `<b>Pension</b>\n file ${'x'.repeat(400)}` }]),
      page,
    ).items;
    expect(record?.title.startsWith('<b>Pension</b> file xxx')).toBe(true);
    expect(record?.title.length).toBeLessThanOrEqual(200);
  });

  it('pages by whole pages, and stops far down the list', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ naId: 1000 + index }));
    expect(parseNaraSearch(answer(many, { value: 381 }), page).next).toEqual({
      offset: 20,
      limit: 20,
    });
    expect(parseNaraSearch(answer(many, { value: 20 }), page).next).toBeNull();
    expect(parseNaraSearch(answer(many.slice(0, 5), { value: 381 }), page).next).toEqual({
      offset: 20,
      limit: 20,
    });
    // Without a count, a full page means there may be more.
    expect(parseNaraSearch(answer(many, 'many'), page)).toMatchObject({
      total: null,
      next: { offset: 20, limit: 20 },
    });
    expect(
      parseNaraSearch(answer(many, { value: 99_999 }), { offset: 1000, limit: 20 }).next,
    ).toBeNull();
    expect(parseNaraSearch(answer([], { value: 0 }), page)).toMatchObject({
      items: [],
      total: 0,
      next: null,
    });
  });

  it('takes an error inside an answer for an error', () => {
    for (const statusCode of [400, 401, 403, 422, 429, 500]) {
      expect(() => parseNaraSearch({ statusCode, body: { message: 'no' } }, page)).toThrow(
        ConnectorError,
      );
    }
    // "Unauthorized" and "forbidden" are about the key, and are told apart from other errors.
    const kindOf = (statusCode: number) => {
      try {
        parseNaraSearch({ statusCode }, page);
      } catch (error) {
        return error instanceof ConnectorError ? error.kind : 'another error';
      }
      return 'no error';
    };
    expect([401, 403, 429, 500].map(kindOf)).toEqual(['key', 'key', 'refused', 'refused']);
    // What the catalog says in such an answer is not passed on.
    try {
      parseNaraSearch({ statusCode: 403, message: `Forbidden for ${CANARY}` }, page);
      throw new Error('it did not fail');
    } catch (error) {
      expect(String(error)).toContain('did not accept the key');
      expect(String(error)).not.toContain(CANARY);
    }
  });

  it('refuses an answer that is not one', () => {
    for (const data of [null, [], 'text', {}, { body: {} }, { body: { hits: { hits: 'none' } } }]) {
      expect(() => parseNaraSearch(data, page)).toThrow(ConnectorError);
    }
  });
});

describe('what the National Archives are sent', () => {
  it('is the words, and neither the years nor the state', () => {
    expect(naraSearchParams(query(), page)).toEqual({
      q: '"josiah marsh"',
      dataSource: 'description',
      sourceIncludes:
        'naId,title,levelOfDescription,inclusiveStartDate,inclusiveEndDate,coverageStartDate,coverageEndDate,productionDates',
      limit: 20,
      page: 1,
    });
    expect(naraSearchParams(query({ phrase: false }), { offset: 45, limit: 20 })).toMatchObject({
      q: 'josiah marsh',
      page: 3,
    });
    expect(naraSearchParams(query(), { offset: 99_999, limit: 5000 })).toMatchObject({
      limit: 100,
      page: 11,
    });
  });

  it('lets nothing that is typed be a command to the search', () => {
    const typed = [
      ['Marsh" OR "Fenwick', 'marsh or fenwick'],
      ['Marsh AND NOT Fenwick', 'marsh and not fenwick'],
      ['Mar* title:(x) ~2', 'mar title x 2'],
      ['-Marsh', 'marsh'],
      ['Mary-Ann O’Hara, Jr.', 'mary-ann o’hara, jr.'],
    ] as const;
    for (const [words, sent] of typed) {
      expect(naraWords(query({ words })), words).toBe(sent);
    }
    expect(naraSearchParams(query({ words: 'a" OR "b' }), page)['q']).toBe('"a or b"');
  });
});

describe('naraCatalogConnector', () => {
  const setup = (data: unknown, key: string | null = CANARY) => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const http = new HttpClient({
      fetch: (url, init) => {
        asked.push({ url, headers: init.headers });
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
      userAgent: 'RulZAncestry/test',
      keyOf: () => key,
      // The client does not ask a source it counts for without a place to keep the count.
      memory: { load: () => null, save: () => undefined },
    });
    return { connector: naraCatalogConnector(http.for(naraCatalogManifest)), asked, http };
  };

  it('asks the search of the catalog, with the key in its header and nowhere else', async () => {
    const { connector, asked } = setup(answer([file]));
    const found = await connector.searchTexts(query(), page);
    expect(found.page.items).toHaveLength(1);
    const [request] = asked;
    const url = new URL(request?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://catalog.archives.gov/api/v2/records/search');
    expect(url.searchParams.get('q')).toBe('"josiah marsh"');
    expect(request?.headers['x-api-key']).toBe(CANARY);
    expect(request?.url).not.toContain(CANARY);
    expect(url.search).not.toContain('1835');
    expect(url.search.toLowerCase()).not.toContain('vermont');
  });

  it('keeps no answer: the terms of the Archives ask for that', async () => {
    const { connector, asked } = setup(answer([file]));
    await connector.searchTexts(query(), page);
    expect((await connector.searchTexts(query(), page)).cached).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('sends nothing without a key, or with one a header cannot hold', async () => {
    for (const key of [null, '', 'two words', 'line\nbreak', 'x'.repeat(301), 'kéy']) {
      const { connector, asked } = setup(answer([file]), key);
      const error = await connector.searchTexts(query(), page).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).kind).toBe('key');
      // The message says nothing of the key.
      if (key) expect((error as HttpError).message).not.toContain(key);
      expect(asked).toHaveLength(0);
    }
  });

  it('sends nothing for no words, and needs the client of its own source', async () => {
    const { connector, asked, http } = setup(answer([]));
    await expect(connector.searchTexts(query({ words: '"*"' }), page)).rejects.toThrow(
      ConnectorError,
    );
    expect(asked).toHaveLength(0);
    expect(() => naraCatalogConnector(http.for({ ...naraCatalogManifest, id: 'other' }))).toThrow();
  });
});
