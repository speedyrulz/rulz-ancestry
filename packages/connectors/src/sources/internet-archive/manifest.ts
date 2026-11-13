import { defineManifest } from '../../manifest';

export const internetArchiveManifest = defineManifest({
  id: 'internet-archive',
  name: 'Internet Archive',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://archive.org/advancedsearch.php',
  siteUrl: 'https://archive.org',
  rateLimit: { requests: 30, perSeconds: 60, source: 'self-imposed' },
  pauseSeconds: 900,
  cacheTtlHours: 24,
  mayStoreImages: false,
  attribution: 'Internet Archive (archive.org)',
  termsUrl: 'https://archive.org/about/terms',
  docsUrl: 'https://archive.org/developers/bots.html',
  verifiedOn: '2026-11-13',
  notes: [
    'The search is advancedsearch.php, which looks in what is written about an item (its title, author, subjects, description), not inside the text of a book.',
    'The Archive has no documented API for a search inside the texts. Its website uses one that it marks as beta, on another host; the app does not use it.',
    'The Archive publishes no number of requests per minute. Its page for automated access asks for a descriptive User-Agent, for honouring 429 and Retry-After, and for caching. The limit here is the project’s own.',
    'Paging stops at 10,000 results.',
    'The rights to an item differ from item to item, so nothing of an item is copied into a tree.',
    'The Terms of Use page could not be read by the tools this manifest was written with; the project owner should read it.',
  ],
});
