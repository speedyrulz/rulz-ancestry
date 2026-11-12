import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export type AppTarget = 'built' | 'packaged';

export interface AppOptions {
  /** Which form of the app to launch; set per project in playwright.config.ts. */
  appTarget: AppTarget;
}

interface AppFixtures {
  /** A throwaway profile folder, so tests never touch the real user's data. */
  userDataDir: string;
  app: ElectronApplication;
  window: Page;
}

const desktopDir = resolve(import.meta.dirname, '..');
const packagedExe = join(desktopDir, 'release', 'win-unpacked', 'RulZ Ancestry.exe');

export const test = base.extend<AppOptions & AppFixtures>({
  appTarget: ['built', { option: true }],

  // Playwright requires the first argument to be an object destructuring pattern.
  // eslint-disable-next-line no-empty-pattern
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'rulz-e2e-'));
    await use(dir);
    // SQLite and Chromium release their file handles shortly after exit.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  },

  app: async ({ appTarget, userDataDir }, use) => {
    const userData = `--user-data-dir=${userDataDir}`;
    const app =
      appTarget === 'packaged'
        ? await electron.launch({ executablePath: packagedExe, args: [userData] })
        : await electron.launch({ args: [desktopDir, userData], cwd: desktopDir });
    await use(app);
    await app.close();
  },

  window: async ({ app }, use) => {
    await use(await app.firstWindow());
  },
});

export { expect } from '@playwright/test';
