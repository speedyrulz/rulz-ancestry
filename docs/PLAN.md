# RulZ Ancestry: project plan

A Windows desktop app with functionality similar to ancestry.com, built only on
free data sources. Written 2026-11-11. Source terms marked "verified" were
checked against the source's own pages on that date.

## 1. The constraint that shapes the design

No free source lets a third-party app search a record collection the size of
Ancestry's. FamilySearch has the largest free collection, but its API requires
approval and does not expose historical-record search to outside apps. The app
therefore combines three access methods and depends on no single provider.

| Ancestry feature                            | Free equivalent in this app                                                                                               | How close                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Family tree builder, charts, media, sources | Local tree database, GEDCOM import/export                                                                                 | Full                                                                    |
| Record search                               | Open APIs, local bulk indexes, prefilled links to free sites                                                              | Partial. Biggest gap: US census 1790–1930 and vital-record name indexes |
| Hints                                       | Local matching engine against open trees, records and newspapers; optional AI assistant that proposes matches (section 7) | Good for tree matches, weaker for records                               |
| Shared member trees                         | WikiTree, Geni, FamilySearch Family Tree, Wikidata                                                                        | Good                                                                    |
| Newspapers                                  | Library of Congress, Trove, Papers Past, Europeana, Gallica                                                               | Good for US 1756–1963 and several countries                             |
| DNA                                         | Local analysis of raw files the user already has                                                                          | Limited. No testing, no ethnicity estimate in v1                        |
| Cloud sync and collaboration                | None hosted. Portable tree folder; optional push to WikiTree or FamilySearch                                              | Limited                                                                 |

## 2. Stack

Electron, TypeScript, React and SQLite, in a pnpm monorepo.

- **Shell:** Electron with context isolation, no Node integration, sandboxed renderer, strict content security policy, and a typed IPC contract.
- **Database:** `better-sqlite3` with FTS5 for full-text search. Schema changes are numbered migrations in `packages/db/src/schema`, applied by `migrate()` and tracked with SQLite's `user_version`. Queries are hand-written SQL behind typed functions; there is no ORM.
- **UI:** React with Vite. D3 or the Topola library for charts, OpenSeadragon for IIIF record images, MapLibre GL for maps.
- **Matching:** `talisman` for Jaro-Winkler, Double Metaphone and Daitch-Mokotoff, plus an open nickname table.
- **AI assistant (optional):** the MCP TypeScript SDK (`@modelcontextprotocol/sdk`) for the tool server, packed for Claude Desktop as an `.mcpb` file, and `@anthropic-ai/sdk` for the API-key route. See section 7.
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

### Findings from Phase 1a that later phases rely on

- `better-sqlite3` binds numbered parameters (`?1`) by name, not by position. Use `@name` parameters with an object when a value is needed twice in a statement.
- `better-sqlite3` binds JavaScript numbers above 32 bits as floating point. Number columns are declared `INTEGER` so SQLite converts them back; this matters for timestamps and for rows that undo rewrites from JSON.
- SQLite fires a table's triggers for rows removed or changed by a foreign-key cascade. The change log and the search index depend on this, and the tests prove it.
- A lookup that tests two nullable columns at once (`person_id IS ? AND family_id IS ?`) made SQLite scan every row. Loading 10,000 people with 20,000 events took 89 seconds until that lookup and the ancestor check were fixed; it now takes 5 to 7 seconds through the one-record-at-a-time functions, and undoing it takes about 2. Write one statement per case, and keep the 10,000-person test, which fails when writes get slower as the tree grows. The GEDCOM importer will need a faster bulk path to load a file of that size in well under the 10-second target.
- `newId()` now counts within a millisecond, so ids made by one running app sort in creation order. `ORDER BY id` is therefore creation order and stays the same after undo and redo.

### Findings from Phase 1b that later phases rely on

- The renderer never imports `@rulz/db`, which needs Node.js. The shapes it receives are declared in `apps/desktop/src/shared/ipc.ts`, and the compiler checks that what the main process returns fits them. The renderer may import `@rulz/core`, so `packages/core` must stay free of Node.js imports.
- A new function for the page needs three entries, and the build fails if one is missing: the signature in `RulzApi`, the name in `API_METHODS`, and a handler in `apps/desktop/src/main/handlers.ts`. The handler's argument schema (zod) is tied to the signature by `define<'name'>`.
- Every call answers with `{ ok: true, value }` or `{ ok: false, error: { code, message } }`. An exception thrown across Electron's IPC keeps only its message, wrapped in other text, so errors travel as data. The messages of rule errors are written for the user and shown as they are.
- Main-process code that does not import Electron (`session.ts`, `handlers.ts`) is unit-tested under Vitest. Electron comes in only through the small `Platform` interface.
- A system dialog cannot be driven from a test. The end-to-end tests replace `dialog.showOpenDialog` in the main process (`answerFolderPicker` in `e2e/fixtures.ts`).
- A run started with `--user-data-dir` keeps new trees inside that folder. The end-to-end tests rely on this to stay out of the user's Documents.
- `eslint-plugin-react-hooks` 7 rejects a state change made directly in an effect. Screens load data in the promise's callback and keep "what this data was loaded for" as a key in state, in place of a loading flag.
- `VACUUM INTO` writes a consistent, compact copy of an open database in one synchronous call and keeps `application_id` and `user_version`. The copy is not in write-ahead-log mode until `openDatabase` opens it.
- SQLite reads a file only at the first statement. `openDatabase` closes the handle when that fails; otherwise Windows keeps a file that is not a database locked until the app exits.
- Measured on a 10,000-person tree: a list page 33 ms, a name search under 35 ms, a person page 2 ms, a backup 0.2 seconds and 26 MB.

### Findings from Phase 1c that later phases rely on

