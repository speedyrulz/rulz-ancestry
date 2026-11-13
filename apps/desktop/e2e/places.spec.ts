import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { ElectronApplication, Page } from '@playwright/test';
import { addPerson, createTree, expect, launchApp, test } from './fixtures';

/** One line of a GeoNames list of places: nineteen columns with tabs between them. */
function line(fields: {
  id: number;
  name: string;
  lat: number;
  lon: number;
  fclass?: string;
  fcode?: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  population?: number;
}): string {
  return [
    fields.id,
    fields.name,
    fields.name,
    '',
    fields.lat,
    fields.lon,
    fields.fclass ?? 'P',
    fields.fcode ?? 'PPL',
    fields.country ?? 'US',
    '',
    fields.admin1 ?? '',
    fields.admin2 ?? '',
    '',
    '',
    fields.population ?? 0,
    '',
    '',
    'UTC',
    '2024-01-01',
  ].join('\t');
}

/** A zip archive that holds one deflated file. */
function zipOf(name: string, text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  const packed = deflateRawSync(data);
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + packed.length, 16);
  return Buffer.concat([local, nameBytes, packed, central, nameBytes, end]);
}

/** How many made-up villages the sample holds; the app refuses a list of fewer than 100,000 places. */
const VILLAGES = 100_000;

/** The files GeoNames would send, small but complete, by name and in base64. */
function sampleFiles(): Record<string, string> {
  const us = [
    line({
      id: 4250542,
      name: 'Springfield',
      fcode: 'PPLA',
      admin1: 'IL',
      admin2: '167',
      lat: 39.80172,
      lon: -89.64371,
      population: 114394,
    }),
    line({
      id: 4409896,
      name: 'Springfield',
      fcode: 'PPLA2',
      admin1: 'MO',
      admin2: '077',
      lat: 37.21533,
      lon: -93.29824,
      population: 170188,
    }),
    line({
      id: 4250165,
      name: 'Sangamon County',
      fclass: 'A',
      fcode: 'ADM2',
      admin1: 'IL',
      admin2: '167',
      lat: 39.75817,
      lon: -89.65889,
      population: 194672,
    }),
  ];
  for (let index = 1; index <= VILLAGES; index += 1) {
    us.push(
      line({
        id: 9_000_000 + index,
        name: `Testville ${index}`,
        admin1: 'MO',
        admin2: '077',
        lat: 37,
        lon: -93,
      }),
    );
  }
  // The app refuses lists of names that look cut short, so these are as long as the real ones.
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const countries = [
    '# ISO\tISO3\tISO-Numeric\tfips\tCountry',
    'US\tUSA\t840\tUS\tUnited States',
    'GB\tGBR\t826\tUK\tUnited Kingdom',
  ];
  for (let index = 0; index < 250; index += 1) {
    const code = `${letters[Math.floor(index / 26)]}${letters[index % 26]}`;
    countries.push(`${code}\tXXX\t0\tXX\tTestland ${index}`);
  }
  const states = [
    'US.IL\tIllinois\tIllinois\t1',
    'US.MO\tMissouri\tMissouri\t2',
    'GB.ENG\tEngland\tEngland\t3',
  ];
  for (let index = 0; index < 3000; index += 1)
    states.push(`XA.${index}\tTest state ${index}\tTest state ${index}\t0`);
  const counties = [
    'US.IL.167\tSangamon County\tSangamon County\t4',
    'US.MO.077\tGreene County\tGreene County\t5',
  ];
  for (let index = 0; index < 30_000; index += 1)
    counties.push(`XA.1.${index}\tTest county ${index}\tTest county ${index}\t0`);
  const one = (country: string, id: number) =>
    line({ id, name: `Capital of ${country}`, country, lat: 1, lon: 1, population: 1000 });
  const files: Record<string, Buffer> = {
    'countryInfo.txt': Buffer.from(countries.join('\n')),
    'admin1CodesASCII.txt': Buffer.from(states.join('\n')),
    'admin2Codes.txt': Buffer.from(counties.join('\n')),
    'US.zip': zipOf('US.txt', us.join('\n')),
    'NL.zip': zipOf('NL.txt', one('NL', 1)),
    'GB.zip': zipOf('GB.txt', one('GB', 2)),
    'IE.zip': zipOf('IE.txt', one('IE', 3)),
    'AU.zip': zipOf('AU.txt', one('AU', 4)),
    'NZ.zip': zipOf('NZ.txt', one('NZ', 5)),
    'cities500.zip': zipOf(
      'cities500.txt',
      line({
        id: 2633352,
        name: 'York',
        fcode: 'PPLA2',
        country: 'GB',
        admin1: 'ENG',
        lat: 53.95763,
        lon: -1.08271,
        population: 156135,
      }),
    ),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, bytes.toString('base64')]),
  );
}

