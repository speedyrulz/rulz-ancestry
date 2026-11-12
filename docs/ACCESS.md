# Access checklist

Some data sources need a key or an approval that only the project owner can
request, because each one involves creating an account or sending a request in
your own name. Nothing here costs money, except API use while developing one
route of the optional AI assistant (noted below). None of it blocks Phase 1 or
Phase 2.

Never commit a key to this repository. Keys entered in the app are stored
through Windows data protection (Electron `safeStorage`), starting in Phase 3.

Terms below were checked on 2026-11-11 unless marked "to confirm".

## Needed before Phase 3 (federated search)

- [ ] **US National Archives Catalog API key**
  - Email `Catalog_API@nara.gov` with your name and the email address to tie to the key. Ask for a read-only key.
  - Limit: 10,000 queries per month per key. A key over the limit is blocked until the 1st of the next month.
  - Because the limit is per key, each user of the app will enter their own key.
  - Docs: <https://www.archives.gov/research/catalog/help/api>

No key is needed for WikiTree, the Library of Congress, or Open Archives.

## Worth starting now because approval takes time

- [x] **FamilySearch developer account and app registration** (optional connector)
  - **Application submitted 2026-11-11. Waiting for FamilySearch to respond.**
  - When a key arrives: keep it out of this repository, and confirm the environment hostnames and throttling rules from the Authentication guide so the connector manifest can be completed.
  - Create a developer account and register an app at <https://developers.familysearch.org>. A Beta key is enabled automatically.
  - Read "App Approval Considerations" before applying: <https://developers.familysearch.org/main/docs/app-approval-considerations>
  - Production access requires acceptance into the Compatible Solution Program and a compatibility review. Reviewers favour apps that add value to Family Tree and do not put unusual load on it.
  - Know the limits going in: third-party apps cannot search or display FamilySearch historical records. The app can read the Family Tree and show match summaries, then must send the user to familysearch.org.
  - The app is designed to work fully without this connector.

## Needed before Phase 4b (optional AI assistant)

Anthropic's terms were checked on 2026-11-11. Section 7 of [PLAN.md](PLAN.md)
describes the three routes. Route A, a connector for the user's own Claude app,
needs no approval; to develop and test it you need Claude Desktop or Claude Code
signed in with your own Claude account.

- [x] **Decide which routes to build.** Decided 2026-11-11: A first, then C (the user's own API key), and B (starting the user's own Claude Code from this app) only if Anthropic confirms it.
- [ ] **Route C: an Anthropic API key for development.** Create one at <https://platform.claude.com>. API use is billed per use, so this is the one item in this file that costs money. Automated tests use recorded responses and never call the API.
- [ ] **Route B only: accept Anthropic's Commercial Terms of Service and ask Anthropic to confirm the use.**
  - Terms: <https://www.anthropic.com/legal/commercial-terms>
  - The conditions and the contact link are on <https://code.claude.com/docs/en/legal-and-compliance>, under "Can customers offer Claude Code in their products?" and "Authentication and credential use".
  - Ask whether a free, open-source desktop app may start the user's own unmodified Claude Code, which the user installed and signed in to themselves, for each AI run.
  - Do not build route B before a written answer.
- [ ] **Check each source's terms for AI use** before setting `mayShareWithAi` in its manifest. Start with WikiTree, the Library of Congress, Open Archives and NARA. FamilySearch stays off unless its terms allow it.
- [ ] **Read Anthropic's trademark guidelines** before the feature is named or described in the app: <https://www.anthropic.com/legal/trademark-guidelines>

## Needed before Phase 5 (more connectors) — to confirm

Each of these is believed to offer a free key, but the terms were not checked
on the date above. Confirm before building the connector.

- [ ] Geni (app key, OAuth sign-in)
- [ ] Digital Public Library of America
- [ ] Europeana
- [ ] Trove (National Library of Australia)
- [ ] DigitalNZ (includes Papers Past)

## Needed before Phase 6 (release)

- [ ] **Microsoft Store developer account.** Free for individuals since September 2025; register at <https://storedeveloper.microsoft.com> with a personal Microsoft account. The Store signs MSIX packages, so no paid certificate is needed.
- [x] **GitHub repository.** Public since 2026-11-11. The workflow in `.github/workflows/ci.yml` runs on every push to `main` and on pull requests; its first run passed.
- [ ] **App icon.** The installer currently uses the default Electron icon. Put a 256x256 `icon.ico` in `apps/desktop/build/`.

## Sources that must stay link-only

The app never fetches these sites. It opens a prefilled search in your browser.

- **Find a Grave** is governed by the Ancestry Terms and Conditions, which bar bulk or automated collection: <https://www.ancestry.com/c/legal/termsandconditions>
- **FamilySearch historical records**, for the reason given above.
- Others planned for Phase 3 (terms to confirm then): FreeBMD, FreeCEN, FreeREG, Ellis Island, JewishGen, IrishGenealogy.ie, Library and Archives Canada, ScotlandsPeople.
