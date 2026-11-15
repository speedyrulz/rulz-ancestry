import {
  externalDate,
  textQueryWords,
  type PageRequest,
  type TextQuery,
  type TextRecord,
} from '@rulz/core';
import { z } from 'zod';
import { ConnectorError, cleanText, type TextConnector } from '../../connector';
import type { SourceClient } from '../../http';
import { troveManifest } from './manifest';

const ID = /^\d{1,12}$/;
const URL_PREFIX = 'https://nla.gov.au/nla.news-article';
// The technical guide could not be reached; the Trove Data Guide's v3 examples
// show category[].records.article, total and nextStart, and title.title.
const answerSchema = z.object({
  category: z.array(
    z.object({
      records: z.object({
        article: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
        total: z.unknown().optional(),
        nextStart: z.unknown().optional(),
      }),
    }),
  ),
});
const articleSchema = z.object({
  id: z.string().regex(ID),
  heading: z.unknown().optional(),
  title: z.unknown().optional(),
  date: z.unknown().optional(),
  page: z.unknown().optional(),
  snippet: z.unknown().optional(),
});

export function troveWords(query: TextQuery): string {
  return textQueryWords(query)
    .replace(/[^\p{L}\p{N}\p{M}'’.,\-\s]+/gu, ' ')
    .replace(/(?<![\p{L}\p{N}])-+|-+(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pageOf(page: PageRequest): PageRequest {
  return {
    limit: Math.max(1, Math.min(20, Math.trunc(page.limit))),
    offset: Math.max(0, Math.trunc(page.offset)),
  };
}

export function troveSearchParams(
  query: TextQuery,
  page: PageRequest,
): Record<string, string | number> {
  const words = troveWords(query);
  let q = query.phrase ? `"${words}"` : words;
  const current = new Date().getFullYear();
  const valid = (year: number | null): year is number =>
    year !== null && Number.isInteger(year) && year >= 1 && year <= 9999;
  const from = query.fromYear;
  const to = query.toYear;
  if (
    (from === null || valid(from)) &&
    (to === null || valid(to)) &&
    (from !== null || to !== null)
  ) {
    const start = from ?? 1803;
    const end = to ?? current;
    if (start > end) {
      throw new ConnectorError(
        'refused',
        from !== null && from > current
          ? 'Trove holds no newspapers from those years (it ends with this year).'
          : 'Trove holds no newspapers from those years (it starts in 1803).',
      );
    }
    q += ` date:[${start} TO ${end}]`;
  }
  return { category: 'newspaper', encoding: 'json', n: pageOf(page).limit, q };
}

/** Decode common named and numeric entities without interpreting HTML. */
function excerptOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  const decoded = value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== '#') return named[name.toLowerCase()] ?? entity;
    const number =
      name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number)
      : ' ';
  });
  return cleanText(decoded.replace(/<[^>]*>/g, ''), 300);
}

function recordOf(value: unknown): TextRecord | null {
  const parsed = articleSchema.safeParse(value);
  if (!parsed.success) return null;
  const article = parsed.data;
  const date =
    typeof article.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(article.date) : null;
  const page =
    typeof article.page === 'string' && /^\d{1,5}$/.test(article.page)
      ? `Page ${article.page}`
      : '';
  return {
    connectorId: troveManifest.id,
    key: article.id,
    kind: 'text',
    title: cleanText(article.heading, 500),
    url: URL_PREFIX + article.id,
    by: cleanText(z.object({ title: z.unknown().optional() }).safeParse(article.title).data?.title),
    date: date ? externalDate(Number(date[1]), Number(date[2]), Number(date[3])) : '',
    about: page,
    excerpt: excerptOf(article.snippet),
  };
}

export function troveConnector(client: SourceClient): TextConnector {
  if (client.manifest.id !== troveManifest.id)
    throw new Error('the Trove connector needs the client of Trove');
  const cursors = new Map<string, string>();
  return {
    manifest: troveManifest,
    recordUrl: (key) => (typeof key === 'string' && ID.test(key) ? URL_PREFIX + key : null),
    async searchTexts(query, page, options = {}) {
      if (!troveWords(query)) throw new ConnectorError('refused', 'Give words to search for.');
      const asked = pageOf(page);
      const params = troveSearchParams(query, asked);
      const signature = JSON.stringify(params);
      const cursorKey = (offset: number) => JSON.stringify([signature, offset]);
      if (asked.offset === 0) {
        // A new search starts over: cursors of an earlier run could serve another result set.
        for (const key of [...cursors.keys()]) {
          if ((JSON.parse(key) as [string, number])[0] === signature) cursors.delete(key);
        }
      }
      const cursor = asked.offset === 0 ? '*' : cursors.get(cursorKey(asked.offset));
      if (!cursor) throw new ConnectorError('refused', 'These results have expired. Search again.');
      const answer = await client.getJson('result', {
        params: { ...params, s: cursor },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
      });
      const parsed = answerSchema.safeParse(answer.data);
      const records = parsed.success ? parsed.data.category[0]?.records : undefined;
      if (!records)
        throw new ConnectorError('format', 'Trove answered in a way the app cannot read.');
      const listed = Array.isArray(records.article)
        ? records.article
        : records.article
          ? [records.article]
          : [];
      const articles = listed.slice(0, asked.limit);
      const items = articles.map(recordOf).filter((record) => record !== null);
      const nextStart =
        typeof records.nextStart === 'string' && records.nextStart.length > 0
          ? records.nextStart
          : null;
      const next = nextStart ? { offset: asked.offset + asked.limit, limit: asked.limit } : null;
      const nextKey = cursorKey(asked.offset + asked.limit);
      cursors.delete(nextKey);
      if (nextStart) {
        cursors.set(nextKey, nextStart);
        if (cursors.size > 50) cursors.delete(cursors.keys().next().value!);
      }
      const total =
        typeof records.total === 'number' && Number.isInteger(records.total) && records.total >= 0
          ? records.total
          : null;
      return {
        page: { items, total, next, hidden: 0 },
        fetchedAt: answer.fetchedAt,
        cached: answer.cached,
      };
    },
  };
}
