/**
 * The document model of a report: a small typed tree that every kind of
 * report is built into, and that `renderHtml` turns into one self-contained
 * HTML page (and from that, in the app, into a PDF or a printout).
 *
 * The model holds only what may be printed. A report about living people is
 * made by leaving their facts out when the model is built, so a living person
 * is a {@link PersonRef} that has no name, dates or id to print.
 */

/** The four charts, each a kind of report of one person. */
export const CHART_REPORT_KINDS = [
  'chart-pedigree',
  'chart-descendants',
  'chart-hourglass',
  'chart-fan',
] as const;
export type ChartReportKind = (typeof CHART_REPORT_KINDS)[number];

/** The kinds of report the app makes. Each needs a row in the leak test of `@rulz/db`. */
export const REPORT_KINDS = ['family-group', 'ahnentafel', ...CHART_REPORT_KINDS] as const;
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

/** The reports that are of one person and go back or down a number of generations. */
export type PersonReportKind = 'ahnentafel' | ChartReportKind;

/**
 * How many generations a report of one person may cover, counting the person
 * as the first. A chart is drawn on one page, so its limit is the most that
 * stays readable there (the text of a chart is never printed smaller than
 * half its size on screen); the Ahnentafel is a list and goes as far as the
 * charts and the tree do.
 */
export const REPORT_GENERATIONS: Readonly<
  Record<PersonReportKind, { min: number; max: number; initial: number }>
> = {
  ahnentafel: { min: 2, max: 10, initial: 6 },
  'chart-pedigree': { min: 2, max: 5, initial: 4 },
  'chart-descendants': { min: 2, max: 6, initial: 4 },
  'chart-hourglass': { min: 2, max: 4, initial: 3 },
  'chart-fan': { min: 2, max: 7, initial: 5 },
};

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
  | {
      readonly kind: 'svg';
      readonly title: string;
      readonly svg: string;
      /** True for a chart that is scaled to fit one page, whatever its size. */
      readonly fitPage?: boolean;
    };

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
  /** The way the paper is turned when printed; portrait when not given. */
  readonly orientation?: 'portrait' | 'landscape';
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
