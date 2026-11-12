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
on and say which names and events each one supports. The open check is to try
the import on a real export from Ancestry. Pictures and documents (part 2b) are
next; there is no record search yet. See
[docs/PLAN.md](docs/PLAN.md) for the full plan and
[docs/ACCESS.md](docs/ACCESS.md) for the API keys and applications that only
the project owner can request.

A tree is a folder holding `tree.db` and a `backups` folder. By default it is
made in `Documents\RulZ Ancestry`. To move a tree, move its folder and open it
again with "Open a tree folder".

GEDCOM is the file format family tree programs use to pass a tree to one
another. The app reads versions 5.5.1 and 7.0 and writes both.

- **Import** always makes a new tree; the file itself is not changed. Details
  the app has no screens for yet (notes, pictures, other programs' own tags)
  are kept exactly as written and go back into an export.
- **Export** in the version the file came in gives the same file again, line
  for line, apart from its header. After edits, only the edited lines differ.
- **Living people are left out of an export** unless you choose to include
  everyone.
- The import has been tested on files written the way Ancestry writes its
  exports, including one with 10,000 people, which takes about 3 seconds. It
  has not yet been tried on a real export from Ancestry or any other program.

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
- Where a source is kept (an archive, a website) and the web address of a
  record have no fields of their own yet.

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

## Layout

```
apps/desktop          Electron app: main process, preload script, React UI, e2e tests
packages/core         Domain logic with no Electron dependency (ids, dates, reading and writing GEDCOM, chart layout, relationship names, duplicate scoring)
packages/db           The tree database: schema migrations, queries, undo and redo, search, backups, GEDCOM import and export, chart data, relationships, duplicates and merging, sources and citations
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
