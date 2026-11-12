import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  addPerson,
  answerFilesPicker,
  answerSaveDialog,
  catchFilesHandedOver,
  createTree,
  expect,
  handedOver,
  launchApp,
  openPerson,
  test,
  writePng,
} from './fixtures';

/** The row of an event on the person page, found by the event's name. */
function eventRow(window: Page, label: string) {
  return window.getByTestId('event-row').filter({ hasText: label });
}

/** The full paths of the files in a tree's media folder. */
function storedFiles(treeDir: string): string[] {
  const root = join(treeDir, 'media');
  return readdirSync(root).flatMap((folder) =>
    readdirSync(join(root, folder)).map((name) => join(root, folder, name)),
  );
}

/** Waits until the small picture of a tile has been drawn, and gives its width in dots. */
async function thumbWidth(tile: Locator): Promise<number> {
  const thumb = tile.getByTestId('media-thumb');
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)))
    .toBeGreaterThan(0);
  return thumb.evaluate((img: HTMLImageElement) => img.naturalWidth);
}

/** The size and place of an element in the window. */
async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element is not on screen');
  return box;
}

test('attaches a scan to a citation and shows it at full size', async ({
  app,
  window,
  userDataDir,
}) => {
  const scan = writePng(join(userDataDir, 'baptism 1870.png'), 1600, 1200);
  await createTree(window, 'Scans');
  await addPerson(window, { given: 'John', surname: 'Hale', birthDate: '1870' });
  const section = window.getByTestId('media-section');
  await expect(section).toContainText('No pictures or documents attached');

  // Say where the birth comes from.
  await eventRow(window, 'Birth').getByTestId('event-sources').click();
  await window.getByTestId('add-citation').click();
  await window.getByTestId('source-title').fill('Parish register of York');
  await window.getByTestId('citation-page').fill('Baptisms 1870, page 12');
  await window.getByTestId('citation-submit').click();
  const cited = window.getByTestId('fact-source');
  await expect(cited).toHaveCount(1);

  // Attach the scan of that page to the citation.
  await answerFilesPicker(app, [scan]);
  await cited.getByTestId('add-media').click();
  const tile = cited.getByTestId('media-tile');
  await expect(tile).toHaveCount(1);
  await expect(tile.getByTestId('media-caption')).toHaveText('baptism 1870.png');
  expect(await thumbWidth(tile)).toBeGreaterThan(0);
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add file (Ctrl+Z)');

  // The file is copied into the tree's own folder, under the hash of its contents.
  const stored = storedFiles(join(userDataDir, 'Trees', 'Scans'));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatch(/[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.png$/);
  expect(readFileSync(stored[0] ?? '').equals(readFileSync(scan))).toBe(true);

  // Look at it. It starts with the whole scan in view, smaller than it really is.
  await tile.click();
  const viewer = window.getByTestId('media-viewer');
  await expect(viewer).toBeVisible();
  await expect(window.getByTestId('media-pixels')).toHaveText(/^1.600 × 1.200 dots$/);
  const zoom = window.getByTestId('media-zoom');
  const image = window.getByTestId('media-image');
  const stage = window.getByTestId('media-stage');
  await expect(zoom).toHaveText(/^\d+%$/);
  const fitted = (await zoom.textContent()) ?? '';
  expect(Number.parseInt(fitted, 10)).toBeGreaterThan(10);
  expect(Number.parseInt(fitted, 10)).toBeLessThan(100);
  const area = await boxOf(stage);
  const whole = await boxOf(image);
  expect(whole.width).toBeLessThanOrEqual(area.width + 1);
  expect(whole.height).toBeLessThanOrEqual(area.height + 1);
  await expect(window.getByTestId('media-fit')).toBeDisabled();

  // Full size: the scan is drawn as large as it is, and only part of it is in view.
  await window.getByTestId('media-actual').click();
  await expect(zoom).toHaveText('100%');
  const full = await boxOf(image);
  expect(Math.round(full.width)).toBe(1600);
  expect(Math.round(full.height)).toBe(1200);
  expect(full.width).toBeGreaterThan(area.width);

  // Dragging moves it.
  const middle = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  await window.mouse.move(middle.x, middle.y);
  await window.mouse.down();
  await window.mouse.move(middle.x - 120, middle.y - 80, { steps: 6 });
  await window.mouse.up();
  const moved = await boxOf(image);
  expect(Math.round(full.x - moved.x)).toBe(120);
  expect(Math.round(full.y - moved.y)).toBe(80);
  await expect(zoom).toHaveText('100%');

  // Closer still with the button, back to the whole scan, and in again with the wheel.
  await window.getByTestId('media-zoom-in').click();
  await expect(zoom).toHaveText('125%');
  await window.getByTestId('media-fit').click();
  await expect(zoom).toHaveText(fitted);
  await window.mouse.move(middle.x, middle.y);
  await window.mouse.wheel(0, -200);
  await expect(zoom).not.toHaveText(fitted);
  expect(Number.parseInt((await zoom.textContent()) ?? '', 10)).toBeGreaterThan(
    Number.parseInt(fitted, 10),
  );

  // Say what it is.
  await window.getByTestId('media-title').fill('Baptism of John Hale, 1870');
  await window.getByTestId('media-description').fill('Entry 4 on the page.');
  await window.getByTestId('media-save').click();
  await expect(window.getByTestId('media-save')).toBeDisabled();
  await expect(viewer.locator('h2')).toHaveText('Baptism of John Hale, 1870');
  await expect(window.getByTestId('media-use')).toHaveCount(1);
  await expect(window.getByTestId('media-use')).toContainText(
    'A citation of Parish register of York, Baptisms 1870, page 12 (about John Hale)',
  );
  await window.getByTestId('media-close').click();
  await expect(viewer).toHaveCount(0);
  await expect(tile.getByTestId('media-caption')).toHaveText('Baptism of John Hale, 1870');
  await window.getByTestId('fact-sources-close').click();

  // The person's page lists the scan with the source it belongs to.
  await expect(section.getByTestId('media-tile')).toHaveCount(1);
  await expect(section.getByTestId('media-note')).toHaveText('Source: Parish register of York');
  await expect(window.getByTestId('undo')).toHaveAttribute(
    'title',
    'Undo Edit file details (Ctrl+Z)',
  );

  // So does the form for the citation itself.
  await window.getByTestId('edit-person-citation').click();
  const form = window.getByTestId('citation-dialog');
  await expect(form.getByTestId('media-tile')).toHaveCount(1);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);

  // And the list of every file in the tree, where it is found by its title.
  await window.getByTestId('open-media').click();
  const library = window.getByTestId('media-library');
  await expect(library.getByTestId('media-tile')).toHaveCount(1);
  await expect(window.getByTestId('library-count')).toHaveText('1 file');
  await window.getByTestId('library-search').fill('baptism');
  await expect(library.getByTestId('media-tile')).toHaveCount(1);
  await window.getByTestId('library-search').fill('wedding');
  await expect(window.getByTestId('library-none')).toBeVisible();
  await window.getByTestId('library-search').fill('');
  await window.getByTestId('library-unattached').check();
  await expect(window.getByTestId('library-none')).toBeVisible();
  await window.getByTestId('library-close').click();
  await expect(library).toHaveCount(0);
});

