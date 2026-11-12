import { describe, expect, it } from 'vitest';
import {
  MEDIA_LIMITS,
  canOpenOutside,
  cleanMediaFields,
  fileExtension,
  isSha256,
  mediaKind,
  mediaStorePath,
  mediaTypeOf,
  sniffMediaType,
} from './media';

/** The given bytes, followed by zeros up to `length`. Text stands for its character codes. */
function bytes(parts: (number[] | string)[], length = 32): Uint8Array {
  const flat = parts.flatMap((part) =>
    typeof part === 'string' ? [...part].map((ch) => ch.charCodeAt(0)) : part,
  );
  const out = new Uint8Array(Math.max(length, flat.length));
  out.set(flat);
  return out;
}

const SHA = 'ab'.repeat(32);

describe('sniffMediaType', () => {
  it('knows the pictures the app shows by their first bytes', () => {
    expect(sniffMediaType(bytes([[0xff, 0xd8, 0xff, 0xe0]]))).toEqual({
      ext: 'jpg',
      mime: 'image/jpeg',
    });
    expect(sniffMediaType(bytes([[0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]]))).toEqual({
      ext: 'png',
      mime: 'image/png',
    });
    expect(sniffMediaType(bytes(['GIF89a']))?.mime).toBe('image/gif');
    expect(sniffMediaType(bytes(['GIF87a']))?.mime).toBe('image/gif');
    expect(sniffMediaType(bytes(['RIFF', [1, 2, 3, 4], 'WEBP']))?.mime).toBe('image/webp');
    expect(sniffMediaType(bytes(['BM', [0x36, 0, 0, 0], [0, 0, 0, 0], [0x36, 0, 0, 0]]))).toEqual({
      ext: 'bmp',
      mime: 'image/bmp',
    });
  });

  it('knows documents and the pictures the window cannot draw', () => {
    expect(sniffMediaType(bytes(['%PDF-1.7']))).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    expect(sniffMediaType(bytes([[0x49, 0x49, 0x2a, 0x00]]))?.ext).toBe('tiff');
    expect(sniffMediaType(bytes([[0x4d, 0x4d, 0x00, 0x2a]]))?.ext).toBe('tiff');
    expect(sniffMediaType(bytes([[0, 0, 0, 0x1c], 'ftyp', 'heic', [0, 0, 0, 0], 'mif1']))).toEqual({
      ext: 'heic',
      mime: 'image/heic',
    });
  });

  it('reads the kinds a container says it is compatible with', () => {
    const avif = bytes([[0, 0, 0, 0x1c], 'ftyp', 'avif', [0, 0, 0, 0], 'mif1', 'miaf']);
    expect(sniffMediaType(avif)?.mime).toBe('image/avif');
    const viaBrand = bytes([[0, 0, 0, 0x1c], 'ftyp', 'mif1', [0, 0, 0, 0], 'mif1', 'avif']);
    expect(sniffMediaType(viaBrand)?.mime).toBe('image/avif');
    // A film in the same container is not a picture.
    expect(sniffMediaType(bytes([[0, 0, 0, 0x18], 'ftyp', 'isom', [0, 0, 2, 0], 'mp41']))).toBe(
      null,
    );
  });

  it('gives null for anything else, however short', () => {
    expect(sniffMediaType(new Uint8Array(0))).toBe(null);
    expect(sniffMediaType(bytes([[0xff, 0xd8]], 2))).toBe(null);
    expect(sniffMediaType(bytes(['Dear cousin, I found the register']))).toBe(null);
    // "BM" at the start of a text is not a bitmap.
    expect(sniffMediaType(bytes(['BMW owners of 1931']))).toBe(null);
    expect(sniffMediaType(bytes(['RIFF', [1, 2, 3, 4], 'WAVE']))).toBe(null);
  });
});

