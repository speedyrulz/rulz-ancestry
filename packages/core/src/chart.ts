/**
 * Where everything goes in the four charts: pedigree (ancestors), descendants,
 * hourglass (both) and fan. The functions take who is related to whom and
 * give back positions; they know nothing of names, colours or the screen, so
 * they can be tested as plain arithmetic.
 *
 * The box charts read left to right: a pedigree has the person on the left
 * and each older generation one column to the right; a descendant chart has
 * each younger generation one column to the right; an hourglass puts the
 * ancestors to the right of the person and the descendants to the left.
 */

/** One ancestor in a pedigree. Slots are numbered as in an Ahnentafel. */
export interface AncestorSlot {
  /**
   * 1 is the person the chart is for, 2 their father and 3 their mother; the
   * parents of slot n are 2n and 2n + 1. Where the sexes are not as that
   * names them, the first parent recorded takes the even slot.
   */
  slot: number;
  personId: string;
  /** True when this person has parents who are not in the chart. */
  more: boolean;
}

/** A person in a descendant chart, with each partnership and its children. */
export interface DescendantNode {
  personId: string;
  unions: DescendantUnion[];
  /** True when this person has children who are not in the chart. */
  more: boolean;
}

export interface DescendantUnion {
  /** The other parent, or null when not known. */
  partnerId: string | null;
  children: DescendantNode[];
}

export interface ChartMetrics {
  boxWidth: number;
  boxHeight: number;
  /** Space between two generations. */
  gapX: number;
  /** Space between two boxes of one generation. */
  gapY: number;
  /** Space between a person and the partner drawn under them. */
  partnerGap: number;
  /** Space around the whole chart. */
  padding: number;
}

export const CHART_METRICS: ChartMetrics = {
  boxWidth: 200,
  boxHeight: 48,
  gapX: 48,
  gapY: 12,
  partnerGap: 4,
  padding: 24,
};

export type ChartRole = 'root' | 'ancestor' | 'descendant' | 'partner';

export interface ChartBox {
  /** Unique within the chart. One person can have several boxes. */
  key: string;
  personId: string;
  role: ChartRole;
  /** The top left corner. */
  x: number;
  y: number;
  /** True when the chart stops here although the tree goes on. */
  more: boolean;
}

export interface ChartLine {
  key: string;
  /** An SVG path from one box to another. */
  d: string;
}

export interface BoxChart {
  width: number;
  height: number;
  boxWidth: number;
  boxHeight: number;
  boxes: ChartBox[];
  lines: ChartLine[];
}

interface Link {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * How far the upright part of the line stands from the middle of the gap.
   * Lines from different partners of one person get different values, so the
   * children of each can be told apart.
   */
  offset?: number;
}

