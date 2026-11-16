# Design

RulZ Kinspora follows the RulZ design system, the one look that every RulZ app shares: black and red, flat
surfaces separated by hairlines, Segoe UI type, compact 13 and 14 px text. This page says how the app applies it,
so that anyone who restyles a screen uses the same parts in the same way. The accessibility rules in
[ACCESSIBILITY.md](ACCESSIBILITY.md) hold on top of it.

The guide itself (colours, type, space, components) was written for the launcher app, in React and Tailwind. Here
the same values are CSS custom properties in plain CSS, under the guide's own names.

## The theme

- **Dark is the default, light is offered, and the choice is remembered.** The theme button (a Lucide `Sun` in the
  dark theme, a `Moon` in the light one, named "Use the light theme" or "Use the dark theme") is in the top bar of
  an open tree and in the banner of the start screen.
- The choice is a setting of the application (key `theme`, value `dark` or `light`) in the settings table of the
  application database, kept by `src/main/theme.ts` the way the update-check setting is kept. A missing or damaged
  value means dark. The renderer reads and writes it with `getTheme()` and `setTheme(theme)` (`src/shared/theme.ts`);
  `setTheme` accepts nothing but the two words.
- The main process applies it with `nativeTheme.themeSource` **before the window is made**, so that the title bar
  and the window's `backgroundColor` are right from the first frame. The page then follows
  `prefers-color-scheme`: `styles/tokens.css` holds the dark values in `:root` and the light values in
  `@media (prefers-color-scheme: light)`. There is no `data-theme` attribute and no theme state in React; the button
  asks the media query which theme is showing (`useDarkTheme` in `components/ui.tsx`).
- The end-to-end tests start the app with `colorScheme: null` (`e2e/fixtures.ts`). Without it Playwright makes every
  page report a light scheme whatever the window's theme is, and a test could not see the dark theme at all.

## Tokens

Every colour has a dark and a light value in `styles/tokens.css`. **Use the token, never a raw colour** (`#fff`,
`rgb(...)`, a named colour). The system colours of high contrast (`ButtonText`, `Highlight`, ...) are the one
exception, and only inside `@media (forced-colors: active)`.

| Group     | Tokens                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surfaces  | `--bg` (window), `--panel` (cards, dialogs, fields), `--panel-2` (raised: secondary buttons, menus, table headers, inline code), `--hover`, `--border`, `--border-strong` |
| Text      | `--text`, `--body`, `--muted`, `--faint` (all 4.5:1 on `--bg`, `--panel` and `--panel-2`)                                                                                 |
| Red       | `--accent` (fills, focus ring), `--accent-hover`, `--accent-soft` (wash), `--accent-fg` (white on red), `--accent-text` (red as text), `--link`                           |
| Errors    | `--danger` (icons, marks, bars), `--danger-text`, `--danger-bg`, `--danger-border`, `--danger-hover`                                                                      |
| Status    | `--ok`, `--warn`, `--warn-text`                                                                                                                                           |
| Notices   | `--banner-bg`, `--banner-text`, `--code-bg`, `--sunken`, `--subtle`, `--subtle-border`, `--track`, `--media-bg`, `--scrim`, `--shadow`                                    |
| Derived   | `--accent-border`, `--ok-soft`, `--ok-border`, `--warn-soft`, `--warn-border`, `--on-accent-soft` (made with `color-mix` from the tokens above)                           |
| Space     | `--space-0\.5` ... `--space-8` (2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32 px; the dot is escaped as in the guide)                                                        |
| Radius    | `--radius-sm` 4, `--radius-md` 6, `--radius-lg` 8, `--radius-xl` 12, `--radius-2xl` 16, `--radius-full`                                                                   |
| Size      | `--control-sm` 32, `--control-md` 36, `--control-lg` 44, `--topbar` 48, `--icon-md` 16, `--icon-sm` 12                                                                    |
| Shadow    | `--shadow-accent-glow`, `--shadow-card-hover`, `--shadow-dialog`, `--shadow-menu`, `--shadow-tile`                                                                        |
| Type      | `--font-sans`, `--font-display` (titles), `--font-mono` (paths, code)                                                                                                     |
| The app's | `--control-border` (below), `--male`, `--female`, `--line` (charts), `--map-sea` (the map of a life)                                                                      |

Type sizes: 14 px base; 13 px for menus, chips, small buttons, hints, dialog text and the search field; 12 px
(`faint`) for captions; 11.5 px in badges; 11 px in a `kbd`. Titles use the display family: `h1` 28 px bold,
`h2` 18 px semibold (the dialog title), `h3` 15 px semibold. Use `font-variant-numeric: tabular-nums` for counts.

