import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Page } from '@playwright/test';
import { expect, test, launchApp } from './fixtures';

/**
 * A local stand-in for GitHub: `latest.yml` as electron-builder writes it, and a small dummy
 * installer. Nothing here reaches GitHub: the app under test is not packaged, so it takes the
 * feed from the switch and the installer from the same folder.
 */
const EXE = Buffer.from('not a real installer, only bytes to download and check\n'.repeat(6000));
const EXE_SHA = createHash('sha512').update(EXE).digest('base64');

interface Feed {
  server: Server;
  port: number;
  /** How many times `latest.yml` was asked for. */
  feedRequests: () => number;
  setVersion: (version: string) => void;
  /** Serve different bytes than the feed's hash describes. */
  corrupt: () => void;
  exeRequests: () => number;
}

async function startFeed(initial: string): Promise<Feed> {
  let version = initial;
  let corrupt = false;
  let feedRequests = 0;
  let exeRequests = 0;
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/latest.yml')) {
      feedRequests++;
      const name = `RulZ-Kinspora-Setup-${version}.exe`;
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end(
        [
          `version: ${version}`,
          'files:',
          `  - url: ${name}`,
          `    sha512: ${EXE_SHA}`,
          `    size: ${EXE.length}`,
          `path: ${name}`,
          `sha512: ${EXE_SHA}`,
          "releaseDate: '2026-01-01T00:00:00.000Z'",
          '',
        ].join('\n'),
      );
      return;
    }
    if (request.url === `/RulZ-Kinspora-Setup-${version}.exe`) {
      exeRequests++;
      const body = corrupt ? Buffer.alloc(EXE.length, 1) : EXE;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      });
      // In two parts with a pause, so that the progress bar is on screen for a moment.
      response.write(body.subarray(0, body.length / 2));
      setTimeout(() => response.end(body.subarray(body.length / 2)), 600);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test feed address');
  return {
    server,
    port: address.port,
    feedRequests: () => feedRequests,
    exeRequests: () => exeRequests,
    setVersion: (next) => void (version = next),
    corrupt: () => void (corrupt = true),
  };
}
/** Serious and critical axe findings inside one part of the page (the same bar as the accessibility spec). */
async function problemsIn(window: Page, include: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page: window })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .include(include)
    .analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);
}
const stopFeed = (feed: Feed) =>
  new Promise<void>((resolve, reject) =>
    feed.server.close((error) => (error ? reject(error) : resolve())),
  );

