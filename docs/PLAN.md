# RulZ Ancestry: project plan

A Windows desktop app with functionality similar to ancestry.com, built only on
free data sources. Written 2026-11-11. Source terms marked "verified" were
checked against the source's own pages on that date.

## 1. The constraint that shapes the design

No free source lets a third-party app search a record collection the size of
Ancestry's. FamilySearch has the largest free collection, but its API does not
expose historical-record search to outside apps, and FamilySearch gives access
to it only to businesses that market applications they alone own; this project
asked and got none (2026-11-13). The app therefore combines three access
methods and depends on no single provider.

| Ancestry feature                            | Free equivalent in this app                                                                                               | How close                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Family tree builder, charts, media, sources | Local tree database, GEDCOM import/export                                                                                 | Full                                                                    |
| Record search                               | Open APIs, local bulk indexes, prefilled links to free sites                                                              | Partial. Biggest gap: US census 1790–1930 and vital-record name indexes |
| Hints                                       | Local matching engine against open trees, records and newspapers; optional AI assistant that proposes matches (section 7) | Good for tree matches, weaker for records                               |
| Shared member trees                         | WikiTree, Geni, Wikidata                                                                                                  | Good                                                                    |
| Newspapers                                  | Library of Congress, Trove, Papers Past, Europeana, Gallica                                                               | Good for US 1756–1963 and several countries                             |
| DNA                                         | Local analysis of raw files the user already has                                                                          | Limited. No testing, no ethnicity estimate in v1                        |
| Cloud sync and collaboration                | None hosted. Portable tree folder; optional push to WikiTree                                                              | Limited                                                                 |

## 2. Stack

Electron, TypeScript, React and SQLite, in a pnpm monorepo.

- **Shell:** Electron with context isolation, no Node integration, sandboxed renderer, strict content security policy, and a typed IPC contract.
- **Database:** `better-sqlite3` with FTS5 for full-text search. Schema changes are numbered migrations in `packages/db/src/schema`, applied by `migrate()` and tracked with SQLite's `user_version`. Queries are hand-written SQL behind typed functions; there is no ORM.
- **UI:** React with Vite. D3 or the Topola library for charts, OpenSeadragon for IIIF record images. Maps are drawn in SVG with d3-geo from outlines the app ships with (decided 2026-11-13; the plan first named MapLibre GL, which needs map tiles).
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

### Findings from Phase 2a that later phases rely on

