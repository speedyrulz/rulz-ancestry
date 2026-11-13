import { describe, expect, it, vi } from 'vitest';
import { HttpClient, HttpError, addressOf, retryAfterMs, type HttpFetch } from './http';
import type { ConnectorManifest } from './manifest';

const source: ConnectorManifest = {
  id: 'example-source',
  name: 'Example',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://example.org/api',
  rateLimit: { requests: 3, perSeconds: 10, source: 'published' },
  cacheTtlHours: 1,
  mayStoreImages: false,
  attribution: 'Example Archive',
  termsUrl: 'https://example.org/terms',
  docsUrl: 'https://example.org/docs',
  verifiedOn: '2026-11-11',
  notes: [],
};

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), init);

/** A client with a clock of its own. Waiting moves the clock on and takes no time. */
function setup(
  answer: (url: string, init: Parameters<HttpFetch>[1]) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
  manifest: ConnectorManifest = source,
) {
  const clock = { now: 1_000_000 };
  const asked: { url: string; at: number; headers: Record<string, string> }[] = [];
  const http = new HttpClient({
    fetch: async (url, init) => {
      asked.push({ url, at: clock.now, headers: init.headers });
      return answer(url, init);
    },
    userAgent: 'RulZAncestry/test',
    now: () => clock.now,
    wait: (ms, signal) => {
      if (signal.aborted) return Promise.reject(new HttpError('cancelled', 'given up'));
      clock.now += ms;
      return Promise.resolve();
    },
    ...options,
  });
  return { http, client: http.for(manifest), clock, asked };
}

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('the request did not fail');
}

describe('addressOf', () => {
  it('adds the path and the query to the address of the manifest', () => {
    expect(addressOf(source, 'search', { q: 'a b&c', n: 2, none: undefined }).href).toBe(
      'https://example.org/api/search?q=a+b%26c&n=2',
    );
    expect(addressOf(source, '').href).toBe('https://example.org/api');
  });

  it('refuses a path that leads out of the source', () => {
    for (const path of [
      'https://elsewhere.example/x',
      '//elsewhere.example/x',
      '../secret',
      'a/../../b',
      'a?b=c',
      'a#b',
      'a\\b',
      './a',
      '%2e%2e/api-other',
      'a%2fb',
    ]) {
      expect(() => addressOf(source, path), path).toThrow(HttpError);
    }
  });

  it('keeps to the address of a source that is one file', () => {
    const file = { ...source, baseUrl: 'https://example.org/api.php' };
    expect(addressOf(file, '', { a: 1 }).href).toBe('https://example.org/api.php?a=1');
    expect(addressOf(file, 'sub').pathname).toBe('/api.php/sub');
  });

  it('refuses a source that is not asked over HTTPS', () => {
    expect(() => addressOf({ ...source, baseUrl: 'http://example.org/api' }, 'a')).toThrow(
      HttpError,
    );
    expect(() => addressOf({ ...source, baseUrl: 'https://me:pw@example.org/api' }, 'a')).toThrow(
      HttpError,
    );
  });
});

describe('retryAfterMs', () => {
  it('reads seconds and a date', () => {
    expect(retryAfterMs('120', 0)).toBe(120_000);
    const now = Date.parse('2026-11-13T10:00:00Z');
    expect(retryAfterMs('Fri, 13 Nov 2026 10:05:00 GMT', now)).toBe(300_000);
    expect(retryAfterMs('Fri, 13 Nov 2026 09:00:00 GMT', now)).toBe(0);
  });

  it('gives null for anything else', () => {
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('soon', 0)).toBeNull();
    expect(retryAfterMs('-5', 0)).toBeNull();
  });
});

