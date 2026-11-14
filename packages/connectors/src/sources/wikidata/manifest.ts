import { defineManifest } from '../../manifest';

export const wikidataManifest = defineManifest({
  id: 'wikidata',
  name: 'Wikidata',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://query.wikidata.org/sparql',
  siteUrl: 'https://www.wikidata.org',
  rateLimit: { requests: 30, perSeconds: 60, source: 'self-imposed' },
  pauseSeconds: 600,
  cacheTtlHours: 24,
  mayStoreImages: false,
  attribution: 'Wikidata (wikidata.org), in the public domain (CC0)',
  termsUrl: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use',
  docsUrl: 'https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual',
  verifiedOn: '2026-11-13',
  notes: [
    'Asked through the Wikidata Query Service: one question searches for humans by name and gives each one’s label, description, sex and dates of birth and death.',
    'The service asks every client to name itself with a descriptive User-Agent, and answers 429 with Retry-After to one that asks too much; a client that goes on may be shut out with 403.',
    'Its own limits are a share of processing time per minute, not a number of requests. The number here is the project’s own.',
    'Wikidata has entries for people of some note only, and many of them are living. The app shows none who may be living.',
    'Structured data of Wikidata is in the public domain (CC0).',
  ],
});
