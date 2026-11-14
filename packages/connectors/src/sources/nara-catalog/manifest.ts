import { defineManifest } from '../../manifest';

export const naraCatalogManifest = defineManifest({
  id: 'nara-catalog',
  name: 'US National Archives Catalog',
  tier: 'api',
  auth: 'apiKey',
  access: 'key-required',
  baseUrl: 'https://catalog.archives.gov/api/v2',
  siteUrl: 'https://catalog.archives.gov',
  keyHeader: 'x-api-key',
  mayStoreText: false,
  rateLimit: { requests: 1, perSeconds: 1, source: 'self-imposed' },
  quota: { requests: 10_000, period: 'month' },
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution:
    'This product uses the National Archives Catalog API but is not endorsed or certified by the National Archives and Records Administration',
  termsUrl: 'https://www.archives.gov/research/catalog/help/api',
  docsUrl: 'https://usnationalarchives.github.io/Catalog-API/',
  verifiedOn: '2026-11-13',
  notes: [
    'The key is free and requested by email to Catalog_API@nara.gov. Each user supplies their own key.',
    'Send the key in the x-api-key request header.',
    'The default quota is 10,000 queries per month per key. A key over quota is blocked until the first of the next month.',
    'No per-second limit is published; one request per second is our own choice to protect the monthly quota.',
    'The terms ask that nothing the API returns be cached or stored, so no answer is kept, also not in memory, and a citation holds the record’s identifier and address only.',
    'The terms ask that an app shows the sentence that is this manifest’s credit line.',
    'The terms ask that keys are not shared or published. A key that is not used for twelve months is switched off.',
    'The search is records/search with q, page (from 1, at most 10,000) and limit (at most 1,000), by the API’s own specification (swagger.json). The specification does not describe the answer; the getting-started guide shows it as body.hits.total.value and body.hits.hits[]._source.record.',
    'Without a key the address answers with the website of the catalog, not with an error. What it answers to a wrong or exhausted key is not documented.',
    'The connector was written without a key and has not been tried against the service.',
  ],
});
