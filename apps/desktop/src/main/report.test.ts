import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportError, checkSvg, type ReportDocument } from '@rulz/core';
import { describe, expect, it } from 'vitest';
import {
  REPORT_WINDOW,
  footerTemplate,
  isReportRequestAllowed,
  reportDataUrl,
  reportFileName,
  standaloneSvg,
  writeReportFile,
} from './report';

describe('the sealed window', () => {
  it('has no script, is sandboxed, has no preload and asks for nothing but its own page', () => {
    expect(REPORT_WINDOW).toEqual({
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: null,
      partition: 'in-memory',
      requests: 'document-only',
    });
    expect(Object.isFrozen(REPORT_WINDOW)).toBe(true);
  });

  it('allows inline data and refuses every address that leaves the page', () => {
    expect(isReportRequestAllowed(reportDataUrl('<p>hi</p>'))).toBe(true);
    for (const url of [
      'https://example.org/a.png',
      'http://example.org/',
      'file:///C:/Users/someone/secret.txt',
      'file://server/share/x',
      'ftp://example.org/x',
      'ws://example.org/',
      'blob:https://example.org/1234',
      'about:blank',
      'chrome://gpu',
      'rulz-media://file/abc',
      '//example.org/x',
      '',
    ]) {
      expect(isReportRequestAllowed(url), url).toBe(false);
    }
  });

  it('hands the page over as a data address that gives the same bytes back', () => {
    const html = '<p>Zo\u00eb "quoted" <b>bold</b></p>';
    const url = reportDataUrl(html);
    expect(url.startsWith('data:text/html;charset=utf-8;base64,')).toBe(true);
    const [, payload = ''] = url.split('base64,');
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(html);
  });
});

describe('the footer', () => {
  it('holds the title as text and has the page numbers filled in by the PDF engine', () => {
    const footer = footerTemplate('Family group sheet: A & B <script>');
    expect(footer).toContain('Family group sheet: A &amp; B &lt;script&gt;');
    expect(footer).not.toContain('<script');
    expect(footer).toContain('<span class="pageNumber"></span>');
    expect(footer).toContain('<span class="totalPages"></span>');
  });

  it('cuts a very long title, never in the middle of a character', () => {
    expect(footerTemplate('x'.repeat(500)).length).toBeLessThan(400);
    const emoji = String.fromCodePoint(0x1f600);
    const footer = footerTemplate(emoji.repeat(200));
    expect(footer).toContain(`${emoji.repeat(87)}...`);
    expect(() => encodeURIComponent(footer)).not.toThrow();
  });
});

describe('the file name', () => {
  it('makes a Windows file name from a title', () => {
    expect(reportFileName('Family group sheet: Hal Marsh and Living')).toBe(
      'Family group sheet - Hal Marsh and Living',
    );
    expect(reportFileName('A/B\\C:D*E?F"G<H>I|J')).toBe('ABC -DEFGHIJ');
    expect(reportFileName('Ends with dots...  ')).toBe('Ends with dots');
    expect(reportFileName('')).toBe('Report');
    expect(reportFileName('CON')).toBe('Report');
    expect(reportFileName('x'.repeat(300)).length).toBe(120);
  });
});

describe('writing the file', () => {
  it('replaces the target whole, and leaves no temporary file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rulz-report-'));
    try {
      const file = join(dir, 'sheet.pdf');
      writeFileSync(file, 'old');
      await writeReportFile(file, 'new contents');
      expect(readFileSync(file, 'utf8')).toBe('new contents');
      expect(readdirSync(dir)).toEqual(['sheet.pdf']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps what was there and removes the temporary file when the write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rulz-report-'));
    try {
      // The target is a folder, so the rename over it fails after the temporary file is written.
      const target = join(dir, 'sheet.pdf');
      mkdirSync(target);
      writeFileSync(join(target, 'keep.txt'), 'kept');
      await expect(writeReportFile(target, 'data')).rejects.toThrow();
      expect(readdirSync(dir)).toEqual(['sheet.pdf']);
      expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the SVG file of a chart', () => {
  const DRAWING =
    '<svg viewBox="0 0 120 60" width="120" height="60" font-family="Arial, Helvetica, sans-serif">' +
    '<g><title>Ada Test</title><rect x="6" y="6" width="100" height="40" fill="#fff" stroke="#111"/>' +
    '<text x="12" y="30" font-size="12">Ada Test</text></g></svg>';
  const model = (svg: string): ReportDocument => ({
    title: 'Chart',
    metadata: [],
    sections: [{ title: '', blocks: [{ kind: 'svg', title: 'A chart', svg }] }],
  });

  it('is the checked drawing on a white page, with the namespace a file needs and nothing else added', () => {
    const file = standaloneSvg(model(DRAWING));
    expect(
      file.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" ',
      ),
    ).toBe(true);
    expect(file).toContain('<rect x="0" y="0" width="120" height="60" fill="#fff"/><g>');
    expect(file.endsWith('</svg>\n')).toBe(true);
    // Without the namespace and the prolog it is a drawing the report accepts.
    const bare = file
      .replace(/^<\?xml[^>]*>\n/, '')
      .replace(' xmlns="http://www.w3.org/2000/svg"', '')
      .trim();
    expect(() => checkSvg(bare)).not.toThrow();
    expect(file).not.toMatch(/<script|href=|style=/i);
  });

  it('refuses a drawing that is not plain shapes and text, and a report that has none', () => {
    expect(() => standaloneSvg(model(DRAWING.replace('<g>', '<script>x</script><g>')))).toThrow(
      ReportError,
    );
    expect(() => standaloneSvg(model('<svg width="1" height="1"></svg>'))).toThrow(ReportError);
    expect(() => standaloneSvg({ title: 'No drawing', metadata: [], sections: [] })).toThrow(
      ReportError,
    );
  });
});
