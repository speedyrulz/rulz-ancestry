import {
  CHART_PRINT_METRICS,
  LIVING_REF,
  MIN_PRINT_SCALE,
  REPORT_GENERATIONS,
  boxChartSvg,
  fanChartSvg,
  layoutDescendants,
  layoutFan,
  layoutHourglass,
  layoutPedigree,
  personLabel,
  planChartPage,
  type AncestorSlot,
  type BoxChart,
  type ChartReportKind,
  type DescendantNode,
  type KeyValueRow,
  type PersonRef,
  type ReportDocument,
} from '@rulz/core';
import { getAncestorSlots, getDescendantTree } from '../charts';
import { getPersonSummary } from '../search';
import { NotFoundError, type Tree } from '../tree';
import type { ReportBuild } from './familygroup';
import { metadataOf } from './familygroup';
import { ReportFilter, ReportRefusedError, type ReportPrivacy } from './filter';

/**
 * The four charts as reports: the same people and places as the charts on
 * the screen, laid out again for one page of paper and drawn as one SVG.
 *
 * The chart is read as who is related to whom, which holds no fact about
 * anyone. Every box then asks the {@link ReportFilter} what it may say of its
 * person, so a person the filter hides is drawn as "Living" and nothing of
 * them is read at all.
 */

const CHART_TITLES: Readonly<Record<ChartReportKind, string>> = {
  'chart-pedigree': 'Ancestor chart',
  'chart-descendants': 'Descendant chart',
  'chart-hourglass': 'Hourglass chart',
  'chart-fan': 'Fan chart',
};

/** What each chart shows of the generations asked for. */
const CHART_SUMMARIES: Readonly<Record<ChartReportKind, (beyond: number) => string>> = {
  'chart-pedigree': (beyond) => `ancestors back ${beyond} generation${beyond === 1 ? '' : 's'}`,
  'chart-descendants': (beyond) =>
    `descendants down ${beyond} generation${beyond === 1 ? '' : 's'}`,
  'chart-hourglass': (beyond) =>
    `ancestors back ${beyond} and descendants down ${beyond} generation${beyond === 1 ? '' : 's'}`,
  'chart-fan': (beyond) => `ancestors back ${beyond} generation${beyond === 1 ? '' : 's'}`,
};

/** The generations asked for, or a refusal that says what is allowed. */
export function requireGenerations(
  kind: keyof typeof REPORT_GENERATIONS,
  generations: number,
): number {
  const limit = REPORT_GENERATIONS[kind];
  if (!Number.isInteger(generations) || generations < limit.min || generations > limit.max) {
    throw new ReportRefusedError(
      `Choose between ${limit.min} and ${limit.max} generations for this report.`,
    );
  }
  return generations;
}

/** The ids a chart draws, once each. */
function idsOf(slots: readonly AncestorSlot[], root: DescendantNode | null): string[] {
  const ids = new Set<string>(slots.map((slot) => slot.personId));
  const walk = (node: DescendantNode): void => {
    ids.add(node.personId);
    for (const union of node.unions) {
      if (union.partnerId !== null) ids.add(union.partnerId);
      union.children.forEach(walk);
    }
  };
  if (root !== null) walk(root);
  return [...ids];
}

/**
 * Builds the chart of one person for paper. Throws a {@link ReportRefusedError}
 * when the filter is on and the person is living (there would be nothing to
 * show), or when the chart is too big to read on one page.
 */
export function buildChartReport(
  tree: Tree,
  kind: ChartReportKind,
  personId: string,
  generations: number,
  privacy: ReportPrivacy,
): ReportBuild {
  requireGenerations(kind, generations);
  if (getPersonSummary(tree, personId) === null) throw new NotFoundError('person', personId);
  const filter = new ReportFilter(privacy);
  if (filter.hides(personId)) {
    throw new ReportRefusedError(
      'This chart is of someone who may be living, so nothing about them can be shown. ' +
        'Include living people to make it.',
    );
  }
  const beyond = generations - 1;

  // One consistent picture, even though it takes many small reads.
  return tree.db.transaction((): ReportBuild => {
    const slots = kind === 'chart-descendants' ? [] : getAncestorSlots(tree, personId, beyond);
    const down =
      kind === 'chart-pedigree' || kind === 'chart-fan'
        ? null
        : getDescendantTree(tree, personId, beyond);

    // Everyone the chart draws is asked of the filter once, before anything is drawn.
    const labels = new Map<string, PersonRef>();
    for (const id of idsOf(slots, down?.root ?? null)) labels.set(id, filter.person(tree, id));
    const rootRef = labels.get(personId) ?? LIVING_REF;
    const label = (id: string): PersonRef | undefined => labels.get(id);

    let svg: string;
    let width: number;
    let height: number;
    if (kind === 'chart-fan') {
      const fan = layoutFan(slots, beyond);
      svg = fanChartSvg(fan, rootRef, label);
      for (const segment of fan.segments) {
        if (segment.personId !== null) filter.countLivingPlace(segment.personId);
      }
      ({ width, height } = fan);
    } else {
      const boxes: BoxChart =
        kind === 'chart-pedigree'
          ? layoutPedigree(slots, CHART_PRINT_METRICS)
          : kind === 'chart-descendants'
            ? layoutDescendants(
                down?.root ?? { personId, unions: [], more: false },
                CHART_PRINT_METRICS,
              )
            : layoutHourglass(
                slots,
                down?.root ?? { personId, unions: [], more: false },
                CHART_PRINT_METRICS,
              );
      svg = boxChartSvg(boxes, label);
      for (const box of boxes.boxes) filter.countLivingPlace(box.personId);
      ({ width, height } = boxes);
    }
    // A chart is saved whole or not at all.
    if (down?.truncated === true) {
      throw new ReportRefusedError(
        'This family is too large to show whole. Choose fewer generations.',
      );
    }
    const plan = planChartPage(width, height);
    if (plan.scale < MIN_PRINT_SCALE) {
      throw new ReportRefusedError(
        'This chart is too big to print on one page and still be read. Choose fewer generations.',
      );
    }

    // One person can fill several boxes, so the boxes that say "Living" are counted, not people.
    const omissions = { ...filter.omissions(), livingOmitted: filter.livingPlaces };
    const who = personLabel(rootRef);
    const title = `${CHART_TITLES[kind]}: ${who}`;
    const rows: KeyValueRow[] = [
      {
        label: 'Generations',
        value: [`${generations}: the person and ${CHART_SUMMARIES[kind](beyond)}.`],
      },
      ...metadataOf(filter.includeLiving, omissions, 'entries'),
    ];
    const model: ReportDocument = {
      title,
      metadata: rows,
      orientation: plan.orientation,
      sections: [
        {
          title: '',
          blocks: [{ kind: 'svg', title: `${CHART_TITLES[kind]} of ${who}`, svg, fitPage: true }],
        },
      ],
    };
    return { model, ...omissions };
  })();
}
