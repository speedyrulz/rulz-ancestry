import { defineManifest } from '../../manifest';

export const papersPastManifest = defineManifest({
  id: 'papers-past',
  name: 'Papers Past (National Library of New Zealand)',
  tier: 'api',
  auth: 'apiKey',
  access: 'key-optional',
  baseUrl: 'https://api.digitalnz.org/v3',
  siteUrl: 'https://paperspast.natlib.govt.nz',
  keyHeader: 'authentication-token',
  citeOnly: true,
  rateLimit: { requests: 1, perSeconds: 2, source: 'self-imposed' },
  quota: { requests: 10_000, period: 'day' },
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: 'Papers Past, National Library of New Zealand, through DigitalNZ',
  termsUrl: 'https://digitalnz.org/about/terms-of-use/developer-api-terms-of-use',
  docsUrl: 'https://digitalnz.org/developers/api-docs-v3',
  keyUrl: 'https://digitalnz.org/developers',
  verifiedOn: '2026-11-15',
  notes: [
    'The search is records.json of the DigitalNZ API v3, limited to the collection Papers Past with and[primary_collection][]=Papers Past, as DigitalNZ’s own documentation shows (read 2026-11-15).',
    'No key is needed. Calls without a key share one allowance of 10,000 a day among everyone who sends none, so the app sends at most 200 a day without a key from one PC. A key is free and personal, sent in the Authentication-Token header, and has its own 10,000 a day.',
    'The terms ask for calls made at the time of use, no copy kept over 30 days, and each item named by its source with a link to its page. Nothing of an answer is cached, and a citation keeps the heading, newspaper, date and link, not the text.',
    'A range of years is and[year][]=[A TO B], as the Records v3 OpenAPI specification words it; not yet tried against the service.',
    'Some results are pictures, not articles.',
  ],
});
