import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Tests that measure how long something takes. They run after all the others
 * and one file at a time, so that what they measure is the code and not how
 * busy the machine is with the rest of the tests.
 */
const TIMED = ['packages/db/src/gedcom/large.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // The desktop app's main-process modules that do not need Electron are tested here too.
          include: ['packages/*/src/**/*.test.ts', 'apps/desktop/src/main/**/*.test.ts'],
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
