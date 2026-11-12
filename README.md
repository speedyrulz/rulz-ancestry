# RulZ Ancestry

A Windows desktop app for building a family tree and researching it with free
data sources. Everything is stored on your own PC.

Status: **Phase 1 in progress.** Parts 1a and 1b are done. You can create a
family tree, add and edit people with their names, events, parents, partners
and children, search the tree by name, and undo or redo every change. The app
backs the tree up when it closes. Importing and exporting GEDCOM files (part
1c) and charts (part 1d) are next; there is no record search yet. See
[docs/PLAN.md](docs/PLAN.md) for the full plan and
[docs/ACCESS.md](docs/ACCESS.md) for the API keys and applications that only
the project owner can request.

A tree is a folder holding `tree.db` and a `backups` folder. By default it is
made in `Documents\RulZ Ancestry`. To move a tree, move its folder and open it
again with "Open a tree folder".

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
packages/core         Domain logic with no Electron dependency (ids, dates; GEDCOM, matching later)
packages/db           The tree database: schema migrations, queries, undo and redo, search
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
  and reject a write made any other way.
- **Schema changes are migrations.** A change to the tree database is a new
  numbered file in `packages/db/src/schema`; a migration that has shipped is
  never edited.
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
