import { defineConfig } from '@playwright/test';
import type { AppOptions } from './e2e/fixtures';

export default defineConfig<AppOptions>({
  testDir: './e2e',
  timeout: 60_000,
  // Each test launches the whole app; run them one at a time.
  workers: 1,
  reporter: 'list',
  projects: [
    // The production build in out/, run with the Electron from node_modules.
    { name: 'built', use: { appTarget: 'built' } },
    // The unpacked installer contents in release/win-unpacked.
    { name: 'packaged', use: { appTarget: 'packaged' } },
  ],
});
