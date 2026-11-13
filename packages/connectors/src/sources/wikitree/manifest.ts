import { defineManifest } from '../../manifest';

export const wikitreeManifest = defineManifest({
  id: 'wikitree',
  name: 'WikiTree',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://api.wikitree.com/api.php',
  siteUrl: 'https://www.wikitree.com',
  rateLimit: { requests: 200, perSeconds: 60, source: 'published' },
  cacheTtlHours: 24,
  mayStoreImages: false,
  attribution: 'Profile data from WikiTree (wikitree.com)',
  termsUrl: 'https://www.wikitree.com/wiki/Help:App_Policies',
  docsUrl: 'https://github.com/wikitree/wikitree-api',
  verifiedOn: '2026-11-11',
  notes: [
    'Read-only API. Edits must send the user to the edit pages on wikitree.com.',
    'Send an appId parameter with every call; requests without one are rate-limited more strictly.',
    'Public profiles need no login. Private profiles return a privacy-limited data set unless the user signs in.',
    'Scraping the website is discouraged by the App Policies; use the API only.',
  ],
});
