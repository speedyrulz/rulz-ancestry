import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addPerson,
  addRelative,
  answerFolderPicker,
  createTree,
  expect,
  launchApp,
  openPerson,
  test,
} from './fixtures';

test('creates a tree in its own folder and opens it', async ({ window, userDataDir }) => {
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await expect(window.getByTestId('no-recent')).toBeVisible();
  // A run with its own profile folder keeps new trees inside it, never in Documents.
  await expect(window.getByTestId('new-tree-location')).toHaveText(join(userDataDir, 'Trees'));

  await window.getByTestId('create-tree').click();
  await expect(window.getByTestId('start-error')).toHaveText('Give the tree a name first.');

  await createTree(window, 'Smith: the family?');
  await expect(window.getByTestId('tree-name')).toHaveText('Smith: the family?');
  await expect(window).toHaveTitle('Smith: the family? - RulZ Ancestry');
  await expect(window.getByTestId('person-count')).toHaveText('0 people');
  await expect(window.getByTestId('undo')).toBeDisabled();
  // The folder name leaves out the characters Windows does not allow.
  expect(existsSync(join(userDataDir, 'Trees', 'Smith the family', 'tree.db'))).toBe(true);
});

test('adds people, finds them by name, and undoes and redoes', async ({ window }) => {
  await createTree(window, 'Search test');

  await window.getByTestId('add-person').click();
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('dialog-error')).toHaveText(
    'A new person needs a given name or a surname.',
  );
  await window.getByTestId('person-given').fill('Johann');
  await window.getByTestId('person-surname').fill('Müller');
  await window.getByTestId('person-birth-date').fill('abt 1850');
  // The form says how it read the date before anything is saved.
  await expect(window.getByTestId('date-hint')).toHaveText('Read as: about 1850');
  await window.getByTestId('dialog-submit').click();

  await expect(window.getByTestId('person-name')).toHaveText('Johann Müller');
  await expect(window.getByTestId('person-lifespan')).toHaveText('b. c. 1850');
  await addPerson(window, { given: 'Anna', surname: 'Schmidt', sex: 'Female' });
  await addPerson(window, { given: 'Zoë', surname: 'Adams' });

  // By surname, then given name.
  await expect(window.getByTestId('person-row')).toHaveText([
    'Adams, Zoë',
    'Müller, Johannb. c. 1850',
    'Schmidt, Anna',
  ]);
  await expect(window.getByTestId('person-count')).toHaveText('3 people');

  // The search ignores case and accents and matches the start of each word.
  await window.getByTestId('search-box').fill('muller joh');
  await expect(window.getByTestId('person-count')).toHaveText('1 found');
  await expect(window.getByTestId('person-row')).toHaveText(['Müller, Johannb. c. 1850']);
  await window.getByTestId('search-box').fill('nobody at all');
  await expect(window.getByTestId('person-list-empty')).toBeVisible();
  await window.getByTestId('search-box').fill('');
  await expect(window.getByTestId('person-row')).toHaveCount(3);

  // Undo takes back the last person added; the page that showed her says so.
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add person (Ctrl+Z)');
  await window.getByTestId('undo').click();
  await expect(window.getByTestId('workspace-notice')).toContainText('Undone: Add person.');
  await expect(window.getByTestId('person-row')).toHaveCount(2);
  await expect(window.getByTestId('person-gone')).toBeVisible();

  await window.getByTestId('redo').click();
  await expect(window.getByTestId('person-row')).toHaveCount(3);
  await expect(window.getByTestId('person-name')).toHaveText('Zoë Adams');

  // The keyboard does the same.
  await window.getByTestId('person-name').click();
  await window.keyboard.press('Control+z');
  await expect(window.getByTestId('person-row')).toHaveCount(2);
  await window.keyboard.press('Control+y');
  await expect(window.getByTestId('person-row')).toHaveCount(3);

  // In a text box Ctrl+Z undoes the typing there, as everywhere in Windows,
  // and leaves the tree alone.
  await window.getByTestId('search-box').click();
  await window.getByTestId('search-box').pressSequentially('adams');
  await expect(window.getByTestId('person-count')).toHaveText('1 found');
  await window.keyboard.press('Control+z');
  await expect(window.getByTestId('search-box')).not.toHaveValue('adams');
  // Give an undo of the tree time to happen, were one wrongly started.
  await window.waitForTimeout(400);
  await expect(window.getByTestId('redo')).toBeDisabled();
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add person (Ctrl+Z)');
  await window.getByTestId('search-box').fill('');
  await expect(window.getByTestId('person-count')).toHaveText('3 people');
});