test('keeps the pictures and documents of a person, takes them away and brings them back', async ({
  app,
  window,
  userDataDir,
}) => {
  const portrait = writePng(join(userDataDir, 'portrait.png'), 300, 400, 1);
  const wedding = writePng(join(userDataDir, 'wedding.png'), 640, 480, 2);
  const notes = join(userDataDir, 'notes.txt');
  writeFileSync(notes, 'Seen at the record office in York.');
  const program = join(userDataDir, 'setup.exe');
  writeFileSync(program, 'MZ this is not really a program');
  await catchFilesHandedOver(app);

  await createTree(window, 'Album');
  await addPerson(window, { given: 'John', surname: 'Hale', birthDate: '1870' });
  const section = window.getByTestId('media-section');
  const tiles = section.getByTestId('media-tile');
  const add = window.getByTestId('add-person-media');

  // A cancelled file dialog adds nothing.
  await answerFilesPicker(app, []);
  await add.click();
  await expect(add).toBeEnabled();
  await expect(tiles).toHaveCount(0);

  // Two pictures in one go are one step.
  await answerFilesPicker(app, [portrait, wedding]);
  await add.click();
  await expect(tiles).toHaveCount(2);
  await expect(tiles.getByTestId('media-caption')).toHaveText(['portrait.png', 'wedding.png']);
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add files (Ctrl+Z)');

  // The same picture again is not a second file.
  await answerFilesPicker(app, [portrait]);
  await add.click();
  await expect(section.getByTestId('media-message')).toHaveText(
    '1 file was attached here already.',
  );
  await expect(tiles).toHaveCount(2);

  // The portrait is also a picture of the birth: the file the tree holds is attached there.
  await eventRow(window, 'Birth').getByTestId('event-media').click();
  const dialog = window.getByTestId('target-media-dialog');
  await expect(dialog).toContainText('Pictures and documents of the birth of John Hale');
  await expect(dialog.getByTestId('media-empty')).toHaveText('Nothing is attached to this yet.');
  await answerFilesPicker(app, [portrait]);
  await dialog.getByTestId('add-media').click();
  await expect(dialog.getByTestId('media-tile')).toHaveCount(1);
  await window.getByTestId('target-media-close').click();
  await expect(eventRow(window, 'Birth').getByTestId('event-media')).toHaveText('Files (1)');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.first().getByTestId('media-note')).toHaveText('Birth');
  expect(storedFiles(join(userDataDir, 'Trees', 'Album'))).toHaveLength(2);

  // The viewer says what a file is attached to, and takes it away from one of them.
  await tiles.first().click();
  const uses = window.getByTestId('media-use');
  await expect(uses).toHaveCount(2);
  await expect(uses.nth(0)).toContainText('John Hale');
  await expect(uses.nth(1)).toContainText('The birth of John Hale');
  await uses.nth(1).getByTestId('media-detach').click();
  await expect(uses).toHaveCount(1);

  // Deleted from the tree, it goes from the page; its copy stays on the disk for Undo.
  await window.getByTestId('media-delete').click();
  await expect(window.getByTestId('confirm-dialog')).toContainText(
    'its copy stays in the media folder',
  );
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('media-viewer')).toHaveCount(0);
  await expect(tiles).toHaveCount(1);
  await expect(eventRow(window, 'Birth').getByTestId('event-media')).toHaveText('Files');
  expect(storedFiles(join(userDataDir, 'Trees', 'Album'))).toHaveLength(2);

  await window.getByTestId('undo').click();
  await expect(window.getByTestId('workspace-notice')).toHaveText(/Undone: Delete file\./);
  await expect(tiles).toHaveCount(2);
  expect(await thumbWidth(tiles.first())).toBeGreaterThan(0);
  await window.getByTestId('undo').click();
  await expect(window.getByTestId('workspace-notice')).toHaveText(/Undone: Remove file\./);
  await expect(eventRow(window, 'Birth').getByTestId('event-media')).toHaveText('Files (1)');

  // A document is kept too. The app does not show it; it hands it to another program.
  await answerFilesPicker(app, [notes, program]);
  await add.click();
  await expect(tiles).toHaveCount(4);
  await tiles.filter({ hasText: 'notes.txt' }).click();
  await expect(window.getByTestId('media-document')).toContainText(
    'Open it in the program Windows uses for it',
  );
  await expect(window.getByTestId('media-stage')).toHaveCount(0);
  await window.getByTestId('media-open').click();
  await window.getByTestId('media-show').click();
  await expect.poll(() => handedOver(app)).toHaveLength(2);
  const [opened, shown] = await handedOver(app);
  expect(opened).toMatch(/^open .*[\\/]Album[\\/]media[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.txt$/);
  expect(shown).toBe(opened?.replace('open ', 'show '));
  await window.getByTestId('media-close').click();

  // A program is kept as well, and never started from the app.
  await tiles.filter({ hasText: 'setup.exe' }).click();
  await expect(window.getByTestId('media-document')).toContainText('Show it in its folder');
  await expect(window.getByTestId('media-open')).toHaveCount(0);
  await expect(window.getByTestId('media-show')).toBeVisible();
  await window.getByTestId('media-close').click();
  expect(await handedOver(app)).toHaveLength(2);

  // A GEDCOM file names the files and says that it does not hold them.
  await window.getByTestId('open-export').click();
  await answerSaveDialog(app, join(userDataDir, 'album.ged'));
  await expect(window.getByTestId('export-without-files')).toBeChecked();
  await window.getByTestId('export-include-living').check();
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-media')).toHaveText(
    'The file names 4 pictures and documents and does not hold them. Export a GEDZip file to take them along.',
  );
  await window.getByTestId('export-close').click();
  expect(readFileSync(join(userDataDir, 'album.ged'), 'utf8')).toContain('0 @M1@ OBJE');

  // So do the backups: they hold the tree's data, not the files.
  await window.getByTestId('open-backups').click();
  await expect(window.getByTestId('backups-media-note')).toContainText(
    '4 pictures and documents are files in the “media” folder beside it, and backups do not copy them',
  );
});

