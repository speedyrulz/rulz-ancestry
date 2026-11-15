import type { TextQuery } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import type { SourceClient } from '../../http';
import { troveManifest } from './manifest';
import { troveConnector, troveSearchParams, troveWords } from './search';

const query = (changes: Partial<TextQuery> = {}): TextQuery => ({
  words: 'Ada Pembury',
  phrase: true,
  fromYear: 1900,
  toYear: 1910,
  state: 'Victoria',
  ...changes,
});
const page = { offset: 0, limit: 20 };
const setup = () => {
  const requests: Record<string, string | number>[] = [];
  let records: Record<string, unknown> = { article: [], nextStart: 'cursor' };
  const client = {
    manifest: troveManifest,
    getJson: (_path: string, options: { params: Record<string, string | number> }) => {
      requests.push(options.params);
      return Promise.resolve({
        data: { category: [{ records }] },
        fetchedAt: 'now',
        cached: false,
      });
    },
  } as unknown as SourceClient;
  return {
    connector: troveConnector(client),
    requests,
    setRecords: (value: Record<string, unknown>) => {
      records = value;
    },
  };
};

describe('Trove search', () => {
  it('sends only cleaned words, years and paging parameters', async () => {
    const { connector, requests } = setup();
    await connector.searchTexts(query(), { offset: 0, limit: 100 });
    expect(requests[0]).toEqual({
      category: 'newspaper',
      encoding: 'json',
      n: 20,
      q: '"ada pembury" date:[1900 TO 1910]',
      s: '*',
    });
    expect(JSON.stringify(requests)).not.toMatch(/victoria|key/i);
    expect(troveWords(query({ words: 'date:[1900 TO 1910] (x) ~ ^ + ! / "AND OR NOT"' }))).toBe(
      'date 1900 to 1910 x and or not',
    );
  });
  it('closes single years without inverted ranges', () => {
    const q = (changes: Partial<TextQuery>) => troveSearchParams(query(changes), page)['q'];
    expect(q({ fromYear: null, toYear: 1900 })).toContain('date:[1803 TO 1900]');
    expect(q({ fromYear: 1900, toYear: null })).toContain(
      `date:[1900 TO ${new Date().getFullYear()}]`,
    );
    expect(q({ fromYear: 1700, toYear: null })).toContain('date:[1700 TO');
    expect(q({ fromYear: 1900.5, toYear: null })).not.toContain('date:');
  });
  it('refuses years outside the collection, without asking', async () => {
    const { connector, requests } = setup();
    const thisYear = new Date().getFullYear();
    for (const years of [
      { fromYear: null, toYear: 1802 },
      { fromYear: thisYear + 1, toYear: null },
      { fromYear: 1910, toYear: 1900 },
    ]) {
      await expect(connector.searchTexts(query(years), page)).rejects.toMatchObject({
        kind: 'refused',
      });
    }
    await expect(
      connector.searchTexts(query({ fromYear: null, toYear: 1802 }), page),
    ).rejects.toThrow('Trove holds no newspapers from those years (it starts in 1803).');
    expect(requests).toEqual([]);
  });
  it('drops the cursors of an earlier run when a search starts again', async () => {
    const { connector, requests, setRecords } = setup();
    const at = (offset: number) => connector.searchTexts(query(), { offset, limit: 20 });
    setRecords({ article: [], nextStart: 'old-20' });
    await at(0);
    setRecords({ article: [], nextStart: 'old-40' });
    await at(20);
    setRecords({ article: [], nextStart: 'old-60' });
    await at(40);
    setRecords({ article: [], nextStart: 'new-20' });
    await at(0);
    await expect(at(40)).rejects.toThrow('These results have expired. Search again.');
    await at(20);
    expect(requests.at(-1)?.['s']).toBe('new-20');
  });
  it('reads a single article given as an object', async () => {
    const { connector, setRecords } = setup();
    setRecords({ total: 1, article: { id: '123', heading: 'One hit' } });
    const { page: result } = await connector.searchTexts(query(), page);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.key).toBe('123');
  });
  it('uses cursors for the exact query and evicts after 50 entries', async () => {
    const { connector, requests } = setup();
    await connector.searchTexts(query(), page);
    await connector.searchTexts(query(), { offset: 20, limit: 20 });
    expect(requests[1]?.['s']).toBe('cursor');
    await expect(
      connector.searchTexts(query({ words: 'other' }), { offset: 20, limit: 20 }),
    ).rejects.toThrow('These results have expired. Search again.');
    for (let i = 0; i < 50; i++) await connector.searchTexts(query({ words: `name ${i}` }), page);
    await expect(connector.searchTexts(query(), { offset: 20, limit: 20 })).rejects.toThrow(
      'These results have expired. Search again.',
    );
  });
  it('reads safe article fields and leaves out invalid ids', async () => {
    const { connector, setRecords } = setup();
    setRecords({
      total: 2,
      article: [
        {
          id: '123',
          heading: 'A heading',
          title: { title: 'The Paper' },
          date: '1901-02-03',
          page: '12345',
          snippet: '<B>Hi</B> &amp; <script>alert(1)</script> &lt;img&gt;',
          troveUrl: 'https://evil.example/',
        },
        { id: '../4' },
      ],
    });
    const { page: result } = await connector.searchTexts(query(), page);
    expect(result).toMatchObject({
      total: 2,
      hidden: 0,
      next: null,
      items: [
        {
          key: '123',
          url: 'https://nla.gov.au/nla.news-article123',
          title: 'A heading',
          by: 'The Paper',
          date: '3 FEB 1901',
          about: 'Page 12345',
          excerpt: 'Hi & alert(1)',
        },
      ],
    });
    for (const invalid of ['123456', '2a', '']) {
      setRecords({ article: [{ id: '1', page: invalid }] });
      expect((await connector.searchTexts(query(), page)).page.items[0]?.about).toBe('');
    }
  });
});
