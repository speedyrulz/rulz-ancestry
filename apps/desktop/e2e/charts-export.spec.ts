import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  addPerson,
  addRelative,
  answerFilePicker,
  answerSaveDialog,
  createTree,
  expect,
  test,
} from './fixtures';

/** Brin Hale, born long ago, with his father Tobin and his mother Odile, who may be living. */
async function buildFamily(window: Page): Promise<void> {
  await addPerson(window, { given: 'Brin', surname: 'Hale', sex: 'Male', birthDate: '1880' });
  await window.getByTestId('add-parent').click();
  await addRelative(window, { given: 'Tobin', surname: 'Hale', sex: 'Male', birthDate: '1850' });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, {
    given: 'Odile',
    surname: 'Secretname',
    sex: 'Female',
    birthDate: '1990',
    birthPlace: 'Secretville',
  });
  await expect(window.getByTestId('person-name')).toHaveText('Brin Hale');
}

test('saves and prints a chart whole, with a living person shown only as "Living"', async ({
  app,
  window,
  userDataDir,
}) => {
  await createTree(window, 'Chart export');
  await buildFamily(window);
  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-view')).toBeVisible();
  await expect(window.getByTestId('chart-box')).toHaveCount(3);

  await window.getByTestId('chart-export').click();
  const dialog = window.getByTestId('report-dialog');
  await expect(dialog).toBeVisible();
  const preview = window.frameLocator('[data-testid="report-preview"]');
  await expect(preview.locator('h1')).toContainText('Ancestor chart: Brin Hale');
  await expect(window.getByTestId('report-preview')).toHaveAttribute('sandbox', '');

  // The whole chart is one drawing; the living mother is a box that says "Living" and no more.
  await expect(preview.locator('svg')).toHaveCount(1);
  await expect(preview.locator('svg text', { hasText: 'Tobin Hale' })).toHaveCount(1);
  await expect(preview.locator('svg text', { hasText: 'Living' })).toHaveCount(1);
  await expect(preview.locator('body')).not.toContainText('Secretname');
  await expect(preview.locator('body')).not.toContainText('Secretville');
  await expect(dialog.getByTestId('report-omitted')).toContainText(
    '1 entry shown only as "Living"',
  );

  // The generations are limited to what stays readable on one page.
  await expect(dialog.getByTestId('report-generations').locator('option')).toHaveText([
    '2',
    '3',
    '4',
    '5',
  ]);
  await dialog.getByTestId('report-generations').selectOption('2');
  await expect(preview.locator('svg text', { hasText: 'Tobin Hale' })).toHaveCount(1);

  // A picture, with the living person left out.
  const svg = join(userDataDir, 'chart.svg');
  await answerSaveDialog(app, svg);
  await dialog.getByTestId('report-save-svg').click();
  await expect(dialog.getByTestId('report-outcome')).toContainText('Saved to');
  const picture = readFileSync(svg, 'utf8');
  expect(picture.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(picture).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(picture).toContain('Tobin Hale');
  expect(picture).not.toContain('Secretname');
  expect(picture).not.toMatch(/<script|href=/i);

  // A PDF is a real PDF.
  const pdf = join(userDataDir, 'chart.pdf');
  await answerSaveDialog(app, pdf);
  await dialog.getByTestId('report-save-pdf').click();
  await expect(dialog.getByTestId('report-outcome')).toContainText('Saved to');
  expect(readFileSync(pdf).subarray(0, 4).toString('latin1')).toBe('%PDF');

  // A cancelled dialog writes nothing.
  const never = join(userDataDir, 'never.svg');
  await answerSaveDialog(app, null);
  await dialog.getByTestId('report-save-svg').click();
  await expect(dialog.getByTestId('report-save-svg')).toBeEnabled();
  await expect(dialog.getByTestId('report-outcome')).toHaveText('');
  expect(existsSync(never)).toBe(false);

  // With living people included her name is in the picture.
  await dialog.getByTestId('report-include-living').check();
  await expect(preview.locator('svg text', { hasText: 'Odile Secretname' })).toHaveCount(1);
  await answerSaveDialog(app, svg);
  await dialog.getByTestId('report-save-svg').click();
  await expect(dialog.getByTestId('report-outcome')).toContainText('Saved to');
  expect(readFileSync(svg, 'utf8')).toContain('Odile Secretname');

  await dialog.getByTestId('report-close').click();
  await expect(dialog).toHaveCount(0);

  // The fan and the hourglass can be saved too, each with its own limit. What the frame
  // shows is what the page hands it, so these checks read that.
  const framed = window.getByTestId('report-preview');
  await window.getByTestId('chart-kind-fan').click();
  await window.getByTestId('chart-export').click();
  await expect(framed).toHaveAttribute('srcdoc', /<h1>Fan chart: Brin Hale<\/h1>/);
  await expect(dialog.getByTestId('report-generations').locator('option')).toHaveCount(6);
  await dialog.getByTestId('report-close').click();
  await window.getByTestId('chart-kind-hourglass').click();
  await window.getByTestId('chart-export').click();
  await expect(framed).toHaveAttribute('srcdoc', /<h1>Hourglass chart: Brin Hale<\/h1>/);
  await expect(dialog.getByTestId('report-generations').locator('option')).toHaveCount(3);
  await dialog.getByTestId('report-close').click();
});

test('refuses to save a chart of a living person unless living people are included', async ({
  window,
}) => {
  await createTree(window, 'Living chart');
  await addPerson(window, { given: 'Odile', surname: 'Now', sex: 'Female', birthDate: '1990' });
  await window.getByTestId('open-chart').click();
  await window.getByTestId('chart-export').click();
  const dialog = window.getByTestId('report-dialog');
  await expect(dialog.getByTestId('report-refused')).toContainText('may be living');
  await expect(dialog.getByTestId('report-save-pdf')).toBeDisabled();
  await expect(dialog.getByTestId('report-save-svg')).toBeDisabled();
  await expect(dialog.getByTestId('report-print')).toBeDisabled();
  await dialog.getByTestId('report-include-living').check();
  await expect(dialog.getByTestId('report-save-svg')).toBeEnabled();
  await expect(window.frameLocator('[data-testid="report-preview"]').locator('h1')).toContainText(
    'Ancestor chart: Odile Now',
  );
});

/**
 * A made-up tree for the biggest charts: a root with seven full generations of
 * ancestors (127 people) and 18 children, all long dead.
 */
function bigTree(): string {
  const lines = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '2 FORM LINEAGE-LINKED', '1 CHAR UTF-8'];
  const person = (id: string, given: string, famc: string | null) => {
    lines.push(`0 @${id}@ INDI`, `1 NAME ${given} /Bigtree/`, '1 BIRT', '2 DATE 1700');
    lines.push('1 DEAT', '2 DATE 1760');
    if (famc !== null) lines.push(`1 FAMC @${famc}@`);
  };
  for (let n = 1; n < 128; n += 1) {
    person(`I${n}`, n === 1 ? 'Root' : `Forebear${n}`, n === 1 ? null : `F${Math.floor(n / 2)}`);
  }
  for (let k = 1; k < 64; k += 1) {
    lines.push(`0 @F${k}@ FAM`, `1 HUSB @I${2 * k}@`, `1 WIFE @I${2 * k + 1}@`, `1 CHIL @I${k}@`);
  }
  for (let c = 1; c <= 18; c += 1) person(`C${c}`, `Child${c}`, 'FD');
  lines.push('0 @FD@ FAM', '1 HUSB @I1@');
  for (let c = 1; c <= 18; c += 1) lines.push(`1 CHIL @C${c}@`);
  lines.push('0 TRLR');
  return lines.join('\n');
}

