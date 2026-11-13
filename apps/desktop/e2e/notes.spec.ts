import type { Page } from '@playwright/test';
import { addPerson, createTree, expect, test } from './fixtures';

/** The row of an event on the person page, found by the event's name. */
function eventRow(window: Page, label: string) {
  return window.getByTestId('event-row').filter({ hasText: label });
}

test('keeps a note on a person, on an event and on a source', async ({ window }) => {
  await createTree(window, 'Notes');
  await addPerson(window, { given: 'Ann', surname: 'Lee', birthDate: '1900' });

  // A person starts without a note.
  const section = window.getByTestId('note-section');
  await expect(section).toContainText('No note.');
  await expect(window.getByTestId('edit-note')).toHaveText('Add a note');

  // A note has as many lines as it needs, and they stay lines.
  await window.getByTestId('edit-note').click();
  await expect(window.getByTestId('note-dialog')).toContainText('Note on Ann Lee');
  await window.getByTestId('note-text').fill('Kept a diary.\nIt is lost.');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('note-dialog')).toHaveCount(0);
  await expect(window.getByTestId('person-note')).toHaveText('Kept a diary.\nIt is lost.');
  await expect(window.getByTestId('edit-note')).toHaveText('Edit note');
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Edit person (Ctrl+Z)');

  // The form opens with the note as it is, and an emptied note is no note.
  await window.getByTestId('edit-note').click();
  await expect(window.getByTestId('note-text')).toHaveValue('Kept a diary.\nIt is lost.');
  await window.getByTestId('note-text').fill('   ');
  await window.getByTestId('dialog-submit').click();
  await expect(section).toContainText('No note.');
  await window.getByTestId('undo').click();
  await expect(window.getByTestId('person-note')).toHaveText('Kept a diary.\nIt is lost.');

  // An event has a note of its own, shown under its details.
  await expect(eventRow(window, 'Birth').getByTestId('event-note-text')).toHaveCount(0);
  await eventRow(window, 'Birth').getByTestId('edit-event').click();
  await window.getByTestId('event-note').fill('Born at home, says her sister.');
  await window.getByTestId('dialog-submit').click();
  await expect(eventRow(window, 'Birth').getByTestId('event-note-text')).toHaveText(
    'Born at home, says her sister.',
  );
  await eventRow(window, 'Birth').getByTestId('edit-event').click();
  await expect(window.getByTestId('event-note')).toHaveValue('Born at home, says her sister.');
  await window.getByTestId('event-date').fill('1901');
  await window.getByTestId('dialog-submit').click();
  // Editing the date leaves the note alone.
  await expect(eventRow(window, 'Birth')).toContainText('1901');
  await expect(eventRow(window, 'Birth').getByTestId('event-note-text')).toHaveText(
    'Born at home, says her sister.',
  );

  // So has a source.
  await window.getByTestId('open-sources').click();
  await window.getByTestId('add-source').click();
  await window.getByTestId('source-title').fill('Parish register of York');
  await window.getByTestId('source-note').fill('Seen on film in 1998.');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('source-dialog')).toContainText('Parish register of York');
  await expect(window.getByTestId('source-note')).toHaveValue('Seen on film in 1998.');
  await window.getByTestId('source-note').fill('Seen on film in 1998.\nHard to read.');
  await window.getByTestId('source-save').click();
  await expect(window.getByTestId('source-save')).toBeDisabled();
  await window.getByTestId('source-close').click();
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Edit source (Ctrl+Z)');
});
