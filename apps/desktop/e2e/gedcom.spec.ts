import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ancestryStyleFile } from '../../../packages/db/src/gedcom/sample';
import {
  addPerson,
  answerFilePicker,
  answerSaveDialog,
  createTree,
  expect,
  openPerson,
  test,
} from './fixtures';

/** A small file in the style Ancestry writes, with a link the file itself gets wrong. */
const HEADER = [
  '0 HEAD',
  '1 SUBM @SUBM1@',
  '1 SOUR Ancestry.com Family Trees',
  '2 NAME Ancestry.com Member Trees',
  '1 GEDC',
  '2 VERS 5.5.1',
  '2 FORM LINEAGE-LINKED',
  '1 CHAR UTF-8',
];
const BODY = [
  '0 @SUBM1@ SUBM',
  '1 NAME Ancestry.com Member Trees Submitter',
  '0 @I1@ INDI',
  '1 NAME Johann /Müller/',
  '2 GIVN Johann',
  '2 SURN Müller',
  '2 SOUR @S1@',
  '3 PAGE Year: 1900; Census Place: Boston',
  '3 _APID 1,7602::1',
  '1 SEX M',
  '1 FAMS @F1@',
  '1 BIRT',
  '2 DATE 12 Mar 1850',
  '2 PLAC Boston, Suffolk, Massachusetts, USA',
  '1 RESI Age: 50; Relation to Head of House: Head',
  '2 DATE 1900',
  '1 _UID 1234ABCD',
  '1 DEAT',
  '2 DATE abt 1920',
  '0 @I2@ INDI',
  '1 NAME Mary /Jones/',
  '1 SEX F',
  '1 FAMS @F1@',
  '0 @I3@ INDI',
  '1 NAME Ann /Müller/',
  '1 SEX F',
  '1 FAMC @F1@',
  '1 FAMC @F9@',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 WIFE @I2@',
  '1 CHIL @I3@',
  '2 _FREL Natural',
  '2 _MREL Natural',
  '1 MARR',
  '2 DATE 1 Jun 1875',
  '0 @S1@ SOUR',
  '1 TITL 1900 United States Federal Census',
  '0 TRLR',
];
const GEDCOM = [...HEADER, ...BODY, ''].join('\r\n');

/** The lines of a GEDCOM file, without the byte-order mark (U+FEFF) it starts with. */
function linesOf(text: string): string[] {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\r\n');
}

/** The lines of a GEDCOM file after its header record. */
function bodyOf(text: string): string[] {
  const lines = linesOf(text);
  return lines.slice(lines.findIndex((line, index) => index > 0 && line.startsWith('0 ')));
}

test('imports a GEDCOM file into a new tree and says what it did', async ({
  app,
  window,
  userDataDir,
}) => {
  const file = join(userDataDir, 'Müller family.ged');
  writeFileSync(file, GEDCOM);

  // A cancelled file dialog changes nothing.
  await answerFilePicker(app, null);
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await expect(window.getByTestId('no-recent')).toBeVisible();

  await answerFilePicker(app, file);
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('workspace')).toBeVisible();
  // The tree is named after the file and kept with the other trees.
  await expect(window.getByTestId('tree-name')).toHaveText('Müller family');
  expect(existsSync(join(userDataDir, 'Trees', 'Müller family', 'tree.db'))).toBe(true);
  await expect(window.getByTestId('person-count')).toHaveText('3 people');
  await expect(window.getByTestId('person-row')).toHaveText([
    'Jones, Mary',
    'Müller, Ann',
    /^Müller, Johann.*1850–c\. 1920$/,
  ]);
  // An import is the tree's starting point, not a step to undo.
  await expect(window.getByTestId('undo')).toBeDisabled();

  await expect(window.getByTestId('import-notice')).toContainText(
    'Imported 3 people, 1 family, 4 events and 1 source from Müller family.ged. 1 place in the file did not follow the rules of the format.',
  );
  await window.getByTestId('import-details').click();
  await expect(window.getByTestId('import-report-summary')).toContainText(
    'The file is GEDCOM 5.5.1, in the UTF-8 character set.',
  );
  await expect(window.getByTestId('import-report-sources')).toContainText(
    'The 1 source of the file is under “Sources”, with 1 citation',
  );
  // The submitter record, the _UID line and the link to a family that is not there.
  await expect(window.getByTestId('import-report-kept')).toContainText('3 items');
  await expect(window.getByTestId('import-issue')).toHaveText([
    /^36.*FAMC @F9@ is not a family in this file; the line is kept as written$/,
  ]);
  await window.getByTestId('import-report-close').click();
  await window.getByTestId('import-dismiss').click();
  await expect(window.getByTestId('import-notice')).toHaveCount(0);

  // The person page shows what was read, and what is kept as written.
  await openPerson(window, 'Müller, Johann');
  await expect(window.getByTestId('person-lifespan')).toHaveText('1850–c. 1920');
  // His birth, residence and death, and the marriage listed with his partner.
  await expect(window.getByTestId('event-row')).toHaveCount(4);
  await expect(window.getByTestId('event-row').nth(1)).toContainText(
    'Age: 50; Relation to Head of House: Head',
  );
  await expect(window.getByTestId('partner-family')).toContainText('Jones');
  await expect(window.getByTestId('child-row')).toContainText('Müller');
  // The census entry cited under his name is listed as a source, not as a line kept as written.
  await expect(window.getByTestId('name-sources')).toHaveText('Sources (1)');
  await expect(window.getByTestId('person-citation')).toHaveText([
    /1900 United States Federal Census.*Year: 1900; Census Place: Boston.*Name/,
  ]);
  await expect(window.getByTestId('kept-summary')).toHaveText(
    '1 item that the app has no fields for yet',
  );
  await window.getByTestId('kept-summary').click();
  await expect(window.getByTestId('kept-lines')).toHaveText(['1 _UID 1234ABCD']);

  // Someone with nothing kept has no such section.
  await openPerson(window, 'Jones, Mary');
  await expect(window.getByTestId('kept-section')).toHaveCount(0);

  // Search finds an imported name whatever its accents.
  await window.getByTestId('search-box').fill('muller');
  await expect(window.getByTestId('person-count')).toHaveText('2 found');
});

