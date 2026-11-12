import type { Page } from '@playwright/test';
import { addPerson, addRelative, createTree, expect, openPerson, test } from './fixtures';

/** John Hale with his parents Thomas and Ann, his partner Mary and their daughter Rose. */
async function buildFamily(window: Page): Promise<void> {
  await addPerson(window, { given: 'John', surname: 'Hale', sex: 'Male', birthDate: '1880' });
  await window.getByTestId('add-parent').click();
  await addRelative(window, { given: 'Thomas', surname: 'Hale', sex: 'Male', birthDate: '1850' });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, { given: 'Ann', surname: 'Reed', sex: 'Female' });
  await window.getByTestId('add-partner').click();
  await addRelative(window, { given: 'Mary', surname: 'Cole', sex: 'Female' });
  await window.getByTestId('add-child-to-family').click();
  await addRelative(window, { given: 'Rose', surname: 'Hale', sex: 'Female', birthDate: '1905' });
  await expect(window.getByTestId('person-count')).toHaveText('5 people');
  await expect(window.getByTestId('person-name')).toHaveText('John Hale');
}

function box(window: Page, name: string) {
  return window.getByTestId('chart-box').filter({ hasText: name });
}

/** Picks a person in the search list of whichever dialog is open. */
async function pick(window: Page, search: string): Promise<void> {
  await window.getByTestId('picker-search').fill(search);
  const found = window.getByTestId('picker-results').locator('label').filter({ hasText: search });
  await expect(found).toHaveCount(1);
  await found.getByTestId('picker-option').check();
}

test('draws the four charts and moves from person to person in them', async ({ window }) => {
  await createTree(window, 'Charts');
  await buildFamily(window);

  await window.getByTestId('open-chart').click();
  await expect(window.getByTestId('chart-view')).toBeVisible();
  await expect(window.getByTestId('chart-root-name')).toHaveText('John Hale');

  // Ancestors: the person and both parents, with their years.
  const canvas = window.getByTestId('chart-canvas');
  await expect(canvas).toHaveAttribute('data-kind', 'pedigree');
  await expect(window.getByTestId('chart-box')).toHaveCount(3);
  await expect(box(window, 'John Hale')).toHaveAttribute('data-role', 'root');
  await expect(box(window, 'John Hale')).toContainText('b. 1880');
  await expect(box(window, 'Thomas Hale')).toHaveAttribute('data-role', 'ancestor');
  // The father is drawn above the mother, one column to the right of the person.
  const [john, thomas, ann] = await Promise.all(
    ['John Hale', 'Thomas Hale', 'Ann Reed'].map((name) => box(window, name).boundingBox()),
  );
  if (!john || !thomas || !ann) throw new Error('a box is not drawn');
  expect(thomas.x).toBeGreaterThan(john.x + john.width);
  expect(ann.x).toBe(thomas.x);
  expect(thomas.y).toBeLessThan(john.y);
  expect(ann.y).toBeGreaterThan(john.y);

  // Descendants: the partner under the person, the child to the right.
  await window.getByTestId('chart-kind-descendants').click();
  await expect(canvas).toHaveAttribute('data-kind', 'descendants');
  await expect(window.getByTestId('chart-box')).toHaveCount(3);
  await expect(box(window, 'Mary Cole')).toHaveAttribute('data-role', 'partner');
  await expect(box(window, 'Rose Hale')).toHaveAttribute('data-role', 'descendant');

  // Hourglass: everyone.
  await window.getByTestId('chart-kind-hourglass').click();
  await expect(canvas).toHaveAttribute('data-kind', 'hourglass');
  await expect(window.getByTestId('chart-box')).toHaveCount(5);
  await expect(window.locator('[data-testid="chart-box"][data-role="root"]')).toHaveCount(1);

  // Fan: one place for each parent, around the person.
  await window.getByTestId('chart-kind-fan').click();
  await expect(canvas).toHaveAttribute('data-kind', 'fan');
  await expect(window.getByTestId('fan-segment')).toHaveCount(2);
  await expect(window.getByTestId('fan-root')).toContainText('John Hale');
  await expect(window.getByTestId('fan-segment').first()).toContainText('Thomas Hale');

  // Clicking a parent in the fan puts him at the centre.
  await window.getByTestId('fan-segment').first().click();
  await expect(window.getByTestId('chart-root-name')).toHaveText('Thomas Hale');
  await expect(window.getByTestId('fan-segment')).toHaveCount(0);

  // Generations and zoom.
  await window.getByTestId('chart-kind-descendants').click();
  await expect(window.getByTestId('chart-box')).toHaveCount(5);
  await window.getByTestId('chart-generations').selectOption('2');
  await expect(window.getByTestId('chart-box')).toHaveCount(3);
  await expect(box(window, 'John Hale')).toContainText('more…');
  await expect(window.getByTestId('chart-zoom')).toHaveText('100%');
  await window.getByTestId('chart-zoom-in').click();
  await expect(window.getByTestId('chart-zoom')).toHaveText('125%');
  await window.getByTestId('chart-fit').click();
  await expect(window.getByTestId('chart-zoom')).toHaveText('100%');

  // Choosing someone in the list of people redraws the chart for them.
  await window.getByTestId('person-row').filter({ hasText: 'Hale, Rose' }).click();
  await expect(window.getByTestId('chart-root-name')).toHaveText('Rose Hale');
  await expect(window.getByTestId('chart-box')).toHaveCount(1);

  // Clicking the person at the centre opens their details.
  await box(window, 'Rose Hale').click();
  await expect(window.getByTestId('person-page')).toBeVisible();
  await expect(window.getByTestId('person-name')).toHaveText('Rose Hale');
});

