import type { GedcomNode, GedcomVersion } from './node';

/**
 * Reads GEDCOM text into records.
 *
 * Files in the wild break the rules in small ways, and a reader that stops at
 * the first one is of no use to someone moving a tree out of another program.
 * So this reader never throws: a line it cannot place is reported as an issue
 * and read as well as it can be.
 */

/** Something in the file that was not as the standard says. `line` is 0 for the file as a whole. */
export interface GedcomIssue {
  line: number;
  message: string;
}

export interface GedcomDocument {
  version: GedcomVersion;
  /** What the file's header gives as its version, e.g. "5.5.1"; empty when it gives none. */
  declaredVersion: string;
  /** Every record in file order, including the header (HEAD) and the trailer (TRLR). */
  records: GedcomNode[];
  /** The first {@link MAX_ISSUES} issues found. */
  issues: GedcomIssue[];
  /** How many issues were found in all. */
  issueCount: number;
  /** How many lines of the file held a GEDCOM line. */
  lineCount: number;
}

/** Issues beyond this many are counted but not listed; a broken file can have one per line. */
export const MAX_ISSUES = 200;

interface Token {
  level: number;
  xref: string | null;
  tag: string;
  value: string;
  /** The line as written, plus any following lines that had no level number. */
  raw: string[];
  line: number;
}

// Level, optional cross-reference id, tag, then one separator and the value.
// Spaces before the level are allowed: some programs indent by level.
const LINE = /^[ \t]*(\d{1,2})[ \t]+(?:@([^@]+)@[ \t]+)?([A-Za-z0-9_]+)(?:[ \t](.*))?$/;

class Issues {
  readonly list: GedcomIssue[] = [];
  count = 0;

  add(line: number, message: string): void {
    this.count += 1;
    if (this.list.length < MAX_ISSUES) this.list.push({ line, message });
  }
}

function tokenize(text: string, issues: Issues): Token[] {
  const tokens: Token[] = [];
  // A byte-order mark (U+FEFF) may start the text; it is not part of the first line.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') continue;
    const match = LINE.exec(raw);
    if (match) {
      tokens.push({
        level: Number(match[1]),
        xref: match[2] ?? null,
        tag: match[3] ?? '',
        value: match[4] ?? '',
        raw: [raw],
        line: index + 1,
      });
      continue;
    }
    // A line with no level number is nearly always a long value that some
    // program broke across lines without marking it. Read it as more of the
    // line above.
    const previous = tokens[tokens.length - 1];
    if (previous) {
      previous.value += `\n${raw}`;
      previous.raw.push(raw);
      issues.add(index + 1, 'line has no level number; read as more of the line above');
    } else {
      issues.add(index + 1, 'line is not a GEDCOM line; left out');
    }
  }
  return tokens;
}

/** The version the header declares, read before the tree is built because it decides how `@` is read. */
function declaredVersionOf(tokens: readonly Token[]): string {
  let inGedc = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) break;
    if (token.level === 0 && index > 0) break;
    if (token.level === 1) inGedc = token.tag.toUpperCase() === 'GEDC';
    if (inGedc && token.level === 2 && token.tag.toUpperCase() === 'VERS')
      return token.value.trim();
  }
  return '';
}

export function versionFrom(declared: string): GedcomVersion {
  return declared.startsWith('7') ? '7.0' : '5.5.1';
}

/**
 * Undoes the doubling of `@`. GEDCOM 5.5.1 doubles every `@` in a value;
 * GEDCOM 7.0 doubles only one at the start of a line.
 */
function unescape(value: string, version: GedcomVersion): string {
  if (version === '7.0') return value.startsWith('@@') ? value.slice(1) : value;
  return value.includes('@@') ? value.replaceAll('@@', '@') : value;
}

function build(
  tokens: readonly Token[],
  version: GedcomVersion,
  baseLevel: number,
  issues: Issues,
): GedcomNode[] {
  const top: GedcomNode[] = [];
  // stack[n] is the node that a line n + 1 levels below the top would belong to.
  let stack: GedcomNode[] = [];

  for (const token of tokens) {
    let depth = token.level - baseLevel;
    if (depth < 0) depth = 0;
    const tag = token.tag.toUpperCase();

    if (depth > stack.length) {
      issues.add(token.line, `level ${token.level} skips a level; read as one level deeper`);
      depth = stack.length;
    }
    const parent = depth === 0 ? undefined : stack[depth - 1];

    if (parent && (tag === 'CONT' || tag === 'CONC')) {
      parent.value += (tag === 'CONT' ? '\n' : '') + unescape(token.value, version);
      parent.raw?.push(...token.raw);
      stack.length = depth;
      continue;
    }

    const node: GedcomNode = {
      xref: token.xref,
      tag,
      value: unescape(token.value, version),
      children: [],
      raw: [...token.raw],
      line: token.line,
    };
    if (parent) {
      parent.children.push(node);
      stack.length = depth;
      stack.push(node);
    } else {
      top.push(node);
      stack = [node];
    }
  }
  return top;
}

/** Reads a whole GEDCOM file that has already been decoded to text. */
export function parseGedcom(text: string): GedcomDocument {
  const issues = new Issues();
  const tokens = tokenize(text, issues);
  const declaredVersion = declaredVersionOf(tokens);
  const version = versionFrom(declaredVersion);

  const first = tokens[0];
  if (first && first.level !== 0) {
    issues.add(first.line, 'the file does not start with a level 0 line');
  }
  const records = build(tokens, version, 0, issues);

  if (records[0]?.tag !== 'HEAD') issues.add(0, 'the file has no header (HEAD) record');
  if (declaredVersion === '' && records[0]?.tag === 'HEAD') {
    issues.add(records[0].line, 'the header gives no GEDCOM version; read as 5.5.1');
  }
  const trailer = records.findIndex((record) => record.tag === 'TRLR');
  if (trailer === -1) {
    issues.add(0, 'the file has no trailer (TRLR) line; it may be cut short');
  } else if (trailer !== records.length - 1) {
    issues.add(records[trailer + 1]?.line ?? 0, 'there are records after the trailer (TRLR) line');
  }

  return {
    version,
    declaredVersion,
    records,
    issues: issues.list,
    issueCount: issues.count,
    lineCount: tokens.length,
  };
}

/**
 * Reads a piece of a GEDCOM file, such as one record or one structure of a
 * record, that the app stored earlier. Levels are taken relative to the first
 * line, so a piece that starts at level 1 is read correctly.
 */
export function parseFragment(text: string, version: GedcomVersion): GedcomNode[] {
  const issues = new Issues();
  const tokens = tokenize(text, issues);
  const first = tokens[0];
  if (!first) return [];
  return build(tokens, version, first.level, issues);
}
