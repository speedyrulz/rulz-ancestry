import type { BoxChart, FanChart, FanSegment } from '../chart';
import { escapeHtml } from './html';
import { LIVING_REF, personLabel, type PersonRef } from './model';

/**
 * The four charts as one SVG drawing each, for a report. A drawing is plain
 * shapes and text only, so it passes `checkSvg`: no style sheet, no id, no
 * link, no picture. A person is drawn from a {@link PersonRef}, so someone
 * the living filter hides is a box that says "Living" and nothing else: not
 * even a mark that their tree goes on.
 */

/** What a drawing is told about a person. A person it is not told about is drawn as "Living". */
export type PersonLabels = (personId: string) => PersonRef | undefined;

/** The area of a page the chart may use, in CSS pixels (96 to the inch), with the smaller paper's margins. */
const PAGE_AREA = {
  landscape: { width: 920, height: 480 },
  portrait: { width: 650, height: 720 },
} as const;

/** A chart that would print smaller than this has text too small to read. */
export const MIN_PRINT_SCALE = 0.5;

export interface PagePlan {
  orientation: 'portrait' | 'landscape';
  /** How much the drawing is shrunk to fit the page; 1 means as drawn. */
  scale: number;
}

/** The way to turn the paper for a drawing of this size, and how much it shrinks. */
export function planChartPage(width: number, height: number): PagePlan {
  const scaleIn = (area: { width: number; height: number }) =>
    Math.min(area.width / Math.max(1, width), area.height / Math.max(1, height), 1);
  const landscape = scaleIn(PAGE_AREA.landscape);
  const portrait = scaleIn(PAGE_AREA.portrait);
  return portrait > landscape
    ? { orientation: 'portrait', scale: portrait }
    : { orientation: 'landscape', scale: landscape };
}

const FONT = 'Arial, Helvetica, sans-serif';
const INK = '#111';
const MUTED = '#444';
const LINE = '#555';

/** A number as it is written in a drawing: at most two decimals, no exponent. */
function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function shorten(text: string, chars: number): string {
  const points = [...text];
  return points.length <= chars
    ? text
    : `${points
        .slice(0, Math.max(1, chars - 1))
        .join('')
        .trimEnd()}…`;
}

function svgOpen(width: number, height: number): string {
  return (
    `<svg viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" ` +
    `preserveAspectRatio="xMidYMid meet" font-family="${FONT}">`
  );
}

/** What a box says: the name and years of a person who is shown, or "Living". */
function boxText(person: PersonRef): { name: string; years: string; living: boolean } {
  return person.living
    ? { name: 'Living', years: '', living: true }
    : { name: personLabel(person), years: person.lifespan, living: false };
}

/**
 * The ancestor, descendant and hourglass charts: a box for each person with a
 * line from each to the next, the root drawn with a heavier outline.
 */
