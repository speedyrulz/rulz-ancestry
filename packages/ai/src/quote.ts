import type { SharedField, SharedRecord } from './record';

/**
 * The check of a quote. Every reason an AI gives for or against a match must
 * quote the record, and the app looks the quote up in the texts it passed on.
 * A reason whose quote is not there is dropped, so that evidence cannot be
 * made up.
 *
 * What counts as found:
 *
 * - The quote lies **in one text** of the record (`SharedRecord.fields`). It
 *   cannot run from one text into the next.
 * - It is **the whole text**, or a run of **whole words** of it that is at
 *   least `QUOTE_PART_MIN` characters long. "1850" is found in "16 FEB 1850"
 *   and not in "18501"; "de" is found only where a text is "de" and no more.
 * - Capitals and small letters count as the same, and so do the forms of one
 *   letter (a wide letter and a plain one), a run of white space and one
 *   space, and the curly and the straight forms of a quotation mark, an
 *   apostrophe and a dash. A letter with an accent and one without do not.
 * - What stands around the quote and is no letter and no number does not
 *   count: quotation marks an AI put around it, a full stop after it.
 * - Where the check cannot be sure, the quote is not found. A character that
 *   stands for several ("½") is quoted whole or not at all, and a word that
 *   stands where a text was cut ("1850…") is not a whole word.
 *
 * The check says that the words are in the record. It does not say that the
 * reason drawn from them is right: that is for the user to judge, with the
 * quote in front of them.
 */

/** The shortest quote that is only a part of a text, in characters. */
export const QUOTE_PART_MIN = 4;

/** The longest quote that is looked for, in characters. */
export const QUOTE_MAX = 300;

export type QuoteCheck =
  | {
      found: true;
      /** The name of the text the quote is in. */
      field: string;
      /** The quoted words as they stand in the record. */
      text: string;
    }
  | { found: false; why: QuoteProblem };

/**
 * Why a quote does not count: it has no letter and no number; it is longer
 * than a quote may be; it is a part of a text and too short to mean much; or
 * it is not in the record.
 */
export type QuoteProblem = 'empty' | 'too-long' | 'too-short' | 'not-in-record';

/** Quotation marks, apostrophes and dashes in the forms a text can have them, and the plain form of each. */
const PLAIN = new Map<number, string>([
  ...[0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x02bc, 0x0060, 0x00b4].map(
    (code): [number, string] => [code, "'"],
  ),
  ...[0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb].map((code): [number, string] => [
    code,
    '"',
  ]),
  ...[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((code): [number, string] => [
    code,
    '-',
  ]),
]);

/** A text made plain for comparing, with where each of its characters came from. */
interface Folded {
  text: string;
  /** For each character of `text`, where the character it was made of starts in the source. */
  from: number[];
  /** And where that character ends. */
  to: number[];
}

function fold(source: string): Folded {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let index = 0;
  for (const char of source) {
    const start = index;
    index += char.length;
    // A mark is made plain before the forms of a letter are: some marks have a
    // form of their own that is no mark (an acute accent, a double prime).
    let piece = PLAIN.get(char.codePointAt(0) ?? 0) ?? '';
    if (piece === '') {
      for (const part of char.normalize('NFKC').toLowerCase()) {
        piece += PLAIN.get(part.codePointAt(0) ?? 0) ?? part;
      }
    }
    if (/^\s+$/u.test(piece)) {
      // A run of white space is one space, and a text does not start with one.
      if (text === '' || text.endsWith(' ')) continue;
      piece = ' ';
    }
    text += piece;
    for (let unit = 0; unit < piece.length; unit += 1) {
      from.push(start);
      to.push(index);
    }
  }
  return { text, from, to };
}

/** A letter, a number, or a mark that belongs to a letter. */
const WORD = '[\\p{L}\\p{N}\\p{M}]';
const CORE = new RegExp(`[\\p{L}\\p{N}](?:.*${WORD})?`, 'su');
const WORD_BEFORE = new RegExp(`${WORD}$`, 'u');
const WORD_AFTER = new RegExp(`^${WORD}`, 'u');

/** Where a folded text starts and ends once what is no letter and no number is taken off both ends; null when nothing is left. */
function core(text: string): { start: number; end: number } | null {
  const match = CORE.exec(text);
  return match === null ? null : { start: match.index, end: match.index + match[0].length };
}

/**
 * Where a quote stands in a folded text as a run of whole words; -1 when it
 * does not. A character of a record can fold into several ("½" into "1⁄2").
 * A quote that starts or ends inside such a character does not count: "1851"
 * is not in "185½", though the folded text starts with it. Nor does one that
 * ends where a text was cut ("1850…"): the word may have gone on.
 */
function wordsAt(folded: Folded, quote: string): number {
  const { text, from } = folded;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const end = at + quote.length;
    const whole =
      (at === 0 || from[at - 1] !== from[at]) &&
      (end === text.length || from[end - 1] !== from[end]) &&
      !text.startsWith('...', end);
    if (whole && !WORD_BEFORE.test(text.slice(0, at)) && !WORD_AFTER.test(text.slice(end))) {
      return at;
    }
  }
  return -1;
}

/** The texts of a record made plain, worked out once for each record. */
const foldedFields = new WeakMap<SharedRecord, FoldedField[]>();

interface FoldedField {
  field: SharedField;
  folded: Folded;
  core: { start: number; end: number } | null;
}

function fieldsOf(record: SharedRecord): FoldedField[] {
  let fields = foldedFields.get(record);
  if (fields === undefined) {
    fields = record.fields.map((field) => {
      const folded = fold(field.value);
      return { field, folded, core: core(folded.text) };
    });
    foldedFields.set(record, fields);
  }
  return fields;
}

/**
 * Looks a quote up in the texts of a record that was passed on. The first
 * text that has it counts, a text the quote is the whole of before one it is
 * a part of.
 */
export function findQuote(quote: unknown, record: SharedRecord): QuoteCheck {
  if (typeof quote !== 'string') return { found: false, why: 'empty' };
  if (quote.length > QUOTE_MAX) return { found: false, why: 'too-long' };
  const asked = fold(quote.normalize('NFC'));
  const askedCore = core(asked.text);
  if (askedCore === null) return { found: false, why: 'empty' };
  const wanted = asked.text.slice(askedCore.start, askedCore.end);

  const fields = fieldsOf(record);
  for (const entry of fields) {
    if (entry.core === null) continue;
    if (entry.folded.text.slice(entry.core.start, entry.core.end) === wanted) {
      // The whole text as it stands, with the mark of where it was cut, if it was.
      return { found: true, field: entry.field.name, text: entry.field.value };
    }
  }
  if (wanted.length < QUOTE_PART_MIN) return { found: false, why: 'too-short' };
  for (const entry of fields) {
    const at = wordsAt(entry.folded, wanted);
    if (at !== -1) {
      const { from, to } = entry.folded;
      return {
        found: true,
        field: entry.field.name,
        text: entry.field.value.slice(from[at], to[at + wanted.length - 1]),
      };
    }
  }
  return { found: false, why: 'not-in-record' };
}
