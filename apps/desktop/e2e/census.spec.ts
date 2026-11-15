import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { CENSUS_LISTING_URL, censusStateUrl } from '@rulz/connectors';
import { CENSUS_FIXTURES, TINY_JPEG } from '../src/main/censusfixtures';
import type {
  CensusCountiesResult,
  CensusDistrictResult,
  CensusDistrictsResult,
  CensusPageImageResult,
  CensusStatesResult,
  PackActionResult,
  PacksState,
  PersonPage,
  AttachRecordResult,
} from '../src/shared/ipc';
import { addPerson, createTree, expect, test } from './fixtures';

/**
 * Installs a state of the 1950 census from a made-up bucket, browses it by
 * county and district through the bridge, views one page image (fetched when
 * asked, never stored) and cites it for a person. `net.fetch` of the main
 * process is replaced, so nothing reaches the real bucket, and every request
 * is kept so that the test can say exactly what the app asked.
 */

/** The bridge as the page has it: each call answers with a result that is ok, or says why not. */
type Bridge = Record<
  string,
  (argument?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>
>;

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

async function pretendBucket(
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
        const headers = {
          'content-length': String(bytes.length),
          etag: file.etag,
          'content-type': 'binary/octet-stream',
        };
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

test('installs a state of the census from a made-up bucket, browses it, views a page and cites it', async ({
  app,
  window,
}) => {
  test.setTimeout(120_000);
  const state = readFileSync(join(CENSUS_FIXTURES, 'state-sample.json'));
  const page2 =
    'https://nara-1950-census.s3.us-east-2.amazonaws.com/1950census/10-Testland/10-Testland-000101/10-Testland-000101-0002.jpg';
  const listing = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>metadata/json/de.json</Key><LastModified>2022-04-01T09:00:00.000Z</LastModified><ETag>&quot;census-de-1&quot;</ETag><Size>${state.length}</Size></Contents></ListBucketResult>`;
  await pretendBucket(
    app,
    { [CENSUS_LISTING_URL]: listing },
    {
      [censusStateUrl('de')]: { base64: state.toString('base64'), etag: '"census-de-1"' },
      [page2]: { base64: Buffer.from(TINY_JPEG).toString('base64'), etag: '"img-1"' },
    },
  );
  await createTree(window, 'Census');
  await addPerson(window, {
    given: 'Tobias',
    surname: 'Baker',
    birthDate: '1860',
    deathDate: '1930',
  });
  const people = await ask<{ persons: { id: string }[] }>(window, 'listPersons', {
    query: '',
    offset: 0,
    limit: 10,
  });
  const personId = people.persons[0]?.id ?? '';

  // Nothing is asked before the user asks.
  expect(await askedOfInternet(app)).toEqual([]);

  const listed = await ask<CensusStatesResult>(window, 'listCensusStates');
  if (!listed.ok) throw new Error(listed.message);
  expect(
    listed.states.map((entry) => [entry.code, entry.name, entry.bytes, entry.installed]),
  ).toEqual([['de', 'Delaware', state.length, 'no']]);

  expect(await ask<PackActionResult>(window, 'installCensusState', 'de')).toEqual({ ok: true });
  await expect
    .poll(
      async () => {
        const packs = await ask<PacksState>(window, 'getPacks');
        if (packs.job?.phase === 'failed') throw new Error(packs.job.message ?? 'the job failed');
        return packs.packs.map((pack) => `${pack.id} ${pack.state}`);
      },
      { timeout: 90_000 },
    )
    .toEqual(['c50de ready']);
  const packs = await ask<PacksState>(window, 'getPacks');
  expect(packs.packs[0]).toMatchObject({
    id: 'c50de',
    kind: 'nara-1950-areas',
    title: '1950 census: Delaware',
    licence: 'Public domain (US Government work)',
    sourceModified: '2022-04-01',
  });

  // A pack of the census is browsed, and is no source of the search for a person.
  const setup = await ask<{ sources: { id: string }[]; links: { id: string }[] }>(
    window,
    'getRecordSearch',
    personId,
  );
  expect(setup.sources.map((source) => source.id)).not.toContain('pack:c50de');
  expect(setup.links.map((link) => link.id)).toContain('nara-1950-search');

  // Browsing goes through the search worker of the built app, and asks nobody.
  const counties = await ask<CensusCountiesResult>(window, 'censusCounties', 'c50de');
  expect(counties).toEqual({
    ok: true,
    counties: [
      { name: 'Alder County', districts: 2 },
      { name: 'Birch County', districts: 1 },
      { name: 'Cedar City', districts: 1 },
    ],
  });
  const districts = await ask<CensusDistrictsResult>(window, 'censusDistricts', {
    packId: 'c50de',
    county: 'Alder County',
    filter: 'school',
    offset: 0,
  });
  if (!districts.ok) throw new Error(districts.message);
  expect(districts.districts.map((entry) => [entry.id, entry.ed, entry.pages])).toEqual([
    [1, '1-1', 3],
  ]);
  const generation = districts.districts[0]?.generation ?? -1;
  const district = await ask<CensusDistrictResult>(window, 'censusDistrict', {
    packId: 'c50de',
    id: 1,
    generation,
  });
  expect(district).toMatchObject({
    ok: true,
    district: { ed: '1-1', roll: 'T628-12', pages: 3, state: 'Testland' },
  });

  // A page image needs the notice; then it is fetched, and only that one.
  const refused = await ask<CensusPageImageResult>(window, 'censusPageImage', {
    packId: 'c50de',
    id: 1,
    generation,
    page: 2,
  });
  expect(refused).toMatchObject({ ok: false, problem: { kind: 'notice' } });
  await ask(window, 'agreeToRecordSearch');
  const image = await ask<CensusPageImageResult>(window, 'censusPageImage', {
    packId: 'c50de',
    id: 1,
    generation,
    page: 2,
  });
  if (!image.ok) throw new Error(image.problem.message);
  expect(Object.values(image.bytes as unknown as object)).toEqual([...TINY_JPEG]);
  expect([image.page, image.pages]).toEqual([2, 3]);

  // Only the page shown can be cited.
  const wrong = await ask<AttachRecordResult>(window, 'citeCensusPage', {
    packId: 'c50de',
    id: 1,
    generation,
    page: 1,
    personId,
  });
  expect(wrong).toMatchObject({ ok: false, problem: { kind: 'record' } });
  const cited = await ask<AttachRecordResult>(window, 'citeCensusPage', {
    packId: 'c50de',
    id: 1,
    generation,
    page: 2,
    personId,
  });
  expect(cited).toMatchObject({ ok: true, added: true });
  const personPage = await ask<PersonPage>(window, 'getPersonPage', personId);
  expect(personPage.citations).toHaveLength(1);
  expect(personPage.citations[0]).toMatchObject({
    sourceTitle: '1950 US Census (National Archives)',
    page: 'Testland, Alder County, ED 1-1, image 2 of 3, roll T628-12',
    url: page2,
  });

  // The app asked exactly this: the listing, the size and the file of the
  // state, and the one page image. Browsing and citing asked nothing.
  expect(await askedOfInternet(app)).toEqual([
    `GET ${CENSUS_LISTING_URL}`,
    `HEAD ${censusStateUrl('de')}`,
    `GET ${censusStateUrl('de')}`,
    `GET ${page2}`,
  ]);
});
