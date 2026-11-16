import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetting, openAppDatabase, setSetting, type Db } from '@rulz/db';
import {
  compareVersions,
  createUpdateHandlers,
  FEED,
  isInstalledCopy,
  parseInstaller,
  scheduleStartupUpdate,
  UpdateService,
} from './updates';

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
  it('follows a Node manual redirect to a GitHub host', async () => {
    const to = 'https://release-assets.githubusercontent.com/feed';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: to } }))
      .mockResolvedValueOnce(new Response('version: 2.0.0'));
    expect(await setup({ fetch: fetcher }).service.check()).toBe('newer');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(to);
  });
  it.each([
    'https://example.com/feed',
    'https://github.com.example.com/feed',
    'https://evilgithubusercontent.com/feed',
    'http://github.com/feed',
  ])('does not follow a feed redirect to %s, packaged or not', async (location) => {
    for (const packaged of [true, false]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(null, { status: 302, headers: { location } }));
      expect(await setup({ fetch: fetcher, packaged }).service.check()).toBe('failed');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
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

// The one-click update: the feed's installer details, the download, the checks and the install.
const NAME = (version: string) => `RulZ-Kinspora-Setup-${version}.exe`;
const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('base64');
const BYTES = Buffer.from('a stand-in for an installer'.repeat(40));
const TEMP = join('/', 'tmp');
function feedText(
  version = '2.0.0',
  bytes: Uint8Array = BYTES,
  edit: (parts: { path: string; sha: string; size: string; entrySha: string }) => void = () =>
    undefined,
) {
  const parts = {
    path: NAME(version),
    sha: sha512(bytes),
    size: String(bytes.length),
    entrySha: '',
  };
  parts.entrySha = parts.sha;
  edit(parts);
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${NAME(version)}`,
    `    sha512: ${parts.entrySha}`,
    `    size: ${parts.size}`,
    `path: ${parts.path}`,
    `sha512: ${parts.sha}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n');
}
function bodyOf(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}
/** A body that sends the first part at once, and the rest when `release` is called. */
function gated(first: Uint8Array, rest?: Uint8Array) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(first);
          await gate;
          if (rest) controller.enqueue(rest);
          controller.close();
        },
      }),
    );
  return { response, release: () => release() };
}
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
/** A folder that lives in memory: the folders made, and the files written in them. */
function memoryFiles(existing: string[] = []) {
  const dirs = new Set<string>(existing.map((name) => join(TEMP, name)));
  const written = new Map<string, Buffer[]>();
  return {
    dirs,
    written,
    makeDir(path: string) {
      if (dirs.has(path)) throw new Error('exists');
      dirs.add(path);
    },
    create: async (path: string) => {
      written.set(path, []);
      return {
        write: async (chunk: Uint8Array) => void written.get(path)!.push(Buffer.from(chunk)),
        close: async () => undefined,
      };
    },
    remove(path: string) {
      dirs.delete(path);
      for (const file of [...written.keys()]) if (dirname(file) === path) written.delete(file);
    },
    list: () => [...dirs].map((dir) => basename(dir)),
    hash: async (path: string) =>
      createHash('sha512')
        .update(Buffer.concat(written.get(path) ?? []))
        .digest(),
  };
}
const GITHUB_EXE = `https://github.com/speedyrulz/rulz-kinspora/releases/download/v2.0.0/${NAME('2.0.0')}`;

