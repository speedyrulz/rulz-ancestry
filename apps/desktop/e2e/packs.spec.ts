import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ElectronApplication, Page } from '@playwright/test';
import { buildPack } from '../src/main/packbuild';
import type {
  PackActionResult,
  PackArchivesResult,
  PackInfo,
  PackOfferResult,
  PacksState,
  RecordSearchResult,
} from '../src/shared/ipc';
import { addPerson, createTree, expect, launchApp, test } from './fixtures';

/**
 * A data pack in the packs folder is listed in the Packs window, is searched in
 * the worker thread the app starts for it (which proves the worker loads from
 * the built app and from the packaged one), and is deleted by Remove.
 *
 * The pack is built here, with the same code the app builds one with, from a
 * made-up file in the format of Open Archives' CSV dumps. The app keeps its
 * packs inside the profile folder when it is started with one, so the file is
 * put there, with the marker that says the folder is the app's, before the app
 * starts.
 */
const FIXTURES = resolve(
  import.meta.dirname,
  '../../../packages/connectors/src/sources/open-archives/fixtures',
);

/** The bridge as the page has it: each call answers with a result that is ok, or says why not. */
type Bridge = Record<
  string,
  (argument?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>
>;

/** Calls a function of the bridge from the page, and gives back what it answered or throws what it refused with. */
function ask<T>(window: Page, method: string, argument?: unknown): Promise<T> {
  return window.evaluate(
    async ({ method, argument }) => {
      const call = (window as unknown as { rulz: Bridge }).rulz[method];
      if (call === undefined) throw new Error(`the bridge has no ${method}`);
      const result = argument === undefined ? await call() : await call(argument);
      if (!result.ok) throw new Error(result.error?.message ?? 'refused');
      return result.value;
    },
    { method, argument },
  ) as Promise<T>;
}

async function personId(window: Page): Promise<string> {
  const page = await ask<{ persons: { id: string }[] }>(window, 'listPersons', {
    query: '',
    offset: 0,
    limit: 10,
  });
  return page.persons[0]?.id ?? '';
}

test('a pack in the packs folder is listed, searched through its worker, and removed', async ({
  appTarget,
  userDataDir,
}) => {
  const packs = join(userDataDir, 'packs');
  mkdirSync(packs, { recursive: true });
  writeFileSync(join(packs, 'rulz-packs.txt'), 'The data packs of RulZ Ancestry.\r\n');
  const file = join(packs, 'tst1.pack');
  await buildPack(
    {
      kind: 'open-archives',
      outPath: file,
      files: ['pack-sample.csv', 'pack-sample-births.csv'].map((name) => ({
        path: join(FIXTURES, name),
        url: `https://oa-export.s3.nl-ams.scw.cloud/csv/${name}`,
        bytes: 1,
        sha256: '0'.repeat(64),
        etag: null,
        modified: null,
      })),
      meta: {
        packId: 'tst1',
        title: 'Test archive',
        sourceName: 'Open Archives',
        sourceUrl: 'https://www.openarchieven.nl/',
        licence: 'CC0 1.0',
        credit: 'Test archive, via Open Archives',
        downloadedAt: '2026-03-04',
      },
      reserveBytes: 1,
    },
    { stop: () => false, progress: () => undefined },
  );
  expect(existsSync(file)).toBe(true);

  const app = await launchApp(appTarget, userDataDir);
  try {
    const window = await app.firstWindow();
    await createTree(window, 'Packs');
    await addPerson(window, {
      given: 'Tobias',
      surname: 'Baker',
      birthDate: '1860',
      deathDate: '1930',
    });

    // The Packs window lists the pack that was put in the folder.
    await window.getByTestId('open-packs').click();
    await expect(window.getByTestId('packs-dialog')).toBeVisible();
    await expect(window.getByTestId('packs-root')).toHaveText(packs);
    await expect(window.getByTestId('pack-row')).toHaveCount(1);
    await expect(window.getByTestId('pack-title')).toHaveText('Test archive');
    await expect(window.getByTestId('pack-state')).toHaveText('Ready');
    await expect(window.getByTestId('pack-downloaded')).toHaveText('2026-03-04');
    await expect(window.getByTestId('pack-licence')).toContainText('CC0 1.0');
    await window.getByTestId('packs-close').click();
    await expect(window.getByTestId('packs-dialog')).toHaveCount(0);

    // The pack is one more source of the record search, and a search of it
    // gives a result: the worker that searches the packs was loaded and works.
    const id = await personId(window);
    const setup = await ask<{ sources: { id: string; name: string }[] }>(
      window,
      'getRecordSearch',
      id,
    );
    expect(setup.sources.find((source) => source.id === 'pack:tst1')?.name).toBe(
      'Test archive (pack on this PC)',
    );
    const result = await ask<RecordSearchResult>(window, 'searchRecords', {
      personId: id,
      sourceId: 'pack:tst1',
      query: { given: 'Tobias', surname: 'Baker', birthYear: null, deathYear: null },
      offset: 0,
    });
    if (!result.ok) throw new Error(`the search of the pack failed: ${result.problem.message}`);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      connectorId: 'open-archives',
      title: 'Tobias Baker',
      event: 'Huwelijk',
    });

    // Remove deletes the file, after a question.
    await window.getByTestId('open-packs').click();
    await window.getByTestId('pack-remove').click();
    await window.getByTestId('dialog-submit').click();
    await expect(window.getByTestId('packs-empty')).toBeVisible();
    await expect.poll(() => existsSync(file)).toBe(false);
    const after = await ask<PacksState>(window, 'getPacks');
    expect(after.packs satisfies PackInfo[]).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
  }
});