describe('HttpClient', () => {
  it('asks the source and gives its JSON', async () => {
    const { client, asked } = setup(() => json({ hello: 'world' }));
    const answer = await client.getJson('search', { params: { q: 'x' } });
    expect(answer).toEqual({ data: { hello: 'world' }, fetchedAt: 1_000_000, cached: false });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe('https://example.org/api/search?q=x');
    expect(asked[0]?.headers['User-Agent']).toBe('RulZAncestry/test');
  });

  it('refuses a source that is not asked live', () => {
    const { http } = setup(() => json({}));
    const { rateLimit: _, ...rest } = source;
    expect(() => http.for({ ...rest, tier: 'deeplink' })).toThrow();
  });

  it('sends nothing for an address outside the source', async () => {
    const { client, asked } = setup(() => json({}));
    expect((await failure(client.getJson('//elsewhere.example/x'))).kind).toBe('address');
    expect(asked).toHaveLength(0);
  });

  it('keeps an answer for as long as the manifest allows, and no longer', async () => {
    const { client, clock, asked } = setup(() => json({ n: 1 }));
    await client.getJson('a');
    clock.now += 59 * 60_000;
    expect((await client.getJson('a')).cached).toBe(true);
    expect(asked).toHaveLength(1);
    clock.now += 2 * 60_000;
    expect((await client.getJson('a')).cached).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('keeps nothing of a source whose manifest allows no keeping', async () => {
    const { client, asked } = setup(() => json({}), {}, { ...source, cacheTtlHours: 0 });
    await client.getJson('a');
    await client.getJson('a');
    expect(asked).toHaveLength(2);
  });

  it('forgets the oldest answers when it holds too many, and all of them when told', async () => {
    const { http, client, asked } = setup(
      () => json({}),
      { cacheEntries: 2 },
      {
        ...source,
        rateLimit: { requests: 100, perSeconds: 1, source: 'published' },
      },
    );
    await client.getJson('a');
    await client.getJson('b');
    await client.getJson('c');
    expect((await client.getJson('c')).cached).toBe(true);
    expect((await client.getJson('a')).cached).toBe(false);
    http.clearCache();
    expect((await client.getJson('c')).cached).toBe(false);
    expect(asked).toHaveLength(5);
  });

  it('sends the same request once when it is asked twice at the same time', async () => {
    const { client, asked } = setup(() => json({ n: 1 }));
    const [one, two] = await Promise.all([client.getJson('a'), client.getJson('a')]);
    expect(one.data).toEqual({ n: 1 });
    expect(two.data).toEqual({ n: 1 });
    expect(asked).toHaveLength(1);
  });

  it('never sends more than the limit within its span, however the span is laid', async () => {
    const { client, asked } = setup(() => json({}));
    await Promise.all(Array.from({ length: 8 }, (_, n) => client.getJson(`p${n}`)));
    expect(asked).toHaveLength(8);
    const times = asked.map((request) => request.at);
    for (const start of times) {
      const within = times.filter((at) => at >= start && at < start + 10_000);
      expect(within.length).toBeLessThanOrEqual(3);
    }
  });

  it('does not wait long for a turn: it says when the source may be asked again', async () => {
    const { client, clock, asked } = setup(() => json({}), { maxWaitMs: 5_000 });
    await client.getJson('a');
    await client.getJson('b');
    await client.getJson('c');
    const error = await failure(client.getJson('d'));
    expect(error.kind).toBe('paused');
    expect(error.retryAt).toBe(clock.now + 10_000);
    expect(asked).toHaveLength(3);
  });

  it('leaves a source alone for as long as it asks, and sends nothing meanwhile', async () => {
    let busy = true;
    const { http, client, clock, asked } = setup(() =>
      busy
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '90' } })
        : json({}),
    );
    const error = await failure(client.getJson('a'));
    expect(error.kind).toBe('paused');
    expect(error.status).toBe(429);
    expect(error.retryAt).toBe(clock.now + 90_000);
    expect(http.pausedUntil(source)).toBe(clock.now + 90_000);

    busy = false;
    clock.now += 89_000;
    expect((await failure(client.getJson('b'))).kind).toBe('paused');
    expect(asked).toHaveLength(1);

    clock.now += 2_000;
    expect(http.pausedUntil(source)).toBeNull();
    await client.getJson('b');
    expect(asked).toHaveLength(2);
  });

  it('pauses for the time of the manifest, or its own, when the source names none', async () => {
    const hour = setup(
      () => new Response('', { status: 429 }),
      {},
      {
        ...source,
        pauseSeconds: 3600,
      },
    );
    expect((await failure(hour.client.getJson('a'))).retryAt).toBe(hour.clock.now + 3_600_000);

    const own = setup(() => new Response('', { status: 503 }), { pauseMs: 60_000 });
    expect((await failure(own.client.getJson('a'))).retryAt).toBe(own.clock.now + 60_000);
  });

  it('never cuts a pause short, and pauses for the span of the limit at least', async () => {
    const waits = ['3600', '60'];
    const { http, client, clock } = setup(
      () => new Response('', { status: 429, headers: { 'retry-after': waits.shift() ?? '60' } }),
      {},
      { ...source, rateLimit: { requests: 5, perSeconds: 10, source: 'published' } },
    );
    // Two requests are under way when the first answer asks for an hour.
    const both = [failure(client.getJson('a')), failure(client.getJson('b'))];
    await Promise.all(both);
    expect(http.pausedUntil(source)).toBe(clock.now + 3_600_000);

    const none = setup(() => new Response('', { status: 429, headers: { 'retry-after': '0' } }));
    expect((await failure(none.client.getJson('a'))).retryAt).toBe(none.clock.now + 10_000);
  });

  it('lets a request that is given up leave the queue, and the others keep their turn', async () => {
    let open: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const sent: string[] = [];
    const clock = { now: 1_000_000 };
    const http = new HttpClient({
      fetch: async (url) => {
        sent.push(new URL(url).pathname);
        return json({});
      },
      userAgent: 'RulZAncestry/test',
      now: () => clock.now,
      // Whoever must wait for a turn waits until the test lets go.
      wait: async (ms) => {
        await held;
        clock.now += ms;
      },
      maxWaitMs: 60_000,
    });
    const client = http.for({
      ...source,
      rateLimit: { requests: 1, perSeconds: 10, source: 'published' },
    });
    await client.getJson('first');
    const second = failure(client.getJson('second'));
    const abort = new AbortController();
    const third = failure(client.getJson('third', { signal: abort.signal }));
    abort.abort();
    // The one that was given up says so at once, though the one before it still waits.
    expect((await third).kind).toBe('cancelled');
    expect(sent).toEqual(['/api/first']);
    open();
    await second.catch(() => undefined);
    expect(sent).not.toContain('/api/third');
  });

  it('looks once more whether a request may be sent when its turn has come', async () => {
    const { client, asked } = setup(() => json({}));
    let allowed = true;
    const beforeSend = () => {
      if (!allowed) throw new Error('no longer');
    };
    await client.getJson('a', { beforeSend });
    allowed = false;
    expect((await failure(client.getJson('b', { beforeSend }))).kind).toBe('cancelled');
    expect(asked).toHaveLength(1);
  });

  it('does not keep an answer that was asked for before the answers were forgotten', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { http, client, asked } = setup(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const first = client.getJson('a');
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    http.clearCache();
    answer(json({ n: 1 }));
    await first;
    const second = client.getJson('a');
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    answer(json({ n: 2 }));
    expect((await second).cached).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('sends no cookie and keeps none, and has nothing written to a cache', async () => {
    const { client } = setup((_url, init) => {
      expect(init.credentials).toBe('omit');
      expect(init.cache).toBe('no-store');
      return json({});
    });
    await client.getJson('a');
  });

  it('cuts a pause a source asks for to a day', async () => {
    const { client, clock } = setup(
      () => new Response('', { status: 429, headers: { 'retry-after': '99999999' } }),
    );
    expect((await failure(client.getJson('a'))).retryAt).toBe(clock.now + 24 * 3_600_000);
  });

  it('shares the pause and the limit between sources on one host', async () => {
    const { http, client } = setup(() => new Response('', { status: 429 }));
    const other = http.for({ ...source, id: 'other-source', baseUrl: 'https://example.org/v2' });
    await failure(client.getJson('a'));
    expect((await failure(other.getJson('a'))).kind).toBe('paused');
  });

  it('tells an error status, an answer that is not JSON and one that is too large apart', async () => {
    const status = setup(() => new Response('gone', { status: 404 }));
    const notFound = await failure(status.client.getJson('a'));
    expect([notFound.kind, notFound.status]).toEqual(['status', 404]);

    const html = setup(() => new Response('<html>Are you a robot?</html>'));
    expect((await failure(html.client.getJson('a'))).kind).toBe('format');

    const announced = setup(() => new Response('{}', { headers: { 'content-length': '5000' } }), {
      maxBytes: 100,
    });
    expect((await failure(announced.client.getJson('a'))).kind).toBe('too-large');

    const unannounced = setup(() => json({ text: 'x'.repeat(500) }), { maxBytes: 100 });
    expect((await failure(unannounced.client.getJson('a'))).kind).toBe('too-large');
  });

  it('keeps no failure', async () => {
    let fail = true;
    const { client, asked } = setup(() => (fail ? new Response('', { status: 500 }) : json({})));
    await failure(client.getJson('a'));
    fail = false;
    expect((await client.getJson('a')).cached).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('reports a source that cannot be reached, without the reason it was given', async () => {
    const { client } = setup(() => {
      throw new Error('getaddrinfo ENOTFOUND example.org at C:\\Users\\someone');
    });
    const error = await failure(client.getJson('a'));
    expect(error.kind).toBe('network');
    expect(error.message).toBe('Example could not be reached.');
  });

  it('gives a request up when its caller does', async () => {
    const abort = new AbortController();
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          abort.abort();
        }),
    );
    expect((await failure(client.getJson('a', { signal: abort.signal }))).kind).toBe('cancelled');

    const before = new AbortController();
    before.abort();
    const never = setup(() => json({}));
    expect((await failure(never.client.getJson('a', { signal: before.signal }))).kind).toBe(
      'cancelled',
    );
    expect(never.asked).toHaveLength(0);
  });

  it('gives a request up when no answer comes in time', async () => {
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 20 },
    );
    expect((await failure(client.getJson('a'))).kind).toBe('timeout');
  });

  it('asks without following an answer that points elsewhere', async () => {
    const { client, asked } = setup((_url, init) => {
      expect(init.redirect).toBe('error');
      expect(init.method).toBe('GET');
      return json({});
    });
    await client.getJson('a');
    expect(asked).toHaveLength(1);
  });
});
