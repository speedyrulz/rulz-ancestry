import { rename, rm, writeFile } from 'node:fs/promises';
import { ReportError, checkSvg, escapeHtml, type ReportDocument } from '@rulz/core';
import type { ReportPaper } from '../shared/ipc';

/**
 * What the main process decides about a report before and after Electron has
 * a hand in it: how the hidden window is sealed, which requests it may make,
 * the footer of the PDF and the name of the file. Nothing here uses Electron,
 * so the rules can be tested; `reportwindow.ts` carries them out.
 */

/**
 * How the hidden window that renders a report is made. The handlers ask the
 * platform for exactly this, and a test checks it: no script runs in the
 * page, the page is sandboxed with no preload and no access to Node.js, and
 * the only request it may make is for the document itself, handed over in
 * memory as a data address (never a temporary file).
 */
export interface ReportWindowSeal {
  readonly javascript: false;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  /** No preload script. */
  readonly preload: null;
  /** The window has a session of its own that keeps nothing on disk. */
  readonly partition: 'in-memory';
  /** Every request but the document's own is cancelled: web, file and anything else. */
  readonly requests: 'document-only';
}

export const REPORT_WINDOW: ReportWindowSeal = Object.freeze({
  javascript: false,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  preload: null,
  partition: 'in-memory',
  requests: 'document-only',
});

/** What the platform is asked to render: the page, the paper, the footer and how to seal the window. */
export interface ReportRenderJob {
  /** The whole report as one HTML document. */
  html: string;
  paper: ReportPaper;
  /** The footer of every page of the PDF; the page numbers are filled in by the PDF engine. */
  footerTemplate: string;
  /** True turns the paper on its side, as the charts ask. */
  landscape: boolean;
  seal: ReportWindowSeal;
}

/** The margins of the PDF, in inches. The footer sits in the bottom one. */
export const REPORT_MARGINS = { top: 0.6, bottom: 0.8, left: 0.7, right: 0.7 } as const;

/**
 * The most a report may be, in bytes of HTML. The page is handed to the
 * window in a data address, which Chromium limits to about 2 MB; the
 * address is a third longer than the page.
 */
export const MAX_REPORT_HTML_BYTES = 1_400_000;

/**
 * The only address the sealed window may fetch: inline data, which cannot
 * leave the machine. Web, file, blob, ftp and every other kind is refused.
 */
export function isReportRequestAllowed(url: string): boolean {
  return /^data:/i.test(url);
}

/** The address that carries the page into the sealed window, without a file. */
export function reportDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
}

const FOOTER_TITLE_MAX = 90;

/**
 * The footer of each PDF page: the report's title and "page 1 of 3". The
 * title comes from the filtered model like everything else, and is escaped
 * because the footer is HTML.
 */
export function footerTemplate(title: string): string {
  const points = [...title];
  const shown =
    points.length > FOOTER_TITLE_MAX
      ? `${points.slice(0, FOOTER_TITLE_MAX - 3).join('')}...`
      : title;
  return (
    '<div style="width:100%;font-size:8px;font-family:Arial,Helvetica,sans-serif;color:#444;text-align:center;">' +
    `${escapeHtml(shown)} - page <span class="pageNumber"></span> of <span class="totalPages"></span>` +
    '</div>'
  );
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A file name, without the extension, from a report's title. Characters
 * Windows does not allow are dropped, a colon becomes a dash.
 */
export function reportFileName(title: string): string {
  let name = title
    .replace(/:/g, ' -')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  if (name === '' || RESERVED.test(name)) name = 'Report';
  return name;
}

/**
 * The drawing of a chart as the text of an SVG file. The drawing is checked
 * again (plain shapes and text only), given a white page to sit on, and only
 * then given the namespace that a file of its own needs; the namespace is a
 * name, not an address that is ever fetched.
 */
export function standaloneSvg(model: ReportDocument): string {
  const block = model.sections.flatMap((section) => section.blocks).find((b) => b.kind === 'svg');
  if (block?.kind !== 'svg') throw new ReportError('This report has no drawing to save.');
  const svg = checkSvg(block.svg);
  const size = /^<svg viewBox="0 0 ([0-9.]+) ([0-9.]+)"[^>]*>/.exec(svg);
  const [open = '', width = '0', height = '0'] = size ?? [];
  if (size === null) throw new ReportError('This report has no drawing to save.');
  const page = `<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>`;
  const whole = checkSvg(`${open}${page}${svg.slice(open.length)}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${whole.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')}\n`;
}

/** Writes the report to the file the user chose. */
export async function writeReportFile(file: string, data: Uint8Array | string): Promise<void> {
  // Write beside the target and rename over it, so a failed write leaves no truncated file.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
