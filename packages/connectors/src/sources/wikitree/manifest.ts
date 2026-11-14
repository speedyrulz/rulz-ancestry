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
  mayShareWithAi: true,
  attribution: 'Profile data from WikiTree (wikitree.com)',
  termsUrl: 'https://www.wikitree.com/wiki/Help:App_Policies',
  docsUrl: 'https://github.com/wikitree/wikitree-api',
  verifiedOn: '2026-11-11',
  notes: [
    'Read-only API. Edits must send the user to the edit pages on wikitree.com.',
    'Send an appId parameter with every call; requests without one are rate-limited more strictly.',
    'Public profiles need no login. Private profiles return a privacy-limited data set unless the user signs in.',
    'Scraping the website is discouraged by the App Policies; use the API only.',
    'Use by an AI assistant, decided on 2026-11-14: the App Policies (the terms address above) refuse automated readers, so no tool read them. The project owner read them in a browser and found no rule on use by an AI, for it or against it, and decided to allow it on that reading. WikiTree itself was not asked. What is passed on is a result of a search the user made, and nothing more is asked of WikiTree for it: the name, the sex, and the dates and places of birth and death of a profile that WikiTree calls public or open and not living, with the credit line and the address of the profile. No biography is asked for. Names and places are as members of WikiTree typed them, so a remark typed into one of them goes along. If WikiTree states a rule against it, this is taken out again.',
  ],
});
