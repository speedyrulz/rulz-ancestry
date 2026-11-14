import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../../connector';
import { HttpClient } from '../../http';
import { wikitreeManifest } from './manifest';
import { parseWikitreeSearch, wikitreeConnector, wikitreeSearchParams } from './search';

// The people below are made up. The shape is WikiTree's, as its documentation
// gives it and as the service answered on 2026-11-13.
const full = {
  Id: 101,
  Name: 'Marsh-90001',
  FirstName: 'Josiah',
  MiddleName: 'Tobias',
  RealName: 'Josiah',
  LastNameAtBirth: 'Marsh',
  LastNameCurrent: 'Marsh',
  Suffix: '',
  BirthDate: '1835-11-30',
  DeathDate: '1910-04-00',
  BirthLocation: 'Ashford, Example County, Vermont, United States',
  DeathLocation: '',
  Gender: 'Male',
  IsLiving: 0,
  Privacy: 60,
  DataStatus: { BirthDate: 'certain', DeathDate: 'guess' },
  index: 0,
};

const married = {
  Id: 102,
  Name: 'Fenwick-90002',
  FirstName: 'Henrietta',
  MiddleName: '',
  RealName: 'Etta',
  LastNameAtBirth: 'Fenwick',
  LastNameCurrent: 'Marsh',
  Suffix: '',
  BirthDate: '1840-00-00',
  DeathDate: '0000-00-00',
  BirthLocation: '',
  DeathLocation: '',
  Gender: 'Female',
  IsLiving: 0,
  Privacy: 50,
  DataStatus: { BirthDate: 'before' },
  index: 1,
};

const answer = (matches: unknown[], total = matches.length) => [
  { status: 0, matches, total, start: 0, limit: 10 },
];

const page = { offset: 0, limit: 10 };

describe('parseWikitreeSearch', () => {
  it('reads a profile into a record', () => {
    const result = parseWikitreeSearch(answer([full]), page);
    expect(result).toEqual({
      items: [
        {
          connectorId: 'wikitree',
          key: 'Marsh-90001',
          kind: 'person',
          title: 'Josiah Tobias Marsh',
          url: 'https://www.wikitree.com/wiki/Marsh-90001',
          sex: 'M',
          facts: [
            {
              type: 'birth',
              date: '30 NOV 1835',
              place: 'Ashford, Example County, Vermont, United States',
            },
            { type: 'death', date: 'ABT APR 1910', place: '' },
          ],
          about: '',
        },
      ],
      total: 1,
      next: null,
      hidden: 0,
    });
  });

  it('names a person by the name they went by, and says what they were born as', () => {
    const [record] = parseWikitreeSearch(answer([married]), page).items;
    expect(record?.title).toBe('Etta Marsh (born Fenwick)');
    expect(record?.sex).toBe('F');
    expect(record?.facts).toEqual([{ type: 'birth', date: 'BEF 1840', place: '' }]);
  });

  it('leaves out private profiles and the profiles of living people, and counts them', () => {
    const result = parseWikitreeSearch(
      answer([
        { Id: 103, index: 0 },
        { ...full, Name: 'Marsh-90004', IsLiving: 1 },
        // Nothing says this one has died.
        { ...full, Name: 'Marsh-90005', IsLiving: undefined },
        full,
        'not a profile',
      ]),
      page,
    );
    expect(result.items.map((record) => record.key)).toEqual(['Marsh-90001']);
    expect(result.hidden).toBe(4);
  });

  it('shows only what WikiTree calls public, whatever comes with a private profile', () => {
    const result = parseWikitreeSearch(
      answer([
        { ...full, Name: 'Marsh-1', Privacy: 20 },
        { ...full, Name: 'Marsh-2', Privacy: 30 },
        { ...full, Name: 'Marsh-3', Privacy: 40 },
        { ...full, Name: 'Marsh-4', Privacy: undefined },
        { ...full, Name: 'Marsh-5', Privacy: '60' },
        { ...full, Name: 'Marsh-6', Privacy: 50 },
        { ...full, Name: 'Marsh-7', Privacy: 60 },
      ]),
      page,
    );
    expect(result.items.map((record) => record.key)).toEqual(['Marsh-6', 'Marsh-7']);
    expect(result.hidden).toBe(5);
  });

  it('shows a profile that comes twice once', () => {
    const result = parseWikitreeSearch(answer([full, full, married]), page);
    expect(result.items.map((record) => record.key)).toEqual(['Marsh-90001', 'Fenwick-90002']);
  });

  it('makes the address of a profile itself, and takes no profile whose id could lead elsewhere', () => {
    const odd = parseWikitreeSearch(
      answer([
        { ...full, Name: 'Van der Berg-12' },
        { ...full, Name: "O'Hara-7" },
        { ...full, Name: '../../Special:Evil-1' },
        { ...full, Name: 'x?y=z-1' },
        { ...full, Name: 'https://elsewhere.example/a-1' },
        { ...full, Name: 'Marsh' },
        { ...full, Name: 42 },
      ]),
      page,
    );
    expect(odd.items.map((record) => record.url)).toEqual([
      'https://www.wikitree.com/wiki/Van_der_Berg-12',
      "https://www.wikitree.com/wiki/O'Hara-7",
    ]);
    for (const record of odd.items) {
      expect(new URL(record.url).origin).toBe('https://www.wikitree.com');
    }
  });

  it('shows what a source sends as plain text, cut to a length', () => {
    const [record] = parseWikitreeSearch(
      answer([
        {
          ...full,
          RealName: '<b>Jo</b>\u0000\n siah',
          BirthLocation: 'x'.repeat(500),
          Gender: { not: 'a text' },
          DataStatus: 'none',
          BirthDate: 18351130,
        },
      ]),
      page,
    ).items;
    expect(record?.title).toBe('<b>Jo</b> siah Tobias Marsh');
    expect(record?.sex).toBeNull();
    expect(record?.facts[0]?.date).toBe('');
    expect(record?.facts[0]?.place).toHaveLength(200);
  });

  it('says whether there are more results', () => {
    const ten = Array.from({ length: 10 }, (_, n) => ({ ...full, Name: `Marsh-${n + 1}` }));
    expect(parseWikitreeSearch(answer(ten, 25), page).next).toEqual({ offset: 10, limit: 10 });
    expect(parseWikitreeSearch(answer(ten, 20), { offset: 10, limit: 10 }).next).toBeNull();
    expect(parseWikitreeSearch(answer([], 25), page).next).toBeNull();
    // No more than was asked for is taken.
    expect(parseWikitreeSearch(answer(ten, 25), { offset: 0, limit: 4 }).items).toHaveLength(4);
    // The last results that are asked for.
    expect(parseWikitreeSearch(answer(ten, 5000), { offset: 1000, limit: 10 }).next).toBeNull();
  });

  it('refuses an answer that is not one', () => {
    for (const data of [null, {}, [], 'text', [{ matches: [] }], [{ status: 0, matches: 'x' }]]) {
      expect(() => parseWikitreeSearch(data, page)).toThrow(ConnectorError);
    }
  });

  it('passes on why WikiTree did not search', () => {
    expect(() =>
      parseWikitreeSearch([{ status: 'You must provide something to search with.' }], page),
    ).toThrow('WikiTree did not search: You must provide something to search with.');
  });
});

