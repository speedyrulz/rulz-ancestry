import { defineManifest } from '../../manifest';

export const nara1950CensusManifest = defineManifest({
  id: 'nara-1950-census',
  name: '1950 US Census (National Archives)',
  tier: 'bulk',
  auth: 'none',
  access: 'open',
  baseUrl: 's3://nara-1950-census/',
  cacheTtlHours: 8760,
  mayStoreImages: true,
  attribution: '1950 Census, National Archives and Records Administration',
  termsUrl: 'https://www.archives.gov/developer/1950-census',
  docsUrl: 'https://registry.opendata.aws/nara-1950-census/',
  verifiedOn: '2026-11-11',
  notes: [
    'Public S3 bucket in us-east-2; readable without an AWS account (unsigned requests).',
    'The full dataset is over 165 TB. The data pack downloads only the name index; page images are fetched one at a time when viewed.',
    'The name index was machine-read from handwriting and contains errors. Present matches as possible, never certain.',
  ],
});