describe('mediaTypeOf', () => {
  it('believes the bytes before the name', () => {
    const png = bytes([[0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]]);
    expect(mediaTypeOf('census page.JPG', png)).toEqual({ ext: 'png', mime: 'image/png' });
  });

  it('falls back on the extension of the name', () => {
    const text = bytes(['Notes on the Hale family']);
    expect(mediaTypeOf('notes.TXT', text)).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(mediaTypeOf('letter.docx', text).mime).toMatch(/wordprocessingml/);
    expect(mediaTypeOf('talk.mp3', text)).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
  });

  it('keeps an unknown extension and says the kind is not known', () => {
    const data = bytes([[1, 2, 3]]);
    expect(mediaTypeOf('tree.ftm', data)).toEqual({
      ext: 'ftm',
      mime: 'application/octet-stream',
    });
    expect(mediaTypeOf('README', data)).toEqual({ ext: '', mime: 'application/octet-stream' });
    expect(mediaTypeOf('odd.name with spaces', data).ext).toBe('');
  });
});

describe('fileExtension', () => {
  it('is the last part of the name, in lower case', () => {
    expect(fileExtension('Scan.JPEG')).toBe('jpeg');
    expect(fileExtension('a.b.c.Pdf')).toBe('pdf');
  });

  it('is empty when there is none worth keeping', () => {
    expect(fileExtension('no extension')).toBe('');
    expect(fileExtension('.hidden')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
    expect(fileExtension('long.extension1')).toBe('');
    expect(fileExtension('bad.e-x')).toBe('');
  });
});

describe('mediaKind', () => {
  it('counts as an image only what the window draws', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']) {
      expect(mediaKind(mime)).toBe('image');
    }
    expect(mediaKind('image/avif')).toBe('image');
    expect(mediaKind('image/tiff')).toBe('document');
    expect(mediaKind('image/heic')).toBe('document');
    expect(mediaKind('image/svg+xml')).toBe('document');
    expect(mediaKind('application/pdf')).toBe('document');
    expect(mediaKind('application/octet-stream')).toBe('document');
  });
});

describe('canOpenOutside', () => {
  it('allows documents, pictures, sound and film', () => {
    for (const ext of ['pdf', 'PDF', 'tiff', 'docx', 'mp3', 'mp4', 'jpg']) {
      expect(canOpenOutside(ext)).toBe(true);
    }
  });

  it('refuses anything that could run, and anything it does not know', () => {
    for (const ext of ['exe', 'bat', 'cmd', 'msi', 'js', 'vbs', 'lnk', 'ps1', 'html', 'svg', '']) {
      expect(canOpenOutside(ext)).toBe(false);
    }
  });
});

describe('mediaStorePath', () => {
  it('files a file under the first two characters of its hash', () => {
    expect(mediaStorePath(SHA, 'jpg')).toBe(`ab/${SHA}.jpg`);
    expect(mediaStorePath(SHA, '')).toBe(`ab/${SHA}`);
  });

  it('refuses a hash or an extension that could leave the folder', () => {
    expect(() => mediaStorePath('../../evil', 'jpg')).toThrow();
    expect(() => mediaStorePath(SHA.toUpperCase(), 'jpg')).toThrow();
    expect(() => mediaStorePath(SHA, '../x')).toThrow();
    expect(() => mediaStorePath(SHA, 'JPG')).toThrow();
  });

  it('tells a hash from other text', () => {
    expect(isSha256(SHA)).toBe(true);
    expect(isSha256(SHA.slice(1))).toBe(false);
    expect(isSha256(`${SHA.slice(0, 63)}g`)).toBe(false);
  });
});

describe('cleanMediaFields', () => {
  it('trims, joins a title to one line and keeps the lines of a description', () => {
    expect(
      cleanMediaFields({ title: '  Wedding\n of  1902 ', description: ' Line one\r\nLine two \n' }),
    ).toEqual({ title: 'Wedding of 1902', description: 'Line one\nLine two' });
  });

  it('cuts text to the lengths the forms accept', () => {
    const cleaned = cleanMediaFields({ title: 'x'.repeat(2000), description: 'y'.repeat(50_000) });
    expect(cleaned.title).toHaveLength(MEDIA_LIMITS.title);
    expect(cleaned.description).toHaveLength(MEDIA_LIMITS.description);
  });
});
