import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

test('creates its database inside the profile folder', async ({ window, userDataDir }) => {
  const shown = await window.getByTestId('database-path').innerText();
  expect(resolve(shown)).toBe(resolve(userDataDir, 'app.db'));
  expect(existsSync(shown)).toBe(true);
});

test('lists the data sources from the connector registry', async ({ window }) => {
  await expect(window.getByTestId('source-count')).toHaveText(
    '8 (5 live, 2 downloadable, 1 link-only)',
  );
});

test('keeps Node.js out of the page', async ({ window }) => {
  const exposed = await window.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    api: Object.keys((globalThis as Record<string, unknown>)['rulz'] ?? {}),
  }));
  expect(exposed).toEqual({ require: 'undefined', process: 'undefined', api: ['getAppInfo'] });
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
