/**
 * Pictures and documents: what the app knows about kinds of file. It tells a
 * file's kind from its first bytes, says which kinds the app can show itself,
 * and says where a file is kept inside a tree's media folder.
 *
 * Nothing here reads a file; the callers pass the bytes in.
 */

/** The fields of a picture or document that the user fills in. */
export interface MediaFields {
  title: string;
  /** What the file shows, who is on it, where it was found. May have several lines. */
  description: string;
}

export const MEDIA_LIMITS = {
  title: 500,
  description: 20_000,
  fileName: 255,
} as const;

/** The fields in the form the app stores them: trimmed, and cut to the lengths the forms accept. */
export function cleanMediaFields(fields: MediaFields): MediaFields {
  return {
    title: fields.title.replace(/\s+/g, ' ').trim().slice(0, MEDIA_LIMITS.title).trim(),
    description: fields.description
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, MEDIA_LIMITS.description)
      .trim(),
  };
}

/**
 * `image`: a picture the app shows itself, with zoom. `document`: any other
 * file. It is kept in the tree all the same, and opened in another program.
 */
export type MediaKind = 'image' | 'document';

export interface MediaType {
  /** The file extension without its dot, in lower case. Empty when the file has none the app accepts. */
  ext: string;
  /** The media type, e.g. `image/jpeg`. `application/octet-stream` when not known. */
  mime: string;
}

/** How many bytes from the start of a file {@link sniffMediaType} needs at most. */
export const MEDIA_SNIFF_BYTES = 64;

const UNKNOWN_MIME = 'application/octet-stream';

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = offset; index < offset + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] ?? 0);
  }
  return text;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);

/**
 * The kind of file, told from its first bytes, or null when they are not
 * those of a kind the app knows. A file's name is not asked: a scan saved as
 * `.jpg` that is really a PNG is a PNG.
 */
export function sniffMediaType(head: Uint8Array): MediaType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: 'png', mime: 'image/png' };
  }
  const start = ascii(head, 0, 6);
  if (start === 'GIF87a' || start === 'GIF89a') return { ext: 'gif', mime: 'image/gif' };
  if (start.startsWith('%PDF-')) return { ext: 'pdf', mime: 'application/pdf' };
  if (start.startsWith('RIFF') && ascii(head, 8, 4) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  // A bitmap starts with "BM", its size, and four reserved bytes that are zero.
  if (start.startsWith('BM') && head.length >= 14 && startsWith(head, [0, 0, 0, 0], 6)) {
    return { ext: 'bmp', mime: 'image/bmp' };
  }
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { ext: 'tiff', mime: 'image/tiff' };
  }
  // AVIF and HEIC share one container. Its first box names the kind, and
  // after that the kinds it is compatible with.
  if (ascii(head, 4, 4) === 'ftyp') {
    const brands = [ascii(head, 8, 4)];
    for (let offset = 16; offset + 4 <= head.length; offset += 4)
      brands.push(ascii(head, offset, 4));
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) {
      return { ext: 'avif', mime: 'image/avif' };
    }
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return { ext: 'heic', mime: 'image/heic' };
  }
  return null;
}

/** Kinds of file the app does not look inside, by the extension of their name. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
};

/** The extension of a file name: lower case, no dot, and empty unless it is 1 to 8 letters or digits. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/**
 * The kind of a file: from its first bytes where the app knows them, and
 * from the extension of its name otherwise.
 */
