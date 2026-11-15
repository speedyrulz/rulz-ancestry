import { defineManifest } from '../../manifest';

export const troveManifest = defineManifest({
  id: 'trove',
  name: 'Trove (National Library of Australia)',
  tier: 'api',
  auth: 'apiKey',
  access: 'key-required',
  baseUrl: 'https://api.trove.nla.gov.au/v3',
  siteUrl: 'https://nla.gov.au',
  keyHeader: 'x-api-key',
  citeOnly: true,
  rateLimit: { requests: 1, perSeconds: 1, source: 'self-imposed' },
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: 'This app uses data sourced from Trove, the National Library of Australia',
  termsUrl: 'https://trove.nla.gov.au/about/create-something/using-api/trove-api-terms-use',
  docsUrl: 'https://trove.nla.gov.au/about/create-something/using-api/v3/api-technical-guide',
  keyUrl: 'https://trove.nla.gov.au/about/create-something/using-api',
  verifiedOn: '2026-11-15',
  notes: [
    'The search is result of the Trove API v3 with category=newspaper and encoding=json; a range of years goes into q as date:[A TO B] (technical guide, read 2026-11-15).',
    'A key is needed, free, by an application to the National Library (answered in about a week). The terms allow a key only for whoever obtained it and ask that it be kept confidential, so each user brings their own. It is sent in the X-API-KEY header, never in the address; the header name is from a Trove data guide and not yet tried by the app.',
    'The published limit is 200 calls a minute; the app asks at most once a second.',
    'The terms ask for calls made at the time of use, no copy kept over 30 days, each item identified with a link to its page, and an app that says it uses data sourced from Trove with a link to https://trove.nla.gov.au/ . Nothing of an answer is cached, and a citation keeps the heading, newspaper, date, page and link, not the text.',
    'Results are paged with a cursor (s, from nextStart), not an offset; not yet tried by the app.',
  ],
});
