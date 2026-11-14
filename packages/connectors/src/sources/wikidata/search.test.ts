import type { PersonQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient } from '../../http';
import { wikidataManifest } from './manifest';
import {
  parseWikidataSearch,
  wikidataConnector,
  wikidataName,
  wikidataQuery,
  wikidataSearchParams,
} from './search';

// The people below are made up. The shape is that of the Wikidata Query
// Service, as it answered on 2026-11-13.
const uri = (value: string) => ({ type: 'uri', value });
const text = (value: string) => ({ type: 'literal', 'xml:lang': 'en', value });
const date = (value: string) => ({
  type: 'literal',
  datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
  value,
});

const num = (value: number) => ({
  type: 'literal',
  datatype: 'http://www.w3.org/2001/XMLSchema#integer',
  value: String(value),
});

/**
 * A row of an answer. The birth is known to the day and the death to the year
 * unless `extra` says otherwise; the latest year the birth can lie in is the
 * year of the birth unless `extra` gives another.
 */
const row = (number: number, extra: Record<string, unknown> = {}) => {
  const merged: Record<string, unknown> = {
    item: uri(`http://www.wikidata.org/entity/Q${number}`),
    ordinal: { type: 'literal', value: String(number) },
    name: text('Josiah Marsh'),
    description: text('American surveyor (1835–1910)'),
    birth: date('1835-11-30T00:00:00Z'),
    death: date('1910-01-01T00:00:00Z'),
    deathPrecision: num(9),
    gender: uri('http://www.wikidata.org/entity/Q6581097'),
    ...extra,
  };
  const born = merged['birth'] as { value?: string } | undefined;
  const year = /^\d{4}/.exec(born?.value ?? '')?.[0];
  return {
    birthPrecision: num(11),
    ...(year === undefined ? {} : { birthLatest: num(Number(year)) }),
    ...merged,
  };
};

const answer = (bindings: unknown[]) => ({ head: { vars: [] }, results: { bindings } });

const page = { offset: 0, limit: 20 };
const YEAR = 2026;

const query = (changes: Partial<PersonQuery> = {}): PersonQuery => ({
  given: 'Josiah',
  surname: 'Marsh',
  birthYear: 1835,
  deathYear: 1910,
  ...changes,
});

