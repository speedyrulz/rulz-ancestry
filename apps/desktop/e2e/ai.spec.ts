import type { ElectronApplication, Page } from '@playwright/test';
import { addPerson, addRelative, createTree, expect, launchApp, test } from './fixtures';

/**
 * The optional AI assistant. This version of the app has no way to connect an
 * AI to a session, so where a test needs one it stands in for it: the app is
 * started with a switch that hands a test the function that takes a call of a
 * tool. Only an app that is not packaged honours the switch, so the tests
 * that call a tool run against the built app only.
 */
const AI_TEST_SWITCH = '--e2e-ai-tools';

test.use({ appArgs: [AI_TEST_SWITCH] });

/**
 * Makes the app's requests to the internet answer as WikiTree would, with two
 * profiles of people who are made up, and notes every address asked for.
 * The tests never reach a source.
 */
async function answerSources(app: ElectronApplication): Promise<void> {
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
    ({ net, session }, matches) => {
      const asked: string[] = [];
      (globalThis as unknown as { askedOfInternet: string[] }).askedOfInternet = asked;
      // Anything the app asks for by another way than its search is a mistake of the test.
      net.fetch = (input) => {
        asked.push(`unexpected: ${typeof input === 'string' ? input : input.url}`);
        return Promise.resolve(new Response('', { status: 500 }));
      };
      session.fromPartition('records').fetch = (input) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        if (new URL(url).host !== 'api.wikitree.com') {
          return Promise.resolve(new Response('', { status: 500 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify([{ status: 0, matches, total: 2, start: 0 }])),
        );
      };
    },
    [profile(1, 'Josiah'), profile(2, 'Abel')],
  );
}

function askedOfInternet(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { askedOfInternet?: string[] }).askedOfInternet ?? [],
  );
}

type ToolAnswer =
  { ok: true; value: Record<string, unknown> } | { ok: false; reason: string; message: string };

/**
 * Calls a tool of the assistant as an AI would, in the app's main process.
 * `hook` is false when the app did not hand the function over: it was started
 * without the switch, or it is packaged.
 */
function aiCall(
  app: ElectronApplication,
  name: string,
  input: unknown,
): Promise<{ hook: boolean; answer: ToolAnswer | null }> {
  return app.evaluate(
    async (_electron, asked) => {
      const call = (globalThis as unknown as Record<symbol, unknown>)[
        Symbol.for('rulz.e2e.aiCall')
      ] as ((name: string, input: unknown) => Promise<ToolAnswer>) | undefined;
      return call === undefined
        ? { hook: false, answer: null }
        : { hook: true, answer: await call(asked.name, asked.input) };
    },
    { name, input },
  );
}

/** Josiah Marsh with his father Ezra and his mother Lydia, who has no dates and so may be living. */
async function family(window: Page): Promise<void> {
  await createTree(window, 'Assistant');
  await addPerson(window, {
    given: 'Josiah',
    surname: 'Marsh',
    birthDate: '12 MAR 1850',
    deathDate: 'ABT 1912',
  });
  await window.getByTestId('add-parent').click();
  await addRelative(window, { given: 'Ezra', surname: 'Marsh', birthDate: '1820' });
  await window.getByTestId('add-other-parent').click();
  await addRelative(window, { given: 'Lydia', surname: 'Marsh' });
}

/** Turns the assistant on from Josiah's page, agrees to both notices, and starts a session that may ask WikiTree. */
async function startSession(window: Page): Promise<void> {
  await window.getByTestId('open-ai-assistant').click();
  await window.getByTestId('ai-agree').click();
  await window.getByTestId('record-agree').click();
  await window.getByTestId('ai-source-wikitree').check();
  await window.getByTestId('ai-start').click();
  await expect(window.getByTestId('ai-session-status')).toContainText('A session is under way');
}

