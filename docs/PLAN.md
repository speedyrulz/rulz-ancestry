# RulZ Ancestry: project plan

A Windows desktop app with functionality similar to ancestry.com, built only on
free data sources. Written 2026-11-11. Source terms marked "verified" were
checked against the source's own pages on that date.

## 1. The constraint that shapes the design

No free source lets a third-party app search a record collection the size of
Ancestry's. FamilySearch has the largest free collection, but its API requires
approval and does not expose historical-record search to outside apps. The app
therefore combines three access methods and depends on no single provider.

| Ancestry feature                            | Free equivalent in this app                                                  | How close                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Family tree builder, charts, media, sources | Local tree database, GEDCOM import/export                                    | Full                                                                    |
| Record search                               | Open APIs, local bulk indexes, prefilled links to free sites                 | Partial. Biggest gap: US census 1790–1930 and vital-record name indexes |
| Hints                                       | Local matching engine against open trees, records and newspapers             | Good for tree matches, weaker for records                               |
| Shared member trees                         | WikiTree, Geni, FamilySearch Family Tree, Wikidata                           | Good                                                                    |
| Newspapers                                  | Library of Congress, Trove, Papers Past, Europeana, Gallica                  | Good for US 1756–1963 and several countries                             |
| DNA                                         | Local analysis of raw files the user already has                             | Limited. No testing, no ethnicity estimate in v1                        |
| Cloud sync and collaboration                | None hosted. Portable tree folder; optional push to WikiTree or FamilySearch | Limited                                                                 |

## 2. Stack

Electron, TypeScript, React and SQLite, in a pnpm monorepo.

- **Shell:** Electron with context isolation, no Node integration, sandboxed renderer, strict content security policy, and a typed IPC contract.
- **Database:** `better-sqlite3` with FTS5 for full-text search. Plain SQL migrations plus a typed query layer, chosen in Phase 1.
- **UI:** React with Vite. D3 or the Topola library for charts, OpenSeadragon for IIIF record images, MapLibre GL for maps.
- **Matching:** `talisman` for Jaro-Winkler, Double Metaphone and Daitch-Mokotoff, plus an open nickname table.
- **Secrets:** Electron `safeStorage` (Windows DPAPI). OAuth through the system browser with PKCE and a loopback redirect.
- **Tests:** Vitest for units, Playwright for end-to-end, recorded HTTP fixtures so tests never call live APIs.
- **Distribution:** `electron-builder`. NSIS installer on GitHub Releases, MSIX for the Microsoft Store. Store registration is free for individuals (verified) and the Store signs MSIX packages. The unsigned NSIS installer shows a SmartScreen warning.

### Findings from Phase 0 that later phases rely on

- `better-sqlite3` 13 ships N-API prebuilt binaries. The same binary runs in Node and in Electron, so there is no native rebuild step (`npmRebuild: false`) and unit tests run under plain Node.
- TypeScript is pinned to 6.0.x because `typescript-eslint` does not yet support TypeScript 7.
- The Electron version is pinned exactly; `electron-builder` requires it and the runtime should only change on purpose.
- pnpm 12 denies dependency install scripts unless listed under `allowBuilds`, and holds back very recently published package versions. Prefer an older version over excluding a package from that check.
- pnpm uses the hoisted linker (`nodeLinker: hoisted`) so `electron-builder` finds production dependencies.
- Workspace packages are devDependencies of the desktop app and get bundled into the main process. Only real runtime packages that must stay external (currently just `better-sqlite3`) go in `dependencies`.

## 3. Architecture

```
apps/desktop          Electron main process (jobs, HTTP, storage), preload, React renderer
packages/core         Domain model, GEDCOM, date and place parsing, matching. No Electron.
packages/db           Schema, migrations, repositories
packages/connectors   One module per data source behind a shared interface
```

Every source has a manifest (`packages/connectors/src/manifest.ts`) holding its
tier, auth method, rate limit, quota, cache lifetime, attribution and terms URL.
From Phase 3 a shared HTTP client enforces those values with a per-host token
bucket, honours `Retry-After`, caches with ETags, and sends a descriptive app
User-Agent. Connectors implement:

```ts
export interface SourceConnector {
  readonly manifest: ConnectorManifest;
  searchPersons?(q: PersonQuery, page: PageRequest): Promise<Page<ExternalRecord>>;
  searchText?(q: TextQuery, page: PageRequest): Promise<Page<ExternalRecord>>;
  getRecord?(key: string): Promise<ExternalRecord>;
  getRelatives?(key: string): Promise<ExternalPersonGraph>;
  buildDeepLink?(q: PersonQuery): string;
}
```

## 4. Data sources

### Tier A: official APIs, queried live

