import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { openArchivesManifest } from './manifest';
import { openArchivesConnector } from './search';

/**
 * Asks Open Archives itself, to notice when its answers change shape. This is
 * not part of the unit tests: it needs the internet, and it runs on its own
 * schedule (`pnpm test:contract`, `.github/workflows/contract.yml`).
 *
 * It sends one search, for a painter who was born in 1853 and died in 1890,
 * and looks at the shape of the answer only.
 */
describe('Open Archives, asked live', () => {
  it('answers a search for a person in the shape the connector reads', async () => {
    const http = new HttpClient({
      fetch: (url, init) => fetch(url, init),
      userAgent: 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
      timeoutMs: 60_000,
    });
    const connector = openArchivesConnector(http.for(openArchivesManifest));
    const { page } = await connector.searchPersons(
      { given: 'Vincent', surname: 'van Gogh', birthYear: 1853, deathYear: 1890 },
      { offset: 0, limit: 10 },
    );
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);
    for (const record of page.items) {
      expect(record.key).toMatch(/^[a-z0-9]+:[A-Za-z0-9-]+\/[A-Za-z0-9:-]+$/);
      expect(record.title).not.toBe('');
      expect(record.url.startsWith('https://www.openarchieven.nl/')).toBe(true);
      expect(record.held).not.toBe('');
    }
    // The span of years keeps the records to the years asked for.
    const years = page.items.map((record) => Number(/\d{4}$/.exec(record.date)?.[0]));
    expect(years.every((year) => year >= 1851 && year <= 1892)).toBe(true);
    // At least one says what the person is in the record, and what the record is of.
    expect(page.items.some((record) => record.role !== '' && record.event !== '')).toBe(true);
  }, 90_000);
});