export function mediaTypeOf(fileName: string, head: Uint8Array): MediaType {
  const sniffed = sniffMediaType(head);
  if (sniffed) return sniffed;
  const ext = fileExtension(fileName);
  return { ext, mime: MIME_BY_EXTENSION[ext] ?? UNKNOWN_MIME };
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/**
 * The kind of a file the tree does not hold, from what an imported file says
 * of it: its format (`jpg` in GEDCOM 5.5.1, `image/jpeg` in 7.0) and, failing
 * that, the extension of its name. A guess, replaced by what the file's own
 * bytes say once the tree holds it.
 */
export function mediaTypeFromFormat(format: string, fileName: string): MediaType {
  const stated = format.trim().toLowerCase();
  if (MEDIA_TYPE.test(stated)) {
    const known = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === stated);
    return { ext: known ? known[0] : fileExtension(fileName), mime: stated };
  }
  const ext = /^[a-z0-9]{1,8}$/.test(stated) ? stated : fileExtension(fileName);
  return { ext, mime: MIME_BY_EXTENSION[ext] ?? UNKNOWN_MIME };
}

/** True for a file reference that is a web address. */
export function isWebAddress(reference: string): boolean {
  return /^https?:\/\//i.test(reference.trim());
}

/**
 * The file name at the end of a path or a web address, as far as one can be
 * told: `C:\Photos\ann.jpg` and `https://example.com/p/ann.jpg?size=2` both
 * give `ann.jpg`. Empty when the reference ends in none.
 */
export function referenceFileName(reference: string): string {
  let text = reference.trim();
  if (isWebAddress(text)) {
    try {
      text = decodeURIComponent(new URL(text).pathname);
    } catch {
      text = text.replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]*/i, '');
    }
    if (text.endsWith('/')) return '';
  }
  const parts = text.split(/[\\/]/).filter((part) => part !== '');
  return (parts[parts.length - 1] ?? '').slice(0, MEDIA_LIMITS.fileName);
}

/**
 * A file reference as a path below some folder, with forward slashes, or
 * null when it is not one: a web address, a path with a drive letter or from
 * the root of a disk, or a path that steps out of the folder with `..`.
 */
export function localRelativePath(reference: string): string | null {
  const text = reference.trim().replace(/\\/g, '/');
  // A scheme (`https:`, `file:`) or a drive letter (`C:`).
  if (text === '' || /^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('/')) return null;
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

/**
 * A name for a file inside an archive that every program and file system
 * accepts: letters without accents, digits, dots, dashes and underscores.
 * `fallback` is used when nothing of the name is left.
 */
export function safeArchiveName(fileName: string, ext: string, fallback: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  const base = /[A-Za-z0-9]/.test(stem) ? stem : fallback;
  return ext === '' ? base : `${base}.${ext}`;
}

/** The pictures the app shows itself. Other kinds, such as TIFF and HEIC, are not drawn by the window. */
const VIEWABLE = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

export function mediaKind(mime: string): MediaKind {
  return VIEWABLE.has(mime) ? 'image' : 'document';
}

/**
 * Extensions the app will hand to the program Windows opens them with.
 * Everything else is only shown in its folder: a tree may hold files that
 * came from someone else, and opening one must never run it.
 */
const OPENABLE = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'pdf',
  'txt',
  'csv',
  'rtf',
  'doc',
  'docx',
  'odt',
  'xls',
  'xlsx',
  'ods',
  'mp3',
  'wav',
  'm4a',
  'ogg',
  'flac',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
]);

export function canOpenOutside(ext: string): boolean {
  return OPENABLE.has(ext.toLowerCase());
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256(text: string): boolean {
  return SHA256_HEX.test(text);
}

/**
 * Where a file is kept inside a tree's media folder, with forward slashes:
 * `ab/ab12….jpg`. The name is the SHA-256 of the file's contents, so the same
 * file is kept once however often it is added, and a file is never changed
 * once it is there.
 */
export function mediaStorePath(sha256: string, ext: string): string {
  if (!isSha256(sha256)) throw new Error('not a SHA-256 in lower-case hex');
  if (ext !== '' && !/^[a-z0-9]{1,8}$/.test(ext)) throw new Error(`not a file extension: ${ext}`);
  return `${sha256.slice(0, 2)}/${sha256}${ext === '' ? '' : `.${ext}`}`;
}
