import { describe, expect, it } from 'vitest';
import {
  CHART_PRINT_METRICS,
  layoutDescendants,
  layoutFan,
  layoutPedigree,
  type AncestorSlot,
  type DescendantNode,
} from '../chart';
import { MIN_PRINT_SCALE, boxChartSvg, fanChartSvg, planChartPage } from './chartsvg';
import { checkSvg, renderHtml } from './html';
import { LIVING_REF, shownPerson, type PersonRef } from './model';

const slots: AncestorSlot[] = [
  { slot: 1, personId: 'a', more: false },
  { slot: 2, personId: 'b', more: true },
  { slot: 3, personId: 'c', more: true },
];

const tree: DescendantNode = {
  personId: 'a',
  more: false,
  unions: [{ partnerId: 'p', children: [{ personId: 'k', unions: [], more: true }] }],
};

const people: Record<string, PersonRef> = {
  a: shownPerson('Ada Test', '1850–1911'),
  b: shownPerson('Bo Test', 'b. 1820'),
  c: LIVING_REF,
  p: shownPerson('Pat Other', ''),
  k: LIVING_REF,
};
const labels = (id: string) => people[id];

describe('boxChartSvg', () => {
  const svg = boxChartSvg(layoutPedigree(slots, CHART_PRINT_METRICS), labels);

  it('is one drawing that the report accepts', () => {
    expect(checkSvg(svg)).toBe(svg);
    expect(svg.startsWith('<svg viewBox="0 0 ')).toBe(true);
  });

  it('draws a box for each person with the name and years, and a hidden person as "Living" only', () => {
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg).toContain('>Ada Test</text>');
    expect(svg).toContain('>1850–1911</text>');
    expect(svg).toContain('>Living</text>');
    // The living person's tree is not said to go on; the dead one's is.
    expect(svg.match(/more…/g)).toHaveLength(1);
  });

  it('draws anyone it is not told about as "Living"', () => {
    const none = boxChartSvg(layoutPedigree(slots, CHART_PRINT_METRICS), () => undefined);
    expect(none.match(/>Living<\/text>/g)).toHaveLength(3);
    expect(none).not.toContain('Ada');
    expect(none).not.toContain('more');
  });

  it('shortens a long name and keeps the whole one in the title', () => {
    const long = 'Bartholomew Maximilian Featherstonehaugh-Cholmondeley';
    const out = boxChartSvg(layoutPedigree(slots, CHART_PRINT_METRICS), (id) =>
      id === 'a' ? shownPerson(long, '') : people[id],
    );
    expect(out).toContain(`<title>${long}</title>`);
    expect(out).not.toContain(`>${long}</text>`);
    expect(out).toContain('…</text>');
    expect(() => checkSvg(out)).not.toThrow();
  });

  it('draws descendants with their partners', () => {
    const out = boxChartSvg(layoutDescendants(tree, CHART_PRINT_METRICS), labels);
    expect(out.match(/<rect /g)).toHaveLength(3);
    expect(out).toContain('Pat Other');
    expect(() => checkSvg(out)).not.toThrow();
  });
});

describe('fanChartSvg', () => {
  const fan = layoutFan(slots, 3);
  const svg = fanChartSvg(fan, people['a'] ?? LIVING_REF, labels);

  it('is one drawing that the report accepts, with the person in the middle', () => {
    expect(checkSvg(svg)).toBe(svg);
    expect(svg.match(/<circle /g)).toHaveLength(1);
    expect(svg).toContain('Ada Test');
    expect(svg).toContain('Bo Test');
  });

  it('says "Living" for a hidden ancestor and says nothing else of them', () => {
    expect(svg).toContain('>Living</tspan>');
    // Only the dead ancestor has more behind them.
    expect(svg.match(/…/g)).toHaveLength(1);
  });
});

describe('planChartPage', () => {
  it('prints a small chart as drawn, and turns the paper the way a wide or a tall chart fits', () => {
    expect(planChartPage(400, 200)).toEqual({ orientation: 'landscape', scale: 1 });
    expect(planChartPage(600, 700).orientation).toBe('portrait');
    expect(planChartPage(1400, 500).orientation).toBe('landscape');
  });

  it('gives the scale at which the chart is printed, below which the text is too small', () => {
    const { scale } = planChartPage(1840, 960);
    expect(scale).toBeCloseTo(0.5, 1);
    expect(planChartPage(3000, 3000).scale).toBeLessThan(MIN_PRINT_SCALE);
  });
});

describe('the page the plan counts on', () => {
  it('is the page the print style sheet gives the drawing', () => {
    const html = renderHtml({ title: 'Chart', metadata: [], sections: [] });
    // 96 pixels to the inch: the tallest drawing the plan allows is the tallest the style sheet allows.
    expect(html).toContain('body.portrait figure.chart svg { max-height: 7.5in; }');
    expect(html).toContain('body.landscape figure.chart svg { max-height: 5in; }');
    const portrait = planChartPage(300, 7.5 * 96 * 2);
    expect(portrait.orientation).toBe('portrait');
    expect(portrait.scale).toBeCloseTo(0.5, 5);
    const landscape = planChartPage(1840, 5 * 96 * 2);
    expect(landscape.orientation).toBe('landscape');
    expect(landscape.scale).toBeCloseTo(0.5, 5);
  });
});

describe('a chart in a report', () => {
  it('is a figure that is scaled to the page, and the page is turned as the report says', () => {
    const html = renderHtml({
      title: 'Chart',
      metadata: [],
      orientation: 'landscape',
      sections: [
        {
          title: '',
          blocks: [
            {
              kind: 'svg',
              title: 'A chart',
              svg: boxChartSvg(layoutPedigree(slots, CHART_PRINT_METRICS), labels),
              fitPage: true,
            },
          ],
        },
      ],
    });
    expect(html).toContain('<body class="landscape">');
    expect(html).toContain('<figure class="chart" role="img" aria-label="A chart">');
    expect(html).toContain('body.landscape figure.chart svg { max-height: 5in; }');
    expect(renderHtml({ title: 'Plain', metadata: [], sections: [] })).toContain(
      '<body class="portrait">',
    );
  });
});
