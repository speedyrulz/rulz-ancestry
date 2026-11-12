/**
 * Turns the bytes of a GEDCOM file into text.
 *
 * GEDCOM 7.0 files are always UTF-8. Older files name their character set in
 * the header (`1 CHAR ANSEL`), and that name is not always true, so the bytes
 * themselves are checked too. ANSEL is a library character set from 1985 that
 * only GEDCOM still uses; no platform decodes it, so it is decoded here.
 */

export interface DecodedGedcom {
  text: string;
  /** The character set the bytes were read as, e.g. "UTF-8" or "ANSEL". */
  encoding: string;
  /** The line ending the file uses, so a file written back can use the same. */
  lineEnding: '\r\n' | '\n' | '\r';
  /** Things the reader had to assume or could not read. */
  issues: string[];
}

/** Stands in for a byte that could not be read (U+FFFD, the Unicode replacement character). */
const REPLACEMENT = String.fromCharCode(0xfffd);
/** The byte-order mark (U+FEFF) that may start a file. */
const BYTE_ORDER_MARK = 0xfeff;

/** ANSEL characters that stand on their own, by byte. Codes from the Library of Congress MARC-8 table. */
const ANSEL_SPACING: Readonly<Record<number, number>> = {
  0xa1: 0x0141, // Ł
  0xa2: 0x00d8, // Ø
  0xa3: 0x0110, // Đ
  0xa4: 0x00de, // Þ
  0xa5: 0x00c6, // Æ
  0xa6: 0x0152, // Œ
  0xa7: 0x02b9, // soft sign
  0xa8: 0x00b7, // middle dot
  0xa9: 0x266d, // music flat
  0xaa: 0x00ae, // ®
  0xab: 0x00b1, // ±
  0xac: 0x01a0, // Ơ
  0xad: 0x01af, // Ư
  0xae: 0x02bc, // alif
  0xb0: 0x02bb, // ayn
  0xb1: 0x0142, // ł
  0xb2: 0x00f8, // ø
  0xb3: 0x0111, // đ
  0xb4: 0x00fe, // þ
  0xb5: 0x00e6, // æ
  0xb6: 0x0153, // œ
  0xb7: 0x02ba, // hard sign
  0xb8: 0x0131, // dotless i
  0xb9: 0x00a3, // £
  0xba: 0x00f0, // ð
  0xbc: 0x01a1, // ơ
  0xbd: 0x01b0, // ư
  // GEDCOM's own additions to ANSEL.
  0xbe: 0x25a1, // empty box
  0xbf: 0x25a0, // black box
  0xc0: 0x00b0, // °
  0xc1: 0x2113, // script l
  0xc2: 0x2117, // ℗
  0xc3: 0x00a9, // ©
  0xc4: 0x266f, // music sharp
  0xc5: 0x00bf, // ¿
  0xc6: 0x00a1, // ¡
  0xc7: 0x00df, // ß (MARC-8)
  0xc8: 0x20ac, // € (MARC-8)
  0xcd: 0x0065, // midline e
  0xce: 0x006f, // midline o
  0xcf: 0x00df, // ß (GEDCOM)
};

/**
 * ANSEL accents, by byte. In ANSEL an accent comes before the letter it
 * belongs to; in Unicode it comes after.
 */