export function boxChartSvg(layout: BoxChart, labels: PersonLabels): string {
  const parts: string[] = [svgOpen(layout.width, layout.height)];
  parts.push(
    `<g fill="none" stroke="${LINE}" stroke-width="1">${layout.lines
      .map((line) => `<path d="${line.d}"/>`)
      .join('')}</g>`,
  );
  const chars = Math.max(4, Math.floor((layout.boxWidth - 12) / 7));
  for (const box of layout.boxes) {
    const person = labels(box.personId) ?? LIVING_REF;
    const { name, years, living } = boxText(person);
    // A hidden person's tree is not said to go on, nor is anything else about them.
    const years2 = box.more && !living ? `${years}${years === '' ? '' : ' '}more…` : years;
    const x = box.x + 6;
    const first =
      years2 === '' ? box.y + layout.boxHeight / 2 + 4 : box.y + layout.boxHeight / 2 - 3;
    parts.push(
      '<g>',
      `<title>${escapeHtml(years === '' ? name : `${name}, ${years}`)}</title>`,
      `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(layout.boxWidth)}" height="${num(layout.boxHeight)}" rx="3" ` +
        `fill="#fff" stroke="${INK}" stroke-width="${box.role === 'root' ? 2 : 1}"/>`,
      `<text x="${num(x)}" y="${num(first)}" font-size="12" font-weight="bold" fill="${INK}"${living ? ' font-style="italic"' : ''}>${escapeHtml(shorten(name, chars))}</text>`,
    );
    if (years2 !== '') {
      parts.push(
        `<text x="${num(x)}" y="${num(first + 13)}" font-size="10" fill="${MUTED}">${escapeHtml(shorten(years2, chars + 4))}</text>`,
      );
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('');
}

/** The lines of text for one place in the fan: as much of the name and years as fits. */
function fanLines(
  person: PersonRef,
  segment: Pick<FanSegment, 'lines' | 'chars'>,
  more: boolean,
): string[] {
  const { name, years, living } = boxText(person);
  const tail = more && !living ? ' …' : '';
  let lines: string[];
  const space = name.lastIndexOf(' ', Math.ceil(name.length / 2) + 2);
  if (segment.lines >= 3 && years !== '' && name.length > segment.chars && space > 0) {
    lines = [name.slice(0, space), name.slice(space + 1), years];
  } else if (segment.lines >= 2) {
    lines = [name, years];
  } else {
    lines = [name];
  }
  const kept = lines.filter((line) => line !== '').map((line) => shorten(line, segment.chars));
  const last = kept.length - 1;
  if (last >= 0 && tail !== '') kept[last] = `${kept[last] ?? ''}${tail}`;
  return kept;
}

const FAN_LINE_HEIGHT = 15;

function fanText(lines: readonly string[], living: boolean): string {
  return lines
    .map((line, index) => {
      const dy = index === 0 ? -((lines.length - 1) * FAN_LINE_HEIGHT) / 2 + 4 : FAN_LINE_HEIGHT;
      const last = index === lines.length - 1 && lines.length > 1;
      return (
        `<tspan x="0" dy="${num(dy)}" font-size="${last ? 11 : 12}" ` +
        `font-weight="${last ? 'normal' : 'bold'}" fill="${last ? MUTED : INK}"` +
        `${living ? ' font-style="italic"' : ''}>${escapeHtml(line)}</tspan>`
      );
    })
    .join('');
}

/**
 * The fan chart: a ring of places for each generation round the person, who
 * is drawn in the middle circle. Places where no ancestor is recorded are
 * drawn empty.
 */
export function fanChartSvg(layout: FanChart, root: PersonRef, labels: PersonLabels): string {
  const parts: string[] = [svgOpen(layout.width, layout.height)];
  for (const segment of layout.segments) {
    if (segment.personId === null) {
      parts.push(`<path d="${segment.d}" fill="#f6f6f6" stroke="#aaa" stroke-width="1"/>`);
      continue;
    }
    const person = labels(segment.personId) ?? LIVING_REF;
    const { name, years, living } = boxText(person);
    parts.push(
      '<g>',
      `<title>${escapeHtml(years === '' ? name : `${name}, ${years}`)}</title>`,
      `<path d="${segment.d}" fill="#fff" stroke="${INK}" stroke-width="1"/>`,
      `<text transform="translate(${num(segment.textX)} ${num(segment.textY)}) rotate(${num(segment.rotate)})" text-anchor="middle">` +
        `${fanText(fanLines(person, segment, segment.more), living)}</text>`,
      '</g>',
    );
  }
  const { name, years, living } = boxText(root);
  parts.push(
    '<g>',
    `<title>${escapeHtml(years === '' ? name : `${name}, ${years}`)}</title>`,
    `<circle cx="${num(layout.centerX)}" cy="${num(layout.centerY)}" r="${num(layout.rootRadius)}" fill="#fff" stroke="${INK}" stroke-width="2"/>`,
    `<text transform="translate(${num(layout.centerX)} ${num(layout.centerY)})" text-anchor="middle">` +
      `${fanText(fanLines(root, { lines: 3, chars: Math.floor((layout.rootRadius * 2 - 16) / 6.6) }, false), living)}</text>`,
    '</g>',
    '</svg>',
  );
  return parts.join('');
}