interface InstallOptions {
  exe?: (url: string) => Response | Promise<Response>;
  feed?: string;
  busy?: () => boolean;
  installable?: boolean;
  packaged?: boolean;
  spawn?: (file: string, args: string[]) => { pid?: number | undefined };
  prepare?: () => void;
  existing?: string[];
  idleMs?: number;
  feedUrl?: string;
}
function installSetup(options: InstallOptions = {}) {
  const files = memoryFiles(options.existing);
  const calls: string[] = [];
  const urls: string[] = [];
  let n = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('latest.yml')) return new Response(options.feed ?? feedText());
    return options.exe ? options.exe(url) : bodyOf(BYTES.subarray(0, 100), BYTES.subarray(100));
  });
  const spawn = vi.fn((file: string, args: string[]) => {
    calls.push('spawn');
    return options.spawn ? options.spawn(file, args) : { pid: 4242 };
  });
  const quit = vi.fn(() => void calls.push('quit'));
  const prepare = vi.fn(() => {
    calls.push('prepare');
    options.prepare?.();
  });
  const service = new UpdateService({
    db,
    version: '1.0.0',
    packaged: options.packaged ?? false,
    ...(options.feedUrl === undefined ? {} : { feed: options.feedUrl }),
    busy: options.busy ?? (() => false),
    fetch: fetcher,
    open: vi.fn().mockResolvedValue(undefined),
    installable: () => options.installable ?? false,
    tempDir: TEMP,
    files,
    random: () => String(++n).padStart(24, '0'),
    idleMs: options.idleMs ?? 60_000,
    waitMs: 1,
    prepare,
    spawn,
    quit,
  });
  return { service, files, calls, urls, fetcher, spawn, quit, prepare };
}
const LOCAL = 'http://127.0.0.1:9/latest.yml';
const phase = (service: UpdateService) => service.state().phase;
const WRONG = Buffer.from('x'.repeat(BYTES.length));

describe('the installer details in the feed', () => {
  const version = '2.0.0';
  it('reads the path, the SHA-512 and the size', () => {
    const installer = parseInstaller(feedText(version), version);
    expect(installer?.size).toBe(BYTES.length);
    expect(installer?.sha512.toString('base64')).toBe(sha512(BYTES));
    expect(parseInstaller(feedText(version).replace(/\n/g, '\r\n'), version)).not.toBeNull();
  });
  const bad: [string, string][] = [
    ['version only', 'version: 2.0.0\n'],
    ['a traversing path', feedText(version, BYTES, (p) => (p.path = `..\\${NAME(version)}`))],
    ['the path of another version', feedText(version, BYTES, (p) => (p.path = NAME('2.0.1')))],
    ['a path with a folder', feedText(version, BYTES, (p) => (p.path = `x/${NAME(version)}`))],
    ['base64 that is too short', feedText(version, BYTES, (p) => (p.sha = p.entrySha = 'QUJD'))],
    [
      'base64 that is not canonical',
      feedText(version, BYTES, (p) => (p.sha = p.entrySha = `${'A'.repeat(85)}B==`)),
    ],
    [
      'a digest of the wrong length',
      feedText(version, BYTES, (p) => {
        p.sha = p.entrySha = createHash('sha256').update('x').digest('base64');
      }),
    ],
    [
      'an entry that differs from the top',
      feedText(version, BYTES, (p) => (p.entrySha = sha512(Buffer.from('x')))),
    ],
    ['a size that is not an integer', feedText(version, BYTES, (p) => (p.size = '12.5'))],
    ['a size of zero', feedText(version, BYTES, (p) => (p.size = '0'))],
    ['a negative size', feedText(version, BYTES, (p) => (p.size = '-4'))],
    [
      'a size over the ceiling',
      feedText(version, BYTES, (p) => (p.size = String(400 * 2 ** 20 + 1))),
    ],
    ['a doubled path', `${feedText(version)}path: ${NAME(version)}\n`],
    ['a doubled sha512', `${feedText(version)}sha512: ${sha512(BYTES)}\n`],
    [
      'a doubled file entry',
      feedText(version).replace(
        'path:',
        `  - url: ${NAME(version)}\n    sha512: ${sha512(BYTES)}\n    size: 5\npath:`,
      ),
    ],
    ['no file entry', feedText(version).replace(/files:[\s\S]*?(?=path:)/, '')],
  ];
  it.each(bad)('refuses %s', (_name, text) => {
    expect(parseInstaller(text, version)).toBeNull();
  });
  it('accepts a size at the ceiling', () => {
    expect(
      parseInstaller(
        feedText(version, BYTES, (p) => (p.size = String(400 * 2 ** 20))),
        version,
      ),
    ).not.toBeNull();
  });
});