test('puts the biggest chart of each kind on exactly one page, with its title and caption', async ({
  app,
  window,
  userDataDir,
}) => {
  const file = join(userDataDir, 'big.ged');
  writeFileSync(file, bigTree());
  await answerFilePicker(app, file);
  await window.getByTestId('import-tree-name').fill('Big');
  await window.getByTestId('import-gedcom').click();
  await expect(window.getByTestId('workspace')).toBeVisible();
  await window.getByTestId('search-box').fill('Root');
  await window.getByTestId('person-row').filter({ hasText: 'Bigtree, Root' }).click();
  await window.getByTestId('open-chart').click();

  const dialog = window.getByTestId('report-dialog');
  const pagesOf = (pdf: string): number =>
    (
      readFileSync(pdf)
        .toString('latin1')
        .match(/\/Type\s*\/Page(?![a-z])/g) ?? []
    ).length;

  // The most generations each kind allows; the descendants chart has 18 children in a row.
  for (const [kind, generations] of [
    ['pedigree', '5'],
    ['fan', '7'],
    ['hourglass', '4'],
    ['descendants', '6'],
  ] as const) {
    await window.getByTestId(`chart-kind-${kind}`).click();
    await window.getByTestId('chart-export').click();
    await dialog.getByTestId('report-generations').selectOption(generations);
    for (const paper of ['A4', 'Letter']) {
      await dialog.getByTestId('report-paper').selectOption(paper);
      await expect(window.getByTestId('report-preview')).toHaveAttribute('srcdoc', /<svg /);
      await expect(dialog.getByTestId('report-refused')).toHaveCount(0);
      const pdf = join(userDataDir, `${kind}-${paper}.pdf`);
      await answerSaveDialog(app, pdf);
      await dialog.getByTestId('report-save-pdf').click();
      await expect(dialog.getByTestId('report-outcome')).toContainText('Saved to');
      expect(pagesOf(pdf), `${kind} on ${paper}`).toBe(1);
    }
    await dialog.getByTestId('report-close').click();
  }
});
