import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  addPerson,
  answerFilePicker,
  answerSaveDialog,
  createTree,
  expect,
  openPerson,
  test,
} from './fixtures';

/** The row of an event on the person page, found by the event's name. */
function eventRow(window: Page, label: string) {
  return window.getByTestId('event-row').filter({ hasText: label });
}

/** Chooses a source in the list of the "add a source" form. */
async function pickSource(window: Page, search: string): Promise<void> {
  await window.getByTestId('source-search').fill(search);
  const found = window.getByTestId('source-option').filter({ hasText: search });
  await expect(found).toHaveCount(1);
  await found.locator('input').check();
}

test('records where a fact comes from, and uses the same citation for another fact', async ({
  window,
}) => {
  await createTree(window, 'Sources');
  await addPerson(window, {
    given: 'John',
    surname: 'Hale',
    birthDate: '1870',
    deathDate: '1931',
  });
  await expect(window.getByTestId('sources-section')).toContainText('No sources recorded');
  await expect(eventRow(window, 'Birth').getByTestId('event-sources')).toHaveText('Sources');

  // A first source for the birth: there is none in the tree yet, so it is a new one.
  await eventRow(window, 'Birth').getByTestId('event-sources').click();
  const dialog = window.getByTestId('fact-sources-dialog');
  await expect(dialog).toContainText('Sources for the birth of John Hale');
  await expect(window.getByTestId('fact-sources-empty')).toBeVisible();
  await window.getByTestId('add-citation').click();
  await expect(window.getByTestId('citation-mode-existing')).toBeDisabled();
  await expect(window.getByTestId('citation-mode-new')).toBeChecked();
  // A source needs a title before it can be added.
  await expect(window.getByTestId('citation-submit')).toBeDisabled();
  await window.getByTestId('source-title').fill('Parish register of York');
  await window.getByTestId('source-author').fill('Church of England');
  await window.getByTestId('citation-page').fill('Baptisms 1870, page 12');
  await window.getByTestId('citation-text').fill('John, son of Thomas Hale');
  await window
    .getByTestId('citation-quality')
    .selectOption({ label: 'Direct and primary evidence' });
  await window.getByTestId('citation-submit').click();

  await expect(window.getByTestId('fact-source')).toHaveCount(1);
  await expect(window.getByTestId('fact-source')).toContainText('Parish register of York');
  await expect(window.getByTestId('fact-source')).toContainText('Baptisms 1870, page 12');
  await expect(window.getByTestId('fact-source')).toContainText('John, son of Thomas Hale');
  await expect(window.getByTestId('fact-source')).toContainText('Direct and primary evidence');
  await window.getByTestId('fact-sources-close').click();
  await expect(dialog).toHaveCount(0);

  await expect(eventRow(window, 'Birth').getByTestId('event-sources')).toHaveText('Sources (1)');
  await expect(window.getByTestId('person-citation')).toHaveCount(1);
  await expect(window.getByTestId('person-citation-uses')).toHaveText('Birth');
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add citation (Ctrl+Z)');

  // The same entry also gives his name: the citation is used again, not written twice.
  await window.getByTestId('name-sources').click();
  await window.getByTestId('add-citation').click();
  await expect(window.getByTestId('citation-mode-existing')).toBeChecked();
  await pickSource(window, 'Parish');
  await expect(window.getByTestId('citation-reuse')).toContainText('Baptisms 1870, page 12');
  await window.getByTestId('citation-reuse-option').check();
  await expect(window.getByTestId('citation-page')).toHaveCount(0);
  await window.getByTestId('citation-submit').click();
  await expect(window.getByTestId('fact-source')).toContainText('Also supports 1 other fact');
  await window.getByTestId('fact-sources-close').click();
  await expect(window.getByTestId('person-citation')).toHaveCount(1);
  await expect(window.getByTestId('person-citation-uses')).toHaveText('Name, Birth');

  // Another place in the same source, for the death.
  await eventRow(window, 'Death').getByTestId('event-sources').click();
  await window.getByTestId('add-citation').click();
  await pickSource(window, 'church');
  await window.getByTestId('citation-reuse-none').check();
  await window.getByTestId('citation-page').fill('Burials 1931, page 3');
  await window.getByTestId('citation-submit').click();
  await expect(window.getByTestId('fact-source')).toContainText('Burials 1931, page 3');
  await window.getByTestId('fact-sources-close').click();
  await expect(window.getByTestId('person-citation')).toHaveCount(2);

  // Editing the shared citation changes it once, for both facts.
  await window.getByTestId('edit-person-citation').first().click();
  await expect(window.getByTestId('citation-shared')).toBeVisible();
  await window.getByTestId('citation-page').fill('Baptisms 1870, page 13');
  await window.getByTestId('citation-note').fill('The page number was misread at first');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('citation-dialog')).toHaveCount(0);
  await expect(window.getByTestId('person-citation').first()).toContainText('page 13');
  await eventRow(window, 'Birth').getByTestId('event-sources').click();
  await expect(window.getByTestId('fact-source')).toContainText('page 13');
  await expect(window.getByTestId('fact-source')).toContainText('The page number was misread');

  // Taken away from the birth, it still supports the name.
  await window.getByTestId('remove-citation').click();
  await expect(window.getByTestId('fact-sources-empty')).toBeVisible();
  await window.getByTestId('fact-sources-close').click();
  await expect(eventRow(window, 'Birth').getByTestId('event-sources')).toHaveText('Sources');
  await expect(window.getByTestId('person-citation-uses').first()).toHaveText('Name');

  // Undo puts it back under the birth.
  await window.getByTestId('undo').click();
  await expect(window.getByTestId('workspace-notice')).toHaveText(/Undone: Remove citation\./);
  await expect(eventRow(window, 'Birth').getByTestId('event-sources')).toHaveText('Sources (1)');
});