describe('where an update may be installed', () => {
  const exists = (path: string) => path.endsWith('Uninstall RulZ Kinspora.exe');
  const local = 'C:\\Users\\a\\AppData\\Local';
  it('allows only the copy the installer made', () => {
    const exe = `${local}\\Programs\\RulZ Kinspora\\RulZ Kinspora.exe`;
    expect(isInstalledCopy(exe, local, exists)).toBe(true);
    expect(isInstalledCopy(exe.toUpperCase(), local.toLowerCase(), exists)).toBe(true);
    expect(isInstalledCopy(exe, local, () => false)).toBe(false);
    expect(isInstalledCopy('C:\\work\\win-unpacked\\RulZ Kinspora.exe', local, exists)).toBe(false);
    expect(isInstalledCopy(`${local}\\Other\\RulZ Kinspora.exe`, local, exists)).toBe(false);
    expect(isInstalledCopy(`${local}\\Programs\\..\\x\\RulZ Kinspora.exe`, local, exists)).toBe(
      false,
    );
    expect(isInstalledCopy(exe, '', exists)).toBe(false);
  });
});

describe('the one-click update', () => {
  it('downloads and verifies, and in a copy that cannot install it stops there', async () => {
    const { service, files, spawn, quit, urls } = installSetup({ feedUrl: LOCAL });
    await service.check();
    expect(service.state().version).toBe('2.0.0');
    const running = service.install();
    expect(phase(service)).toBe('downloading');
    await running;
    expect(phase(service)).toBe('verified');
    expect(service.state().percent).toBeNull();
    expect(service.state().canInstall).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(getSetting(db, 'update.pending')).toBeNull();
    // The throwaway folder holds exactly the verified file, until the app closes.
    const [file] = [...files.written.keys()];
    expect(file).toBe(join(TEMP, `rulz-kinspora-update-${'1'.padStart(24, '0')}`, NAME('2.0.0')));
    expect(Buffer.concat(files.written.get(file!)!).equals(BYTES)).toBe(true);
    // A development build with a local feed takes the file from the feed's folder, never from GitHub.
    expect(urls.filter((u) => !u.startsWith('http://127.0.0.1:9/'))).toEqual([]);
    expect(urls).toContain(`http://127.0.0.1:9/${NAME('2.0.0')}`);
    service.stop();
    expect(files.dirs.size).toBe(0);
  });
  it('downloads from the tag of the release, not from "latest"', async () => {
    const { service, urls } = installSetup({ packaged: true, installable: true });
    await service.check();
    await service.install();
    expect(urls[1]).toBe(GITHUB_EXE);
    expect(urls[1]).not.toContain('latest');
  });
  it('starts the installer last: marker, backup, spawn, then quit', async () => {
    const { service, calls, spawn, files } = installSetup({
      installable: true,
      prepare: () => expect(getSetting(db, 'update.pending')).toBe('2.0.0'),
    });
    await service.check();
    await service.install();
    expect(calls).toEqual(['prepare', 'spawn', 'quit']);
    expect(spawn).toHaveBeenCalledWith(
      join(TEMP, `rulz-kinspora-update-${'1'.padStart(24, '0')}`, NAME('2.0.0')),
      ['--updated', '/S', '--force-run'],
    );
    expect(phase(service)).toBe('installing');
    expect(service.installing).toBe(true);
    expect(getSetting(db, 'update.pending')).toBe('2.0.0');
    // The app's own quit stops the service; the installer's file must stay for the installer.
    service.stop();
    expect(files.dirs.size).toBe(1);
    expect(files.written.size).toBe(1);
  });
  it.each<[string, () => { pid?: number }]>([
    [
      'throws',
      () => {
        throw new Error('EACCES');
      },
    ],
    ['has no pid', () => ({})],
  ])('stays open and reports it when the spawn %s', async (_name, spawnFn) => {
    const { service, quit, files } = installSetup({ installable: true, spawn: spawnFn });
    await service.check();
    await service.install();
    expect(quit).not.toHaveBeenCalled();
    expect(phase(service)).toBe('failed');
    expect(service.installing).toBe(false);
    expect(service.state().failure).toMatch(/could not be started/);
    expect(getSetting(db, 'update.pending')).toBeNull();
    expect(files.dirs.size).toBe(0);
  });
  it('deletes a download whose hash does not match and never starts it', async () => {
    const { service, files, spawn } = installSetup({
      installable: true,
      exe: () => bodyOf(WRONG),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(service.state().failure).toMatch(/did not match/);
    expect(spawn).not.toHaveBeenCalled();
    expect(files.dirs.size).toBe(0);
    expect(files.written.size).toBe(0);
  });
  it('refuses a feed without checkable installer details', async () => {
    const { service, fetcher, files } = installSetup({
      installable: true,
      feed: feedText('2.0.0', BYTES, (p) => (p.path = '..\\evil.exe')),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(files.dirs.size).toBe(0);
  });
  it.each([
    ['a host that is not GitHub', 'https://example.com/a.exe'],
    ['http', 'http://github.com/a.exe'],
    ['a look-alike host', 'https://github.com.example.com/a.exe'],
    ['a host that only ends like GitHub content', 'https://evilgithubusercontent.com/a.exe'],
  ])('does not follow a redirect to %s', async (_name, location) => {
    const { service, files, fetcher } = installSetup({
      installable: true,
      exe: () => redirect(location),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(files.dirs.size).toBe(0);
  });
  it('follows GitHub redirects, up to five', async () => {
    let hops = 0;
    const five = installSetup({
      installable: true,
      exe: () =>
        ++hops <= 5 ? redirect('https://objects.githubusercontent.com/x/a.exe') : bodyOf(BYTES),
    });
    await five.service.check();
    await five.service.install();
    expect(phase(five.service)).toBe('installing');
    const six = installSetup({
      installable: true,
      exe: () => redirect('https://release-assets.githubusercontent.com/a.exe'),
    });
    await six.service.check();
    await six.service.install();
    expect(phase(six.service)).toBe('failed');
  });
  it('aborts a download that runs past the size in the feed', async () => {
    const { service, files, spawn } = installSetup({
      installable: true,
      exe: () => bodyOf(BYTES, Buffer.from('one byte too many')),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(service.state().failure).toMatch(/larger/);
    expect(spawn).not.toHaveBeenCalled();
    expect(files.dirs.size).toBe(0);
  });
  it('fails a download that ends short', async () => {
    const { service, files } = installSetup({
      installable: true,
      exe: () => bodyOf(BYTES.subarray(0, 10)),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(files.dirs.size).toBe(0);
  });
  it('gives up when no bytes arrive for the idle time', async () => {
    const { service, files } = installSetup({
      installable: true,
      idleMs: 20,
      exe: () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(service.state().failure).toMatch(/stalled/);
    expect(files.dirs.size).toBe(0);
  });
  it('reports progress as the bytes come in', async () => {
    const half = BYTES.length / 2;
    const body = gated(BYTES.subarray(0, half), BYTES.subarray(half));
    const { service } = installSetup({ installable: true, exe: body.response });
    await service.check();
    const running = service.install();
    await vi.waitFor(() => expect(service.state().percent).toBe(50));
    body.release();
    await running;
    expect(service.state().percent).toBeNull();
  });
  it('removes the partial file when the app stops mid-download', async () => {
    const body = gated(BYTES.subarray(0, 10));
    const { service, files, spawn } = installSetup({ installable: true, exe: body.response });
    await service.check();
    const running = service.install();
    await vi.waitFor(() => expect(files.written.size).toBe(1));
    service.stop();
    await running;
    body.release();
    expect(files.dirs.size).toBe(0);
    expect(files.written.size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(getSetting(db, 'update.pending')).toBeNull();
  });
  it('cancels from the user without a failure', async () => {
    const { service, files } = installSetup({
      installable: true,
      exe: () => new Response(new ReadableStream<Uint8Array>({ start() {} })),
    });
    await service.check();
    const running = service.install();
    await vi.waitFor(() => expect(files.dirs.size).toBe(1));
    service.cancel();
    await running;
    expect(phase(service)).toBe('idle');
    expect(service.state().failure).toBeNull();
    expect(files.dirs.size).toBe(0);
    expect(service.state().version).toBe('2.0.0');
  });
  it('waits while busy after the download, says so, then installs', async () => {
    let busy = false;
    const { service, spawn, calls } = installSetup({
      installable: true,
      busy: () => busy,
      exe: () => {
        // A task starts while the file is coming in.
        busy = true;
        return bodyOf(BYTES);
      },
    });
    await service.check();
    const running = service.install();
    await vi.waitFor(() => expect(phase(service)).toBe('waiting'));
    expect(spawn).not.toHaveBeenCalled();
    expect(service.installing).toBe(false);
    expect(await service.check()).toBe('busy');
    busy = false;
    await running;
    expect(phase(service)).toBe('installing');
    expect(calls).toEqual(['prepare', 'spawn', 'quit']);
  });
  it('quitting while it waits deletes the file and never installs', async () => {
    let busy = false;
    const { service, spawn, quit, files } = installSetup({
      installable: true,
      busy: () => busy,
      exe: () => {
        busy = true;
        return bodyOf(BYTES);
      },
    });
    await service.check();
    const running = service.install();
    await vi.waitFor(() => expect(phase(service)).toBe('waiting'));
    service.stop();
    await running;
    busy = false;
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(getSetting(db, 'update.pending')).toBeNull();
    expect(files.dirs.size).toBe(0);
  });
  it('does nothing without a newer version or while it is already running', async () => {
    const { service, fetcher } = installSetup({ installable: true });
    await service.install();
    expect(fetcher).not.toHaveBeenCalled();
    await service.check();
    const first = service.install();
    await service.install();
    await first;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('stops the update and stays open when the backup fails', async () => {
    const { service, spawn, quit, files } = installSetup({
      installable: true,
      prepare: () => {
        throw new Error('disk full');
      },
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(service.state().failure).toBe(
      'The tree could not be backed up, so the update was not started.',
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(service.installing).toBe(false);
    expect(getSetting(db, 'update.pending')).toBeNull();
    expect(files.dirs.size).toBe(0);
  });
  it('reads the file from disk again before it is run and refuses a changed one', async () => {
    let busy = false;
    const { service, spawn, quit, files } = installSetup({
      installable: true,
      busy: () => busy,
      exe: () => {
        busy = true;
        return bodyOf(BYTES);
      },
    });
    await service.check();
    const running = service.install();
    await vi.waitFor(() => expect(phase(service)).toBe('waiting'));
    // Something replaces the file while the update waits.
    const [file] = [...files.written.keys()];
    files.written.set(file!, [WRONG]);
    busy = false;
    await running;
    expect(phase(service)).toBe('failed');
    expect(service.state().failure).toMatch(/changed before it was run/);
    expect(spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(files.dirs.size).toBe(0);
  });
  it('answers Update now with a message while a check is running', async () => {
    let finish!: (response: Response) => void;
    const { service, fetcher } = installSetup({ installable: true });
    await service.check();
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const check = service.check(true);
    await service.install();
    expect(phase(service)).toBe('failed');
    expect(service.state().failure).toMatch(/check for a new version is running/);
    finish(new Response(feedText()));
    await check;
    expect(phase(service)).toBe('idle');
  });
  it('can try again after a failure', async () => {
    let bad = true;
    const { service, spawn } = installSetup({
      installable: true,
      exe: () => (bad ? bodyOf(WRONG) : bodyOf(BYTES)),
    });
    await service.check();
    await service.install();
    expect(phase(service)).toBe('failed');
    bad = false;
    await service.install();
    expect(phase(service)).toBe('installing');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('what the last update left behind', () => {
  it('reports an update that took, and clears the marker', () => {
    setSetting(db, 'update.pending', '1.0.0');
    const { service } = installSetup();
    service.start();
    expect(service.state().outcome).toEqual({ kind: 'updated', version: '1.0.0' });
    expect(getSetting(db, 'update.pending')).toBeNull();
    service.acknowledge();
    expect(service.state().outcome).toBeNull();
  });
  it('reports an update that did not install, with the release page to open', async () => {
    setSetting(db, 'update.pending', '2.0.0');
    const open = vi.fn().mockResolvedValue(undefined);
    const service = new UpdateService({
      db,
      version: '1.0.0',
      packaged: false,
      busy: () => false,
      fetch: vi.fn(),
      open,
    });
    service.start();
    expect(service.state().outcome).toEqual({ kind: 'not-installed', version: '2.0.0' });
    expect(getSetting(db, 'update.pending')).toBeNull();
    await service.open();
    expect(open).toHaveBeenCalledWith(
      'https://github.com/speedyrulz/rulz-kinspora/releases/tag/v2.0.0',
    );
  });
  it('says nothing for an older or unreadable marker, and still clears it', () => {
    for (const marker of ['0.5.0', 'nonsense']) {
      setSetting(db, 'update.pending', marker);
      const { service } = installSetup();
      service.start();
      expect(service.state().outcome).toBeNull();
      expect(getSetting(db, 'update.pending')).toBeNull();
    }
  });
  it('sweeps the folders of earlier downloads and nothing else', () => {
    const { service, files } = installSetup({
      existing: [
        `rulz-kinspora-update-${'a'.repeat(24)}`,
        `rulz-kinspora-update-${'0'.repeat(24)}`,
        'other-folder',
        'rulz-kinspora-update-old1',
        `rulz-kinspora-update-${'A'.repeat(24)}`,
        `rulz-kinspora-update-${'a'.repeat(25)}`,
      ],
    });
    service.start();
    expect([...files.dirs].map((dir) => basename(dir))).toEqual([
      'other-folder',
      'rulz-kinspora-update-old1',
      `rulz-kinspora-update-${'A'.repeat(24)}`,
      `rulz-kinspora-update-${'a'.repeat(25)}`,
    ]);
  });
  it('goes on sweeping when one folder is locked', () => {
    const { service, files } = installSetup({
      existing: [
        `rulz-kinspora-update-${'a'.repeat(24)}`,
        `rulz-kinspora-update-${'b'.repeat(24)}`,
      ],
    });
    const remove = files.remove.bind(files);
    files.remove = (path: string) => {
      if (basename(path).endsWith('a'.repeat(24))) throw new Error('EBUSY');
      remove(path);
    };
    service.start();
    expect([...files.dirs].map((dir) => basename(dir))).toEqual([
      `rulz-kinspora-update-${'a'.repeat(24)}`,
    ]);
  });
  it('takes no arguments for the new calls, and never a version from the page', () => {
    const { service, fetcher } = installSetup();
    const handlers = createUpdateHandlers(service);
    expect(() => handlers.installUpdate('2.0.0')).toThrow();
    expect(() => handlers.installUpdate({ version: '9.9.9' })).toThrow();
    expect(() => handlers.cancelUpdate(1)).toThrow();
    expect(() => handlers.acknowledgeUpdate('x')).toThrow();
    expect(handlers.installUpdate()).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
