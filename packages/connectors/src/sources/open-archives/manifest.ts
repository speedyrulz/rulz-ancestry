import { defineManifest } from '../../manifest';

export const openArchivesManifest = defineManifest({
  id: 'open-archives',
  name: 'Open Archives (Open Archieven)',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://api.openarchieven.nl/1.1',
  siteUrl: 'https://www.openarchieven.nl',
  rateLimit: { requests: 4, perSeconds: 1, source: 'published' },
  cacheTtlHours: 24,
  mayStoreImages: false,
  attribution: 'Open Archives (openarchieven.nl) and the contributing archive',
  termsUrl: 'https://www.openarchieven.nl/api/docs/',
  docsUrl: 'https://www.openarchieven.nl/api/docs/records/search.php',
  verifiedOn: '2026-11-13',
  notes: [
    'The published limit is 4 requests per second per IP address.',
    'The search is records/search.json with name, lang, number_show and start; tried on 2026-11-13. A span of years after the name ("1850-1860") keeps the search to records of events in those years.',
    'A result is a record of an event that names the person in a role, with the archive that holds it. Its page is www.openarchieven.nl/<archive>:<record>/en.',
    'A match endpoint finds records by name and birth year, which suits the hints engine.',
    'Each contributing archive sets its own reuse terms; show the archive name with every record.',
    'Bulk dumps exist per archive and can become data packs in Phase 5; some archives exclude their data.',
  ],
});
