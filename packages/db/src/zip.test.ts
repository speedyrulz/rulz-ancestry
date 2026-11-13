import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanUpAfterEach, pngBytes, tempDir } from './testing';
import { ZipError, ZipReader, writeZip, type ZipEntry, type ZipInput } from './zip';

cleanUpAfterEach();

/** Writes an archive into a folder of its own and returns its path. */
function zipOf(inputs: readonly ZipInput[]): string {
  const path = join(tempDir(), 'test.zip');
  writeZip(path, inputs);
  return path;
}

/** Opens an archive, hands it to `use`, and closes it whatever happens. */
function withZip<T>(path: string, use: (zip: ZipReader) => T): T {
  const zip = ZipReader.open(path);
  try {
    return use(zip);
  } finally {
    zip.close();
  }
}

function entryOf(zip: ZipReader, name: string): ZipEntry {
  const entry = zip.find(name);
  if (!entry) throw new Error(`no entry called ${name}`);
  return entry;
}

/** Reads an entry through its piecewise reader, with a small buffer. */
function pieces(zip: ZipReader, entry: ZipEntry, max = 10_000_000): Buffer {
  const read = zip.reader(entry, max);
  const buffer = Buffer.alloc(1000);
  const parts: Buffer[] = [];
  for (;;) {
    const length = read(buffer);
    if (length === 0) break;
    parts.push(Buffer.from(buffer.subarray(0, length)));
  }
  return Buffer.concat(parts);
}

const TEXT = Buffer.from('0 HEAD\n1 GEDC\n2 VERS 7.0\n'.repeat(400), 'utf8');
const PICTURE = pngBytes(40, 30, 5);
const ACCENTED = `photos/M${String.fromCharCode(252)}ller.png`;

