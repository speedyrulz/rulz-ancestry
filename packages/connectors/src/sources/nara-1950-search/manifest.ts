import { defineManifest } from '../../manifest';

export const nara1950SearchManifest = defineManifest({
  id: 'nara-1950-search',
  name: '1950 Census name search (National Archives)',
  tier: 'deeplink',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://1950census.archives.gov',
  siteUrl: 'https://1950census.archives.gov',
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: '1950 Census, National Archives and Records Administration',
  termsUrl: 'https://www.archives.gov/developer/1950-census',
  docsUrl: 'https://1950census.archives.gov/howto/',
  verifiedOn: '2026-11-15',
  notes: [
    'NARA’s search of the 1950 census by name. Its names were machine-read from handwriting and contain errors: a hit is a lead, never a fact.',
    'The app must never fetch this site. It only opens a prefilled search in the user’s browser.',
    'The address of a search (/search/?name=<given surname>) follows the keys the site’s own code puts in its address (state, county, ed, page, size, name, reservation, scheduleId), read on 2026-11-15; whether it opens a name search was not tried by the app.',
    'The user records what they found through the clip form, or cites a page of an installed 1950 census pack.',
  ],
});
