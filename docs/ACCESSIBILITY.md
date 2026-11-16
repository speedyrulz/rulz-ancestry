# Accessibility

RulZ Kinspora aims at WCAG 2.2 level AA. This page says what the app does, how that is tested, what is
known to be missing, and gives the check a person makes with Narrator.

## What the app does

- **Keyboard.** Every control can be reached with Tab and Shift+Tab. The list of people moves with Up, Down,
  Home and End; the kinds of chart move with the arrow keys. Escape closes a dialog. A "Skip to the main
  part of the screen" link is the first stop of the tree screen.
- **Focus.** A dialog takes the focus when it opens and gives it back to the control that opened it. When
  the control that had the focus is removed (a deleted row, a button that turned into something else, the
  screen that was left) the focus goes to a neighbour, to the person's heading (a person page shows a
  heading from its first moment, so the focus has a place while it is read) or to the title of the new
  screen, never to the page. A chart that is drawn again for another person leaves the focus alone if the
  user has moved on to something else.
  Every focused control has a 2 px red outline, offset 2 px (`:focus-visible`); on a red button it is white and
  inside the button.
- **Names and structure.** Fields have labels, repeated buttons say what they are for ("Edit Birth, 1880"),
  dialogs have a name and `aria-modal`, tables have header cells and a name, one `h1` per screen
  (the tree's name, or the app's), `main`, `nav` and `header` landmarks. Messages are in `role="status"`
  or `role="alert"` and do not take the focus.
- **Charts.** Each chart has a text outline (a nested list: the person, their father and mother, and so on;
  descendants by partner and child) under "Text outline of this chart". A name in it moves the chart to that
  person, as a click on their box does. The drawing is not hidden: its boxes and places are buttons, reached
  with Tab, and the outline is the structured way to walk it.
- **High contrast.** In Windows high contrast (`forced-colors`) buttons, fields, tables and chart boxes keep a
  border, and the selected row, kind of chart, chosen place on the map and its row in the list use the
  system colours `Highlight` and `HighlightText`. Sex is shown by colour only; in high contrast the edge
  of a chart box is solid for male, double for female and dotted for the others, and a place in the fan has a
  solid, dashed or dotted outline in the same way.
- **Large text.** At 200% in a window of 1280 by 800 the two columns become one and the page scrolls as a
  whole. Only wide content (tables, charts, pictures) scrolls sideways inside its own box.
- **Reduced motion.** With "reduce motion" on, there is no animation and no smooth scrolling.
- **Contrast.** Text is at least 4.5:1 and the edges of fields, select boxes, unchecked checkboxes and chart boxes
  at least 3:1 (`--control-border`), in the dark and the light theme. The theme is dark unless the user chose light
  with the button in the top bar; it is kept, and it does not follow Windows (see DESIGN.md).

## How it is tested

- `apps/desktop/e2e/accessibility.spec.ts` runs `@axe-core/playwright` (rules `wcag2a`, `wcag2aa`,
  `wcag21a`, `wcag21aa`, `wcag22aa`) and fails on any serious or critical finding. It covers the start
  screen, the tree screen with a person page, each chart kind with its outline open, and the dialogs of
  every screen (add person, edit event, family group sheet, Ahnentafel, relationship, merge, sources,
  records search, AI assistant, media, places, packs and census, inbox, backups, duplicates, export, chart
  export), in both themes. The dialogs are opened with nothing in them beyond what a new tree holds; a
  dialog with a long result list is not audited with that list.
  The tests start the app with `colorScheme: null` (`e2e/fixtures.ts`): Playwright otherwise makes every page
  report a light scheme, and the dark theme would never be audited. The spec sets the theme with
  `nativeTheme.themeSource`, as the theme button does.
- The same spec runs axe on the tree screen and on the ancestor and fan charts with `forced-colors`, and on
  the tree screen with reduced motion; it checks that the rule for reduced motion is in force (animation and
  transition shortened to nothing, no smooth scrolling). The app has no animation of its own. It walks
  through the app with the keyboard alone (create a tree, add a person and a parent, edit an event, open a
  chart, move to the parent through the outline, open the family group sheet and close it with Escape,
  asserting after each step which control has the focus), and checks the page at 200%.
- Run it with `node ../../node_modules/@playwright/test/cli.js test --project=built e2e/accessibility.spec.ts`
  from `apps/desktop` after `pnpm build`.
- axe cannot judge everything. It does not hear a screen reader, and it does not check the order of
  reading or whether a name makes sense. Narrator is checked by a person (below).

## Known gaps

- Narrator has not been run against the app by the author; the table below is for the owner.
- A failed form says what is wrong in a message (`role="alert"`) under the form, not next to the field it
  is about. Fields of the start screen and the dialogs are not marked `aria-invalid`.
