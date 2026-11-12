import { defineManifest } from '../../manifest';

export const naraCatalogManifest = defineManifest({
  id: 'nara-catalog',
  name: 'US National Archives Catalog',
  tier: 'api',
  auth: 'apiKey',
  access: 'key-required',
  baseUrl: 'https://catalog.archives.gov/api/v2',
  rateLimit: { requests: 1, perSeconds: 1, source: 'self-imposed' },
  quota: { requests: 10_000, period: 'month' },
  cacheTtlHours: 720,
  mayStoreImages: true,
  attribution: 'National Archives and Records Administration (catalog.archives.gov)',
  termsUrl: 'https://www.archives.gov/research/catalog/help/api',
  docsUrl: 'https://usnationalarchives.github.io/Catalog-API/',
  verifiedOn: '2026-11-11',
  notes: [
    'The key is free and requested by email to Catalog_API@nara.gov. Each user supplies their own key.',
    'Send the key in the x-api-key request header.',
    'The default quota is 10,000 queries per month per key. A key over quota is blocked until the first of the next month.',
    'No per-second limit is published; one request per second is our own choice to protect the monthly quota.',
  ],
});