describe('parseWikidataSearch', () => {
  it('reads an entry into a record, with a link of its own making', () => {
    expect(parseWikidataSearch(answer([row(90001)]), page, YEAR)).toEqual({
      items: [
        {
          connectorId: 'wikidata',
          key: 'Q90001',
          kind: 'person',
          title: 'Josiah Marsh',
          url: 'https://www.wikidata.org/wiki/Q90001',
          sex: 'M',
          // The death is known to the year only, and is shown as the year.
          facts: [
            { type: 'birth', date: '30 NOV 1835', place: '' },
            { type: 'death', date: '1910', place: '' },
          ],
          about: 'American surveyor (1835–1910)',
        },
      ],
      total: null,
      next: null,
      hidden: 0,
    });
  });

  it('reads what an entry leaves out', () => {
    const [bare, woman] = parseWikidataSearch(
      answer([
        {
          item: uri('http://www.wikidata.org/entity/Q7'),
          death: date('1890-07-29T00:00:00Z'),
          deathPrecision: num(11),
        },
        row(8, {
          gender: uri('http://www.wikidata.org/entity/Q6581072'),
          death: undefined,
          birth: date('1700-05-02T00:00:00Z'),
        }),
      ]),
      page,
      YEAR,
    ).items;
    expect(bare).toMatchObject({
      key: 'Q7',
      title: 'Q7',
      sex: null,
      about: '',
      facts: [{ type: 'death', date: '29 JUL 1890', place: '' }],
    });
    expect(woman).toMatchObject({
      sex: 'F',
      facts: [{ type: 'birth', date: '2 MAY 1700', place: '' }],
    });
  });

  it('shows nobody who may be living', () => {
    const read = parseWikidataSearch(
      answer([
        // No death, and born within the last 110 years: may be living.
        row(1, { death: undefined, birth: date('1960-03-01T00:00:00Z') }),
        row(2, { death: undefined, birth: date('1917-01-01T00:00:00Z') }),
        // No dates at all.
        row(3, { death: undefined, birth: undefined }),
        // Born in 1916: the last day of that year is not 110 years back yet.
        row(7, { death: undefined, birth: date('1916-01-01T00:00:00Z') }),
        // Born more than 110 years ago, on whatever day: taken to have died.
        row(4, { death: undefined, birth: date('1915-12-31T00:00:00Z') }),
        // A death, however recent.
        row(5, { birth: date('1990-01-01T00:00:00Z'), death: date('2020-02-03T00:00:00Z') }),
        // A death that is no date is none.
        row(6, { birth: date('1990-01-01T00:00:00Z'), death: text('unknown value') }),
        // Nor is one that only starts like a date, or names a day that does not exist.
        row(8, { birth: date('1990-01-01T00:00:00Z'), death: date('2020-02-03Tgarbage') }),
        row(9, { birth: date('1990-01-01T00:00:00Z'), death: date('2020-02-31T00:00:00Z') }),
        row(10, { birth: date('1990-01-01T00:00:00Z'), death: date('2020-13-01T00:00:00Z') }),
        row(11, { birth: date('1990-01-01T00:00:00Z'), death: date('0000-01-01T00:00:00Z') }),
        row(12, { birth: date('1990-01-01T00:00:00Z'), death: date('-0044-03-15T00:00:00Z') }),
        // A birth that is no date is none either.
        row(13, { death: undefined, birth: date('1800-02-30T00:00:00Z') }),
      ]),
      page,
      YEAR,
    );
    expect(read.items.map((record) => record.key)).toEqual(['Q4', 'Q5']);
    expect(read.hidden).toBe(11);
  });

  it('reads a date as exactly as the entry knows it, and no more', () => {
    const read = parseWikidataSearch(
      answer([
        // To the month.
        row(1, { birth: date('1850-06-01T00:00:00Z'), birthPrecision: num(10) }),
        // To the year: the first of January is not a day.
        row(2, { birth: date('1850-01-01T00:00:00Z'), birthPrecision: num(9) }),
        // To the century: no date is shown, and the death still is.
        row(3, { birth: date('1801-01-01T00:00:00Z'), birthPrecision: num(7) }),
        // Without word of how exact: to the year.
        row(4, { birthPrecision: undefined, deathPrecision: undefined }),
      ]),
      page,
      YEAR,
    );
    expect(read.items.map((record) => record.facts.map((fact) => fact.date))).toEqual([
      ['JUN 1850', '1910'],
      ['1850', '1910'],
      ['1910'],
      ['1835', '1910'],
    ]);
  });

  it('counts a birth by the last year it can lie in', () => {
    const born = (year: number, precision: number, latest: number | undefined) => ({
      death: undefined,
      birth: date(`${year}-01-01T00:00:00Z`),
      birthPrecision: num(precision),
      birthLatest: latest === undefined ? undefined : num(latest),
    });
    const read = parseWikidataSearch(
      answer([
        // "The twentieth century" can be 1990: may be living.
        row(1, born(1901, 7, 2000)),
        // "The 1910s" can be 1919.
        row(2, born(1910, 8, 1919)),
        // "The nineteenth century" cannot.
        row(3, born(1801, 7, 1900)),
        // "The 1900s", the decade, cannot either.
        row(4, born(1900, 8, 1909)),
        // Two births, of 1890 and of 1950: the later one counts.
        row(5, born(1950, 11, 1950)),
        // Without the last year, nothing says how long ago it was.
        row(6, born(1801, 7, undefined)),
        row(7, { ...born(1801, 7, 1900), birthLatest: text('long ago') }),
      ]),
      page,
      YEAR,
    );
    expect(read.items.map((record) => record.key)).toEqual(['Q3', 'Q4']);
    // Nothing is shown of a birth that is known to the century only.
    expect(read.items.map((record) => record.facts)).toEqual([[], []]);
    expect(read.hidden).toBe(5);
  });

  it('leaves out what is no entry of Wikidata, and shows an entry once', () => {
    const odd = [
      null,
      {},
      { item: 'Q1' },
      { item: uri('https://elsewhere.example/entity/Q1') },
      { item: uri('http://www.wikidata.org/entity/P31') },
      { item: uri('http://www.wikidata.org/entity/Q1/../Q2') },
      { item: uri('http://www.wikidata.org/entity/Q0') },
    ];
    const read = parseWikidataSearch(answer([...odd, row(9), row(9)]), page, YEAR);
    expect(read.items.map((record) => record.key)).toEqual(['Q9']);
  });

  it('shows text of the service as text', () => {
    const [record] = parseWikidataSearch(
      answer([row(1, { name: text(`<b>Josiah</b>\n Marsh ${'x'.repeat(300)}`) })]),
      page,
      YEAR,
    ).items;
    expect(record?.title.startsWith('<b>Josiah</b> Marsh xxx')).toBe(true);
    expect(record?.title.length).toBeLessThanOrEqual(200);
  });

  it('knows there is more when one more than a page came', () => {
    const rows = Array.from({ length: 21 }, (_, index) => row(index + 1));
    const full = parseWikidataSearch(answer(rows), page, YEAR);
    expect(full.items).toHaveLength(20);
    expect(full.next).toEqual({ offset: 20, limit: 20 });
    expect(parseWikidataSearch(answer(rows.slice(0, 20)), page, YEAR).next).toBeNull();
    // Far down the list no more is asked for.
    expect(parseWikidataSearch(answer(rows), { offset: 200, limit: 20 }, YEAR).next).toBeNull();
    expect(parseWikidataSearch(answer([]), page, YEAR)).toEqual({
      items: [],
      total: null,
      next: null,
      hidden: 0,
    });
  });

  it('refuses an answer that is not one', () => {
    for (const data of [null, [], {}, { results: {} }, { results: { bindings: 'none' } }]) {
      expect(() => parseWikidataSearch(data, page, YEAR)).toThrow(ConnectorError);
    }
  });
});

