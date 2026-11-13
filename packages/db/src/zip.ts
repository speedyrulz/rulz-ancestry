import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { Readable, pipeline } from 'node:stream';
import { crc32, createInflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Reading and writing zip archives, as far as a GEDZip file needs: a GEDCOM
 * file with the pictures and documents it names.
 *
 * The reader never writes a file under a name taken from an archive. It hands
 * out the bytes of an entry; where they go is the caller's business. An
 * archive from someone else can therefore not put a file anywhere.
 *
 * Not supported: archives in the ZIP64 format (larger than 4 GB, or with more
 * than 65,534 files), archives split over several files, and encrypted
 * entries. Entries are stored or deflated; no other method is read.
 */

/** The archive cannot be read or written; the message says why, for the user. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** The name of the file inside the archive, with forward slashes. */
  name: string;
  /** 0 for stored, 8 for deflated. */
  method: number;
  crc: number;
  compressedSize: number;
  /** Size of the file itself, in bytes. */
  size: number;
  /** Where the entry starts in the archive. */
  offset: number;
  encrypted: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const END_RECORD_SIZE = 22;
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
/** The largest list of entries the reader takes into memory. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new ZipError('the zip file ends before it should; it may be damaged');
    done += read;
  }
  return buffer;
}

/** An open zip archive. Close it when done. */
export class ZipReader {
  readonly entries: readonly ZipEntry[];
  readonly #fd: number;
  readonly #byName = new Map<string, ZipEntry>();
  readonly #byLowerName = new Map<string, ZipEntry>();
  #open = true;

  private constructor(fd: number, entries: ZipEntry[]) {
    this.#fd = fd;
    this.entries = entries;
    for (const entry of entries) {
      if (!this.#byName.has(entry.name)) this.#byName.set(entry.name, entry);
      const lower = entry.name.toLowerCase();
      if (!this.#byLowerName.has(lower)) this.#byLowerName.set(lower, entry);
    }
  }

  /** Opens an archive and reads its list of files. Folders are left out of the list. */
  static open(file: string): ZipReader {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch (error) {
      throw new ZipError(`the file cannot be read: ${(error as Error).message}`);
    }
    try {
      return new ZipReader(fd, ZipReader.#directory(fd));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  static #directory(fd: number): ZipEntry[] {
    const size = fstatSync(fd).size;
    if (size < END_RECORD_SIZE) throw new ZipError('this is not a zip file');
    // The record that ends the archive is at its very end, before a comment of at most 65,535 bytes.
    const tailLength = Math.min(size, END_RECORD_SIZE + UINT16_MAX);
    const tail = readAt(fd, size - tailLength, tailLength);
    let end = -1;
    for (let at = tail.length - END_RECORD_SIZE; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) !== END_RECORD) continue;
      if (at + END_RECORD_SIZE + tail.readUInt16LE(at + 20) <= tail.length) {
        end = at;
        break;
      }
    }
    if (end === -1) throw new ZipError('this is not a zip file, or its end is missing');
    if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) {
      throw new ZipError('this zip file is one part of several, which the app does not read');
    }
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === UINT16_MAX || directorySize === UINT32_MAX || directoryOffset === UINT32_MAX) {
      throw new ZipError(
        'this zip file is in the ZIP64 format (over 4 GB, or very many files), which the app does not read yet',
      );
    }
    if (directorySize > MAX_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
      throw new ZipError('the list of files in this zip file is damaged');
    }

    const directory = readAt(fd, directoryOffset, directorySize);
    const decoder = new TextDecoder('utf-8');
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_HEADER) {
        throw new ZipError('the list of files in this zip file is damaged');
      }
      const flags = directory.readUInt16LE(at + 8);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const entry: ZipEntry = {
        name: decoder.decode(directory.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, '/'),
        method: directory.readUInt16LE(at + 10),
        crc: directory.readUInt32LE(at + 16),
        compressedSize: directory.readUInt32LE(at + 20),
        size: directory.readUInt32LE(at + 24),
        offset: directory.readUInt32LE(at + 42),
        encrypted: (flags & 1) !== 0,
      };
      if (
        entry.compressedSize === UINT32_MAX ||
        entry.size === UINT32_MAX ||
        entry.offset === UINT32_MAX
      ) {
        throw new ZipError(
          'this zip file is in the ZIP64 format (over 4 GB, or very many files), which the app does not read yet',
        );
      }
      at += 46 + nameLength + extraLength + commentLength;
      if (at > directory.length)
        throw new ZipError('the list of files in this zip file is damaged');
      if (!entry.name.endsWith('/')) entries.push(entry);
    }
    return entries;
  }

  /** The entry with this name; failing that, the one whose name differs only in upper and lower case. */
  find(name: string): ZipEntry | undefined {
    return this.#byName.get(name) ?? this.#byLowerName.get(name.toLowerCase());
  }

  /** Where the bytes of an entry start, after the header that precedes them. */
  #dataStart(entry: ZipEntry): number {
    const header = readAt(this.#fd, entry.offset, 30);
    if (header.readUInt32LE(0) !== LOCAL_HEADER) {
      throw new ZipError(`${entry.name} is damaged in this zip file`);
    }
    return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  }

  #check(entry: ZipEntry, maxBytes: number): void {
    if (!this.#open) throw new ZipError('the zip file has been closed');
    if (entry.encrypted) {
      throw new ZipError(
        `${entry.name} is protected by a password, which the app does not ask for`,
      );
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${entry.name} is packed in a way the app does not read`);
    }
    if (entry.size > maxBytes) {
      throw new ZipError(`${entry.name} is larger than the app takes from a zip file`);
    }
    if (entry.method === 0 && entry.compressedSize !== entry.size) {
      throw new ZipError(`${entry.name} is damaged in this zip file`);
    }
  }

  /**
   * The whole of an entry. Refused when it is larger than `maxBytes`, also
   * when the archive lies about its size: nothing larger is ever unpacked.
   */
  read(entry: ZipEntry, maxBytes: number): Buffer {
    this.#check(entry, maxBytes);
    // A deflated file is at worst a little larger than the file itself.
    if (entry.compressedSize > maxBytes + CHUNK) {
      throw new ZipError(`${entry.name} is larger than the app takes from a zip file`);
    }
    const packed = readAt(this.#fd, this.#dataStart(entry), entry.compressedSize);
    let data: Buffer;
    if (entry.method === 0) {
      data = packed;
    } else {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(1, maxBytes) });
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipError(`${entry.name} is larger than the app takes from a zip file`);
        }
        throw new ZipError(`${entry.name} is damaged in this zip file`);
      }
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) {
      throw new ZipError(`${entry.name} is damaged in this zip file`);
    }
    return data;
  }

  /**
   * A function that fills a buffer with the next bytes of an entry and
   * returns how many it gave, 0 at the end. A stored entry is read from the
   * archive piece by piece, so a large picture is never in memory as a whole.
   */
  reader(entry: ZipEntry, maxBytes: number): (buffer: Buffer) => number {
    this.#check(entry, maxBytes);
    if (entry.method !== 0) {
      const data = this.read(entry, maxBytes);
      let given = 0;
      return (buffer) => {
        const length = Math.min(buffer.length, data.length - given);
        data.copy(buffer, 0, given, given + length);
        given += length;
        return length;
      };
    }
    const start = this.#dataStart(entry);
    let given = 0;
    let check = 0;
    return (buffer) => {
      const length = Math.min(buffer.length, entry.size - given);
      if (length === 0) return 0;
      const read = readSync(this.#fd, buffer, 0, length, start + given);
      if (read === 0) throw new ZipError(`${entry.name} is damaged in this zip file`);
      check = crc32(buffer.subarray(0, read), check);
      given += read;
      if (given === entry.size && check !== entry.crc) {
        throw new ZipError(`${entry.name} is damaged in this zip file`);
      }
      return read;
    };
  }

  /**
   * The bytes of an entry piece by piece, unpacked as they are asked for, so
   * a file of hundreds of megabytes is never in memory as a whole. Fails
   * when the entry turns out larger than `maxBytes` or than the archive
   * says, and at the end when its checksum is wrong. The archive must stay
   * open until the last piece has been taken.
   */
  async *stream(entry: ZipEntry, maxBytes: number): AsyncGenerator<Buffer, void, void> {
    this.#check(entry, maxBytes);
    if (entry.compressedSize === 0) {
      if (entry.size !== 0) throw new ZipError(`${entry.name} is damaged in this zip file`);
      return;
    }
    const start = this.#dataStart(entry);
    const fd = this.#fd;
    // Read here, not by a file stream: a file stream closes the archive
    // when it is done, and the archive has more entries to give.
    function* pieces(): Generator<Buffer> {
      for (let at = 0; at < entry.compressedSize; at += CHUNK) {
        yield readAt(fd, start + at, Math.min(CHUNK, entry.compressedSize - at));
      }
    }
    const packed = Readable.from(pieces(), { objectMode: false });
    let unpacked: Readable = packed;
    if (entry.method === 8) {
      const inflate = createInflateRaw();
      // An error in reading ends the unpacking with that error.
      pipeline(packed, inflate, () => undefined);
      unpacked = inflate;
    }
    let given = 0;
    let check = 0;
    try {
      for await (const piece of unpacked as AsyncIterable<Buffer>) {
        given += piece.length;
        if (given > entry.size || given > maxBytes) {
          throw new ZipError(`${entry.name} is larger than the archive says`);
        }
        check = crc32(piece, check);
        yield piece;
      }
    } catch (error) {
      if (error instanceof ZipError) throw error;
      throw new ZipError(`${entry.name} is damaged in this zip file`);
    } finally {
      packed.destroy();
      unpacked.destroy();
    }
    if (given !== entry.size || check !== entry.crc) {
      throw new ZipError(`${entry.name} is damaged in this zip file`);
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    closeSync(this.#fd);
  }
}

/** A file to put in an archive: bytes held in memory, or a file on disk, which is copied as it is. */
export type ZipInput = { name: string; data: Uint8Array } | { name: string; file: string };

interface WrittenEntry {
  name: Buffer;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function writeAll(fd: number, data: Uint8Array, position?: number): void {
  let done = 0;
  while (done < data.length) {
    done += writeSync(
      fd,
      data,
      done,
      data.length - done,
      position === undefined ? null : position + done,
    );
  }
}

/** The date and time as zip files store them: local time, to two seconds. */
function dosDateTime(now: number): { date: number; time: number } {
  const moment = new Date(now);
  const year = Math.min(Math.max(moment.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((moment.getMonth() + 1) << 5) | moment.getDate(),
    time:
      (moment.getHours() << 11) | (moment.getMinutes() << 5) | Math.floor(moment.getSeconds() / 2),
  };
}

function localHeader(entry: WrittenEntry, stamp: { date: number; time: number }): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(20, 4);
  // Bit 11: the name is in UTF-8.
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

const TOO_LARGE =
  'the pictures and documents come to more than 4 GB, which is more than the app can put in one zip file';

/**
 * Writes a zip archive. Bytes held in memory are deflated when that makes
 * them smaller; files on disk are stored as they are, because pictures are
 * packed already. The caller removes the file when this throws.
 */
export function writeZip(file: string, inputs: readonly ZipInput[], now = Date.now()): void {
  if (inputs.length >= UINT16_MAX) {
    throw new ZipError('there are more files than the app can put in one zip file (65,534)');
  }
  const stamp = dosDateTime(now);
  const written: WrittenEntry[] = [];
  const fd = openSync(file, 'w');
  try {
    let offset = 0;
    for (const input of inputs) {
      const name = Buffer.from(input.name, 'utf8');
      if (name.length > UINT16_MAX) throw new ZipError(`the name ${input.name} is too long`);
      if (offset > UINT32_MAX) throw new ZipError(TOO_LARGE);
      const entry: WrittenEntry = { name, method: 0, crc: 0, compressedSize: 0, size: 0, offset };

      if ('data' in input) {
        const plain = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
        const packed = deflateRawSync(plain);
        const body = packed.length < plain.length ? packed : plain;
        entry.method = body === packed ? 8 : 0;
        entry.crc = crc32(plain);
        entry.size = plain.length;
        entry.compressedSize = body.length;
        if (entry.size > UINT32_MAX) throw new ZipError(TOO_LARGE);
        writeAll(fd, localHeader(entry, stamp));
        writeAll(fd, name);
        writeAll(fd, body);
      } else {
        // The header is written first with nothing in it, and filled in once
        // the file has been copied and its size and checksum are known.
        writeAll(fd, localHeader(entry, stamp));
        writeAll(fd, name);
        const source = openSync(input.file, 'r');
        try {
          const buffer = Buffer.allocUnsafe(CHUNK);
          for (;;) {
            const read = readSync(source, buffer, 0, buffer.length, null);
            if (read === 0) break;
            const chunk = buffer.subarray(0, read);
            entry.crc = crc32(chunk, entry.crc);
            entry.size += read;
            if (entry.size > UINT32_MAX) throw new ZipError(TOO_LARGE);
            writeAll(fd, chunk);
          }
        } finally {
          closeSync(source);
        }
        entry.compressedSize = entry.size;
        const sizes = Buffer.alloc(12);
        sizes.writeUInt32LE(entry.crc, 0);
        sizes.writeUInt32LE(entry.compressedSize, 4);
        sizes.writeUInt32LE(entry.size, 8);
        writeAll(fd, sizes, offset + 14);
      }
      written.push(entry);
      offset += 30 + name.length + entry.compressedSize;
    }
    if (offset > UINT32_MAX) throw new ZipError(TOO_LARGE);

    const directoryOffset = offset;
    for (const entry of written) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      writeAll(fd, header);
      writeAll(fd, entry.name);
      offset += 46 + entry.name.length;
    }
    const directorySize = offset - directoryOffset;
    if (offset > UINT32_MAX) throw new ZipError(TOO_LARGE);

    const end = Buffer.alloc(END_RECORD_SIZE);
    end.writeUInt32LE(END_RECORD, 0);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);
    writeAll(fd, end);
  } finally {
    closeSync(fd);
  }
}