### What the old names became

| Old               | New                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--surface`       | `--panel`                                                                                                                                                                            |
| `--surface-2`     | `--panel-2` (for a hover fill, `--hover`; behind a picture, `--media-bg`; code, `--code-bg`)                                                                                         |
| `--accent-text`   | `--accent-fg` (it meant white text on red)                                                                                                                                           |
| `--accent-strong` | `--accent-text` (it meant red text)                                                                                                                                                  |
| `--error`         | `--danger` for bars, borders and marks; `--danger-text` for text                                                                                                                     |
| `--error-soft`    | `--danger-bg`                                                                                                                                                                        |
| `--focus`         | `--accent` (the focus ring is red now)                                                                                                                                               |
| the rest          | unchanged: `--bg`, `--text`, `--muted`, `--border`, `--accent`, `--accent-hover`, `--accent-soft`, `--warn`, `--ok`, `--control-border`, `--male`, `--female`, `--line`, `--map-sea` |

## The style files

`src/renderer/src/main.tsx` imports them in this order, and the order matters (a later file wins a tie):

| File           | What is in it                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.css`   | Every token, dark in `:root`, light under `prefers-color-scheme: light`                                                                                     |
| `base.css`     | Reset, body, headings, links, `code` and `kbd`, `.muted`, `.error`, `.path`, `.visually-hidden`, scrollbars                                                 |
| `controls.css` | Buttons, icon buttons, chips, fields, search field, checkbox, switch, badges, progress, menu, banners and notices, tables; their high-contrast rules        |
| `dialogs.css`  | The dialog, its header, body, footer and close button; `.pick-list`, `.scroll-box`, `.dialog-actions`, `.confirm-box`                                       |
| `layout.css`   | The logo images, the start screen (hero, cards, recent trees), the workspace (top bar, action bar, panes, person list)                                      |
| `people.css`   | The person page, family, timeline and map of a life, relationships, notes                                                                                   |
| `charts.css`   | The four charts and their controls                                                                                                                          |
| `gedcom.css`   | GEDCOM import and export                                                                                                                                    |
| `sources.css`  | Sources and citations                                                                                                                                       |
| `records.css`  | Records search, a search run, the inbox, the comparison of a record                                                                                         |
| `media.css`    | Pictures and documents, the viewer                                                                                                                          |
| `places.css`   | The offers while a place is typed, the gazetteer                                                                                                            |
| `packs.css`    | Offline data packs and the census                                                                                                                           |
| `ai.css`       | The optional AI assistant                                                                                                                                   |
| `a11y.css`     | Imported last: the skip link, the text outline of a chart, the reflow at large text for the shared layout, reduced motion, high contrast for the focus ring |

Two more files sit beside their screens: `components/reports.css` (the report dialog) and `components/updates.css`
(the update notice). Both are imported by their components, so they load before the files above.

An area's own rules for large text (`@media (max-width: 900px)`) and for high contrast (`@media (forced-colors: active)`)
sit at the end of **its own file**. Rules that belong to no one area, such as the reflow of the top bar and the
panes, or the high-contrast rules of buttons, tables and dialogs, sit in `a11y.css`, `controls.css`,
`dialogs.css` or `layout.css` next to what they change.

## Which class is which component

### Buttons

A `button` is a secondary button without any class: `--panel-2`, a `--border` hairline, 36 px tall, radius 8, 14 px
medium text. Add classes, not new rules:

