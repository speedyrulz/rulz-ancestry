# RulZ Ancestry

A Windows desktop app for building a family tree and researching it with free
data sources. Everything is stored on your own PC.

Status: **Phase 1 is built with one check open, and Phase 2 has started.** You
can create a family tree, add and edit people with their names, events,
parents, partners and children, search the tree by name, and undo or redo every
change. The app backs the tree up when it closes. You can bring in a tree from
Ancestry or another program as a GEDCOM file, and write a tree out as one. You
can draw four kinds of chart, ask how two people are related, and find and
merge people who were entered twice. You can record the sources a tree rests
on and say which names and events each one supports. You can attach pictures
and documents to people, events, families, citations and sources, and look at
a picture at full size. The pictures and documents a GEDCOM file names are read
and written, and a GEDZip file takes the files themselves along. A person, an
event and a source can each carry a note. One real export from Ancestry has
been tried and comes back out line for line. The app offers places while you
type, and can link each place of a tree to where it lies on the map, from a
list of the world's places that it downloads when you ask. A person's page
tells their life as a timeline and marks its places on a map. Phase 2 is
complete with that. Phase 3 has started: the app can search WikiTree for a
person of your tree and attach a result to the person as a source with one
click. It opens a search at Find a Grave or FamilySearch in your browser, and
a page you find there becomes a source when you paste its address. See
[docs/PLAN.md](docs/PLAN.md) for the full plan and
[docs/ACCESS.md](docs/ACCESS.md) for the API keys and applications that only
the project owner can request.

A tree is a folder holding `tree.db`, a `backups` folder and, once the tree
holds a picture or document, a `media` folder. By default it is made in
`Documents\RulZ Ancestry`. To move a tree, move its folder and open it again
with "Open a tree folder". To keep a tree safe, copy the whole folder: the
backups hold the tree's data, not its pictures and documents.

GEDCOM is the file format family tree programs use to pass a tree to one
another. The app reads versions 5.5.1 and 7.0 and writes both.

- **Import** always makes a new tree; the file itself is not changed. Details
  the app has no screens for yet (a second note on one thing, other programs'
  own tags) are kept
  exactly as written and go back into an export.
- **Export** in the version the file came in gives the same file again, line
  for line, apart from its header. After edits, only the edited lines differ.
- **Living people are left out of an export** unless you choose to include
  everyone.
- The import has been tested on files written the way Ancestry writes its
  exports, including one with 10,000 people, which takes about 3 seconds. One
  real export from Ancestry, of 162 people, has been tried; no export from
  another program has.

Charts, relationships and duplicates:

- **Charts.** "Chart" on a person's page draws their ancestors, their
  descendants, both (an hourglass), or a fan of ancestors. Click a person to
  put them at the centre.
- **Relationships.** "Relationship" on a person's page says how anyone else in
  the tree is related to them, for example "second cousin once removed" or
  "father-in-law", and lists the people in between.
- **Duplicates.** "Duplicates" lists the people most likely to be in the tree
  twice, with the reasons. Nothing is merged until you compare two records
  and say so. A merge keeps everything both records had and is one undo step.
- The duplicate scores were set by hand and have not been checked against a
  real tree, so treat the list as suggestions.

Sources:

- **A source** is where information comes from: a census, a register, a
  certificate, a book. "Sources" on the tree screen lists them all.
- **A citation** is one place in a source, with what it says there. "Sources"
  beside a name or an event on a person's page lists the citations that fact
  rests on, and adds, edits and removes them.
- **One citation can support several facts.** One census entry gives a name, a
  year of birth and a residence; it is entered once and edited once.
- **Sources in a GEDCOM file** are read into these screens and written back.
  A tree imported by an earlier build is upgraded when it is opened, after a
  copy of it is put in its backups folder.
- **A citation can carry the web address of the record** and the day you
  looked at it. Both are read from and written to GEDCOM files; an address
  Ancestry wrote for a record is shown and opens in your browser.
