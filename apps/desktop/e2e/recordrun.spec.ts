import type { ElectronApplication, Page } from '@playwright/test';
import { addPerson, addRelative, createTree, expect, test } from './fixtures';

/**
 * Makes the app's requests to the internet answer as WikiTree and Open
 * Archives would, and notes every address asked for. WikiTree answers with
 * two profiles of people who are made up, whoever it is asked for; Open
 * Archives with nothing. With `busy`, both answer "too many requests"; with
 * `slowMs`, each answer takes that long. The tests never reach either.
 */
async function answerRuns(
  app: ElectronApplication,
  options: { busy?: boolean; slowMs?: number } = {},
): Promise<void> {
  const profile = (number: number, given: string) => ({
    Id: number,
    Name: `Marsh-${90000 + number}`,
    FirstName: given,
    MiddleName: '',
    RealName: given,
    LastNameAtBirth: 'Marsh',
    LastNameCurrent: 'Marsh',
    Suffix: '',
    BirthDate: '1850-03-12',
    DeathDate: '1912-00-00',
    BirthLocation: 'Ashford, Vermont',
    DeathLocation: '',
    Gender: 'Male',
    IsLiving: 0,
    Privacy: 60,
    DataStatus: { BirthDate: 'certain', DeathDate: 'guess' },
  });
  await app.evaluate(
    ({ net, session }, served) => {
      const asked: string[] = [];
      (globalThis as unknown as { askedOfInternet: string[] }).askedOfInternet = asked;
      // Anything the app asks for by another way than its search is a mistake of the test.
      net.fetch = (input) => {
        asked.push(`unexpected: ${typeof input === 'string' ? input : input.url}`);
        return Promise.resolve(new Response('', { status: 500 }));
      };
      session.fromPartition('records').fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        if (served.slowMs > 0) await new Promise((resolve) => setTimeout(resolve, served.slowMs));
        if (served.busy) {
          return new Response('slow down', { status: 429, headers: { 'retry-after': '600' } });
        }
        const host = new URL(url).host;
        if (host === 'api.openarchieven.nl') {
          return new Response(JSON.stringify({ response: { number_found: 0, docs: [] } }));
        }
        if (host !== 'api.wikitree.com') return new Response('', { status: 500 });
        return new Response(
          JSON.stringify([{ status: 0, matches: served.matches, total: 2, start: 0 }]),
        );
      };
    },
    {
      matches: [profile(1, 'Josiah'), profile(2, 'Abel')],
      busy: options.busy === true,
      slowMs: options.slowMs ?? 0,
    },
  );
}

function askedOfInternet(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { askedOfInternet?: string[] }).askedOfInternet ?? [],
  );
}

/** Josiah Marsh with his father Ezra and his mother Lydia. The mother has the dates given, or none. */
async function family(window: Page, mother: { birthDate?: string } = {}): Promise<void> {
  await createTree(window, 'Ancestors');
  await addPerson(window, {
    given: 'Josiah',
    surname: 'Marsh',
    birthDate: '12 MAR 1850',
    deathDate: 'ABT 1912',
  });
  await window.getByTestId('add-parent').click();
  await addRelative(window, { given: 'Ezra', surname: 'Marsh', birthDate: '1820' });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, { given: 'Lydia', surname: 'Marsh', ...mother });
}

/** Opens the window of the search for ancestors, and agrees to the notice when it is shown. */
async function openRun(window: Page, agree: boolean): Promise<void> {
  await window.getByTestId('open-record-run').click();
  await expect(window.getByTestId('record-run')).toContainText(
    'Search for ancestors of Josiah Marsh',
  );
  if (agree) await window.getByTestId('record-agree').click();
  await expect(window.getByTestId('run-plan')).toBeVisible();
}

