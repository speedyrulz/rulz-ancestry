import type { ElectronApplication } from '@playwright/test';
import { addPerson, createTree, expect, openPerson, test } from './fixtures';

/** A profile as WikiTree gives it. The people are made up. */
function profile(number: number, extra: object = {}) {
  return {
    Id: number,
    Name: `Marsh-${90000 + number}`,
    FirstName: 'Josiah',
    MiddleName: '',
    RealName: 'Josiah',
    LastNameAtBirth: 'Marsh',
    LastNameCurrent: 'Marsh',
    Suffix: '',
    BirthDate: '1850-03-12',
    DeathDate: '1912-00-00',
    BirthLocation: 'Ashford, Vermont',
    DeathLocation: '',
    Gender: 'Male',
    IsLiving: 0,
    Privacy: 60,
    DataStatus: { BirthDate: 'certain', DeathDate: 'guess' },
    ...extra,
  };
}

/**
 * Makes the app's requests to the internet answer as WikiTree would, the first four
 * results and then the rest of `total`, and notes every address asked for. With
 * `busy`, the answer is "too many requests". The Library of Congress answers with
 * one page of a newspaper and the Internet Archive with one book, both made up.
 * Open Archives answers with a marriage record of 1872 and one of 1990, and
 * Wikidata with one person who died in 1912 and one born in 1985.
 * The tests never reach any of them.
 */
async function answerSearches(
  app: ElectronApplication,
  total: number,
  busy = false,
): Promise<void> {
  const first = [
    profile(1),
    profile(2, { RealName: '<img src=x onerror=alert(1)>', BirthLocation: '' }),
    // A private profile, and one of a living person: neither is shown.
    profile(3, { Privacy: 20 }),
    profile(4, { IsLiving: 1 }),
  ];
  const second = [profile(21, { RealName: 'Later' })];
  await app.evaluate(
    ({ net, session }, served) => {
      const asked: string[] = [];
      (globalThis as unknown as { askedOfInternet: string[] }).askedOfInternet = asked;
      // Anything the app asks for by another way than its search is a mistake of the test.
      net.fetch = (input) => {
        asked.push(`unexpected: ${typeof input === 'string' ? input : input.url}`);
        return Promise.resolve(new Response('', { status: 500 }));
      };
      const keys: string[] = [];
      (globalThis as unknown as { keysSent: string[] }).keysSent = keys;
      session.fromPartition('records').fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        // Whatever comes in the header for a key, to see where a key goes.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers['x-api-key'] !== undefined)
          keys.push(`${new URL(url).host} ${headers['x-api-key']}`);
        if (served.busy) {
          return Promise.resolve(
            new Response('slow down', { status: 429, headers: { 'retry-after': '600' } }),
          );
        }
        const host = new URL(url).host;
        if (host === 'api.openarchieven.nl') {
          const record = (number: number, year: number, role: string) => ({
            pid: `Person${number}`,
            identifier: `REC-${number}`,
            archive_code: 'exa',
            archive: 'Example Municipal Archive',
            personname: 'Josiah Marsh',
            relationtype: role,
            eventtype: 'Marriage',
            eventdate: { day: 21, month: 5, year },
            eventplace: ['Voorbeeldstad'],
            sourcetype: 'Civil registration marriages',
          });
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: {
                  number_found: 2,
                  docs: [record(1, 1872, 'Groom'), record(2, 1990, 'Witness')],
                },
              }),
            ),
          );
        }
        if (host === 'query.wikidata.org') {
          const entry = (id: string, birth: string, death?: string) => ({
            item: { type: 'uri', value: `http://www.wikidata.org/entity/${id}` },
            name: { type: 'literal', value: 'Josiah Marsh' },
            description: { type: 'literal', value: 'surveyor' },
            birth: { type: 'literal', value: birth },
            birthPrecision: { type: 'literal', value: '11' },
            birthLatest: { type: 'literal', value: birth.slice(0, 4) },
            ...(death === undefined
              ? {}
              : {
                  death: { type: 'literal', value: death },
                  deathPrecision: { type: 'literal', value: '9' },
                }),
          });
          return Promise.resolve(
            new Response(
              JSON.stringify({
                results: {
                  bindings: [
                    entry('Q90001', '1850-03-12T00:00:00Z', '1912-01-01T00:00:00Z'),
                    entry('Q90002', '1985-06-01T00:00:00Z'),
                  ],
                },
              }),
            ),
          );
        }
        if (host === 'catalog.archives.gov') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                statusCode: 200,
                body: {
                  hits: {
                    total: { value: 1 },
                    hits: [
                      {
                        _source: {
                          record: {
                            naId: 90000001,
                            title: 'Pension file of Josiah Marsh',
                            levelOfDescription: 'fileUnit',
                            coverageStartDate: { year: 1862 },
                            coverageEndDate: { year: 1912 },
                          },
                        },
                      },
                    ],
                  },
                },
              }),
            ),
          );
        }
        if (host === 'www.loc.gov') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                pagination: { current: 1, of: 1, next: null },
                results: [
                  {
                    id: 'http://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
                    title: 'Image 8 of The Ashford gazette (Ashford, Vt.), May 1, 1903',
                    date: '1903-05-01',
                  },
                ],
              }),
            ),
          );
        }
        if (host === 'archive.org') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: {
                  numFound: 1,
                  start: 0,
                  docs: [
                    {
                      identifier: 'marshfamily00exam',
                      title: 'Marsh family.',
                      creator: 'Fenwick, Henrietta.',
                      year: 1930,
                    },
                  ],
                },
              }),
            ),
          );
        }
        const start = Number(new URL(url).searchParams.get('start') ?? '0');
        const matches = start === 0 ? served.first : served.second;
        return Promise.resolve(
          new Response(JSON.stringify([{ status: 0, matches, total: served.total, start }])),
        );
      };
    },
    { first, second, total, busy },
  );
}

