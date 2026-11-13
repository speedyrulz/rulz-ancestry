import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatGazetteerPlace } from '@rulz/core';
import { GAZETTEER_FILE_NAME, type GazetteerMinimums } from '@rulz/db';
import {
  GEONAMES_BASE_URL,
  GazetteerService,
  gazetteerSources,
  type GazetteerFetch,
} from './gazetteer';
import { SAMPLE_COUNTRIES, SAMPLE_PLACES, sampleFetch, sampleFiles } from './gazetteersample';

let dir: string;
const services: GazetteerService[] = [];

function service(
  fetch: GazetteerFetch,
  options: { stallMs?: number; minimums?: GazetteerMinimums } = {},
) {
  const made = new GazetteerService({
    dir,
    fetch,
    countries: SAMPLE_COUNTRIES,
    now: () => 1_700_000_000_000,
    minimums: {},
    ...options,
  });
  services.push(made);
  return made;
}

/** What is in the gazetteer's folder, so that nothing left behind goes unnoticed. */
function folder(): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'rulz-gazetteer-')), 'gazetteer');
});

afterEach(async () => {
  for (const made of services.splice(0)) {
    made.close();
    await made.idle();
  }
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

describe('gazetteerSources', () => {
  it('names the three small lists, each country of the priority, and the towns of the world', () => {
    expect(gazetteerSources().map((source) => source.name)).toEqual([
      'countryInfo.txt',
      'admin1CodesASCII.txt',
      'admin2Codes.txt',
      'US.zip',
      'NL.zip',
      'GB.zip',
      'IE.zip',
      'AU.zip',
      'NZ.zip',
      'cities500.zip',
    ]);
  });
});

describe('GazetteerService', () => {
  it('has no gazetteer, and finds nothing, before one is downloaded', () => {
    const { fetch, asked } = sampleFetch();
    const places = service(fetch);
    expect(places.status()).toMatchObject({ installed: null, job: null, error: null });
    expect(places.search('Springfield')).toEqual([]);
    expect(places.get(4250542)).toBeNull();
    // Nothing is asked of the internet until the user says so.
    expect(asked).toEqual([]);
    expect(folder()).toEqual([]);
  });

  it('downloads the lists from GeoNames, builds the gazetteer and cleans up', async () => {
    const { fetch, asked } = sampleFetch();
    const places = service(fetch);
    places.start();
    expect(places.status().job).toMatchObject({ phase: 'downloading', steps: 6 });
    await places.idle();

    expect(asked).toEqual(
      [
        'countryInfo.txt',
        'admin1CodesASCII.txt',
        'admin2Codes.txt',
        'US.zip',
        'NL.zip',
        'cities500.zip',
      ].map((name) => GEONAMES_BASE_URL + name),
    );
    expect(places.status()).toMatchObject({
      installed: { places: SAMPLE_PLACES, builtAt: 1_700_000_000_000, countries: ['US', 'NL'] },
      job: null,
      error: null,
    });
    expect(folder()).toEqual([GAZETTEER_FILE_NAME]);
    expect(places.search('Springf').map(formatGazetteerPlace)).toEqual([
      'Springfield, Sangamon County, Illinois, USA',
      'Springfield, Greene County, Missouri, USA',
    ]);
    expect(places.get(2633352)?.name).toBe('York');
  });

  it('finds the gazetteer again the next time the app starts', async () => {
    const first = service(sampleFetch().fetch);
    first.start();
    await first.idle();
    first.close();

    const { fetch, asked } = sampleFetch();
    const second = service(fetch);
    expect(second.installed?.places).toBe(SAMPLE_PLACES);
    expect(second.search('amster')).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it('does not start a second download while one runs', async () => {
    const { fetch, asked } = sampleFetch();
    const places = service(fetch);
    places.start();
    places.start();
    await places.idle();
    expect(asked).toHaveLength(6);
  });

  it('keeps the gazetteer in use while a new one is downloaded, then uses the new one', async () => {
    const found: number[] = [];
    const { fetch, asked } = sampleFetch(sampleFiles(), (name) => {
      if (name === 'cities500.zip') found.push(places.search('york').length);
      return undefined;
    });
    const places = service(fetch);
    places.start();
    await places.idle();
    places.start();
    await places.idle();
    // Nothing during the first download, the first gazetteer during the second.
    expect(found).toEqual([0, 1]);
    expect(asked).toHaveLength(12);
    expect(places.status()).toMatchObject({ installed: { places: SAMPLE_PLACES }, error: null });
    expect(places.search('york')).toHaveLength(1);
    expect(folder()).toEqual([GAZETTEER_FILE_NAME]);
  });

  it('offers an entry for a place of a tree, but no region found by leaving out its start', async () => {
    const places = service(sampleFetch().fetch);
    expect(places.offer('Springfield, Illinois')).toBeNull();
    places.start();
    await places.idle();
    expect(places.offer('Springfield, Sangamon, Illinois, USA')?.geonameId).toBe(4250542);
    // A ward or a church before a town the gazetteer has.
    expect(places.offer('Ward 7, Springfield, Missouri')?.geonameId).toBe(4409896);
    // The county itself, with or without an empty place for the town before it.
    expect(places.offer('Sangamon, Illinois')?.geonameId).toBe(4250165);
    expect(places.offer(', Sangamon, Illinois, USA')?.geonameId).toBe(4250165);
    // A village the gazetteer does not have: a search finds its county, which is not offered.
    expect(places.search('Smallville, Sangamon, Illinois')[0]?.geonameId).toBe(4250165);
    expect(places.offer('Smallville, Sangamon, Illinois')).toBeNull();
    expect(places.offer('Nowhere at all')).toBeNull();
  });

  it('says why when GeoNames does not have a file, and leaves nothing behind', async () => {
    const files = sampleFiles();
    files.delete('NL.zip');
    const places = service(sampleFetch(files).fetch);
    places.start();
    await places.idle();
    expect(places.status()).toMatchObject({ installed: null, job: null });
    expect(places.status().error).toMatch(/404.*NL\.zip/);
    expect(folder()).toEqual([]);
  });

  it('keeps the gazetteer it has when a new download fails', async () => {
    const files = sampleFiles();
    const places = service(sampleFetch(files).fetch);
    places.start();
    await places.idle();

    files.set('US.zip', Buffer.from('this is not a zip file, whatever its name says'));
    places.start();
    await places.idle();
    expect(places.status().error).toMatch(/zip/);
    expect(places.installed?.places).toBe(SAMPLE_PLACES);
    expect(places.search('Springf')).toHaveLength(2);
    expect(folder()).toEqual([GAZETTEER_FILE_NAME]);
  });

  it('gives up a file that is larger than it should be, announced or not', async () => {
    const huge = new Uint8Array(3 * 1024 * 1024);
    const announced = service(
      sampleFetch(sampleFiles(), (name) =>
        name === 'countryInfo.txt'
          ? new Response('x', { headers: { 'content-length': String(huge.length) } })
          : undefined,
      ).fetch,
    );
    announced.start();
    await announced.idle();
    expect(announced.status().error).toMatch(/countryInfo\.txt is larger/);

    const unannounced = service(
      sampleFetch(sampleFiles(), (name) =>
        name === 'countryInfo.txt' ? new Response(huge) : undefined,
      ).fetch,
    );
    unannounced.start();
    await unannounced.idle();
    expect(unannounced.status().error).toMatch(/countryInfo\.txt is larger/);
    expect(folder()).toEqual([]);
  });

  it('notices a download that ends early, or that brings nothing', async () => {
    const short = service(
      sampleFetch(sampleFiles(), (name) =>
        name === 'admin2Codes.txt'
          ? new Response('half', { headers: { 'content-length': '4000' } })
          : undefined,
      ).fetch,
    );
    short.start();
    await short.idle();
    expect(short.status().error).toMatch(/admin2Codes\.txt ended before/);

    const empty = service(
      sampleFetch(sampleFiles(), (name) =>
        name === 'admin2Codes.txt' ? new Response(new Uint8Array(0)) : undefined,
      ).fetch,
    );
    empty.start();
    await empty.idle();
    expect(empty.status().error).toMatch(/sent nothing for admin2Codes\.txt/);
  });

  it('lets go of an answer it refuses, and takes an empty length for none', async () => {
    const files = sampleFiles();
    let cancelled = 0;
    const refused = service(
      sampleFetch(files, (name) =>
        name === 'NL.zip'
          ? new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancelled += 1;
                },
              }),
              { status: 503 },
            )
          : undefined,
      ).fetch,
    );
    refused.start();
    await refused.idle();
    expect(refused.status().error).toMatch(/503.*NL\.zip/);
    expect(cancelled).toBe(1);

    const places = service(
      sampleFetch(files, (name) =>
        name === 'countryInfo.txt'
          ? new Response(new Uint8Array(files.get(name) ?? Buffer.alloc(0)), {
              headers: { 'content-length': '' },
            })
          : undefined,
      ).fetch,
    );
    places.start();
    await places.idle();
    expect(places.status()).toMatchObject({ installed: { places: SAMPLE_PLACES }, error: null });
  });

  it('does not compare lengths when the answer was packed on its way', async () => {
    const files = sampleFiles();
    const places = service(
      sampleFetch(files, (name) =>
        name === 'countryInfo.txt'
          ? new Response(new Uint8Array(files.get(name) ?? Buffer.alloc(0)), {
              headers: { 'content-length': '7', 'content-encoding': 'gzip' },
            })
          : undefined,
      ).fetch,
    );
    places.start();
    await places.idle();
    expect(places.status()).toMatchObject({ installed: { places: SAMPLE_PLACES }, error: null });
  });

  it('refuses a file that was sent from somewhere else', async () => {
    const places = service(
      sampleFetch(sampleFiles(), (name) => {
        if (name !== 'US.zip') return undefined;
        const response = new Response('elsewhere');
        Object.defineProperty(response, 'url', { value: 'https://example.com/US.zip' });
        return response;
      }).fetch,
    );
    places.start();
    await places.idle();
    expect(places.status().error).toMatch(/somewhere else/);
    expect(places.installed).toBeNull();
  });

  it('follows no redirect: an answer that points elsewhere fails', async () => {
    const seen: string[] = [];
    const places = service((url, init) => {
      seen.push(init.redirect);
      // What a fetch does with a redirect when it was told not to follow one.
      return Promise.reject(new TypeError('unexpected redirect'));
    });
    places.start();
    await places.idle();
    expect(seen).toEqual(['error']);
    expect(places.status().error).toMatch(/could not be downloaded/);
  });

  it('says so when the internet cannot be reached', async () => {
    const places = service(() => Promise.reject(new TypeError('fetch failed')));
    places.start();
    await places.idle();
    expect(places.status().error).toMatch(/could not be downloaded.*check the internet/);
  });

  it('gives up a download from which nothing arrives', async () => {
    const places = service(
      sampleFetch(sampleFiles(), (name, signal) =>
        name === 'NL.zip'
          ? new Promise<Response>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            })
          : undefined,
      ).fetch,
      { stallMs: 30 },
    );
    places.start();
    await places.idle();
    expect(places.status().error).toMatch(/NL\.zip stopped/);
    expect(folder()).toEqual([]);
  });

  it('stops when the user says so, without calling that a failure', async () => {
    let stop = true;
    const { fetch } = sampleFetch(sampleFiles(), (name) => {
      if (stop && name === 'US.zip') places.cancel();
      return undefined;
    });
    const places = service(fetch);
    places.start();
    await places.idle();
    expect(places.status()).toMatchObject({ installed: null, job: null, error: null });
    expect(folder()).toEqual([]);
    // And can be started again.
    stop = false;
    places.start();
    await places.idle();
    expect(places.installed?.places).toBe(SAMPLE_PLACES);
  });

  it('takes a download with too few places for one that went wrong', async () => {
    const places = service(sampleFetch().fetch, { minimums: { places: 1000 } });
    places.start();
    await places.idle();
    expect(places.status().error).toMatch(/far fewer/);
    expect(places.installed).toBeNull();
    expect(folder()).toEqual([]);
  });

  it('keeps the gazetteer it has when a list of names arrives cut short', async () => {
    const files = sampleFiles();
    const minimums = { places: 5, countries: 3, admin1: 4, admin2: 2 };
    const places = service(sampleFetch(files).fetch, { minimums });
    places.start();
    await places.idle();
    expect(places.installed?.places).toBe(SAMPLE_PLACES);

    // One line of two, with a length that fits what was sent.
    files.set('admin2Codes.txt', Buffer.from('US.IL.167\tSangamon County\tSangamon County\t1'));
    places.start();
    await places.idle();
    expect(places.status().error).toMatch(/list of counties holds 1 names/);
    expect(places.installed?.places).toBe(SAMPLE_PLACES);
    expect(places.search('Springfield, Greene')).toHaveLength(1);
    expect(folder()).toEqual([GAZETTEER_FILE_NAME]);
  });

  it('asks for the full lists unless told otherwise', async () => {
    const made = new GazetteerService({
      dir,
      fetch: sampleFetch().fetch,
      countries: SAMPLE_COUNTRIES,
    });
    services.push(made);
    made.start();
    await made.idle();
    expect(made.status().error).toMatch(/far fewer/);
    expect(made.installed).toBeNull();
  });

  it('keeps the gazetteer it has when the new one cannot take its place', async () => {
    const places = service(sampleFetch().fetch);
    places.start();
    await places.idle();
    // Something in the way where the file in use waits during the swap.
    mkdirSync(join(dir, `${GAZETTEER_FILE_NAME}.old`, 'in the way'), { recursive: true });
    places.start();
    await places.idle();
    expect(places.status().error).not.toBeNull();
    expect(places.installed?.places).toBe(SAMPLE_PLACES);
    expect(places.search('york')).toHaveLength(1);
    expect(existsSync(join(dir, `${GAZETTEER_FILE_NAME}.new`))).toBe(false);
  });

  it('removes the gazetteer when asked, and not while one is being downloaded', async () => {
    const places = service(sampleFetch().fetch);
    places.start();
    expect(() => places.remove()).toThrow(/being downloaded/);
    await places.idle();
    places.remove();
    expect(places.status()).toMatchObject({ installed: null, error: null });
    expect(places.search('Springfield')).toEqual([]);
    expect(folder()).toEqual([]);
  });

  it('clears away what a run that was cut short left behind', () => {
    mkdirSync(join(dir, 'download'), { recursive: true });
    writeFileSync(join(dir, 'download', 'US.zip'), 'half a file');
    writeFileSync(join(dir, `${GAZETTEER_FILE_NAME}.new`), 'half a gazetteer');
    service(sampleFetch().fetch);
    expect(folder()).toEqual([]);
  });

  it('puts the old gazetteer back when the app was stopped while a new one took its place', async () => {
    const first = service(sampleFetch().fetch);
    first.start();
    await first.idle();
    first.close();
    // As the folder is in the moment between the two renames.
    renameSync(join(dir, GAZETTEER_FILE_NAME), join(dir, `${GAZETTEER_FILE_NAME}.old`));
    writeFileSync(join(dir, `${GAZETTEER_FILE_NAME}.new`), 'the new one, not yet in place');

    const second = service(sampleFetch().fetch);
    expect(second.installed?.places).toBe(SAMPLE_PLACES);
    expect(second.search('york')).toHaveLength(1);
    expect(folder()).toEqual([GAZETTEER_FILE_NAME]);
    second.close();

    // A copy of the old one that was left beside the new one is cleared away.
    writeFileSync(join(dir, `${GAZETTEER_FILE_NAME}.old`), 'left over');
    const third = service(sampleFetch().fetch);
    expect(third.installed?.places).toBe(SAMPLE_PLACES);
    expect(folder()).toEqual([GAZETTEER_FILE_NAME]);
  });

  it('starts without a gazetteer when its file cannot be read, and can download it anew', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, GAZETTEER_FILE_NAME), 'not a gazetteer');
    const places = service(sampleFetch().fetch);
    expect(places.installed).toBeNull();
    expect(places.status().error).not.toBeNull();
    places.start();
    await places.idle();
    expect(places.status()).toMatchObject({ installed: { places: SAMPLE_PLACES }, error: null });
  });
});