test('lists the sources of a tree, and edits and deletes one', async ({ window }) => {
  await createTree(window, 'Source list');
  await addPerson(window, { given: 'Ann', surname: 'Lee', birthDate: '1850' });

  await window.getByTestId('open-sources').click();
  await expect(window.getByTestId('sources-empty')).toHaveText('This tree has no sources yet.');

  // A source can be added before anything cites it.
  await window.getByTestId('add-source').click();
  await window.getByTestId('source-title').fill('1851 Census of England');
  await window.getByTestId('source-author').fill('General Register Office');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('source-dialog')).toContainText('1851 Census of England');
  await expect(window.getByTestId('source-citation-count')).toHaveText('Not cited yet');
  await expect(window.getByTestId('source-save')).toBeDisabled();

  // Its details are edited in place.
  await window.getByTestId('source-publication').fill('The National Archives, Kew');
  await window.getByTestId('source-save').click();
  await expect(window.getByTestId('source-save')).toBeDisabled();
  await window.getByTestId('source-close').click();
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Edit source (Ctrl+Z)');

  // Cite it for the birth, then see the citation on the source's own page.
  await eventRow(window, 'Birth').getByTestId('event-sources').click();
  await window.getByTestId('add-citation').click();
  await pickSource(window, '1851');
  await window.getByTestId('citation-page').fill('Piece 2101, folio 44');
  await window.getByTestId('citation-submit').click();
  await window.getByTestId('fact-sources-close').click();

  await window.getByTestId('open-sources').click();
  await expect(window.getByTestId('source-row')).toHaveCount(1);
  await expect(window.getByTestId('source-cited')).toHaveText('1 time');
  // The search narrows the list by title or author.
  await window.getByTestId('sources-search').fill('nothing like it');
  await expect(window.getByTestId('sources-empty')).toHaveText(
    'No source has that in its title or author.',
  );
  await window.getByTestId('sources-search').fill('register office');
  await window.getByTestId('open-source').click();
  await expect(window.getByTestId('source-publication')).toHaveValue('The National Archives, Kew');
  await expect(window.getByTestId('source-citation-count')).toHaveText('Cited 1 time');
  await expect(window.getByTestId('source-citation')).toContainText('Piece 2101, folio 44');
  await expect(window.getByTestId('citation-uses')).toHaveText('Birth of Ann Lee');

  // Deleting the source takes its citations with it; Undo brings both back.
  await window.getByTestId('delete-source').click();
  await expect(window.getByTestId('confirm-dialog')).toContainText(
    '1 citation of this source is deleted with it',
  );
  await window.getByTestId('confirm-dialog').getByTestId('dialog-submit').click();
  await expect(window.getByTestId('sources-empty')).toBeVisible();
  await window.getByTestId('sources-close').click();
  await expect(eventRow(window, 'Birth').getByTestId('event-sources')).toHaveText('Sources');
  await window.getByTestId('undo').click();
  await expect(eventRow(window, 'Birth').getByTestId('event-sources')).toHaveText('Sources (1)');

  // From the source's page, a person it names can be opened.
  await addPerson(window, { given: 'Tom', surname: 'Lee' });
  await window.getByTestId('open-sources').click();
  await window.getByTestId('open-source').click();
  await window.getByTestId('citation-person').click();
  await expect(window.getByTestId('source-dialog')).toHaveCount(0);
  await expect(window.getByTestId('person-name')).toHaveText('Ann Lee');
});