function askedOfInternet(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { askedOfInternet?: string[] }).askedOfInternet ?? [],
  );
}

test('searches WikiTree for a person, after saying what is sent', async ({ app, window }) => {
  await answerSearches(app, 5);
  await createTree(window, 'Records');
  await addPerson(window, {
    given: 'Josiah',
    surname: 'Marsh',
    birthDate: '12 MAR 1850',
    deathDate: 'ABT 1912',
  });

  // The first time, the app says what a search sends. Nothing is sent meanwhile.
  await window.getByTestId('open-records').click();
  const dialog = window.getByTestId('record-search');
  await expect(dialog).toContainText('Search records for Josiah Marsh');
  await expect(window.getByTestId('record-search-notice')).toContainText('WikiTree');
  await expect(window.getByTestId('record-search-go')).toHaveCount(0);
  await window.getByTestId('record-agree').click();

  // The form starts with the person's name and years, and still nothing is sent.
  await expect(window.getByTestId('record-given')).toHaveValue('Josiah');
  await expect(window.getByTestId('record-surname')).toHaveValue('Marsh');
  await expect(window.getByTestId('record-birth')).toHaveValue('1850');
  await expect(window.getByTestId('record-death')).toHaveValue('1912');
  // The form says which service is sent what.
  const asks = window.getByTestId('record-person-asks');
  await expect(asks).toContainText('WikiTree: the given name, the last name and the years');
  await expect(asks).toContainText('Open Archives');
  await expect(asks).toContainText('Wikidata: the given name and the last name, not the years');
  expect(await askedOfInternet(app)).toEqual([]);

  // A year that is none is not sent.
  await window.getByTestId('record-death').fill('19x2');
  await expect(window.getByTestId('record-search-go')).toBeDisabled();
  await window.getByTestId('record-death').fill('');

  await window.getByTestId('record-search-go').click();
  const results = window.getByTestId('records-wikitree');
  await expect(results.getByTestId('record-total')).toHaveText('5 results');
  await expect(results.getByTestId('record-result')).toHaveCount(2);
  const one = results.getByTestId('record-result').first();
  await expect(one).toContainText('Josiah Marsh');
  await expect(one).toContainText('Born 12 March 1850, Ashford, Vermont');
  await expect(one).toContainText('Died about 1912');
  await expect(one.getByTestId('record-link')).toHaveAttribute(
    'href',
    'https://www.wikitree.com/wiki/Marsh-90001',
  );
  // What a source sends is shown as text, never as a page of its own.
  await expect(results.getByTestId('record-result').nth(1)).toContainText(
    '<img src=x onerror=alert(1)> Marsh',
  );
  await expect(results.locator('img')).toHaveCount(0);
  await expect(results.getByTestId('record-hidden')).toContainText('2 results are not shown');
  await expect(results).toContainText('Profile data from WikiTree');

  // One request went out to each of the three. WikiTree's has the name and the year and nothing else.
  const asked = await askedOfInternet(app);
  expect(asked).toHaveLength(3);
  const url = new URL(asked.find((address) => address.includes('api.wikitree.com')) ?? '');
  expect(url.origin + url.pathname).toBe('https://api.wikitree.com/api.php');
  expect(url.searchParams.get('FirstName')).toBe('Josiah');
  expect(url.searchParams.get('LastName')).toBe('Marsh');
  expect(url.searchParams.get('BirthDate')).toBe('1850');
  expect(url.searchParams.has('DeathDate')).toBe(false);
  expect([...url.searchParams.keys()].sort()).toEqual(
    [
      'BirthDate',
      'FirstName',
      'LastName',
      'action',
      'appId',
      'dateSpread',
      'fields',
      'limit',
      'start',
    ].sort(),
  );

  // More results are added to the list.
  await results.getByTestId('record-more').click();
  await expect(results.getByTestId('record-result')).toHaveCount(3);
  await expect(results.getByTestId('record-result').nth(2)).toContainText('Later Marsh');
  await expect(results.getByTestId('record-more')).toHaveCount(0);

  // A record of an archive names the person in a role. One of 1990 is not shown:
  // those it names may be living.
  const archive = window.getByTestId('records-open-archives');
  await expect(archive.getByTestId('record-result')).toHaveCount(1);
  await expect(archive.getByTestId('record-event')).toHaveText(
    'Groom in: Marriage, 21 May 1872, Voorbeeldstad',
  );
  await expect(archive).toContainText('Civil registration marriages, Example Municipal Archive');
  await expect(archive.getByTestId('record-hidden')).toContainText('1 result is not shown');
  await expect(archive.getByTestId('record-link')).toHaveAttribute(
    'href',
    'https://www.openarchieven.nl/exa:REC-1/en',
  );
  // An entry of Wikidata comes with a few words about the person, and without the living.
  const entries = window.getByTestId('records-wikidata');
  await expect(entries.getByTestId('record-result')).toHaveCount(1);
  await expect(entries.getByTestId('record-about')).toHaveText('surveyor');
  await expect(entries).toContainText('Died 1912');
  await expect(entries.getByTestId('record-hidden')).toContainText('1 result is not shown');

  // One request to each of the three, and one for more at WikiTree.
  const requests = (await askedOfInternet(app)).map((address) => new URL(address));
  expect(requests.map((url) => url.host).sort()).toEqual([
    'api.openarchieven.nl',
    'api.wikitree.com',
    'api.wikitree.com',
    'query.wikidata.org',
  ]);
  const archiveAsked = requests.find((url) => url.host === 'api.openarchieven.nl');
  expect(archiveAsked?.searchParams.get('name')).toMatch(/^Josiah Marsh \d{4}-\d{4}$/);

  // Nothing was added to the tree.
  await window.getByTestId('record-search-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add person (Ctrl+Z)');

  // The notice is shown once: the form opens at once the next time.
  await window.getByTestId('open-records').click();
  await expect(window.getByTestId('record-given')).toHaveValue('Josiah');
  await window.getByTestId('record-search-close').click();
});

