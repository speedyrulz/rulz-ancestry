import type { PersonQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient } from '../../http';
import { openArchivesManifest } from './manifest';
import {
  openArchivesConnector,
  openArchivesName,
  openArchivesSearchParams,
  openArchivesSpan,
  parseOpenArchivesSearch,
} from './search';

// The people and records below are made up. The shape is that of Open
// Archives, as the service answered on 2026-11-13.
const marriage = {
  pid: 'Person4071521043',
  identifier: '0919CF97-E4A2-4560-A9A8-348F5F222041',
  archive_code: 'exa',
  archive_org: 'Voorbeeldarchief',
  archive: 'Example Municipal Archive',
  personname: 'Hendrik de Vries',
  relationtype: 'Father of bride',
  _relationtype: 'Vader van de bruid',
  eventtype: 'Marriage',
  _eventtype: 'Huwelijk',
  eventdate: { day: 21, month: 5, year: 1851 },
  eventplace: ['Voorbeeldstad'],
  sourcetype: 'Civil registration marriages',
  url: 'https://www.openarchieven.nl/exa:0919CF97-E4A2-4560-A9A8-348F5F222041/en',
};

const answer = (docs: unknown[] | undefined, number_found: unknown = docs?.length ?? 0) => ({
  query: { name: 'x' },
  response: docs === undefined ? { number_found } : { number_found, docs },
});

const page = { offset: 0, limit: 20 };
const YEAR = 2026;

const query = (changes: Partial<PersonQuery> = {}): PersonQuery => ({
  given: 'Hendrik',
  surname: 'de Vries',
  birthYear: 1820,
  deathYear: 1890,
  ...changes,
});

describe('parseOpenArchivesSearch', () => {
  it('reads a record of an event into a record of the app, with a link of its own making', () => {
    expect(parseOpenArchivesSearch(answer([marriage]), page, YEAR)).toEqual({
      items: [
        {
          connectorId: 'open-archives',
          key: 'exa:0919CF97-E4A2-4560-A9A8-348F5F222041/Person4071521043',
          kind: 'event',
          title: 'Hendrik de Vries',
          url: 'https://www.openarchieven.nl/exa:0919CF97-E4A2-4560-A9A8-348F5F222041/en',
          role: 'Father of bride',
          event: 'Marriage',
          date: '21 MAY 1851',
          place: 'Voorbeeldstad',
          held: 'Civil registration marriages, Example Municipal Archive',
        },
      ],
      total: 1,
      next: null,
      hidden: 0,
    });
  });

  it('reads what a record leaves out', () => {
    const [record] = parseOpenArchivesSearch(
      answer([
        {
          pid: 'Person:6825c956-f8e1',
          identifier: 'ad4e5dba',
          archive_code: 'exa',
          eventdate: { year: 1880 },
          eventplace: null,
        },
      ]),
      page,
      YEAR,
    ).items;
    expect(record).toMatchObject({
      key: 'exa:ad4e5dba/Person:6825c956-f8e1',
      title: 'exa:ad4e5dba',
      role: '',
      event: '',
      date: '1880',
      place: '',
      held: '',
    });
  });

  it('shows nobody who may be living', () => {
    const at = (year: number, extra: object = {}) => ({
      ...marriage,
      identifier: `r${year}`,
      eventdate: { year },
      ...extra,
    });
    const read = parseOpenArchivesSearch(
      answer([
        // An event more than 110 years ago, on whatever day: those it names are taken to have died.
        at(1915),
        // The last day of 1916 is not 110 years back yet in 2026.
        at(1916),
        // Later than that: a witness or a bride may be living.
        at(1917),
        at(1950),
        // The record of a death shows the one who died, whenever it was.
        at(1990, { eventtype: 'Death', relationtype: 'Deceased', identifier: 'd1' }),
        at(1991, { _eventtype: 'Overlijden', _relationtype: 'Overledene', identifier: 'd2' }),
        // And nobody else it names.
        at(1992, { eventtype: 'Death', relationtype: 'Informant', identifier: 'd3' }),
        // Without a year, nothing says how long ago it was.
        { ...marriage, identifier: 'undated', eventdate: {} },
        { ...marriage, identifier: 'nodate', eventdate: undefined },
      ]),
      page,
      YEAR,
    );
    expect(read.items.map((record) => record.key.split('/')[0])).toEqual([
      'exa:r1915',
      'exa:d1',
      'exa:d2',
    ]);
    expect(read.hidden).toBe(6);
  });

  it('leaves out a record it cannot name, and shows one person of a record once', () => {
    const odd = [
      null,
      {},
      { ...marriage, archive_code: 'EXA' },
      { ...marriage, archive_code: '../x' },
      { ...marriage, identifier: 'a/b' },
      { ...marriage, identifier: 'a?b' },
      { ...marriage, pid: 'a b' },
      { ...marriage, pid: 7 },
    ];
    const read = parseOpenArchivesSearch(
      answer([...odd, marriage, marriage, { ...marriage, pid: 'Person2' }], 40),
      page,
      YEAR,
    );
    // Two people of the same record are two results with the same link.
    expect(read.items.map((record) => record.key)).toEqual([
      'exa:0919CF97-E4A2-4560-A9A8-348F5F222041/Person4071521043',
      'exa:0919CF97-E4A2-4560-A9A8-348F5F222041/Person2',
    ]);
    expect(new Set(read.items.map((record) => record.url)).size).toBe(1);
  });

  it('shows text of the service as text, and makes the link itself', () => {
    const [record] = parseOpenArchivesSearch(
      answer([
        {
          ...marriage,
          personname: `<b>Hendrik</b>\n de Vries ${'x'.repeat(300)}`,
          url: 'https://elsewhere.example/',
          eventplace: ['A', 7, 'B', 'C', 'D'],
        },
      ]),
      page,
      YEAR,
    ).items;
    expect(record?.title.startsWith('<b>Hendrik</b> de Vries xxx')).toBe(true);
    expect(record?.title.length).toBeLessThanOrEqual(200);
    expect(record?.url.startsWith('https://www.openarchieven.nl/exa:')).toBe(true);
    expect(record?.place).toBe('A, B');
  });

  it('pages by whole pages, and reads an answer without results', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      ...marriage,
      identifier: `r${index}`,
    }));
    expect(parseOpenArchivesSearch(answer(many, 254), page, YEAR).next).toEqual({
      offset: 20,
      limit: 20,
    });
    expect(parseOpenArchivesSearch(answer(many, 20), page, YEAR).next).toBeNull();
    // A page that came short is followed by the next page, not asked for again.
    expect(parseOpenArchivesSearch(answer(many.slice(0, 5), 254), page, YEAR).next).toEqual({
      offset: 20,
      limit: 20,
    });
    expect(
      parseOpenArchivesSearch(answer(many, 99_999), { offset: 1000, limit: 20 }, YEAR).next,
    ).toBeNull();
    // Nothing found: the service leaves the list out.
    expect(parseOpenArchivesSearch(answer(undefined, 0), page, YEAR)).toEqual({
      items: [],
      total: 0,
      next: null,
      hidden: 0,
    });
  });

  it('refuses an answer that is not one', () => {
    for (const data of [null, [], 'text', {}, { response: 'none' }, { response: { docs: 7 } }]) {
      expect(() => parseOpenArchivesSearch(data, page, YEAR)).toThrow(ConnectorError);
    }
  });
});

