import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackReader, PackWriter, openAppDatabase, type Db, type PackMeta } from '@rulz/db';
import { BuildStopped, inProcessBuildRunner, type BuildRunner } from './packbuild';
import { PACKS_LOCK, PACKS_MARKER, PackError, PackManager } from './packs';
import type { PackFetch, PackInstallSpec } from './packs';
import { PackSearch, inProcessSearchChannel, type InProcessOptions } from './packsearch';

/**
 * Lets a test make a rename or a delete of the packs folder fail, or change
 * what follows it. Without a hook the real call is made.
 */
const fsHooks = vi.hoisted(() => ({
  rename: null as
    null | ((from: string, to: string, real: (from: string, to: string) => void) => void),
  rm: null as null | ((path: string) => void),
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (fsHooks.rename === null) real.renameSync(from, to);
      else fsHooks.rename(String(from), String(to), real.renameSync);
    },
    rmSync: (path: string, options?: object) => {
      fsHooks.rm?.(String(path));
      real.rmSync(path, options);
    },
  };
});

// Every name, place and identifier in the fixtures is made up.
const FIXTURES = join(
  import.meta.dirname,
  '../../../../packages/connectors/src/sources/open-archives/fixtures',
);
const marriages = readFileSync(join(FIXTURES, 'pack-sample.csv'));
const births = readFileSync(join(FIXTURES, 'pack-sample-births.csv'));

let dir: string;
let appDb: Db;
let server: Server | null;
let port: number;
/** The requests the server saw, as "METHOD /path". */
let seen: string[];
/** What the server does for a path; a test can put its own in place. */
let routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void>;
let managers: PackManager[];