- The marks on the map of a life are drawn pictures; the numbered buttons in the list under the map are
  the keyboard and screen reader way to pick a place.
- The pictures and documents themselves (scans) have only the title and the note the user wrote.
- The preview of a report is a page in a frame; it is read by a screen reader only as far as the frame lets
  it, and the saved PDF is not tagged for accessibility.
- Text sizes are fixed in pixels; zooming the page (Ctrl and +) scales them, but a Windows "text size"
  setting alone does not.

## Narrator checklist

Start Narrator with Ctrl+Win+Enter and stop it the same way. Use Tab, Shift+Tab, the arrow keys, Enter and
Escape. Caps Lock+H reads headings ("Narrator key" is Caps Lock or Insert). Fill in the table at the end.

| Screen                               | What to do                                                  | What Narrator should say                                                                 | Listen for                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Start screen                         | Open the app                                                | "RulZ Kinspora, heading level 1"                                                         | The name of the tree field is "Name of the tree, edit"                                                        |
| Start screen                         | Tab through                                                 | Each button by its name; "Open <name of tree>" in the list of trees                      | No unnamed button                                                                                             |
| Start screen                         | Press Create tree with the name empty                       | "Give the tree a name first."                                                            | The message is read without moving the focus                                                                  |
| Tree screen                          | Create or open a tree                                       | The name of the tree, heading level 1                                                    | The focus is on the title, not lost                                                                           |
| Tree screen                          | Press Tab once, then Enter on the first link                | "Skip to the main part of the screen"; the focus goes to the person or the empty message |                                                                                                               |
| Tree screen                          | Search box, then the list                                   | "Search this tree by name, search"; each row by name and years; the chosen row "current" | Up and Down move between rows                                                                                 |
| Person page                          | Choose a person                                             | The name as heading level 2; sections as headings level 3                                | Heading navigation (Caps Lock+H) finds each section                                                           |
| Person page                          | Events table                                                | "Events, table"; column headers Event, Date, Place, Details                              | Each Edit and Delete says which event                                                                         |
| Person page                          | Delete an event                                             | Focus moves to the next row or to "Add an event"                                         | The focus is not lost                                                                                         |
| Add a person                         | Press Add person                                            | "Add a person, dialog"; the focus is in "Given names"                                    | Escape closes it and the focus returns to Add person                                                          |
| Add a person                         | Type a date like 12 Mar 1881                                | The field reads "Read as: 12 March 1881" after its name                                  |                                                                                                               |
| Edit an event                        | Press Edit on an event                                      | "Edit event, dialog"                                                                     | The date field has its hint read                                                                              |
| Chart                                | Press Chart                                                 | The person's name as heading; "Kind of chart, radio group"                               | Arrow keys change the kind and Narrator says the new one; "Ancestor chart of <name>, 4 generations is shown." |
| Chart                                | Open "Text outline of this chart" and walk it               | A list with the person, then the father and mother                                       | A name moves the chart and the focus stays in the outline                                                     |
| Chart                                | Tab through the drawing                                     | Each box by name and years                                                               |                                                                                                               |
| Family group sheet                   | Press Family group sheet                                    | "Family group sheet, dialog"; family, paper, include living people                       | The preview frame is named "Preview of the family group sheet"; Escape closes it                              |
| Save or print a chart                | Press Save or print in the chart                            | "Save or print this chart, dialog"                                                       | Saved or printed message is read                                                                              |
| Sources, Places, Packs, Media, Inbox | Press each button on the top bar                            | Its name as the dialog's name; list and buttons by name                                  | Escape returns to the button                                                                                  |
| Search records                       | Press Search records on a person                            | The dialog; each result with the buttons for it                                          | While a search runs and when it ends, the status text in the window is read                                   |
| AI assistant                         | Press AI assistant                                          | "AI assistant, dialog"                                                                   | The session notice is read                                                                                    |
| Backups                              | Press Backups, then Restore on a backup                     | The question is read and the focus is on Cancel                                          | Cancel returns the focus to the list                                                                          |
| High contrast                        | Turn on a high contrast theme (Alt+Left Shift+Print Screen) | Not Narrator: look at the screen                                                         | Borders on buttons and boxes; the chosen row, kind of chart and place stand out                               |
| 200%                                 | Ctrl and + until 200%                                       | Not Narrator: look at the screen                                                         | Nothing cut off; the page scrolls up and down only                                                            |

| Checked by | Date | Screen reader and version | Result |
| ---------- | ---- | ------------------------- | ------ |
|            |      |                           |        |
|            |      |                           |        |