interface Draft {
  boxes: ChartBox[];
  links: Link[];
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Moves a draft so that it starts at the padding, and turns its links into paths. */
function finish(draft: Draft, metrics: ChartMetrics): BoxChart {
  const { boxWidth, boxHeight, padding } = metrics;
  if (draft.boxes.length === 0) {
    return { width: 0, height: 0, boxWidth, boxHeight, boxes: [], lines: [] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of draft.boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + boxWidth);
    maxY = Math.max(maxY, box.y + boxHeight);
  }
  const dx = padding - minX;
  const dy = padding - minY;
  return {
    width: round(maxX - minX + 2 * padding),
    height: round(maxY - minY + 2 * padding),
    boxWidth,
    boxHeight,
    boxes: draft.boxes.map((box) => ({ ...box, x: round(box.x + dx), y: round(box.y + dy) })),
    lines: draft.links.map((link) => {
      const x1 = round(link.x1 + dx);
      const x2 = round(link.x2 + dx);
      const y1 = round(link.y1 + dy);
      const y2 = round(link.y2 + dy);
      // Out of one box, across to the middle of the gap, along it, and into the other.
      const bend = round((x1 + x2) / 2 + (link.offset ?? 0));
      return { key: link.key, d: `M ${x1} ${y1} H ${bend} V ${y2} H ${x2}` };
    }),
  };
}

/** The generation of a slot: 0 for the person, 1 for parents, 2 for grandparents. */
export function slotGeneration(slot: number): number {
  return Math.floor(Math.log2(Math.max(1, slot)));
}

/**
 * Places the ancestors. A leaf takes one row. A person with parents sits
 * midway between them; when only one parent is known the other's row is left
 * empty, so the father's side is always above and the mother's below.
 * Returns the middle of the root box, or null when there is no root.
 */
function placeAncestors(
  slots: readonly AncestorSlot[],
  metrics: ChartMetrics,
  draft: Draft,
): number | null {
  const bySlot = new Map(slots.map((entry) => [entry.slot, entry]));
  if (!bySlot.has(1)) return null;
  const { boxWidth, boxHeight, gapX, gapY } = metrics;
  const step = boxHeight + gapY;
  const centers = new Map<number, number>();
  let cursor = 0;

  const row = (): number => {
    const center = cursor + boxHeight / 2;
    cursor += step;
    return center;
  };
  const place = (slot: number, generation: number): number => {
    const father = bySlot.has(slot * 2);
    const mother = bySlot.has(slot * 2 + 1);
    let center: number;
    if (!father && !mother) {
      center = row();
    } else {
      const above = father ? place(slot * 2, generation + 1) : row();
      const below = mother ? place(slot * 2 + 1, generation + 1) : row();
      center = (above + below) / 2;
    }
    centers.set(slot, center);
    const entry = bySlot.get(slot);
    if (entry) {
      draft.boxes.push({
        key: `a${slot}`,
        personId: entry.personId,
        role: slot === 1 ? 'root' : 'ancestor',
        x: generation * (boxWidth + gapX),
        y: center - boxHeight / 2,
        more: entry.more,
      });
    }
    return center;
  };
  const rootCenter = place(1, 0);

  for (const [slot, center] of centers) {
    if (slot === 1) continue;
    const child = Math.floor(slot / 2);
    const childCenter = centers.get(child);
    if (childCenter === undefined) continue;
    const generation = slotGeneration(slot);
    draft.links.push({
      key: `a${slot}`,
      x1: (generation - 1) * (boxWidth + gapX) + boxWidth,
      y1: childCenter,
      x2: generation * (boxWidth + gapX),
      y2: center,
    });
  }
  return rootCenter;
}

/**
 * Places the descendants. Each person's partners are stacked under them, and
 * the children of a partnership hang from that partner's box (or from the
 * person's own box when the other parent is not known). A person is centred
 * on their children. `direction` 1 grows to the right, -1 to the left.
 * Returns the top of the root box.
 */
function placeDescendants(
  root: DescendantNode,
  metrics: ChartMetrics,
  draft: Draft,
  direction: 1 | -1,
): number {
  const { boxWidth, boxHeight, gapX, gapY, partnerGap } = metrics;
  const columnX = (depth: number) => direction * depth * (boxWidth + gapX);
  /** The side of a box its children hang from, and the side a child is reached on. */
  const outX = (x: number) => (direction === 1 ? x + boxWidth : x);
  const inX = (x: number) => (direction === 1 ? x : x + boxWidth);
  let cursor = 0;
  let counter = 0;

  const place = (node: DescendantNode, depth: number): { top: number; center: number } => {
    const key = `d${counter}`;
    counter += 1;
    const partners = node.unions.filter((union) => union.partnerId !== null).length;
    const unitHeight = boxHeight + partners * (boxHeight + partnerGap);
    const start = cursor;
    const firstBox = draft.boxes.length;
    const firstLink = draft.links.length;

    const children: { union: number; center: number }[] = [];
    node.unions.forEach((union, index) => {
      for (const child of union.children) {
        children.push({ union: index, center: place(child, depth + 1).center });
      }
    });

    let top: number;
    if (children.length === 0) {
      top = start;
      cursor = start + unitHeight + gapY;
    } else {
      const blockHeight = cursor - gapY - start;
      if (unitHeight > blockHeight) {
        // The person and their partners are taller than their children: move
        // the children down so they are centred on the taller side.
        const shift = (unitHeight - blockHeight) / 2;
        for (const box of draft.boxes.slice(firstBox)) box.y += shift;
        for (const link of draft.links.slice(firstLink)) {
          link.y1 += shift;
          link.y2 += shift;
        }
        for (const child of children) child.center += shift;
        top = start;
        cursor = start + unitHeight + gapY;
      } else {
        top = start + (blockHeight - unitHeight) / 2;
      }
    }

    const x = columnX(depth);
    draft.boxes.push({
      key,
      personId: node.personId,
      role: depth === 0 ? 'root' : 'descendant',
      x,
      y: top,
      more: node.more,
    });
    const anchors: number[] = [];
    let below = 0;
    node.unions.forEach((union, index) => {
      if (union.partnerId === null) {
        anchors[index] = top + boxHeight / 2;
        return;
      }
      below += 1;
      const y = top + below * (boxHeight + partnerGap);
      draft.boxes.push({
        key: `${key}p${index}`,
        personId: union.partnerId,
        role: 'partner',
        x,
        y,
        more: false,
      });
      anchors[index] = y + boxHeight / 2;
    });
    // Each partnership with children gets its own upright line in the gap.
    const withChildren = [...new Set(children.map((child) => child.union))];
    const spread = Math.min(10, (gapX - 16) / Math.max(1, withChildren.length - 1));
    children.forEach((child, index) => {
      const place = withChildren.indexOf(child.union) - (withChildren.length - 1) / 2;
      draft.links.push({
        key: `${key}c${index}`,
        x1: outX(x),
        y1: anchors[child.union] ?? top + boxHeight / 2,
        x2: inX(columnX(depth + 1)),
        y2: child.center,
        // The first partnership bends nearest the children, so its lines cross none of the others.
        offset: -direction * place * spread,
      });
    });
    return { top, center: top + boxHeight / 2 };
  };

  return place(root, 0).top;
}

/** A pedigree: the person on the left, each older generation a column to the right. */
export function layoutPedigree(
  slots: readonly AncestorSlot[],
  metrics: ChartMetrics = CHART_METRICS,
): BoxChart {
  const draft: Draft = { boxes: [], links: [] };
  placeAncestors(slots, metrics, draft);
  return finish(draft, metrics);
}

/** A descendant chart: the person on the left, each younger generation a column to the right. */
export function layoutDescendants(
  root: DescendantNode,
  metrics: ChartMetrics = CHART_METRICS,
): BoxChart {
  const draft: Draft = { boxes: [], links: [] };
  placeDescendants(root, metrics, draft, 1);
  return finish(draft, metrics);
}

/** An hourglass: ancestors to the right of the person, descendants to the left. */
export function layoutHourglass(
  slots: readonly AncestorSlot[],
  root: DescendantNode,
  metrics: ChartMetrics = CHART_METRICS,
): BoxChart {
  const up: Draft = { boxes: [], links: [] };
  const rootCenter = placeAncestors(slots, metrics, up);
  const down: Draft = { boxes: [], links: [] };
  const rootTop = placeDescendants(root, metrics, down, -1);
  if (rootCenter === null) return finish(down, metrics);

  // Line the two halves up on the person, who is drawn once.
  const shift = rootCenter - metrics.boxHeight / 2 - rootTop;
  const draft: Draft = {
    boxes: [
      ...up.boxes,
      ...down.boxes
        .filter((box) => box.role !== 'root')
        .map((box) => ({ ...box, y: box.y + shift })),
    ],
    links: [
      ...up.links,
      ...down.links.map((link) => ({ ...link, y1: link.y1 + shift, y2: link.y2 + shift })),
    ],
  };
  return finish(draft, metrics);
}

/** One ancestor's place in a fan chart, or an empty place where no ancestor is recorded. */
export interface FanSegment {
  key: string;
  slot: number;
  generation: number;
  personId: string | null;
  more: boolean;
  /** The outline of the segment as an SVG path. */
  d: string;
  /** Where the text is centred, and how far it is turned, in degrees. */
  textX: number;
  textY: number;
  rotate: number;
  /** True when the text runs along the radius, not around the ring. */
  radial: boolean;
  /** Roughly how many lines of text fit, and how many letters in a line. */
  lines: number;
  chars: number;
}

export interface FanChart {
  width: number;
  height: number;
  /** The middle of the circle the person the chart is for is drawn in. */
  centerX: number;
  centerY: number;
  rootRadius: number;
  generations: number;
  segments: FanSegment[];
}

/** A fan shows at most this many generations of ancestors; beyond it the text cannot be read. */
export const FAN_MAX_GENERATIONS = 6;

const FAN_ROOT_RADIUS = 64;
const FAN_PADDING = 24;
/** How deep each ring is, and whether its text runs along the radius. */
const FAN_RINGS = [
  { depth: 64, radial: false },
  { depth: 64, radial: false },
  { depth: 72, radial: false },
  { depth: 124, radial: true },
  { depth: 124, radial: true },
  { depth: 124, radial: true },
] as const;
/** The average width of a letter and the height of a line, in the fan's text size. */
const FAN_LETTER = 6.6;
const FAN_LINE = 15;

/**
 * A fan chart: a half circle above the person, one ring per generation, the
 * father's side on the left. Every place up to the oldest generation shown is
 * given, with `personId` null where nobody is recorded.
 */
export function layoutFan(
  slots: readonly AncestorSlot[],
  maxGenerations: number = FAN_MAX_GENERATIONS,
): FanChart {
  const limit = Math.min(Math.max(1, Math.trunc(maxGenerations)), FAN_MAX_GENERATIONS);
  const bySlot = new Map(slots.map((entry) => [entry.slot, entry]));
  let generations = 0;
  for (const entry of slots) {
    const generation = slotGeneration(entry.slot);
    if (generation <= limit) generations = Math.max(generations, generation);
  }
  generations = Math.max(generations, 1);

  let radius = FAN_ROOT_RADIUS;
  for (let ring = 0; ring < generations; ring += 1) radius += FAN_RINGS[ring]?.depth ?? 0;
  const centerX = FAN_PADDING + radius;
  const centerY = FAN_PADDING + radius;
  const point = (r: number, angle: number): string =>
    `${round(centerX + r * Math.cos(angle))} ${round(centerY + r * Math.sin(angle))}`;

  const segments: FanSegment[] = [];
  let inner = FAN_ROOT_RADIUS;
  for (let generation = 1; generation <= generations; generation += 1) {
    const ring = FAN_RINGS[generation - 1];
    if (!ring) break;
    const outer = inner + ring.depth;
    const count = 2 ** generation;
    const sweep = Math.PI / count;
    for (let index = 0; index < count; index += 1) {
      const slot = count + index;
      const entry = bySlot.get(slot) ?? null;
      // Angles run from the left (pi) over the top to the right (2 pi).
      const from = Math.PI + index * sweep;
      const to = from + sweep;
      const middle = from + sweep / 2;
      const middleRadius = (inner + outer) / 2;
      const degrees = (middle * 180) / Math.PI;
      const arc = middleRadius * sweep;
      segments.push({
        key: `f${slot}`,
        slot,
        generation,
        personId: entry?.personId ?? null,
        more: entry?.more ?? false,
        d: [
          `M ${point(inner, from)}`,
          `A ${inner} ${inner} 0 0 1 ${point(inner, to)}`,
          `L ${point(outer, to)}`,
          `A ${outer} ${outer} 0 0 0 ${point(outer, from)}`,
          'Z',
        ].join(' '),
        textX: round(centerX + middleRadius * Math.cos(middle)),
        textY: round(centerY + middleRadius * Math.sin(middle)),
        // Around the ring the text is upright at the top. Along the radius it
        // reads towards the middle on the left half and away from it on the right.
        rotate: round(ring.radial ? (degrees < 270 ? degrees + 180 : degrees) : degrees + 90),
        radial: ring.radial,
        lines: ring.radial
          ? Math.min(3, Math.max(1, Math.floor((inner * sweep - 4) / FAN_LINE)))
          : Math.min(4, Math.max(1, Math.floor((ring.depth - 8) / FAN_LINE))),
        chars: Math.max(3, Math.floor(((ring.radial ? ring.depth : arc) - 14) / FAN_LETTER)),
      });
    }
    inner = outer;
  }

  return {
    width: round(2 * radius + 2 * FAN_PADDING),
    height: round(radius + FAN_ROOT_RADIUS + 2 * FAN_PADDING),
    centerX,
    centerY,
    rootRadius: FAN_ROOT_RADIUS,
    generations,
    segments,
  };
}