function serve(name: string, body: Buffer): void {
  routes.set(`/${name}`, (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

/** A file that starts to arrive and never ends. Asked for its size, it says. */
function slow(name: string, length = 50_000_000, first = 1000): void {
  routes.set(`/${name}`, (req, res) => {
    res.writeHead(200, { 'content-length': length });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.write(Buffer.alloc(first));
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rulz-packs-'));
  appDb = openAppDatabase(':memory:');
  seen = [];
  routes = new Map();
  managers = [];
  fsHooks.rename = null;
  fsHooks.rm = null;
  serve('marriages.csv.gz', gzipSync(marriages));
  // A file that is not packed is taken as it is.
  serve('births.csv', births);
  server = createServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`);
    const route = routes.get(req.url ?? '');
    if (route === undefined) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  fsHooks.rename = null;
  fsHooks.rm = null;
  for (const manager of managers) await manager.shutdown(2000);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  appDb.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const root = () => join(dir, 'packs');
const url = (name: string) => `http://127.0.0.1:${port}/${name}`;

const spec = (overrides: Partial<PackInstallSpec> = {}): PackInstallSpec => ({
  id: 'tst1',
  kind: 'open-archives',
  title: 'Test archive',
  sourceName: 'Open Archives',
  sourceUrl: 'https://www.openarchieven.nl/',
  licence: 'CC0 1.0',
  credit: 'Test archive, via Open Archives',
  files: [{ url: url('marriages.csv.gz') }, { url: url('births.csv') }],
  ...overrides,
});

interface Made {
  manager: PackManager;
  search: PackSearch;
  /** The channels the search side was given, so a test can see that it was ended. */
  ended: { count: number };
}

function make(
  options: {
    build?: BuildRunner;
    freeBytes?: (dir: string) => number | null;
    reserveBytes?: number;
    stallMs?: number;
    ackMs?: number;
    channel?: InProcessOptions;
    isRunning?: (pid: number) => boolean;
    fetch?: PackFetch;
  } = {},
): Made {
  const ended = { count: 0 };
  const search: PackSearch = new PackSearch({
    spawn: () =>
      inProcessSearchChannel({
        ...options.channel,
        onTerminate: () => {
          ended.count += 1;
        },
      }),
    pathOf: (id) => join(root(), `${id}.pack`),
    ackMs: options.ackMs ?? 2000,
  });
  const manager = new PackManager({
    appDb,
    defaultRoot: root(),
    fetch: options.fetch ?? ((address, init) => fetch(address, init)),
    appVersion: '0.0.0-test',
    search,
    build: options.build ?? inProcessBuildRunner(),
    ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
    reserveBytes: options.reserveBytes ?? 1,
    stallMs: options.stallMs ?? 5000,
    retryMs: 1,
    testHosts: { hosts: ['127.0.0.1'], insecure: true },
    ...(options.isRunning === undefined ? {} : { isRunning: options.isRunning }),
  });
  managers.push(manager);
  return { manager, search, ended };
}

/** The names of what is in the packs folder. */
const listing = () => (existsSync(root()) ? readdirSync(root()).sort() : []);

const nobody = () => new AbortController().signal;

describe('installing a pack', () => {
  it('downloads, builds and installs it, and the pack can be searched', async () => {
    const { manager } = make();
    manager.start();
    manager.install(spec());
    expect(manager.running).toBe(true);
    await manager.idle();

    const state = manager.state();
    expect(state.job).toMatchObject({ id: 'tst1', phase: 'done', message: null });
    expect(state.job?.doneBytes).toBe(gzipSync(marriages).length + births.length);
    expect(state.job?.totalBytes).toBe(gzipSync(marriages).length + births.length);
    expect(state.packs).toHaveLength(1);
    expect(state.packs[0]).toMatchObject({
      id: 'tst1',
      kind: 'open-archives',
      title: 'Test archive',
      licence: 'CC0 1.0',
      state: 'ready',
    });
    expect(state.packs[0]?.downloadedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Nothing is left but the marker and the pack.
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);

    // The pack holds the rows of both files, each placed by its own header.
    const opened = PackReader.open(manager.pathOf('tst1'));
    if (!opened.ok) throw new Error('the pack does not open');
    const { meta, columns } = opened.reader;
    opened.reader.close();
    expect(meta.files.map((file) => file.url)).toEqual([
      url('marriages.csv.gz'),
      url('births.csv'),
    ]);
    expect(meta.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    expect(meta.files[0]?.bytes).toBe(gzipSync(marriages).length);
    expect(columns).toContain('GROOM_NAME_SURN');
    expect(columns).toContain('PR_NAME_SURN');
    expect(meta.rows).toBeGreaterThan(5);
    expect(state.packs[0]?.rows).toBe(meta.rows);

    const baker = await manager.search('tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody());
    expect(baker.rows.length).toBeGreaterThan(0);
    expect(baker.rows.every((row) => JSON.stringify(row).includes('Baker'))).toBe(true);
    // A request for the sizes first, then each file; each is asked for once.
    expect(seen.filter((line) => line.startsWith('GET')).sort()).toEqual([
      'GET /births.csv',
      'GET /marriages.csv.gz',
    ]);
  });

  it('puts the marker in a new folder', () => {
    const { manager } = make();
    manager.install(spec());
    expect(readFileSync(join(root(), PACKS_MARKER), 'utf8')).toContain('data packs');
    manager.cancel();
  });

  it('uses an existing folder that is empty', async () => {
    mkdirSync(root());
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });

  it('replaces a pack with a new build and keeps searching the new file', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    const first = manager.state().packs[0]?.rows ?? 0;
    // The search side has the old file open; the swap must make it let go.
    const before = await manager.search('tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody());
    expect(before.rows.length).toBeGreaterThan(0);
    manager.install(spec({ title: 'Test archive, again', files: [{ url: url('births.csv') }] }));
    await manager.idle();
    expect(manager.state().job?.phase).toBe('done');
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
    expect(manager.state().packs[0]?.title).toBe('Test archive, again');
    expect(manager.state().packs[0]?.rows).toBeLessThan(first);
    // The new file is searched, not the old one: only it has the births.
    const smit = await manager.search('tst1', { names: 'Smit', limit: 20, offset: 0 }, nobody());
    expect(smit.rows.length).toBeGreaterThan(0);
    const baker = await manager.search('tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody());
    expect(baker.rows).toEqual([]);
  });

  it('refuses a second job while one runs', async () => {
    const { manager } = make();
    manager.install(spec());
    expect(() => manager.install(spec({ id: 'tst2' }))).toThrow(PackError);
    await manager.idle();
  });

  it('refuses a request that is not one the app takes', () => {
    const { manager } = make();
    const refused = (overrides: Partial<PackInstallSpec>) => () => manager.install(spec(overrides));
    expect(refused({ id: '../x' })).toThrow(/id/);
    expect(refused({ id: 'AB' })).toThrow(/id/);
    expect(refused({ id: 'a' })).toThrow(/id/);
    expect(refused({ id: 'abcdefghijklm' })).toThrow(/id/);
    expect(refused({ id: 'a.b' })).toThrow(/id/);
    expect(refused({ kind: 'nara' })).toThrow(/kind/);
    expect(refused({ files: [] })).toThrow(/files/);
    expect(refused({ files: [{ url: 'https://example.com/a.csv.gz' }] })).toThrow(/not downloaded/);
    expect(refused({ files: [{ url: 'http://oa-export.s3.nl-ams.scw.cloud/a.csv.gz' }] })).toThrow(
      /https/,
    );
    expect(
      refused({ files: [{ url: 'https://u:p@oa-export.s3.nl-ams.scw.cloud/a.csv.gz' }] }),
    ).toThrow(/user name/);
    expect(
      refused({ files: [{ url: 'https://oa-export.s3.nl-ams.scw.cloud:8443/a.csv.gz' }] }),
    ).toThrow(/port/);
    expect(refused({ files: [{ url: 'not a url' }] })).toThrow(/address/);
    // Nothing was made for any of them.
    expect(listing()).toEqual([]);
    expect(manager.running).toBe(false);
  });

  it('accepts the host the kind names, over https', async () => {
    // Only the checks are looked at here: the download then fails, as there is no such host in a test.
    const { manager } = make({ fetch: () => Promise.reject(new Error('no network in a test')) });
    expect(() =>
      manager.install(
        spec({
          files: [{ url: 'https://oa-export.s3.nl-ams.scw.cloud/csv/tst.marriages.csv.gz' }],
        }),
      ),
    ).not.toThrow();
    await manager.idle();
    expect(manager.state().job?.phase).toBe('failed');
  });
});

describe('a job that does not finish', () => {
  it('cancelled in the middle of a download leaves no work folder and no new file', async () => {
    slow('slow.csv.gz');
    const { manager } = make();
    manager.install(
      spec({ files: [{ url: url('marriages.csv.gz') }, { url: url('slow.csv.gz') }] }),
    );
    for (let waited = 0; (manager.state().job?.phase ?? '') !== 'downloading'; waited += 1) {
      if (waited > 200) throw new Error('the download did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    while ((manager.state().job?.doneBytes ?? 0) <= gzipSync(marriages).length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(join(root(), 'work-tst1'))).toBe(true);
    expect(manager.cancel()).toEqual({ ok: true });
    await manager.idle();
    expect(manager.state().job?.phase).toBe('cancelled');
    expect(listing()).toEqual([PACKS_MARKER]);
    expect(manager.cancel()).toMatchObject({ ok: false });
  });

  it('cancelled in the middle of the build leaves no work folder and no new file', async () => {
    // A file of many rows, so that the build writes several batches.
    const lines = marriages.toString('utf8').split('\n');
    const header = lines[0] ?? '';
    const row = lines[1] ?? '';
    const guidAt = header.split('|').indexOf('SOURCE_RECORD_GUID');
    const many = [header];
    for (let n = 0; n < 30_000; n += 1) {
      const fields = row.split('|');
      fields[guidAt] = `{r${n}-4E5F}`;
      many.push(fields.join('|'));
    }
    serve('many.csv.gz', gzipSync(Buffer.from(many.join('\n'))));
    const inner = inProcessBuildRunner();
    let manager: PackManager | null = null;
    let cancelled: unknown = null;
    const build: BuildRunner = (input, onProgress) =>
      inner(input, (rows) => {
        onProgress(rows);
        if (cancelled === null) cancelled = manager?.cancel();
      });
    const made = make({ build });
    manager = made.manager;
    manager.install(spec({ files: [{ url: url('many.csv.gz') }] }));
    await manager.idle();
    expect(cancelled).toEqual({ ok: true });
    expect(manager.state().job?.phase).toBe('cancelled');
    expect(listing()).toEqual([PACKS_MARKER]);
  });

  it('a pack that fails its check leaves the old pack in use', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    const before = readFileSync(manager.pathOf('tst1'));

    // A build that makes something that is no pack, and says it succeeded.
    const bad: BuildRunner = (input) => {
      writeFileSync(input.outPath, 'this is not a pack');
      return {
        promise: Promise.resolve({
          packId: 'tst1',
          kind: 'open-archives',
          builderVersion: 1,
          title: '',
          sourceName: '',
          sourceUrl: '',
          licence: '',
          credit: '',
          files: [],
          rows: 1,
          downloadedAt: '2026-11-15',
          builtAt: '',
        }),
        stop: () => undefined,
      };
    };
    const second = make({ build: bad });
    // Same folder, the manager of the first run is gone.
    second.manager.install(spec());
    await second.manager.idle();
    expect(second.manager.state().job).toMatchObject({ phase: 'failed' });
    expect(second.manager.state().job?.message).toMatch(/failed its check/);
    expect(readFileSync(second.manager.pathOf('tst1')).equals(before)).toBe(true);
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
    const found = await second.manager.search(
      'tst1',
      { names: 'Baker', limit: 20, offset: 0 },
      nobody(),
    );
    expect(found.rows.length).toBeGreaterThan(0);
  });

  it('refuses when there is not room, before anything is downloaded', async () => {
    const { manager } = make({ freeBytes: () => 1000, reserveBytes: 10_000 });
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(manager.state().job?.message).toMatch(/not enough free space/);
    expect(seen.filter((line) => line.startsWith('GET'))).toEqual([]);
    expect(listing()).toEqual([PACKS_MARKER]);
  });

  it('needs twelve times the size of the files', async () => {
    const need = (gzipSync(marriages).length + births.length) * 12;
    const { manager } = make({ freeBytes: () => need + 5, reserveBytes: 10 });
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job?.message).toMatch(/not enough free space/);
    const enough = make({ freeBytes: () => need + 50_000, reserveBytes: 10 });
    enough.manager.install(spec());
    await enough.manager.idle();
    expect(enough.manager.state().job?.phase).toBe('done');
  });

  it('fails when a file is shorter than the source said', async () => {
    routes.set('/short.csv.gz', (_req, res) => {
      res.writeHead(200, { 'content-length': 5000 });
      res.write(Buffer.alloc(100));
      setTimeout(() => res.destroy(), 20);
    });
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('short.csv.gz') }] }));
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(listing()).toEqual([PACKS_MARKER]);
  });

  it('does not follow a redirect', async () => {
    routes.set('/moved.csv.gz', (_req, res) => {
      res.writeHead(302, { location: url('marriages.csv.gz') }).end();
    });
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('moved.csv.gz') }] }));
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(seen.filter((line) => line.includes('marriages'))).toEqual([]);
  });

  it('gives up a download from which nothing arrives', async () => {
    slow('stalled.csv.gz', 5000, 10);
    const { manager } = make({ stallMs: 150 });
    manager.install(spec({ files: [{ url: url('stalled.csv.gz') }] }));
    await manager.idle();
    expect(manager.state().job?.message).toMatch(/stopped/);
    expect(listing()).toEqual([PACKS_MARKER]);
  });

  it('fails on a file that is not of the kind, and leaves nothing', async () => {
    serve('other.csv', Buffer.from('a|b|c\n1|2|3\n'));
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('other.csv') }] }));
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(manager.state().job?.message).toMatch(/SOURCE_RECORD_GUID|not an Open Archives file/);
    expect(listing()).toEqual([PACKS_MARKER]);
  });

  it("leaves out a row that does not have its header's fields and says so", async () => {
    const lines = marriages.toString('utf8').split('\n');
    const broken = [...lines.slice(0, 2), 'a|b', ...lines.slice(2)].join('\n');
    serve('broken.csv', Buffer.from(broken));
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('broken.csv') }] }));
    await manager.idle();
    expect(manager.state().job?.phase).toBe('done');
    const opened = PackReader.open(manager.pathOf('tst1'));
    if (!opened.ok) throw new Error('the pack does not open');
    const { meta } = opened.reader;
    opened.reader.close();
    // The fixture has a row of its own that is not whole.
    const own = lines
      .slice(1)
      .filter((line) => line !== '' && line.split('|').length !== 27 + 12 * 17);
    expect(meta.skipped).toBe(own.length + 1);
  });
});