| Class             | Use                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primary`         | The one main action of a view: red, white text, glow. **One per view.** A dialog is a view of its own                                                                              |
| `danger`          | Something that removes something. Never for Cancel                                                                                                                                 |
| `outline`         | A secondary action that should still read as RulZ: red edge, `--link` text                                                                                                         |
| `ghost`           | Low-weight actions, such as Cancel: no fill, `--muted` text                                                                                                                        |
| `link`            | A button that reads as a link, inside a sentence                                                                                                                                   |
| `small` (or `sm`) | 32 px, 13 px text, radius 6: action bars, rows of a table, buttons inside a list                                                                                                   |
| `large` (or `lg`) | 44 px, 15 px semibold                                                                                                                                                              |
| `icon-btn`        | A 36 px square with one 16 px icon. Always has an `aria-label`; use `IconButton` from `components/ui.tsx`                                                                          |
| `chip`            | A pill in a group of toggles (`aria-pressed`), 32 px; `chip highlight` for a pill that should stand out; `.chip-count` for its number                                              |
| `segmented`       | A frame (`div.segmented role="radiogroup"`) around buttons with `role="radio"` and `aria-checked`: one of a few choices, such as the kind of chart. The chosen one is red and bold |

`a.btn` takes the same classes for a link that looks like a button. A toggle (`aria-pressed="true"`) is red. A
`button.link` (a person's name in a list or a path) is the guide's link: `--link`, an underline at 35% red that is
full red on hover, the weight of the text around it.
Heights come from padding, never from a fixed `height`, so a button that wraps or holds a picture can grow.
Icons: Lucide, 16 px in buttons and the top bar, 14 px in `small` buttons, 12 px in badges, always
`aria-hidden="true"`; the colour is the text's. Do not add an icon to every button.

### Fields

`TextField`, `TextAreaField`, `SelectField` and `DateField` (in `components/ui.tsx`) make a `.field`: a 13 px muted
label over an input on `--panel`, radius 8, with a `--control-border` edge and an accent edge when it has the focus.
`.field-grid` lays fields out in two columns; `.hint` is the line under a field. Checkboxes are 18 px with radius 4
(the system's own box in high contrast); radio buttons keep the system's, in red. `.switch` is the 36 by 20 px
switch for a setting that applies at once (a `button` with `role="switch"` and `aria-checked`).
`.search-field` is the guide's SearchField: a 320 px field with a Lucide `Search` icon and a `kbd` hint that goes
while the field has the focus or holds a query.

### Badges and status

`.badge` is a 24 px pill with 11.5 px text. **A badge always carries a word, and a status never rests on colour
alone.** Tones: none (neutral), `accent`, `ok`, `warn`, `danger`: `<span className="badge ok">Attached</span>`. A 12 px
Lucide icon (`aria-hidden`) may come first. A badge that starts a line or a cell sits flush (no left margin). The
`warn` tone uses `--warn-text` and `ok` is darker in the light theme than the guide's green, so that both reach
4.5:1 on their own wash.

### Messages

`.notice` is a quiet panel (`--panel`, a `--border` hairline), so that "Undone" or "Backup made" does not read as a
warning; `.notice.accent` is the red wash for the one that asks to be seen (a new version is out). `.banner.error` and
`.error` (a `p` or `div`) are errors with a red bar at the left, `.notice-bar` holds the messages of the workspace. A
message with a role of `status` or `alert` never takes the focus.

### Tables, lists, boxes

`.table` has `--panel-2` headers and a stripe on every other row. `.scroll-box` is a framed area that scrolls (its
table header sticks). `.pick-list` is a list of choices in a dialog. Rows of a list are `--border` hairlines with a
`--hover` fill on hover. The chosen row is `--accent-soft` with a red mark at its left edge and a bolder name
(`.person-list .row.selected`): a chosen thing is never shown by colour alone.

### Cards and the hero

`.card` is `--panel`, a `--border` hairline, radius 12, padding 20 by 24. `.recent li` is a list row of the
start screen: `--panel-2`, radius 12. `.hero` is the red-glow banner (two radial washes and the slashes at -48
degrees) and is used on the start screen only, as the guide says.

### Dialogs

`Dialog`, `FormDialog` and `ConfirmDialog` (`components/ui.tsx`) make this structure:

```
dialog.dialog [.wide | .full]    --panel, --border, radius 12, shadow-dialog, over a --scrim with a 2 px blur
  div.dialog-head > h2           the title, 18 px display
  div.dialog-body                scrolls on its own
  div.dialog-foot                the buttons of a form, right-aligned, primary last (FormDialog, ConfirmDialog)
  button.icon-btn.dialog-close   "Close this window", at the top right
