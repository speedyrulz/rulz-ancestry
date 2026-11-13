import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { internetArchiveManifest } from './manifest';
import { internetArchiveConnector } from './search';

/**
 * Asks the Internet Archive itself, to notice when its answers change shape.
 * This is not part of the unit tests: it needs the internet, and it runs on
 * its own schedule (`pnpm test:contract`, `.github/workflows/contract.yml`).
 *
 * It sends one search, for texts about the family of a writer who died in
 * 1910, and looks at the shape of the answer only.
 */
describe('The Internet Archive, asked live', () => {
  it('answers a search for texts in the shape the connector reads', async () => {
    const http = new HttpClient({
      fetch: (url, init) => fetch(url, init),
      userAgent: 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
      timeoutMs: 60_000,
    });
    const connector = internetArchiveConnector(http.for(internetArchiveManifest));
    const { page } = await connector.searchTexts(
      { words: 'Clemens family', phrase: true, fromYear: null, toYear: null, state: '' },
      { offset: 0, limit: 5 },
    );
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);
    for (const record of page.items) {
      expect(record.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(record.title).not.toBe('');
      expect(record.url).toBe(`https://archive.org/details/${record.key}`);
    }
    // At least one comes with the year it was published.
    expect(page.items.some((record) => /^\d{4}$/.test(record.date))).toBe(true);
  }, 90_000);
});