const HEADER = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8'];
const BODY = [
  '0 @U1@ SUBM',
  '1 NAME A tester',
  '0 @I1@ INDI',
  '1 NAME John /Hale/',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 _APID 1,7602::11',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1870',
  '2 SOUR @S1@',
  '3 PAGE Sheet 4B',
  '3 _APID 1,7602::11',
  '1 DEAT',
  '2 DATE 1931',
  '0 @S1@ SOUR',
  '1 TITL 1900 United States Federal Census',
  '1 AUTH Ancestry.com',
  '1 REPO @R1@',
  '0 @R1@ REPO',
  '1 NAME Ancestry.com',
  '0 TRLR',
];

/** The lines of a GEDCOM file after its header record, without the byte-order mark it starts with. */
function bodyOf(text: string): string[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\r\n');
  return lines.slice(lines.findIndex((line, index) => index > 0 && line.startsWith('0 ')));
}

test('reads the sources of a GEDCOM file, and writes a changed one back in every place', async ({
  app,
  window,
  userDataDir,
}) => {
  const file = join(userDataDir, 'Hale.ged');
  writeFileSync(file, [...HEADER, ...BODY, ''].join('\r\n'));
  await answerFilePicker(app, file);
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('workspace')).toBeVisible();
  await expect(window.getByTestId('import-notice')).toContainText('and 1 source from Hale.ged');

  // The file writes the citation twice; the app shows it once, for both facts.
  await openPerson(window, 'Hale, John');
  await expect(window.getByTestId('person-citation')).toHaveCount(1);
  await expect(window.getByTestId('person-citation')).toContainText(
    '1900 United States Federal Census',
  );
  await expect(window.getByTestId('person-citation-uses')).toHaveText('Name, Birth');
  await expect(window.getByTestId('kept-section')).toHaveCount(0);

  // The source's page shows what the app has no fields for.
  await window.getByTestId('open-sources').click();
  await window.getByTestId('open-source').click();
  await expect(window.getByTestId('source-author')).toHaveValue('Ancestry.com');
  await expect(window.getByTestId('source-citation')).toHaveCount(1);
  await expect(window.getByTestId('citation-uses').locator('li')).toHaveText([
    'The name of John Hale',
    'Birth of John Hale',
  ]);
  await window.getByTestId('source-kept').locator('summary').click();
  await expect(window.getByTestId('kept-lines')).toHaveText(['1 REPO @R1@']);
  await window.getByTestId('source-close').click();

  // Exported untouched, the file comes back as it was.
  const untouched = join(userDataDir, 'untouched.ged');
  await answerSaveDialog(app, untouched);
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-include-living').check();
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-done')).toBeVisible();
  await window.getByTestId('export-close').click();
  expect(bodyOf(readFileSync(untouched, 'utf8'))).toEqual([...BODY, '']);

  // One edit of the citation, and the death cited from the same entry.
  await window.getByTestId('edit-person-citation').click();
  await window.getByTestId('citation-page').fill('Sheet 5A');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('citation-dialog')).toHaveCount(0);
  await eventRow(window, 'Death').getByTestId('event-sources').click();
  await window.getByTestId('add-citation').click();
  await pickSource(window, 'Census');
  await window.getByTestId('citation-reuse-option').check();
  await window.getByTestId('citation-submit').click();
  await window.getByTestId('fact-sources-close').click();
  await expect(window.getByTestId('person-citation-uses')).toHaveText('Name, Birth, Death');

  const changed = join(userDataDir, 'changed.ged');
  await answerSaveDialog(app, changed);
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-include-living').check();
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-done')).toBeVisible();
  // The page changed in both places, and the death carries the same lines, Ancestry's own included.
  expect(bodyOf(readFileSync(changed, 'utf8'))).toEqual([
    '0 @U1@ SUBM',
    '1 NAME A tester',
    '0 @I1@ INDI',
    '1 NAME John /Hale/',
    '2 SOUR @S1@',
    '3 PAGE Sheet 5A',
    '3 _APID 1,7602::11',
    '1 SEX M',
    '1 BIRT',
    '2 DATE 1870',
    '2 SOUR @S1@',
    '3 PAGE Sheet 5A',
    '3 _APID 1,7602::11',
    '1 DEAT',
    '2 DATE 1931',
    '2 SOUR @S1@',
    '3 PAGE Sheet 5A',
    '3 _APID 1,7602::11',
    '0 @S1@ SOUR',
    '1 TITL 1900 United States Federal Census',
    '1 AUTH Ancestry.com',
    '1 REPO @R1@',
    '0 @R1@ REPO',
    '1 NAME Ancestry.com',
    '0 TRLR',
    '',
  ]);
});