- Where a source is kept (an archive, a website) has no field of its own yet.

Pictures and documents:

- **Adding a file copies it into the tree.** The copy goes into the tree's
  `media` folder; the file you chose stays where it was. The same file added
  twice is kept once.
- **A file can be attached** to a person, a family, an event, a citation or a
  source, and to several of them. A scan of a register page belongs with the
  citation of that page.
- **The viewer** shows a picture fitted to the window and zooms to its real
  size and beyond, with the buttons, the mouse wheel or the keyboard. Drag to
  move.
- **"Media"** on the tree screen lists every file in the tree, including those
  attached to nothing.
- **Other files** (PDF, TIFF, text, sound, film) are kept in the tree and
  opened in the program Windows uses for them.
- **Deleting a file from the tree leaves its copy on the disk,** so that Undo
  can bring it back. The app does not free that space yet.
- **One file is one entry,** however often it is added in the app. Only an
  imported file that lists one picture twice gives two entries.

Pictures and documents in GEDCOM files:

- **A GEDCOM file names files; it does not hold them.** After an import the
  tree knows each picture by its title and by what it belongs to, and shows
  "Not in the tree" until it has the file.
- **"Find the files in a folder"** under "Media" looks in a folder you choose,
  and the folders inside it, for the files by name, and takes a copy of each
  one it finds. "Choose the file" in the viewer does the same for one file.
- **The app opens no path a GEDCOM file gives.** It shows the path or web
  address, and takes a file only from a place you point at.
- **A GEDZip file** (`.gdz`) is a zip file with a GEDCOM file and the files it
  names. The import reads one and takes its pictures into the tree. The export
  dialog writes one with every file the tree holds.
- **A GEDCOM file written on its own** names every picture and document: those
  that were imported as they were written, those added in the app as new
  records.
- **Pictures that belong only to people an export leaves out are left out
  too,** and the export says how many.
- Archives over 4 GB are not read or written. Nothing is downloaded from a web
  address. No GEDZip file from another program has been tried.

Places:

- **The place of an event is the text you type,** and the app never changes it.
- **Places are offered while you type:** first the places your tree already
  has, then places from all over the world once the place list is downloaded.
