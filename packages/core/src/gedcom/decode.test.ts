import { describe, expect, it } from 'vitest';
import { decodeAnsel, decodeGedcom, encodeGedcom } from './decode';

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? ascii(part) : part)));

const header = (charset: string) => `0 HEAD\r\n1 CHAR ${charset}\r\n`;

describe('decodeAnsel', () => {
  it('puts an accent after its letter and joins the two into one character', () => {
    // In ANSEL the accent comes first: E2 is acute, E8 is umlaut, F0 is cedilla.
    const decoded = decodeAnsel(bytes('Ren', [0xe2], 'e M', [0xe8], 'uller Fran', [0xf0], 'cois'));
    expect(decoded).toEqual({ text: 'René Müller François', unknown: 0 });
  });

  it('reads the special letters', () => {
    const decoded = decodeAnsel(
      bytes([0xa2], 'rsted ', [0xb1], 'awa Stra', [0xcf], 'e ', [0xa5], [0xb5], [0xa6], [0xb6]),
    );
    expect(decoded.text).toBe('Ørsted ława Straße ÆæŒœ');
  });

  it('keeps two accents on one letter in the order they were given', () => {
    // Circumflex then acute on "e": Vietnamese ế.
    expect(decodeAnsel(bytes([0xe3], [0xe2], 'e')).text).toBe('ế');
  });

  it('counts bytes that mean nothing in ANSEL and does not carry an accent over a line break', () => {
    const decoded = decodeAnsel(bytes('a', [0xdd], 'b', [0xe2], '\n', 'e'));
    expect(decoded.unknown).toBe(1);
    expect(decoded.text).toBe(`a${String.fromCharCode(0xfffd)}b\ne`);
  });
});

describe('decodeGedcom', () => {
  it('reads UTF-8 with or without a byte-order mark, and drops the mark', () => {
    const text = `${header('UTF-8')}1 NOTE Zoë Čapek\r\n`;
    const plain = new TextEncoder().encode(text);
    expect(decodeGedcom(plain)).toEqual({
      text,
      encoding: 'UTF-8',
      lineEnding: '\r\n',
      issues: [],
    });
    const marked = Uint8Array.from([0xef, 0xbb, 0xbf, ...plain]);
    expect(decodeGedcom(marked).text).toBe(text);
  });

  it('reads ANSEL when the header names it', () => {
    const decoded = decodeGedcom(
      bytes(header('ANSEL'), '1 NAME Ren', [0xe2], 'e /M', [0xe8], 'uller/'),
    );
    expect(decoded.encoding).toBe('ANSEL');
    expect(decoded.text).toContain('René /Müller/');
    expect(decoded.issues).toEqual([]);
  });

  it('reads the Windows character set when the header names it', () => {
    // 0xE9 is é and 0x80 is the euro sign in Windows-1252.
    const decoded = decodeGedcom(bytes(header('ANSI'), '1 NOTE caf', [0xe9], ' 5', [0x80]));
    expect(decoded.encoding).toBe('Windows-1252');
    expect(decoded.text).toContain('café 5€');
  });

  it('reads the old IBM PC character set when the header names it', () => {
    // 0x81 is ü and 0x82 is é in code page 437.
    const decoded = decodeGedcom(bytes(header('IBMPC'), '1 NAME M', [0x81], 'ller Ren', [0x82]));
    expect(decoded.encoding).toBe('IBM PC (code page 437)');
    expect(decoded.text).toContain('Müller René');
  });

  it('reads UTF-16 in either byte order', () => {
    const text = '0 HEAD\n1 CHAR UNICODE\n1 NOTE Zoë\n';
    const little: number[] = [0xff, 0xfe];
    const big: number[] = [0xfe, 0xff];
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      little.push(code & 0xff, code >> 8);
      big.push(code >> 8, code & 0xff);
    }
    for (const data of [little, big, little.slice(2), big.slice(2)]) {
      const decoded = decodeGedcom(Uint8Array.from(data));
      expect(decoded.encoding).toBe('UTF-16');
      expect(decoded.text).toBe(text);
      expect(decoded.lineEnding).toBe('\n');
    }
  });

  it('falls back to the Windows character set when a file is not what its header says', () => {
    // Says ASCII, but holds a byte above 127 that is not valid UTF-8.
    const decoded = decodeGedcom(bytes(header('ASCII'), '1 NOTE caf', [0xe9]));
    expect(decoded.encoding).toBe('Windows-1252');
    expect(decoded.text).toContain('café');
    expect(decoded.issues).toEqual([
      'the header says ASCII, but the file is not valid for it; read as Windows-1252',
    ]);

    const unnamed = decodeGedcom(bytes('0 HEAD\n1 NOTE caf', [0xe9]));
    expect(unnamed.issues[0]).toMatch(/names no character set/);
  });

  it('reads a file as UTF-8 when it is valid UTF-8, whatever name the header gives', () => {
    const data = new TextEncoder().encode(`${header('ASCII')}1 NOTE Zoë\r\n`);
    expect(decodeGedcom(data).text).toContain('Zoë');
    expect(decodeGedcom(data).issues).toEqual([]);
  });

  it('reports which line ending the file uses', () => {
    expect(decodeGedcom(bytes('0 HEAD\n0 TRLR\n')).lineEnding).toBe('\n');
    expect(decodeGedcom(bytes('0 HEAD\r0 TRLR\r')).lineEnding).toBe('\r');
    expect(decodeGedcom(bytes('0 HEAD')).lineEnding).toBe('\r\n');
    expect(decodeGedcom(new Uint8Array()).text).toBe('');
  });
});

describe('encodeGedcom', () => {
  it('writes UTF-8 that starts with the byte-order mark and reads back as the same text', () => {
    const text = '0 HEAD\r\n1 NOTE Zoë\r\n0 TRLR\r\n';
    const data = encodeGedcom(text);
    expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decodeGedcom(data).text).toBe(text);
  });
});