- **An untouched part of a file is written back from its own lines.** The GEDCOM reader keeps, with every node, the lines it was read from. The writer uses those lines for a node nobody changed, and writes a changed node afresh. This is what makes an export of an import identical; anything that changes a node must call `touch()` on it.
- **Reading and writing a name or event are one pair of functions** in `packages/core/src/gedcom` (`readName` and `patchName`, `readEvent` and `patchEvent`). The export decides whether a name changed by reading its original lines again and comparing with the tree. So a change to how a line is _read_ changes what the export thinks was edited in trees imported earlier. Change those functions only together with a migration that rewrites what is stored.
- **A statement that a trigger may abort gets a "statement journal", which SQLite puts in a temporary file by default.** Every write to a tree table is such a statement. Creating a file per statement made a 10,000-person import three times slower on disk than in memory. Every connection now sets `temp_store = MEMORY`.
- **`newId()` took a fifth of the import** because it asked the system for random bytes on every call. It now draws from a 4,096-byte pool and is fourteen times faster. Ids are otherwise unchanged.
- **Logging an import in the change log would double its time and the size of the tree file**, and undoing an import into an empty tree gives an empty tree. `Tree.load` is therefore the one unlogged way to write, allowed only into a tree with nobody in it. Because the change log no longer tells the whole story, backups also look at the `loaded_at` value in `tree_meta` to see that a tree changed.
- **The Write tool of this development setup turns a unicode escape in source text into the character itself.** A byte-order mark ended up as an invisible character in a source file. Build such characters with `String.fromCharCode`.
- **A file dialog cannot be driven from a test,** like the folder dialog. The end-to-end tests replace `dialog.showOpenDialog` and `dialog.showSaveDialog` in the main process (`answerFilePicker` and `answerSaveDialog` in `e2e/fixtures.ts`).
- Measured on a 10,000-person file of 261,000 lines: import 2.7 seconds in the app, from picking the file to the tree being on screen; export 0.8 seconds. Import time grows in step with the file: 50,000 people took 16 seconds before the two speed-ups above.

### Findings from Phase 1d that later phases rely on

- **Chart layout is plain arithmetic in `packages/core/src/chart.ts`.** It takes who is related to whom and gives back positions, with no knowledge of names or the screen, so it is unit-tested without a window. No chart library was added: the four charts need about 400 lines, and a library would have been one more dependency inside the content security policy.
- **Box charts are HTML buttons over an SVG of lines; the fan is SVG throughout.** Buttons give keyboard focus, a readable name and text that is cut off with an ellipsis for free. Zoom is a CSS scale on the whole chart.
- **The name of a relationship comes from two counts**: generations up from the first person to the nearest shared ancestor, and generations down to the second (`kinshipTerm` in `packages/core/src/kinship.ts`). Reports and the AI assistant can use the same function.
- **Duplicate scoring is `scoreDuplicate` in `packages/core/src/match.ts`**, with the name comparisons the hints of Phase 4 need: normalised names, Soundex and Jaro-Winkler. Its weights are hand-set and have not been checked against labelled data; Phase 4 plans that check.
- **Comparing everyone with everyone is too slow**, so records are compared only within groups that share a surname key (by sound, by first four letters, or without the first letter). A group of more than 300 people is split by the first letter of the given name. The scan stops after four million comparisons and says so.
- **A merge moves rows; it does not copy them.** Names, events and family links keep their ids, so undo is exact and the lines an imported file had under a name or event are still found by that id.
- **A merged person's kept GEDCOM lines would be lost without a record of the merge**, because those lines are stored under the id of the record that is gone. `merged_record` keeps that link, and the export and the person page follow it.
- **Dropping an exact repeat in a merge must look at the imported lines too.** Two births with the same date and place are repeats, unless the file gave one of them a source. Such a name or event is kept.
- **A result list must not offer stale answers.** The first version of the person picker showed the results of the previous spelling for a moment after each keystroke, and a click could land on the wrong person. It now shows results only for the text that is in the box.
- Measured on the 10,000-person sample tree: reading a chart of seven generations each way takes about 1 ms for an ordinary family, and about 70 ms with layout for the largest one shown (1,000 descendants and their partners); a relationship takes under 1 ms; a merge takes 6 ms. The duplicate scan takes 2.2 seconds there and stops at its limit of four million comparisons, because the sample repeats a small set of names. No tree with realistic names was measured.

## 3. Architecture

```
apps/desktop          Electron main process (jobs, HTTP, storage), preload, React renderer
packages/core         Domain model, GEDCOM, date and place parsing, matching. No Electron.
packages/db           Schema, migrations, repositories
packages/connectors   One module per data source behind a shared interface
packages/ai           Planned for Phase 4b: the AI assistant's tools, instructions and proposal checks. No Electron.
```

Inside the desktop app:

```
src/shared/ipc.ts     The contract: every function the page may call, and the shapes that cross
src/preload           Exposes exactly those functions to the page as window.rulz
src/main/index.ts     Electron wiring: window, security settings, IPC registration, quit
src/main/session.ts   The open tree, the recent list, reopening at start, backup on close,
                      import and export of GEDCOM files. No Electron.
src/main/handlers.ts  What each function does, after checking its arguments. No Electron.
src/renderer          React screens: start screen, person list, person page, charts, dialogs
```

Charts, relationships and duplicates are split between the packages in the same
way as GEDCOM: what can be worked out from plain values is in `core`, and what
needs the tree is in `db`.

```
packages/core/src/chart.ts        Where each box, line and fan segment goes.
packages/core/src/kinship.ts      The name of a relationship ("second cousin once removed").
packages/core/src/match.ts        How likely two person records are one person.
packages/db/src/charts.ts         Reading a person's ancestors and descendants.
packages/db/src/relationship.ts   Finding how two people are related.
packages/db/src/duplicates.ts     Scanning a tree for likely duplicates.
packages/db/src/merge.ts          Merging two records of one person.
```

GEDCOM is split between two packages:

```
packages/core/src/gedcom   No Node.js, no database: decoding bytes to text (UTF-8, UTF-16, ANSEL,
                           Windows-1252, IBM PC), reading text into records, writing records as
                           text, reading and writing names, events and family links, and rewriting
                           records from one GEDCOM version to the other.
packages/db/src/gedcom     Loading a parsed file into a tree, and writing a tree as a file.
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

Built, in schema version 1 (`packages/db/src/schema/001-core-tree.ts`):

```sql
tree_meta(key, value)                                        -- tree id, name, created_at
person(id, sex, living, created_at, updated_at)              -- living: 1, 0 or NULL (not stated)
person_name(id, person_id, type, prefix, given, nickname, surname, suffix, is_primary, sort_order)
family(id, partner1_id, partner2_id, created_at, updated_at)
family_child(id, family_id, child_id, pedigree, sort_order)  -- birth|adopted|foster|step|sealing|other
event(id, type, date_text, date_qualifier, date_calendar, date_min_jdn, date_max_jdn,
      place_text, description, created_at, updated_at)
