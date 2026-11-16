import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addPerson, addRelative, answerSaveDialog, createTree, expect, test } from './fixtures';

test('makes a family group sheet that shows a living partner only as "Living", and saves it as a PDF', async ({
  app,
  window,
  userDataDir,
}) => {
  await createTree(window, 'Report test');
  await addPerson(window, {
    given: 'Hal',
    surname: 'Marsh',
    sex: 'Male',
    birthDate: '1850',
    birthPlace: 'Oldtown',
    deathDate: '1910',
  });
  // The person page says why Hal is taken to be deceased.
  await expect(window.getByTestId('living-reason')).toHaveText('Deceased: death recorded');

  // His partner has no death recorded and was born recently, so she may be living.
  await window.getByTestId('add-partner').click();
  await addRelative(window, {
    given: 'Livia',
    surname: 'Secretname',
    sex: 'Female',
    birthDate: '1995',
  });

  await window.getByTestId('open-report').click();
  const dialog = window.getByTestId('report-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('report-include-living')).not.toBeChecked();

  // The preview runs in a frame in which nothing can run, and holds no name of the living partner.
  const preview = window.frameLocator('[data-testid="report-preview"]');
  await expect(preview.locator('h1')).toContainText('Family group sheet: Hal Marsh and Living');
  await expect(preview.locator('body')).toContainText('Living');
  await expect(preview.locator('body')).toContainText('Oldtown');
  await expect(preview.locator('body')).not.toContainText('Livia');
  await expect(preview.locator('body')).not.toContainText('Secretname');
  await expect(window.getByTestId('report-preview')).toHaveAttribute('sandbox', '');
  await expect(dialog.getByTestId('report-omitted')).toContainText(
    '1 person shown only as "Living"',
  );

  // Saving a PDF through the system dialog (answered by the test) writes a real PDF.
  const pdf = join(userDataDir, 'sheet.pdf');
  await answerSaveDialog(app, pdf);
  await dialog.getByTestId('report-save-pdf').click();
  await expect(dialog.getByTestId('report-outcome')).toContainText('Saved to');
  expect(existsSync(pdf)).toBe(true);
  expect(readFileSync(pdf).subarray(0, 4).toString('latin1')).toBe('%PDF');

  // A cancelled dialog writes nothing and says nothing was saved.
  const never = join(userDataDir, 'never.pdf');
  await answerSaveDialog(app, null);
  await dialog.getByTestId('report-save-pdf').click();
  await expect(dialog.getByTestId('report-save-pdf')).toBeEnabled();
  await expect(dialog.getByTestId('report-outcome')).toHaveText('');
  expect(existsSync(never)).toBe(false);

  // With living people included the partner is named.
  await dialog.getByTestId('report-include-living').check();
  await expect(preview.locator('h1')).toContainText(
    'Family group sheet: Hal Marsh and Livia Secretname',
  );
  await expect(preview.locator('body')).toContainText('Livia Secretname');

  // The web page can be saved too, and holds no script.
  const html = join(userDataDir, 'sheet.html');
  await answerSaveDialog(app, html);
  await dialog.getByTestId('report-save-html').click();
  await expect(dialog.getByTestId('report-outcome')).toContainText('Saved to');
  const text = readFileSync(html, 'utf8');
  expect(text).toContain('Livia Secretname');
  expect(text).not.toMatch(/<script/i);

  await dialog.getByTestId('report-close').click();
  await expect(dialog).toHaveCount(0);
});

test('refuses a sheet whose partners may all be living, and says why a person is taken to be living', async ({
  window,
}) => {
  await createTree(window, 'Living report test');
  await addPerson(window, { given: 'Ann', surname: 'Now', sex: 'Female', birthDate: '1990' });
  await expect(window.getByTestId('living-reason')).toHaveText(
    'Presumed living: no death recorded and born less than 110 years ago',
  );
  await window.getByTestId('add-partner').click();
  await addRelative(window, { given: 'Ben', surname: 'Now', sex: 'Male', birthDate: '1988' });

  await window.getByTestId('open-report').click();
  const dialog = window.getByTestId('report-dialog');
  await expect(dialog.getByTestId('report-refused')).toContainText('may be living');
  await expect(dialog.getByTestId('report-save-pdf')).toBeDisabled();
  await expect(dialog.getByTestId('report-print')).toBeDisabled();

  await dialog.getByTestId('report-include-living').check();
  const preview = window.frameLocator('[data-testid="report-preview"]');
  await expect(preview.locator('body')).toContainText('Ann Now');
  await expect(dialog.getByTestId('report-save-pdf')).toBeEnabled();
});