test('offers the update at launch, downloads and checks it, and respects the startup setting', async ({
  appTarget,
  userDataDir,
}) => {
  test.skip(appTarget !== 'built', 'The packaged app deliberately ignores test feeds.');
  const feed = await startFeed('9999.0.0');
  const args = [`--rulz-update-feed=http://127.0.0.1:${feed.port}/latest.yml`];
  let app = await launchApp(appTarget, userDataDir, args);
  try {
    const runningVersion = await app.evaluate(({ app: electronApp, shell }) => {
      (globalThis as unknown as { opened: string[] }).opened = [];
      shell.openExternal = async (url) => {
        (globalThis as unknown as { opened: string[] }).opened.push(url);
      };
      return electronApp.getVersion();
    });
    let window = await app.firstWindow();
    const notice = window.getByTestId('update-notice');
    await expect(notice.getByText('Version 9999.0.0 is available.')).toBeVisible({
      timeout: 15000,
    });
    // The notice offers the update, a way to leave it, and the switch for the check at startup.
    await expect(notice.getByRole('button', { name: 'Update now' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Not now' })).toBeVisible();
    await expect(
      notice.getByRole('switch', { name: 'Check for updates when the app starts' }),
    ).toHaveAttribute('aria-checked', 'true');

    expect(await problemsIn(window, '[data-testid="update-notice"]')).toEqual([]);

    // Update now: the bar and its percentage, then "checked" and no install, since this build is
    // not an installed copy; the release page is the way on.
    await notice.getByRole('button', { name: 'Update now' }).click();
    await expect(notice.getByTestId('update-progress-text-notice')).toContainText(
      'Downloading version',
    );
    await expect(
      notice.getByText(/downloaded and checked, but this copy of the app cannot/),
    ).toBeVisible({
      timeout: 15000,
    });
    expect(feed.exeRequests()).toBe(1);
    // The live region speaks the phases, not every percent.
    await expect(window.getByTestId('update-live')).toContainText('Downloaded and checked');
    expect(await problemsIn(window, '[data-testid="update-notice"]')).toEqual([]);
    await notice.getByRole('button', { name: 'Open release page' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual(['https://github.com/speedyrulz/rulz-kinspora/releases/tag/v9999.0.0']);

    await notice.getByRole('switch').click();
    await expect(notice.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await app.close();
    feed.setVersion(runningVersion);
    app = await launchApp(appTarget, userDataDir, args);
    window = await app.firstWindow();
    const before = feed.feedRequests();
    await window.getByRole('button', { name: 'App updates' }).click();
    const dialog = window.getByTestId('updates-panel');
    await expect(
      dialog.getByRole('switch', { name: 'Check for updates when the app starts' }),
    ).toHaveAttribute('aria-checked', 'false');
    await window.waitForTimeout(6500);
    expect(feed.feedRequests()).toBe(before);
    await dialog.getByRole('button', { name: 'Check now' }).click();
    await expect(dialog.getByText('You have the newest version.')).toBeVisible();
    expect(feed.feedRequests()).toBe(before + 1);
  } finally {
    await app.close().catch(() => undefined);
    await stopFeed(feed);
  }
});

test('Not now hides the notice for that version and the panel still checks by hand', async ({
  appTarget,
  userDataDir,
}) => {
  test.skip(appTarget !== 'built', 'The packaged app deliberately ignores test feeds.');
  const feed = await startFeed('9999.0.0');
  const app = await launchApp(appTarget, userDataDir, [
    `--rulz-update-feed=http://127.0.0.1:${feed.port}/latest.yml`,
  ]);
  try {
    const window = await app.firstWindow();
    const notice = window.getByTestId('update-notice');
    await expect(notice).toBeVisible({ timeout: 15000 });
    await notice.getByRole('button', { name: 'Not now' }).click();
    await expect(notice).toHaveCount(0);
    // The keyboard focus goes to the button that opens the updates panel.
    await expect(window.getByRole('button', { name: /^App updates/ })).toBeFocused();
    await window.getByRole('button', { name: /^App updates/ }).click();
    const dialog = window.getByTestId('updates-panel');
    await dialog.getByRole('button', { name: 'Check now' }).click();
    // A check the user starts offers the dismissed version again, with Update now.
    await expect(dialog.getByText('Version 9999.0.0 is available.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Update now' })).toBeVisible();
    expect(await problemsIn(window, '[data-testid="updates-panel"]')).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await stopFeed(feed);
  }
});

test('a download that does not match the release is refused, with a way to the release page', async ({
  appTarget,
  userDataDir,
}) => {
  test.skip(appTarget !== 'built', 'The packaged app deliberately ignores test feeds.');
  const feed = await startFeed('9999.0.0');
  feed.corrupt();
  const app = await launchApp(appTarget, userDataDir, [
    `--rulz-update-feed=http://127.0.0.1:${feed.port}/latest.yml`,
  ]);
  try {
    const window = await app.firstWindow();
    const notice = window.getByTestId('update-notice');
    await expect(notice).toBeVisible({ timeout: 15000 });
    await notice.getByRole('button', { name: 'Update now' }).click();
    await expect(notice.getByTestId('update-failure-notice')).toContainText(
      'did not match the release',
      {
        timeout: 15000,
      },
    );
    await expect(window.getByTestId('update-live')).toContainText('The update failed');
    // The fallback is there, and the update can be tried again.
    await expect(notice.getByRole('button', { name: 'Open release page' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Update now' })).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await stopFeed(feed);
  }
});