test('does not search for a person who may be living, and waits when a source asks it to', async ({
  app,
  window,
}) => {
  await answerSearches(app, 0, true);
  await createTree(window, 'Living');
  await addPerson(window, { given: 'Rita', surname: 'Marsh', birthDate: '1990' });
  await addPerson(window, { given: 'Josiah', surname: 'Marsh', birthDate: '1850' });

  await openPerson(window, 'Rita');
  await window.getByTestId('open-records').click();
  await expect(window.getByTestId('record-search-living')).toContainText('may be living');
  await expect(window.getByTestId('record-agree')).toHaveCount(0);
  await expect(window.getByTestId('record-search-go')).toHaveCount(0);
  await window.getByTestId('record-search-close').click();

  await openPerson(window, 'Josiah');
  await window.getByTestId('open-records').click();
  await window.getByTestId('record-agree').click();
  await window.getByTestId('record-search-go').click();
  await expect(window.getByTestId('records-wikitree').getByTestId('record-problem')).toContainText(
    'asks to be left alone for a while. It can be asked again at',
  );
  // A second try is not sent at all.
  await window.getByTestId('record-search-go').click();
  await expect(window.getByTestId('records-wikitree').getByTestId('record-problem')).toContainText(
    'It can be asked again at',
  );
  expect(await askedOfInternet(app)).toHaveLength(3);
});

