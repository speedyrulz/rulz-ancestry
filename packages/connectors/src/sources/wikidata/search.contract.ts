import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { wikidataManifest } from './manifest';
import { wikidataConnector } from './search';

/**
 * Asks Wikidata itself, to notice when its answers change shape. This is not
 * part of the unit tests: it needs the internet, and it runs on its own
 * schedule (`pnpm test:contract`, `.github/workflows/contract.yml`).
 *
 * It sends one search, for a painter who died in 1890, and looks at the shape
 * of the answer only.
 */
describe('Wikidata, asked live', () => {
  it('answers a search for a person in the shape the connector reads', async () => {
    const http = new HttpClient({
      fetch: (url, init) => fetch(url, init),
      userAgent: 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
      timeoutMs: 60_000,
    });
    const connector = wikidataConnector(http.for(wikidataManifest));
    const { page } = await connector.searchPersons(
      { given: 'Vincent', surname: 'van Gogh', birthYear: 1853, deathYear: 1890 },
      { offset: 0, limit: 5 },
    );
    expect(page.items.length).toBeGreaterThan(0);
    // Several people have this name, so there is more than one page of five.
    expect(page.next).toEqual({ offset: 5, limit: 5 });
    for (const record of page.items) {
      expect(record.key).toMatch(/^Q\d+$/);
      expect(record.title).not.toBe('');
      expect(record.url).toBe(`https://www.wikidata.org/wiki/${record.key}`);
    }
    // The painter comes with his dates, read as dates.
    const painter = page.items.find((record) => record.key === 'Q5582');
    expect(painter?.facts).toEqual([
      { type: 'birth', date: '30 MAR 1853', place: '' },
      { type: 'death', date: '29 JUL 1890', place: '' },
    ]);
    expect(painter?.sex).toBe('M');
    expect(painter?.about).not.toBe('');
  }, 90_000);
});
