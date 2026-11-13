import { defineManifest } from '../../manifest';

export const familySearchRecordsManifest = defineManifest({
  id: 'familysearch-records',
  name: 'FamilySearch',
  tier: 'deeplink',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://www.familysearch.org',
  siteUrl: 'https://www.familysearch.org',
  cacheTtlHours: 0,
  mayStoreImages: false,
  attribution: 'FamilySearch (familysearch.org)',
  termsUrl: 'https://www.familysearch.org/en/legal/legal-center',
  docsUrl: 'https://www.familysearch.org/en/search/',
  verifiedOn: '2026-11-13',
  notes: [
    'The search of historical records on familysearch.org. FamilySearch does not let third-party apps search or show these records, so the app only opens a prefilled search in the user’s browser.',
    'The app must never fetch this site. Seeing results needs a free FamilySearch account, which the user signs in to in their own browser.',
    'The address of a search (q.givenName, q.surname, q.birthLikeDate.from and .to, q.deathLikeDate.from and .to) follows the query terms in FamilySearch’s developer documentation and what others report of the website; it was not tried against the site.',
    'The user records what they found through the clip form, which creates a citation with the URL and access date.',
    'There is no connector for the Family Tree API: FamilySearch answered the project’s application on 2026-11-13 without access, which it limits to businesses that market applications they alone own.',
  ],
});