describe('wikitreeSearchParams', () => {
  it('sends the name and the years, and names the app', () => {
    expect(
      wikitreeSearchParams(
        { given: ' Josiah ', surname: 'Marsh', birthYear: 1835, deathYear: null },
        { offset: 20, limit: 10 },
      ),
    ).toMatchObject({
      action: 'searchPerson',
      appId: 'RulZAncestry',
      FirstName: 'Josiah',
      LastName: 'Marsh',
      BirthDate: '1835',
      DeathDate: undefined,
      dateSpread: 2,
      limit: 10,
      start: 20,
    });
  });

  it('leaves out what is not asked', () => {
    const params = wikitreeSearchParams(
      { given: '', surname: 'Marsh', birthYear: null, deathYear: null },
      { offset: 0, limit: 500 },
    );
    expect(params['FirstName']).toBeUndefined();
    expect(params['dateSpread']).toBeUndefined();
    expect(params['limit']).toBe(100);
  });
});

describe('wikitreeConnector', () => {
  it('asks WikiTree and nobody else', async () => {
    const asked: string[] = [];
    const http = new HttpClient({
      fetch: async (url) => {
        asked.push(url);
        return new Response(JSON.stringify(answer([full])));
      },
      userAgent: 'RulZAncestry/test',
    });
    const connector = wikitreeConnector(http.for(wikitreeManifest));
    const found = await connector.searchPersons(
      { given: 'Josiah', surname: 'Marsh', birthYear: 1835, deathYear: null },
      page,
    );
    expect(found.page.items).toHaveLength(1);
    expect(found.cached).toBe(false);
    expect(asked).toHaveLength(1);
    const url = new URL(asked[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://api.wikitree.com/api.php');
    expect(url.searchParams.get('LastName')).toBe('Marsh');
    expect(url.searchParams.get('appId')).toBe('RulZAncestry');
  });
});
