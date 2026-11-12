import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The desktop app's main-process modules that do not need Electron are tested here too.
    include: ['packages/*/src/**/*.test.ts', 'apps/desktop/src/main/**/*.test.ts'],
    environment: 'node',
  },
});