/**
 * Makes the app's requests to the internet answer from `files`, and notes
 * every address asked for. `failing` names a file that is answered with
 * "not found". The tests never reach GeoNames itself.
 */
async function answerDownloads(
  app: ElectronApplication,
  files: Record<string, string>,
  failing: string | null = null,
): Promise<void> {
  await app.evaluate(
    ({ net }, { files: served, failing: broken }) => {
      const asked: string[] = [];
      (globalThis as unknown as { askedOfInternet: string[] }).askedOfInternet = asked;
      net.fetch = (input) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        const name = url.slice(url.lastIndexOf('/') + 1);
        const encoded = served[name];
        if (encoded === undefined || name === broken) {
          return Promise.resolve(new Response('not found', { status: 404 }));
        }
        const bytes = Buffer.from(encoded, 'base64');
        return Promise.resolve(
          new Response(new Uint8Array(bytes), {
            headers: { 'content-length': String(bytes.length) },
          }),
        );
      };
    },
    { files, failing },
  );
}

function askedOfInternet(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { askedOfInternet?: string[] }).askedOfInternet ?? [],
  );
}

function placeRow(window: Page, text: string) {
  return window.getByTestId('place-row').filter({ hasText: text });
}

test('offers places while typing, downloads the place list and links places to it', async ({
  app,
  window,
  appTarget,
  userDataDir,
}) => {
  test.setTimeout(120_000);
  const files = sampleFiles();
  await answerDownloads(app, files, 'NL.zip');
  await createTree(window, 'Places');
  await addPerson(window, {
    given: 'Ann',
    surname: 'Lee',
    birthDate: '1900',
    birthPlace: 'Springfield, Sangamon, Illinois, USA',
  });

  // Before any download: a place the tree already has is offered, and nothing else.
  await window.getByTestId('add-event').click();
  await window.getByTestId('event-place').pressSequentially('spring');
  const offers = window.getByTestId('event-place-offers');
  await expect(offers.getByTestId('place-offer')).toHaveCount(1);
  await expect(offers.getByTestId('place-offer')).toContainText(
    'Springfield, Sangamon, Illinois, USA',
  );
  await expect(offers.getByTestId('place-offer')).toContainText('In this tree, 1 event');
  await expect(offers.getByTestId('place-offers-hint')).toContainText('download the place list');
  // Escape puts the offers away and leaves the form open.
  await window.getByTestId('event-place').press('Escape');
  await expect(offers).toHaveCount(0);
  await expect(window.getByTestId('event-dialog')).toBeVisible();
  await window.getByTestId('event-place').press('Escape');
  await expect(window.getByTestId('event-dialog')).toHaveCount(0);
  expect(await askedOfInternet(app)).toEqual([]);

  // The Places window lists the tree's places and says the list is not there.
  await window.getByTestId('open-places').click();
  await expect(window.getByTestId('gazetteer-absent')).toContainText('downloads once');
  await expect(window.getByTestId('places-count')).toContainText('1 place, 0 linked');
  await expect(placeRow(window, 'Springfield, Sangamon')).toContainText('1 event');
  await expect(window.getByTestId('link-place-offer')).toHaveCount(0);

  // A download that fails says why and leaves things as they were.
  await window.getByTestId('gazetteer-download').click();
  await expect(window.getByTestId('gazetteer-error')).toContainText('GeoNames answered 404');
  await expect(window.getByTestId('gazetteer-absent')).toBeVisible();

  // A download that works: every file comes from GeoNames' address, and the list is built.
  await answerDownloads(app, files);
  await window.getByTestId('gazetteer-download').click();
  await expect(window.getByTestId('gazetteer-installed')).toContainText('100,009 places', {
    timeout: 60_000,
  });
  await expect(window.getByTestId('gazetteer-error')).toHaveCount(0);
  const asked = await askedOfInternet(app);
  expect(asked).toHaveLength(10);
  expect(asked.every((url) => url.startsWith('https://download.geonames.org/export/dump/'))).toBe(
    true,
  );
  expect(existsSync(join(userDataDir, 'gazetteer', 'geonames.db'))).toBe(true);
  expect(existsSync(join(userDataDir, 'gazetteer', 'download'))).toBe(false);

  // The tree's place now has an entry offered; one press links it.
  const row = placeRow(window, 'Springfield, Sangamon');
  await expect(row.getByTestId('place-link')).toContainText(
    'Perhaps: Springfield, Sangamon County, Illinois, USA',
  );
  await row.getByTestId('link-place-offer').click();
  await expect(row.getByTestId('place-link')).toContainText(
    'Springfield, Sangamon County, Illinois, USA',
  );
  await expect(row.getByTestId('place-link')).toContainText('39.80° N, 89.64° W');
  await expect(row.getByTestId('place-link')).not.toContainText('Perhaps');
  // The place itself is still written as it was typed.
  await expect(row.getByTestId('place-text')).toHaveText('Springfield, Sangamon, Illinois, USA');
  await expect(window.getByTestId('places-count')).toContainText('1 place, 1 linked');

  // Unlinking, and linking to another entry found by hand.
  await row.getByTestId('unlink-place').click();
  await expect(row.getByTestId('place-link')).toContainText('Perhaps');
  await row.getByTestId('find-place').click();
  await expect(window.getByTestId('link-place-search')).toHaveValue(
    'Springfield, Sangamon, Illinois, USA',
  );
  await window.getByTestId('link-place-search').fill('Springfield, Missouri');
  await expect(window.getByTestId('link-place-result')).toHaveCount(1);
  await expect(window.getByTestId('link-place-result')).toContainText(
    'Springfield, Greene County, Missouri, USA',
  );
  await window.getByTestId('link-place-pick').click();
  await expect(window.getByTestId('link-place-dialog')).toHaveCount(0);
  await expect(row.getByTestId('place-link')).toContainText('Greene County, Missouri');
  await window.getByTestId('places-close').click();
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Link place (Ctrl+Z)');

  // While typing, places from the list are offered after those of the tree.
  await window.getByTestId('add-event').click();
  await window.getByTestId('event-type').selectOption({ label: 'Residence' });
  await window.getByTestId('event-place').pressSequentially('york');
  await expect(offers.getByTestId('place-offer')).toHaveCount(1);
  await expect(offers.getByTestId('place-offer')).toContainText('York, England');
  await expect(offers.getByTestId('place-offer')).toContainText('From GeoNames');
  await expect(offers.getByTestId('place-offers-hint')).toHaveCount(0);
  // Arrow down and Enter take the offer; the form is not sent.
  await window.getByTestId('event-place').press('ArrowDown');
  await window.getByTestId('event-place').press('Enter');
  await expect(window.getByTestId('event-place')).toHaveValue('York, England');
  await expect(window.getByTestId('event-dialog')).toBeVisible();
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('event-dialog')).toHaveCount(0);
  // One step: the event and its link.
  await expect(window.getByTestId('undo')).toHaveAttribute('title', 'Undo Add event (Ctrl+Z)');

  await window.getByTestId('open-places').click();
  await expect(window.getByTestId('places-count')).toContainText('2 places, 2 linked');
  await expect(placeRow(window, 'York, England').getByTestId('place-link')).toContainText(
    '53.96° N, 1.08° W',
  );
  // The filter shows the places that still need a link.
  await window.getByTestId('places-filter').selectOption({ label: 'Not linked' });
  await expect(window.getByTestId('places-empty')).toBeVisible();
  await window.getByTestId('places-close').click();

  // A place that was typed, not picked, gets no link.
  await window.getByTestId('add-event').click();
  await window.getByTestId('event-type').selectOption({ label: 'Residence' });
  await window.getByTestId('event-place').pressSequentially('Springfield');
  await expect(offers.getByTestId('place-offer').first()).toBeVisible();
  await window.getByTestId('event-date').fill('1930');
  await window.getByTestId('dialog-submit').click();
  await expect(window.getByTestId('event-dialog')).toHaveCount(0);
  await window.getByTestId('open-places').click();
  await expect(window.getByTestId('places-count')).toContainText('3 places, 2 linked');
  await window.getByTestId('places-close').click();

  // The place list and the links are still there after the app is restarted.
  await app.close();
  const second = await launchApp(appTarget, userDataDir);
  try {
    const again = await second.firstWindow();
    await expect(again.getByTestId('workspace')).toBeVisible();
    await again.getByTestId('open-places').click();
    await expect(again.getByTestId('gazetteer-installed')).toContainText('100,009 places');
    await expect(again.getByTestId('places-count')).toContainText('3 places, 2 linked');

    // Removing the list keeps the links.
    await again.getByTestId('gazetteer-remove').click();
    await again.getByTestId('dialog-submit').click();
    await expect(again.getByTestId('gazetteer-absent')).toBeVisible();
    await expect(again.getByTestId('places-count')).toContainText('3 places, 2 linked');
    await expect(placeRow(again, 'York, England').getByTestId('place-link')).toContainText(
      'York, England',
    );
    expect(existsSync(join(userDataDir, 'gazetteer', 'geonames.db'))).toBe(false);
  } finally {
    await second.close();
  }
});
