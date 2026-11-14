import { describe, expect, it, vi } from 'vitest';
import {
  HttpClient,
  HttpError,
  addressOf,
  retryAfterMs,
  type HostMemory,
  type HostRecord,
  type QuotaRecord,
  type HttpFetch,
} from './http';
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

  it('gives a source that is known to be slow the time its manifest names', async () => {
    // An answer that takes its time, and is given up when the request is.
    const slow = (_url: string, init: Parameters<HttpFetch>[1]) =>
      new Promise<Response>((resolve, reject) => {
        const late = setTimeout(() => resolve(json({ late: true })), 80);
        init.signal.addEventListener('abort', () => {
          clearTimeout(late);
          reject(new Error('aborted'));
        });
      });
    // The client's own time is over long before the answer comes.
    const hasty = setup(slow, { timeoutMs: 20 });
    expect((await failure(hasty.client.getJson('a'))).kind).toBe('timeout');
    // The manifest's time is not.
    const patient = setup(slow, { timeoutMs: 20 }, { ...source, timeoutSeconds: 2 });
    expect((await patient.client.getJson('a')).data).toEqual({ late: true });
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

describe('what the client keeps for the next time the app runs', () => {
  /** A place that keeps what it is given, as the settings of the app do. */
  function memoryOf(kept: Record<string, unknown> = {}) {
    const saved: [string, HostRecord | QuotaRecord][] = [];
    const memory: HostMemory = {
      load: (host) => kept[host],
      save: (host, record) => {
        kept[host] = structuredClone(record);
        saved.push([host, structuredClone(record)]);
      },
    };
    return { memory, kept, saved };
  }

  const hourly = { ...source, pauseSeconds: 3600 };

  it('still leaves a source alone after the app was closed and started again', async () => {
    const { memory, kept } = memoryOf();
    const first = setup(() => new Response('', { status: 429 }), { memory }, hourly);
    await failure(first.client.getJson('a'));
    expect(kept['example.org']).toMatchObject({ pausedUntil: first.clock.now + 3_600_000 });

    // The app starts again: a new client, the same place.
    const second = setup(() => json({}), { memory }, hourly);
    expect(second.http.pausedUntil(hourly)).toBe(second.clock.now + 3_600_000);
    const error = await failure(second.client.getJson('a'));
    expect([error.kind, error.retryAt]).toEqual(['paused', second.clock.now + 3_600_000]);
    expect(second.asked).toHaveLength(0);

    second.clock.now += 3_600_001;
    await second.client.getJson('a');
    expect(second.asked).toHaveLength(1);
  });

  it('counts the requests sent before the app was closed', async () => {
    const { memory, kept, saved } = memoryOf();
    const first = setup(() => json({}), { memory });
    await first.client.getJson('a');
    await first.client.getJson('b');
    await first.client.getJson('c');
    expect(saved).toHaveLength(3);
    expect(kept['example.org']).toEqual({
      pausedUntil: 0,
      sent: [1_000_000, 1_000_000, 1_000_000],
    });

    // Three were sent within the ten seconds of the limit, so the fourth waits
    // for them to be ten seconds old, although this client sent none of them.
    const second = setup(() => json({}), { memory, maxWaitMs: 60_000 });
    second.clock.now += 4_000;
    await second.client.getJson('d');
    expect(second.asked.map((request) => request.at)).toEqual([1_010_000]);
  });

  it('takes nothing that was kept on trust', async () => {
    const day = 24 * 3_600_000;
    // A pause far in the future, as after a change of the clock, ends a day from now.
    const far = setup(() => json({}), {
      memory: memoryOf({ 'example.org': { pausedUntil: 9e15, sent: [] } }).memory,
    });
    expect(far.http.pausedUntil(source)).toBe(far.clock.now + day);

    // And it ends then, however often the app is started meanwhile: what was
    // read is kept as it was understood.
    const stuck = memoryOf({ 'example.org': { pausedUntil: 9e15, sent: [] } });
    const one = setup(() => json({}), { memory: stuck.memory });
    expect(one.http.pausedUntil(source)).toBe(one.clock.now + day);
    expect(stuck.kept['example.org']).toMatchObject({ pausedUntil: one.clock.now + day });
    const two = setup(() => json({}), { memory: stuck.memory });
    two.clock.now += day - 1000;
    expect(two.http.pausedUntil(source)).toBe(one.clock.now + day);
    two.clock.now += 2000;
    expect(two.http.pausedUntil(source)).toBeNull();

    // Times in the future count as now, and what is no time is left out.
    const odd = setup(() => json({}), {
      memory: memoryOf({
        'example.org': {
          pausedUntil: 'tomorrow',
          sent: [9e15, 'now', null, -5, Number.NaN, 999_000],
        },
      }).memory,
      maxWaitMs: 60_000,
    });
    expect(odd.http.pausedUntil(source)).toBeNull();
    await odd.client.getJson('a');
    await odd.client.getJson('b');
    // Two were counted from before: the second request here is the fourth of the span.
    expect(odd.asked.map((request) => request.at)).toEqual([1_000_000, 1_009_000]);

    for (const kept of [null, 'text', 7, [], { sent: 'many' }]) {
      const plain = setup(() => json({}), { memory: memoryOf({ 'example.org': kept }).memory });
      await plain.client.getJson('a');
      expect(plain.asked).toHaveLength(1);
    }
  });

  it('leaves a source alone for the time of its manifest at least, whatever it asks for', async () => {
    // The source says "a minute", and its manifest says it shuts a client out for an hour.
    const short = setup(
      () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
      {},
      hourly,
    );
    expect((await failure(short.client.getJson('a'))).retryAt).toBe(short.clock.now + 3_600_000);
    // A longer time that it asks for still holds.
    const long = setup(
      () => new Response('', { status: 429, headers: { 'retry-after': '7200' } }),
      {},
      hourly,
    );
    expect((await failure(long.client.getJson('a'))).retryAt).toBe(long.clock.now + 7_200_000);
  });

  it('is not shut for good by a clock that is set back while the app runs', async () => {
    const day = 24 * 3_600_000;
    const { client, clock, asked } = setup(() => json({}), { maxWaitMs: 60_000 });
    // The clock of these tests starts near nought; it is put forward so that it can go back.
    clock.now += 40 * day;
    const start = clock.now;
    await client.getJson('a');
    await client.getJson('b');
    await client.getJson('c');
    // The clock goes back a week. The three requests now lie in the future.
    clock.now -= 7 * day;
    await client.getJson('d');
    // They count as sent now: the fourth waits for the ten seconds of the limit, and no longer.
    expect(asked[3]?.at).toBe(clock.now);
    expect(asked[3]?.at).toBe(start - 7 * day + 10_000);

    const paused = setup(() => new Response('', { status: 429 }), {}, hourly);
    paused.clock.now += 40 * day;
    await failure(paused.client.getJson('a'));
    paused.clock.now -= 30 * day;
    expect(paused.http.pausedUntil(hourly)).toBe(paused.clock.now + day);
  });

  it('writes nothing about a host when there was nothing to put right', () => {
    const fresh = memoryOf();
    const quiet = setup(() => json({}), { memory: fresh.memory });
    expect(quiet.http.pausedUntil(source)).toBeNull();
    expect(fresh.saved).toHaveLength(0);
  });

  it('goes on when the place fails', async () => {
    const broken: HostMemory = {
      load: () => {
        throw new Error('the settings cannot be read');
      },
      save: () => {
        throw new Error('the settings cannot be written');
      },
    };
    const { http, client, clock, asked } = setup(
      () => (asked.length === 1 ? json({}) : new Response('', { status: 429 })),
      { memory: broken },
      hourly,
    );
    await client.getJson('a');
    expect((await failure(client.getJson('b'))).kind).toBe('paused');
    // The pause still holds while the app runs.
    expect(http.pausedUntil(hourly)).toBe(clock.now + 3_600_000);
  });

  it('pauses when a source that names its own pause sends a web page in place of an answer', async () => {
    const { memory, kept } = memoryOf();
    const page = '<!DOCTYPE html>\n<html><body>Please show that you are no robot.</body></html>';
    const { http, client, clock, asked } = setup(() => new Response(page), { memory }, hourly);
    const error = await failure(client.getJson('a'));
    expect([error.kind, error.retryAt]).toEqual(['paused', clock.now + 3_600_000]);
    expect(http.pausedUntil(hourly)).toBe(clock.now + 3_600_000);
    expect(kept['example.org']).toMatchObject({ pausedUntil: clock.now + 3_600_000 });
    expect((await failure(client.getJson('b'))).kind).toBe('paused');
    expect(asked).toHaveLength(1);

    // The same page with "forbidden" pauses too.
    const forbidden = setup(
      () =>
        new Response(page, {
          status: 403,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      {},
      hourly,
    );
    const shut = await failure(forbidden.client.getJson('a'));
    expect([shut.kind, shut.status, shut.retryAt]).toEqual([
      'paused',
      403,
      forbidden.clock.now + 3_600_000,
    ]);
    // So does "forbidden" without a page, and a page that starts another way.
    const plain = setup(() => new Response('{}', { status: 403 }), {}, hourly);
    expect((await failure(plain.client.getJson('a'))).kind).toBe('paused');
    for (const body of [
      '<!-- challenge -->\n<head></head>',
      '  <head><title>Wait</title></head>',
    ]) {
      const odd = setup(() => new Response(body), {}, hourly);
      expect((await failure(odd.client.getJson('a'))).kind, body).toBe('paused');
    }
    const typed = setup(
      () => new Response('Please wait', { headers: { 'content-type': 'text/html' } }),
      {},
      hourly,
    );
    expect((await failure(typed.client.getJson('a'))).kind).toBe('paused');
    // "Forbidden" from a source that names no pause is an error like another.
    const other = setup(
      () => new Response(page, { status: 403, headers: { 'content-type': 'text/html' } }),
    );
    expect((await failure(other.client.getJson('a'))).kind).toBe('status');
    const missing = setup(
      () => new Response(page, { status: 404, headers: { 'content-type': 'text/html' } }),
      {},
      hourly,
    );
    expect((await failure(missing.client.getJson('a'))).kind).toBe('status');
    expect(missing.http.pausedUntil(hourly)).toBeNull();

    // Something else that is no JSON is a fault of the answer, and no reason to pause.
    const text = setup(() => new Response('not found'), {}, hourly);
    expect((await failure(text.client.getJson('a'))).kind).toBe('format');
    expect(text.http.pausedUntil(hourly)).toBeNull();
  });
});

describe('a source that needs the key of the user', () => {
  const keyed: ConnectorManifest = {
    ...source,
    id: 'keyed-source',
    auth: 'apiKey',
    access: 'key-required',
    keyHeader: 'x-api-key',
    cacheTtlHours: 0,
  };
  const KEY = 'canary-key-0123456789';

  it('sends the key in its header, and in no address', async () => {
    const { client, asked } = setup(() => json({ ok: true }), { keyOf: () => KEY }, keyed);
    await client.getJson('search', { params: { q: 'x' } });
    expect(asked[0]?.headers['x-api-key']).toBe(KEY);
    expect(asked[0]?.url).toBe('https://example.org/api/search?q=x');
    // A source without a key is sent none, whatever the app holds.
    const open = setup(() => json({}), { keyOf: () => KEY });
    await open.client.getJson('a');
    expect(Object.values(open.asked[0]?.headers ?? {})).not.toContain(KEY);
  });

  it('sends nothing without a key, or with what no header can hold', async () => {
    for (const key of [
      null,
      '',
      'two words',
      'tab\there',
      'line\r\nInjected: yes',
      'x'.repeat(301),
    ]) {
      const { client, asked } = setup(() => json({}), { keyOf: () => key }, keyed);
      const error = await failure(client.getJson('a'));
      expect(error.kind).toBe('key');
      if (key) expect(error.message).not.toContain(key);
      expect(asked).toHaveLength(0);
    }
    const none = setup(() => json({}), {}, keyed);
    expect((await failure(none.client.getJson('a'))).kind).toBe('key');
  });

  it('asks for the key anew for each request, and keeps none', async () => {
    let key: string | null = KEY;
    const { client, asked } = setup(() => json({}), { keyOf: () => key }, keyed);
    await client.getJson('a');
    key = null;
    expect((await failure(client.getJson('b'))).kind).toBe('key');
    key = 'another-key-9876543210';
    await client.getJson('c');
    expect(asked.map((request) => request.headers['x-api-key'])).toEqual([
      KEY,
      'another-key-9876543210',
    ]);
  });

  it('says when the source does not accept the key, and nothing of the key', async () => {
    for (const answer of [
      () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }),
      () => new Response('', { status: 401 }),
      // Its website in place of an answer, as a catalog sends without a key.
      () => new Response('<!doctype html><html></html>'),
    ]) {
      const { client } = setup(answer, { keyOf: () => KEY }, keyed);
      const error = await failure(client.getJson('a'));
      expect(error.kind).toBe('key');
      expect(error.message).toContain('did not accept the key');
      expect(error.message).not.toContain(KEY);
    }
    // Another error is an error like another.
    const broken = setup(() => new Response('', { status: 500 }), { keyOf: () => KEY }, keyed);
    expect((await failure(broken.client.getJson('a'))).kind).toBe('status');
  });

  it('keeps the key out of what it writes down about a host', async () => {
    const written: string[] = [];
    const memory: HostMemory = {
      load: () => null,
      save: (name, record) => written.push(name + JSON.stringify(record)),
    };
    const { client } = setup(
      () => new Response('', { status: 429 }),
      { keyOf: () => KEY, memory },
      { ...keyed, quota: { requests: 100, period: 'month' } },
    );
    await failure(client.getJson('a'));
    expect(written.length).toBeGreaterThan(0);
    expect(written.join('\n')).not.toContain(KEY);
  });
});

describe('a source that allows so many requests a month', () => {
  const counted: ConnectorManifest = {
    ...source,
    id: 'counted-source',
    cacheTtlHours: 0,
    rateLimit: { requests: 1000, perSeconds: 1, source: 'self-imposed' },
    quota: { requests: 10, period: 'month' },
  };
  /** Noon on 15 November 2026, in Unix milliseconds. */
  const MID_MONTH = Date.UTC(2026, 10, 15, 12);

  function memoryOf(kept: Record<string, unknown> = {}) {
    const memory: HostMemory = {
      load: (name) => kept[name],
      save: (name, record) => {
        kept[name] = structuredClone(record);
      },
    };
    return { memory, kept };
  }

  it('counts every request that goes out, and stops below what the source allows', async () => {
    const { memory, kept } = memoryOf();
    const { http, client, clock, asked } = setup(() => json({}), { memory }, counted);
    clock.now = MID_MONTH;
    expect(http.quotaOf(counted)).toEqual({
      period: '2026-11',
      used: 0,
      // Nine of ten: the rest is left for whatever else uses the key.
      ceiling: 9,
      resetsAt: Date.UTC(2026, 11, 1, 12),
    });
    for (let index = 0; index < 9; index += 1) await client.getJson(`r${index}`);
    expect(kept['quota:counted-source']).toEqual({ period: '2026-11', used: 9 });
    const error = await failure(client.getJson('one-more'));
    expect([error.kind, error.retryAt]).toEqual(['quota', Date.UTC(2026, 11, 1, 12)]);
    expect(asked).toHaveLength(9);
    // A source without a count has none.
    expect(http.quotaOf(source)).toBeNull();
  });

  it('counts a request that failed, and none that was never sent', async () => {
    const { memory, kept } = memoryOf();
    const { client, clock } = setup(() => new Response('', { status: 500 }), { memory }, counted);
    clock.now = MID_MONTH;
    await failure(client.getJson('a'));
    expect(kept['quota:counted-source']).toEqual({ period: '2026-11', used: 1 });
    // An address the source does not have is refused before anything is counted.
    await failure(client.getJson('../elsewhere'));
    // So is a request that its caller gives up when its turn has come.
    await failure(
      client.getJson('b', {
        beforeSend: () => {
          throw new Error('not now');
        },
      }),
    );
    expect(kept['quota:counted-source']).toEqual({ period: '2026-11', used: 1 });
  });

  it('goes on counting after the app was closed, and starts again with the month', async () => {
    const { memory, kept } = memoryOf({ 'quota:counted-source': { period: '2026-11', used: 8 } });
    const first = setup(() => json({}), { memory }, counted);
    first.clock.now = MID_MONTH;
    expect(first.http.quotaOf(counted)?.used).toBe(8);
    await first.client.getJson('a');
    expect((await failure(first.client.getJson('b'))).kind).toBe('quota');

    // The first of December has begun somewhere, but not everywhere: still November.
    const early = setup(() => json({}), { memory }, counted);
    early.clock.now = Date.UTC(2026, 11, 1, 11, 59);
    expect(early.http.quotaOf(counted)).toMatchObject({ period: '2026-11', used: 9 });
    expect((await failure(early.client.getJson('c'))).kind).toBe('quota');

    // Now it has begun everywhere.
    const next = setup(() => json({}), { memory }, counted);
    next.clock.now = Date.UTC(2026, 11, 1, 12, 1);
    expect(next.http.quotaOf(counted)).toMatchObject({ period: '2026-12', used: 0 });
    await next.client.getJson('d');
    expect(kept['quota:counted-source']).toEqual({ period: '2026-12', used: 1 });
  });

  it('takes no count on trust, and does not ask when it cannot keep count', async () => {
    // Nothing kept is a count of nought.
    for (const none of [null, undefined]) {
      const { memory } = memoryOf({ 'quota:counted-source': none });
      const { http, clock } = setup(() => json({}), { memory }, counted);
      clock.now = MID_MONTH;
      expect(http.quotaOf(counted)?.used).toBe(0);
    }
    // Something kept that is no count is taken for a month that is used up:
    // the app does not know how much it asked.
    for (const damaged of [
      'nine',
      7,
      [],
      {},
      { period: 7, used: 3 },
      { period: '2026-11', used: -4 },
      { period: '2026-11', used: 2.5 },
      { period: '2026-11' },
      { period: 'November', used: 3 },
      // A count by the day where one by the month is kept.
      { period: '2026-11-15', used: 3 },
    ]) {
      const { memory } = memoryOf({ 'quota:counted-source': damaged });
      const { http, client, clock, asked } = setup(() => json({}), { memory }, counted);
      clock.now = MID_MONTH;
      expect(http.quotaOf(counted)?.used, JSON.stringify(damaged)).toBe(9);
      expect((await failure(client.getJson('a'))).kind).toBe('quota');
      expect(asked).toHaveLength(0);
    }
    // And so is a place that cannot be read at all, although it can be written.
    const unreadable: HostMemory = {
      load: () => {
        throw new Error('the settings cannot be read');
      },
      save: () => undefined,
    };
    const blind = setup(() => json({}), { memory: unreadable }, counted);
    blind.clock.now = MID_MONTH;
    expect((await failure(blind.client.getJson('a'))).kind).toBe('quota');
    expect(blind.asked).toHaveLength(0);
    const broken: HostMemory = {
      load: () => {
        throw new Error('the settings cannot be read');
      },
      save: (name) => {
        if (name.startsWith('quota:')) throw new Error('the settings cannot be written');
      },
    };
    const { client, clock, asked } = setup(() => json({}), { memory: broken }, counted);
    clock.now = MID_MONTH;
    const error = await failure(client.getJson('a'));
    expect(error.kind).toBe('quota');
    expect(asked).toHaveLength(0);
  });

  it('does not bring a used month back when the clock is set forward and back', async () => {
    const { memory, kept } = memoryOf({ 'quota:counted-source': { period: '2026-11', used: 9 } });
    const { http, client, clock, asked } = setup(() => json({}), { memory }, counted);
    clock.now = MID_MONTH;
    expect((await failure(client.getJson('a'))).kind).toBe('quota');
    // The clock is put a month on: a new month, as far as the app can tell.
    clock.now = Date.UTC(2026, 11, 15, 12);
    for (let index = 0; index < 9; index += 1) await client.getJson(`r${index}`);
    expect(kept['quota:counted-source']).toEqual({ period: '2026-12', used: 9 });
    // And back again. November is not fresh, and what was asked "in December" still counts.
    clock.now = MID_MONTH;
    expect(http.quotaOf(counted)).toMatchObject({ period: '2026-12', used: 9 });
    expect((await failure(client.getJson('b'))).kind).toBe('quota');
    // Not after the app was started again either.
    const again = setup(() => json({}), { memory }, counted);
    again.clock.now = MID_MONTH;
    expect((await failure(again.client.getJson('c'))).kind).toBe('quota');
    expect(asked).toHaveLength(9);
    expect(again.asked).toHaveLength(0);
  });

  it('does not ask a source it counts for when it has no place to keep the count', async () => {
    const { client, clock, asked } = setup(() => json({}), {}, counted);
    clock.now = MID_MONTH;
    const error = await failure(client.getJson('a'));
    expect(error.kind).toBe('quota');
    expect(asked).toHaveLength(0);
  });

  it('counts by the day for a source that allows so many a day', async () => {
    const daily = { ...counted, quota: { requests: 10, period: 'day' as const } };
    const { http, clock } = setup(() => json({}), {}, daily);
    clock.now = MID_MONTH;
    expect(http.quotaOf(daily)).toMatchObject({
      period: '2026-11-15',
      resetsAt: Date.UTC(2026, 10, 16, 12),
    });
  });
});
