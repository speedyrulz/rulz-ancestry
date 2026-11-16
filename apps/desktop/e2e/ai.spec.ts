import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  addPerson,
  addRelative,
  bridgeFile,
  catchFilesHandedOver,
  createTree,
  expect,
  handedOver,
  launchApp,
  test,
  type AppTarget,
} from './fixtures';

/**
 * The optional AI assistant. Where a test needs an AI, it stands in for an
 * AI app the way a real one connects: it starts the bridge the app hands
 * out, as a program of its own, and speaks the Model Context Protocol to it.
 * The bridge reaches the running app over the pipe of the session. This is
 * the same for the built and for the packaged app.
 */

/** What the test calls itself to the bridge, as an AI app does. */
const STAND_IN = 'a test in the place of an AI app';

/** The file the app writes for its bridge while a session is under way. */
const CONNECTOR_FILE = 'ai-connector.json';

/** Starts the bridge as an AI app would, told where this run of the app keeps its data. */
async function connectAi(appTarget: AppTarget, userDataDir: string): Promise<Client> {
  const client = new Client({ name: STAND_IN, version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bridgeFile(appTarget)],
      env: { RULZ_KINSPORA_PROFILE: userDataDir },
    }),
  );
  return client;
}

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

/** Calls a tool of the assistant as an AI app does: through the bridge. */
async function aiCall(
  client: Client,
  name: string,
  input: Record<string, unknown>,
): Promise<{ answer: ToolAnswer }> {
  const result = await client.callTool({ name, arguments: input });
  const [first] = result.content as { type: string; text: string }[];
  if (first?.type !== 'text') throw new Error('the bridge answered with no text');
  const said = JSON.parse(first.text) as Record<string, unknown>;
  return {
    answer:
      result.isError === true
        ? { ok: false, reason: String(said['reason']), message: String(said['message']) }
        : { ok: true, value: said },
  };
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
  userDataDir,
}) => {
  await answerSources(app);
  await catchFilesHandedOver(app);
  // What the app would put on the clipboard is noted, and the clipboard of this PC is left alone.
  await app.evaluate(({ clipboard }) => {
    const copied: string[] = [];
    (globalThis as unknown as { copied: string[] }).copied = copied;
    (clipboard as unknown as { writeText: (text: string) => void }).writeText = (text) => {
      copied.push(text);
    };
  });
  await family(window);

  // Off to begin with: the window says what turning it on means, and offers no session.
  await window.getByTestId('open-ai-assistant').click();
  const assistant = window.getByTestId('ai-assistant');
  await expect(assistant.getByTestId('ai-notice')).toContainText('it is off');
  await expect(assistant.getByTestId('ai-notice-connect')).toContainText(
    'through a connector of this app that you install in your own Claude Desktop',
  );
  await expect(assistant.getByTestId('ai-notice-same-account')).toContainText(
    'another program that runs under your Windows account could read that key',
  );
  await expect(assistant.getByTestId('ai-notice-other-tools')).toContainText(
    'This app takes proposals only for records it fetched itself',
  );
  await expect(assistant.getByTestId('ai-notice-api-key')).toContainText(
    'only after you save a key and start a run',
  );
  await expect(assistant.getByTestId('ai-notice')).toContainText('2 hours after it started');
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
  // How an AI app is connected: the connector file is shown in its folder, and the command can be copied.
  const connect = assistant.getByTestId('ai-connect');
  await connect.locator('summary').click();
  await connect.getByTestId('ai-connector-show').click();
  const shown = await handedOver(app);
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatch(/^show .*[\\/]out[\\/]connector[\\/]rulz-kinspora\.mcpb$/);
  expect(existsSync((shown[0] ?? '').slice('show '.length))).toBe(true);
  const command = (await connect.getByTestId('ai-connector-command').textContent()) ?? '';
  // This run keeps its data in a folder of its own, so the command says where.
  expect(command).toMatch(
    /^claude mcp add rulz-kinspora --scope user --transport stdio --env "RULZ_KINSPORA_PROFILE=[^"]+" "--" node "[^"]+bridge\.cjs"$/,
  );
  expect(command).toContain(`RULZ_KINSPORA_PROFILE=${userDataDir}"`);
  // And the window names that folder for the connector's setting in Claude Desktop.
  await expect(connect.getByTestId('ai-connector-data-folder')).toHaveText(userDataDir);
  await expect(connect.getByTestId('ai-connector-ways')).toContainText('Install Extension');
  await connect.getByTestId('ai-connector-copy').click();
  await expect(connect.getByTestId('ai-connector-copied')).toBeVisible();
  expect(await app.evaluate(() => (globalThis as unknown as { copied: string[] }).copied)).toEqual([
    command,
  ]);
  // No session, so nothing listens and there is no key.
  expect(existsSync(join(userDataDir, CONNECTOR_FILE))).toBe(false);
  await expect(assistant.getByTestId('ai-route-app')).toBeChecked();
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
  await expect(assistant.getByTestId('ai-session-status')).toContainText('at the latest');
  await expect(assistant.getByTestId('ai-session-clients')).toContainText(
    'No AI app is connected to this session yet',
  );
  // Now the app listens for its bridge, and the file that says where is there.
  await expect.poll(() => existsSync(join(userDataDir, CONNECTOR_FILE))).toBe(true);
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
  expect(existsSync(join(userDataDir, CONNECTOR_FILE))).toBe(false);
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
  await answerSources(app);
  await family(window);
  const ai = await connectAi(appTarget, userDataDir);
  try {
    // Before a session, a tool gives nothing, and says what the user has to do.
    const early = await aiCall(ai, 'get_session', {});
    expect(early.answer).toMatchObject({ ok: false, reason: 'no-session' });
    expect(early.answer.ok ? '' : early.answer.message).toContain('start a session');
    await startSession(window);
    // Nobody is connected until an AI app calls.
    await expect(window.getByTestId('ai-session-clients')).toContainText('No AI app is connected');

    // An AI asks what the session is for, asks WikiTree for Josiah, and proposes a match.
    const session = await aiCall(ai, 'get_session', {});
    if (!session.answer.ok) throw new Error('the session gave nothing');
    // The window says that a program is connected, by the name it gave itself.
    await expect(window.getByTestId('ai-session-clients')).toContainText(
      `Connected now: a program that calls itself "${STAND_IN}" (1.0.0)`,
    );
    // The log has the program that connected, as it named itself.
    await window.getByTestId('ai-log-open').click();
    await expect(window.getByTestId('ai-log')).toContainText(
      `A program connected to the session. It calls itself "${STAND_IN}" (version 1.0.0).`,
    );
    await window.getByTestId('ai-log-close').click();
    await window.getByTestId('ai-close').click();
    const people = session.answer.value['people'] as { id: string; name: string }[];
    // Lydia may be living: she is no part of it.
    expect(people.map((person) => person.name)).toEqual(['Josiah Marsh', 'Ezra Marsh']);
    const josiah = people[0]?.id ?? '';
    const found = await aiCall(ai, 'search_records', {
      personId: josiah,
      sourceId: 'wikitree',
      given: 'Josiah',
      surname: 'Marsh',
      birthYear: 1850,
      deathYear: null,
    });
    if (!found.answer.ok) throw new Error('the search gave nothing');
    const given = found.answer.value['records'] as { ref: string; url: string }[];
    const ref = given.find((record) => record.url.endsWith('Marsh-90001'))?.ref ?? '';
    expect(await askedOfInternet(app)).toHaveLength(1);
    // A name the tree does not have for him is not sent.
    const other = await aiCall(ai, 'search_records', {
      personId: josiah,
      sourceId: 'wikitree',
      given: 'Josiah',
      surname: 'Fenwick',
      birthYear: 1850,
      deathYear: null,
    });
    expect(other.answer).toMatchObject({ ok: false, reason: 'query' });
    expect(await askedOfInternet(app)).toHaveLength(1);
    const proposed = await aiCall(ai, 'propose_match', {
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
    expect((await aiCall(ai, 'get_session', {})).answer).toMatchObject({
      ok: false,
      reason: 'no-session',
    });
    expect(existsSync(join(userDataDir, CONNECTOR_FILE))).toBe(false);
    // What it proposed is still there to look at.
    await expect(window.getByTestId('open-inbox')).toHaveText('Inbox (1 + 1 proposed)');

    // After a restart the proposals are gone, and what was kept still has the AI's reasons.
    await app.close();
    const second = await launchApp(appTarget, userDataDir);
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
  } finally {
    await ai.close();
  }
});

test('the bridge lists the tools at any time, gives nothing without a session, and the page has no way to a tool', async ({
  window,
  appTarget,
  userDataDir,
}) => {
  await expect(window.getByTestId('start-screen')).toBeVisible();
  const ai = await connectAi(appTarget, userDataDir);
  try {
    expect(ai.getServerVersion()?.name).toBe('rulz-kinspora');
    expect((await ai.listTools()).tools.map((tool) => tool.name)).toEqual([
      'get_session',
      'list_sources',
      'search_tree',
      'get_person',
      'get_relatives',
      'search_records',
      'get_record',
      'propose_match',
    ]);
    expect((await ai.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
      'research_session',
    ]);
    for (const name of ['get_session', 'search_tree', 'read_file']) {
      expect((await aiCall(ai, name, {})).answer).toMatchObject({
        ok: false,
        reason: 'no-session',
      });
    }
  } finally {
    await ai.close();
  }
  // The page has the functions of the contract, and none of them calls a tool.
  const api = await window.evaluate(() =>
    Object.keys((globalThis as unknown as { rulz: object }).rulz),
  );
  expect(api.filter((method) => /tool|call|propose/i.test(method))).toEqual([]);
});

test('picks the Anthropic API key route, saves a key, shows the run controls, and removes the key', async ({
  app,
  window,
  userDataDir,
}) => {
  const fakeKey = 'sk-ant-test-canary-0000';
  await answerSources(app);
  await family(window);

  await window.getByTestId('open-ai-assistant').click();
  const assistant = window.getByTestId('ai-assistant');
  await assistant.getByTestId('ai-agree').click();
  await assistant.getByTestId('record-agree').click();

  await assistant.getByTestId('ai-route-api').check();
  await expect(assistant.getByTestId('ai-route-api')).toBeChecked();
  await expect(assistant.getByTestId('ai-key-state')).toContainText('missing');

  const keyInput = assistant.getByTestId('ai-key-input');
  await expect(keyInput).toHaveAttribute('type', 'password');
  await keyInput.fill(fakeKey);
  await assistant.getByTestId('ai-key-save').click();

  await expect(assistant.getByTestId('ai-key-state')).toContainText('saved');
  await expect(keyInput).toHaveValue('');
  expect(await window.content()).not.toContain(fakeKey);

  await expect(assistant.getByTestId('ai-run-model')).toHaveValue('claude-opus-5-5');
  await expect(assistant.getByTestId('ai-run-effort')).toHaveValue('medium');
  await expect(assistant.getByTestId('ai-effort-hint')).toContainText('thinking');
  await expect(assistant.getByTestId('ai-run-cap')).toHaveValue('1');
  await expect(assistant.getByTestId('ai-price-note')).toContainText('2026-11-15');

  await assistant.getByTestId('ai-source-wikitree').check();
  await assistant.getByTestId('ai-start').click();
  await expect(assistant.getByTestId('ai-session-status')).toContainText('A session is under way');
  // A route-C session never opens the connector pipe.
  expect(existsSync(join(userDataDir, CONNECTOR_FILE))).toBe(false);
  await expect(assistant.getByTestId('ai-run-start')).toBeEnabled();

  await assistant.getByTestId('ai-key-remove').click();
  await expect(assistant.getByTestId('ai-key-state')).toContainText('missing');
  await expect(assistant.getByTestId('ai-run-start')).toBeDisabled();

  await assistant.getByTestId('ai-stop').click();
  expect(await askedOfInternet(app)).toEqual([]);
});