describe('removing a pack', () => {
  it('deletes the file after the search let go of it', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    // A search opens the pack in the search side, which holds it open.
    await manager.search('tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody());
    expect(await manager.remove('tst1')).toEqual({ ok: true });
    expect(listing()).toEqual([PACKS_MARKER]);
    expect(manager.state().packs).toEqual([]);
    expect(await manager.remove('tst1')).toMatchObject({ ok: false });
  });

  it('returns in about two seconds when the search is stuck, and the file is gone', async () => {
    const { manager, ended } = make({
      ackMs: 150,
      channel: { stuck: (request) => request.type === 'search' || request.type === 'close' },
    });
    manager.install(spec());
    await manager.idle();
    const stuck = manager.search('tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody()).then(
      () => 'found',
      (error: unknown) => (error instanceof Error ? error.name : 'failed'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    expect(await manager.remove('tst1')).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ended.count).toBe(1);
    expect(listing()).toEqual([PACKS_MARKER]);
    // The search that was under way was ended, not left hanging.
    expect(await stuck).not.toBe('found');
  });

  it('refuses ids outside the pattern and a pack that is not there', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    for (const id of ['../tst1', 'TST1', 'a', 'tst1.pack', 'tst1\\..', '']) {
      expect(await manager.remove(id)).toMatchObject({ ok: false });
    }
    expect(await manager.remove('nope')).toMatchObject({ ok: false });
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
    await expect(
      manager.search('../tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody()),
    ).rejects.toThrow(PackError);
  });

  it('is refused while a job for the same pack runs', async () => {
    slow('slow.csv.gz');
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('births.csv') }] }));
    await manager.idle();
    manager.install(spec({ files: [{ url: url('slow.csv.gz') }] }));
    expect(await manager.remove('tst1')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/being installed/),
    });
    manager.cancel();
    await manager.idle();
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });

  it('never deletes a link or a folder, or a file that is not a pack', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    // A folder with a pack's name.
    mkdirSync(join(root(), 'zz.pack'));
    writeFileSync(join(root(), 'zz.pack', 'keep.txt'), 'x');
    expect(await manager.remove('zz')).toMatchObject({ ok: false });
    expect(existsSync(join(root(), 'zz.pack', 'keep.txt'))).toBe(true);
    // The state lists only real files.
    expect(manager.state().packs.map((pack) => pack.id)).toEqual(['tst1']);
  });
});