/** Keeps the app from opening the browser, and notes every address it would have opened. */
async function catchBrowser(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { openedInBrowser: string[] }).openedInBrowser = opened;
    shell.openExternal = (url) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
}

function openedInBrowser(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { openedInBrowser?: string[] }).openedInBrowser ?? [],
  );
}

test('attaches a result as a source, opens a search in the browser, and cites a pasted address', async ({
  app,
  window,
}) => {
  await answerSearches(app, 2);
  await catchBrowser(app);
  await createTree(window, 'Attach');
  await addPerson(window, {
    given: 'Josiah',
    surname: 'Marsh',
    birthDate: '12 MAR 1850',
    deathDate: 'ABT 1912',
  });

  await window.getByTestId('open-records').click();
  // The notice names the sites a search is opened at in the browser, too.
  await expect(window.getByTestId('record-search-notice')).toContainText('Find a Grave');
  await window.getByTestId('record-agree').click();
  await window.getByTestId('record-search-go').click();
  const results = window.getByTestId('records-wikitree');
  await expect(results.getByTestId('record-result')).toHaveCount(2);

  // One click attaches a result, and one Undo would take it back.
  const one = results.getByTestId('record-result').first();
  await one.getByTestId('record-attach').click();
  await expect(one.getByTestId('record-attached')).toBeVisible();
  await expect(one.getByTestId('record-attach')).toHaveCount(0);
  await expect(results.getByTestId('record-attach')).toHaveCount(1);
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Attach record (Ctrl+Z)');
  expect(await askedOfInternet(app)).toHaveLength(3);

  // A search at a site the app never asks goes to the browser, and nowhere else.
  await window.getByTestId('record-open-find-a-grave').click();
  await expect.poll(() => openedInBrowser(app)).toHaveLength(1);
  const opened = new URL((await openedInBrowser(app))[0] ?? '');
  expect(opened.origin + opened.pathname).toBe('https://www.findagrave.com/memorial/search');
  expect(opened.searchParams.get('firstname')).toBe('Josiah');
  expect(opened.searchParams.get('lastname')).toBe('Marsh');
  expect(opened.searchParams.get('birthyear')).toBe('1850');
  expect(await askedOfInternet(app)).toHaveLength(3);

  // A page found there is cited by its address. The app does not ask for the page.
  await window.getByTestId('record-clip-find-a-grave').click();
  const clip = window.getByTestId('clip-dialog');
  await expect(clip.getByTestId('citation-mode-site')).toBeChecked();
  await expect(clip.getByTestId('citation-accessed')).not.toHaveValue('');
  await expect(clip.getByTestId('citation-submit')).toBeDisabled();
  await clip.getByTestId('citation-url').fill('findagrave.com/memorial/1');
  await expect(clip.getByTestId('citation-url-problem')).toBeVisible();
  await expect(clip.getByTestId('citation-submit')).toBeDisabled();
  await clip.getByTestId('citation-url').fill('https://www.findagrave.com/memorial/1/josiah-marsh');
  await clip.getByTestId('citation-page').fill('Memorial 1');
  await clip.getByTestId('citation-submit').click();
  await expect(clip).toHaveCount(0);
  expect(await askedOfInternet(app)).toHaveLength(3);
  expect(await openedInBrowser(app)).toHaveLength(1);

  await window.getByTestId('record-search-close').click();
  const cited = window.getByTestId('person-citation');
  await expect(cited).toHaveCount(2);
  await expect(cited.nth(0)).toContainText('WikiTree');
  await expect(cited.nth(0)).toContainText('Josiah Marsh (Marsh-90001)');
  await expect(cited.nth(0)).toContainText('Born 12 March 1850, Ashford, Vermont');
  await expect(cited.nth(0).getByTestId('citation-address').locator('a')).toHaveAttribute(
    'href',
    'https://www.wikitree.com/wiki/Marsh-90001',
  );
  await expect(cited.nth(1)).toContainText('Find a Grave');
  await expect(cited.nth(1)).toContainText('Memorial 1');
  await expect(cited.nth(1)).toContainText('https://www.findagrave.com/memorial/1/josiah-marsh');

  // The next search says at once which result the page of the person cites already.
  await window.getByTestId('open-records').click();
  await window.getByTestId('record-search-go').click();
  await expect(window.getByTestId('records-wikitree').getByTestId('record-attached')).toHaveCount(
    1,
  );
  await window.getByTestId('record-search-close').click();
});