test('refuses a file that is not GEDCOM and makes no tree for it', async ({
  app,
  window,
  userDataDir,
}) => {
  const file = join(userDataDir, 'letter.ged');
  writeFileSync(file, 'Dear John,\r\nthis is not a family tree.\r\n');
  await answerFilePicker(app, file);
  await window.getByTestId('import-tree-name').fill('Should not exist');
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('start-error')).toHaveText(
    'This is not a GEDCOM file: it has no header, people or families.',
  );
  await expect(window.getByTestId('start-screen')).toBeVisible();
  expect(existsSync(join(userDataDir, 'Trees', 'Should not exist'))).toBe(false);
});

test('exports an imported tree and gives the file back as it was', async ({
  app,
  window,
  userDataDir,
}) => {
  const file = join(userDataDir, 'in.ged');
  writeFileSync(file, GEDCOM);
  await answerFilePicker(app, file);
  await window.getByTestId('import-tree-name').fill('Round trip');
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('tree-name')).toHaveText('Round trip');

  // Sharing is the default: people who may be living are left out.
  await window.getByTestId('open-export').click();
  await expect(window.getByTestId('export-hide-living')).toBeChecked();
  await expect(window.getByTestId('export-version-551')).toBeChecked();
  // Johann has a death recorded and Mary married in 1875; only their daughter may be living.
  await expect(window.getByTestId('export-living-count')).toContainText(
    '1 person of 3 may be living.',
  );

  // A cancelled save dialog writes nothing and leaves the choices open.
  await answerSaveDialog(app, null);
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-submit')).toBeEnabled();
  await expect(window.getByTestId('export-done')).toHaveCount(0);

  const shared = join(userDataDir, 'shared.ged');
  await answerSaveDialog(app, shared);
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-done')).toContainText(
    '2 people and 1 family were written as GEDCOM 5.5.1',
  );
  await expect(window.getByTestId('export-file')).toHaveText(shared);
  await expect(window.getByTestId('export-omitted')).toHaveText(
    '1 person who may be living was left out.',
  );
  await window.getByTestId('export-close').click();
  const sharedText = readFileSync(shared, 'utf8');
  expect(sharedText).toContain('1 NAME Johann /Müller/');
  expect(sharedText).toContain('1 NAME Mary /Jones/');
  // Neither the daughter nor any line that points at her is in the file.
  expect(sharedText).not.toMatch(/Ann \/Müller|@I3@/);

  // With everyone included, every line after the header is the imported file again.
  const whole = join(userDataDir, 'whole.ged');
  await answerSaveDialog(app, whole);
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-include-living').check();
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-done')).toContainText(
    '3 people and 1 family were written as GEDCOM 5.5.1',
  );
  await expect(window.getByTestId('export-omitted')).toHaveCount(0);
  await window.getByTestId('export-close').click();

  const bytes = readFileSync(whole);
  // UTF-8 with a byte-order mark, as most programs expect.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const exported = bytes.toString('utf8');
  expect(bodyOf(exported)).toEqual(BODY.concat(''));
  expect(exported).toContain('1 SOUR RULZ_ANCESTRY');
  expect(exported).toContain('1 SUBM @SUBM1@');
  // No temporary file is left beside the exports.
  expect(readdirSync(userDataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

  // An edit changes only its own lines of the next export.
  await openPerson(window, 'Jones, Mary');
  await window.getByTestId('add-event').click();
  await window.getByTestId('event-type').selectOption('death');
  await window.getByTestId('event-date').fill('about 1930');
  await window.getByTestId('dialog-submit').click();
  // Her new death event, and the marriage listed with her partner.
  await expect(window.getByTestId('event-row')).toHaveCount(2);

  const edited = join(userDataDir, 'edited.ged');
  await answerSaveDialog(app, edited);
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-include-living').check();
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-done')).toBeVisible();
  // The new event goes after her name and sex, where events come in a record
  // that had none, and its date is written in GEDCOM's own form.
  const expected = [...BODY, ''];
  expected.splice(BODY.indexOf('1 NAME Mary /Jones/') + 2, 0, '1 DEAT', '2 DATE ABT 1930');
  expect(bodyOf(readFileSync(edited, 'utf8'))).toEqual(expected);
});

