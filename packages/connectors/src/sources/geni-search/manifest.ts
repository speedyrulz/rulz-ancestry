import { defineManifest } from '../../manifest';

export const geniSearchManifest = defineManifest({
  id: 'geni-search',
  name: 'Geni',
  tier: 'deeplink',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://www.geni.com',
  siteUrl: 'https://www.geni.com',
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: 'Geni',
  termsUrl: 'https://www.geni.com/company/terms_of_use',
  docsUrl: 'https://www.geni.com/platform/developer/help',
  verifiedOn: '2026-11-15',
  notes: [
    'Every call to Geni’s API needs the user’s own Geni login and an app registered with Geni, and its terms bar keeping what it returns, so the app never asks Geni. It only opens Geni’s own search in the user’s browser.',
    'The address of a search (/search?search_type=people&names=<given surname>) was seen to show results to an agent’s reading tool on 2026-11-15; whether a visitor who is not logged in sees them was not tried.',
  ],
});