test('searches newspapers and books for words, and attaches a page of a newspaper', async ({
  app,
  window,
}) => {
  await answerSearches(app, 2);
  await createTree(window, 'Texts');
  await addPerson(window, {
    given: 'Josiah',
    surname: 'Marsh',
    birthDate: '12 MAR 1850',
    deathDate: 'ABT 1912',
  });

  await window.getByTestId('open-records').click();
  // The notice says what each service is sent.
  const sources = window.getByTestId('record-notice-sources');
  await expect(sources).toContainText('WikiTree: the given name, the last name and the years');
  await expect(sources).toContainText('Library of Congress');
  await expect(sources).toContainText('Internet Archive: the words only');
  await window.getByTestId('record-agree').click();

  // The form starts with the name as a phrase, from the birth to the year after the death.
  await expect(window.getByTestId('record-words')).toHaveValue('Josiah Marsh');
  await expect(window.getByTestId('record-phrase')).toBeChecked();
  await expect(window.getByTestId('record-from')).toHaveValue('1850');
  await expect(window.getByTestId('record-to')).toHaveValue('1913');
  await expect(window.getByTestId('record-text-sends')).toContainText('Internet Archive');
  expect(await askedOfInternet(app)).toEqual([]);

  // Years that do not fit are said so, and nothing can be sent.
  await window.getByTestId('record-from').fill('1950');
  await expect(window.getByTestId('record-text-problem')).toBeVisible();
  await expect(window.getByTestId('record-text-go')).toBeDisabled();
  await window.getByTestId('record-from').fill('1850');
  await window.getByTestId('record-state').selectOption('Vermont');

  await window.getByTestId('record-text-go').click();
  const newspapers = window.getByTestId('records-loc');
  const books = window.getByTestId('records-internet-archive');
  await expect(newspapers.getByTestId('record-result')).toHaveCount(1);
  await expect(newspapers).toContainText('Image 8 of The Ashford gazette');
  await expect(newspapers.getByTestId('record-print')).toHaveText('published 1 May 1903');
  await expect(newspapers.getByTestId('record-link')).toHaveAttribute(
    'href',
    'https://www.loc.gov/resource/sn99000001/1903-05-01/ed-1/?sp=8',
  );
  await expect(books.getByTestId('record-result')).toHaveCount(1);
  await expect(books.getByTestId('record-print')).toHaveText('Fenwick, Henrietta., published 1930');

  // Two requests: one to each, and none to the source that keeps people.
  const asked = (await askedOfInternet(app)).map((address) => new URL(address));
  expect(asked.map((url) => url.host).sort()).toEqual(['archive.org', 'www.loc.gov']);
  const library = asked.find((url) => url.host === 'www.loc.gov');
  expect(library?.searchParams.get('qs')).toBe('Josiah Marsh');
  expect(library?.searchParams.get('start_date')).toBe('1850-01-01');
  expect(library?.searchParams.get('end_date')).toBe('1913-12-31');
  expect(library?.searchParams.get('location_state')).toBe('vermont');
  await expect(window.getByTestId('records-wikitree')).toHaveCount(0);

  await newspapers.getByTestId('record-attach').click();
  await expect(newspapers.getByTestId('record-attached')).toBeVisible();
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Attach record (Ctrl+Z)');
  expect(await askedOfInternet(app)).toHaveLength(2);

  await window.getByTestId('record-search-close').click();
  const cited = window.getByTestId('person-citation');
  await expect(cited).toHaveCount(1);
  await expect(cited).toContainText('Library of Congress');
  await expect(cited).toContainText('Image 8 of The Ashford gazette');
  await expect(cited).toContainText('Published 1 May 1903');
});