```

A dialog puts the buttons that end it in the footer (the `footer` prop of `Dialog`): right-aligned, the one primary
last, Cancel or Close as a `ghost` beside a primary and as a plain button when it is the only one. A dialog's Close is
never red. Buttons that act on the content (Back up now, Restore, Compare in a row) stay in the body, in a
`.dialog-actions` row. A form dialog ties the submit button in the footer to the form by `form={id}`, so Enter in a
field still submits.
Everything part 6.3 built stays: `aria-modal`, the focus goes in and back, Escape closes it, and the 50 ms rescue
when the focused control is removed.

### The workspace

A 48 px top bar on `--bg` with a hairline: the mark (24 px) and the label `KINSPORA` (`brand-label`), the tree's name
(`h1`, keep its test id) with the backup line in `--faint`, then at the right the search field, Undo and Redo icon
buttons and the theme button. Under it a sticky action bar with the commands, in `small` buttons: **Add person**
is the one `primary`. Then the list of people (320 px) and the person or chart. At large text (window narrower than
900 px) both bars stop being sticky and the page scrolls as a whole, so a focused control is never hidden behind them.

**App updates** (`components/updates.tsx`): `UpdatesProvider` (in `App.tsx`) keeps what is known and the panel, a
`Dialog` named "App updates" with the check button (the dialog's one primary), the "Check for a new version at
startup" box and what leaves the PC. `UpdatesButton` is the icon button that opens it (in the top bar, and in the
hero of the start screen; a red dot shows while a newer version is out). `UpdateNotice` is a thin `notice accent`
under the action bar (and under the hero), only while a newer version is out: "Open release page" and "Dismiss"
(Dismiss opens the panel at its check button).

### The person page and the charts

The person's name and years, then the commands in four named groups (`role="group"`): see (Chart, Relationship),
reports (Family group sheet, Ahnentafel), look for records (Search records, Search for ancestors, AI assistant) and
change the tree (Merge, Delete person). All are `small`; every command stays a visible button, because other
screens' tests and keyboard users reach them directly. Delete person is `danger`; the Delete and Remove buttons in
rows are plain, because they are many and Undo brings them back. People in the page's lists are `button.link`.

The chart bar holds the kind switch (`.segmented`), Generations, zoom as icon buttons (Zoom out, Zoom in) with the
percentage between, Fit and Save or print as `small` buttons. Chart boxes are `--panel` on a `--bg` canvas with a
`--control-border` edge, radius 8, and the sex colour at the left edge; the person at the centre has the red edge.

## Where the app departs from the guide, and why

1. **`--control-border` for the edge of fields, select boxes, unchecked checkboxes and chart boxes.** The guide
   draws these with `--border` (about 1.3:1 against the page) or `--border-strong`. WCAG 2.2 criterion 1.4.11 asks
   3:1 for the edge that makes a control visible, and part 6.3 made the app meet AA, so these controls use
   `--control-border` (`#8a8a93` dark, `#767680` light, at least 3:1 on `--bg`, `--panel` and `--panel-2`). The guide's
   `--border` is kept for cards, dividers and buttons that have a word on them.
2. **The ring of a primary button is white and inside the button** (offset -4 px), not outside it. A white ring
   outside a red button does not show on the white page of the light theme.
3. **The scrollbar thumb is `--faint`**, not `--border-strong`, so that it shows at 3:1.
4. **Fields show both the accent edge and the focus ring** when focused by keyboard.
5. **The Close button of a dialog comes after the body in the page**, and is drawn at the top right. This keeps
   the focus starting at the first field, as before, instead of on Close.
6. **`.hint` is 13 px `--muted`**, not 12 px `--faint`, because a hint here is a whole sentence.
7. **Tables have square corners**: a collapsed table cannot round them.
8. **Not used from the guide:** Radix, Tailwind and the app-card parts (screenshot, icon tile); this app has no
   cards of that kind.
9. The hover colour of a primary button on the dark theme (`--accent-hover`) is `#c8000b`, the light theme's
   value, not the guide's `#ff2633`: white text on the guide's colour is about 3.8:1, under 4.5:1, while on
   `#c8000b` it is about 6.1:1.

## Rules for the screens

- **Tokens only.** No hex, `rgb()` or named colours; no old token names. Sizes and radii use the space, radius and
  size tokens where one fits.
- **One primary button per view.** A dialog is a view. Cancel is `ghost`, a button that removes something is `danger`.
- **Sentence case** in buttons, headings, menus and dialog titles ("Add person", not "Add Person"). Uppercase
  is for the `KINSPORA` label only. No emoji; icons are Lucide.
- **A status carries a word** (and, where it helps, a 12 px icon). Never green against red alone. In high contrast
  something chosen needs a border or a system colour besides: see the end of `charts.css` and `layout.css`.
- **Edit only your own file** (`charts.css`, `records.css`, ...). A rule a screen needs from controls, dialogs or
  layout is a change to that shared file, asked for, not copied.
- A new control gets a text label or an `aria-label`, a visible focus (do not remove the outline), and both themes
  checked. Run `e2e/accessibility.spec.ts` after any change of look.
- Keep each file's line endings and encoding, and run `pnpm format:check`.
