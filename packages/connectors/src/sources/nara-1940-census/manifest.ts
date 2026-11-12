import { defineManifest } from '../../manifest';

export const nara1940CensusManifest = defineManifest({
  id: 'nara-1940-census',
  name: '1940 US Census (National Archives)',
  tier: 'bulk',
  auth: 'none',
  access: 'open',
  baseUrl: 's3://nara-1940-census/',
  cacheTtlHours: 8760,
  mayStoreImages: true,
  attribution: '1940 Census, National Archives and Records Administration',
  termsUrl: 'https://www.archives.gov/developer/1940-census',
  docsUrl: 'https://www.archives.gov/developer/1940-census',
  verifiedOn: '2026-11-11',
  notes: [
    'Public S3 bucket; readable without an AWS account (unsigned requests).',
    'About 15 TB: metadata index, population schedules, enumeration district maps and descriptions.',
    'No name index was found in the dataset. Browsing is by enumeration district, so the pack indexes district descriptions only.',
  ],
});
