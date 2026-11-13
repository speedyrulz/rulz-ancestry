import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { locManifest } from './manifest';
import { locConnector } from './search';

/**
 * Asks the Library of Congress itself, to notice when its answers change
 * shape. This is not part of the unit tests: it needs the internet, and it
 * runs on its own schedule (`pnpm test:contract`, `.github/workflows/contract.yml`).
 *
 * It sends one search of the newspapers, for a writer who died in 1910, in the
 * District of Columbia in that year, and looks at the shape of the answer only.
 */
describe('The Library of Congress, asked live', () => {
  it('answers a search of newspaper pages in the shape the connector reads', async () => {
    const http = new HttpClient({
      fetch: (url, init) => fetch(url, init),
      userAgent: 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
      // The Library can take its time over a search.
      timeoutMs: 60_000,
    });
    const connector = locConnector(http.for(locManifest));
    const { page } = await connector.searchTexts(
      {
        words: 'Samuel Clemens',
        phrase: true,
        fromYear: 1910,
        toYear: 1910,
        state: 'District of Columbia',
      },
      { offset: 0, limit: 5 },
    );
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);
    for (const record of page.items) {
      expect(record.key).toMatch(/^[a-z0-9]+\/1910-\d{2}-\d{2}\/ed-\d+\/seq-\d+$/);
      expect(record.title).not.toBe('');
      expect(record.url.startsWith('https://www.loc.gov/resource/')).toBe(true);
      expect(record.date).toMatch(/1910$/);
    }
  }, 90_000);
});
