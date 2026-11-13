import { defineManifest } from '../../manifest';

export const locManifest = defineManifest({
  id: 'loc',
  name: 'Library of Congress (Chronicling America)',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://www.loc.gov',
  rateLimit: { requests: 20, perSeconds: 60, source: 'published' },
  pauseSeconds: 3600,
  cacheTtlHours: 720,
  mayStoreImages: true,
  attribution: 'Library of Congress, Chronicling America: Historic American Newspapers',
  termsUrl: 'https://www.loc.gov/apis/json-and-yaml/working-within-limits/',
  docsUrl: 'https://www.loc.gov/apis/additional-apis/chronicling-america-api/',
  verifiedOn: '2026-11-11',
  notes: [
    'The legacy chroniclingamerica.loc.gov API was retired in 2025. Use the loc.gov JSON API (append fo=json).',
    'Exceeding 20 requests per minute blocks the client for one hour.',
    'Search queries with more than 100,000 results are rejected; narrow by date or state first.',
    'Limits can drop under heavy load. On HTTP 429 or a CAPTCHA response, pause instead of retrying.',
    'Image and text services have a separate published limit of 150 requests per minute.',
  ],
});
