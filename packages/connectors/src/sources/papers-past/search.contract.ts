import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { papersPastManifest } from './manifest';
import { papersPastConnector } from './search';

/**
 * Asks DigitalNZ itself, to notice when its answers change shape. Not part of
 * the unit tests: it needs the internet, and a call without a key spends the
 * allowance shared by everyone who sends none, so it runs only when
 * RULZ_CONTRACT_PAPERS_PAST=1 is set.
 */
describe.skipIf(process.env['RULZ_CONTRACT_PAPERS_PAST'] !== '1')(
  'Papers Past, asked live through DigitalNZ',
  () => {
    it('answers a search of newspaper articles in the shape the connector reads', async () => {
      const http = new HttpClient({
        fetch: (url, init) => fetch(url, init),
        userAgent: 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
        timeoutMs: 60_000,
        keyOf: () => ({ kind: 'none' }),
        memory: { load: () => null, save: () => undefined },
      });
      const connector = papersPastConnector(http.for(papersPastManifest));
      const { page } = await connector.searchTexts(
        { words: 'Wairarapa Daily Times', phrase: false, fromYear: 1900, toYear: 1910, state: '' },
        { offset: 0, limit: 20 },
      );
      expect(page.total).toBeGreaterThan(0);
      expect(page.items.length).toBeGreaterThan(0);
      for (const record of page.items) {
        expect(record.key).toMatch(/^\d{1,15}$/);
        expect(record.title).not.toBe('');
        expect(record.url.startsWith('https://paperspast.natlib.govt.nz/')).toBe(true);
      }
    }, 90_000);
  },
);
