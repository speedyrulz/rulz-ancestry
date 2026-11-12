import { defineManifest } from '../../manifest';

export const findAGraveManifest = defineManifest({
  id: 'find-a-grave',
  name: 'Find a Grave',
  tier: 'deeplink',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://www.findagrave.com',
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: 'Find a Grave (findagrave.com)',
  termsUrl: 'https://www.ancestry.com/c/legal/termsandconditions',
  docsUrl: 'https://www.findagrave.com',
  verifiedOn: '2026-11-11',
  notes: [
    'No official public API. Find a Grave is governed by the Ancestry Terms and Conditions, which bar bulk or automated collection (bots, crawlers, scrapers, AI tools).',
    'That clause was read in the 2023 version of the terms; the live version was not confirmed, so re-read it before Phase 3.',
    'The app must never fetch this site. It only opens a prefilled search in the user’s browser.',
    'The user records what they found through the clip form, which creates a citation with the URL and access date.',
  ],
});