test('the AI assistant is off until its notice is agreed to; a session is listed first, started, shown and stopped', async ({
  app,
  window,
}) => {
  await answerSources(app);
  await family(window);

  // Off to begin with: the window says what turning it on means, and offers no session.
  await window.getByTestId('open-ai-assistant').click();
  const assistant = window.getByTestId('ai-assistant');
  await expect(assistant.getByTestId('ai-notice')).toContainText('it is off');
  await expect(assistant.getByTestId('ai-notice-connect')).toContainText(
    'No AI can be connected in this version yet',
  );
  await expect(assistant.getByTestId('ai-notice-sources').locator('li')).toHaveText([
    /^WikiTree: /,
    /^Open Archives /,
    /^Wikidata: /,
  ]);
  await expect(assistant.getByTestId('ai-notice')).toContainText('never the text of a record');
  await expect(assistant.getByTestId('ai-start')).toHaveCount(0);

  // Turned on, the notice of the search comes next, since a session asks through the search.
  await assistant.getByTestId('ai-agree').click();
  await expect(assistant.getByTestId('ai-needs-search-notice')).toBeVisible();
  await expect(assistant.getByTestId('ai-start')).toHaveCount(0);
  await assistant.getByTestId('record-agree').click();

  // Who a session would be for, and who is left out. No service is ticked, so nothing can start.
  await expect(assistant.getByTestId('ai-no-connection')).toContainText('nothing will call');
  await expect(assistant.getByTestId('ai-plan-people').locator('li')).toHaveText([
    'Josiah Marsh',
    'Ezra Marsh (parent)',
  ]);
  await expect(assistant.getByTestId('ai-plan-left-out')).toContainText(
    'Lydia Marsh (parent): may be living',
  );
  await expect(assistant.getByTestId('ai-plan-count')).toHaveText('Tick a service the AI may ask.');
  await expect(assistant.getByTestId('ai-start')).toBeDisabled();
  await assistant.getByTestId('ai-generations').selectOption('0');
  await expect(assistant.getByTestId('ai-plan-people').locator('li')).toHaveText(['Josiah Marsh']);
  await assistant.getByTestId('ai-generations').selectOption('1');
  await assistant.getByTestId('ai-source-wikitree').check();
  await expect(assistant.getByTestId('ai-plan-count')).toContainText(
    'at most 10 questions about these 2 people',
  );

  await assistant.getByTestId('ai-start').click();
  await expect(assistant.getByTestId('ai-session-status')).toContainText('A session is under way');
  await expect(assistant.getByTestId('ai-session-people').locator('li')).toHaveText([
    'Josiah Marsh',
    'Ezra Marsh',
  ]);
  await expect(assistant.getByTestId('ai-session-sources')).toHaveText(
    'WikiTree: 0 of 10 questions asked',
  );
  await expect(assistant.getByTestId('ai-session-calls')).toHaveText(
    '0 of the 500 calls a session takes.',
  );
  // While it is under way, no other session is offered.
  await expect(assistant.getByTestId('ai-plan')).toHaveCount(0);

  // The session goes on when its window is closed, and the workspace says so.
  await assistant.getByTestId('ai-close').click();
  const line = window.getByTestId('ai-session-line');
  await expect(line).toContainText('An AI session is under way: 0 calls, 0 questions to services.');
  await line.getByTestId('ai-session-show').click();
  await expect(assistant.getByTestId('ai-session-status')).toContainText('A session is under way');
  await assistant.getByTestId('ai-close').click();

  await line.getByTestId('ai-session-stop').click();
  await expect(line).toHaveCount(0);
  await window.getByTestId('open-ai-assistant').click();
  await expect(assistant.getByTestId('ai-session-status')).toHaveText('You stopped the session.');
  // A new one can be started from here.
  await expect(assistant.getByTestId('ai-plan')).toBeVisible();

  // The log says what happened, and can be cleared.
  await assistant.getByTestId('ai-log-open').click();
  const log = window.getByTestId('ai-log');
  await expect(log.getByTestId('ai-log-entry')).toHaveText([
    /The session ended: you stopped it\. 0 calls, 0 questions to services, 0 proposals\.$/,
    /A session started for Josiah Marsh and 1 generation of their ancestors: 2 people\. It may ask WikiTree\.$/,
  ]);
  await log.getByTestId('ai-log-clear').click();
  await window.getByTestId('confirm-dialog').getByTestId('dialog-submit').click();
  await expect(log.getByTestId('ai-log-empty')).toBeVisible();
  await log.getByTestId('ai-log-close').click();

  // Turned off again, the window is back at its notice.
  await assistant.getByTestId('ai-turn-off').click();
  await window.getByTestId('confirm-dialog').getByTestId('dialog-submit').click();
  await expect(assistant.getByTestId('ai-notice')).toBeVisible();

  // None of this asked anything of the internet.
  expect(await askedOfInternet(app)).toEqual([]);
});