event_participant(id, event_id, person_id, family_id, role, sort_order)  -- a person or a family
change_tx(id, label, at, undone)                             -- one undoable step
change_log(id, tx_id, entity_type, entity_id, op, before_json, after_json)
change_state(id, mode, current_tx)                           -- idle | record | replay
search_doc(id, entity_type, entity_id, person_id)            -- maps a search row to its record
search_fts                                                   -- FTS5 over names
```

Built, in schema version 2 (`packages/db/src/schema/002-gedcom.ts`):

```sql
gedcom_record(id, position, tag, xref, kind, text, parts)    -- one row per record of an imported file
  -- kind: head | person | family | kept
  -- person and family rows: id is the person's or family's id, text is the record's first line,
  --   parts is a JSON list of the lines under it, each saying what it became (a name, an event,
  --   a family link) or nothing, when it is kept as written
  -- kept rows: text is the whole record (a source, a note, a media item, another program's own)
tree_meta also holds: gedcom_version, gedcom_encoding, gedcom_line_ending, gedcom_file,
  gedcom_imported_at, loaded_at
```

`gedcom_record` is written once, by the import, and never changed afterwards, so
it is not in the change log. A row whose person has been deleted is ignored by
the export, and is used again if the deletion is undone.

Built, in schema version 3 (`packages/db/src/schema/003-merge.ts`):

```sql
not_duplicate(id, person_a, person_b, created_at)            -- a pair the user said are two people
merged_record(id, kind, into_id, merged_at)                  -- id: the person or family that was
                                                             --   merged; into_id: the one left
```

Both are in the change log, so marking a pair and merging two people can be
undone. `merged_record` is how the export and the person page find the kept
lines of a record that was merged into another.

Planned, each added by a migration in the phase that first uses it:

```sql
place(id, name, parent_id, geonames_id, lat, lon)            -- Phase 2; event gains place_id
source(id, title, author, repository_id, connector_id, url)
citation(id, source_id, page, url, accessed_at, transcription, confidence, external_record_id)
citation_link(citation_id, entity_type, entity_id)
media(id, sha256, rel_path, mime, title)
media_link(media_id, entity_type, entity_id, region_json)
external_id(person_id, connector_id, external_key)
external_record(id, connector_id, external_key, record_type, payload_json, fetched_at, expires_at)
hint(id, person_id, external_record_id, origin, score, features_json, rationale_json,
     status, decided_at)                                     -- origin: engine | ai
job(id, kind, payload_json, priority, run_after, attempts, status)
```

The AI assistant's activity log (`ai_run`, `ai_tool_call`) is planned for the app
database, not the tree, so a tree folder that is copied or shared carries no AI
logs.

Also planned: places, notes and transcriptions in the search index. Phonetic
codes were planned as columns on `person_name`; part 1d works them out in memory
during a scan instead, which needed no schema change. They become columns only
if the hints of Phase 4 need to look names up by sound in the database. When sources, notes and
media get their tables (Phase 2), a migration moves them out of the `kept` rows
and the kept lines of `gedcom_record`.

The application database (`app.db` in the profile folder, schema in
`packages/db/src/appdb.ts`) is separate from any tree. Built, in its schema
version 1:

```sql
setting(key, value)                                          -- e.g. the tree to reopen at start
recent_tree(dir, tree_id, name, last_opened_at)              -- at most 20, latest first
```

Rules:

- **IDs** are UUIDv7 (`newId()` in `packages/core`) so trees can be merged. The cross-reference ids of an imported GEDCOM file (`@I1@`) are kept in `gedcom_record.xref` and used again on export; a person added later gets the first free `I` number, a family the first free `F` number.
- **Dates** keep the text as typed, plus a normalized day-number range, a qualifier (about, before, between) and a calendar. `parseDate()` in `packages/core` reads GEDCOM 5.5.1 and 7.0 dates and common English forms. Text it cannot read is kept as a phrase with no range.
- **Places** keep the text as typed and only link to a standardized GeoNames entry. The user's text is never overwritten.
- **What the app has no fields for is kept as written.** Every line of an imported GEDCOM file is stored: a line that became a name, an event or a family link together with the id of what it became, and every other line (sources, notes, media, other programs' own tags) exactly as it was. The export puts each line back in its place. A name or event that was not edited since the import is written from its original lines; one that was edited gets only the edited lines rewritten.
- **An import makes a new tree.** A GEDCOM file is not merged into a tree that has people in it. The duplicate detection that needs exists since part 1d; bringing a file into an existing tree is still to be built.
- **Nothing is merged automatically.** The app lists pairs of people who may be one person, with a score and its reasons. Two records become one only when the user compares them and says so, and a pair the user marks as different people is not offered again.
- **A merge loses nothing but exact repeats.** The person kept receives the other record's names, events, parents, partners and children. A name or event is dropped only when the person kept already has it word for word and the imported file says nothing more about it. Two families with the same two partners become one. The whole merge is one undo step.
- **Some merges are refused**: a person with their own ancestor or descendant (they would become their own ancestor), and two people who are partners of each other.
- **Every write** goes through `change_log`, which provides undo and a per-person history. Database triggers do the recording, and they reject any write to a tree table that is not inside a change transaction (`Tree.transact`), so no code path can skip the log. The one exception is `Tree.load`, which fills a tree that has nobody in it (an import) without logging; what it loads is the tree's starting point and cannot be undone.
- **Exports leave out living people unless asked.** The export dialog starts on "leave out people who may be living". A person may be living unless they are marked deceased, have a death, burial, cremation or probate recorded, or took part in an event that certainly happened more than 110 years ago (`presumedLivingIds` in `packages/db/src/living.ts`). Someone with no dates at all counts as possibly living. A family with a living partner is written without its events and notes.
- **The primary name** is a flag on `person_name` with a unique index, not a column on `person`, which avoids two tables pointing at each other.
- **A person cannot be their own ancestor.** `addChild` and `setPartners` refuse a link that would create a loop, so charts can walk the tree without guarding against one.
- **A family that links nobody is removed.** When a person is deleted or unlinked, a family with nobody left in it goes, and a family with one person left goes unless it has events of its own.
- **Backups** are complete copies of `tree.db` in the `backups` folder inside the tree folder. One is written with SQLite's `VACUUM INTO` when a tree is closed or the app quits, if the tree changed since the newest backup. A copy is written under a temporary name, checked, and only then given its final name. Kept: the ten newest, then the last backup of each month for six months. Restoring a backup first backs up the present state.
- **Search** uses the FTS5 tokenizer `unicode61 remove_diacritics 2`, so "muller" finds "Müller". Triggers keep the index in step with the names, including during undo and redo.

## 6. Features by module

1. **Tree:** person and family editing; pedigree, descendant, hourglass and fan charts; relationship calculator; duplicate detection and merge. Built in parts 1b and 1d.
2. **GEDCOM:** import 5.5.1 (including ANSEL encoding and vendor tags from Ancestry, Family Tree Maker, RootsMagic, MyHeritage) and 7.0; export both. This is the migration path from Ancestry, whose export carries media links but not the media files. Built in part 1c, apart from GEDZip (a 7.0 file zipped together with its media), which waits for the media store in Phase 2.
3. **Sources and media:** citation management, IIIF deep-zoom viewer, face-region tags, optional local OCR with `tesseract.js`.
4. **Search:** one query form sent to Tier A connectors and installed packs, results grouped by source with attribution, plus a row of Tier C links.
5. **Hints:** background jobs query sources for each person, direct ancestors first. Scoring is Fellegi-Sunter style over name similarity, phonetic codes, date gaps, place hierarchy overlap and relatives' names. Results go to a hints inbox with a side-by-side compare. Accepted facts get a citation, rejected hints never resurface, and nothing merges automatically.
6. **Places and timeline:** local gazetteer autocomplete, map of a person's events, life timeline.
7. **Reports:** charts to SVG/PDF, family group sheet, Ahnentafel, narrative report, with a filter that hides living people.
8. **DNA (later):** import raw files from AncestryDNA, 23andMe, MyHeritage and FamilyTreeDNA; compare two kits for shared segments; estimate relationships from shared centimorgans; import and cluster match lists. All local, never uploaded.
9. **AI assistant (optional):** Claude plans searches, reads the results and proposes matches with written reasons; the user confirms or rejects each one in the hints inbox. Off by default. See section 7.

## 7. AI assistant (optional)

Added 2026-11-11. An optional mode in which Claude plans searches, reads the
results and proposes matches, and the user confirms or rejects each one. It is
off until the user turns it on, and the app works fully without it.

The aim is to let a user who already pays for a Claude plan spend that plan's
usage here. Anthropic's rules decide how that can be done.

### What Anthropic allows

Checked against Anthropic's own pages on 2026-11-11.

- **An app may not offer its own Claude sign-in.** Third-party developers may not offer Claude.ai login in their applications, send requests through a user's Free, Pro, Max or Ultra plan credentials, or collect or store those credentials. Sign-in must complete in Anthropic's own software. The Agent SDK page states the same for apps built on it, "unless previously approved". Sources: <https://code.claude.com/docs/en/legal-and-compliance> ("Authentication and credential use") and <https://code.claude.com/docs/en/agent-sdk/overview>.
- **A user may use their plan in Anthropic's own apps,** and those apps can load a local tool server (MCP). Claude Desktop installs one from an `.mcpb` file that the user opens, and Node.js is included with Claude Desktop on Windows. Source: <https://claude.com/docs/connectors/building/mcpb>.
- **A product may run the unmodified Claude Code program** when each user signs in to it themselves, the product does not pay for, resell or pass on the usage, no sign-in method is removed, and the developer has agreed to Anthropic's Commercial Terms of Service. Source: the legal page above, "Can customers offer Claude Code in their products?".
- **Billing for that route moved during 2026.** On 2026-11-11, usage from `claude -p` signed in with a plan counts against the plan's limits. Anthropic announced a change to that earlier in the year and paused it on 2026-06-15 with no new date. It also reserves the right to charge third-party tool use to usage credits instead of plan limits. Sources: <https://support.claude.com/articles/15036540> and <https://support.claude.com/en/articles/13189465-logging-in-to-your-claude-account>.
- **An API key is always allowed** and is what Anthropic tells developers to use. It is billed per use and is separate from a plan. The first support article above says Max, Ultra and Team plans include monthly API credits for a linked Claude Console organization.

### Three routes

| Route                                              | How the user connects                                                                            | What pays for it                                               | Where the user works                                           | Standing                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A. Connector for the user's Claude app             | Installs this app's connector in Claude Desktop (one `.mcpb` file) or adds it to Claude Code     | The user's Claude plan, as ordinary use of Anthropic's own app | In Claude's window. Proposals arrive in this app's hints inbox | Allowed. Built first                                                                                             |
| B. The user's own Claude Code, started by this app | Installs Claude Code and signs in to it themselves. This app starts it, unmodified, for each run | The user's plan today. Anthropic may change this               | In this app, from a button on a person                         | Allowed under conditions. Built only after the owner accepts the Commercial Terms and Anthropic confirms the use |
| C. The user's own API key                          | Pastes a key from Claude Console. Stored with `safeStorage`                                      | Pay-per-use API billing, or a plan's monthly API credits       | In this app                                                    | Allowed. Built second                                                                                            |

Not built under any route: a Claude sign-in inside this app, reading the login
that Claude Code or Claude Desktop stores, or any other reuse of a plan's
tokens.

### What the AI does

One set of tools serves all three routes. The tools live in `packages/ai` and
run in the app's main process.

| Tool                                         | What it does                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `search_tree`, `get_person`, `get_relatives` | Read the open tree                                                                                                                 |
| `list_sources`                               | Lists the connectors and data packs the AI may use                                                                                 |
| `search_records`                             | Runs a search through a connector or pack, under that source's rate limit and quota, and returns the stored `external_record` rows |
| `get_record`                                 | Returns one stored record                                                                                                          |
| `propose_match`                              | Files a hint for the user: the person, the record, a verdict, a confidence and reasons, each reason quoting the record             |
| `suggest_link`                               | Suggests a Tier C link for the user to open in their own browser                                                                   |

No tool edits the tree, reads a file, runs a command or fetches a URL.

What this adds to the Phase 4 matching engine:

- **Search planning:** spelling variants, maiden and married names, likely places and date ranges worked out from relatives' events, and which source suits the question.
- **Judging unclear candidates,** with the reasoning written out, including the evidence against a match.
- **Reading free text** such as newspaper articles and obituaries to pull out the people and relationships named in them.
- **Suggesting what to look for next** when nothing is found.

A run covers one person, or a short list, chosen by the user. Proposals appear in
the hints inbox marked as AI, beside the record, the matching engine's own score
and the AI's reasons. Accepting one creates a citation as any accepted hint does.
Nothing merges automatically.

The search functions from Phase 3 and the hint functions from Phase 4 take plain
data in and return plain data, so these tools are thin wrappers around them.

### How each route connects

- **Route A.** A small stdio MCP server ships with the app, packed as an `.mcpb` file. It forwards each tool call to the running app over a Windows named pipe protected by a per-install secret. The tools therefore run in the app's main process, the tree has one writer, and every rate limit is enforced in one place. The app must be open, and it shows what the AI is doing. The server also supplies the research instructions as an MCP prompt. The Claude directory no longer accepts `.mcpb` submissions, so the file is distributed with the app. To settle when built: how the bridge is packaged and how Claude Code users add it.
- **Route B.** The app starts `claude -p` with `--mcp-config` and `--strict-mcp-config` (this app's server only), `--tools ""` (no built-in tools, so no file, shell or web access), `--allowedTools` naming this app's tools, `--permission-mode dontAsk`, `--output-format json` with `--json-schema`, `--max-turns`, `--max-budget-usd` and `--no-session-persistence`, in an empty working folder. It cannot use `--bare`, because bare mode does not read the plan sign-in; Anthropic's documentation says bare mode will become the default for `-p` in a future release, which may force a change here. To settle when built: how to keep the user's own Claude Code hooks, plugins and memory out of these runs without `--bare`.
- **Route C.** The main process calls the Messages API through `@anthropic-ai/sdk`, using the SDK's tool runner over the same tools, with streaming and with prompt caching of the instructions and tool list. The default model is `claude-opus-5-5`, and the user can choose a cheaper one.

### Rules

- **Off by default.** Before the first run a consent screen states what is sent and to whom. The feature can be turned off again at any time.
- **The AI proposes and the user decides.** AI tools cannot write to the tree. A change happens only when the user accepts a proposal, through `Tree.transact` like any other edit.
- **Every reason quotes the record.** The app checks each quote against the stored record and drops a reason whose quote is not there. A proposal left with no reason is not shown. This guards against invented evidence.
- **The source rules still apply.** AI searches go through the connectors and the shared HTTP client, with the same rate limits, quotas and attribution. No scraping. Tier C stays link-only. Each run has a search budget per source, which matters for sources with a monthly quota such as NARA.
- **Each source must permit it.** A new manifest field, `mayShareWithAi`, says whether a source's record text may be sent to an AI service. It is false until that source's terms have been checked. FamilySearch stays false unless its terms allow it.
- **Living people are masked** in what the tools return, as "Living person" plus the relationship, unless the user opts in for that tree. DNA data is never offered to the AI.
- **Record text is untrusted.** A record, a newspaper page or a community tree profile may contain text written as instructions. It is passed as data. Because the tools can only read and propose, the worst result is a bad proposal, which the user reviews.
- **An activity log** lists each run's searches, the records read and what was sent. It is kept in the app database, not in the tree folder.
- **Usage is shown where the route reports it.** Routes B and C report tokens and an estimated cost for each run. Route A does not; that usage is visible in Claude's own app.
- **Naming.** The feature is called "AI assistant". The app may say in plain text that it works with Claude. It uses no Anthropic name or logo in a product or feature name, and Anthropic's trademark guidelines are checked before release.

### Limits

- **Route A's conversation happens in Claude's window,** not in this app. Only the proposals appear here.
- **In route A the app does not control Claude's other tools.** The user's Claude app may have web search or other connectors turned on. The app accepts proposals only for records it fetched itself, so its own no-scraping rule holds.
- **Route B rests on terms and billing that changed several times in 2026.** It is isolated behind the same interface as the other routes so it can be removed without touching them.
- **The AI can be wrong.** Its precision is measured on the Phase 4 labelled test set and compared with the matching engine alone before the feature is released.
- **A run over a whole tree could use up a plan's limits quickly.** The first version runs on one person or a short list, with a cap on searches and turns.

## 8. Phases

Durations are rough estimates for one developer working with AI assistance.

| Phase                       | Scope                                                                                                                                                                                                                     | Done when                                                                                                                                                                             | Estimate  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0. Foundations              | Repo, monorepo, CI, packaging; connector manifests; access checklist                                                                                                                                                      | An installer builds and the packaged app opens a window. **Done 2026-11-11**                                                                                                          | 1 week    |
| 1. Core tree                | Schema, editing, charts, own-tree search, GEDCOM both versions, undo, backups                                                                                                                                             | A 10,000-person Ancestry GEDCOM imports in under 10 seconds and round-trips with no diff. Met in part 1c on a file written in Ancestry's style; a real export is still to be tried    | 3–4 weeks |
| 2. Sources, media, places   | Citations, media store and viewer, gazetteer, map, timeline                                                                                                                                                               | A scanned record can be attached, cited and viewed at full zoom                                                                                                                       | 2–3 weeks |
| 3. Federated search         | HTTP client; WikiTree, Wikidata, Library of Congress, Open Archives, NARA, Internet Archive; Tier C links and clip form                                                                                                   | A search returns grouped results and one click attaches a record as a citation                                                                                                        | 3–4 weeks |
| 4. Hints                    | Matching engine, job scheduler, inbox, compare view                                                                                                                                                                       | Hints appear for an imported tree and precision is measured on a labelled test set                                                                                                    | 2–3 weeks |
| 4b. AI assistant (optional) | Shared tool set; connector for Claude Desktop and Claude Code (route A); AI hints with quoted reasons; consent, masking of living people, activity log; then the API-key route (C). Route B only if Anthropic confirms it | From Claude Desktop, asking for records for one person puts proposals in the hints inbox, each with reasons quoted from the record, and precision is measured on the Phase 4 test set | 2–3 weeks |
| 5. Packs and more sources   | Pack manager, 1950 census index, Open Archives dumps; Geni, regional newspapers, FamilySearch if approved                                                                                                                 | Packs install, search offline, and uninstall cleanly                                                                                                                                  | 2–3 weeks |
| 6. Release                  | Reports, accessibility, app icon, auto-update, MSIX, Store submission, user docs                                                                                                                                          | Installable from the Store and GitHub Releases                                                                                                                                        | 2 weeks   |
| 7. DNA and extras           | DNA tools; transcription of record images, locally or through the AI assistant                                                                                                                                            | Open-ended                                                                                                                                                                            | —         |

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

### Phase 1 breakdown

| Part | Scope                                                                                                           | Status              |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1a   | Tree database layer: migrations, schema, people, names, families, events, dates, undo and redo, own-tree search | **Done 2026-11-11** |
| 1b   | Tree screens: create and open a tree folder, person list and page, editing, undo and redo, search box, backups  | **Done 2026-11-11** |
| 1c   | GEDCOM 5.5.1 and 7.0 import and export, with the cross-reference ids, notes and unknown tags a round trip needs | **Done 2026-11-11** |
| 1d   | Charts (pedigree, descendant, hourglass, fan), relationship calculator, duplicate detection and merge           | **Done 2026-11-11** |

All four parts are built. Phase 1 is not closed until its test has been run on
a real export from Ancestry; see "Phase 1c outcome".

### Phase 1a outcome

Delivered in `packages/db` and `packages/core`: the migration runner, schema
version 1, typed functions for people, names, families, children and events,
date parsing, the change log with undo and redo, own-tree search, and a tree
folder format (`tree.db` marked with its own SQLite application id). The app's
system check now builds a tree in memory at start-up and adds, finds, undoes
and redoes a person, so the packaged app proves the layer works. 103 unit tests
cover it, including a 21-step editing session walked backwards and forwards
through undo and redo, and a 10,000-person load.

Not done, and why (tree screens and backups were also open here; part 1b delivered them):

- **Places** stay as typed text. The `place` table arrives with the gazetteer in Phase 2.
- **Hebrew and French Republican dates** are recognised and stored, but not converted to day numbers, so they do not sort.
- **Numeric dates such as 12/03/1881** are kept as text only, because the day and month order is ambiguous. Month names are read in English only.
- **Per-person history** has its data in `change_log` but no query or screen yet.
- **The change log grows without limit.** It needs a pruning rule before a release.

### Phase 1b outcome

Delivered:

- **Start screen.** Create a tree by name; its folder is made in `Documents\RulZ Ancestry` or in a folder the user picks. Open a tree folder through the system dialog, or from the list of recent trees, which marks folders that are no longer there. The tree that was open when the app quit is reopened at the next start.
- **Tree screen.** Everyone by surname in a list that loads 100 rows at a time, a search box that finds people by any of their names, and a page for one person: sex, living or deceased, names, events, parents, brothers and sisters, partners and children. All of it can be edited there, and relatives are links to their own pages.
- **Adding people.** A form for name, sex, birth and death, which shows how each date was read before it is saved. A relative can be a new person or someone already in the tree.
- **Undo and redo.** Every edit the screens offer is one undo step, including the ones that touch several records, such as "Add father". The buttons name the step, and Ctrl+Z and Ctrl+Y work outside text boxes.
- **Backups.** Automatic when a tree is closed or the app quits, on request, with a dialog to list them, open their folder and restore one. See section 5 for the rules.
- **The contract between the page and the main process** grew from 1 function to 33. Each one checks its arguments, and the page can create a tree only where the user picked a folder and open only a recent tree or a folder the user picked.
- **A damaged `app.db` no longer stops the app from starting.** It is set aside and a new one is made; it holds only the recent list and settings.
- **Tests.** Unit tests went from 103 to 206 and now include the main process's session and handlers. End-to-end tests went from 8 to 17, run against both the production build and the packaged app.

Changed from part 1a: deleting a person now also removes a family that is left with one person and no events. Part 1a removed only a family with nobody in it.

Not done, and why:

- **A tree cannot be renamed, moved or deleted inside the app.** Moving the folder in File Explorer and opening it again works.
- **No drawing of the tree.** Charts are part 1d; until then relatives are reached through the list and the links on a person's page.
- **One parent cannot be removed for one child only.** "Remove from this family" takes the person away from both parents, and "Remove partner" applies to all of that family's children.
- **A second set of parents can only be added once the first set has two parents.** Before that, a new parent joins the first set.
- **Witnesses and events shared by several people** have their place in the schema but no screen.
- **Living or deceased is not worked out from events.** A person with a death date still shows "Not stated" until it is set by hand. This is due with the filter that hides living people (reports, Phase 6).
- **Backups hold the whole undo history**, so each backup of the 10,000-person test tree is 26 MB and up to 16 are kept. Pruning the change log, still open from part 1a, will shrink them.
- **Backups are kept on the same disk as the tree.** They guard against mistakes and a damaged file, not against losing the disk.
- **The backup on quitting is done in one blocking step.** It takes 0.2 seconds for 10,000 people; a much larger tree would delay the exit, and Windows may not wait for it at shutdown.
- **Dark colours** follow the Windows setting, but only the light colours were checked by eye.
- **The installer itself was still not executed.** As before, tests ran against its unpacked contents.

### Phase 1c outcome

Delivered:

- **Import.** "Choose a GEDCOM file" on the start screen reads a file into a new tree and opens it. GEDCOM 5.5.1 (also 5.5 and 5.5.5) and 7.0 are read, in UTF-8, UTF-16, ANSEL, Windows-1252 or the old IBM PC character set; the character set is checked against the bytes, not only taken from the header. The reader never stops at a line that breaks the rules: it reads it as well as it can and lists it.
- **What goes into the tree.** People with sex and names (including the name pieces, titles, nicknames, suffixes and the kind of name); 35 kinds of personal event and attribute and 12 kinds for couples, plus the tags Ancestry and Family Tree Maker add for events the standard lacks; families with partners and children in order; and how each child is linked, from the standard `PEDI` line or from Ancestry's `_FREL` and `_MREL`.
- **What is kept as written.** Everything else: sources and citations, notes, media, repositories, submitters, other programs' own tags. A person's page lists the lines kept for that person.
- **Repairs, all reported.** A link that only one side of the file states is made. A link that would make someone their own ancestor is not made. A line that points at a record that is not in the file is kept as written. After the import the app shows how many such places there were, with a list by line number.
- **Export.** "Export" on the tree screen writes GEDCOM 5.5.1 or 7.0, in UTF-8. A tree exported in the version it was imported in comes out line for line as it went in, apart from the header, which names this app as the writer. After edits, only the lines of what was edited differ, and new names, events and links follow the original ones of their kind.
- **The other version.** A tree imported from 5.5.1 can be exported as 7.0 and the reverse. What the app models is written in the right form; for the kept lines a set of plain rewrites is applied (note records and shared notes, dates, values that changed case, tags one version lacks, file formats and media types, language names). What has no rule is written as it is, and the export says how many such items there were.
- **Dates typed in the app are written in GEDCOM's form.** "12 March 1881" becomes `12 MAR 1881`, "about 1850" becomes `ABT 1850`, "1850-1855" becomes `BET 1850 AND 1855`, and text that is not a date becomes a date phrase.
- **Living people are left out of an export unless the user chooses "include everyone".** See the rule in section 5. The dialog says how many people that is before anything is written.
- **Speed.** A 10,000-person file of 261,000 lines, written the way Ancestry writes its exports, imports in 2.7 seconds in the packaged app and exports in under a second. The target was 10 seconds.
- **Tests.** Unit tests went from 206 to 385 and end-to-end tests from 17 to 22. The end-to-end tests import the 10,000-person file through the real window, export it, and compare every line.

Changed from earlier parts:

- **The tree schema is at version 2.** A tree made by an earlier build is upgraded when it is opened, and an earlier build can then no longer open it. Its backups from before are still read.
- **Every database connection keeps its temporary data in memory,** and `newId()` draws its random bytes from a pool. Both were found while timing the import, and both make ordinary edits faster too.
- **The start screen has a third card,** and the tree screen an Export button.

Not done, and why:

- **It has not been tried on a real Ancestry export.** The 10,000-person test file is written to look like one, from what is known of Ancestry's format; no real export was available. The same goes for Family Tree Maker, RootsMagic, MyHeritage and Gramps. The owner should import a real export and report what the import lists. The official GEDCOM 7.0 test files were not used either; downloading them into the repository needs the owner's say.
- **A file cannot be merged into a tree that has people in it.** An import always makes a new tree. Merging needs duplicate detection, which is part 1d.
- **An import cannot be undone,** and a tree cannot be deleted in the app. To discard an imported tree, close it and delete its folder.
- **GEDZip files (`.gdz`) are refused,** with a message to unzip them first. Media files are not copied: a media record keeps its lines, and its link or file name with them. Both wait for the media store in Phase 2.
- **Sources, notes and media have no screens.** They are kept and exported, and those lines that sit directly under a person are shown on that person's page as GEDCOM text. Lines kept under a name, an event or a family, and records of their own, are not shown anywhere yet.
- **The rewrite between versions is partial.** A media item described in place (5.5.1) is not turned into a media record, an unknown file format is left as it is, and 7.0 extension tags are not declared in the header. A strict reader of the other version may reject such lines. Exporting in the version the file came in avoids all of this.
- **A description typed on an event such as a birth** is written on the event's own line in 5.5.1, as Ancestry does, although the standard allows only `Y` there. In 7.0 it is written as a note under the event, and importing that file again shows it with the kept lines, not as the description.
- **Not everything about a name survives an edit.** A name written surname first is rewritten given name first when it is edited, and a separate surname prefix (`SPFX`) is folded into the surname when the surname is edited. A kind of name outside the app's list is shown as "other". Unedited names are untouched.
- **A family with more than two partners** keeps the third as a line, not as a partner.
- **The export is not identical in four cases,** all outside the app's control or deliberate: a file that was not in UTF-8 comes back as UTF-8; blank lines are dropped; a continuation line that came after other sub-lines moves up to its own line; and a repaired or repeated link changes the lines of that link.
- **The living rule is cautious and simple.** It does not reason from relatives (a person whose child was born in 1850 still counts as possibly living if nothing else is recorded), so sparse trees leave out more people than necessary. Notes and sources that are kept as written may mention living people and are exported as they are.
- **The import runs in one blocking step.** The window does not respond for the 3 seconds a 10,000-person file takes; a 100,000-person file would take about half a minute. There is no progress bar, and files over 256 MB are refused.
- **A tree is upgraded in place when a newer build opens it,** with no backup made just before. The migration in this part only adds a table; a migration that rewrites data should back up first.
- **The lines kept from a file are never pruned.** A person deleted from the tree leaves their original lines in the tree file, so that undo can bring them back complete.
- **The real Windows file dialogs were not exercised,** like the folder dialog in part 1b: the tests replace them.
- **One unexplained crash.** During one run of the unit tests the worker running the 10,000-person test stopped with a Windows access violation. It did not happen again in ten further full runs or in any other run, and no cause was found.

### Phase 1d outcome

Delivered:

- **Four charts,** opened with "Chart" on a person's page: ancestors (a pedigree), descendants, an hourglass of both, and a fan of ancestors. Each has a choice of 2 to 8 generations (7 for the fan), zoom, "Fit", and dragging to move. Clicking a person puts them at the centre; clicking the person at the centre opens their details; choosing someone in the list of people redraws the chart for them. A box shows "more…" where the tree goes on beyond the chart.
- **How the charts treat awkward families.** A person with two sets of parents is drawn with their birth parents. An unknown parent leaves an empty place, so the father's side stays above and the mother's below. Each partner is drawn under the person, and the children of each partnership hang from that partner on a line of their own. An ancestor who appears on two lines is drawn twice.
- **A relationship calculator,** opened with "Relationship" on a person's page. It names blood relationships of any distance ("second cousin once removed", "3rd great-grandmother", "half-sister"), lists the people in between and the ancestors shared, and says when two people are related in more than one way. It also names partners, and relatives through one partnership ("father-in-law", "stepson", "wife of an uncle").
- **Duplicate detection,** opened with "Duplicates" on the tree screen. It compares everyone in the tree and lists the pairs most likely to be one person, each with a score from 50 to 100 and the reasons for it: names (including spelling variants, initials and every name a person has), years of birth and death, places, and parents and partners who are the same or have the same names. Two children of one family born in different years are not offered, nor are a parent and child or two partners.
- **Merge,** from that list or with "Merge" on a person's page. The two records are shown side by side and the user chooses which to keep. See the rules in section 5. A pair can instead be marked as different people.
- **Merges and GEDCOM.** After a merge, an export writes one record that carries the kept lines of both, moves the lines under a name or event with it, and makes every line that pointed at the merged record point at the one that is left. Undoing the merge gives the original file back.
- **Tests.** Unit tests went from 385 to 488 and end-to-end tests from 22 to 25. The end-to-end tests draw all four charts, ask for relationships, and find, merge, undo and dismiss a duplicate in the real window.

Changed from earlier parts:

- **The tree schema is at version 3.** As in part 1c, a tree is upgraded when this build opens it, and an earlier build can then no longer open it.
- **An export no longer leaves a line pointing at a person who was deleted since the import.** Part 1c dropped the deleted person's record but left lines elsewhere that pointed at it, such as an association. Those lines are now dropped too.
- **The contract between the page and the main process has 41 functions,** five more than before.
- **The person page has three more buttons** (Chart, Relationship, Merge) and the tree screen one more (Duplicates).

Not done, and why:

- **The duplicate scores are not validated.** The weights were set by hand and tried on made-up people. Nobody has checked on a real tree how many of the listed pairs are true duplicates, or how many true duplicates are missed. Phase 4 plans a labelled test set; until then the list is a suggestion and the comparison screen is the safeguard.
- **Some duplicates are not found.** Two records are compared only when their surnames sound alike, start with the same four letters, or differ only in the first letter. A woman entered once under her maiden name and once under her married name is found only if one record lists both names. In a group of more than 300 people with one surname, given names that start with different letters (Catherine, Katherine) are not compared.
- **A file still cannot be imported into an existing tree.** The parts are there (import, duplicate detection, merge), but not the step that joins them.
- **A merge cannot choose between two values.** It keeps both versions of every fact; the user deletes the wrong one afterwards. Only sex and living status are single values, and the record kept wins where it states them.
- **Families are joined only when both partners are the same.** Two families of one person with an unknown partner each are left as two, because the unknown partners may differ.
- **Relationships through more than one partnership are not found,** for example the brother of a sister-in-law. Step-brothers and step-sisters are reported as no relationship.
- **"Husband" and "wife" are used only when a marriage event is recorded**; otherwise the word is "partner". Adoptive, foster and step links count like birth links when a relationship is worked out, and the answer does not say which kind was followed.
- **When two people are related in several ways, a "half" relationship can be reported as full or the reverse** in rare trees where the same ancestors are reached by two routes. The first route found decides.
- **There is no home person.** Other programs show how everyone is related to one chosen person; here the question is asked for one pair at a time.
- **Charts cannot be printed or saved** as a picture or PDF. That is part of the reports in Phase 6.
- **The fan shows at most six generations of ancestors and the other charts at most seven**; a descendant chart stops at 1,000 descendants. Long names are cut off; the full name is in the tooltip.
- **A very large descendant chart is slow to draw.** Every box is an element on the page; 1,000 descendants with their partners make 2,000 of them.
- **The duplicate scan blocks the window while it runs,** about 2 seconds on the 10,000-person sample tree, and stops after four million comparisons.
- **The charts were checked by eye in light colours only,** and at one window size. Dragging was not tried on a touch screen.
- **The unexplained crash of part 1c happened again, once.** In one of about twelve full runs of the unit tests in this part, the worker running the 10,000-person GEDCOM test stopped before reporting its three tests. Eight further full runs in a row passed. It is the same test file as before, which this part did not change. The cause is still unknown; the next step is to capture a crash dump. Until then a run of the unit tests, locally or in CI, can fail for this reason and pass when repeated.

## 9. Risks

- **Anthropic's rules for using a Claude plan outside its own apps changed several times in 2026** and may change again. Route A of the AI assistant relies only on ordinary use of Anthropic's own apps. Routes B and C sit behind one interface, and the app works without any of them.
- **AI proposals can be wrong or invented.** Every reason must quote the stored record, the app checks the quotes, and the user decides. See section 7.
- **FamilySearch may refuse or delay approval.** Nothing in Phases 1–4 depends on it; the Tier C link is the fallback.
- **APIs change or close**, as the Chronicling America legacy API did in 2025. Connectors are isolated, and from Phase 3 a scheduled CI job runs contract checks against live endpoints.
- **Terms of service.** No scraping anywhere. Rate limits and attribution come from the manifest.
- **Data quality.** Community trees and machine-read indexes contain errors, so every fact shows its source and nothing is accepted without the user.
- **Privacy.** Living people and DNA stay on the PC. Exports hide living people by default. No telemetry. The one exception is the optional AI assistant: while it is on, details of the people being researched and the records read for them are sent to Anthropic. Living people are masked unless the user opts in, and DNA is never sent.
- **GEDCOM files in the wild do not follow the standard closely,** and each program bends it in its own way. The import was built from the two standards and from what is known of Ancestry's files, not from a collection of real exports. It keeps every line it does not understand and reports what it could not place, so a surprise in a real file should cost a misread field, not lost data. Real exports from each program need to be tried before a release.
- **A wrong merge damages a tree,** and a list of suggested duplicates invites one. The app never merges on its own, shows both records before a merge, keeps everything both had, and makes the merge one undo step. The undo history is kept in the tree file, and backups hold earlier states.
- **A test that fails now and then hides real failures.** The 10,000-person GEDCOM unit test has stopped with a native crash twice in about 35 full runs, with no cause found. If it becomes more frequent, find the cause before adding more tests around it.
- **Coverage.** Users with mostly US ancestors before 1940 will do much of their record searching through links to FamilySearch's own site.

## 10. Open decisions

1. **Open source or private.** Decided 2026-11-11: the repository is public on GitHub under the MIT license.
2. **Region priority,** which sets connector order. Default: US, then Netherlands, UK and Ireland, Australia and New Zealand.
3. **FamilySearch.** Decided 2026-11-11: applied. Awaiting a response; the connector stays optional either way.
4. **AI assistant routes.** Decided 2026-11-11: build route A first, then route C. Route B is built only after Anthropic confirms in writing that starting the user's own unmodified Claude Code from this app is permitted; it also needs the owner to accept Anthropic's Commercial Terms of Service. See [ACCESS.md](ACCESS.md).
