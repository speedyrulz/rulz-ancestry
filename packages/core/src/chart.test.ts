import { describe, expect, it } from 'vitest';
import {
  CHART_METRICS,
  FAN_MAX_GENERATIONS,
  layoutDescendants,
  layoutFan,
  layoutHourglass,
  layoutPedigree,
  slotGeneration,
  type AncestorSlot,
  type BoxChart,
  type ChartBox,
  type DescendantNode,
} from './chart';

const { boxWidth, boxHeight, gapX, gapY, padding } = CHART_METRICS;

const slots = (...numbers: number[]): AncestorSlot[] =>
  numbers.map((slot) => ({ slot, personId: `a${slot}`, more: false }));

function node(
  personId: string,
  unions: { partnerId?: string | null; children?: DescendantNode[] }[] = [],
): DescendantNode {
  return {
    personId,
    more: false,
    unions: unions.map((union) => ({
      partnerId: union.partnerId ?? null,
      children: union.children ?? [],
    })),
  };
}

function box(chart: BoxChart, key: string): ChartBox {
  const found = chart.boxes.find((entry) => entry.key === key);
  if (!found) throw new Error(`no box ${key}`);
  return found;
}

function byPerson(chart: BoxChart, personId: string): ChartBox {
  const found = chart.boxes.find((entry) => entry.personId === personId);
  if (!found) throw new Error(`no box for ${personId}`);
  return found;
}

const middle = (entry: ChartBox): number => entry.y + boxHeight / 2;

/** Fails when two boxes overlap or a box lies outside the chart. */
function expectTidy(chart: BoxChart): void {
  for (const entry of chart.boxes) {
    expect(entry.x).toBeGreaterThanOrEqual(padding);
    expect(entry.y).toBeGreaterThanOrEqual(padding);
    expect(entry.x + boxWidth).toBeLessThanOrEqual(chart.width - padding + 0.01);
    expect(entry.y + boxHeight).toBeLessThanOrEqual(chart.height - padding + 0.01);
  }
  for (let i = 0; i < chart.boxes.length; i += 1) {
    for (let j = i + 1; j < chart.boxes.length; j += 1) {
      const a = chart.boxes[i];
      const b = chart.boxes[j];
      if (!a || !b) continue;
      const apart =
        a.x + boxWidth <= b.x ||
        b.x + boxWidth <= a.x ||
        a.y + boxHeight <= b.y ||
        b.y + boxHeight <= a.y;
      expect(apart, `${a.key} and ${b.key} overlap`).toBe(true);
    }
  }
  expect(new Set(chart.boxes.map((entry) => entry.key)).size).toBe(chart.boxes.length);
  expect(new Set(chart.lines.map((line) => line.key)).size).toBe(chart.lines.length);
}

