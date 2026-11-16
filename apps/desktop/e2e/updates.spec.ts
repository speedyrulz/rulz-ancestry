import { createServer } from 'node:http';
import { expect, test, launchApp } from './fixtures';

test('checks the local feed, opens and dismisses a release, and respects the startup setting', async ({
  appTarget,
  userDataDir,
}) => {
  test.skip(appTarget !== 'built', 'The packaged app deliberately ignores test feeds.');
  let version = '9999.0.0';
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'content-type': 'text/yaml' });
    response.end(`version: ${version}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test feed address');
  const args = [`--rulz-update-feed=http://127.0.0.1:${address.port}/latest.yml`];
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
    await expect(window.getByText('Version 9999.0.0 is available.')).toBeVisible({
      timeout: 15000,
    });
    await window.getByRole('button', { name: 'Open release page' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual(['https://github.com/speedyrulz/rulz-kinspora/releases/tag/v9999.0.0']);
    await window.getByRole('button', { name: 'Dismiss' }).click();
    await expect(window.getByText('Version 9999.0.0 is available.')).toHaveCount(0);
    // Dismiss opens the panel and moves keyboard focus to its check button.
    await expect(window.getByRole('button', { name: 'Check for a new version' })).toBeFocused();
    await window.getByLabel('Check for a new version at startup').uncheck();
    await app.close();
    version = runningVersion;
    requests = 0;
    app = await launchApp(appTarget, userDataDir, args);
    window = await app.firstWindow();
    await window.getByRole('button', { name: 'App updates' }).click();
    await expect(window.getByLabel('Check for a new version at startup')).not.toBeChecked();
    await window.waitForTimeout(6500);
    expect(requests).toBe(0);
    await window.getByRole('button', { name: 'Check for a new version' }).click();
    await expect(window.getByText('You have the newest version.')).toBeVisible();
    expect(requests).toBe(1);
  } finally {
    await app.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