describe('the packs folder', () => {
  const sweepable = () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(join(root(), PACKS_MARKER), 'marker');
  };

  it('is swept at the start: unfinished files go, an old pack is put back', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    const good = readFileSync(manager.pathOf('tst1'));
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.txt'), 'keep me');

    writeFileSync(join(root(), 'ab.pack.new'), 'half');
    // The app was stopped between two renames: only the old file is left.
    writeFileSync(join(root(), 'cd.pack.old'), good);
    // The new file arrived: the old one is not needed.
    writeFileSync(join(root(), 'tst1.pack.old'), 'old');
    mkdirSync(join(root(), 'work-ef'));
    writeFileSync(join(root(), 'work-ef', 'file0'), 'partial');
    // Not names the app makes: left alone.
    writeFileSync(join(root(), 'notes.txt'), 'mine');
    writeFileSync(join(root(), 'a-b.pack.new'), 'hyphen');
    writeFileSync(join(root(), 'abcdefghijklm.pack.old'), 'too long');
    writeFileSync(join(root(), 'a.pack.old'), 'too short');
    mkdirSync(join(root(), 'work-Upper'));
    mkdirSync(join(root(), 'work-x'));
    // A link to a folder outside is not followed, and nothing in it is deleted.
    let linked = false;
    try {
      symlinkSync(outside, join(root(), 'work-gh'), 'junction');
      linked = true;
    } catch {
      // Links cannot be made here; the rest is still checked.
    }

    const fresh = make();
    fresh.manager.start();
    expect(listing()).toEqual(
      [
        PACKS_MARKER,
        'a-b.pack.new',
        'a.pack.old',
        'abcdefghijklm.pack.old',
        'cd.pack',
        'notes.txt',
        'tst1.pack',
        'work-Upper',
        'work-x',
        ...(linked ? ['work-gh'] : []),
      ].sort(),
    );
    expect(readFileSync(join(root(), 'cd.pack')).equals(good)).toBe(true);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    if (linked) expect(lstatSync(join(root(), 'work-gh')).isSymbolicLink()).toBe(true);
    // The restored file is a pack, but it names another id, so it is not offered.
    expect(fresh.manager.state().packs.map((pack) => [pack.id, pack.state])).toEqual([
      ['cd', 'unreadable'],
      ['tst1', 'ready'],
    ]);
  });

  it('is not swept while a process that is running holds the job lock', () => {
    sweepable();
    writeFileSync(join(root(), 'ab.pack.new'), 'half');
    writeFileSync(join(root(), PACKS_LOCK), JSON.stringify({ pid: 424242, startedAt: 1 }));
    const live = make({ isRunning: () => true });
    live.manager.start();
    expect(listing()).toEqual(['ab.pack.new', PACKS_LOCK, PACKS_MARKER]);
    const gone = make({ isRunning: () => false });
    gone.manager.start();
    expect(listing()).toEqual([PACKS_MARKER]);
  });

  it('is refused when it holds files but no marker: nothing in it is swept or deleted', async () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(join(root(), 'thesis.docx'), 'important');
    writeFileSync(join(root(), 'ab.pack.new'), 'looks like ours');
    writeFileSync(join(root(), 'tst1.pack'), 'looks like ours too');
    mkdirSync(join(root(), 'work-ab'));
    const { manager } = make();
    manager.start();
    expect(listing()).toEqual(['ab.pack.new', 'thesis.docx', 'tst1.pack', 'work-ab']);
    expect(() => manager.install(spec())).toThrow(/not a packs folder/);
    expect(await manager.remove('tst1')).toMatchObject({ ok: false });
    expect(listing()).toEqual(['ab.pack.new', 'thesis.docx', 'tst1.pack', 'work-ab']);
    const state = manager.state();
    expect(state.packs).toEqual([]);
    expect(state.job).toMatchObject({ phase: 'failed' });
    expect(state.job?.message).toMatch(/not a packs folder/);
    expect(manager.ready()).toEqual([]);
    await expect(
      manager.search('tst1', { names: 'Baker', limit: 20, offset: 0 }, nobody()),
    ).rejects.toThrow(PackError);
  });

  it('is refused when it is a link', () => {
    const target = join(dir, 'elsewhere');
    mkdirSync(target);
    try {
      symlinkSync(target, root(), 'junction');
    } catch {
      return;
    }
    const { manager } = make();
    expect(() => manager.install(spec())).toThrow(/not a plain folder/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('lists a pack made by another builder as one to rebuild, and a file that is no pack as unreadable', async () => {
    sweepable();
    const old = PackWriter.create(join(root(), 'oldb.pack'), ['EVENT_TYPE'], {
      names: [],
      places: [],
    });
    old.add([{ year: 1900, values: ['x'] }]);
    old.finish({
      packId: 'oldb',
      kind: 'open-archives',
      builderVersion: 0,
      title: 'Old build',
      sourceName: 's',
      sourceUrl: 'https://example.com/',
      licence: 'l',
      credit: 'c',
      files: [],
      downloadedAt: '2026-01-02',
    });
    writeFileSync(join(root(), 'junk.pack'), 'not a database');
    const strange = PackWriter.create(join(root(), 'kind1.pack'), ['A'], { names: [], places: [] });
    strange.add([{ year: null, values: ['x'] }]);
    strange.finish({
      packId: 'kind1',
      kind: 'census',
      builderVersion: 1,
      title: 'Another kind',
      sourceName: 's',
      sourceUrl: 'https://example.com/',
      licence: 'l',
      credit: 'c',
      files: [],
      downloadedAt: '2026-01-02',
    });
    const { manager } = make();
    const packs = manager.state().packs;
    expect(packs.map((pack) => [pack.id, pack.state])).toEqual([
      ['junk', 'unreadable'],
      ['kind1', 'unreadable'],
      ['oldb', 'rebuild'],
    ]);
    // Only a ready pack is searched.
    expect(manager.ready()).toEqual([]);
    expect(packs[2]).toMatchObject({ title: 'Old build', downloadedAt: '2026-01-02', rows: 1 });
  });
});

/** A pack that is complete but whose file was changed after the check: the swap finds it unreadable. */
const spoil = (dest: string) => writeFileSync(dest, 'spoiled after the check');

describe('replacing a pack safely', () => {
  const installed = async () => {
    const first = make();
    first.manager.install(spec());
    await first.manager.idle();
    await first.manager.shutdown(500);
    return readFileSync(join(root(), 'tst1.pack'));
  };
  /** Makes the new file unreadable as soon as it is in place. */
  const spoilOnSwap = () => {
    fsHooks.rename = (from, to, real) => {
      real(from, to);
      if (from.endsWith('.pack.new') && to.endsWith('.pack')) spoil(to);
    };
  };

  it('puts a lone .old file back before anything is replaced, and keeps it when the swap fails', async () => {
    const before = await installed();
    renameSync(join(root(), 'tst1.pack'), join(root(), 'tst1.pack.old'));
    spoilOnSwap();
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('births.csv') }] }));
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(readFileSync(join(root(), 'tst1.pack')).equals(before)).toBe(true);
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });

  it('does not replace a pack file that is a folder or a link', async () => {
    mkdirSync(join(root(), 'tst1.pack'), { recursive: true });
    writeFileSync(join(root(), PACKS_MARKER), 'marker');
    writeFileSync(join(root(), 'tst1.pack', 'keep.txt'), 'mine');
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(manager.state().job?.message).toMatch(/not a plain file/);
    expect(readFileSync(join(root(), 'tst1.pack', 'keep.txt'), 'utf8')).toBe('mine');
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });

  it('tries the rollback again when the old file is in use for a moment', async () => {
    const before = await installed();
    let refused = 0;
    fsHooks.rename = (from, to, real) => {
      if (from.endsWith('.pack.old') && to.endsWith('.pack') && refused < 2) {
        refused += 1;
        throw new Error('EBUSY: in use');
      }
      real(from, to);
      if (from.endsWith('.pack.new') && to.endsWith('.pack')) spoil(to);
    };
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('births.csv') }] }));
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(refused).toBe(2);
    expect(readFileSync(join(root(), 'tst1.pack')).equals(before)).toBe(true);
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });

  it('when the rollback cannot finish, the next sweep restores the old pack instead of deleting it', async () => {
    const before = await installed();
    spoilOnSwap();
    const spoiling = fsHooks.rename;
    fsHooks.rename = (from, to, real) => {
      if (from.endsWith('.pack.old')) throw new Error('EBUSY: in use');
      spoiling?.(from, to, real);
    };
    // Neither the failed file nor the leftovers can be deleted now.
    fsHooks.rm = (path) => {
      if (path.endsWith('.pack') || path.endsWith('.pack.new')) throw new Error('EBUSY: in use');
    };
    const { manager } = make();
    manager.install(spec({ files: [{ url: url('births.csv') }] }));
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    // The failed file is called a leftover, and the old file is kept.
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack.new', 'tst1.pack.old']);
    fsHooks.rename = null;
    fsHooks.rm = null;
    make().manager.start();
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
    expect(readFileSync(join(root(), 'tst1.pack')).equals(before)).toBe(true);
  });
});

