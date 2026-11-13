import { QUERY_YEAR_SPREAD, isEmptyQuery, type PersonQuery } from '@rulz/core';
import type { ConnectorManifest } from './manifest';
import { familySearchRecordsManifest } from './sources/familysearch-records/manifest';
import { findAGraveManifest } from './sources/find-a-grave/manifest';

/**
 * Sites the app never fetches (tier `deeplink`): it only makes the address of
 * a search there, which the user's own browser opens. Nothing in this file
 * asks anything of the internet, and nothing here may import the HTTP client.
 */
export interface DeepLinkSource {
  readonly manifest: ConnectorManifest;
  /**
   * The address of a search for a person at the site. Always HTTPS, on the
   * site of the manifest. Null when the query names nobody.
   */
  buildSearchUrl(query: PersonQuery): string | null;
}

type Params = Record<string, string | number | null>;

/** A deep-link source whose search is one page with a query string. */
function searchPage(
  manifest: ConnectorManifest,
  path: string,
  paramsOf: (query: PersonQuery) => Params,
): DeepLinkSource {
  if (manifest.tier !== 'deeplink') {
    throw new Error(`${manifest.id} is not a link-only source`);
  }
  const site = new URL(manifest.baseUrl);
  if (site.protocol !== 'https:') throw new Error(`${manifest.id} is not reached over HTTPS`);
  return {
    manifest,
    buildSearchUrl(query) {
      if (isEmptyQuery(query)) return null;
      const url = new URL(path, site);
      for (const [name, value] of Object.entries(paramsOf(query))) {
        if (value !== null && value !== '') url.searchParams.set(name, String(value));
      }
      // The path is fixed and the rest is a query string, so this cannot fail;
      // it is checked all the same, since the address is handed to the browser.
      if (url.origin !== site.origin) throw new Error(`${manifest.id}: the link left its site`);
      return url.href;
    },
  };
}

const text = (value: string): string => value.trim().replace(/\s+/g, ' ').slice(0, 100);
const year = (value: number | null): number | null =>
  value !== null && Number.isInteger(value) && value >= 1 && value <= 9999 ? value : null;

/**
 * Find a Grave's memorial search. A year may lie three years to either side,
 * the narrowest of the site's choices that holds the app's own two.
 */
export const findAGraveLinks = searchPage(findAGraveManifest, '/memorial/search', (query) => {
  const birth = year(query.birthYear);
  const death = year(query.deathYear);
  return {
    firstname: text(query.given),
    lastname: text(query.surname),
    birthyear: birth,
    birthyearfilter: birth === null ? null : '3',
    deathyear: death,
    deathyearfilter: death === null ? null : '3',
  };
});

/** FamilySearch's search of historical records. */
export const familySearchRecordsLinks = searchPage(
  familySearchRecordsManifest,
  '/search/record/results',
  (query) => {
    const span = (name: string, value: number | null): Params => {
      const at = year(value);
      return at === null
        ? {}
        : {
            [`${name}.from`]: Math.max(1, at - QUERY_YEAR_SPREAD),
            [`${name}.to`]: at + QUERY_YEAR_SPREAD,
          };
    };
    return {
      'q.givenName': text(query.given),
      'q.surname': text(query.surname),
      ...span('q.birthLikeDate', query.birthYear),
      ...span('q.deathLikeDate', query.deathYear),
    };
  },
);

/** Every site the app links to and never fetches. */
export const deepLinkSources: readonly DeepLinkSource[] = [
  familySearchRecordsLinks,
  findAGraveLinks,
];

/**
 * The source the tree keeps for a site: what a citation of one of its pages
 * or records is a citation of.
 */
export function citationSourceOf(manifest: ConnectorManifest): {
  title: string;
  publication: string;
} {
  return {
    title: manifest.name,
    publication: new URL(manifest.siteUrl ?? manifest.baseUrl).hostname.replace(/^www\./, ''),
  };
}
