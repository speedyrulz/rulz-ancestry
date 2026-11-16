import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The root vitest.config.ts only collects packages and the desktop app.
// These checks live next to the release scripts, so `pnpm test` runs them
// with this config.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    name: 'release',
    environment: 'node',
    include: ['*.test.mjs'],
  },
});
