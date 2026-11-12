import { type GedcomNode, type GedcomVersion } from './node';

/** Writes records back out as GEDCOM text. */

export interface WriteOptions {
  version: GedcomVersion;
  /** Placed after every line. Defaults to the Windows line ending, which is what most GEDCOM files use. */
  lineEnding?: string;
  /**
   * Write a node that still has its original lines from those lines, not from
   * its tag and value. This reproduces an untouched part of a file exactly,
   * including where its long values were broken. It is only right when the
   * file being written has the same version as the one the lines came from.
   */
  keepOriginalLines?: boolean;
}

/**
 * GEDCOM 5.5.1 allows 255 characters in a line. A little is held back for the
 * line ending and for readers that count bytes.
 */
const MAX_LINE_LENGTH = 248;

const CALENDAR_ESCAPE = /(@#D[A-Z_ ]+@)/;
const WHOLE_POINTER = /^@[^@#\s][^@\s]*@$/;

/**
 * Doubles `@` the way the version asks. GEDCOM 5.5.1 doubles every one, apart
 * from the calendar markers in dates (`@#DJULIAN@`). GEDCOM 7.0 doubles only
 * one that starts a line.
 */
function escapeLine(text: string, version: GedcomVersion): string {
  if (version === '7.0') return text.startsWith('@') ? `@${text}` : text;
  if (!text.includes('@')) return text;
  return text
    .split(CALENDAR_ESCAPE)
    .map((piece, index) => (index % 2 === 1 ? piece : piece.replaceAll('@', '@@')))
    .join('');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Where to break a long value for a CONC line. The standard says not to break
 * at a space, because a reader may drop a space at the end or the start of a
 * line. A break also must not fall inside a doubled `@` or inside a character
 * that takes two code units.
 */
function breakPoint(text: string, limit: number): number {
  let at = Math.min(limit, text.length);
  for (let guard = 0; guard < limit; guard += 1) {
    if (at <= 1) return Math.min(limit, text.length);
    const before = text[at - 1];
    const after = text[at];
    if (before === ' ' || after === ' ' || isHighSurrogate(text.charCodeAt(at - 1))) {
      at -= 1;
      continue;
    }
    if (before === '@') {
      // Every @ is doubled by now. An odd number of them before the break
      // would leave one half of a pair on each line.
      let run = 0;
      while (run < at && text[at - 1 - run] === '@') run += 1;
      if (run % 2 === 1) {
        at -= 1;
        continue;
      }
    }
    return at;
  }
  return Math.min(limit, text.length);
}

function writeLine(
  head: string,
  text: string,
  concHead: string,
  version: GedcomVersion,
  out: string[],
): void {
  if (text === '') {
    out.push(head);
    return;
  }
  if (version === '7.0' || head.length + 1 + text.length <= MAX_LINE_LENGTH) {
    out.push(`${head} ${text}`);
    return;
  }
  // GEDCOM 5.5.1 only: carry the rest of a long value on CONC lines.
  let rest = text;
  let lineHead = head;
  while (rest !== '') {
    const room = Math.max(MAX_LINE_LENGTH - lineHead.length - 1, 16);
    const at = rest.length <= room ? rest.length : breakPoint(rest, room);
    out.push(`${lineHead} ${rest.slice(0, at)}`);
    rest = rest.slice(at);
    lineHead = concHead;
  }
}

function writeNode(node: GedcomNode, level: number, options: WriteOptions, out: string[]): void {
  if (options.keepOriginalLines === true && node.raw !== null) {
    out.push(...node.raw);
  } else {
    const xref = node.xref === null ? '' : `@${node.xref}@ `;
    const head = `${level} ${xref}${node.tag}`;
    const below = level + 1;
    if (WHOLE_POINTER.test(node.value)) {
      out.push(`${head} ${node.value}`);
    } else {
      const lines = node.value.replaceAll('\r', '').split('\n');
      lines.forEach((line, index) => {
        writeLine(
          index === 0 ? head : `${below} CONT`,
          escapeLine(line, options.version),
          `${below} CONC`,
          options.version,
          out,
        );
      });
    }
  }
  for (const child of node.children) writeNode(child, level + 1, options, out);
}

/** The lines of some nodes that sit at `level`, without line endings. */
export function writeLines(
  nodes: readonly GedcomNode[],
  level: number,
  options: WriteOptions,
): string[] {
  const out: string[] = [];
  for (const node of nodes) writeNode(node, level, options, out);
  return out;
}

/** A whole file: every record, each line followed by the line ending. */
export function writeGedcom(records: readonly GedcomNode[], options: WriteOptions): string {
  const ending = options.lineEnding ?? '\r\n';
  const lines = writeLines(records, 0, options);
  return lines.length === 0 ? '' : lines.join(ending) + ending;
}