describe('the job lock', () => {
  const sweepable = () => {
    mkdirSync(root(), { recursive: true });
    writeFileSync(join(root(), PACKS_MARKER), 'marker');
  };

  it('is not taken over from another process that is running', async () => {
    sweepable();
    const lock = JSON.stringify({ pid: 424242, startedAt: 1 });
    writeFileSync(join(root(), PACKS_LOCK), lock);
    const { manager } = make({ isRunning: () => true });
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job).toMatchObject({
      phase: 'failed',
      message: 'Another copy of the app is working on packs.',
    });
    expect(readFileSync(join(root(), PACKS_LOCK), 'utf8')).toBe(lock);
    expect(seen).toEqual([]);
    expect(listing()).toEqual([PACKS_LOCK, PACKS_MARKER]);
  });

  it('is replaced when it is a stale one', async () => {
    sweepable();
    writeFileSync(join(root(), PACKS_LOCK), JSON.stringify({ pid: 424242, startedAt: 1 }));
    const { manager } = make({ isRunning: () => false });
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job?.phase).toBe('done');
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });

  it('is never written through a link', async () => {
    sweepable();
    const target = join(dir, 'precious.txt');
    writeFileSync(target, 'keep me');
    try {
      symlinkSync(target, join(root(), PACKS_LOCK), 'file');
    } catch {
      return;
    }
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(lstatSync(join(root(), PACKS_LOCK)).isSymbolicLink()).toBe(true);
  });
});