| Source                                           | Provides                                                           | Access                                                                                                                                      | Status     |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| WikiTree                                         | Collaborative tree profiles, ancestors, descendants                | No key. Send `appId`. 200 requests/min. Read-only; edits go through the site                                                                | Verified   |
| Library of Congress / Chronicling America        | Full-text US newspapers, maps, photos                              | loc.gov JSON API, no key. 20 requests/min, one-hour block if exceeded. Legacy API retired 2025. Queries over 100,000 results rejected       | Verified   |
| NARA Catalog API v2                              | Military, immigration, naturalization descriptions and scans       | Free key by email, sent in `x-api-key`. 10,000 queries/month per key                                                                        | Verified   |
| Open Archives                                    | Dutch and Belgian civil and church records                         | No key. 4 requests/sec. Match endpoint by name and birth year                                                                               | Verified   |
| FamilySearch                                     | Family Tree persons, relatives, sources, memories, match summaries | OAuth 2. Beta key automatic; production needs a compatibility review. No historical-record search. No data kept after the session. Optional | Verified   |
| Wikidata                                         | Notable people, family links, cross-site IDs                       | SPARQL, CC0, no key                                                                                                                         | To confirm |
| Internet Archive                                 | City directories, county histories, yearbooks, census film scans   | Free search and metadata APIs                                                                                                               | To confirm |
| Geni, DPLA, Europeana, Trove, DigitalNZ, Gallica | World tree profiles; regional newspapers and archives              | Free app key each                                                                                                                           | To confirm |

### Tier B: open bulk datasets, installed as optional data packs

- **NARA 1950 census** (verified): public S3 bucket `nara-1950-census`, no AWS account needed. Over 165 TB in full, so a pack holds only the name index and images load on demand. The index was machine-read from handwriting and has errors.
- **NARA 1940 census** (verified): bucket `nara-1940-census`, about 15 TB. No name index found; browse by enumeration district.
- **Open Archives dumps** (verified): CSV/XML per archive; some archives exclude their data.
- **To confirm:** Reclaim the Records indexes, GeoNames gazetteer, VA gravesite data, Commonwealth War Graves data.

