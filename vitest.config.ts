import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Tests that measure how long something takes. They run after all the others
 * and one file at a time, so that what they measure is the code and not how
 * busy the machine is with the rest of the tests.
 */
const TIMED = ['packages/db/src/gedcom/large.test.ts'];

/**
 * GitHub's Windows runners sometimes stall on the disk for several seconds, so
 * tests that take a tenth of a second here hit vitest's 5 s limit there. CI gets
 * more room; locally the defaults stay, so a test that really became slow shows.
 * The timed tests check their own durations and are not loosened by this.
 */
const ON_CI = process.env.CI === 'true';

export default defineConfig({
  test: {
    environment: 'node',
    ...(ON_CI ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // The desktop app's main-process modules that do not need Electron are tested here too.
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/desktop/src/main/**/*.test.ts',
            'apps/desktop/src/bridge/**/*.test.ts',
          ],
          exclude: [...configDefaults.exclude, ...TIMED],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'timed',
          include: TIMED,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
