import { defineManifest } from '../../manifest';

export const nara1950CensusManifest = defineManifest({
  id: 'nara-1950-census',
  name: '1950 US Census (National Archives)',
  tier: 'bulk',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://nara-1950-census.s3.us-east-2.amazonaws.com/',
  siteUrl: 'https://1950census.archives.gov',
  cacheTtlHours: 8760,
  mayStoreImages: false,
  attribution: '1950 Census, National Archives and Records Administration',
  termsUrl: 'https://www.archives.gov/developer/1950-census',
  docsUrl: 'https://registry.opendata.aws/nara-1950-census/',
  verifiedOn: '2026-11-15',
  notes: [
    'Public S3 bucket in us-east-2; readable without an AWS account (unsigned requests). A US Government work, with no copyright.',
    'The bucket holds no index of names. Each state has one metadata file (metadata/json/<code>.json, 60 files, 544 MB in all, dated 2022-04-01) that lists its counties and enumeration districts, each with its description, roll and page images; a territory lists only its pages.',
    'A data pack is one state built from its metadata file, to browse by county and district. A page image (about 5 MB) is fetched from the bucket only when the user views it, and is never stored.',
    'NARA’s own name search at 1950census.archives.gov was machine-read from handwriting and contains errors; the app only opens it in the user’s browser (the source nara-1950-search).',
  ],
});