describe('what Wikidata is sent', () => {
  it('is a question that holds the name, and neither of the years', () => {
    const params = wikidataSearchParams(query(), page);
    expect(Object.keys(params)).toEqual(['format', 'query']);
    expect(params['format']).toBe('json');
    const question = String(params['query']);
    // The rule that keeps the search to humans comes first, and the name after it.
    expect(question).toContain('mwapi:srsearch "haswbstatement:P31=Q5 josiah marsh" .');
    expect(question).toContain('wikibase:limit 21 ;');
    expect(question).toContain('OFFSET 0 LIMIT 21');
    expect(question).not.toContain('1835');
    expect(question).not.toContain('1910');
  });

  it('asks for the page after, by whole pages, within limits', () => {
    expect(wikidataQuery('x', { offset: 45, limit: 20 })).toContain('OFFSET 40 LIMIT 21');
    expect(wikidataQuery('x', { offset: 40, limit: 20 })).toContain('wikibase:limit 61 ;');
    expect(wikidataQuery('x', { offset: 9999, limit: 500 })).toContain('OFFSET 200 LIMIT 51');
  });

  it('lets nothing that is typed end the text it stands in, or be a command', () => {
    const typed = [
      ['Marsh" . } DROP ALL #', 'marsh . drop all'],
      ['Marsh\\" OR 1=1', 'marsh or 1 1'],
      // OR and AND in capitals are commands to the search; in small letters they are words.
      ['Alice OR Bob AND Carol NOT', 'alice or bob and carol not'],
      ['Marsh\nhaswbstatement:P31=Q146', 'marsh haswbstatement p31 q146'],
      ['insource:/x/ -Marsh !Marsh ~', 'insource x marsh marsh'],
      ['Mary-Ann O’Hara', 'mary-ann o’hara'],
      ["d'Hondt, J.", "d'hondt j."],
      ['Müller  Søren', 'müller søren'],
    ] as const;
    for (const [given, sent] of typed) {
      const name = wikidataName(query({ given, surname: '' }));
      expect(name, given).toBe(sent);
      expect(name).not.toMatch(/["\\\n\r:{}<>()]/);
      // In the question, the name stands between two quotation marks and no third.
      const line =
        wikidataQuery(name, page)
          .split('\n')
          .find((part) => part.startsWith('mwapi:srsearch')) ?? '';
      expect(line.split('"')).toHaveLength(3);
    }
  });
});

describe('wikidataConnector', () => {
  const setup = (data: unknown) => {
    const asked: string[] = [];
    const http = new HttpClient({
      fetch: (url) => {
        asked.push(url);
        return Promise.resolve(new Response(JSON.stringify(data)));
      },
      userAgent: 'RulZAncestry/test',
    });
    return {
      connector: wikidataConnector(http.for(wikidataManifest), () => Date.UTC(2026, 5, 1)),
      asked,
    };
  };

  it('asks the query service, and nothing else', async () => {
    const { connector, asked } = setup(
      answer([row(1), row(2, { death: undefined, birth: date('1980-01-01T00:00:00Z') })]),
    );
    const found = await connector.searchPersons(query(), page);
    expect(found.page.items.map((record) => record.key)).toEqual(['Q1']);
    expect(found.page.hidden).toBe(1);
    const url = new URL(asked[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://query.wikidata.org/sparql');
    expect([...url.searchParams.keys()]).toEqual(['format', 'query']);
  });

  it('sends nothing when no name is left to ask for', async () => {
    const { connector, asked } = setup(answer([]));
    for (const given of ['', '  ', '"{}" :']) {
      await expect(connector.searchPersons(query({ given, surname: '' }), page)).rejects.toThrow(
        ConnectorError,
      );
    }
    expect(asked).toHaveLength(0);
  });

  it('needs the client of its own source', () => {
    const http = new HttpClient({
      fetch: () => Promise.reject(new Error('nothing may be asked')),
      userAgent: 'RulZAncestry/test',
    });
    expect(() => wikidataConnector(http.for({ ...wikidataManifest, id: 'other' }))).toThrow();
  });
});
