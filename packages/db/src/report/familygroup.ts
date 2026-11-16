import {
  noteMark,
  personLabel,
  personSpan,
  type Block,
  type Inline,
  type KeyValueRow,
  type ReportDocument,
  type ReportSection,
} from '@rulz/core';
import { listFamilyEvents, listPersonEvents, type TreeEvent } from '../events';
import {
  listChildren,
  listFamiliesAsChild,
  listFamiliesAsPartner,
  requireFamily,
} from '../families';
import { listMedia, type MediaTarget } from '../media';
import { sortEventsForDisplay } from '../personpage';
import { getPerson } from '../persons';
import { listCitations, type CitationTarget, type CitedSource } from '../sources';
import type { Tree } from '../tree';
import {
  ReportFilter,
  ReportRefusedError,
  type ReportOmissions,
  type ReportPrivacy,
} from './filter';

/**
 * The family group sheet: one couple, their parents, the events of the couple,
 * their children with their partners, and the sources as numbered endnotes.
 *
 * Every person is read through the {@link ReportFilter}. A person it hides is
 * a line that says "Living" and nothing more is read about them, and nothing
 * is said of a couple when either partner is hidden.
 */

/** What a report builder returns: the document and what it left out. */
export interface ReportBuild extends ReportOmissions {
  model: ReportDocument;
}

const SEX_WORDS: Readonly<Record<string, string>> = {
  M: 'Male',
  F: 'Female',
  X: 'Other',
  U: 'Not known',
};

const PEDIGREE_WORDS: Readonly<Record<string, string>> = {
  adopted: 'adopted',
  foster: 'foster child',
  step: 'step-child',
  sealing: 'sealed',
  other: 'other tie',
};

const BIRTH = ['birth'];
const CHRISTENING = ['baptism', 'christening'];
const DEATH = ['death'];
const BURIAL = ['burial'];
const CREMATION = ['cremation'];