describe('writing and reading a zip archive', () => {
  it('gives back what was put in, from memory and from a file on disk', () => {
    const onDisk = join(tempDir(), 'picture.png');
    writeFileSync(onDisk, PICTURE);
    const path = zipOf([
      { name: 'gedcom.ged', data: TEXT },
      { name: 'media/picture.png', file: onDisk },
      { name: ACCENTED, data: PICTURE },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);
    withZip(path, (zip) => {
      expect(zip.entries.map((entry) => entry.name)).toEqual([
        'gedcom.ged',
        'media/picture.png',
        ACCENTED,
        'empty.txt',
      ]);
      // Text shrinks and is deflated; a file from disk is stored as it is.
      expect(entryOf(zip, 'gedcom.ged')).toMatchObject({ method: 8, size: TEXT.length });
      expect(entryOf(zip, 'gedcom.ged').compressedSize).toBeLessThan(TEXT.length / 10);
      expect(entryOf(zip, 'media/picture.png')).toMatchObject({
        method: 0,
        size: PICTURE.length,
        compressedSize: PICTURE.length,
      });
      expect(zip.read(entryOf(zip, 'gedcom.ged'), 1_000_000).equals(TEXT)).toBe(true);
      expect(zip.read(entryOf(zip, 'media/picture.png'), 1_000_000).equals(PICTURE)).toBe(true);
      expect(zip.read(entryOf(zip, ACCENTED), 1_000_000).equals(PICTURE)).toBe(true);
      expect(zip.read(entryOf(zip, 'empty.txt'), 10)).toHaveLength(0);
    });
  });

  it('reads an entry piece by piece, stored or deflated', () => {
    const onDisk = join(tempDir(), 'picture.png');
    const large = Buffer.concat([PICTURE, PICTURE, PICTURE, PICTURE]);
    writeFileSync(onDisk, large);
    const path = zipOf([
      { name: 'gedcom.ged', data: TEXT },
      { name: 'picture.png', file: onDisk },
    ]);
    withZip(path, (zip) => {
      expect(pieces(zip, entryOf(zip, 'picture.png')).equals(large)).toBe(true);
      expect(pieces(zip, entryOf(zip, 'gedcom.ged')).equals(TEXT)).toBe(true);
    });
  });

  it('finds an entry whatever the case of its name', () => {
    withZip(zipOf([{ name: 'Photos/Ann.PNG', data: PICTURE }]), (zip) => {
      expect(zip.find('photos/ann.png')?.name).toBe('Photos/Ann.PNG');
      expect(zip.find('photos/tom.png')).toBeUndefined();
    });
  });

  it('writes an archive with nothing in it', () => {
    withZip(zipOf([]), (zip) => expect(zip.entries).toEqual([]));
  });
});

describe('an archive that cannot be trusted', () => {
  it('is refused when it is not a zip file at all', () => {
    const path = join(tempDir(), 'not.zip');
    writeFileSync(path, 'PK this only starts like one, and goes on for a while longer');
    expect(() => ZipReader.open(path)).toThrow(ZipError);
    writeFileSync(path, 'PK');
    expect(() => ZipReader.open(path)).toThrow(/not a zip file/);
    expect(() => ZipReader.open(join(tempDir(), 'missing.zip'))).toThrow(ZipError);
  });

  it('never unpacks more than it was told to take', () => {
    // 4 MB of zeros deflate to a few kilobytes.
    const path = zipOf([
      { name: 'bomb.bin', data: new Uint8Array(4 * 1024 * 1024) },
      { name: 'picture.png', data: PICTURE },
    ]);
    withZip(path, (zip) => {
      expect(() => zip.read(entryOf(zip, 'bomb.bin'), 100_000)).toThrow(/larger than/);
      expect(() => zip.reader(entryOf(zip, 'picture.png'), PICTURE.length - 1)).toThrow(
        /larger than/,
      );
    });
  });

  it('does not believe a size the archive states too small', () => {
    const path = zipOf([{ name: 'bomb.bin', data: new Uint8Array(4 * 1024 * 1024) }]);
    const bytes = readFileSync(path);
    // The list of files is at the end; the size of the file itself is 24 bytes into its entry.
    const directory = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(10, directory + 24);
    writeFileSync(path, bytes);
    withZip(path, (zip) => {
      expect(entryOf(zip, 'bomb.bin').size).toBe(10);
      expect(() => zip.read(entryOf(zip, 'bomb.bin'), 1000)).toThrow(ZipError);
    });
  });

  it('notices a file that was changed after it was packed', () => {
    const onDisk = join(tempDir(), 'picture.png');
    writeFileSync(onDisk, PICTURE);
    const path = zipOf([
      { name: 'stored.png', file: onDisk },
      { name: 'gedcom.ged', data: TEXT },
    ]);
    const bytes = readFileSync(path);
    // One byte in the middle of the stored picture, and one in the deflated text.
    const stored = 30 + 'stored.png'.length + 50;
    bytes[stored] = (bytes[stored] ?? 0) ^ 0xff;
    const second = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
    const deflated = second + 30 + 'gedcom.ged'.length + 20;
    bytes[deflated] = (bytes[deflated] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);
    withZip(path, (zip) => {
      expect(() => zip.read(entryOf(zip, 'stored.png'), 1_000_000)).toThrow(/damaged/);
      expect(() => pieces(zip, entryOf(zip, 'stored.png'))).toThrow(/damaged/);
      expect(() => zip.read(entryOf(zip, 'gedcom.ged'), 1_000_000)).toThrow(/damaged/);
    });
  });

  it('refuses an entry that is protected by a password, or packed another way', () => {
    const path = zipOf([
      { name: 'a.png', data: PICTURE },
      { name: 'b.png', data: PICTURE },
    ]);
    const bytes = readFileSync(path);
    const first = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const second = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), first + 4);
    // The flags are 8 bytes into an entry of the list, the method 10.
    bytes.writeUInt16LE(bytes.readUInt16LE(first + 8) | 1, first + 8);
    bytes.writeUInt16LE(14, second + 10);
    writeFileSync(path, bytes);
    withZip(path, (zip) => {
      expect(() => zip.read(entryOf(zip, 'a.png'), 1_000_000)).toThrow(/password/);
      expect(() => zip.read(entryOf(zip, 'b.png'), 1_000_000)).toThrow(/does not read/);
    });
  });

  it('says so when the archive is in the ZIP64 format', () => {
    const path = zipOf([{ name: 'a.png', data: PICTURE }]);
    const bytes = readFileSync(path);
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    // In that format the count of files here is the largest number the field holds.
    bytes.writeUInt16LE(0xffff, end + 10);
    writeFileSync(path, bytes);
    expect(() => ZipReader.open(path)).toThrow(/ZIP64/);
  });

  it('leaves folders out of its list, and gives nothing once it is closed', () => {
    const path = zipOf([
      { name: 'photos/', data: new Uint8Array(0) },
      { name: 'photos/a.png', data: PICTURE },
    ]);
    const zip = ZipReader.open(path);
    expect(zip.entries.map((entry) => entry.name)).toEqual(['photos/a.png']);
    const entry = entryOf(zip, 'photos/a.png');
    zip.close();
    zip.close();
    expect(() => zip.read(entry, 1_000_000)).toThrow(/closed/);
  });
});

