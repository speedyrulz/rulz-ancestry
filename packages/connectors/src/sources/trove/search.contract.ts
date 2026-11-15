import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../http';
import { troveManifest } from './manifest';
import { troveConnector } from './search';

// This opt-in check spends a request from the owner's Trove key.
describe.skipIf(!process.env['TROVE_API_KEY'])('Trove, asked live', () => {
  it('answers a newspaper search in the shape the connector reads', async () => {
    const http = new HttpClient({
      fetch: (url, init) => fetch(url, init),
      userAgent: 'RulZAncestry/contract-check',
      keyOf: () => ({ kind: 'key', value: process.env['TROVE_API_KEY'] ?? '' }),
    });
    const { page } = await troveConnector(http.for(troveManifest)).searchTexts(
      { words: 'library', phrase: false, fromYear: null, toYear: null, state: '' },
      { offset: 0, limit: 5 },
    );
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items)
      expect(item.url).toMatch(/^https:\/\/nla\.gov\.au\/nla\.news-article\d+$/);
  }, 90_000);
});