/** A stored value such as an event type as a label: "naturalization" gives "Naturalization". */
function labelOf(value: string): string {
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text === '' ? 'Event' : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The citations of the sheet, numbered in the order they are first met. */
class Endnotes {
  readonly items: CitedSource[] = [];
  readonly #numbers = new Map<string, number>();

  marks(tree: Tree, target: CitationTarget): Inline {
    return listCitations(tree, target).map((citation) => {
      let number = this.#numbers.get(citation.id);
      if (number === undefined) {
        this.items.push(citation);
        number = this.items.length;
        this.#numbers.set(citation.id, number);
      }
      return noteMark(number);
    });
  }
}

/** The pictures and documents of what the sheet shows; each is listed once. */
class Pictures {
  readonly titles = new Map<string, string>();

  constructor(private readonly filter: ReportFilter) {}

  of(tree: Tree, target: MediaTarget): void {
    for (const media of listMedia(tree, target)) {
      if (this.filter.media(media.id)) {
        this.titles.set(media.id, media.title !== '' ? media.title : media.fileName);
      }
    }
  }
}

interface Context {
  tree: Tree;
  filter: ReportFilter;
  endnotes: Endnotes;
  pictures: Pictures;
}

/** One event as a line: date, place, detail, the endnote marks and, where allowed, the note. */
function eventLine(ctx: Context, event: TreeEvent): Inline {
  const when = [event.dateText, event.placeText].filter((part) => part !== '').join(', ');
  const detail = event.description === '' ? '' : `(${event.description})`;
  const head = [when, detail].filter((part) => part !== '').join(' ');
  const note = ctx.filter.note(event.note);
  ctx.pictures.of(ctx.tree, { type: 'event', id: event.id });
  return [
    head === '' ? 'Date and place not recorded' : head,
    ...ctx.endnotes.marks(ctx.tree, { type: 'event', id: event.id }),
    ...(note === '' ? [] : [`\nNote: ${note}`]),
  ];
}

/** Every event of the given types as a row, or nothing when there is none. */
function eventRows(
  ctx: Context,
  label: string,
  events: readonly TreeEvent[],
  types: readonly string[],
): KeyValueRow[] {
  const found = events.filter((event) => types.includes(event.type));
  if (found.length === 0) return [];
  const value: (string | Inline[number])[] = [];
  found.forEach((event, index) => {
    if (index > 0) value.push('\n');
    value.push(...eventLine(ctx, event));
  });
  return [{ label, value }];
}

/** "A and B", or the people of a list of lines joined by "; ". */
function peopleLine(parts: readonly Inline[], between: string): Inline {
  return parts.flatMap((part, index) => (index === 0 ? part : [between, ...part]));
}

function parentsOf(ctx: Context, personId: string): Inline | null {
  const lines: Inline[] = [];
  for (const link of listFamiliesAsChild(ctx.tree, personId)) {
    const family = requireFamily(ctx.tree, link.familyId);
    const parents = [family.partner1Id, family.partner2Id]
      .filter((id): id is string => id !== null)
      .map((id): Inline => [personSpan(ctx.filter.person(ctx.tree, id))]);
    if (parents.length === 0) continue;
    const tie = PEDIGREE_WORDS[link.pedigree];
    lines.push([...peopleLine(parents, ' and '), ...(tie === undefined ? [] : [` (${tie})`])]);
  }
  return lines.length === 0 ? null : peopleLine(lines, '\n');
}

/** "Husband", "Wife" or "Partner"; a hidden partner's sex is not read. */
function partnerTitle(ctx: Context, personId: string): string {
  if (ctx.filter.hides(personId)) return 'Partner';
  const sex = getPerson(ctx.tree, personId)?.sex ?? 'U';
  return sex === 'M' ? 'Husband' : sex === 'F' ? 'Wife' : 'Partner';
}

function partnerBlocks(ctx: Context, personId: string): Block[] {
  const title = partnerTitle(ctx, personId);
  const nameRow: KeyValueRow = {
    label: 'Name',
    value: [personSpan(ctx.filter.person(ctx.tree, personId))],
  };
  if (ctx.filter.hides(personId)) {
    return [
      { kind: 'heading', level: 3, text: title },
      { kind: 'keyValues', rows: [nameRow] },
    ];
  }
  const events = sortEventsForDisplay(listPersonEvents(ctx.tree, personId));
  ctx.pictures.of(ctx.tree, { type: 'person', id: personId });
  const rows: KeyValueRow[] = [
    {
      label: nameRow.label,
      value: [...nameRow.value, ...ctx.endnotes.marks(ctx.tree, { type: 'person', id: personId })],
    },
    ...eventRows(ctx, 'Born', events, BIRTH),
    ...eventRows(ctx, 'Christened', events, CHRISTENING),
    ...eventRows(ctx, 'Died', events, DEATH),
    ...eventRows(ctx, 'Buried', events, BURIAL),
    ...eventRows(ctx, 'Cremated', events, CREMATION),
  ];
  const parents = parentsOf(ctx, personId);
  if (parents !== null) rows.push({ label: 'Parents', value: parents });
  const note = ctx.filter.note(getPerson(ctx.tree, personId)?.note ?? '');
  if (note !== '') rows.push({ label: 'Note', value: [note] });
  return [
    { kind: 'heading', level: 3, text: title },
    { kind: 'keyValues', rows },
  ];
}

function childRow(ctx: Context, childId: string, pedigree: string): Inline[] {
  if (ctx.filter.hides(childId))
    return [[personSpan(ctx.filter.person(ctx.tree, childId))], [], [], [], []];
  const events = sortEventsForDisplay(listPersonEvents(ctx.tree, childId));
  ctx.pictures.of(ctx.tree, { type: 'person', id: childId });
  const note = ctx.filter.note(getPerson(ctx.tree, childId)?.note ?? '');
  const line = (types: readonly string[]): Inline => {
    const found = events.filter((event) => types.includes(event.type));
    return found.flatMap((event, index) =>
      index === 0 ? eventLine(ctx, event) : ['\n', ...eventLine(ctx, event)],
    );
  };
  const tie = PEDIGREE_WORDS[pedigree];
  const partners = listFamiliesAsPartner(ctx.tree, childId).flatMap((family) => {
    const other = family.partner1Id === childId ? family.partner2Id : family.partner1Id;
    return other === null ? [] : [[personSpan(ctx.filter.person(ctx.tree, other))] as Inline];
  });
  return [
    [
      personSpan(ctx.filter.person(ctx.tree, childId)),
      ...(tie === undefined ? [] : [` (${tie})`]),
      ...ctx.endnotes.marks(ctx.tree, { type: 'person', id: childId }),
      ...(note === '' ? [] : [`\nNote: ${note}`]),
    ],
    [SEX_WORDS[getPerson(ctx.tree, childId)?.sex ?? 'U'] ?? ''],
    line(BIRTH),
    line(DEATH),
    peopleLine(partners, ', '),
  ];
}

function citationLine(ctx: Context, citation: CitedSource): Inline {
  const title = citation.sourceTitle === '' ? 'Source without a title' : citation.sourceTitle;
  const where = citation.page === '' ? '' : `, ${citation.page}`;
  const text = ctx.filter.citationText(citation.text);
  const note = ctx.filter.note(citation.note);
  return [
    `${title}${where}.`,
    ...(text === '' ? [] : [`\nText: ${text}`]),
    ...(note === '' ? [] : [`\nNote: ${note}`]),
  ];
}

/**
 * Builds the family group sheet of one family. Throws a
 * {@link ReportRefusedError} when the filter is on and every partner of the
 * family is living, since nothing of the family could then be shown.
 */
export function buildFamilyGroupSheet(
  tree: Tree,
  familyId: string,
  privacy: ReportPrivacy,
): ReportBuild {
  const family = requireFamily(tree, familyId);
  const filter = new ReportFilter(privacy);
  const partnerIds = [family.partner1Id, family.partner2Id].filter(
    (id): id is string => id !== null,
  );
  if (partnerIds.length > 0 && partnerIds.every((id) => filter.hides(id))) {
    throw new ReportRefusedError(
      'Everyone this family sheet is about may be living, so there is nothing about them that can be shown. ' +
        'Include living people to make it.',
    );
  }

  // One consistent picture, even though it takes many small reads.
  return tree.db.transaction((): ReportBuild => {
    const ctx: Context = {
      tree,
      filter,
      endnotes: new Endnotes(),
      pictures: new Pictures(filter),
    };
    const sections: ReportSection[] = [];

    const partnerBlocksAll = partnerIds.flatMap((id) => partnerBlocks(ctx, id));
    sections.push({ title: 'Partners', blocks: partnerBlocksAll });

    // What is said of the couple goes when either partner is left out.
    const whole = partnerIds.every((id) => !filter.hides(id));
    if (whole) {
      const events = sortEventsForDisplay(listFamilyEvents(tree, family.id));
      const rows: KeyValueRow[] = events.map((event) => ({
        label: labelOf(event.type),
        value: eventLine(ctx, event),
      }));
      const marks = ctx.endnotes.marks(tree, { type: 'family', id: family.id });
      if (marks.length > 0) rows.push({ label: 'Sources for the family', value: marks });
      ctx.pictures.of(tree, { type: 'family', id: family.id });
      sections.push({
        title: 'The couple',
        blocks:
          rows.length === 0
            ? [
                {
                  kind: 'paragraph',
                  content: ['No marriage or other event of the couple is recorded.'],
                },
              ]
            : [{ kind: 'keyValues', rows }],
      });
    } else {
      sections.push({
        title: 'The couple',
        blocks: [
          {
            kind: 'paragraph',
            content: ['What is recorded of this couple is left out, because a partner is living.'],
          },
        ],
      });
    }

    const children = listChildren(tree, family.id);
    sections.push({
      title: 'Children',
      blocks:
        children.length === 0
          ? [{ kind: 'paragraph', content: ['No children are recorded.'] }]
          : [
              {
                kind: 'table',
                caption: 'Children of this family',
                head: ['Name', 'Sex', 'Born', 'Died', 'Partners'],
                rows: children.map((child) => childRow(ctx, child.childId, child.pedigree)),
              },
            ],
    });

    // Pictures and documents of the citations are found once the citations are known.
    for (const citation of ctx.endnotes.items) {
      ctx.pictures.of(tree, { type: 'citation', id: citation.id });
    }
    if (ctx.pictures.titles.size > 0) {
      sections.push({
        title: 'Pictures and documents',
        blocks: [
          {
            kind: 'list',
            ordered: false,
            items: [...ctx.pictures.titles.values()].map((title) => [title]),
          },
        ],
      });
    }
    if (ctx.endnotes.items.length > 0) {
      sections.push({
        title: 'Sources',
        blocks: [
          {
            kind: 'list',
            ordered: true,
            items: ctx.endnotes.items.map((citation) => citationLine(ctx, citation)),
          },
        ],
      });
    }

    // The title is made from the same filtered people as the sheet itself.
    const names = partnerIds.map((id) => personLabel(filter.person(tree, id)));
    const title =
      names.length === 0 ? 'Family group sheet' : `Family group sheet: ${names.join(' and ')}`;
    const omissions = filter.omissions();
    const model: ReportDocument = {
      title,
      metadata: metadataOf(filter.includeLiving, omissions),
      sections,
    };
    return { model, ...omissions };
  })();
}

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export function metadataOf(
  includeLiving: boolean,
  omissions: ReportOmissions,
  /** What the count of hidden people counts: people, or places in a report where a person can repeat. */
  unit: 'people' | 'entries' = 'people',
): KeyValueRow[] {
  if (includeLiving) {
    return [{ label: 'Living people', value: ['Included in full.'] }];
  }
  const rows: KeyValueRow[] = [
    {
      label: 'Living people',
      value: [
        omissions.livingOmitted === 0
          ? 'Anyone who may be living would be shown only as "Living". No one is.'
          : `${
              unit === 'people'
                ? plural(omissions.livingOmitted, 'person is', 'people are')
                : plural(omissions.livingOmitted, 'entry is', 'entries are')
            } shown only as "Living".`,
      ],
    },
  ];
  const left: string[] = [];
  if (omissions.notesOmitted > 0) left.push(plural(omissions.notesOmitted, 'note', 'notes'));
  if (omissions.citationTextsOmitted > 0) {
    left.push(plural(omissions.citationTextsOmitted, 'source text', 'source texts'));
  }
  if (omissions.mediaOmitted > 0) {
    left.push(plural(omissions.mediaOmitted, 'picture or document', 'pictures and documents'));
  }
  if (left.length > 0) rows.push({ label: 'Left out', value: [left.join(', ')] });
  return rows;
}