/** Everything an entry gives when it is read as a stream. */
async function streamed(zip: ZipReader, entry: ZipEntry, max = 100_000_000): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of zip.stream(entry, max)) parts.push(piece);
  return Buffer.concat(parts);
}

describe('reading an entry as a stream', () => {
  /** Three megabytes that do not pack well, so the packed entry spans several pieces too. */
  function noise(): Buffer {
    const bytes = randomBytes(3 * 1024 * 1024);
    // Text-like bytes: they deflate a little, so the entry is stored deflated.
    for (let at = 0; at < bytes.length; at += 1) bytes[at] = 32 + ((bytes[at] ?? 0) & 63);
    return bytes;
  }

  it('gives a deflated and a stored entry whole, and leaves the archive open', async () => {
    const onDisk = join(tempDir(), 'picture.png');
    writeFileSync(onDisk, PICTURE);
    const big = noise();
    const path = zipOf([
      { name: 'big.txt', data: big },
      { name: 'stored.png', file: onDisk },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);
    const zip = ZipReader.open(path);
    try {
      expect(entryOf(zip, 'big.txt').method).toBe(8);
      expect(entryOf(zip, 'big.txt').compressedSize).toBeGreaterThan(1024 * 1024);
      expect((await streamed(zip, entryOf(zip, 'big.txt'))).equals(big)).toBe(true);
      expect((await streamed(zip, entryOf(zip, 'stored.png'))).equals(PICTURE)).toBe(true);
      expect(await streamed(zip, entryOf(zip, 'empty.txt'))).toHaveLength(0);
      // The archive still answers after three streams.
      expect(zip.read(entryOf(zip, 'stored.png'), 1_000_000).equals(PICTURE)).toBe(true);
    } finally {
      zip.close();
    }
  });

  it('can be left before its end', async () => {
    const path = zipOf([{ name: 'big.txt', data: noise() }]);
    const zip = ZipReader.open(path);
    try {
      let count = 0;
      for await (const piece of zip.stream(entryOf(zip, 'big.txt'), 100_000_000)) {
        expect(piece.length).toBeGreaterThan(0);
        count += 1;
        break;
      }
      expect(count).toBe(1);
      expect(await streamed(zip, entryOf(zip, 'big.txt'))).toHaveLength(3 * 1024 * 1024);
    } finally {
      zip.close();
    }
  });

  it('stops at an entry that is damaged, too large, or larger than the archive says', async () => {
    const path = zipOf([
      { name: 'gedcom.ged', data: TEXT },
      { name: 'bomb.bin', data: new Uint8Array(4 * 1024 * 1024) },
    ]);
    let zip = ZipReader.open(path);
    try {
      await expect(streamed(zip, entryOf(zip, 'bomb.bin'), 100_000)).rejects.toThrow(/larger than/);
    } finally {
      zip.close();
    }

    const bytes = readFileSync(path);
    const deflated = 30 + 'gedcom.ged'.length + 20;
    bytes[deflated] = (bytes[deflated] ?? 0) ^ 0xff;
    // The archive now says the second file is ten bytes long.
    const directory = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(10, directory + 24);
    writeFileSync(path, bytes);
    zip = ZipReader.open(path);
    try {
      await expect(streamed(zip, entryOf(zip, 'gedcom.ged'))).rejects.toThrow(ZipError);
      await expect(streamed(zip, entryOf(zip, 'bomb.bin'))).rejects.toThrow(/larger than/);
    } finally {
      zip.close();
    }
  });
});
