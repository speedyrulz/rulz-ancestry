/**
 * The document model of a report: a small typed tree that every kind of
 * report is built into, and that `renderHtml` turns into one self-contained
 * HTML page (and from that, in the app, into a PDF or a printout).
 *
 * The model holds only what may be printed. A report about living people is
 * made by leaving their facts out when the model is built, so a living person
 * is a {@link PersonRef} that has no name, dates or id to print.
 */

/** The kinds of report the app makes. Each needs a row in the leak test of `@rulz/db`. */
export const REPORT_KINDS = ['family-group'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * A person in a report: either shown, with the name and years the report
 * prints, or "Living", which carries nothing else.
 */
export type PersonRef =
  | { readonly living: true }
  | { readonly living: false; readonly name: string; readonly lifespan: string };

/** A person left out of the report's facts. */
export const LIVING_REF: PersonRef = { living: true };

/** A superscript number that points at an endnote. */
export interface NoteMark {
  readonly kind: 'note';
  readonly number: number;
}

/** A person inside a line of text. */
export interface PersonSpan {
  readonly kind: 'person';
  readonly person: PersonRef;
}

/** A line of text: plain strings, people and endnote marks. */
export type Inline = readonly (string | PersonSpan | NoteMark)[];

export interface KeyValueRow {
  readonly label: string;
  readonly value: Inline;
}

export type Block =
  | { readonly kind: 'heading'; readonly level: 3 | 4; readonly text: string }
  | { readonly kind: 'paragraph'; readonly content: Inline }
  | { readonly kind: 'keyValues'; readonly rows: readonly KeyValueRow[] }
  | {
      readonly kind: 'table';
      readonly caption: string;
      readonly head: readonly string[];
      readonly rows: readonly (readonly Inline[])[];
    }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly Inline[] }
  /**
   * A drawing made by the app, for charts. The markup is checked when it is
   * rendered: no script, no link and no address of any kind.
   */
  | { readonly kind: 'svg'; readonly title: string; readonly svg: string };

export interface ReportSection {
  /** The heading of the section; empty for none. */
  readonly title: string;
  readonly blocks: readonly Block[];
  /** Starts the section on a new page when printed. */
  readonly pageBreakBefore?: boolean;
}

export interface ReportDocument {
  /** Also the title of the HTML page and of the PDF. */
  readonly title: string;
  readonly subtitle?: string;
  /** Facts about the report itself, shown under the title: who it is for, what was left out. */
  readonly metadata: readonly KeyValueRow[];
  readonly sections: readonly ReportSection[];
}

/** The person a report prints for a name and years. */
export function shownPerson(name: string, lifespan = ''): PersonRef {
  return { living: false, name, lifespan };
}

/** A person as a piece of a line of text. */
export function personSpan(person: PersonRef): PersonSpan {
  return { kind: 'person', person };
}

/** An endnote mark as a piece of a line of text. */
export function noteMark(number: number): NoteMark {
  return { kind: 'note', number };
}

/** What a person is called in a title or a file name: their name, or "Living". */
export function personLabel(person: PersonRef): string {
  return person.living ? 'Living' : person.name === '' ? 'Name not recorded' : person.name;
}
