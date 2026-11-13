import { defineConfig } from 'vitest/config';

// The checks that ask the sources themselves. They need the internet and are
// not part of `pnpm test`; see `.github/workflows/contract.yml`.
export default defineConfig({
  test: {
    include: ['packages/connectors/src/**/*.contract.ts'],
    environment: 'node',
    // One at a time: a source is never asked by two checks at once.
    fileParallelism: false,
  },
});