- **The place list is downloaded when you ask,** with "Download the place
  list" under "Places" on the tree screen: about 100 MB, from
  [GeoNames](https://www.geonames.org/), licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It becomes a file
  of about 76 MB in the app's own folder, holding 550,000 places: every town,
  village, township and county of the United States, the Netherlands, the
  United Kingdom, Ireland, Australia and New Zealand, and the towns of 500
  people and more elsewhere. It can be removed again.
- **This download sends nothing about you or your tree.** Apart from it, the
  app asks the internet only when you search for records (see below).
- **Linking a place** says where it lies. "Places" lists every place of the
  tree, offers the entry of the place list that fits each best, and links it
  with one press; every event at that place then shares the link. A place
  picked from the list while typing is linked at once.
- **A tree keeps the coordinates of its linked places,** so it does not need
  the place list on another PC.
- Links are not written to a GEDCOM file, and places are linked one at a
  time.

Timeline and map:

- **"Timeline and map" on a person's page** tells the life in order: the
  person's own events, their marriages, and the births and deaths close to
  them, with how old the person was at each. Events without a date are listed
  apart.
- **The map marks every place that is linked to the place list,** with the
  number that stands beside it in the timeline. Places that lie far apart can
  be looked at one area at a time.
- **The map is drawn from outlines the app ships with:** countries, and the
  states, provinces and counties of seven countries, from
  [Natural Earth](https://www.naturalearthdata.com/) (public domain). It shows
  borders and coasts, no roads or towns, and asks nothing of the internet.
- A place that is not linked is named under the map; "Places" links it.

Searching for records:

- **"Search records" on a person's page** looks for the person at
  [WikiTree](https://www.wikitree.com/). The form starts with their name and
  their years of birth and death; you can change or empty each before you
  search.
- **What is sent:** those four fields, to WikiTree, when you press "Search".
  Nothing else of your tree, nothing while you type, nothing in the
  background. The app says so before the first search and asks you to agree.
- **Living people:** the app does not search for a person who may be living,
  and shows no profiles of living people or private profiles.
- **Results** show a name, the birth and the death, and a link that opens the
  profile in your browser. They are not kept, and nothing is added to your
  tree unless you attach one.
- **"Attach as a source"** on a result cites it for the person: the source is
  "WikiTree", and the citation holds the name and id of the profile, its birth
  and death as WikiTree gives them, its address and today's date. It is one
  step for Undo. A tree has one source per site, however many records of it
  are cited.
- **Other sites.** The app never asks Find a Grave or FamilySearch anything
  itself; their terms do not allow it. A button opens a search for the same
  four fields at the site, in your own browser. The fields are part of the
  address that is opened, so the site and your browser's history hold them.
  The app does this for no person who may be living.
- **"Cite a page you found there"** makes a source of a page from your
  browser: you paste its address, and the app keeps the address and the day.
  It does not fetch the page.

An optional AI assistant is planned (Phase 4b). Claude proposes record matches
for you to confirm, through your own Claude app or your own API key. It is off by
default, and while it is on, details of the people being researched are sent to
Anthropic. See section 7 of the plan.

The [wiki](https://github.com/speedyrulz/rulz-ancestry/wiki) has the roadmap,
architecture, data sources, development guide and changelog. It is updated after
every push or merge to `main`; `.claude/hooks/wiki-reminder.cjs` reminds Claude
Code sessions to do so.

## Requirements

- Windows 10 or 11, 64-bit
- Node.js 24 or newer
- pnpm 12 (`corepack enable` picks up the version pinned in `package.json`)

## Commands

Run these from the repository root.

| Command                  | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `pnpm install`           | Install dependencies                                            |
| `pnpm dev`               | Run the app with hot reload                                     |
| `pnpm test`              | Unit tests (Vitest); `pnpm test packages/db` runs one folder    |
| `pnpm typecheck`         | TypeScript check for every package                              |
| `pnpm lint`              | ESLint                                                          |
| `pnpm format`            | Format all files with Prettier                                  |
| `pnpm build`             | Production build into `apps/desktop/out`                        |
| `pnpm test:e2e`          | End-to-end tests against the production build                   |
| `pnpm package`           | Build the installer into `apps/desktop/release`                 |
| `pnpm test:e2e:packaged` | End-to-end tests against the packaged app (run `package` first) |
| `pnpm test:contract`     | Asks each searchable source one question. Needs the internet    |

## Layout

```
apps/desktop          Electron app: main process, preload script, React UI, e2e tests
packages/core         Domain logic with no Electron dependency (ids, dates, reading and writing GEDCOM, chart layout, relationship names, duplicate scoring, kinds of file)
packages/db           The tree database: schema migrations, queries, undo and redo, search, backups, GEDCOM and GEDZip import and export, chart data, relationships, duplicates and merging, sources and citations, the media folder, zip archives
packages/connectors   One folder per data source, each with a manifest of its limits and terms
docs/                 Plan and access checklist
```

## Rules the code follows

- **No scraping.** A source is used only through its official API, an open bulk
  dataset, or a link opened in the user's browser. Each source's manifest in
  `packages/connectors/src/sources` records which, with its rate limits and terms.
- **The UI cannot reach Node.js.** The window runs sandboxed with context
  isolation; it talks to the main process only through the functions listed in
  `apps/desktop/src/shared/ipc.ts`.
- **What the page sends is checked.** Each of those functions validates its
  arguments in `apps/desktop/src/main/handlers.ts` before anything runs. The
  page can create a tree only in a folder the user picked, and open only a
  recent tree or a folder the user picked.
- **Every change to a tree can be undone.** Code changes a tree only through
  `Tree.transact` in `packages/db`. Database triggers record each changed row
  and reject a write made any other way. The one exception is `Tree.load`,
  which fills an empty tree from a file and is the tree's starting point.
- **An import loses nothing.** Every line of a GEDCOM file is stored, whether
  or not the app understands it, and the export puts it back. Code that
  changes a line read from a file marks it with `touch()`, so that only
  changed lines are written afresh.
- **Exports protect living people.** An export leaves out anyone who may be
  living unless the user chooses otherwise.
- **Nothing is merged automatically.** The app only suggests that two records
  may be one person. A merge moves names, events and family links to the
  record kept, drops only exact repeats, and can be undone in one step.
- **Layout and naming are plain functions.** Where a chart puts each box
  (`packages/core/src/chart.ts`) and what a relationship is called
  (`packages/core/src/kinship.ts`) are worked out from plain values, with no
  database and no screen, so they are tested as arithmetic.
- **A citation exists only while it supports something.** When the last fact
  it supports goes, the database removes the citation in the same undo step.
  A GEDCOM file has no place for a citation that supports nothing, so it would
  otherwise be lost in an export without notice.
- **A file in a tree's media folder is never changed or removed by an edit.**
  It is stored under the SHA-256 of its contents. Deleting a file from the
  tree deletes its row and leaves the copy, so undo, redo and a restored
  backup always find the file a row names.
- **The page names a file by its id, never by a path.** The user picks files
  in the system dialog. Pictures reach the page through the `rulz-media:`
  scheme, which the main process answers only from the open tree's media
  folder (`apps/desktop/src/main/mediafiles.ts`).
- **Opening a file never runs it.** Only kinds on a fixed list in
  `packages/core/src/media.ts` are handed to another program; anything else
  is shown in its folder.
- **A file comes into a tree only from where the user says.** The import
  opens no path a GEDCOM file names. Files come from the archive the GEDCOM
  file came in, by a path that stays inside it, or from a file or folder
  picked in the system dialog.
- **Nothing is written under a name from an archive.** The zip reader in
  `packages/db/src/zip.ts` hands out bytes, and the media folder files them
  under their hash. An entry larger than the limit is not unpacked, whatever
  size the archive states.
- **The text of a place is the user's.** Linking a place to the place list
  stores the entry's name and coordinates beside the text
  (`packages/db/src/places.ts`); it never rewrites the text, and it changes no
  line of an imported GEDCOM file.
- **The app asks nothing of the internet unless the user says so.** It makes
  two kinds of request: the download of the place list, and a search for
  records. Sites whose terms bar automated access are never asked: the app
  only builds a search address for them and hands it to the user's browser
  (`packages/connectors/src/links.ts`, which has no way to fetch), under the
  same notice and the same rule for living people. A search sends a name and two years, after the user has agreed to
  a notice, never for a person who may be living, and only through the client
  of the source (`apps/desktop/src/main/records.ts`,
  `packages/connectors/src/http.ts`): its address only, within its limits,
  without cookies. The download asks fixed addresses on
  one host (`apps/desktop/src/main/gazetteer.ts`). What arrives is not
  trusted: each file has a size limit, archives are checked, the new list is
  built beside the old one and swapped in only when complete.
- **Schema changes are migrations.** A change to the tree database is a new
  numbered file in `packages/db/src/schema`; a migration that has shipped is
  never edited. A tree is copied to its backups folder before a migration
  changes it. When a migration gives a table to something an import used to
  keep as written, the import and the migration make their rows with the same
  code, and a test compares an upgraded tree with a fresh import.
- **Development data stays separate.** `pnpm dev` stores its database in
  `%APPDATA%\RulZ Ancestry (dev)` and makes new trees in
  `Documents\RulZ Ancestry (dev)`, not in the installed app's folders. The
  end-to-end tests keep everything inside a temporary profile folder.

## Dependency updates

pnpm holds back very recently published packages as a supply-chain precaution.
If an install asks to add a brand-new version to `minimumReleaseAgeExclude`,
prefer widening the version range so an older release can be used instead.

## License

MIT. See [LICENSE](LICENSE).