test('searches for a person and their ancestors in one go, after listing who is asked for', async ({
  app,
  window,
}) => {
  await answerRuns(app);
  await family(window);

  // The first time, the app says what a search sends, and that one press can ask for several people.
  await window.getByTestId('open-record-run').click();
  await expect(window.getByTestId('record-notice-several')).toContainText(
    'lists everyone it will ask for',
  );
  await expect(window.getByTestId('run-start')).toHaveCount(0);
  await window.getByTestId('record-agree').click();

  // Who is asked for, with what is sent for each; and who is not.
  await expect(window.getByTestId('run-asked-count')).toHaveText('2 people are asked for');
  const asked = window.getByTestId('run-asked').locator('li');
  await expect(asked).toHaveText(['Josiah Marsh, born 1850, died 1912', /^Ezra Marsh, born 1820/]);
  await expect(window.getByTestId('run-left-out')).toContainText(
    'Lydia Marsh (parent): may be living',
  );
  // WikiTree is ticked to begin with, and Open Archives is not. No other source is offered.
  await expect(window.getByTestId('run-source-wikitree')).toBeChecked();
  await expect(window.getByTestId('run-source-open-archives')).not.toBeChecked();
  await expect(window.getByTestId('run-sources').locator('input')).toHaveCount(2);
  await expect(window.getByTestId('run-count')).toContainText(
    'sends at most 2 requests: 2 to WikiTree.',
  );
  await window.getByTestId('run-source-open-archives').check();
  await expect(window.getByTestId('run-count')).toContainText(
    'sends at most 4 requests: 2 to WikiTree, 2 to Open Archives (Open Archieven).',
  );
  // With no service ticked there is nothing to start.
  await window.getByTestId('run-source-open-archives').uncheck();
  await window.getByTestId('run-source-wikitree').uncheck();
  await expect(window.getByTestId('run-start')).toBeDisabled();
  await window.getByTestId('run-source-wikitree').check();
  await window.getByTestId('run-source-open-archives').check();
  // No further back than the parents: the list is the same here, since nobody is further back.
  await window.getByTestId('run-generations').selectOption('1');
  await expect(window.getByTestId('run-asked-count')).toHaveText('2 people are asked for');
  expect(await askedOfInternet(app)).toEqual([]);

  await window.getByTestId('run-start').click();
  await expect(window.getByTestId('run-status')).toContainText('The search is finished.', {
    timeout: 20_000,
  });
  await expect(window.getByTestId('run-progress-wikitree')).toContainText('WikiTree: 2 of 2');
  await expect(window.getByTestId('run-progress-wikitree')).toContainText(
    'Profile data from WikiTree',
  );
  await expect(window.getByTestId('run-progress-open-archives')).toContainText('2 of 2');

  // One request for each person at each source, with the name and years the list showed.
  const sent = await askedOfInternet(app);
  expect(sent).toHaveLength(4);
  const ofWikiTree = sent
    .filter((address) => new URL(address).host === 'api.wikitree.com')
    .map((address) => new URL(address).searchParams);
  expect(ofWikiTree.map((params) => params.get('FirstName'))).toEqual(['Josiah', 'Ezra']);
  expect(ofWikiTree.map((params) => params.get('BirthDate'))).toEqual(['1850', '1820']);
  expect(sent.join(' ')).not.toContain('Lydia');

  // The results stand person by person. What fits is unfolded; the rest is one press away.
  const people = window.getByTestId('run-person');
  await expect(people).toHaveCount(2);
  const josiah = people.nth(0);
  await expect(josiah.getByTestId('run-person-found')).toContainText(
    'WikiTree: 1 fits well, 1 other · Open Archives (Open Archieven): nothing found',
  );
  await expect(josiah.getByTestId('record-result')).toHaveCount(2);
  await expect(josiah.getByTestId('record-fit').first()).toHaveText('Fits well');
  const ezra = people.nth(1);
  await expect(ezra).toContainText('Ezra Marsh parent');
  await expect(ezra.getByTestId('run-person-found')).toContainText('WikiTree: 2 others');
  await expect(ezra.getByTestId('record-result')).toHaveCount(0);
  await ezra.getByTestId('run-person-toggle').click();
  await expect(ezra.getByTestId('record-result')).toHaveCount(2);

  // Nothing of it is in the tree until a result is kept, by a press for that result.
  await expect(window.getByTestId('open-inbox')).toHaveText('Inbox');
  await josiah.getByTestId('record-keep').first().click();
  await expect(josiah.getByTestId('record-kept')).toHaveCount(1);
  // The same record was found for the father, and is still his to keep.
  await ezra.getByTestId('record-keep').first().click();
  await expect(ezra.getByTestId('record-kept')).toHaveCount(1);
  // One he turns down is left out, and counted.
  await ezra.getByTestId('record-decline').last().click();
  await expect(ezra.getByTestId('record-result')).toHaveCount(1);
  await expect(window.getByTestId('run-declined-count')).toContainText(
    '1 result you turned down is not shown',
  );
  await window.getByTestId('run-close').click();
  await expect(window.getByTestId('record-run')).toHaveCount(0);
  await expect(window.getByTestId('open-inbox')).toHaveText('Inbox (2)');
  await expect(window.getByTestId('undo')).toHaveAttribute(
    'title',
    'Undo Turn a record down (Ctrl+Z)',
  );
  // Nothing was asked after the run ended.
  expect(await askedOfInternet(app)).toHaveLength(4);
});

