import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HttpClient } from './http';
import {
  citationSourceOf,
  deepLinkSources,
  familySearchRecordsLinks,
  findAGraveLinks,
} from './links';
import { manifestsByTier } from './registry';
import { wikitreeManifest } from './sources/wikitree/manifest';

// The people below are made up.
const full = { given: 'Josiah', surname: 'Marsh', birthYear: 1835, deathYear: 1910 };

describe('links to sites the app never fetches', () => {
  it('makes the address of a search at Find a Grave', () => {
    const url = new URL(findAGraveLinks.buildSearchUrl(full) ?? '');
    expect(url.origin + url.pathname).toBe('https://www.findagrave.com/memorial/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      firstname: 'Josiah',
      lastname: 'Marsh',
      birthyear: '1835',
      birthyearfilter: '3',
      deathyear: '1910',
      deathyearfilter: '3',
    });
  });

  it('makes the address of a search of the records at FamilySearch', () => {
    const url = new URL(familySearchRecordsLinks.buildSearchUrl(full) ?? '');
    expect(url.origin + url.pathname).toBe('https://www.familysearch.org/search/record/results');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'q.givenName': 'Josiah',
      'q.surname': 'Marsh',
      'q.birthLikeDate.from': '1833',
      'q.birthLikeDate.to': '1837',
      'q.deathLikeDate.from': '1908',
      'q.deathLikeDate.to': '1912',
    });
  });

  it('leaves out what is not asked, and gives no address for nobody', () => {
    for (const source of deepLinkSources) {
      const url = new URL(
        source.buildSearchUrl({
          given: '',
          surname: ' Marsh ',
          birthYear: null,
          deathYear: null,
        }) ?? '',
      );
      expect([...url.searchParams.values()], source.manifest.id).toEqual(['Marsh']);
      expect(
        source.buildSearchUrl({ given: ' ', surname: '', birthYear: 1835, deathYear: null }),
      ).toBeNull();
    }
  });

  it('keeps whatever is typed inside the query string, on the site', () => {
    const odd = [
      "O'Hara & Söhne",
      'a/../../b',
      'x?y=z#frag',
      '//elsewhere.example/',
      'https://elsewhere.example/',
      '@elsewhere.example',
      'a\r\nHost: elsewhere.example',
      '%2e%2e%2f',
    ];
    for (const source of deepLinkSources) {
      const site = new URL(source.manifest.baseUrl);
      for (const typed of odd) {
        const built = source.buildSearchUrl({
          given: typed,
          surname: typed,
          birthYear: 99_999,
          deathYear: -4,
        });
        const url = new URL(built ?? '');
        expect(url.protocol).toBe('https:');
        expect(url.host).toBe(site.host);
        expect(url.username + url.password + url.hash).toBe('');
        const values = [...url.searchParams.values()];
        // Two names and no year: a year that is none is not sent.
        expect(values).toHaveLength(2);
        expect(values[0]).toBe(typed.trim().replace(/\s+/g, ' '));
      }
    }
  });

  it('covers every link-only source the app knows, and only those', () => {
    expect(deepLinkSources.map((source) => source.manifest.id).sort()).toEqual(
      manifestsByTier('deeplink')
        .map((manifest) => manifest.id)
        .sort(),
    );
  });

  it('is refused by the client that fetches', () => {
    const http = new HttpClient({
      fetch: () => Promise.reject(new Error('nothing may be asked')),
      userAgent: 'RulZAncestry/test',
    });
    for (const source of deepLinkSources) {
      expect(() => http.for(source.manifest), source.manifest.id).toThrow();
    }
  });

  it('has no way to fetch: its file does not know the client', () => {
    const code = readFileSync(fileURLToPath(new URL('./links.ts', import.meta.url)), 'utf8');
    expect(code).not.toMatch(/from '\.\/http'|\bfetch\(/);
  });
});

describe('citationSourceOf', () => {
  it('names the source a tree keeps for a site', () => {
    expect(citationSourceOf(wikitreeManifest)).toEqual({
      title: 'WikiTree',
      publication: 'wikitree.com',
    });
    expect(citationSourceOf(findAGraveLinks.manifest)).toEqual({
      title: 'Find a Grave',
      publication: 'findagrave.com',
    });
  });
});