const ANSEL_COMBINING: Readonly<Record<number, number>> = {
  0xe0: 0x0309, // hook above
  0xe1: 0x0300, // grave
  0xe2: 0x0301, // acute
  0xe3: 0x0302, // circumflex
  0xe4: 0x0303, // tilde
  0xe5: 0x0304, // macron
  0xe6: 0x0306, // breve
  0xe7: 0x0307, // dot above
  0xe8: 0x0308, // diaeresis (umlaut)
  0xe9: 0x030c, // caron
  0xea: 0x030a, // ring above
  0xeb: 0xfe20, // ligature, left half
  0xec: 0xfe21, // ligature, right half
  0xed: 0x0315, // comma above right
  0xee: 0x030b, // double acute
  0xef: 0x0310, // candrabindu
  0xf0: 0x0327, // cedilla
  0xf1: 0x0328, // ogonek
  0xf2: 0x0323, // dot below
  0xf3: 0x0324, // diaeresis below
  0xf4: 0x0325, // ring below
  0xf5: 0x0333, // double low line
  0xf6: 0x0332, // low line
  0xf7: 0x0326, // comma below
  0xf8: 0x031c, // left half ring below
  0xf9: 0x032e, // breve below
  0xfa: 0xfe22, // double tilde, left half
  0xfb: 0xfe23, // double tilde, right half
  0xfe: 0x0313, // comma above
};

/** Decodes ANSEL. Returns the text and how many bytes had no meaning in ANSEL. */
export function decodeAnsel(bytes: Uint8Array): { text: string; unknown: number } {
  const out: string[] = [];
  let pending = '';
  let unknown = 0;
  for (const byte of bytes) {
    if (byte < 0x80) {
      out.push(String.fromCharCode(byte));
      if (pending !== '') {
        // A line break ends the line; an accent cannot carry over it.
        if (byte !== 0x0a && byte !== 0x0d) out.push(pending);
        pending = '';
      }
      continue;
    }
    const accent = ANSEL_COMBINING[byte];
    if (accent !== undefined) {
      pending += String.fromCharCode(accent);
      continue;
    }
    const spacing = ANSEL_SPACING[byte];
    if (spacing === undefined) {
      unknown += 1;
      out.push(REPLACEMENT);
    } else {
      out.push(String.fromCharCode(spacing));
    }
    if (pending !== '') {
      out.push(pending);
      pending = '';
    }
  }
  // Joins a letter and its accent into the single character most text uses.
  return { text: out.join('').normalize('NFC'), unknown };
}

/** The upper half of Windows code page 1252 where it differs from Latin-1 (bytes 80 to 9F). */
const CP1252_80_9F: readonly number[] = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

/** The upper half of the original IBM PC character set, code page 437 (bytes 80 to FF). */
const CP437_80_FF =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■' +
  // Byte FF is a no-break space.
  String.fromCharCode(0xa0);

function decodeSingleByte(bytes: Uint8Array, high: (byte: number) => string): string {
  const out: string[] = [];
  // In chunks, because one call with a very long argument list overflows the stack.
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    let piece = '';
    for (let index = start; index < end; index += 1) {
      const byte = bytes[index] ?? 0;
      piece += byte < 0x80 ? String.fromCharCode(byte) : high(byte);
    }
    out.push(piece);
  }
  return out.join('');
}

function decodeCp1252(bytes: Uint8Array): string {
  return decodeSingleByte(bytes, (byte) =>
    String.fromCharCode(byte < 0xa0 ? (CP1252_80_9F[byte - 0x80] ?? 0xfffd) : byte),
  );
}

function decodeCp437(bytes: Uint8Array): string {
  return decodeSingleByte(bytes, (byte) => CP437_80_FF[byte - 0x80] ?? REPLACEMENT);
}