test('says when a file has gone from the tree folder, and takes it back', async ({
  app,
  window,
  userDataDir,
  appTarget,
}) => {
  const portrait = writePng(join(userDataDir, 'portrait.png'), 300, 400, 1);
  await createTree(window, 'Lost and found');
  await addPerson(window, { given: 'Ann', surname: 'Lee' });
  await answerFilesPicker(app, [portrait]);
  await window.getByTestId('add-person-media').click();
  await expect(window.getByTestId('media-section').getByTestId('media-tile')).toHaveCount(1);
  await app.close();

  // The file is deleted outside the app while it is closed.
  const stored = storedFiles(join(userDataDir, 'Trees', 'Lost and found'));
  expect(stored).toHaveLength(1);
  rmSync(stored[0] ?? '');

  const second = await launchApp(appTarget, userDataDir);
  try {
    const page = await second.firstWindow();
    await openPerson(page, 'Lee, Ann');
    const tile = page.getByTestId('media-section').getByTestId('media-tile');
    await expect(tile).toHaveCount(1);
    await expect(tile.getByTestId('media-missing')).toHaveText('File missing');
    await tile.click();
    await expect(page.getByTestId('media-absent')).toContainText(
      'is no longer in the media folder of this tree',
    );
    await expect(page.getByTestId('media-show')).toHaveCount(0);
    await page.getByTestId('media-close').click();

    // Adding the same file again puts it back where the tree expects it.
    await answerFilesPicker(second, [portrait]);
    await page.getByTestId('add-person-media').click();
    await expect(tile.getByTestId('media-missing')).toHaveCount(0);
    expect(await thumbWidth(tile)).toBeGreaterThan(0);
    expect(storedFiles(join(userDataDir, 'Trees', 'Lost and found'))).toEqual(stored);
  } finally {
    await second.close();
  }
});