test('links parents, a partner and children, and follows the links', async ({ window }) => {
  await createTree(window, 'Family test');
  await addPerson(window, { given: 'Mary', surname: 'Evans', sex: 'Female', birthDate: '1819' });

  await window.getByTestId('add-parent').click();
  await addRelative(window, { given: 'Robert', sex: 'Male', birthDate: '1773' });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, { given: 'Christiana', surname: 'Pearson', sex: 'Female' });
  const parents = window.getByTestId('parent-family');
  await expect(parents).toContainText('FatherRobert Evansb. 1773');
  await expect(parents).toContainText('MotherChristiana Pearson');

  await window.getByTestId('add-partner').click();
  await addRelative(window, { given: 'John', surname: 'Cross', sex: 'Male' });
  await window.getByTestId('add-child-to-family').click();
  // A child is offered the father's surname.
  await expect(window.getByTestId('person-surname')).toHaveValue('Cross');
  await addRelative(window, { given: 'Thomas', sex: 'Male' });
  await window.getByTestId('add-family-event').click();
  await expect(window.getByTestId('event-type')).toHaveValue('marriage');
  await window.getByTestId('event-date').fill('6 May 1880');
  await window.getByTestId('dialog-submit').click();
  const family = window.getByTestId('partner-family');
  await expect(family).toContainText('PartnerJohn Cross');
  await expect(family).toContainText('SonThomas Cross');
  await expect(family.getByTestId('event-row')).toContainText('Marriage6 May 1880');
  await expect(window.getByTestId('person-count')).toHaveText('5 people');

  // Each of those was one step: one undo takes the marriage away again.
  await window.getByTestId('undo').click();
  await expect(family.getByTestId('event-row')).toHaveCount(0);
  await window.getByTestId('redo').click();
  await expect(family.getByTestId('event-row')).toHaveCount(1);

  // From the son's page, Mary is his mother; from her father's page, she is his daughter.
  await window.getByTestId('person-link').filter({ hasText: 'Thomas Cross' }).click();
  await expect(window.getByTestId('person-name')).toHaveText('Thomas Cross');
  await expect(window.getByTestId('parent-family')).toContainText('MotherMary Evansb. 1819');
  await window.getByTestId('person-link').filter({ hasText: 'Mary Evans' }).click();
  await window.getByTestId('person-link').filter({ hasText: 'Robert Evans' }).click();
  await expect(window.getByTestId('partner-family')).toContainText('DaughterMary Evans');

  // Someone already in the tree can be linked instead of typed again, and a
  // link that would make a person their own ancestor is refused with a reason.
  await window.getByTestId('add-parent').click();
  await window.getByTestId('relative-mode-existing').check();
  await window.getByTestId('relative-search').fill('thomas');
  await window.getByTestId('relative-results').getByText('Cross, Thomas').click();
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('dialog-error')).toContainText('own descendant');
  await window.getByRole('button', { name: 'Cancel' }).click();
  await expect(window.getByTestId('parents-section')).toContainText('No parents recorded.');
});

