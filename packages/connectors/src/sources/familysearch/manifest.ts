import { defineManifest } from '../../manifest';

export const familySearchManifest = defineManifest({
  id: 'familysearch',
  name: 'FamilySearch Family Tree',
  tier: 'api',
  auth: 'oauth2-pkce',
  access: 'approval-required',
  baseUrl: 'https://api.familysearch.org',
  rateLimit: { requests: 1, perSeconds: 1, source: 'self-imposed' },
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: 'FamilySearch Family Tree (familysearch.org)',
  termsUrl: 'https://developers.familysearch.org/main/docs/compatibility-checklist',
  docsUrl: 'https://developers.familysearch.org/main/docs/getting-started',
  verifiedOn: '2026-11-11',
  notes: [
    'Optional connector. Nothing else in the app may depend on it.',
    'A Beta key is enabled automatically for a registered app. Production needs acceptance into the Compatible Solution Program and a compatibility review.',
    'Third-party apps cannot search or display historical records. Send the user to familysearch.org to review and attach them.',
    'Sign-in must use OAuth 2 in the system browser, or an embedded page that shows the URL.',
    'Do not store the session permanently and do not keep fetched data after the session ends (cacheTtlHours is 0).',
    'Do not show familysearch.org pages inside a frame.',
    'Environment hostnames and throttling rules were not on the pages checked; confirm them from the Authentication guide once a key is issued.',
    'If the app uses AI features, the AI Utilization Disclosure Addendum applies.',
  ],
});
