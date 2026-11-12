import { defineManifest } from '../../manifest';

export const openArchivesManifest = defineManifest({
  id: 'open-archives',
  name: 'Open Archives (Open Archieven)',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://api.openarchieven.nl/1.1',
  rateLimit: { requests: 4, perSeconds: 1, source: 'published' },
  cacheTtlHours: 24,
  mayStoreImages: false,
  attribution: 'Open Archives (openarchieven.nl) and the contributing archive',
  termsUrl: 'https://www.openarchieven.nl/api/docs/',
  docsUrl: 'https://www.openarchieven.nl/api/docs/records/search.php',
  verifiedOn: '2026-11-11',
  notes: [
    'The published limit is 4 requests per second per IP address.',
    'A match endpoint finds records by name and birth year, which suits the hints engine.',
    'Each contributing archive sets its own reuse terms; show the archive name with every record.',
    'Bulk dumps exist per archive and can become data packs in Phase 5; some archives exclude their data.',
  ],
});