test('imports a 10,000-person file in under 10 seconds and exports it unchanged', async ({
  app,
  window,
  userDataDir,
}) => {
  // The measure the plan sets for Phase 1, taken in the app itself: from the
  // click that picks the file to the tree being on screen.
  const original = ancestryStyleFile(10_000);
  const file = join(userDataDir, 'Ten thousand.ged');
  writeFileSync(file, original);
  await answerFilePicker(app, file);

  const started = Date.now();
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('person-count')).toHaveText('10,000 people', {
    timeout: 30_000,
  });
  const importMs = Date.now() - started;
  expect(importMs).toBeLessThan(10_000);
  await expect(window.getByTestId('import-notice')).toContainText('Imported 10,000 people');
  await expect(window.getByTestId('import-notice')).not.toContainText('did not follow');

  // The list and the search answer at once on a tree of this size.
  await window.getByTestId('search-box').fill('mary z surname25');
  await expect(window.getByTestId('person-count')).toHaveText(/^[1-9]\d* found$/);
  await window.getByTestId('search-box').fill('');

  const out = join(userDataDir, 'Ten thousand out.ged');
  await answerSaveDialog(app, out);
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-include-living').check();
  await window.getByTestId('export-submit').click();
  await expect(window.getByTestId('export-done')).toContainText('10,000 people', {
    timeout: 30_000,
  });

  const exported = bodyOf(readFileSync(out, 'utf8'));
  const expected = bodyOf(original);
  expect(exported.length).toBe(expected.length);
  const firstDifferent = exported.findIndex((line, index) => line !== expected[index]);
  expect(
    firstDifferent === -1 ? null : [exported[firstDifferent], expected[firstDifferent]],
  ).toBeNull();
  console.info(`10,000-person import in the app: ${importMs} ms`);
});

test('exports a tree made in the app as GEDCOM 7.0', async ({ app, window, userDataDir }) => {
  await createTree(window, 'Made here');
  await addPerson(window, {
    given: 'Ada',
    surname: 'Lovelace',
    sex: 'Female',
    birthDate: '10 December 1815',
    birthPlace: 'London',
    deathDate: '27 Nov 1852',
  });

  const file = join(userDataDir, 'made-here');
  await answerSaveDialog(app, file);
  await window.getByTestId('open-export').click();
  await window.getByTestId('export-version-70').check();
  await window.getByTestId('export-submit').click();
  // A name typed without an ending gets .ged.
  await expect(window.getByTestId('export-file')).toHaveText(`${file}.ged`);
  await expect(window.getByTestId('export-done')).toContainText(
    '1 person and 0 families were written as GEDCOM 7.0',
  );

  const lines = linesOf(readFileSync(`${file}.ged`, 'utf8'));
  expect(lines.slice(0, 3)).toEqual(['0 HEAD', '1 GEDC', '2 VERS 7.0']);
  expect(lines.slice(lines.indexOf('0 @I1@ INDI'))).toEqual([
    '0 @I1@ INDI',
    '1 NAME Ada /Lovelace/',
    '2 GIVN Ada',
    '2 SURN Lovelace',
    '1 SEX F',
    '1 BIRT',
    '2 DATE 10 DEC 1815',
    '2 PLAC London',
    '1 DEAT',
    '2 DATE 27 NOV 1852',
    '0 TRLR',
    '',
  ]);
});