test('a proposal of the AI is shown with its reasons, and a record kept from it keeps them', async ({
  app,
  window,
  appTarget,
  userDataDir,
}) => {
  test.skip(appTarget === 'packaged', 'the packaged app hands no test the tools');
  await answerSources(app);
  await family(window);

  // Before a session, a tool gives nothing.
  expect((await aiCall(app, 'get_session', {})).answer).toMatchObject({
    ok: false,
    reason: 'no-session',
  });
  await startSession(window);
  await window.getByTestId('ai-close').click();

  // An AI asks what the session is for, asks WikiTree for Josiah, and proposes a match.
  const session = await aiCall(app, 'get_session', {});
  if (session.answer?.ok !== true) throw new Error('the session gave nothing');
  const people = session.answer.value['people'] as { id: string; name: string }[];
  // Lydia may be living: she is no part of it.
  expect(people.map((person) => person.name)).toEqual(['Josiah Marsh', 'Ezra Marsh']);
  const josiah = people[0]?.id ?? '';
  const found = await aiCall(app, 'search_records', {
    personId: josiah,
    sourceId: 'wikitree',
    given: 'Josiah',
    surname: 'Marsh',
    birthYear: 1850,
    deathYear: null,
  });
  if (found.answer?.ok !== true) throw new Error('the search gave nothing');
  const given = found.answer.value['records'] as { ref: string; url: string }[];
  const ref = given.find((record) => record.url.endsWith('Marsh-90001'))?.ref ?? '';
  expect(await askedOfInternet(app)).toHaveLength(1);
  // A name the tree does not have for him is not sent.
  const other = await aiCall(app, 'search_records', {
    personId: josiah,
    sourceId: 'wikitree',
    given: 'Josiah',
    surname: 'Fenwick',
    birthYear: 1850,
    deathYear: null,
  });
  expect(other.answer).toMatchObject({ ok: false, reason: 'query' });
  expect(await askedOfInternet(app)).toHaveLength(1);
  const proposed = await aiCall(app, 'propose_match', {
    personId: josiah,
    ref,
    verdict: 'fits',
    confidence: 'medium',
    reasons: [
      { side: 'for', text: 'He was born on the day the tree has.', quote: '12 MAR 1850' },
      { side: 'for', text: 'The record names his father.', quote: 'son of Ezra Marsh' },
    ],
  });
  expect(proposed.answer).toMatchObject({ ok: true, value: { filed: true, reasonsKept: 1 } });

  // The workspace follows it, and the window shows every question as it was asked.
  const line = window.getByTestId('ai-session-line');
  await expect(line).toContainText('4 calls, 1 question to services');
  await expect(window.getByTestId('open-inbox')).toHaveText('Inbox (0 + 1 proposed)');
  await line.getByTestId('ai-session-show').click();
  const assistant = window.getByTestId('ai-assistant');
  await expect(assistant.getByTestId('ai-question')).toHaveText([
    'WikiTree, for Josiah Marsh: Josiah Marsh, born 1850; 2 records passed on',
  ]);
  await expect(assistant.getByTestId('ai-session-sources')).toHaveText(
    'WikiTree: 1 of 10 questions asked',
  );

  // The inbox lists the proposal: the record, the app's own label, and what the AI said.
  await assistant.getByTestId('ai-open-inbox').click();
  const inbox = window.getByTestId('record-inbox');
  const proposal = inbox.getByTestId('inbox-proposal');
  await expect(proposal).toHaveCount(1);
  await expect(proposal.getByTestId('inbox-title')).toHaveText('Josiah Marsh');
  await expect(proposal.getByTestId('inbox-fit')).toHaveText('Fits well');
  await expect(proposal.getByTestId('ai-verdict')).toHaveText('AI: fits');
  await expect(proposal.getByTestId('ai-reason')).toHaveText([
    /^For: He was born on the day the tree has\. “12 MAR 1850” \(birth date\)$/,
  ]);
  // The reason whose words are not in the record is counted, and not shown.
  await expect(proposal.getByTestId('proposal-dropped')).toContainText(
    '1 reason of the AI is not shown',
  );
  await expect(inbox).not.toContainText('son of Ezra Marsh');

  // Kept for later, it is in the tree with what the AI said, as one step.
  await proposal.getByTestId('proposal-keep').click();
  await expect(proposal.getByTestId('proposal-kept')).toHaveText('Kept for later');
  await inbox.getByTestId('inbox-tab-kept').click();
  const kept = inbox.getByTestId('inbox-item');
  await expect(kept).toHaveCount(1);
  await expect(kept.getByTestId('ai-verdict')).toHaveText('AI: fits');
  await expect(kept.getByTestId('ai-reason')).toContainText('“12 MAR 1850” (birth date)');
  await inbox.getByTestId('record-inbox-close').click();
  await expect(window.getByTestId('open-inbox')).toHaveText('Inbox (1 + 1 proposed)');
  await expect(window.getByTestId('undo')).toHaveAttribute('title', /Keep a record for later/);

  // Loading the page again ends the session: nobody would see what an AI asks.
  await window.reload();
  await expect(window.getByTestId('workspace')).toBeVisible();
  await expect(window.getByTestId('ai-session-line')).toHaveCount(0);
  expect((await aiCall(app, 'get_session', {})).answer).toMatchObject({
    ok: false,
    reason: 'no-session',
  });
  // What it proposed is still there to look at.
  await expect(window.getByTestId('open-inbox')).toHaveText('Inbox (1 + 1 proposed)');

  // After a restart the proposals are gone, and what was kept still has the AI's reasons.
  await app.close();
  const second = await launchApp(appTarget, userDataDir, [AI_TEST_SWITCH]);
  try {
    const page = await second.firstWindow();
    await expect(page.getByTestId('open-inbox')).toHaveText('Inbox (1)');
    await page.getByTestId('open-inbox').click();
    const again = page.getByTestId('record-inbox').getByTestId('inbox-item');
    await expect(again.getByTestId('ai-verdict')).toHaveText('AI: fits');
    await expect(again.getByTestId('ai-reason')).toContainText('“12 MAR 1850” (birth date)');
    await expect(page.getByTestId('inbox-tab-proposals')).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test('the tools are handed to a test only by an app that is not packaged, and never to the page', async ({
  app,
  window,
  appTarget,
}) => {
  await expect(window.getByTestId('start-screen')).toBeVisible();
  // The switch is given in both cases; only the app that is not packaged honours it.
  expect((await aiCall(app, 'get_session', {})).hook).toBe(appTarget === 'built');
  // The page has the functions of the contract, and none of them calls a tool.
  const api = await window.evaluate(() =>
    Object.keys((globalThis as unknown as { rulz: object }).rulz),
  );
  expect(api.filter((method) => /tool|call|propose/i.test(method))).toEqual([]);
});