describe('the work folder', () => {
  it('loses only the files a job makes, in a sweep and after a job', async () => {
    mkdirSync(join(root(), 'work-ef', 'sub'), { recursive: true });
    writeFileSync(join(root(), PACKS_MARKER), 'marker');
    writeFileSync(join(root(), 'work-ef', 'file0'), 'partial');
    writeFileSync(join(root(), 'work-ef', 'keep.txt'), 'mine');
    writeFileSync(join(root(), 'work-ef', 'sub', 'deep.txt'), 'mine too');
    make().manager.start();
    expect(readdirSync(join(root(), 'work-ef')).sort()).toEqual(['keep.txt', 'sub']);
    expect(readFileSync(join(root(), 'work-ef', 'sub', 'deep.txt'), 'utf8')).toBe('mine too');

    mkdirSync(join(root(), 'work-tst1'));
    writeFileSync(join(root(), 'work-tst1', 'keep.txt'), 'mine');
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job?.phase).toBe('done');
    expect(readdirSync(join(root(), 'work-tst1'))).toEqual(['keep.txt']);
  });

  it('is removed once it is empty', async () => {
    const { manager } = make();
    manager.install(spec());
    await manager.idle();
    expect(listing()).toEqual([PACKS_MARKER, 'tst1.pack']);
  });
});