describe('slotGeneration', () => {
  it('counts generations from the person', () => {
    expect([1, 2, 3, 4, 7, 8, 15, 16].map(slotGeneration)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });
});

describe('layoutPedigree', () => {
  it('draws one person as one box', () => {
    const chart = layoutPedigree(slots(1));
    expect(chart.boxes).toEqual([
      { key: 'a1', personId: 'a1', role: 'root', x: padding, y: padding, more: false },
    ]);
    expect(chart.lines).toEqual([]);
    expect(chart.width).toBe(boxWidth + 2 * padding);
    expect(chart.height).toBe(boxHeight + 2 * padding);
  });

  it('is empty when there is nobody', () => {
    expect(layoutPedigree([])).toMatchObject({ width: 0, height: 0, boxes: [], lines: [] });
  });

  it('puts a person midway between their parents, one column to the left', () => {
    const chart = layoutPedigree(slots(1, 2, 3));
    const [root, father, mother] = [box(chart, 'a1'), box(chart, 'a2'), box(chart, 'a3')];
    expect(father.x).toBe(root.x + boxWidth + gapX);
    expect(mother.x).toBe(father.x);
    expect(father.y).toBeLessThan(mother.y);
    expect(mother.y - father.y).toBe(boxHeight + gapY);
    expect(middle(root)).toBe((middle(father) + middle(mother)) / 2);
    expect(father.role).toBe('ancestor');
    expect(chart.lines.map((line) => line.key).sort()).toEqual(['a2', 'a3']);
    expectTidy(chart);
  });

  it('keeps the father above and the mother below when only one is known', () => {
    const onlyMother = layoutPedigree(slots(1, 3));
    expect(middle(box(onlyMother, 'a3'))).toBeGreaterThan(middle(box(onlyMother, 'a1')));
    const onlyFather = layoutPedigree(slots(1, 2));
    expect(middle(box(onlyFather, 'a2'))).toBeLessThan(middle(box(onlyFather, 'a1')));
    expectTidy(onlyMother);
    expectTidy(onlyFather);
  });

  it('lays out four full generations without overlap', () => {
    const chart = layoutPedigree(slots(...Array.from({ length: 15 }, (_, index) => index + 1)));
    expect(chart.boxes).toHaveLength(15);
    expect(chart.lines).toHaveLength(14);
    expect(chart.width).toBe(4 * boxWidth + 3 * gapX + 2 * padding);
    expect(chart.height).toBe(8 * boxHeight + 7 * gapY + 2 * padding);
    for (const entry of chart.boxes) {
      const generation = slotGeneration(Number(entry.key.slice(1)));
      expect(entry.x).toBe(padding + generation * (boxWidth + gapX));
    }
    expectTidy(chart);
  });

  it('lays out a ragged tree without overlap and passes on the "more" mark', () => {
    const entries = slots(1, 2, 3, 4, 6, 7, 8, 13, 14, 15, 26, 30, 31);
    const last = entries.at(-1);
    if (last) last.more = true;
    const chart = layoutPedigree(entries);
    expect(chart.boxes).toHaveLength(entries.length);
    expect(chart.lines).toHaveLength(entries.length - 1);
    expect(box(chart, 'a31').more).toBe(true);
    expect(box(chart, 'a2').more).toBe(false);
    expectTidy(chart);
  });

  it('draws each line from the child box to the parent box', () => {
    const chart = layoutPedigree(slots(1, 2));
    const [root, father] = [box(chart, 'a1'), box(chart, 'a2')];
    const mid = root.x + boxWidth + gapX / 2;
    expect(chart.lines[0]?.d).toBe(
      `M ${root.x + boxWidth} ${middle(root)} H ${mid} V ${middle(father)} H ${father.x}`,
    );
  });
});

describe('layoutDescendants', () => {
  it('draws one person as one box', () => {
    const chart = layoutDescendants(node('r'));
    expect(chart.boxes).toHaveLength(1);
    expect(chart.boxes[0]).toMatchObject({ personId: 'r', role: 'root', x: padding, y: padding });
  });

  it('stacks a partner under the person and hangs the children from the partner', () => {
    const chart = layoutDescendants(
      node('r', [{ partnerId: 'w', children: [node('c1'), node('c2'), node('c3')] }]),
    );
    const root = byPerson(chart, 'r');
    const partner = byPerson(chart, 'w');
    expect(partner.role).toBe('partner');
    expect(partner.x).toBe(root.x);
    expect(partner.y).toBe(root.y + boxHeight + CHART_METRICS.partnerGap);
    const children = ['c1', 'c2', 'c3'].map((id) => byPerson(chart, id));
    for (const child of children) {
      expect(child.role).toBe('descendant');
      expect(child.x).toBe(root.x + boxWidth + gapX);
    }
    expect(children.map((child) => child.y)).toEqual(
      [...children.map((child) => child.y)].sort((a, b) => a - b),
    );
    expect(chart.lines).toHaveLength(3);
    // Every line starts at the right edge of the partner's box.
    for (const line of chart.lines) {
      expect(line.d.startsWith(`M ${partner.x + boxWidth} ${middle(partner)} `)).toBe(true);
    }
    expectTidy(chart);
  });

  it('hangs the children of an unknown partner from the person', () => {
    const chart = layoutDescendants(node('r', [{ children: [node('c1')] }]));
    const root = byPerson(chart, 'r');
    expect(chart.boxes).toHaveLength(2);
    expect(chart.lines[0]?.d.startsWith(`M ${root.x + boxWidth} ${middle(root)} `)).toBe(true);
    expect(middle(byPerson(chart, 'c1'))).toBe(middle(root));
  });

  it('makes room when a person with several partners is taller than their children', () => {
    const chart = layoutDescendants(
      node('r', [
        { partnerId: 'w1', children: [node('c1')] },
        { partnerId: 'w2' },
        { partnerId: 'w3' },
      ]),
    );
    expect(chart.boxes).toHaveLength(5);
    const unitMiddle = (byPerson(chart, 'r').y + byPerson(chart, 'w3').y + boxHeight) / 2;
    expect(middle(byPerson(chart, 'c1'))).toBe(unitMiddle);
    expectTidy(chart);
  });

  it('lays out several generations with partners without overlap', () => {
    const grandchildren = (prefix: string) =>
      [1, 2, 3].map((n) => node(`${prefix}g${n}`, [{ partnerId: `${prefix}g${n}p` }]));
    const chart = layoutDescendants(
      node('r', [
        {
          partnerId: 'w1',
          children: [
            node('a', [{ partnerId: 'ap', children: grandchildren('a') }]),
            node('b'),
            node('c', [
              { partnerId: 'cp1', children: grandchildren('c') },
              { children: [node('cx')] },
            ]),
          ],
        },
        { partnerId: 'w2', children: [node('d', [{ partnerId: 'dp' }, { partnerId: 'dq' }])] },
      ]),
    );
    expect(chart.boxes).toHaveLength(24);
    expect(chart.lines).toHaveLength(11);
    expectTidy(chart);
  });
});

describe('layoutHourglass', () => {
  it('draws the person once, ancestors to the right and descendants to the left', () => {
    const chart = layoutHourglass(
      slots(1, 2, 3, 4, 5),
      node('a1', [{ partnerId: 'w', children: [node('c1'), node('c2', [{ partnerId: 'c2p' }])] }]),
    );
    const roots = chart.boxes.filter((entry) => entry.role === 'root');
    expect(roots).toHaveLength(1);
    const root = roots[0];
    if (!root) throw new Error('no root');
    expect(root.personId).toBe('a1');
    for (const entry of chart.boxes) {
      if (entry.role === 'ancestor') expect(entry.x).toBeGreaterThan(root.x);
      if (entry.role === 'descendant') expect(entry.x).toBeLessThan(root.x);
    }
    const partner = byPerson(chart, 'w');
    expect(partner.x).toBe(root.x);
    expect(partner.y).toBe(root.y + boxHeight + CHART_METRICS.partnerGap);
    // Children are reached on their right edge, from the left edge of the partner.
    const child = byPerson(chart, 'c1');
    expect(chart.lines.some((line) => line.d.endsWith(`H ${child.x + boxWidth}`))).toBe(true);
    expect(chart.boxes).toHaveLength(5 + 4);
    expect(chart.lines).toHaveLength(4 + 2);
    expectTidy(chart);
  });

  it('is a descendant chart turned round when no ancestors are given', () => {
    const chart = layoutHourglass([], node('r', [{ children: [node('c')] }]));
    expect(byPerson(chart, 'c').x).toBeLessThan(byPerson(chart, 'r').x);
    expectTidy(chart);
  });
});

describe('layoutFan', () => {
  it('gives every place of each generation shown, empty or not', () => {
    const chart = layoutFan(slots(1, 2, 3, 4));
    expect(chart.generations).toBe(2);
    expect(chart.segments.map((segment) => segment.slot)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(chart.segments.map((segment) => segment.personId)).toEqual([
      'a2',
      'a3',
      'a4',
      null,
      null,
      null,
    ]);
    expect(chart.segments.every((segment) => /^M [\d.]+ [\d.]+ A /.test(segment.d))).toBe(true);
  });

  it('is a half circle above the person, the father on the left', () => {
    const chart = layoutFan(slots(1, 2, 3));
    expect(chart.width).toBeCloseTo(2 * chart.centerX, 5);
    expect(chart.height).toBe(chart.centerY + chart.rootRadius + 24);
    const [father, mother] = chart.segments;
    if (!father || !mother) throw new Error('no segments');
    expect(father.textX).toBeLessThan(chart.centerX);
    expect(mother.textX).toBeGreaterThan(chart.centerX);
    expect(father.textY).toBeLessThan(chart.centerY);
    expect(father.textX + mother.textX).toBeCloseTo(2 * chart.centerX, 1);
    // Text around the ring leans left on the left side and right on the right side.
    expect(father.rotate).toBeCloseTo(315, 5);
    expect(mother.rotate).toBeCloseTo(405, 5);
    expect(father.radial).toBe(false);
  });

  it('turns the text along the radius in the outer rings, never upside down', () => {
    const chart = layoutFan(slots(...Array.from({ length: 63 }, (_, index) => index + 1)));
    expect(chart.generations).toBe(5);
    const outer = chart.segments.filter((segment) => segment.generation >= 4);
    expect(outer.length).toBe(16 + 32);
    for (const segment of outer) {
      expect(segment.radial).toBe(true);
      const turned = segment.rotate % 360;
      expect(turned <= 90 || turned >= 270).toBe(true);
      expect(segment.chars).toBeGreaterThanOrEqual(10);
    }
    expect(chart.segments.filter((segment) => segment.generation === 1)[0]?.lines).toBe(3);
  });

  it('shows no more generations than it can label', () => {
    const many = slots(...Array.from({ length: 255 }, (_, index) => index + 1));
    expect(layoutFan(many).generations).toBe(FAN_MAX_GENERATIONS);
    expect(layoutFan(many).segments).toHaveLength(2 + 4 + 8 + 16 + 32 + 64);
    expect(layoutFan(many, 3).generations).toBe(3);
    expect(layoutFan(slots(1)).generations).toBe(1);
  });
});
