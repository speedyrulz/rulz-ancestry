import { closeSync, createReadStream, openSync, readFileSync, readSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { createGunzip } from 'node:zlib';
import {
  CENSUS_BUILDER_VERSION,
  CENSUS_COLUMNS,
  CENSUS_HOST,
  NARA_CENSUS_PACK_KIND,
  OA_BUILDER_VERSION,
  OA_PACK_KIND,
  censusSkipAcceptable,
  oaLayout,
  parseCensusState,
  splitOaLine,
} from '@rulz/connectors';
import { PackWriter, type PackMeta } from '@rulz/db';

/**
 * Building a pack from the files its source publishes. The logic lives here,
 * as plain code the tests run in the main thread; `packbuild.worker.ts` runs
 * it in a worker thread of its own, so that a build of millions of rows never
 * holds up the app's window.
 *
 * Each kind of pack has a build of its own, since its source's files differ.
 * Open Archives' files are CSVs, packed with gzip or not: a file's first line
 * names its columns, the pack's columns are all the files' columns in the
 * order they first appear, and each row is placed by the header of its own
 * file; a row that does not have as many fields as its header is left out and
 * counted. A state of the 1950 census is one JSON file, read whole.
 */

/** What one kind of pack knows about its source's files. */
export interface PackKind {
  /** Raised when a change to how rows are read means that packs must be built again. */
  builderVersion: number;
  /** The hosts a file of this kind may be downloaded from, over https. */
  allowedHosts: readonly string[];
  /** A file larger than this is not downloaded. */
  maxFileBytes: number;
  /** About how many times the size of its files a pack of this kind takes of the disk, while it is made. */
  spaceFactor: number;
  /** Builds a pack of this kind from the downloaded files. */
  build(input: BuildInput, hooks: BuildHooks): Promise<PackMeta>;
}

/** What the CSV build needs to know of a kind of pack whose files are CSVs. */
interface CsvShape {
  /** The columns whose text is searched, from a header. Throws when the header is not this kind's. */
  layout(header: readonly string[]): { ftsNames: string[]; ftsPlaces: string[] };
  /** The column that holds the year of a row. */
  yearColumn: string;
  /** Splits one line. */
  split(line: string): string[];
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const OA_CSV: CsvShape = {
  layout: (header) => {
    const { ftsNames, ftsPlaces } = oaLayout(header);
    return { ftsNames, ftsPlaces };
  },
  yearColumn: 'EVENT_YEAR',
  split: splitOaLine,
};

/** The kinds of pack this build of the app knows. A pack of another kind is not used. */
export const PACK_KINDS: Readonly<Record<string, PackKind>> = {
  [OA_PACK_KIND]: {
    builderVersion: OA_BUILDER_VERSION,
    allowedHosts: ['oa-export.s3.nl-ams.scw.cloud'],
    maxFileBytes: 20 * GB,
    spaceFactor: 12,
    build: (input, hooks) => buildCsvPack(OA_CSV, input, hooks),
  },
  [NARA_CENSUS_PACK_KIND]: {
    builderVersion: CENSUS_BUILDER_VERSION,
    allowedHosts: [CENSUS_HOST],
    // The largest state file is about 51 MB.
    maxFileBytes: 80 * MB,
    // The file, and a pack of about 0.6 times its size.
    spaceFactor: 3,
    build: buildCensusPack,
  },
};

/** What a build is given. It holds plain data only: it is passed to a worker thread. */
export interface BuildInput {
  kind: string;
  /** Where the pack is written; no file is there yet. */
  outPath: string;
  files: {
    /** The downloaded file. */
    path: string;
    url: string;
    bytes: number;
    sha256: string;
    etag: string | null;
    modified: string | null;
  }[];
  meta: {
    packId: string;
    title: string;
    sourceName: string;
    sourceUrl: string;
    licence: string;
    credit: string;
    downloadedAt: string;
    /** The source's own last-changed day, where it gives one. */
    sourceModified?: string;
  };
  /** The build stops when the free space of the drive falls below this. */
  reserveBytes: number;
  /** How many rows lie between two looks at the free space. */
  checkEvery?: number;
}

/** What a build does besides reading and writing. */
export interface BuildHooks {
  /** True when the build is to stop; asked for at every batch of rows. */
  stop(): boolean;
  progress(rows: number): void;
  /** Free space on the drive of a folder; null when it cannot be read. */
  freeBytes?(dir: string): number | null;
}

export class BuildStopped extends Error {
  constructor() {
    super('The build was stopped.');
    this.name = 'BuildStopped';
  }
}

/** The free space on the drive of a folder, in bytes; null when it cannot be read. */
export function freeBytesOf(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

const BATCH_ROWS = 5000;
/** A line longer than this is no line of any source this app reads. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const BOM = String.fromCharCode(0xfeff);

/** True when the file starts as a gzip file does. */
function isGzip(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(2);
    const read = readSync(fd, bytes, 0, 2, 0);
    return read === 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

/** The lines of a CSV file, packed or not, without their line ends. The stream is closed when the caller stops. */
async function* linesOf(path: string): AsyncGenerator<string> {
  const file = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const input = isGzip(path) ? file.pipe(createGunzip()) : file;
  file.on('error', (error) => input.destroy(error));
  const decoder = new StringDecoder('utf8');
  let rest = '';
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      rest += decoder.write(chunk);
      let at = rest.indexOf('\n');
      let from = 0;
      while (at >= 0) {
        const line = rest.slice(from, at);
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        from = at + 1;
        at = rest.indexOf('\n', from);
      }
      rest = rest.slice(from);
      if (rest.length > MAX_LINE_CHARS) throw new Error('A line of the file is far too long.');
    }
    rest += decoder.end();
    if (rest !== '') yield rest.endsWith('\r') ? rest.slice(0, -1) : rest;
  } finally {
    input.destroy();
    file.destroy();
  }
}

async function headerOf(path: string, kind: CsvShape): Promise<string[]> {
  const lines = linesOf(path);
  try {
    const first = await lines.next();
    if (first.done === true || first.value === '') throw new Error('A file has no header line.');
    const header = kind.split(first.value.startsWith(BOM) ? first.value.slice(1) : first.value);
    if (new Set(header).size !== header.length) {
      throw new Error('A file names one column twice.');
    }
    return header;
  } finally {
    await lines.return(undefined);
  }
}

const yearOf = (text: string | undefined): number | null =>
  text !== undefined && /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null;

/**
 * Builds the pack of `input.files` at `input.outPath`, in the way of its kind.
 * Throws `BuildStopped` when `hooks.stop()` says so, and an error when a file
 * is not one of the pack's kind or the disk is nearly full. On any failure the
 * file is left for the caller to delete.
 */
export async function buildPack(input: BuildInput, hooks: BuildHooks): Promise<PackMeta> {
  const kind = PACK_KINDS[input.kind];
  if (kind === undefined)
    throw new Error(`This app does not know packs of the kind ${input.kind}.`);
  return kind.build(input, hooks);
}

/** Builds a pack from CSV files (see the top of this file). */
async function buildCsvPack(
  kind: CsvShape,
  input: BuildInput,
  hooks: BuildHooks,
): Promise<PackMeta> {
  const builderVersion = PACK_KINDS[input.kind]?.builderVersion ?? 0;
  const freeBytes = hooks.freeBytes ?? freeBytesOf;
  const outDir = dirname(input.outPath);

  const headers: string[][] = [];
  for (const file of input.files) {
    if (hooks.stop()) throw new BuildStopped();
    const header = await headerOf(file.path, kind);
    kind.layout(header);
    headers.push(header);
  }
  const columns = [...new Set(headers.flat())];
  const at = new Map(columns.map((name, i) => [name, i]));
  const { ftsNames, ftsPlaces } = kind.layout(columns);

  const writer = PackWriter.create(input.outPath, columns, { names: ftsNames, places: ftsPlaces });
  let rows = 0;
  let skipped = 0;
  let sinceLook = 0;
  const checkEvery = input.checkEvery ?? 50_000;
  try {
    for (const [index, file] of input.files.entries()) {
      const header = headers[index] ?? [];
      const place = header.map((name) => at.get(name) ?? 0);
      const yearAt = header.indexOf(kind.yearColumn);
      let batch: { year: number | null; values: string[] }[] = [];
      const flush = () => {
        if (batch.length === 0) return;
        writer.add(batch);
        rows += batch.length;
        sinceLook += batch.length;
        batch = [];
        hooks.progress(rows);
        if (sinceLook >= checkEvery) {
          sinceLook = 0;
          const free = freeBytes(outDir);
          if (free !== null && free < input.reserveBytes) {
            throw new Error('The disk is nearly full, so the pack was not finished.');
          }
        }
      };
      let first = true;
      for await (const line of linesOf(file.path)) {
        if (first) {
          first = false;
          continue;
        }
        if (line === '') continue;
        const fields = kind.split(line);
        if (fields.length !== header.length) {
          skipped += 1;
          continue;
        }
        const values = new Array<string>(columns.length).fill('');
        for (let i = 0; i < fields.length; i += 1) values[place[i] ?? 0] = fields[i] ?? '';
        batch.push({ year: yearAt < 0 ? null : yearOf(fields[yearAt]), values });
        if (batch.length >= BATCH_ROWS) {
          flush();
          if (hooks.stop()) throw new BuildStopped();
        }
      }
      flush();
      if (hooks.stop()) throw new BuildStopped();
    }
    if (rows === 0) throw new Error('The files hold no records.');
    return writer.finish({
      packId: input.meta.packId,
      kind: input.kind,
      builderVersion,
      title: input.meta.title,
      sourceName: input.meta.sourceName,
      sourceUrl: input.meta.sourceUrl,
      licence: input.meta.licence,
      credit: input.meta.credit,
      files: input.files.map(({ url, bytes, sha256, etag, modified }) => ({
        url,
        bytes,
        sha256,
        etag,
        modified,
      })),
      downloadedAt: input.meta.downloadedAt,
      skipped,
      ...(input.meta.sourceModified !== undefined
        ? { sourceModified: input.meta.sourceModified }
        : {}),
    });
  } catch (error) {
    writer.abandon();
    throw error;
  }
}

const CENSUS_BATCH = 500;

/** Reads a state's file; its text is let go of when this returns, before the rows are written. */
function readCensusFile(path: string): ReturnType<typeof parseCensusState> {
  const text = readFileSync(path, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    throw new Error('The file is not JSON.');
  }
  return parseCensusState(json);
}

/**
 * Builds a pack from one state's metadata file of the 1950 census. The file
 * is read whole and parsed with `JSON.parse` (the largest is about 51 MB); a
 * row is made for each enumeration district, or one for a territory, which
 * has none. A district whose paths or page list are not as the bucket's own
 * are is left out and counted; the build fails when more than 1% are.
 */
async function buildCensusPack(input: BuildInput, hooks: BuildHooks): Promise<PackMeta> {
  const [file] = input.files;
  if (input.files.length !== 1 || file === undefined) {
    throw new Error('A pack of the census is made from one file.');
  }
  if (hooks.stop()) throw new BuildStopped();
  const state = readCensusFile(file.path);
  if (hooks.stop()) throw new BuildStopped();
  // A pack of a state is named after the state's code: the file must be that state's.
  if (!input.meta.packId.endsWith(state.abbreviation.toLowerCase())) {
    throw new Error('The file is not the state this pack is for.');
  }
  if (!censusSkipAcceptable(state.skippedDistricts, state.districts)) {
    throw new Error(
      `${state.skippedDistricts} of ${state.districts} districts are not as they must be, so the pack was not made.`,
    );
  }
  if (state.rows.length === 0) throw new Error('The file holds no districts.');
  const writer = PackWriter.create(input.outPath, CENSUS_COLUMNS, {
    names: [],
    places: ['county', 'description'],
  });
  try {
    let written = 0;
    for (let from = 0; from < state.rows.length; from += CENSUS_BATCH) {
      const batch = state.rows.slice(from, from + CENSUS_BATCH);
      writer.add(
        batch.map((row) => ({
          year: null,
          values: [
            row.state,
            row.abbreviation,
            row.county,
            row.ed,
            row.description,
            row.reservation,
            row.roll,
            row.descriptionImage,
            row.folder,
            JSON.stringify(row.files),
            JSON.stringify(row.maps),
            String(row.files.length),
          ],
        })),
      );
      written += batch.length;
      hooks.progress(written);
      if (hooks.stop()) throw new BuildStopped();
    }
    return writer.finish({
      packId: input.meta.packId,
      kind: input.kind,
      builderVersion: CENSUS_BUILDER_VERSION,
      title: input.meta.title,
      sourceName: input.meta.sourceName,
      sourceUrl: input.meta.sourceUrl,
      licence: input.meta.licence,
      credit: input.meta.credit,
      files: input.files.map(({ url, bytes, sha256, etag, modified }) => ({
        url,
        bytes,
        sha256,
        etag,
        modified,
      })),
      downloadedAt: input.meta.downloadedAt,
      skipped: state.skippedDistricts + state.skippedImages,
      ...(input.meta.sourceModified !== undefined
        ? { sourceModified: input.meta.sourceModified }
        : {}),
    });
  } catch (error) {
    writer.abandon();
    throw error;
  }
}

/** A build under way. `promise` settles once nothing of the build can write any more. */
export interface BuildRun {
  promise: Promise<PackMeta>;
  /** Asks the build to stop; it ends at its next batch. */
  stop(): void;
}

/** Starts a build; `onProgress` is told how many rows are written. */
export type BuildRunner = (input: BuildInput, onProgress: (rows: number) => void) => BuildRun;

/** Runs the build in this thread. For tests. */
export function inProcessBuildRunner(overrides: Partial<BuildHooks> = {}): BuildRunner {
  return (input, onProgress) => {
    let stopped = false;
    const promise = buildPack(input, {
      stop: () => stopped,
      progress: onProgress,
      ...overrides,
    });
    return {
      promise,
      stop: () => {
        stopped = true;
      },
    };
  };
}

/** How long a worker is given to stop by itself before it is ended. */
const WORKER_STOP_GRACE_MS = 10_000;

type BuildMessage =
  | { type: 'progress'; rows: number }
  | { type: 'done'; meta: PackMeta }
  | { type: 'failed'; message: string; stopped: boolean };

/**
 * Runs each build in a worker thread loaded from `workerPath`. The promise
 * settles after the worker has exited, so that a file the build wrote is not
 * deleted from under it.
 */
export function workerBuildRunner(workerPath: string): BuildRunner {
  return (input, onProgress) => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(workerPath, {
      workerData: { rulzPackBuild: true, input, flag },
    });
    let outcome: BuildMessage | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<PackMeta>((resolve, reject) => {
      worker.on('message', (message: BuildMessage) => {
        if (message.type === 'progress') onProgress(message.rows);
        else outcome = message;
      });
      worker.once('error', (error) => {
        outcome ??= { type: 'failed', message: error.message, stopped: false };
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (outcome?.type === 'done') resolve(outcome.meta);
        else if (outcome?.type === 'failed' && outcome.stopped) reject(new BuildStopped());
        else {
          reject(
            new Error(
              outcome?.type === 'failed'
                ? outcome.message
                : `The build ended without an answer (code ${code}).`,
            ),
          );
        }
      });
    });
    return {
      promise,
      stop: () => {
        Atomics.store(flag, 0, 1);
        timer ??= setTimeout(() => void worker.terminate(), WORKER_STOP_GRACE_MS);
      },
    };
  };
}