describe('free space and quitting', () => {
  it('looks at the free space again with the real sizes when the source gave none', async () => {
    const noLength = (name: string, body: Buffer) =>
      routes.set(`/${name}`, (req, res) => {
        res.writeHead(200);
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    noLength('marriages.csv.gz', gzipSync(marriages));
    noLength('births.csv', births);
    const actual = gzipSync(marriages).length + births.length;
    const { manager } = make({ freeBytes: () => actual * 12 - 1000, reserveBytes: 10 });
    manager.install(spec());
    await manager.idle();
    expect(manager.state().job).toMatchObject({ phase: 'failed' });
    expect(manager.state().job?.message).toMatch(/not enough free space/);
    expect(listing()).toEqual([PACKS_MARKER]);
    const enough = make({ freeBytes: () => actual * 12 + 1000, reserveBytes: 10 });
    enough.manager.install(spec());
    await enough.manager.idle();
    expect(enough.manager.state().job?.phase).toBe('done');
  });

  it('waits at quit for a job whose build takes longer than five seconds to stop', async () => {
    let stopped = (): void => undefined;
    const late: BuildRunner = () => ({
      promise: new Promise<PackMeta>((_resolve, reject) => {
        stopped = () => {
          setTimeout(() => reject(new BuildStopped()), 6000);
        };
      }),
      stop: () => stopped(),
    });
    const { manager } = make({ build: late });
    manager.install(spec());
    for (let waited = 0; (manager.state().job?.phase ?? '') !== 'building'; waited += 1) {
      if (waited > 500) throw new Error('the build did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await manager.shutdown();
    expect(manager.running).toBe(false);
    expect(manager.state().job?.phase).toBe('cancelled');
    expect(listing()).toEqual([PACKS_MARKER]);
  }, 20_000);
});