/**
 * Replaces Electron's `net.fetch` in the main process with a made-up Open
 * Archives: the catalogue, one archive's page, and the sizes and bytes of its
 * two files. Every request is kept as "METHOD address", so that the test can
 * say exactly what the app asked. Nothing reaches the real site.
 */
async function pretendOpenArchives(
  app: ElectronApplication,
  texts: Record<string, string>,
  files: Record<string, { base64: string; etag: string }>,
): Promise<void> {
  await app.evaluate(
    ({ net }, { texts: pages, files: served }) => {
      const asked: string[] = [];
      (globalThis as unknown as { askedOfInternet: string[] }).askedOfInternet = asked;
      net.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = init?.method ?? 'GET';
        asked.push(`${method} ${url}`);
        const page = pages[url];
        if (page !== undefined) return Promise.resolve(new Response(page));
        const file = served[url];
        if (file === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
        const bytes = Buffer.from(file.base64, 'base64');
        const headers = { 'content-length': String(bytes.length), etag: file.etag };
        return Promise.resolve(
          method === 'HEAD'
            ? new Response(null, { headers })
            : new Response(new Uint8Array(bytes), { headers }),
        );
      };
    },
    { texts, files },
  );
}

function askedOfInternet(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { askedOfInternet?: string[] }).askedOfInternet ?? [],
  );
}