function decodeUtf8(bytes: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder('utf-8', { fatal, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): string {
  let data = bytes;
  if (bigEndian) {
    // Swap each pair of bytes, so the one decoder every platform has can be used.
    data = new Uint8Array(bytes.length - (bytes.length % 2));
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      data[index] = bytes[index + 1] ?? 0;
      data[index + 1] = bytes[index] ?? 0;
    }
  }
  return new TextDecoder('utf-16le').decode(data);
}

/** The character set the header names (`1 CHAR UTF-8`), in capitals; empty when it names none. */
function declaredCharset(bytes: Uint8Array): string {
  // The header is plain ASCII in every character set a GEDCOM file may use.
  const head = decodeSingleByte(bytes.subarray(0, 8192), (byte) => String.fromCharCode(byte));
  const match = /^[ \t]*1[ \t]+CHAR(?:ACTER)?[ \t]+([^\r\n]*)/im.exec(head);
  return (match?.[1] ?? '').trim().toUpperCase();
}

function lineEndingOf(text: string): '\r\n' | '\n' | '\r' {
  const at = text.search(/[\r\n]/);
  if (at === -1) return '\r\n';
  if (text[at] === '\n') return '\n';
  return text[at + 1] === '\n' ? '\r\n' : '\r';
}

const WINDOWS_NAMES = new Set([
  'ANSI',
  'WINDOWS',
  'WINDOWS-1252',
  'CP1252',
  'IBM WINDOWS',
  'ISO-8859-1',
  'ISO8859-1',
  'LATIN1',
  'LATIN-1',
]);
const DOS_NAMES = new Set(['IBMPC', 'IBM-PC', 'IBM DOS', 'MS-DOS', 'CP437', 'OEM']);
const UTF16_NAMES = new Set(['UNICODE', 'UTF-16', 'UTF16', 'UTF-16LE', 'UTF-16BE']);

/** Reads the bytes of a GEDCOM file as text, working out which character set they are in. */
export function decodeGedcom(bytes: Uint8Array): DecodedGedcom {
  const issues: string[] = [];
  let text: string;
  let encoding: string;

  const b0 = bytes[0] ?? -1;
  const b1 = bytes[1] ?? -1;
  const b2 = bytes[2] ?? -1;

  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    // The file is marked as UTF-8, whatever its header says.
    const strict = decodeUtf8(bytes, true);
    if (strict === null) {
      issues.push(`some bytes are not valid UTF-8; they are shown as ${REPLACEMENT}`);
    }
    text = strict ?? decodeUtf8(bytes, false) ?? '';
    encoding = 'UTF-8';
  } else if ((b0 === 0xff && b1 === 0xfe) || (b0 !== 0 && b1 === 0)) {
    text = decodeUtf16(bytes, false);
    encoding = 'UTF-16';
  } else if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0 && b1 !== 0)) {
    text = decodeUtf16(bytes, true);
    encoding = 'UTF-16';
  } else {
    const declared = declaredCharset(bytes);
    const asUtf8 = decodeUtf8(bytes, true);
    if (declared === 'ANSEL') {
      const decoded = decodeAnsel(bytes);
      text = decoded.text;
      encoding = 'ANSEL';
      if (decoded.unknown > 0) {
        issues.push(
          `${decoded.unknown} byte(s) have no meaning in ANSEL; they are shown as ${REPLACEMENT}`,
        );
      }
    } else if (DOS_NAMES.has(declared)) {
      text = decodeCp437(bytes);
      encoding = 'IBM PC (code page 437)';
    } else if (WINDOWS_NAMES.has(declared)) {
      text = decodeCp1252(bytes);
      encoding = 'Windows-1252';
    } else if (asUtf8 !== null) {
      // UTF-8, ASCII (which is the same bytes), or a name the app does not
      // know on a file that reads cleanly as UTF-8.
      text = asUtf8;
      encoding = 'UTF-8';
      if (UTF16_NAMES.has(declared)) {
        issues.push(`the header says ${declared}, but the file is UTF-8`);
      }
    } else {
      // Not valid UTF-8. Files that say ASCII or UTF-8 and are neither were
      // nearly always written on Windows in its own character set.
      text = decodeCp1252(bytes);
      encoding = 'Windows-1252';
      issues.push(
        declared === ''
          ? 'the header names no character set and the file is not UTF-8; read as Windows-1252'
          : `the header says ${declared}, but the file is not valid for it; read as Windows-1252`,
      );
    }
  }

  if (text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
  return { text, encoding, lineEnding: lineEndingOf(text), issues };
}

/** The bytes of a GEDCOM file the app writes: UTF-8, starting with the byte-order mark. */
export function encodeGedcom(text: string): Uint8Array {
  return new TextEncoder().encode(String.fromCharCode(BYTE_ORDER_MARK) + text);
}