Each pack is its own SQLite file with FTS5 under `%LOCALAPPDATA%\RulZAncestry\packs\`,
attached to the main database, so a pack can be removed without touching the tree.

### Tier C: link-only

Free sites with no API, or terms against automated access. The app builds a
search URL from the selected person, opens it in the user's browser, and offers
a clip form that turns the result URL into a citation. The app never fetches
these sites.

Find a Grave (governed by Ancestry's terms, which bar automated collection),
FamilySearch record search, FreeBMD/FreeCEN/FreeREG, Ellis Island, JewishGen,
IrishGenealogy.ie, Library and Archives Canada, ScotlandsPeople index.

## 5. Data model

A tree is one portable folder: a SQLite file plus a content-addressed media folder.

```sql
person(id, sex, living, primary_name_id, created_at, updated_at)
person_name(id, person_id, type, given, surname, suffix, nickname, phonetic_dm, phonetic_metaphone)
family(id, partner1_id, partner2_id)
family_child(family_id, child_id, pedigree, sort_order)        -- birth|adopted|foster|step
event(id, type, date_text, date_min_jdn, date_max_jdn, qualifier, calendar, place_id, place_text)
event_participant(event_id, person_id, family_id, role)
place(id, name, parent_id, geonames_id, lat, lon)
source(id, title, author, repository_id, connector_id, url)
citation(id, source_id, page, url, accessed_at, transcription, confidence, external_record_id)
citation_link(citation_id, entity_type, entity_id)
media(id, sha256, rel_path, mime, title)
media_link(media_id, entity_type, entity_id, region_json)
external_id(person_id, connector_id, external_key)
external_record(id, connector_id, external_key, record_type, payload_json, fetched_at, expires_at)
hint(id, person_id, external_record_id, score, features_json, status, decided_at)
job(id, kind, payload_json, priority, run_after, attempts, status)
change_log(id, tx_id, entity_type, entity_id, op, before_json, after_json, at)
search_fts  -- FTS5 over names, places, notes, transcriptions
```

Rules:

- **IDs** are UUIDv7 (`newId()` in `packages/core`) so trees can be merged. Original GEDCOM cross-reference IDs are kept for round-tripping.
- **Dates** keep the text as typed, plus a normalized day-number range, a qualifier (about, before, between) and a calendar.
- **Places** keep the text as typed and only link to a standardized GeoNames entry. The user's text is never overwritten.
- **Unknown GEDCOM tags** are stored verbatim so export loses nothing.
- **Every write** goes through `change_log`, which provides undo and a per-person history.
- **Backups** run on close using SQLite's online backup, keeping the last several copies.
- **Search** uses the FTS5 tokenizer `unicode61 remove_diacritics 2`, so "muller" finds "Müller".

## 6. Features by module

1. **Tree:** person and family editing; pedigree, descendant, hourglass and fan charts; relationship calculator; duplicate detection and merge.
2. **GEDCOM:** import 5.5.1 (including ANSEL encoding and vendor tags from Ancestry, Family Tree Maker, RootsMagic, MyHeritage) and 7.0 with GEDZip media; export both. This is the migration path from Ancestry, whose export carries media links but not the media files.
3. **Sources and media:** citation management, IIIF deep-zoom viewer, face-region tags, optional local OCR with `tesseract.js`.
4. **Search:** one query form sent to Tier A connectors and installed packs, results grouped by source with attribution, plus a row of Tier C links.
5. **Hints:** background jobs query sources for each person, direct ancestors first. Scoring is Fellegi-Sunter style over name similarity, phonetic codes, date gaps, place hierarchy overlap and relatives' names. Results go to a hints inbox with a side-by-side compare. Accepted facts get a citation, rejected hints never resurface, and nothing merges automatically.
6. **Places and timeline:** local gazetteer autocomplete, map of a person's events, life timeline.
7. **Reports:** charts to SVG/PDF, family group sheet, Ahnentafel, narrative report, with a filter that hides living people.
8. **DNA (later):** import raw files from AncestryDNA, 23andMe, MyHeritage and FamilyTreeDNA; compare two kits for shared segments; estimate relationships from shared centimorgans; import and cluster match lists. All local, never uploaded.

## 7. Phases

Durations are rough estimates for one developer working with AI assistance.

| Phase                     | Scope                                                                                                                   | Done when                                                                                | Estimate  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------- |
| 0. Foundations            | Repo, monorepo, CI, packaging; connector manifests; access checklist                                                    | An installer builds and the packaged app opens a window. **Done 2026-11-11**             | 1 week    |
| 1. Core tree              | Schema, editing, charts, own-tree search, GEDCOM both versions, undo, backups                                           | A 10,000-person Ancestry GEDCOM imports in under 10 seconds and round-trips with no diff | 3–4 weeks |
| 2. Sources, media, places | Citations, media store and viewer, gazetteer, map, timeline                                                             | A scanned record can be attached, cited and viewed at full zoom                          | 2–3 weeks |
| 3. Federated search       | HTTP client; WikiTree, Wikidata, Library of Congress, Open Archives, NARA, Internet Archive; Tier C links and clip form | A search returns grouped results and one click attaches a record as a citation           | 3–4 weeks |
| 4. Hints                  | Matching engine, job scheduler, inbox, compare view                                                                     | Hints appear for an imported tree and precision is measured on a labelled test set       | 2–3 weeks |
| 5. Packs and more sources | Pack manager, 1950 census index, Open Archives dumps; Geni, regional newspapers, FamilySearch if approved               | Packs install, search offline, and uninstall cleanly                                     | 2–3 weeks |
| 6. Release                | Reports, accessibility, app icon, auto-update, MSIX, Store submission, user docs                                        | Installable from the Store and GitHub Releases                                           | 2 weeks   |
| 7. DNA and extras         | DNA tools, optional local AI transcription                                                                              | Open-ended                                                                               | —         |

### Phase 0 outcome

Delivered: git repository, pnpm monorepo, the four packages, strict TypeScript,
ESLint, Prettier, unit tests, end-to-end tests that run against both the
production build and the packaged app, an NSIS installer, a CI workflow, eight
connector manifests, and [ACCESS.md](ACCESS.md).

Not done, and why:

- **Keys** (NARA and others) need the owner's own accounts. The FamilySearch application was submitted on 2026-11-11 and is awaiting a response. See [ACCESS.md](ACCESS.md).
- **The installer itself was not executed.** Tests ran against its unpacked contents (`release/win-unpacked`), which is what the installer copies.
- **No app icon.** The default Electron icon is used until Phase 6.
- **MSIX packaging** needs the Store identity, so it belongs to Phase 6.

## 8. Risks

- **FamilySearch may refuse or delay approval.** Nothing in Phases 1–4 depends on it; the Tier C link is the fallback.
- **APIs change or close**, as the Chronicling America legacy API did in 2025. Connectors are isolated, and from Phase 3 a scheduled CI job runs contract checks against live endpoints.
- **Terms of service.** No scraping anywhere. Rate limits and attribution come from the manifest.
- **Data quality.** Community trees and machine-read indexes contain errors, so every fact shows its source and nothing is accepted without the user.
- **Privacy.** Living people and DNA stay on the PC. Exports hide living people by default. No telemetry.
- **Coverage.** Users with mostly US ancestors before 1940 will do much of their record searching through links to FamilySearch's own site.

## 9. Open decisions

1. **Open source or private.** Decided 2026-11-11: the repository is public on GitHub under the MIT license.
2. **Region priority,** which sets connector order. Default: US, then Netherlands, UK and Ireland, Australia and New Zealand.
3. **FamilySearch.** Decided 2026-11-11: applied. Awaiting a response; the connector stays optional either way.