test('edits names and events on the person page', async ({ window }) => {
  await createTree(window, 'Editing test');
  await addPerson(window, { given: 'Mary Ann', surname: 'Evans' });

  await window.getByTestId('add-name').click();
  await window.getByTestId('name-given').fill('Marian');
  await window.getByTestId('name-surname').fill('Cross');
  await window.getByTestId('name-primary').check();
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('person-name')).toHaveText('Marian Cross');
  await expect(window.getByTestId('person-row')).toHaveText(['Cross, Marian']);
  // Both names still find her.
  await window.getByTestId('search-box').fill('evans');
  await expect(window.getByTestId('person-row')).toHaveText(['Cross, Marian']);
  await window.getByTestId('search-box').fill('');

  await window.getByTestId('make-primary').click();
  await expect(window.getByTestId('person-name')).toHaveText('Mary Ann Evans');
  await window
    .getByTestId('name-row')
    .filter({ hasText: 'Marian' })
    .getByTestId('delete-name')
    .click();
  await expect(window.getByTestId('name-row')).toHaveCount(1);

  await window.getByTestId('add-event').click();
  await window.getByTestId('event-type').selectOption({ label: 'Death' });
  await window.getByTestId('event-date').fill('22 Dec 1880');
  await window.getByTestId('event-place').fill('London');
  await window.getByTestId('dialog-submit').click();
  await window.getByTestId('add-event').click();
  await window.getByTestId('event-type').selectOption({ label: 'Other…' });
  await window.getByTestId('event-custom-type').fill('Confirmation');
  await window.getByTestId('event-date').fill('sometime in the thirties');
  await expect(window.getByTestId('date-hint')).toContainText('Not recognised as a date');
  await window.getByTestId('dialog-submit').click();
  await window.getByTestId('add-event').click();
  await window.getByTestId('event-date').fill('22 Nov 1819');
  await window.getByTestId('dialog-submit').click();

  // In the order of a life, whatever order they were typed in.
  const events = window.getByTestId('events-section').getByTestId('event-row');
  await expect(events).toHaveCount(3);
  await expect(events.nth(0)).toContainText('Birth22 Nov 1819');
  await expect(events.nth(1)).toContainText('Death22 Dec 1880London');
  await expect(events.nth(2)).toContainText(
    'Confirmationsometime in the thirties (not read as a date)',
  );
  await expect(window.getByTestId('person-lifespan')).toHaveText('1819–1880');

  await events.nth(1).getByTestId('edit-event').click();
  await expect(window.getByTestId('event-date')).toHaveValue('22 Dec 1880');
  await window.getByTestId('event-place').fill('Chelsea, London');
  await window.getByTestId('dialog-submit').click();
  await expect(events.nth(1)).toContainText('Chelsea, London');
  await events.nth(2).getByTestId('delete-event').click();
  await expect(events).toHaveCount(2);

  await window.getByTestId('detail-living').selectOption({ label: 'Deceased' });
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Edit person (Ctrl+Z)');

  await window.getByTestId('delete-person').click();
  await expect(window.getByTestId('confirm-dialog')).toContainText('Delete Mary Ann Evans?');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('person-count')).toHaveText('0 people');
  await expect(window.getByTestId('nobody-selected')).toBeVisible();
  await window.getByTestId('undo').click();
  await expect(window.getByTestId('person-row')).toHaveText(['Evans, Mary Ann1819–1880']);
});

test('backs up on closing, lists the tree as recent and reopens it', async ({
  window,
  userDataDir,
}) => {
  await createTree(window, 'Recent test');
  await addPerson(window, { given: 'Ada', surname: 'Lovelace' });
  await expect(window.getByTestId('tree-backup')).toHaveText('No backup yet');

  await window.getByTestId('close-tree').click();
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await expect(window).toHaveTitle('RulZ Ancestry');
  const backups = join(userDataDir, 'Trees', 'Recent test', 'backups');
  expect(readdirSync(backups)).toHaveLength(1);

  const recent = window.getByTestId('recent-tree');
  await expect(recent).toHaveCount(1);
  await expect(recent).toContainText('Recent test');
  await recent.getByTestId('open-recent').click();
  await expect(window.getByTestId('person-row')).toHaveText(['Lovelace, Ada']);
  await expect(window.getByTestId('tree-backup')).toContainText('Last backup');
  // The undo history is kept in the tree file.
  await expect(window.getByTestId('undo')).toBeEnabled();

  // Nothing changed this time, so closing makes no second backup.
  await window.getByTestId('close-tree').click();
  await expect(window.getByTestId('start-screen')).toBeVisible();
  expect(readdirSync(backups)).toHaveLength(1);

  await window.getByTestId('forget-recent').click();
  await expect(window.getByTestId('no-recent')).toBeVisible();
  expect(existsSync(join(userDataDir, 'Trees', 'Recent test', 'tree.db'))).toBe(true);
});