- **A table for something the import used to keep as written needs three things together:** a migration that makes the rows for trees imported earlier, an import that makes the same rows for a new file, and a test that the two agree. `CitationLoader` in `packages/db/src/gedcom/citations.ts` is the one piece of code both use; `packages/db/src/gedcom/sources.test.ts` imports a file the old way into a version 3 tree, upgrades it, and compares it with a fresh import. Notes, media and places will each need the same.
- **The stored lines of an imported file are not rewritten when part of them gets a table.** A part of a person's record is only marked: `k: 'citation'` with the citation's id for a SOUR line under the person, and a list `c` of citation ids for the SOUR lines under a name or event. The export finds a citation's original lines through those marks and patches them, as it does for names and events.
- **A link from many kinds of record uses one nullable column per kind,** each a real foreign key with `ON DELETE CASCADE`, as `event_participant` does, and one query per column. `citation_link` has four. A single column holding "type and id" would have no foreign key, and every place that deletes a person, family, event or name would have to clean up after itself.
- **A rule such as "a citation goes with its last link" is a trigger that acts only while a change is recorded** (`change_state.mode = 'record'`). The change log then holds both deletions, and undo and redo write the rows back themselves. A trigger that also acted during undo would fight the replay.
- **Lines that say the same are one citation.** Ancestry writes a citation out again under every fact it supports. The import makes one citation of SOUR lines that cite the same source in exactly the same words, with one link per fact. The sample file has 20,000 such lines and 10,000 citations.
- **A citation used for a new fact is written with the lines of its first imported copy,** so what the app has no fields for (Ancestry's `_APID`, a media link) goes along. A copy written at another level than it was read from must have all its lines marked as changed (`touchAll`), because original lines carry their level numbers.
- **A tree is backed up before a migration changes it.** `openTree` calls `backupTree` when the file is at an older schema version. Nothing is written when the newest backup already holds the same data, which is the usual case, since the app backs a tree up when it closes it.
- **A dialog can open another dialog over itself.** The fact's list of sources opens the form for one citation as a second `<dialog>` inside the first. Both are modal, Escape closes the top one, and no state has to be passed between them.
- Measured on the 10,000-person sample tree, with other work running on the machine: a person's page with its citations reads in 0.3 ms, the list of sources in 0.5 ms, a page of 50 citations of one source with the facts they support in 2 ms. Upgrading the tree from schema version 3 takes about 1.1 seconds. Sources make the import slower: writing the sample to the database takes about 3.2 seconds with its 10,000 citations and 20,000 links and about 2.4 without, measured four times each. In the app the whole import, from picking the file to the tree being on screen, took 3.2 to 3.6 seconds in three runs. The export takes about 0.15 seconds longer, at about 0.95.

### Findings from Phase 2b that later phases rely on

- **A file of a tree is stored under the SHA-256 of its contents and is never changed or removed by an edit.** The row in `media` needs no path: the hash and the extension say where the file is (`mediaStorePath` in `packages/core/src/media.ts`), so a tree folder can be moved. Deleting a file from the tree deletes the row and leaves the copy, which is what lets Undo, Redo and a restored backup find it again. The price is that the app never frees disk space; a clean-up that removes copies no row and no undo step refers to is still to be built.
- **The page loads pictures from a scheme of the app's own, `rulz-media:`.** `protocol.handle` in the main process answers `rulz-media://file/<id>` and `rulz-media://thumb/<id>` from the open tree. The page names a file only by the id of its row, so no address can reach a file outside the tree's media folder (`apps/desktop/src/main/mediafiles.ts`, unit-tested without Electron). The scheme is declared with `registerSchemesAsPrivileged` before the app is ready, and the content security policy allows it for images only.
- **Windows makes the small pictures.** `nativeImage.createThumbnailFromPath` asks the Windows thumbnail cache, which also keeps them. A 2,400 by 3,200 scan came back as 240 by 320. Nothing is cached by the app. Where Windows has no preview, a picture is shown from the file itself and a document gets a tile with its extension.
- **The kind of a file is told from its first bytes, not its name** (`sniffMediaType`). The window draws JPEG, PNG, GIF, WebP, BMP and AVIF; everything else, TIFF and PDF included, is a document that another program opens.
- **Opening a file must never run it.** The app hands a file to Windows only when its extension is on a fixed list of pictures, documents, sound and film (`canOpenOutside`). Anything else is only shown in its folder. The same list decides which documents Windows is asked to preview.
- **A dialog with buttons of its own cannot sit inside a form.** React passes a submit of an inner form on to the form around it, even through a second `<dialog>`. `FormDialog` therefore takes a `before` slot that is shown above its form, and the files of a citation are put there.
- **A picture with zoom needs no library.** The viewer is one `<img>` moved and scaled with a CSS transform inside a clipped area (`ImageStage` in `apps/desktop/src/renderer/src/components/media.tsx`). The wheel needs a listener of its own, because React listens for it passively and cannot stop the dialog from scrolling.
- Measured in the unit tests, on a solid-state disk and with the files just written (so partly from memory): 40 files of 5 MB each are taken into a tree in 0.33 seconds, one file of 200 MB in 0.22 seconds, and a person's page with 41 files reads in 0.3 ms.

### Findings from Phase 2c that later phases rely on

- **A GEDCOM file names a picture in one of two ways.** A media record (`0 @M1@ OBJE`) with lines that point at it is what GEDCOM 7.0 requires and what the sample written in Ancestry's style has. GEDCOM 5.5.1 also allows the description in place, under each person on the photograph (`1 OBJE` with a `2 FILE` line), and several desktop programs are said to write that form. Both are read (`packages/core/src/gedcom/media.ts`). Descriptions in place that say the same in the same words are one file with several links. Which program writes which form was taken from the standards and from memory of such files, not from real exports: none has been tried.
- **Below the first level of a record, the export works out which file a line stands for; it stores no mark.** A pointer names a media record, and a description in place is found by its wording, in the table `gedcom_media`. Only a line directly under a person or a family is marked, like a citation there, because the person's page must know that it is not a line "kept as written". This needed far less bookkeeping than the marks citations have, and a line that a file repeats is handled without a special case.
- **A file the tree only knows of is a row without a hash.** `media.sha256` is NULL until the file itself is given: from the zip archive the GEDCOM file came in, from a file the user points at, or from a folder the user has the app look in. `media.origin` keeps the path or web address the imported file gave. The page is never served anything for such a row, whatever path it names.
- **One file may now be two rows.** Two records of an imported file may name the same picture, and both are kept, so that the file can be written back as it was. The index on `sha256` is therefore no longer unique. A file added in the app is still one row: it attaches the oldest row that has its contents.
- **An import copies no file from a path a GEDCOM file names.** Such a path can be anything on the computer, and a file from someone else must not be able to pull a document into a tree that is later shared. Files come only from the archive the GEDCOM file came in, by a path that stays inside it, or from a file or folder the user picks in the system dialog.
- **A zip archive is read and written without a library** (`packages/db/src/zip.ts`, on `node:zlib`). The reader never writes a file under a name from an archive: it hands out bytes, and the media folder files them under their hash, so an archive cannot place a file anywhere. An entry is refused when it is larger than it was told to take, whatever size the archive states. Files written by it were opened with Windows' own tools, and a zip made by Windows was read. ZIP64 (over 4 GB) is neither read nor written.
- **A migration that writes to a tracked table takes the triggers off first** (`untrackChanges`), writes, and puts them back with `trackChanges`, which also picks up a new column. Rows logged before the column existed are still undone correctly, because undo writes only the columns a logged row has.
- **GEDCOM 7.0 has no place for a description in place,** so an export to 7.0 turns each into a record with pointers. The lines the app has no fields for come along into the record.
- Measured in the unit tests, on a solid-state disk and with the files just written: a GEDZip file with 100 files of 5 MB each (500 MB) is written in 0.7 seconds and imported in 1.1 seconds, and those 100 files are found in a folder and taken in 1.1 seconds. Upgrading the 10,000-person sample tree, which has 1,000 lines that point at one portrait, takes 0.4 seconds. The import and the export of that sample take as long as before this part, measured three times each on the same day: 4.0 to 4.6 seconds and 1.2 to 1.5 seconds in the unit test, on a busier machine than the earlier figures were taken on. In the app the import took 4.9 seconds on the production build and 3.4 seconds on the packaged app, in one run each.

### Findings from the first real export (2026-11-13)

The owner's tree was exported from Ancestry (export version 2025.08: 162 people, 48 families, 90 sources, 79 media records, 10,038 lines) and run through the import and the export. The file itself is not in the repository and must never be.

- **It imports with nothing to report and exports line for line,** after one fix. The import made 711 events, 687 citations with 1,378 links, and 79 pictures and documents, in 0.3 seconds.
- **Ancestry writes `1 FILE` with no value.** No media record of the file names a file or a web address. The export took the empty value for "added in the app" and wrote a name of its own making, which changed 79 lines. It now leaves the FILE line of every imported record as written unless the file goes along in an archive.
- **So "Find the files in a folder" cannot find anything for an Ancestry tree:** there is no name to look for. Only "Choose the file" works, one picture at a time. The title is the only handle (`2 TITL` under `1 FILE`), and Ancestry's downloads are not known to be named after it. To be designed: matching by title, or by the size and dimensions the record gives (`_SIZE`, `_WDTH`, `_HGHT`).
- **Ancestry's description of a picture is `1 _DSCR`,** not a note, in 33 of 79 records; it is kept as written and not shown. A date and a place of the picture (`1 DATE`, `1 PLAC`) are also kept and not shown. Seven records give a web address under `1 _ORIG` / `2 _URL`, which is where the picture came from, not the file.
- **Under a person, a media line carries `_PRIM Y` (21 of 79) and a cropping (`_CROP`, 5).** This is the portrait the plan lacks; it is kept and not shown.
- **There is not one note on a person, an event or a family.** The only notes are in source records (85 of 90), most of them long. Part 2d should start from the note of a source.
- **Ancestry writes a marriage or divorce under a person** (`1 MARR` under `INDI`, 7 times; `1 DIV`, 3 times) as well as under the family. These ten are not events; they are kept as written and show as GEDCOM text on the person's page.
- **Places are plain text of one to five parts** separated by commas (of 787 place values, 277 have three parts, 260 four and 93 one), as the gazetteer work assumed. One has eight.
- **Sources carry `_APID` everywhere,** `PUBL` with a date and a place under it, and one repository for all 90. Citations have `PAGE`, and sometimes `DATA` with a `WWW` line, which is the address of the record: 111 of them. Since part 3b a citation has a field for this address.
- **The file ends its lines with a line feed alone, and 16 values have a carriage return in them.** The export writes those 16 lines without it. It is one more case in which an export is not identical; the others are listed under "Phase 1c outcome".
- Not covered by one file: a large tree, a tree with living people marked private, and what Ancestry writes for notes, since this tree has none.

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
src/main/mediafiles.ts  Which file of the open tree an address of the media scheme stands for.
                      No Electron.
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

Sources follow the same split:

```
packages/core/src/gedcom/sources.ts   Reading and writing a source record and a citation, changing
                                      as few of the original lines as possible.
packages/db/src/sources.ts            Sources and citations: adding, editing, citing a fact, lists.
packages/db/src/gedcom/citations.ts   Making citations of the SOUR lines of a file, for the import
                                      and for the upgrade of trees imported earlier.
```

So do pictures and documents:

```
packages/core/src/media.ts   Telling the kind of a file from its first bytes, which kinds the app
                             shows itself, which it may hand to another program, and where a file
                             is kept inside the media folder.
packages/db/src/media.ts     Copying a file into the tree, attaching it, the lists, deleting.
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
Since part 3a a shared HTTP client (`packages/connectors/src/http.ts`) enforces
those values: it counts the requests to each host, honours `Retry-After`, keeps
answers in memory for the manifest's lifetime, and sends a User-Agent that names
the app. A connector gets a client bound to its manifest, never `fetch`. The
plan first named ETags; no source built so far sends them for a search. The
interface below is the plan; part 3a built `searchPersons`
(`packages/connectors/src/connector.ts`). Connectors implement:

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

| Source                                           | Provides                                                         | Access                                                                                                                                | Status     |
| ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| WikiTree                                         | Collaborative tree profiles, ancestors, descendants              | No key. Send `appId`. 200 requests/min. Read-only; edits go through the site                                                          | Verified   |
| Library of Congress / Chronicling America        | Full-text US newspapers, maps, photos                            | loc.gov JSON API, no key. 20 requests/min, one-hour block if exceeded. Legacy API retired 2025. Queries over 100,000 results rejected | Verified   |
| NARA Catalog API v2                              | Military, immigration, naturalization descriptions and scans     | Free key by email, sent in `x-api-key`. 10,000 queries/month per key                                                                  | Verified   |
| Open Archives                                    | Dutch and Belgian civil and church records                       | No key. 4 requests/sec. Match endpoint by name and birth year                                                                         | Verified   |
| Wikidata                                         | Notable people, family links, cross-site IDs                     | SPARQL, CC0, no key                                                                                                                   | To confirm |
| Internet Archive                                 | City directories, county histories, yearbooks, census film scans | Free search and metadata APIs                                                                                                         | To confirm |
| Geni, DPLA, Europeana, Trove, DigitalNZ, Gallica | World tree profiles; regional newspapers and archives            | Free app key each                                                                                                                     | To confirm |

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

Built in part 3b for the first two (`packages/connectors/src/links.ts`); the
others are planned. The form of each site's search address was taken from what
is publicly written about it and has not been tried against the site.

## 5. Data model

A tree is one portable folder: a SQLite file (`tree.db`), a `backups` folder, and since part 2b a `media` folder that holds each picture and document under the SHA-256 of its contents (`media/ab/ab12….jpg`).

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

Built, in schema version 4 (`packages/db/src/schema/004-sources.ts`):

```sql
source(id, title, author, publication, abbreviation, text, created_at, updated_at)
citation(id, source_id, page, text, quality, note, created_at, updated_at)
  -- quality: 0 unreliable, 1 questionable, 2 secondary, 3 direct and primary; NULL not stated
citation_link(id, citation_id, person_id, family_id, event_id, name_id, sort_order)
  -- exactly one of the four is set: what the citation supports
gedcom_record.kind gains 'source': the record a source was imported from, under the source's id
```

All three are in the change log. A source's repository, its web address and the
date it was consulted are not columns yet: the first is kept as written from an
imported file, and the other two wait for the clip form of Phase 3.

Built, in schema version 5 (`packages/db/src/schema/005-media.ts`):

```sql
media(id, sha256, ext, mime, size, file_name, title, description, created_at, updated_at)
  -- one file the tree holds; sha256 is unique, so the same file is one row however often it is added
  -- sha256 may be NULL, for a file the tree knows of but does not hold; nothing makes such rows yet
media_link(id, media_id, person_id, family_id, event_id, citation_id, source_id, sort_order)
  -- exactly one of the five is set: what the file is attached to
```

Both are in the change log. The files themselves are not: a file in the media
folder is never changed or removed by an edit. The plan had a `rel_path` column
and a link by "type and id"; the path is worked out from the hash instead, and
the link has one column per kind of owner, as `citation_link` does. A region of
a picture (a face, one entry on a page) is not a column yet.

Changed in schema version 6 (`packages/db/src/schema/006-gedcom-media.ts`):

```sql
media gains: origin  -- where an imported GEDCOM file says the file is: a path or a web address
media.sha256         -- no longer unique; NULL for a file the tree knows of and does not hold
gedcom_record.kind   -- gains 'media': the record a file was imported from, under the file's id
gedcom_media(media_id, key)
  -- the file each media item written in place became, by its wording; written by an import only
```

`gedcom_media` is not in the change log, like `gedcom_record`: an import
writes it and no edit changes it.

Changed in schema version 7 (`packages/db/src/schema/007-notes.ts`):

```sql
person gains: note   -- the user's own remark, of any number of lines
event gains: note
source gains: note
gedcom_record.parts  -- a person's NOTE line carries the mark 'note'
```

Added in schema version 8 (`packages/db/src/schema/008-places.ts`):

```sql
place(id, text UNIQUE, geonames_id, name, lat, lon, created_at, updated_at)
  -- text: a place as typed in events, compared without regard to case
  -- name, lat, lon: a copy of the gazetteer entry the text is linked to
index on event(place_text)                                   -- for the list of a tree's places
```

Changed in schema version 9 (`packages/db/src/schema/009-citation-addresses.ts`):

```sql
citation gains: url, accessed_at   -- the address of the record; the day it was consulted, YYYY-MM-DD
source gains: connector_id         -- the site a source stands for; at most one source per site
```

The gazetteer is not part of a tree. It is one SQLite file of its own in the
profile folder (`gazetteer\geonames.db`, built by `packages/db/src/gazetteer.ts`):

```sql
place(geonameid, name, lat, lon, fclass, fcode, country, admin1, admin2, population)
place_name(folded, geonameid, alternate, population, country) -- every name, folded, in order
country(code, name)   admin1(code, name)   admin2(code, name)
meta(key, value)                                              -- places, built_at, countries
```

Planned, each added by a migration in the phase that first uses it:

```sql
source gains: repository_id, connector_id, url
citation gains: url, accessed_at, external_record_id
media_link gains: a region of the picture
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
if the hints of Phase 4 need to look names up by sound in the database. Sources
and citations got their tables in part 2a, and a migration made their rows for
trees imported earlier. Part 2b made the tables for files added in the app, and
part 2c fills them from imported files, with a migration for trees imported
earlier. Notes are still kept as written.

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
- **Places** keep the text as typed and only link to a standardized GeoNames entry. The user's text is never overwritten. The link belongs to the text, not to one event: every event with the same place shares it, and an event whose place is retyped follows its new text.
- **What the app has no fields for is kept as written.** Every line of an imported GEDCOM file is stored: a line that became a name, an event, a family link, a source, a citation or a file together with the id of what it became, and every other line (notes, repositories, other programs' own tags) exactly as it was. The export puts each line back in its place. A name, event, source, citation or file that was not edited since the import is written from its original lines; one that was edited gets only the edited lines rewritten.
- **A citation is one place in a source, and can support several facts.** It is linked to a person or a family as a whole, to an event, or to a name. Editing it changes it for every fact it supports. In a GEDCOM file it is written out under each of them.
- **A citation exists only while it supports something.** When its last link goes, the citation goes too, whether the user removed the link or deleted the event, name, person or family. GEDCOM has no place to write a citation that supports nothing, so such a citation would be lost in an export without anyone being told. The source stays, and Undo brings the citation back.
- **Deleting a source deletes its citations.** The app says how many before it does.
- **Not every SOUR line becomes a citation.** A source described in place with no record of its own (GEDCOM 5.5.1 allows this), a line that points at no record of the file, the second of two equal citations of one fact, and a citation under something other than a person, family, name or event stay as lines kept as written.
- **A file is copied into the tree, and the copy is never touched again.** Adding a picture or document copies it into the tree's media folder; the file that was chosen stays where it was. The copy is named after the SHA-256 of its contents, so adding the same file twice gives one file with one more attachment. No edit changes or removes a copy: deleting a file from the tree deletes its row only, so that Undo brings it back. Disk space is therefore not freed by the app yet.
- **A file can be attached to several things, and stays when it is attached to none.** A person or a family as a whole, an event, a citation and a source can each have files. Unlike a citation, a file that is attached to nothing is kept: it is worth keeping on its own, and "Media" on the tree screen lists it.
- **The page never names a file by its path.** The user picks files in the system dialog; from then on a file is known to the page by the id of its row. The main process works out the path from the row, and serves a picture only from the open tree's media folder.
- **Opening a file never runs it.** Only kinds on a fixed list (pictures, documents, sound, film) are handed to the program Windows opens them with. Any other file is shown in its folder.
- **A GEDCOM file names files; a GEDZip file holds them.** An import of a GEDCOM file makes a row for every picture and document it names, attached to what the file attaches it to, and holds none of them. An import of a GEDZip file (a zip archive with the GEDCOM file and the files it names) takes the files in as well. An export writes either: the GEDCOM file alone, or a GEDZip file with the files the tree holds.
- **A file is taken into a tree only from where the user says.** The path an imported file gives for a picture is shown and never opened. The files come from the archive the GEDCOM file came in, from one file the user chooses for one row, or from a folder the user has the app look in, where a file is found by its name and, among files of one name, by the folders at the end of the path the imported file gave. When two fit equally well, neither is taken.
- **A file keeps the name the imported file gave it.** A GEDCOM file written without the files gives the path or address it was imported with, so that an untouched import still exports line for line. A file that goes into an archive is named by its path there, and so is a file added in the app, which has no other name: `media/` and its file name, with only letters, digits, dots, dashes and underscores.
- **Not every OBJE line becomes a file.** A line that points at no media record of the file, a description that names no file, a media record without an id, and a media line under something other than a person, a family, an event, a citation or a source record stay as lines kept as written. Only the first file of a record that names several is the file; the other lines are kept.
- **An export says what it leaves out.** It says how many pictures and documents it names, how many of them it holds, and how many it left out because everything they are attached to was left out, as the pictures of people who may be living are. A picture attached to nothing is written.
- **An import makes a new tree.** A GEDCOM file is not merged into a tree that has people in it. The duplicate detection that needs exists since part 1d; bringing a file into an existing tree is still to be built.
- **Nothing is merged automatically.** The app lists pairs of people who may be one person, with a score and its reasons. Two records become one only when the user compares them and says so, and a pair the user marks as different people is not offered again.
- **A merge loses nothing but exact repeats.** The person kept receives the other record's names, events, parents, partners and children. A name or event is dropped only when the person kept already has it word for word and the imported file says nothing more about it. Two families with the same two partners become one. The whole merge is one undo step.
- **Some merges are refused**: a person with their own ancestor or descendant (they would become their own ancestor), and two people who are partners of each other.
- **Every write** goes through `change_log`, which provides undo and a per-person history. Database triggers do the recording, and they reject any write to a tree table that is not inside a change transaction (`Tree.transact`), so no code path can skip the log. The one exception is `Tree.load`, which fills a tree that has nobody in it (an import) without logging; what it loads is the tree's starting point and cannot be undone.
- **Exports leave out living people unless asked.** The export dialog starts on "leave out people who may be living". A person may be living unless they are marked deceased, have a death, burial, cremation or probate recorded, or took part in an event that certainly happened more than 110 years ago (`presumedLivingIds` in `packages/db/src/living.ts`). Someone with no dates at all counts as possibly living. A family with a living partner is written without its events and notes.
- **The primary name** is a flag on `person_name` with a unique index, not a column on `person`, which avoids two tables pointing at each other.
- **A person cannot be their own ancestor.** `addChild` and `setPartners` refuse a link that would create a loop, so charts can walk the tree without guarding against one.
- **A family that links nobody is removed.** When a person is deleted or unlinked, a family with nobody left in it goes, and a family with one person left goes unless it has events of its own.
- **Backups do not hold the pictures and documents.** A backup is a copy of `tree.db`. The media folder is not copied, because its files never change; a restored backup finds every file it names still in place. A file that is lost from the media folder is lost, so the whole tree folder has to be copied somewhere else to be safe.
- **Backups** are complete copies of `tree.db` in the `backups` folder inside the tree folder. One is written with SQLite's `VACUUM INTO` when a tree is closed or the app quits, if the tree changed since the newest backup. A copy is written under a temporary name, checked, and only then given its final name. Kept: the ten newest, then the last backup of each month for six months. Restoring a backup first backs up the present state.
- **Search** uses the FTS5 tokenizer `unicode61 remove_diacritics 2`, so "muller" finds "Müller". Triggers keep the index in step with the names, including during undo and redo.

## 6. Features by module

1. **Tree:** person and family editing; pedigree, descendant, hourglass and fan charts; relationship calculator; duplicate detection and merge. Built in parts 1b and 1d.
2. **GEDCOM:** import 5.5.1 (including ANSEL encoding and vendor tags from Ancestry, Family Tree Maker, RootsMagic, MyHeritage) and 7.0; export both. This is the migration path from Ancestry, whose export carries media links but not the media files. Built in part 1c. Part 2c added the pictures and documents a file names, and GEDZip (a GEDCOM file zipped together with its media), both ways.
3. **Sources and media:** citation management, a viewer with zoom, face-region tags, optional local OCR with `tesseract.js`. Sources and citations were built in part 2a, and the media store with its viewer in part 2b. The viewer shows files of the tree; record images served by an archive (IIIF) come with the search of Phase 3. Face regions and OCR are not built.
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
- **Each source must permit it.** A new manifest field, `mayShareWithAi`, says whether a source's record text may be sent to an AI service. It is false until that source's terms have been checked.
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

| Phase                       | Scope                                                                                                                                                                                                                     | Done when                                                                                                                                                                                                                               | Estimate  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0. Foundations              | Repo, monorepo, CI, packaging; connector manifests; access checklist                                                                                                                                                      | An installer builds and the packaged app opens a window. **Done 2026-11-11**                                                                                                                                                            | 1 week    |
| 1. Core tree                | Schema, editing, charts, own-tree search, GEDCOM both versions, undo, backups                                                                                                                                             | A 10,000-person Ancestry GEDCOM imports in under 10 seconds and round-trips with no diff. Met in part 1c on a file written in Ancestry's style; a real export is still to be tried                                                      | 3–4 weeks |
| 2. Sources, media, places   | Citations, media store and viewer, gazetteer, map, timeline                                                                                                                                                               | A scanned record can be attached, cited and viewed at full zoom. Met in part 2b on 2026-11-12, for a scan added in the app, and since part 2c for a scan a GEDZip file brings along; two parts are still to do, see "Phase 2 breakdown" | 2–3 weeks |
| 3. Federated search         | HTTP client; WikiTree, Wikidata, Library of Congress, Open Archives, NARA, Internet Archive; Tier C links and clip form                                                                                                   | A search returns grouped results and one click attaches a record as a citation                                                                                                                                                          | 3–4 weeks |
| 4. Hints                    | Matching engine, job scheduler, inbox, compare view                                                                                                                                                                       | Hints appear for an imported tree and precision is measured on a labelled test set                                                                                                                                                      | 2–3 weeks |
| 4b. AI assistant (optional) | Shared tool set; connector for Claude Desktop and Claude Code (route A); AI hints with quoted reasons; consent, masking of living people, activity log; then the API-key route (C). Route B only if Anthropic confirms it | From Claude Desktop, asking for records for one person puts proposals in the hints inbox, each with reasons quoted from the record, and precision is measured on the Phase 4 test set                                                   | 2–3 weeks |
| 5. Packs and more sources   | Pack manager, 1950 census index, Open Archives dumps; Geni, regional newspapers                                                                                                                                           | Packs install, search offline, and uninstall cleanly                                                                                                                                                                                    | 2–3 weeks |
| 6. Release                  | Reports, accessibility, app icon, auto-update, MSIX, Store submission, user docs                                                                                                                                          | Installable from the Store and GitHub Releases                                                                                                                                                                                          | 2 weeks   |
| 7. DNA and extras           | DNA tools; transcription of record images, locally or through the AI assistant                                                                                                                                            | Open-ended                                                                                                                                                                                                                              | —         |

### Phase 0 outcome

Delivered: git repository, pnpm monorepo, the four packages, strict TypeScript,
ESLint, Prettier, unit tests, end-to-end tests that run against both the
production build and the packaged app, an NSIS installer, a CI workflow, eight
connector manifests, and [ACCESS.md](ACCESS.md).

Not done, and why:

- **Keys** (NARA and others) need the owner's own accounts. The owner has a NARA key since 2026-11-13. The FamilySearch application was submitted on 2026-11-11 and answered on 2026-11-13 without access. See [ACCESS.md](ACCESS.md).
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
- **Sources, notes and media have no screens.** They are kept and exported, and those lines that sit directly under a person are shown on that person's page as GEDCOM text. Lines kept under a name, an event or a family, and records of their own, are not shown anywhere yet. Sources and citations got their screens in part 2a.
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

### Phase 3 breakdown

| Part | Scope                                                                                                                                                       | Status              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 3a   | The HTTP client, the connector interface, the search for a person at WikiTree, the search window, and a check against WikiTree itself                       | **Done 2026-11-13** |
| 3b   | Attaching a result as a citation (a web address and the date consulted on a citation), the clip form, and the links to sites the app never fetches (Tier C) | **Done 2026-11-13** |
| 3c   | Library of Congress and Internet Archive: search by text, results that are not people                                                                       | Planned             |
| 3d   | Open Archives and Wikidata                                                                                                                                  | Planned             |
| 3e   | The National Archives catalog: the user's own key, kept through Windows data protection, and its monthly quota                                              | Planned             |

Attaching comes second, so that the phase's test ("a search returns grouped
results and one click attaches a record as a citation") is met with one source
before more are added. Sources that need a key come last. Three views were asked
for on the split and on part 3a (the primary, an Opus helper and a Codex helper);
they agreed on this order, except that Codex put the Tier C links last.

### Phase 3b outcome: attaching a result, the clip form and links to other sites (2026-11-13)

With this part the phase's test is met for one source: a search returns results
grouped by source, and one click attaches a record as a citation.

Delivered:

- **A citation has a web address and the day it was consulted** (schema version 9). The citation form has a field for each, and a citation shows them; an https address opens in the browser, any other is shown as text.
- **Both in GEDCOM files.** The address is the first `WWW` line under a citation's `DATA` line, which is where Ancestry writes the address of a record. A new address is written the same way in a 5.5.1 file and as `_WWW` in a 7.0 file. The day is a line `_RULZ_ACCESSED` under the citation. An untouched import still exports line for line.
- **Trees imported earlier are upgraded:** their addresses are read from the lines the tree kept, and the result is the same as a fresh import of the same file. The upgrade is not an edit, and undoing a deletion made before it brings the citation back with its address.
- **"Attach as a source" on a result.** One click cites the record for the person as a whole: the source is the site, and the citation holds the title and key of the record, its birth and death as the site gives them, its address and today's date. It is one undo step. A result whose address the person's page already cites says "Attached as a source", also at the next search.
- **One source per site.** A source the app makes for a site is marked with the site (`source.connector_id`) and used for every record of it, also after the user renames it.
- **Links to sites the app never fetches:** Find a Grave and the record search of FamilySearch. A button opens a search for the four fields of the form in the user's browser.
- **The clip form.** "Cite a page you found there" is the citation form with the site as its source and today as the day; the user pastes the address. "Cite a page of another site" does the same for any source. The app never asks for the page.

Decided while building:

- **The page only names a result.** To attach, the page sends the person, the source and the key of the result. The main process cites what it read from the source itself, and only a result it showed for that person since the tree was opened, whose address is https and on the site of the source.
- **A link opened in the browser counts as sending.** The address holds the name and the years, so it needs the notice to have been agreed and is refused for a person who may be living, like a search. The notice now names these sites and says that the site and the browser's history hold what was searched.
- **The file that builds the links cannot fetch.** It does not import the HTTP client, a test checks that, and the client refuses a link-only source.
- **A pasted address is checked, not changed.** It must be an http or https address of at most 2,048 characters, without a user name, spaces or characters that cannot be seen. It is stored as typed. An address that came with an imported file is kept whatever it is, as long as it is not edited.
- **The day is a day, in the user's own time zone,** and is stored as `YYYY-MM-DD`.
- **A source of the tree stands in for a site only when both its title and its publication are the site's.** A GEDCOM file keeps no mark, so this is how the app's own source is found again after a round trip through one. A source of the user that only shares the title is left alone, and the app makes its own beside it.

Found by the reviews, and what was done. OpenAI Codex and a Claude Opus subagent each gave a view on the design before it was built and reviewed the result, without seeing each other's findings. Each finding was checked against the code.

- **The upgrade missed a tag written in small letters** (Codex), which a fresh import reads. Fixed, with a test.
- **Emptying an address brought a second one forward** (Codex) when a citation had two `WWW` lines. Emptying now removes them all; changing the first leaves the second as written.
- **A source that only shared a site's title was taken for the site** (both). First left as the design views had it, then changed when the second review named the same risk: title and publication must both match.
- **A search that answered after its tree had closed was still remembered** (Opus). Its answer is dropped now. No test reaches this: the search is also cancelled when the tree closes.
- **A day that does not exist emptied the stored day without a word** (Opus), when a page sent one. It is refused now.
- **Characters that cannot be seen were allowed in an address** (Opus), and can make it read as another. Refused now. An address written `HTTPS://` was shown as text; it is a link now.
- **`WWW` under `DATA` is not in the GEDCOM 5.5.1 standard** (Opus). Left: it is what Ancestry writes, so it is what other programs are most likely to read. A program that drops lines it does not know loses the address.
- **Not verified:** whether the browser engine inside the app opens a connection to a site when a link to it is pressed, before the link is handed to the user's browser (Opus, unsure). No request is sent either way.

Turned down from the design views: removing tracking parts from a pasted address (it can break the address), tables for the records themselves (the citation holds what it cites), a new version of the notice (part 3a was never released), and blocking the two sites in the search's network session (it could not be tested without asking them).

Tests: unit tests went from 911 to 960, end-to-end tests from 36 to 37.

Not done:

- **The other link-only sites** of the list in section 4.
- **The search addresses were not tried against Find a Grave and FamilySearch.** The app must not ask them, and neither did the build. If a site changes its search page, the link opens the page without the fields filled in.
- **Attaching to one event.** A result is cited for the person as a whole; the citation can be linked to more facts afterwards, as any citation.
- **Taking facts over from a result** into the tree. The citation records them as text.
- **Merging two sources.** A source of the user with a site's title and the app's own stay two.
- **A note in a GEDCOM 7.0 file's header that declares `_WWW` and `_RULZ_ACCESSED`,** and a rule for them when a file is converted between versions.

### Phase 3a outcome: the search for records, and WikiTree (2026-11-13)

Delivered:

- **"Search records" on a person's page.** The window starts with the person's given name, last name and years of birth and death, each of which can be changed or emptied. "Search" sends them to WikiTree. Results come twenty at a time, under the source's name and credit, each with its name, sex, birth and death, and a link that opens the profile at WikiTree in the browser. "More results" asks for the next twenty.
- **A notice before the first search.** It says what is sent, to whom, when, and what is kept. Nothing is sent before the user has agreed; the agreement is kept in the app's settings.
- **No search for a person who may be living.** The rule is the one of the exports (`presumedLivingIds`). The window says so and offers no form, and the main process refuses whatever a page asks.
- **The HTTP client.** It asks only the address of a source's manifest, over HTTPS, without cookies, without a cache on disk and without following an answer that points elsewhere. It never sends more requests to a host than the manifest allows within any span of the manifest's length. When a source answers "too many requests" it is left alone for as long as it asks, or the manifest's own pause (`pauseSeconds`, an hour for the Library of Congress), and at most a day. A request has 20 seconds, and an answer 2 MB.
- **The WikiTree connector** (`searchPerson`, read from WikiTree's documentation and tried against the service). It asks for sixteen fields and reads each with care: only a profile that WikiTree calls public or open and not living is shown, and the rest is counted as "not shown".
- **A check against WikiTree itself,** `pnpm test:contract`, run every Monday by `.github/workflows/contract.yml` and not as part of CI. It sends one search for a writer who died in 1910 and looks at the shape of the answer.

Decided while building:

- **Nothing is sent without a press.** Not while typing, not in the background. The form shows what will be sent.
- **A year, not a date.** The search sends the years of birth and death and lets a record lie two years to either side. A date of the tree that spans several years gives the year in their middle; one that is open to one side gives none.
- **The gate looks at the person, not at the words.** What the user types into the form is theirs to send, as in a browser. The form is never filled in for a person who may be living. A search without a person of the tree is not offered in this part.
- **Results are not kept.** They live in the memory of the main process until the tree closes, by the lifetime of the manifest at most. There is no table for them; the citation of part 3b will hold what it cites.
- **A session of its own.** The search asks through an Electron session that lives in memory only, so that no cookie and no answer reaches the disk.
- **Everything a source sends is untrusted.** Texts are shown as text, cut to 200 characters and cleared of control characters. The link of a result is made by the app from the profile's id and always lies on wikitree.com.
- **Where the code lives.** The shapes (`PersonQuery`, `Page`, `ExternalRecord`) are in `packages/core/src/records.ts`; the client and the connector in `packages/connectors`; the rules (notice, living people, one search per source at a time) in `apps/desktop/src/main/records.ts`.

Found by the reviews, and what was done. Two helpers reviewed the change without seeing each other's findings: OpenAI Codex and a Claude Opus subagent. Each finding was checked against the code.

- **A private profile was hidden only because it comes without fields** (both). WikiTree's own privacy level is now asked for, and only public and open profiles are shown.
- **Cookies and answers could reach the disk** (Opus). Electron's own network session keeps both. The search now has a session in memory, sends no cookie and asks for no caching.
- **A path could leave the address of a source** (Codex): "%2e%2e" is ".." to a server, and "/api.php-other" passed for a path below "/api.php". Both are refused now.
- **A search could be sent after the person became possibly living** (Codex), while it waited for its turn. The rule is looked at again just before the request goes out.
- **Opening another tree kept what was found for the first** (Opus). Only closing a tree by hand cleared it. Every way of leaving a tree now does.
- **A shorter pause could replace a longer one** (Codex), and a source could ask for a pause of nothing (Opus). The longest pause stands, and a pause lasts the span of the limit at least.
- **A search that was given up still waited in the queue** (both), and one given up could still be kept as an answer (both). Fixed.
- **Closing the window did not stop a search** (Opus). It does now.
- **A profile that came twice was shown twice** (Opus). Once now.
- **A pause longer than a day is cut to a day** (Codex wanted it honoured in full). Left: a source that is mistaken or hostile must not shut the search for good.
- **Any HTTPS link of a result would open** (Opus): the rule that links stay on the source's site is kept by the connector alone. Left; the window's link handler is the app's general one.
- **Who may be living is worked out for the whole tree at each search** (Opus). Left; it takes milliseconds on the trees tried.
- **Not tested:** that Electron itself refuses a redirect and sends the User-Agent the client gives. The unit tests check that both are asked for.

Tests: unit tests went from 856 to 911, end-to-end tests from 34 to 36. The end-to-end tests answer in WikiTree's place and fail on any other request.

Not done:

- **Attaching a result to the tree.** Done in part 3b.
- **Any source but WikiTree.**
- **A search without a person,** and a search by place.
- **A pause that outlasts the app.** A source's pause is forgotten when the app closes. It matters for the Library of Congress, in part 3c.
- **Signing in to WikiTree,** which would show private profiles the user is trusted with.
- **Relatives of a result,** and the reading of one record in full.

### Phase 2 breakdown

| Part | Scope                                                                                                                                      | Status              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| 2a   | Sources and citations: tables, the screens to add, cite, edit and remove them, GEDCOM both ways, and the upgrade of trees imported earlier | **Done 2026-11-12** |
| 2b   | Media: a store inside the tree folder, attaching a file to a person, a family, an event, a citation or a source, and a viewer with zoom    | **Done 2026-11-12** |
| 2c   | Media in GEDCOM files: reading media records and the lines that point at them, writing both, the upgrade of trees imported earlier, GEDZip | **Done 2026-11-12** |
| 2d   | Notes and places: notes as fields, a place table, the gazetteer and place suggestions while typing                                         | **Done 2026-11-13** |
| 2e   | Map of a person's events, and the life timeline                                                                                            | **Done 2026-11-13** |

The phase's test ("a scanned record can be attached, cited and viewed at full
zoom") is met by parts 2a and 2b for a scan added in the app. Part 2b was first
planned to include GEDCOM media records and GEDZip. They became part 2c: the
store, the screens and the viewer are useful on their own, and reading media
records needs the same three things together as sources did (an import, a
migration for trees imported earlier, and a test that the two agree). With
part 2c a scan that comes with an imported tree is attached, cited and viewed
in the same way. Two
things decided how 2d and 2e are built and needed the owner. The first was
decided on 2026-11-13 and built the same day: the GeoNames gazetteer is
downloaded by the user on first use, not shipped with the app. The second was
where map tiles come from, since free tile servers limit how an app may use
them. It was decided on 2026-11-13 too: there are none. The map is drawn from
outlines the app ships with.

### Phase 2e outcome: the timeline and the map (2026-11-13)

The last part of Phase 2.

Delivered:

- **A timeline on a person's page.** "Timeline and map" tells the life in order: the person's own events, the events of the couples they are one of, and what happened close to them while they lived, which is the births of their brothers, sisters and children and the deaths of their parents, partners, brothers, sisters and children. Each line gives the date as typed, how old the person was, what happened, to whom (a name that leads to that person's page) and where. A tick box takes the births and deaths in the family away.
- **The age is as sure as the dates.** Two full dates give "age 23". A date that names only a year gives "age 22 or 23", and a period gives "age 20 to 45". An open-ended date ("before 1850") gives none, and neither does an age beyond 125 years.
- **Events without a date stand apart,** under "Date not known". They are not guessed into place.
- **A map of the life.** Every place of the timeline that is linked to the place list gets a numbered mark, and the same number stands beside the place in the timeline. Several events at one place share a mark. Under the map each mark is listed with the place as typed, the entry it is linked to when that reads differently, and its events. A press on a number in the timeline or the list picks its mark out.
- **Places that lie apart can be looked at alone.** Marks more than 700 km from each other form groups; with more than one group the map has a button for each ("Around York") beside "Everything". "Zoom in" and "Zoom out" change the scale, and a press on a number in the list puts that place in the middle.
- **Places without a link are named,** in a line under the map that says how many there are and that "Places" links them.
- **The outlines.** Every country, and the states, provinces and counties of the United States, Canada, the Netherlands, the United Kingdom, Ireland, Australia and New Zealand, each named on the map where it is drawn large enough. The file is 618 KB and is read when a map is first shown.

Decided while building:

- **No map tiles.** Three views were asked for (Opus, Codex and Grok helpers), and all three and the primary came to the same: outlines that ship with the app. A tile server learns which area is being looked at, and where a family lived is private; OpenStreetMap's own servers are not offered as the background of a distributed app; a downloadable detailed map is tens of megabytes at least and much code. The owner chose the outlines. They say in which state or county a place lies, not on which road.
- **Natural Earth, public domain** (confirmed from its own licence text, tag v5.1.2). No credit is required; the map gives one all the same. Countries come from its 1:50 million set. The seven divided countries come from the states and provinces of its 1:10 million set and are left out of the country layer, so that their coast is drawn once. `tools/build-map.mjs` builds the file: it keeps 30% of the points and stores them on a grid of 20,000 steps. The file is committed; the two source files are not.
- **Drawn in SVG with d3-geo,** not MapLibre GL as the plan had it. A map of three to thirty marks needs no tiles and no WebGL, and SVG stays within the content security policy. A frame up to 110 degrees wide is drawn in Mercator, which keeps shapes as people know them; a wider one in Equal Earth, because Mercator swells the north.
- **The frame goes the short way round the earth,** so New Zealand and Hawaii are framed across the Pacific. One place, or places close together, get a frame about the size of a state, since a smaller one shows a blank shape.
- **Where the logic lives.** Ages, grouping and framing are plain functions in `packages/core` (`life.ts`, `map.ts`) with tests of their own. `getPersonLife` in `packages/db` reads the life in one transaction. The page asks for it with one call, `getPersonLife`, apart from the person's page itself.
- **A relative's event counts when it has a date within the person's life.** The life runs from the first day the birth can mean to the last day the death can mean; where one is not known, that side is open. Someone who is two things to the person is told of once.
- **No line is drawn between the marks.** The order of the events is known, the roads taken are not.
- **Nothing new is shown of living people.** Every event of the timeline was already on the person's page or on the page of the relative it names.

Tried on the owner's real export from Ancestry, with its places linked as in part 2d: 158 of 162 people have a map, with at most 17 marks and at most three groups; two people's frames are wide enough for Equal Earth. Reading a life took at most 2 ms. Only counts were taken from it.

Changed from before:

- **Four new development dependencies:** `d3-geo` and `topojson-client` in the app, and `topojson-server` and `topojson-simplify` for the build script.
- **The page's script grew by a second file** of 640 KB with the outlines, loaded on demand.
- **Tests.** Unit tests went from 830 to 856. End-to-end tests are still 34; the places test now also checks the timeline, the map, its groups and that the map asks nothing of the internet, in the built and in the packaged app.

Found by the reviews, and what was done:

Two helpers reviewed the change without seeing each other's findings or the primary's opinion of it: OpenAI Codex and a Claude Opus subagent. Each finding was checked against the code before it was acted on. Opus read the files while Codex's findings were being fixed, and confirmed four of those fixes.

- **A birth "before 1900" shut out what happened before 1900** (Codex). The life was taken to start on the last day the birth can mean. It now starts on the first, and a date without a first day leaves that side open; the same for a death "after 1900".
- **A relative's event was judged by one day of its date** (Codex). A brother born "between 1899 and 1901" was left out of the life of someone born in 1900. An event is now left out only when its whole date lies before the life or after it.
- **Enlarging the map could push a mark off it** (Codex). The map was put back on the middle of its frame in degrees, which is not the middle of the drawing: a projection does not space latitudes evenly. It now keeps the drawing as fitted and enlarges about its middle.
- **A place near a pole was framed without its mark** (Codex). The frame stopped at 84 degrees and the mark was drawn where it lies. The frame now reaches 89 degrees, and one that goes beyond 78 is drawn in Equal Earth, which has room there. Opus ran the framing against twelve sets of places, the South Pole, Svalbard and a pair across the 180th meridian among them, and every mark stayed in the drawing.
- **A mark stayed picked out by its number after an edit** (Codex), so that the number pointed at another place. It is now kept by its point, and the map starts afresh when the places change.
- **180 degrees east and west gave two marks at one point** (Codex). They are one now.
- **A number in the timeline could pick out a mark that was not in view** (Opus), with the map on one group or enlarged; nothing seemed to happen. The map now goes back to showing every place.
- **A brother born in the same year came before the person's own birth** (Opus), with "age 0". The person's birth now comes before anything of the family, when its first day is known.
- **Three groups of small islands were missing from the map** (Opus): the Cocos Islands, Christmas Island and Tokelau. The build script left out a country by one code and took its divisions by another. Both layers now go by the same code.
- **Borders are drawn twice where the two scales meet** (Opus): a divided country comes from the 1:10 million set and its neighbour from the 1:50 million, so the United States and Mexico each draw their side. True, and seen only when much enlarged. Left as it is.
- **Marks that lie on top of each other take one press between them,** and a mark cannot be reached with the keyboard (Opus). True. The list under the map has a button for every mark. Left as it is.
- **The list's button stays pressed on a second press** (Opus). It shows the place; it is not a switch. Left as it is.
- **The page now shows the dates and places of relatives' births and deaths** (Opus), which before stood only on their own pages. Nothing leaves the PC and no export changes. Noted for the owner.
- **The choice of projection and the fitting have no unit test** (Opus). They live in the page's own file with the drawing. The end-to-end test covers a wide frame, a narrow one and the marks in each; the rest was checked by Opus's script. Still to do.
- Codex could not run the unit tests in its sandbox (\`spawn EPERM\`); its findings came from reading and from running single functions. Each was confirmed here with a test.

Not done:

- **Roads, towns, rivers and hills** on the map. Only borders and coasts.
- **Borders of the time.** The outlines are today's.
- **Dragging the map.** It is moved by the buttons and by picking a place.
- **A map of a whole tree,** of a family, or of the way a family moved.
- **The counties of the United States,** and divisions of countries other than the seven.
- **Printing or saving** the timeline or the map.
- **Events of grandparents, grandchildren and in-laws,** and events of the world, in the timeline.
- **How sure a mark is.** A place linked to a county is marked in the middle of the county, and the map does not show that apart from a town; the list under it names the entry.
- **Names on the map can still crowd** where many small shapes meet, and a name is written in the middle of what is drawn of its shape.

### Phase 2d outcome: places (2026-11-13)

The second half of part 2d. With it the part is done.

Delivered:

- **A list of the world's places, downloaded when the user asks.** "Places" on the tree screen says what the list is, how large the download is and where it comes from, and has the button. The app fetches ten files from GeoNames, about 100 MB: three lists of the names of countries and their divisions; every town, village, township and county of the six countries of the region priority; and the towns of 500 people and more of the rest of the world. From them it builds one file of 76 MB that holds 550,187 places. On the development PC the download took 7 seconds and the build 14. The list can be downloaded again and removed.
- **Places offered while typing,** in the place field of the event form and of the forms that add a person. The places the tree already has come first, with how many events give each; then places from the list. The arrow keys move through them, Enter takes one, Escape puts them away. The tree's own places are offered before anything is downloaded.
- **Finding a place in the list.** The name is looked up by its start, without regard to case, accents and punctuation. Text after a comma narrows it to a county, a state or a country: "Springfield, Ill", "York, England", "Kinsale, Co. Cork". A place is also found by its other names ("Bombay", "Den Haag") and without the words that say what it is ("Sangamon" for Sangamon County, "Monroe" for Township of Monroe). When a whole text finds nothing, the text after its first comma is tried, up to three times, because many places in family trees start with a ward, a church or a street, or with nothing.
- **Linking a place.** A place picked from the list while typing is linked in the same undo step as the event. The "Places" window lists every place of the tree with the number of events at it and, for a place without a link, the entry that fits best ("Perhaps: …") with a button that links it. A county or a state that was found only by leaving out the start of the text is not offered this way. Another entry can be looked for by hand, and a link can be taken away. The list can be searched and narrowed to the places without a link.
- **A linked place knows where it lies; its text does not change.** The tree keeps a copy of the entry's name and coordinates, so a tree that is copied to a computer without the list still has them. This is what part 2e draws its map from.
- **Tried on the owner's real export from Ancestry:** it imports with nothing to report and exports with no line changed, as before. Its events give 260 different places. For 255 of them a search of the list finds an entry; the other five are not places of a kind the list holds, or are not spelt as the list spells them. 243 are offered an entry with a button, and for 12 the entry found is a county or a state that has to be picked by hand. With every one of the 243 linked, the export is still the same, line for line.
- **Tests.** Unit tests went from 709 to 830 and end-to-end tests from 33 to 34. The end-to-end test drives the built app through a failed download, a download, the offers and the links, with the app's requests answered from sample files; it never reaches GeoNames.

Decided while building:

- **The link is kept by the text of the place, not by a column on the event.** The plan had `event.place_id`. Three views were asked for before building. Two (the primary's and the Opus helper's) preferred the text: one link then covers every event at that place, which matters for a tree with hundreds of imported places; editing an event, merging people and Undo need no code for places; and the migration writes no rows, so an upgraded tree and a fresh import cannot differ. The Codex helper preferred a link on each event, because one text can mean two places ("Springfield"). That case is real but rare, the answer is to write the place more fully, and a link on one event can be added later without undoing this.
- **No hierarchy of places in the tree** (`parent_id`). The list has the hierarchy in its own codes, and the map needs coordinates only.
- **Which files.** The world file (`allCountries.zip`, 420 MB) would be four times the download for places few users need; the towns file alone (`cities500.zip`) lacks the hamlets and townships family history is full of. Of each country file only two of GeoNames' classes are kept: where people live (P) and countries and their divisions (A). Streams, hills, schools and cemeteries are left out.
- **Other names in Latin letters only.** GeoNames lists each place's names in every script. Keeping only those a user here can type halves the file.
- **A plain index over the folded names, not the full-text index** the tree search uses. A place is looked up by the start of its whole name, which a sorted index answers directly; the full-text index matches single words. On the real list a search for a name took at most 16 ms, and one narrowed by a region, which weighs up to 8,000 names, about 60 ms.
- **How a place is written.** As family historians write it and as Ancestry does: town, county, state, "USA" for the United States; town, county, and England, Scotland, Wales or Northern Ireland for the United Kingdom, without the kingdom; town and county for Ireland; town, province or state, and country elsewhere. This is only the text put in the field when an entry is picked; the user can change it.
- **Order of the offers.** The whole name typed comes before a name that only starts with it. After that count the number of people who live there, whether the name is the place's main one, and whether the country is one of the region priority. A town comes before the county or municipality named after it. The weights were set by hand against some forty searches on the real list and are not measured against anything.
- **The download is made safe by what it refuses.** The addresses are fixed in the code: one host, ten file names. A file larger than its limit is given up, whether the server announces the size or not; so is a download from which nothing arrives for a minute, an answer that points to another address (no redirect is followed), an archive whose checksum is wrong, a list with a line of more than 100,000 characters, and a result of fewer than 100,000 places or with a list of names cut short. The new file is built beside the old one and put in its place only when it is complete; when anything fails the old one stays in use and nothing is left behind. GeoNames publishes no checksums of its files, so that the files are GeoNames' own rests on the HTTPS connection alone.
- **The list is built in the main process, a piece at a time.** Each piece of the archive is unpacked, read and written, and then other work gets its turn. The slowest answer of the main process during a build was 0.6 seconds, at the very end. A worker thread was not needed.
- **GeoNames' licence was confirmed** from its own readme on 2026-11-13: Creative Commons Attribution 4.0. The credit, with links to GeoNames and to the licence, stands in the "Places" window, and each offered place says "From GeoNames".
- **GEDCOM is left alone.** A link is not written to a GEDCOM file and not read from one. Coordinates a file gives under a place (`MAP`, `LATI`, `LONG`) stay lines kept as written, as before.

Changed from before:

- **The tree schema is at version 8.** An earlier build cannot open a tree once this build has opened it; a copy is put in the backups folder first. The upgrade adds a table and an index and changes no row.
- **The app now asks something of the internet,** for the first time: the ten files, from one host, when the user presses "Download the place list" or "Download again", and at no other time. It sends nothing about the user or the tree. Every other part of the app works without it.
- **The zip reader can hand out an entry piece by piece** (`ZipReader.stream`), so that a list of 350 MB is never in memory as a whole.

Found by the reviews, and what was done:

Two helpers reviewed the change without seeing each other's findings or the primary's opinion of it: a Claude Opus subagent and OpenAI Codex. Each finding was checked against the code, and where it was about speed against a measurement on the real list, before it was acted on. Neither found a way to lose data.

- **A redirect could have sent a request to another host** (Codex). The download followed redirects and checked afterwards where the file had come from, so the request to the other address had already been made. The request now refuses redirects outright. Checked in the built app: a redirect fails, and GeoNames' own files, which do not redirect, arrive.
- **Stopping the app in the moment a new list took the place of the old one lost the old one** (Codex). The old file had been renamed and nothing put it back. The next start now puts it back.
- **An archive with one endless line could have filled the memory** (Codex). The text of a list was gathered up until a line ended, up to the size limit of the whole list. A line of more than 100,000 characters now ends the build; GeoNames' longest is about 10,000. The limit for one unpacked list went from 2 GB to 1 GB.
- **A list of names that arrived cut short could have passed** (Codex). Only the number of places was checked. The lists of countries, of states and of counties now have a least number each (200, 3,000 and 30,000; the real lists hold 252, 3,865 and 47,753), and a build that falls short is thrown away with the old list kept.
- **Listing the places of a tree could keep the app from answering** (Opus). The list looked up the entry that fits best for each of its fifty places in one go. Measured on the real list, looking up a short name with a region took 90 ms, so a page of such places would have taken over four seconds; the owner's real tree took up to 0.2 seconds a page. The list now comes without the entries, and the window asks for them one place at a time and keeps what it was told. A look-up with a region also went from 90 ms to 60: the name of a county or a state is prepared once, not for every place in it, and a name that both of the search's queries bring is weighed once.
- **One press could tie a place to the middle of its state** (Opus). "St John's Church, Smallville, Kansas", with no Smallville in the list, was offered Kansas, because the search leaves out the start of a text that finds nothing. A county, a state or a country that was found only that way is no longer offered with a button; looking for the place by hand still finds it. A region written on its own, or after an empty place for the town (", Story, Iowa"), is offered as before. In the owner's real tree this takes the button from 12 of 255 places.
- **A new list that could not be opened stayed in the place of the list** (Opus), when there had been none before, and every later start reported it. It is now removed. No test covers exactly this: nothing in a test can make a complete file fail to open at that moment. A swap that fails a step earlier is covered, and keeps the old list in use.
- **A refused answer kept its connection** (Opus), until the program cleared it away by itself. It is now let go at once. An empty length in an answer's headers was also read as "nothing will arrive" and failed the download; it is now read as no length given.
- **Enter took an offer while a letter was being composed** (Opus), which matters to anyone who types with an input method. Keys that belong to composing are now left alone. Not covered by a test: the tests cannot compose a letter.
- **Finishing the build blocks the main process** (Codex, Opus). True, and measured on the real list: 0.6 seconds, once, at the end of a build. Opus expected several seconds from a made-up list; the real one does not bear that out. Left as it is.
- **Places that differ only in the case of a letter outside A to Z are two places** (Codex, Opus). True; SQLite sets the case alike for those 26 letters only. Left as it is: a test now states it, and it is listed under "Not done".
- **Closing the app during a build does not wait for the build to stop** (Opus). True. What the build leaves behind is cleared away at the next start, which a test covers. Left as it is.

Not done:

- **The map and the timeline** (part 2e). Built later the same day; see below.
- **Coordinates in GEDCOM files:** neither written for a linked place nor read from a file that has them. A tree that goes out as GEDCOM and comes back has lost its links.
- **A link for one event alone,** for a text that means two places.
- **Linking many places at once.** Each place is linked with one press, one at a time. A real tree of 260 places takes 243 presses, and 12 searches by hand.
- **A person's page does not show which places are linked.** Only the "Places" window does.
- **Changing how a place is written in every event at once.**
- **Other countries in full, and choosing the countries.** The six of the region priority are fixed in the code. Elsewhere only towns of 500 people and more are found.
- **Old names and old borders.** A place is found by an old name only where GeoNames lists it among its other names, and counties are those of today.
- **Churches, cemeteries, farms and streets** are not in the list.
- **Coordinates typed by hand,** for a place the list does not have. The table allows for them; no screen does.
- **Places are not in the tree search.**
- **The order of the offers takes no account of the tree:** a tree whose places all lie in one state is still offered a larger town of the same name in another state first.
- **The download shows the bytes so far, not how far it is,** and a download that was cut short starts again from the beginning. Nothing says when GeoNames has a newer list.
- **The offers can cover the buttons under a field** at the foot of a form, until one is taken or Escape is pressed.
- **A place text of more than 500 characters,** which only an imported file can hold, is listed but cannot be linked.
- **Texts that differ only in the case of letters outside English** ("Ö" and "ö") are two places; SQLite folds the case of the English letters only.
- **Not tried:** a slow or broken connection other than in tests, a proxy, and a second Windows PC. The real download was done once, through the built app, before the review. The packaged app ran the tests for places, notes and the basics on this PC, with sample files in place of GeoNames.

### Phase 2d outcome: notes (2026-11-13)

Part 2d was built in two halves. Notes came first, because the first real
export showed where its notes are (on 85 of 90 sources and nowhere else), and
because places wait on a download that has to be designed. Places are still
to do.

Delivered:

- **A note on a person, an event and a source.** A person's page has a "Note" section with the note's lines as typed and a form to add or change it. The event form and the source form each have a "Note" box; an event's note shows under its details. A citation and a picture already had a note.
- **GEDCOM.** The first NOTE line that holds its own text, under a person record, an event or a source record, is read as that note and written back. An untouched import still exports line for line; an edited note changes its own lines only; a cleared note takes its line away, with what stood under it. A note of a tree made in the app is written as a NOTE line and read back.
- **Trees imported earlier are upgraded** (schema version 7): their notes are filled in from the lines the tree kept, and the result is the same as a fresh import of the same file.
- **A merge keeps both notes.** The person who is left keeps their own note, or takes the other's when they have none, with the lines that stood under it. A second note that stands unchanged in the file the other person was imported from stays as a line kept as written, shown under "Other details from the imported file". Any other second note is joined to the first, with an empty line between.
- **An independent review of the change found three ways a note could be lost,** all in trees with merged people or with deletions made before the upgrade. Each is fixed and has a test: the lines under the note of a merged record, the note of an event or source brought back by Undo after the upgrade (the upgrade now writes the note into the change log too), and the notes of the events of a record that was merged before the upgrade.
- **Tried on the owner's real export from Ancestry:** 85 source notes became fields, the longest of 846 characters, and the file still exports with no line changed.
- **Tests.** Unit tests went from 681 to 709 and end-to-end tests from 32 to 33.

Decided while building:

- **One note per thing.** A second NOTE line stays as a line kept as written, and so does a pointer to a note record that several things share (`NOTE @N1@`, in 7.0 `SNOTE`). Showing those needs a list of notes and note records as rows; neither real file seen so far has them.
- **A note longer than 50,000 characters is cut in the tree and left whole in the file,** as long as it is not edited: the export writes the original lines back when the note is unchanged.
- **The NOTE line of a person carries a mark; the note of an event or a source does not.** The export reads those from the event's or the source's own lines, as it does a citation's note.
- **A person merged into another before the upgrade keeps their NOTE line as a kept line** of the person who is left. It is not joined into that person's note after the fact.

Changed from before:

- **The tree schema is at version 7.** An earlier build cannot open a tree once this build has opened it; a copy is put in the backups folder first.
- **A note no longer shows under "Other details from the imported file".** It shows in the "Note" section, and can be edited.
- **In GEDCOM 7.0 a description typed on an event such as a birth** is still written as a note under the event. Importing that file now shows it as the event's note, where before it showed with the kept lines.
- **Two events that differ only in their note are not repeats** when two people are merged.

Not done:

- **Places:** built later the same day; see "Phase 2d outcome: places".
- **A note whose whole text looks like a pointer** (`@X1@`) is written without the doubling of `@` that would mark it as text, and reads back as a pointer. This was already so for the note of a citation.
- **A person who was deleted before the upgrade and is brought back by Undo after it** has their note as a kept line, not as the note.
- **A family has no note field.** A note under a family record stays as a line kept as written, and is shown nowhere, as before.
- **A name has no note field,** nor does a media record beyond its description.
- **Notes are not in the search.**
- **The findings of the first real export are otherwise open:** matching Ancestry's pictures to files, showing its picture descriptions, the main picture of a person, and marriages written under a person. The web address of a record on a citation came with part 3b.
- **The upgrade from version 6 was tested on trees built by the tests,** not on a file saved by the earlier build.
- **The new fields were looked at in light colours only,** in screenshots of one window.

### Phase 2a outcome

Delivered:

- **Sources.** A "Sources" button on the tree screen lists every source with how often it is cited, and finds one by title or author. A source has a title, an author, where it was published or is kept, a short title and its own text. It can be added before anything cites it, edited in place and deleted.
- **Citations.** "Sources" beside every name and event on a person's page, and for a family and a person as a whole, lists what that fact rests on. A citation says where in the source (a page, a sheet, an entry), what it says there, how far it can be trusted, and a note. It is added with a source already in the tree or with a new source made in the same step.
- **One citation for several facts.** Where a source is already cited on the person's page, the form offers to use that citation again. The person's page lists each citation once with everything it supports ("Name, Birth, Residence"), and an edit changes it for all of them.
- **A source's page** lists its citations with the facts they support and the people concerned; a click on a name opens that person. It also shows the lines of an imported source the app has no fields for.
- **GEDCOM.** Source records and the lines that cite them are read into these tables and written back. An untouched import still exports line for line; an edited citation changes one line in each place it stands; a citation used for another fact is written there with the lines its first copy had; a new source gets the first free `S` number.
- **Trees imported before this part are upgraded** when they are opened: their sources, which were lines kept as written, become sources and citations exactly as a fresh import of the same file would make them. A copy of the tree is put in its backups folder first.
- **Merging and deleting.** A merge moves the citations of the record that goes to the person who is left. A name or event with a citation is never dropped as a repeat. Deleting a person, family, event or name removes its citations, and Undo brings them back.
- **Tests.** Unit tests went from 488 to 552 and end-to-end tests from 25 to 28.

Changed from earlier parts:

- **The tree schema is at version 4.** As before, an earlier build cannot open a tree once this build has opened it. New in this part: the tree is copied to its backups folder before it is upgraded.
- **An import report counts sources and citations**, and no longer counts source records among what is kept as written.
- **The person page lists citations as sources**, not as GEDCOM text under "Other details from the imported file". Lines under a name or an event that cite a source are now visible; before, they were shown nowhere.
- **The contract between the page and the main process has 51 functions,** ten more than before.

Not done, and why:

- **No repositories.** Where a source is held (an archive, a library, a website) is a record of its own in GEDCOM. That record is kept as written and exported, and shown nowhere; the source's page shows only the line that points at it, as GEDCOM text. A source added in the app has the "published or kept" field for it.
- **No web address or date consulted on a citation.** Both arrived with part 3b.
- **A citation cannot be moved to another source, and two sources cannot be merged.** A file that names one census under two source records keeps two sources.
- **A citation is only used again from the same person's page.** The form offers the citations already on the page; a citation of another person (the same household entry for a brother) has to be typed again, and then is a second citation.
- **Some source lines of a file are not citations:** a source described in place without a record, a line pointing at no record of the file, the second of two equal citations of one fact, and citations under notes, associations and other structures. They stay kept as written; those directly under a person show as GEDCOM text, the others are not shown.
- **What a citation carries beyond the four fields is not shown:** Ancestry's record number, a link to a picture, a note that is a record of its own, a second quotation. It is kept and exported.
- **Only the first title, author and so on of a source record is a field.** A second line of the same kind is kept as written. A title of several lines is read as one line, and written as one line once it is edited.
- **Citations that say the same in the modelled fields but differ in a line the app does not show are two citations** that look alike on screen.
- **The quality of a citation uses GEDCOM's four steps** (unreliable, questionable, secondary, direct and primary). It is one value per citation, not per fact, although a census can be good evidence for a residence and poor evidence for a year of birth.
- **Sources are found by a plain text match** on title, author and short title. The list shows the first 200; a source's page shows up to 200 of its citations, 50 at a time.
- **An upgrade cannot be undone from inside the app.** The backup made before it is in the tree's backups folder and opens in the earlier build; restoring it in this build upgrades it again.
- **The upgrade was tested on trees made by the current import with sources left out,** not on a tree file written by the earlier build itself. The schema of such a tree is made by the same three migrations, so the two should not differ, but no file from the earlier build was kept to prove it.
- **The new screens were checked by eye in light colours only,** at one window size.
- **Still no real export from Ancestry or any other program has been tried.** Source records are where programs differ most, so this matters more than it did.

### Phase 2b outcome

Delivered:

- **A media folder in every tree.** A picture or document that is added is copied into the `media` folder of the tree, under the SHA-256 of its contents. The file that was chosen stays where it was. The same file added again is not copied again; it is attached once more.
- **Files on a person's page.** A "Pictures and documents" section shows everything attached on the page as small pictures: the files of the person, of their events, of their families, and the scans of the citations on the page, each with a line saying what it belongs to. "Add pictures or documents" takes one or many files from the system dialog.
- **Files of an event, a family, a citation and a source.** "Files" beside every event and for a family lists and adds them. A citation shows its scans where it is listed for a fact and in its own form; a source has files of its own on its page.
- **A viewer with zoom.** A picture opens fitted to the window. It zooms with the buttons, the mouse wheel (at the pointer), the keyboard and a double-click, up to its real size and on to eight times that, and is moved by dragging. The viewer also holds the file's title and description, what it is attached to (with a "Remove" for each), and the buttons to open it in another program, show it in its folder, and delete it from the tree.
- **The list of every file.** "Media" on the tree screen lists the files of the whole tree, the one added last first, finds them by title, description or file name, and can show only those attached to nothing. Files can be added there without attaching them.
- **Documents.** Any kind of file can be added, up to 500 MB each and 100 at a time. The app draws JPEG, PNG, GIF, WebP, BMP and AVIF itself. Other files, PDF and TIFF included, get a small preview where Windows can make one, and are opened in the program Windows uses for them. A file whose kind could run is kept and shown in its folder, and never opened.
- **Undo, merging and deleting.** Adding, attaching, removing and deleting files and editing their details are undo steps; several files added in one go are one step. A merge moves the files of the record that goes to the one that is left, and an event with a file attached is never dropped as a repeat. Deleting a person, event, citation or source leaves its files in the tree, attached to nothing.
- **A file that has gone** from the media folder is shown as missing, and adding the same file again puts it back with its title and attachments.
- **Tests.** Unit tests went from 552 to 599 and end-to-end tests from 28 to 31.

Changed from earlier parts:

- **The tree schema is at version 5.** An earlier build cannot open a tree once this build has opened it; a copy is put in the backups folder first, as since part 2a.
- **A tree folder holds a `media` folder** beside `tree.db` and `backups`.
- **The content security policy allows pictures from the `rulz-media:` scheme,** and nothing else new.
- **An export says how many files it left out.** A GEDCOM file written by this build does not mention files added in the app.
- **The contract between the page and the main process has 60 functions,** nine more than before.
- **Part 2b is smaller than planned,** and Phase 2 has five parts instead of four; see the breakdown above.

Not done, and why:

- **GEDCOM files know nothing of the files added in the app,** and the media records of an imported file are still lines kept as written, shown nowhere in the app. Both are part 2c, with GEDZip.
- **Disk space is never freed.** A file deleted from the tree stays in the media folder, so that Undo can bring it back, and the undo history has no end yet. A clean-up needs the pruning rule for the change log first.
- **Backups do not include the media folder.** They protect the tree's data, not its pictures. The Backups dialog says so once a tree has files, and says to copy the whole tree folder.
- **A file already in the tree can be attached to something else only by choosing the same file again** in the system dialog. There is no "choose from this tree" yet.
- **Files cannot be dragged into the window or pasted.**
- **No picture stands for a person.** Lists and charts show no portraits, and the order of the files on a page cannot be changed.
- **No regions.** A face in a group photograph or one entry on a page cannot be marked.
- **No text is read out of a picture** (OCR), and a file has no date or place of its own.
- **PDF, TIFF, HEIC, sound and film are not shown in the app.** They open in another program.
- **Very large pictures are drawn whole.** There are no tiles, so a scan of several hundred megapixels may be slow or fail to draw. The largest picture tried was 2,400 by 3,200.
- **The small pictures depend on Windows.** They were checked on the development PC only. On a PC where Windows returns none, lists fall back to the full files and get slow; the end-to-end tests accept either.
- **Copying a file blocks the window,** like an import. That was 0.2 seconds for 200 MB on a solid-state disk, measured with the file just written; a slow or network disk was not tried.
- **The upgrade from version 4 was tested on a tree built by the tests,** not on a file saved by the earlier build.
- **The new screens were checked by eye in light colours only,** in one window of about 1,100 by 570 points.
- **Real photographs and scans were not tried.** The test pictures are generated patterns, and no JPEG from a camera or scanner went through the viewer.

### Phase 2c outcome

Delivered:

- **The pictures and documents an imported file names.** A media record, and a description written in place under a person, a family, an event, a citation or a source record, becomes a file of the tree with its title and its note, attached to what the file attaches it to. It shows on the person's page, under its citation and in "Media" like a file added in the app. Until the file itself is given, its tile says "Not in the tree" and the viewer shows the path or web address the imported file gave.
- **Giving the tree the files.** "Find the files in a folder" under "Media" looks in a folder the user picks, and the folders inside it, and takes a copy of each file it finds, as one undo step. The viewer has "Choose the file" for one file, and a link for a web address, which opens in the browser like every other link of the app (the tests check the link, and do not click it). A filter lists only the files that are not in the tree.
- **GEDZip, both ways.** The import reads a `.gdz` file, or any zip file that holds one GEDCOM file, and takes the pictures in it into the tree. The export dialog offers "A GEDZip file", which packs the GEDCOM file with every file the tree holds.
- **Export.** A GEDCOM file names the files of the tree: the imported ones as they were written, line for line when nothing was edited, and the ones added in the app as new records. A title or note that was edited changes one line, or one line in each place a description stands. A file taken away from something loses its line there; a deleted file loses its record and every line that pointed at it. In GEDCOM 7.0 a description in place becomes a record.
- **Trees imported before this part are upgraded** when they are opened, after a copy is put in the backups folder: their media records and media lines, which were kept as written, become files and attachments exactly as a fresh import of the same file would make them. Files attached in the app before the upgrade stay first in each list.
- **Living people.** A picture that is attached only to people and things an export leaves out is left out too, and the export says how many.
- **Tests.** Unit tests went from 599 to 680 and end-to-end tests from 31 to 32.

Changed from earlier parts:

- **The tree schema is at version 6.** An earlier build cannot open a tree once this build has opened it; a copy is put in the backups folder first.
- **"One file is one row" now holds only for files added in the app.** Two records of an imported file that name the same picture are two rows, as in the file.
- **An import report counts pictures and documents,** and no longer counts media records among what is kept as written. A person's page no longer lists media lines under "items the app has no fields for".
- **An export writes the files added in the app,** which part 2b left out and said so.
- **GEDZip files are no longer refused.**
- **The contract between the page and the main process has 62 functions,** two more than before: choosing the file for one row, and looking in a folder. Exporting takes one more choice, and the list of files one more filter.

Not done, and why:

- **No real export from any program has been tried,** and here it matters most. How Ancestry, Family Tree Maker, RootsMagic, Gramps and the others write media was taken from the two standards and from memory of such files. The sample in Ancestry's style has one media record. A file that names its pictures in a way not thought of keeps those lines as written, which loses nothing, but shows no picture.
- **No GEDZip file made by another program was read.** The archives in the tests were written by this app, and one by Windows' own zip tool. A file from FamilySearch or another GEDCOM 7.0 program may name its files in a way the import does not follow.
- **Archives over 4 GB are neither read nor written** (the ZIP64 format), nor are more than 65,534 files in one archive. A tree with more pictures than that can still be copied as a folder. The export stops when it reaches the limit, says so, and leaves no half-written file behind.
- **Nothing is downloaded.** A picture that an imported file names by a web address, as Ancestry's exports do, has to be saved by the user and then chosen or found in a folder. The address opens in the browser.
- **A file is found by its name only.** A picture that was renamed since the GEDCOM file was written is not found, and two files of one name in folders that fit equally well are both left. There is no way yet to pick between them, other than choosing the file for each row by hand.
- **The folder search looks at 50,000 files and 12 folders deep at most,** and blocks the window while it copies, as adding files does.
- **Only the first file of a media record that names several is the file.** The other FILE lines are kept and exported, and shown nowhere.
- **What a media line carries beyond the pointer is not shown:** a cropping, a title for that one use (GEDCOM 7.0), a program's own "main picture" mark. It is kept and exported.
- **A description in place that differs in one line is another file.** Two people with the same photograph, one of them marked as the main picture, get two rows that name one file. Both hold it once it is found.
- **Media under a note, an association, a submitter or a name is not attached to anything;** the line is kept as written. So is the second of two equal citations of one fact, with the media under it.
- **A file's kind is guessed until the tree holds it,** from the format the GEDCOM file states or the ending of the name. A wrong guess corrects itself when the file is taken in.
- **An export to 5.5.1 of a tree imported as 7.0 keeps records,** which 5.5.1 allows. An export to 7.0 writes file names as they are; 7.0 wants a path with special characters written in a coded form, and only the names this app makes are sure to need none.
- **The Backups dialog counts every picture and document as a file in the media folder,** also those the tree only knows of.
- **The new screens were checked by eye in light colours only,** in one window of about 1,100 by 570 points.
- **The upgrade from version 5 was tested on trees built by the tests,** not on a file saved by the earlier build.

## 9. Risks

- **Anthropic's rules for using a Claude plan outside its own apps changed several times in 2026** and may change again. Route A of the AI assistant relies only on ordinary use of Anthropic's own apps. Routes B and C sit behind one interface, and the app works without any of them.
- **AI proposals can be wrong or invented.** Every reason must quote the stored record, the app checks the quotes, and the user decides. See section 7.
- **FamilySearch gave no access** (answered 2026-11-13): its API is for businesses that market applications they alone own, not for open-source or personal projects. Nothing in Phases 1–4 depends on it; the Tier C link, built in part 3b, is what the app has.
- **APIs change or close**, as the Chronicling America legacy API did in 2025. Connectors are isolated, and from Phase 3 a scheduled CI job runs contract checks against live endpoints.
- **Terms of service.** No scraping anywhere. Rate limits and attribution come from the manifest.
- **Data quality.** Community trees and machine-read indexes contain errors, so every fact shows its source and nothing is accepted without the user.
- **Privacy.** Living people and DNA stay on the PC. Exports hide living people by default. No telemetry. The one exception is the optional AI assistant: while it is on, details of the people being researched and the records read for them are sent to Anthropic. Living people are masked unless the user opts in, and DNA is never sent.
- **GEDCOM files in the wild do not follow the standard closely,** and each program bends it in its own way. The import was built from the two standards and from what is known of Ancestry's files, not from a collection of real exports. It keeps every line it does not understand and reports what it could not place, so a surprise in a real file should cost a misread field, not lost data. Real exports from each program need to be tried before a release.
- **A wrong merge damages a tree,** and a list of suggested duplicates invites one. The app never merges on its own, shows both records before a merge, keeps everything both had, and makes the merge one undo step. The undo history is kept in the tree file, and backups hold earlier states.
- **An upgrade rewrites a tree in place.** From part 2a a migration can change what a tree holds, not only add tables. The tree is copied to its backups folder first, each migration is one transaction that is applied whole or not at all, and the tests compare an upgraded tree with a fresh import. A mistake in a migration would still reach every tree the build opens, so each one needs that comparison.
- **One citation for several facts is not how every program thinks.** A user who edits a citation under a birth may not expect the name's citation to change with it. The edit form says when a citation supports more than one fact; whether that is enough has not been tried with a user.
- **A tree is now more than one file.** The pictures and documents are in the media folder, not in `tree.db`, and backups do not hold them. A user who copies only `tree.db`, or relies on the backups folder alone, loses the files. The app shows a lost file as missing and takes it back when it is added again, and the Backups dialog and the README say to copy the whole folder. A backup that includes the media folder is still to be designed.
- **The media folder only grows.** Nothing is removed from it, so a tree can become much larger than what it shows. See "Disk space is never freed" under part 2b.
- **A file from someone else can name any path and hold any archive.** A GEDCOM file may give `C:\Users\…` for a picture, and a zip file may claim sizes it does not have. The import opens no path a GEDCOM file names, takes from an archive only what the GEDCOM file names by a path inside it, never writes under a name from an archive, and unpacks no entry beyond 500 MB. An archive that names very many large files can still fill the disk of whoever imports it; nothing limits the total yet.
- **The zip code is the app's own.** It was written for this part, with no library behind it, and has met two other tools: Windows' own unpacker and bsdtar read what it writes, and it read one archive Windows wrote. Archives from other programs may use features it refuses (ZIP64, encryption, other packing methods); it says so and imports nothing.
- **A test that fails now and then hides real failures.** The 10,000-person GEDCOM unit test has stopped with a native crash twice in about 35 full runs, with no cause found. If it becomes more frequent, find the cause before adding more tests around it.
- **Coverage.** Users with mostly US ancestors before 1940 will do much of their record searching through links to FamilySearch's own site.

## 10. Open decisions

1. **Open source or private.** Decided 2026-11-11: the repository is public on GitHub under the MIT license.
2. **Region priority,** which sets connector order. Decided 2026-11-13: the default stands. US, then Netherlands, UK and Ireland, Australia and New Zealand.
3. **FamilySearch.** Decided 2026-11-11: applied. Answered 2026-11-13: no access for an open-source project. Decided the same day: the Family Tree connector is dropped from the plan and its manifest is removed. The app knows FamilySearch only as a site whose record search it opens in the user's browser.
4. **AI assistant routes.** Decided 2026-11-11: build route A first, then route C. Route B is built only after Anthropic confirms in writing that starting the user's own unmodified Claude Code from this app is permitted; it also needs the owner to accept Anthropic's Commercial Terms of Service. See [ACCESS.md](ACCESS.md).
5. **The GeoNames gazetteer.** Decided 2026-11-13: downloaded by the user on first use, not shipped with the app. Built the same day. Its licence is CC BY 4.0, confirmed from GeoNames' own readme; the credit line is in the "Places" window.
6. **Map tiles.** Decided 2026-11-13: none. The map is drawn from Natural Earth's public-domain outlines, which the app ships with, and asks nothing of the internet. A detailed map can be added later as a download, never as a service that is asked while the user looks.