test('says how two people are related, and refuses to merge a parent with a child', async ({
  window,
}) => {
  await createTree(window, 'Relatives');
  await buildFamily(window);

  await window.getByTestId('open-relationship').click();
  await expect(window.getByTestId('relationship-dialog')).toBeVisible();
  await pick(window, 'Rose');
  await expect(window.getByTestId('relationship-answer')).toHaveText(
    'Rose Hale is John Hale’s daughter.',
  );
  await pick(window, 'Mary');
  await expect(window.getByTestId('relationship-answer')).toHaveText(
    'Mary Cole is John Hale’s partner.',
  );
  await window.getByTestId('relationship-close').click();

  // From the grandfather, with the people in between.
  await openPerson(window, 'Hale, Thomas');
  await window.getByTestId('open-relationship').click();
  await pick(window, 'Rose');
  await expect(window.getByTestId('relationship-answer')).toHaveText(
    'Rose Hale is Thomas Hale’s granddaughter.',
  );
  await expect(window.getByTestId('relationship-path').locator('li')).toHaveText([
    /Thomas Hale/,
    /John Hale/,
    /Rose Hale/,
  ]);
  await pick(window, 'Mary');
  await expect(window.getByTestId('relationship-answer')).toHaveText(
    'Mary Cole is Thomas Hale’s daughter-in-law.',
  );
  await expect(window.getByTestId('relationship-via')).toHaveText('Through John Hale.');
  // A name in the answer is a link to that person.
  await window.getByTestId('relationship-via').getByRole('button').click();
  await expect(window.getByTestId('relationship-dialog')).toHaveCount(0);
  await expect(window.getByTestId('person-name')).toHaveText('John Hale');

  // A person cannot be merged with their own father; the dialog says why.
  await window.getByTestId('open-merge').click();
  await expect(window.getByTestId('merge-pick-dialog')).toBeVisible();
  await pick(window, 'Thomas');
  await window.getByTestId('merge-compare').click();
  await expect(window.getByTestId('merge-dialog')).toBeVisible();
  await expect(window.getByTestId('merge-compare-table')).toContainText('Ann Reed');
  await window.getByTestId('merge-submit').click();
  await expect(window.getByTestId('dialog-error')).toHaveText(
    'A person cannot be merged with their own ancestor or descendant.',
  );
  await expect(window.getByTestId('person-count')).toHaveText('5 people');
});

test('finds a person entered twice, merges the two records, and undoes it', async ({ window }) => {
  await createTree(window, 'Duplicates');
  await addPerson(window, {
    given: 'Eliza',
    surname: 'Wood',
    birthDate: '1840',
    birthPlace: 'York',
  });
  await addPerson(window, {
    given: 'Eliza',
    surname: 'Wood',
    birthDate: 'abt 1840',
    deathDate: '1901',
  });
  await addPerson(window, { given: 'Thomas', surname: 'Wood' });

  await window.getByTestId('open-duplicates').click();
  await expect(window.getByTestId('duplicates-summary')).toHaveText(
    '1 possible duplicate among 3 people.',
  );
  await expect(window.getByTestId('duplicate-row')).toHaveCount(1);
  await expect(window.getByTestId('duplicate-score')).toHaveText('Likely (75)');
  await expect(window.getByTestId('duplicate-row')).toContainText(
    'Same name. Born in the same year.',
  );

  // Side by side, then merged into the first record.
  await window.getByTestId('duplicate-compare').click();
  await expect(window.getByTestId('merge-dialog')).toBeVisible();
  await expect(window.getByTestId('merge-compare-table')).toContainText('Birth: 1840, York');
  await expect(window.getByTestId('merge-compare-table')).toContainText('Death: 1901');
  await expect(window.getByTestId('merge-keep-first')).toBeChecked();
  await window.getByTestId('merge-submit').click();
  await expect(window.getByTestId('merge-dialog')).toHaveCount(0);
  await expect(window.getByTestId('duplicates-summary')).toHaveText(
    'No likely duplicates were found among 2 people.',
  );
  await window.getByTestId('duplicates-close').click();

  await expect(window.getByTestId('workspace-notice')).toContainText(
    'Merged into Eliza Wood. 2 events came over. Undo brings both records back.',
  );
  await expect(window.getByTestId('person-count')).toHaveText('2 people');
  // The person who is left is shown, with the facts of both records.
  await expect(window.getByTestId('person-name')).toHaveText('Eliza Wood');
  await expect(window.getByTestId('events-section').getByTestId('event-row')).toHaveCount(3);

  // One undo brings the second record back.
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Merge people (Ctrl+Z)');
  await window.getByTestId('undo').click();
  await expect(window.getByTestId('person-count')).toHaveText('3 people');
  await expect(window.getByTestId('events-section').getByTestId('event-row')).toHaveCount(1);

  // Saying they are different people takes the pair off the list for good.
  await window.getByTestId('open-duplicates').click();
  await window.getByTestId('duplicate-compare').click();
  await window.getByTestId('merge-different').click();
  await expect(window.getByTestId('merge-dialog')).toHaveCount(0);
  await expect(window.getByTestId('duplicates-summary')).toHaveText(
    'No likely duplicates were found among 3 people.',
  );
  await window.getByTestId('duplicates-close').click();
  await expect(window.getByTestId('undo')).toHaveAttribute(
    'title',
    'Undo Mark as different people (Ctrl+Z)',
  );
});