test('reopens the tree that was open when the app was last quit', async ({
  app,
  window,
  appTarget,
  userDataDir,
}) => {
  await createTree(window, 'Restart test');
  await addPerson(window, { given: 'Grace', surname: 'Hopper' });
  await app.close();
  // Quitting backed the tree up.
  expect(readdirSync(join(userDataDir, 'Trees', 'Restart test', 'backups'))).toHaveLength(1);

  const second = await launchApp(appTarget, userDataDir);
  try {
    const page = await second.firstWindow();
    await expect(page.getByTestId('tree-name')).toHaveText('Restart test');
    await expect(page.getByTestId('person-row')).toHaveText(['Hopper, Grace']);
  } finally {
    await second.close();
  }
});

test('opens a tree from a folder chosen in the system dialog', async ({
  app,
  window,
  userDataDir,
}) => {
  // Keep the new tree somewhere other than the default place.
  const elsewhere = join(userDataDir, 'Elsewhere');
  mkdirSync(elsewhere);
  await answerFolderPicker(app, elsewhere);
  await window.getByTestId('choose-folder').click();
  await expect(window.getByTestId('new-tree-location')).toHaveText(elsewhere);
  await createTree(window, 'Moved tree');
  await addPerson(window, { given: 'Alan', surname: 'Turing' });
  await window.getByTestId('close-tree').click();
  await window.getByTestId('forget-recent').click();
  await expect(window.getByTestId('no-recent')).toBeVisible();

  // A cancelled dialog changes nothing; a folder with no tree is refused with a reason.
  await answerFolderPicker(app, null);
  await window.getByTestId('open-tree-folder').click();
  await expect(window.getByTestId('start-screen')).toBeVisible();
  await answerFolderPicker(app, elsewhere);
  await window.getByTestId('open-tree-folder').click();
  await expect(window.getByTestId('start-error')).toContainText(
    'There is no family tree in this folder',
  );
  expect(readdirSync(elsewhere)).toEqual(['Moved tree']);

  await answerFolderPicker(app, join(elsewhere, 'Moved tree'));
  await window.getByTestId('open-tree-folder').click();
  await expect(window.getByTestId('tree-name')).toHaveText('Moved tree');
  await expect(window.getByTestId('person-row')).toHaveText(['Turing, Alan']);
});

test('makes a backup on request and restores it', async ({ window }) => {
  await createTree(window, 'Backup test');
  await addPerson(window, { given: 'Kept', surname: 'Person' });

  await window.getByTestId('open-backups').click();
  await expect(window.getByTestId('backups-list')).toContainText('No backups yet.');
  await window.getByTestId('backup-now').click();
  await expect(window.getByTestId('backups-message')).toHaveText('Backup made.');
  await expect(window.getByTestId('backup-row')).toHaveCount(1);
  await window.getByTestId('backup-now').click();
  await expect(window.getByTestId('backups-message')).toHaveText(
    'The newest backup already holds the tree as it is now.',
  );
  await window.getByTestId('backups-close').click();

  // A mistake: the person is deleted and another is added.
  await openPerson(window, 'Person, Kept');
  await window.getByTestId('delete-person').click();
  await window.getByTestId('dialog-submit').click();
  await addPerson(window, { given: 'Wrong', surname: 'Entry' });
  await expect(window.getByTestId('person-row')).toHaveText(['Entry, Wrong']);

  await window.getByTestId('open-backups').click();
  await window.getByTestId('backup-row').getByRole('button', { name: 'Restore…' }).click();
  await expect(window.getByTestId('restore-confirm')).toContainText('backed up first');
  await window.getByTestId('restore-confirm-button').click();
  await expect(window.getByTestId('backups-message')).toContainText('The tree is now as it was on');
  // The state from before the restore was saved too, so the restore can be reversed.
  await expect(window.getByTestId('backup-row')).toHaveCount(2);
  await window.getByTestId('backups-close').click();

  await expect(window.getByTestId('person-row')).toHaveText(['Person, Kept']);
  await expect(window.getByTestId('person-gone')).toBeVisible();
});
