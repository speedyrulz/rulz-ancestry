import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { wikitreeManifest } from './manifest';
import { wikitreeConnector } from './search';

/**
 * Asks WikiTree itself, to notice when its answers change shape. This is not
 * part of the unit tests: it needs the internet, and it runs on its own
 * schedule (`pnpm test:contract`, `.github/workflows/contract.yml`).
 *
 * It sends one search, for a writer who died in 1910, and looks at the shape
 * of the answer only. Nothing of it is kept.
 */
describe('WikiTree, asked live', () => {
  it('answers a search for a person in the shape the connector reads', async () => {
    const http = new HttpClient({
      fetch: (url, init) => fetch(url, init),
      userAgent: 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
    });
    const connector = wikitreeConnector(http.for(wikitreeManifest));
    const { page } = await connector.searchPersons(
      { given: 'Samuel', surname: 'Clemens', birthYear: 1835, deathYear: 1910 },
      { offset: 0, limit: 5 },
    );
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);
    for (const record of page.items) {
      expect(record.key).toMatch(/-\d+$/);
      expect(record.title).not.toBe('');
      expect(record.url.startsWith('https://www.wikitree.com/wiki/')).toBe(true);
    }
    // At least one result comes with a year of birth, read as a date.
    const births = page.items
      .flatMap((record) => record.facts)
      .filter((fact) => fact.type === 'birth');
    expect(births.some((fact) => /\b18\d\d$/.test(fact.date))).toBe(true);
  }, 30_000);
});
