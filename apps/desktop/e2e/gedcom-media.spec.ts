import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerFilePicker,
  answerFilesPicker,
  answerFolderPicker,
  answerSaveDialog,
  expect,
  openPerson,
  test,
  writePng,
} from './fixtures';

/** The files in a tree's media folder, by name. */
function storedFiles(treeDir: string): string[] {
  const root = join(treeDir, 'media');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((folder) => readdirSync(join(root, folder)));
}

test('finds the pictures a GEDCOM file names, and takes them along in a GEDZip file', async ({
  app,
  window,
  userDataDir,
}) => {
  // The pictures as another program kept them, and the file it wrote. The
  // file names a portrait by the path it had on another computer, a scan by
  // a path beside the file, and a picture on a website that is long gone.
  const old = join(userDataDir, 'Old PC');
  mkdirSync(join(old, 'Tree Media'), { recursive: true });
  mkdirSync(join(old, 'scans'), { recursive: true });
  writePng(join(old, 'Tree Media', 'ann.png'), 800, 600, 1);
  writePng(join(old, 'scans', 'register.png'), 640, 480, 2);
  const gedcom = join(userDataDir, 'Lee family.ged');
  writeFileSync(
    gedcom,
    [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 5.5.1',
      '2 FORM LINEAGE-LINKED',
      '1 CHAR UTF-8',
      '0 @U1@ SUBM',
      '1 NAME Ann Lee',
      '0 @I1@ INDI',
      '1 NAME Ann /Lee/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1 JAN 1900',
      '2 OBJE',
      '3 FILE scans/register.png',
      '4 FORM png',
      '3 TITL Register, page 4',
      '1 DEAT',
      '2 DATE 1980',
      '1 OBJE @M1@',
      '1 OBJE @M2@',
      '0 @M1@ OBJE',
      '1 FILE C:\\Somewhere Else\\Tree Media\\ann.png',
      '2 FORM png',
      '2 TITL Ann Lee',
      '0 @M2@ OBJE',
      '1 FILE https://example.com/lost.jpg',
      '2 FORM jpg',
      '2 TITL Lost picture',
      '0 TRLR',
      '',
    ].join('\r\n'),
  );

  await answerFilePicker(app, gedcom);
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('tree-name')).toHaveText('Lee family');
  await window.getByTestId('import-details').click();
  await expect(window.getByTestId('import-report-media')).toContainText(
    'The file names 3 pictures and documents. A GEDCOM file does not hold the files themselves.',
  );
  await expect(window.getByTestId('import-report-media')).toContainText(
    '“Find the files in a folder” there looks for them',
  );
  await window.getByTestId('import-report-close').click();
  await window.getByTestId('import-dismiss').click();
  const firstTree = join(userDataDir, 'Trees', 'Lee family');
  expect(storedFiles(firstTree)).toEqual([]);

  // The person's page shows what the file says of each picture, and that none is here.
  await openPerson(window, 'Lee, Ann');
  const tiles = window.getByTestId('media-section').getByTestId('media-tile');
  await expect(tiles.getByTestId('media-caption')).toHaveText([
    'Ann Lee',
    'Lost picture',
    'Register, page 4',
  ]);
  await expect(tiles.getByTestId('media-not-held')).toHaveCount(3);
  await tiles.first().click();
  await expect(window.getByTestId('media-not-held-message')).toContainText(
    'names this picture or document and does not hold it',
  );
  await expect(window.getByTestId('media-origin')).toHaveText(
    'C:\\Somewhere Else\\Tree Media\\ann.png',
  );
  await expect(window.getByTestId('media-open')).toHaveCount(0);
  await window.getByTestId('media-close').click();

  // Looking in the folder the pictures are in now finds two of the three, in one step.
  await window.getByTestId('open-media').click();
  await expect(window.getByTestId('library-named')).toContainText('3 files are named');
  await answerFolderPicker(app, null);
  await window.getByTestId('library-find').click();
  await expect(window.getByTestId('library-found')).toHaveCount(0);
  await answerFolderPicker(app, old);
  await window.getByTestId('library-find').click();
  await expect(window.getByTestId('library-found')).toHaveText(
    'Found 2 of 3 files and took a copy of each.',
  );
  await expect(window.getByTestId('library-named')).toContainText('1 file is named');
  expect(storedFiles(firstTree)).toHaveLength(2);
  // The pictures the other program kept are still where they were.
  expect(existsSync(join(old, 'Tree Media', 'ann.png'))).toBe(true);

  // The one that is left is given by hand.
  await window.getByTestId('library-not-held').check();
  const left = window.getByTestId('library-list').getByTestId('media-tile');
  await expect(left.getByTestId('media-caption')).toHaveText(['Lost picture']);
  await left.first().click();
  await expect(window.getByTestId('media-origin-link')).toHaveAttribute(
    'href',
    'https://example.com/lost.jpg',
  );
  await answerFilesPicker(app, []);
  await window.getByTestId('media-choose').click();
  await expect(window.getByTestId('media-not-held-message')).toBeVisible();
  await answerFilesPicker(app, [writePng(join(userDataDir, 'found after all.png'), 400, 300, 3)]);
  await window.getByTestId('media-choose').click();
  await expect(window.getByTestId('media-image')).toBeVisible();
  await expect(window.getByTestId('media-pixels')).toHaveText('400 × 300 dots');
  await expect(window.getByTestId('media-facts')).toContainText('https://example.com/lost.jpg');
  await window.getByTestId('media-close').click();
  await expect(window.getByTestId('library-none')).toBeVisible();
  await expect(window.getByTestId('library-named')).toHaveCount(0);
  await window.getByTestId('library-close').click();
  await expect(tiles.getByTestId('media-not-held')).toHaveCount(0);
  await expect(window.getByTestId('undo')).toBeEnabled();

  // A GEDZip file carries the three pictures.
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-with-files').check();
  await window.getByTestId('export-include-living').check();
  await answerSaveDialog(app, join(userDataDir, 'Lee with pictures'));
  await window.getByTestId('export-submit').click();
  const packed = join(userDataDir, 'Lee with pictures.gdz');
  await expect(window.getByTestId('export-file')).toHaveText(packed);
  await expect(window.getByTestId('export-media')).toHaveText(
    'The file holds 3 pictures and documents.',
  );
  await window.getByTestId('export-close').click();
  // A zip file starts with "PK".
  expect(readFileSync(packed).subarray(0, 2).toString('latin1')).toBe('PK');

  // A GEDCOM file on its own still names them as the imported file did.
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-include-living').check();
  await answerSaveDialog(app, join(userDataDir, 'names only.ged'));
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-media')).toContainText(
    'The file names 3 pictures and documents and does not hold them.',
  );
  await window.getByTestId('export-close').click();
  const named = readFileSync(join(userDataDir, 'names only.ged'), 'utf8');
  expect(named).toContain('1 FILE C:\\Somewhere Else\\Tree Media\\ann.png');
  expect(named).toContain('3 FILE scans/register.png');

  // Imported into a new tree, the GEDZip file brings its pictures with it.
  await window.getByTestId('close-tree').click();
  await answerFilePicker(app, packed);
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('tree-name')).toHaveText('Lee with pictures');
  await window.getByTestId('import-details').click();
  await expect(window.getByTestId('import-report-media')).toHaveText(
    'The file names 3 pictures and documents. They came with the file and are in the tree.',
  );
  await window.getByTestId('import-report-close').click();
  expect(storedFiles(join(userDataDir, 'Trees', 'Lee with pictures'))).toHaveLength(3);

  await openPerson(window, 'Lee, Ann');
  await expect(tiles.getByTestId('media-caption')).toHaveText([
    'Ann Lee',
    'Lost picture',
    'Register, page 4',
  ]);
  await expect(tiles.getByTestId('media-not-held')).toHaveCount(0);
  await tiles.first().click();
  await expect(window.getByTestId('media-image')).toBeVisible();
  await expect(window.getByTestId('media-pixels')).toHaveText('800 × 600 dots');
  await window.getByTestId('media-close').click();
});