test('installs an Open Archives pack from a made-up catalogue, and searches it', async ({
  app,
  window,
}) => {
  test.setTimeout(120_000);
  const site = 'https://www.openarchieven.nl';
  const exports = 'https://oa-export.s3.nl-ams.scw.cloud/csv';
  const marriages = gzipSync(readFileSync(join(FIXTURES, 'pack-sample.csv')));
  const births = gzipSync(readFileSync(join(FIXTURES, 'pack-sample-births.csv')));
  await pretendOpenArchives(
    app,
    {
      [`${site}/datasets/datacatalog.jsonld`]: readFileSync(
        join(FIXTURES, 'catalogue.sample.jsonld'),
        'utf8',
      ),
      [`${site}/datasets/tst1`]: readFileSync(join(FIXTURES, 'dataset-page-tst1.html'), 'utf8'),
    },
    {
      [`${exports}/tst1.bsh.csv.gz`]: { base64: marriages.toString('base64'), etag: '"m-1"' },
      [`${exports}/tst1.bsg.csv.gz`]: { base64: births.toString('base64'), etag: '"b-1"' },
    },
  );
  await createTree(window, 'Archives');
  await addPerson(window, {
    given: 'Tobias',
    surname: 'Baker',
    birthDate: '1860',
    deathDate: '1930',
  });
  await window.getByTestId('open-packs').click();
  await expect(window.getByTestId('packs-dialog')).toBeVisible();
  // Nothing is asked before the user asks.
  expect(await askedOfInternet(app)).toEqual([]);

  const listed = await ask<PackArchivesResult>(window, 'listPackArchives');
  if (!listed.ok) throw new Error(listed.message);
  expect(listed.archives.map((archive) => [archive.code, archive.name, archive.installed])).toEqual(
    [
      ['tst1', 'Test Town Archive', 'no'],
      ['tst2', 'Voorbeeldstad Archief', 'no'],
    ],
  );

  const described = await ask<PackOfferResult>(window, 'describePackArchive', 'tst1');
  if (!described.ok) throw new Error(described.message);
  expect(described.offer).toMatchObject({
    code: 'tst1',
    name: 'Test Town Archive',
    files: [
      { url: `${exports}/tst1.bsh.csv.gz`, bytes: marriages.length },
      { url: `${exports}/tst1.bsg.csv.gz`, bytes: births.length },
    ],
    downloadBytes: marriages.length + births.length,
    installed: 'no',
  });

  expect(await ask<PackActionResult>(window, 'installPackArchive', 'tst1')).toEqual({ ok: true });
  await expect
    .poll(
      async () => {
        const state = await ask<PacksState>(window, 'getPacks');
        if (state.job?.phase === 'failed') throw new Error(state.job.message ?? 'the job failed');
        return state.packs.map((pack) => `${pack.id} ${pack.state}`);
      },
      { timeout: 90_000 },
    )
    .toEqual(['oatst1 ready']);

  const state = await ask<PacksState>(window, 'getPacks');
  expect(state.packs[0]).toMatchObject({
    id: 'oatst1',
    kind: 'open-archives',
    title: 'Test Town Archive',
    licence: 'CC0 1.0',
    sourceModified: '2026-02-01',
  });

  // The pack found its way into the search, and the worker that reads it ran.
  const id = await personId(window);
  const result = await ask<RecordSearchResult>(window, 'searchRecords', {
    personId: id,
    sourceId: 'pack:oatst1',
    query: { given: 'Tobias', surname: 'Baker', birthYear: null, deathYear: null },
    offset: 0,
  });
  if (!result.ok) throw new Error(`the search of the pack failed: ${result.problem.message}`);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ connectorId: 'open-archives', title: 'Tobias Baker' });

  // The app asked exactly this: the catalogue, the page, the sizes, and again
  // the sizes and then the files when the install began.
  expect(await askedOfInternet(app)).toEqual([
    `GET ${site}/datasets/datacatalog.jsonld`,
    `GET ${site}/datasets/tst1`,
    `HEAD ${exports}/tst1.bsh.csv.gz`,
    `HEAD ${exports}/tst1.bsg.csv.gz`,
    `HEAD ${exports}/tst1.bsh.csv.gz`,
    `HEAD ${exports}/tst1.bsg.csv.gz`,
    `GET ${exports}/tst1.bsh.csv.gz`,
    `GET ${exports}/tst1.bsg.csv.gz`,
  ]);

  // Looking again, the files are those the pack was made from.
  const again = await ask<PackOfferResult>(window, 'describePackArchive', 'tst1');
  if (!again.ok) throw new Error(again.message);
  expect(again.offer.installed).toBe('current');
  const asked = await askedOfInternet(app);
  expect(asked.slice(8)).toEqual([
    `GET ${site}/datasets/tst1`,
    `HEAD ${exports}/tst1.bsh.csv.gz`,
    `HEAD ${exports}/tst1.bsg.csv.gz`,
  ]);

  // An archive that was not looked at cannot be installed.
  const unlooked = await ask<PackActionResult>(window, 'installPackArchive', 'tst2');
  expect(unlooked.ok).toBe(false);
});