describe('what Open Archives is sent', () => {
  it('is the name and a span of years, and nothing else of a tree', () => {
    expect(openArchivesSearchParams(query(), page)).toEqual({
      name: 'Hendrik de Vries 1818-1892',
      lang: 'en',
      number_show: 20,
      start: 0,
    });
    expect(
      openArchivesSearchParams(query({ birthYear: null, deathYear: null }), page)['name'],
    ).toBe('Hendrik de Vries');
    expect(openArchivesSearchParams(query(), { offset: 45, limit: 20 })).toMatchObject({
      number_show: 20,
      start: 40,
    });
    expect(openArchivesSearchParams(query(), { offset: 9999, limit: 500 })).toMatchObject({
      number_show: 100,
      start: 1000,
    });
  });

  it('reaches as far as a life can when one year is missing', () => {
    expect(openArchivesSpan(query())).toEqual({ from: 1818, to: 1892 });
    expect(openArchivesSpan(query({ deathYear: null }))).toEqual({ from: 1818, to: 1932 });
    expect(openArchivesSpan(query({ birthYear: null }))).toEqual({ from: 1778, to: 1892 });
    expect(openArchivesSpan(query({ birthYear: null, deathYear: null }))).toBeNull();
    // Years the wrong way round are put right, and none leaves the calendar.
    expect(openArchivesSpan(query({ birthYear: 1890, deathYear: 1820 }))).toEqual({
      from: 1818,
      to: 1892,
    });
    expect(openArchivesSpan(query({ birthYear: 1, deathYear: 9999 }))).toEqual({
      from: 1,
      to: 9999,
    });
  });

  it('lets nothing that is typed be a command or a year to the search', () => {
    const typed = [
      ['"Hendrik" & Jan*', 'Hendrik Jan'],
      ['Hendrik 1850-1900', 'Hendrik'],
      ['~Hendrik >de %smid $', 'Hendrik de smid'],
      ['-Hendrik', 'Hendrik'],
      ['Anna-Maria', 'Anna-Maria'],
      ["d'Hondt", "d'Hondt"],
      ['J. P.', 'J. P.'],
      ['Zoë  Müller', 'Zoë Müller'],
    ] as const;
    for (const [given, sent] of typed) {
      expect(openArchivesName(query({ given, surname: '' })), given).toBe(sent);
    }
    expect(openArchivesName(query({ given: "'s-Gravenhage", surname: 'van  den Berg?' }))).toBe(
      "'s-Gravenhage van den Berg",
    );
    // What is left of a name full of signs is all that is sent with the span.
    expect(
      openArchivesSearchParams(query({ given: 'A" 1700-1800 &', surname: 'B*' }), page)['name'],
    ).toBe('A B 1818-1892');
  });
});

describe('openArchivesConnector', () => {
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
      connector: openArchivesConnector(http.for(openArchivesManifest), () => Date.UTC(2026, 5, 1)),
      asked,
    };
  };

  it('asks the search of the service, at its own address', async () => {
    const { connector, asked } = setup(
      answer([marriage, { ...marriage, eventdate: { year: 1990 } }]),
    );
    const found = await connector.searchPersons(query(), page);
    expect(found.page.items).toHaveLength(1);
    expect(found.page.hidden).toBe(1);
    const url = new URL(asked[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://api.openarchieven.nl/1.1/records/search.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'Hendrik de Vries 1818-1892',
      lang: 'en',
      number_show: '20',
      start: '0',
    });
  });

  it('sends nothing when no name is left to ask for', async () => {
    const { connector, asked } = setup(answer([]));
    for (const given of ['', '  ', '1850 "*"']) {
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
    expect(() =>
      openArchivesConnector(http.for({ ...openArchivesManifest, id: 'other' })),
    ).toThrow();
  });
});
