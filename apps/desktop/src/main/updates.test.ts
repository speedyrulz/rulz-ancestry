import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAppDatabase, type Db } from '@rulz/db';
import { compareVersions, FEED, scheduleStartupUpdate, UpdateService } from './updates';

let db: Db;
beforeEach(() => {
  db = openAppDatabase(':memory:');
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});
function setup(overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  // A new Response each call: a body can be read only once.
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response('version: 2.0.0\n')));
  const open = vi.fn().mockResolvedValue(undefined);
  const service = new UpdateService({
    db,
    version: '1.0.0',
    packaged: false,
    busy: () => false,
    fetch: fetcher,
    open,
    ...overrides,
  });
  return { service, fetcher, open };
}
describe('update checks', () => {
  it('compares semver including prereleases and invalid versions', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('garbage', '1.0.0')).toBeNull();
  });
  it('keeps the setting and dismisses the version', async () => {
    const { service, open } = setup();
    expect(service.state().startup).toBe(true);
    service.setStartup(false);
    expect(service.state().startup).toBe(false);
    expect(await service.check()).toBe('newer');
    await service.open();
    expect(open).toHaveBeenCalledWith(
      'https://github.com/speedyrulz/rulz-kinspora/releases/tag/v2.0.0',
    );
    service.dismiss();
    await service.check();
    expect(service.state().version).toBeNull();
    expect(await service.check(true)).toBe('newer');
    expect(service.state().version).toBe('2.0.0');
  });
  it('skips busy work and concurrent checks', async () => {
    expect(await setup({ busy: () => true }).service.check()).toBe('busy');
    let finish!: (response: Response) => void;
    const { service } = setup({
      fetch: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const first = service.check();
    expect(await service.check()).toBe('busy');
    finish(new Response('version: 3.0.0'));
    expect(await first).toBe('newer');
  });
  it('aborts a timed out request', async () => {
    vi.useFakeTimers();
    const { service } = setup({
      timeoutMs: 10,
      clock: { setTimeout, clearTimeout },
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    const check = service.check();
    await vi.advanceTimersByTimeAsync(10);
    expect(await check).toBe('failed');
  });
  it('rejects malformed, oversized and insecure redirects', async () => {
    for (const response of [
      new Response('version: nope'),
      new Response('x'.repeat(65537)),
      new Response(null, { status: 302, headers: { location: 'http://example.com/' } }),
    ]) {
      expect(await setup({ fetch: async () => response }).service.check()).toBe('failed');
    }
  });
  it.each(['v0.2.0', '0.2.0-01'])(
    'clears a stale notice for invalid version %s',
    async (version) => {
      const { service, fetcher } = setup();
      await service.check();
      fetcher.mockResolvedValueOnce(new Response(`version: ${version}`));
      expect(await service.check()).toBe('failed');
      expect(service.state().version).toBeNull();
    },
  );
  it('follows a Node manual redirect to HTTPS', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://example.com/feed' } }),
      )
      .mockResolvedValueOnce(new Response('version: 2.0.0'));
    expect(await setup({ fetch: fetcher }).service.check()).toBe('newer');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://example.com/feed');
  });
  it('retries a busy startup check and cancels retries on quit', async () => {
    vi.useFakeTimers();
    let busy = true;
    const { service, fetcher } = setup({ busy: () => busy });
    const stop = scheduleStartupUpdate(service);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    stop();
    const second = setup({ busy: () => true });
    const stopSecond = scheduleStartupUpdate(second.service);
    await vi.advanceTimersByTimeAsync(5000);
    stopSecond();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.fetcher).not.toHaveBeenCalled();
  });
  it('does not access the database when an in-flight check finishes after shutdown', async () => {
    let finish!: (response: Response) => void;
    const { service } = setup({
      fetch: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const check = service.check();
    service.stop();
    db.close();
    expect(await (finish(new Response('version: 2.0.0')), check)).toBe('failed');
    db = openAppDatabase(':memory:');
  });
  it('ignores overrides in packaged builds and never opens invalid versions', async () => {
    const { service, fetcher, open } = setup({ packaged: true, feed: 'http://127.0.0.1/' });
    await service.open();
    expect(open).not.toHaveBeenCalled();
    await service.check();
    expect(fetcher.mock.calls[0]?.[0]).toBe(FEED);
  });
});