test('takes a key for the National Archives, keeps it out of sight, and searches with it', async ({
  app,
  window,
}) => {
  // A key that is none, made for this test.
  const key = 'test-key-0123456789abcdef';
  await answerSearches(app, 2);
  await createTree(window, 'Archives');
  await addPerson(window, {
    given: 'Josiah',
    surname: 'Marsh',
    birthDate: '12 MAR 1850',
    deathDate: 'ABT 1912',
  });

  await window.getByTestId('open-records').click();
  // The notice says that the key goes to the Archives, and what it tells them.
  await expect(window.getByTestId('record-notice-sources')).toContainText(
    'US National Archives Catalog: the words only, and your own key',
  );
  await window.getByTestId('record-agree').click();

  // Without a key the Archives are not asked.
  const box = window.getByTestId('record-key-nara-catalog');
  await expect(box).toContainText('needs a key of your own');
  await expect(box.getByTestId('record-key-save')).toBeDisabled();
  await window.getByTestId('record-text-go').click();
  const archives = window.getByTestId('records-nara-catalog');
  await expect(archives.getByTestId('record-problem')).toContainText('needs your own key');
  expect((await askedOfInternet(app)).some((address) => address.includes('archives.gov'))).toBe(
    false,
  );

  // A key that is too short to be one cannot be saved.
  await box.getByTestId('record-key-input').fill('short');
  await expect(box.getByTestId('record-key-save')).toBeDisabled();
  // The key is typed into a field that does not show it.
  await expect(box.getByTestId('record-key-input')).toHaveAttribute('type', 'password');
  await box.getByTestId('record-key-input').fill(key);
  await box.getByTestId('record-key-save').click();
  await expect(box.getByTestId('record-key-state')).toContainText('A key is saved');
  await expect(box.getByTestId('record-key-input')).toHaveCount(0);
  // Nothing on the page holds the key now, and saving it asked nobody.
  expect(await window.content()).not.toContain(key);
  expect(await keysSent(app)).toEqual([]);

  await window.getByTestId('record-text-go').click();
  await expect(archives.getByTestId('record-result')).toHaveCount(1);
  await expect(archives).toContainText('Pension file of Josiah Marsh');
  await expect(archives.getByTestId('record-print')).toContainText('File unit');
  await expect(archives.getByTestId('record-print')).toContainText('1862');
  // The sentence the Archives ask every app to show.
  await expect(archives).toContainText(
    'not endorsed or certified by the National Archives and Records Administration',
  );
  await expect(box.getByTestId('record-quota')).toContainText('Asked 1 of 9,000 times this month');

  // The key went to the Archives, in its header, and to nobody else and in no address.
  expect(await keysSent(app)).toEqual([`catalog.archives.gov ${key}`]);
  expect((await askedOfInternet(app)).some((address) => address.includes(key))).toBe(false);
  expect(await window.content()).not.toContain(key);

  // A description is cited by its identifier and address: the Archives ask that nothing they send is kept.
  await archives.getByTestId('record-attach').click();
  await expect(archives.getByTestId('record-attached')).toBeVisible();

  // Removing the key brings the field back.
  await box.getByTestId('record-key-remove').click();
  await expect(box.getByTestId('record-key-input')).toBeVisible();

  await window.getByTestId('record-search-close').click();
  const cited = window.getByTestId('person-citation');
  await expect(cited).toHaveCount(1);
  await expect(cited).toContainText('US National Archives Catalog');
  await expect(cited).toContainText('Identifier 90000001');
  await expect(cited).not.toContainText('Pension file');
});

function keysSent(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { keysSent?: string[] }).keysSent ?? []);
}