test('a search for ancestors stops when told to, when its window closes, and when the page loads again', async ({
  app,
  window,
}) => {
  await answerRuns(app, { slowMs: 1500 });
  await family(window, { birthDate: '1824' });
  await openRun(window, true);
  await expect(window.getByTestId('run-asked-count')).toHaveText('3 people are asked for');

  await window.getByTestId('run-start').click();
  await expect(window.getByTestId('run-status')).toContainText('Searching');
  await window.getByTestId('run-stop').click();
  await expect(window.getByTestId('run-status')).toContainText('The search was stopped.');
  await expect(window.getByTestId('run-stop')).toHaveCount(0);
  const sent = (await askedOfInternet(app)).length;
  expect(sent).toBeLessThan(3);
  await expect(window.getByTestId('run-person').last()).toContainText('WikiTree: not asked');
  await window.getByTestId('run-close').click();

  // Started again and left by closing the window: nothing more is asked after that.
  await openRun(window, false);
  await window.getByTestId('run-start').click();
  await expect(window.getByTestId('run-status')).toContainText('Searching');
  await window.getByTestId('run-close').click();
  await expect(window.getByTestId('record-run')).toHaveCount(0);
  const after = (await askedOfInternet(app)).length;
  // Long enough for two more questions, had the run gone on.
  await window.waitForTimeout(4000);
  expect(await askedOfInternet(app)).toHaveLength(after);
  expect(after).toBeLessThan(sent + 3);

  // Started once more, and the page is loaded again, which closes no window
  // in the page's own eyes: the search ends all the same.
  await openRun(window, false);
  await window.getByTestId('run-start').click();
  await expect(window.getByTestId('run-status')).toContainText('Searching');
  await window.reload();
  await expect(window.getByTestId('record-run')).toHaveCount(0);
  const atReload = (await askedOfInternet(app)).length;
  await window.waitForTimeout(4000);
  expect(await askedOfInternet(app)).toHaveLength(atReload);
});

test('a search for ancestors leaves a source alone that asks for it', async ({ app, window }) => {
  await answerRuns(app, { busy: true });
  await family(window);
  await openRun(window, true);
  await window.getByTestId('run-source-open-archives').check();

  await window.getByTestId('run-start').click();
  await expect(window.getByTestId('run-status')).toContainText('The search is finished.', {
    timeout: 20_000,
  });
  for (const id of ['wikitree', 'open-archives']) {
    const progress = window.getByTestId(`run-progress-${id}`);
    await expect(progress).toContainText('asks to be left alone');
    await expect(progress).toContainText('It can be asked again at');
  }
  await expect(window.getByTestId('run-person').first()).toContainText('WikiTree: not asked');
  // Each was asked once, and not again for the second person.
  expect(await askedOfInternet(app)).toHaveLength(2);

  // The next list says that they are to be left alone.
  await window.getByTestId('run-close').click();
  await openRun(window, false);
  await expect(window.getByTestId('run-sources')).toContainText('It asked to be left alone until');
});
