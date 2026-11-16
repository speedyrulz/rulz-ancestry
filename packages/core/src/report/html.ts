import {
  personLabel,
  type Block,
  type Inline,
  type KeyValueRow,
  type PersonRef,
  type ReportDocument,
  type ReportSection,
} from './model';

/**
 * Turns a report into one HTML document. The page is self-contained: its
 * styles are inline, it has no script, and it names no address on the
 * internet or on the disk. Every text that comes from the tree goes through
 * {@link escapeHtml}, the only place that writes text into the page.
 */

/** A report that cannot be written, e.g. a drawing that holds a link. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text as HTML text or as the value of an attribute. Characters that cannot
 * be in a page (controls other than a tab or a line break) are dropped.
 */
export function escapeHtml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)
  );
}

/**
 * The page may load nothing: no script, no picture and no style from outside.
 * This is the second lock; the first is that the page has no such address.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";

/**
 * No page size is named, so the page fits A4 and Letter alike; the paper is
 * chosen when the PDF is made or the page is printed.
 */
const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; color: #111; background: #fff; font: 11pt/1.4 Georgia, "Times New Roman", serif; }
@media screen { body { max-width: 52rem; margin: 0 auto; padding: 1.5rem; } }
h1 { margin: 0 0 0.2em; font-size: 20pt; line-height: 1.2; }
h2 { margin: 1.4em 0 0.4em; padding-bottom: 0.15em; border-bottom: 1px solid #555; font-size: 14pt; break-after: avoid; }
h3 { margin: 1em 0 0.3em; font-size: 12pt; break-after: avoid; }
h4 { margin: 0.8em 0 0.2em; font-size: 11pt; break-after: avoid; }
p { margin: 0.3em 0; white-space: pre-line; }
.subtitle { margin: 0; font-size: 12pt; color: #333; }
.meta { margin: 0.8em 0 0; padding: 0.5em 0.7em; border: 1px solid #999; font: 9.5pt/1.4 Arial, Helvetica, sans-serif; }
.meta div { display: flex; gap: 0.5em; }
.meta dt { min-width: 11em; font-weight: bold; }
.meta dd { margin: 0; }
dl.facts { margin: 0.3em 0; }
dl.facts .row { display: flex; gap: 0.6em; padding: 0.1em 0; break-inside: avoid; }
dl.facts dt { flex: 0 0 9em; font-weight: bold; }
dl.facts dd { margin: 0; flex: 1 1 auto; white-space: pre-line; }
table { width: 100%; margin: 0.4em 0; border-collapse: collapse; font-size: 10pt; }
caption { padding: 0.2em 0; text-align: left; font-weight: bold; }
th, td { padding: 0.25em 0.4em; border: 1px solid #888; text-align: left; vertical-align: top; white-space: pre-line; }
th { background: #eee; }
tr { break-inside: avoid; }
ol, ul { margin: 0.3em 0; padding-left: 1.6em; }
li { margin: 0.15em 0; white-space: pre-line; }
sup.note { font-size: 70%; line-height: 0; }
.living { font-style: italic; }
.years { color: #444; }
figure { margin: 0.6em 0; break-inside: avoid; }
figure svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
body.landscape figure.chart svg { max-height: 5in; }
body.portrait figure.chart svg { max-height: 7.5in; }
figcaption { font-size: 9.5pt; color: #333; }
section.break { break-before: page; }
@media print { body { font-size: 10.5pt; } a { color: inherit; } }
`;

function personHtml(person: PersonRef): string {
  if (person.living) return '<span class="person living">Living</span>';
  const years =
    person.lifespan === '' ? '' : ` <span class="years">(${escapeHtml(person.lifespan)})</span>`;
  return `<span class="person">${escapeHtml(personLabel(person))}</span>${years}`;
}

function inlineHtml(content: Inline): string {
  return content
    .map((part) => {
      if (typeof part === 'string') return escapeHtml(part);
      if (part.kind === 'person') return personHtml(part.person);
      // The mark is a number that points at a numbered endnote of the same page.
      return `<sup class="note">${String(Math.trunc(part.number))}</sup>`;
    })
    .join('');
}

/** The only elements a drawing may hold: shapes and text, nothing that loads, links or runs. */
const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'line',
  'polyline',
  'polygon',
  'rect',
  'circle',
  'ellipse',
  'text',
  'tspan',
  'title',
  'desc',
]);

/** Elements whose content is text. Elsewhere only white space may stand between tags. */
const SVG_TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);

/** The only attributes: geometry and presentation. No style, no link, no event, no namespace. */
const SVG_ATTRIBUTES = new Set([
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'dx',
  'dy',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'opacity',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'class',
  'role',
  'aria-label',
]);

const SVG_TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][A-Za-z0-9-]*="[^"<>]*")*)\s*(\/?)>/y;
const SVG_ATTRIBUTE = /\s+([A-Za-z][A-Za-z0-9-]*)="([^"<>]*)"/g;
const SVG_TEXT = /^(?:[^<>&]|&(?:amp|lt|gt|quot|#39);)*$/;
const SVG_BAD_VALUE = /url\(|javascript:|expression\(|&|\|\/\/|[a-z]+:/i;

/**
 * Throws a {@link ReportError} unless the drawing is exactly one svg element
 * made only of the elements and attributes allowed above, with nothing
 * before or after it. Anything else is refused, not repaired.
 */
export function checkSvg(svg: string): string {
  const text = svg.trim();
  const refuse = (): never => {
    throw new ReportError(
      'A drawing in a report must be one svg element of plain shapes and text, with no script, link or address.',
    );
  };
  const stack: string[] = [];
  let at = 0;
  let closedRoot = false;
  while (at < text.length) {
    if (text[at] !== '<') {
      // Text between tags.
      const next = text.indexOf('<', at);
      const chunk = text.slice(at, next === -1 ? text.length : next);
      const top = stack[stack.length - 1];
      if (closedRoot || (!SVG_TEXT_ELEMENTS.has(top ?? '') && chunk.trim() !== '')) refuse();
      if (!SVG_TEXT.test(chunk)) refuse();
      at += chunk.length;
      continue;
    }
    SVG_TAG.lastIndex = at;
    const match = SVG_TAG.exec(text);
    if (match === null || closedRoot) return refuse();
    const [whole, closing = '', name = '', attributes = '', selfClosing = ''] = match;
    if (!SVG_ELEMENTS.has(name) || (closing !== '' && (selfClosing !== '' || attributes !== ''))) {
      return refuse();
    }
    if (closing === '') {
      if (stack.length === 0 && (name !== 'svg' || at !== 0)) refuse();
      if (name === 'svg' && stack.length > 0) refuse();
      for (const attribute of attributes.matchAll(SVG_ATTRIBUTE)) {
        const [, key = '', value = ''] = attribute;
        if (!SVG_ATTRIBUTES.has(key) || SVG_BAD_VALUE.test(value)) refuse();
      }
      if (selfClosing === '') stack.push(name);
      else if (stack.length === 0) closedRoot = true;
    } else {
      if (stack.pop() !== name) refuse();
      if (stack.length === 0) closedRoot = true;
    }
    at += whole.length;
  }
  if (!closedRoot || stack.length > 0) refuse();
  return text;
}

function rowsHtml(rows: readonly KeyValueRow[]): string {
  return rows
    .map(
      (row) =>
        `<div class="row"><dt>${escapeHtml(row.label)}</dt><dd>${inlineHtml(row.value)}</dd></div>`,
    )
    .join('');
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${inlineHtml(block.content)}</p>`;
    case 'keyValues':
      return `<dl class="facts">${rowsHtml(block.rows)}</dl>`;
    case 'table': {
      const caption = block.caption === '' ? '' : `<caption>${escapeHtml(block.caption)}</caption>`;
      const head = block.head.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('');
      const body = block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inlineHtml(cell)}</td>`).join('')}</tr>`)
        .join('');
      return `<table>${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${inlineHtml(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'svg':
      return `<figure${block.fitPage === true ? ' class="chart"' : ''} role="img" aria-label="${escapeHtml(block.title)}">${checkSvg(block.svg)}<figcaption>${escapeHtml(block.title)}</figcaption></figure>`;
  }
}

function sectionHtml(section: ReportSection, index: number): string {
  const heading = section.title === '' ? '' : `<h2>${escapeHtml(section.title)}</h2>`;
  const attributes = section.pageBreakBefore === true && index > 0 ? ' class="break"' : '';
  return `<section${attributes}>${heading}${section.blocks.map(blockHtml).join('')}</section>`;
}

/** A complete HTML document for the report. */
export function renderHtml(report: ReportDocument): string {
  const subtitle =
    report.subtitle === undefined || report.subtitle === ''
      ? ''
      : `<p class="subtitle">${escapeHtml(report.subtitle)}</p>`;
  const metadata =
    report.metadata.length === 0
      ? ''
      : `<dl class="meta">${report.metadata
          .map(
            (row) =>
              `<div><dt>${escapeHtml(row.label)}</dt><dd>${inlineHtml(row.value)}</dd></div>`,
          )
          .join('')}</dl>`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CONTENT_SECURITY_POLICY)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="RulZ Kinspora">',
    `<title>${escapeHtml(report.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body class="${report.orientation ?? 'portrait'}">`,
    `<header><h1>${escapeHtml(report.title)}</h1>${subtitle}${metadata}</header>`,
    `<main>${report.sections.map(sectionHtml).join('')}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
