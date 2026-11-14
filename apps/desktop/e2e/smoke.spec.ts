import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { API_METHODS } from '../src/shared/ipc';
import { expect, test } from './fixtures';

test('opens the main window', async ({ window }) => {
  await expect(window).toHaveTitle('RulZ Ancestry');
  await expect(window.getByRole('heading', { level: 1, name: 'RulZ Ancestry' })).toBeVisible();
  await expect(window.getByTestId('app-error')).toHaveCount(0);
});

test('reports a working database with full-text search', async ({ window }) => {
  await expect(window.getByTestId('sqlite-version')).toHaveText(/^SQLite 3\.\d+\.\d+/);
  await expect(window.getByTestId('fts5')).toHaveText('Available');
  await expect(window.getByTestId('app-version')).toHaveText(/^\d+\.\d+\.\d+/);
});

test('can build, search and undo a family tree with the shipped database engine', async ({
  window,
}) => {
  // The main process runs this check at start-up against an in-memory tree.
  await expect(window.getByTestId('tree-engine')).toHaveText(/^Ready \(schema version [1-9]\d*\)$/);
});

test('creates its database inside the profile folder', async ({ window, userDataDir }) => {
  const shown = await window.getByTestId('database-path').innerText();
  expect(resolve(shown)).toBe(resolve(userDataDir, 'app.db'));
  expect(existsSync(shown)).toBe(true);
});

test('lists the data sources from the connector registry', async ({ window }) => {
  await expect(window.getByTestId('source-count')).toHaveText(
    '10 (6 live, 2 downloadable, 2 link-only)',
  );
});

test('keeps Node.js out of the page', async ({ window }) => {
  const exposed = await window.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    api: Object.keys((globalThis as Record<string, unknown>)['rulz'] ?? {}),
  }));
  // The page gets the functions of the contract and nothing else.
  expect({ ...exposed, api: [...exposed.api].sort() }).toEqual({
    require: 'undefined',
    process: 'undefined',
    api: [...API_METHODS].sort(),
  });
});

test('checks what the page sends before acting on it', async ({ window, userDataDir }) => {
  await expect(window.getByTestId('start-screen')).toBeVisible();
  const outside = join(userDataDir, 'Outside');
  // Calls made straight to the bridge, as a compromised page could make them.
  const answers = await window.evaluate(async (parentDir) => {
    const bridge = (
      globalThis as unknown as { rulz: Record<string, (...args: unknown[]) => unknown> }
    ).rulz;
    const call = (method: string, ...args: unknown[]) => bridge[method]?.(...args);
    return {
      wrongType: await call('getPersonPage', { id: 1 }),
      noTree: await call('listPersons', { query: '', offset: 0, limit: 10 }),
      unknownKey: await call('addPerson', { given: 'Ada', isAdmin: true }),
      // A folder the user never picked in the system dialog.
      pathOfItsOwn: await call('createTree', { name: 'Tree', parentDir }),
      notRecent: await call('openRecentTree', parentDir),
    };
  }, outside);

  expect(answers).toMatchObject({
    wrongType: { ok: false, error: { code: 'invalid' } },
    noTree: { ok: false, error: { code: 'no-tree', message: 'no family tree is open' } },
    unknownKey: { ok: false, error: { code: 'invalid' } },
    pathOfItsOwn: { ok: false, error: { code: 'rule' } },
    notRecent: { ok: false, error: { code: 'rule' } },
  });
  expect(existsSync(outside)).toBe(false);
});

test('blocks inline scripts through the content security policy', async ({ window }) => {
  await expect(window.getByTestId('app-status')).toBeVisible();
  const result = await window.evaluate(
    () =>
      new Promise<{ ran: boolean; blockedBy: string | null }>((resolve) => {
        let blockedBy: string | null = null;
        document.addEventListener('securitypolicyviolation', (event) => {
          blockedBy = event.effectiveDirective;
        });
        const script = document.createElement('script');
        script.textContent = 'window.__inlineScriptRan = true';
        document.head.append(script);
        setTimeout(() => {
          const ran = (globalThis as Record<string, unknown>)['__inlineScriptRan'] === true;
          resolve({ ran, blockedBy });
        }, 100);
      }),
  );
  // The violation event shows the policy stopped the script, not some other failure.
  expect(result).toEqual({ ran: false, blockedBy: 'script-src-elem' });
});

test('refuses to open new windows', async ({ app, window }) => {
  // Inside evaluate() the code runs in the page, where globalThis is the browser window.
  await window.evaluate(() => {
    globalThis.open('about:blank');
  });
  // Give Electron a moment to (not) create a window.
  await window.waitForTimeout(500);
  expect(app.windows().length).toBe(1);
});
