import { describe, expect, it } from 'vitest';
import { ReportError, checkSvg, escapeHtml, renderHtml } from './html';
import {
  LIVING_REF,
  noteMark,
  personLabel,
  personSpan,
  shownPerson,
  type ReportDocument,
} from './model';

const SAMPLE: ReportDocument = {
  title: 'Family group sheet',
  subtitle: 'Ada Test and Living',
  metadata: [{ label: 'Living people', value: ['Shown as "Living".'] }],
  sections: [
    {
      title: 'Partners',
      blocks: [
        { kind: 'heading', level: 3, text: 'Husband' },
        {
          kind: 'keyValues',
          rows: [{ label: 'Born', value: ['1850, Ashford', noteMark(1)] }],
        },
        { kind: 'paragraph', content: [personSpan(shownPerson('Ada Test', '1850-1911'))] },
        { kind: 'paragraph', content: [personSpan(LIVING_REF)] },
        {
          kind: 'table',
          caption: 'Children',
          head: ['Name', 'Born'],
          rows: [[[personSpan(LIVING_REF)], ['1880']]],
        },
      ],
    },
    {
      title: 'Notes',
      pageBreakBefore: true,
      blocks: [{ kind: 'list', ordered: true, items: [['A source, page 3']] }],
    },
  ],
};

describe('escapeHtml', () => {
  it('escapes the five characters that can open markup or leave an attribute', () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });

  it('drops control characters but keeps a tab and a line break', () => {
    expect(escapeHtml('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne');
  });
});

describe('renderHtml', () => {
  const html = renderHtml(SAMPLE);

  it('writes a complete document with the title in the head and the body', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Family group sheet</title>');
    expect(html).toContain('<h1>Family group sheet</h1>');
    expect(html).toContain('<h2>Partners</h2>');
    expect(html).toContain('<sup class="note">1</sup>');
    expect(html).toContain('<span class="person living">Living</span>');
    expect(html).toContain('<span class="years">(1850-1911)</span>');
  });

  it('starts a section on a new page only where asked, and never the first', () => {
    expect(html.match(/<section class="break">/g)).toHaveLength(1);
    const first = renderHtml({
      ...SAMPLE,
      sections: [{ ...SAMPLE.sections[0]!, pageBreakBefore: true }],
    });
    expect(first).not.toContain('class="break"');
  });

  it('has no script, no address, no link and no url() but a data one', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toContain('//');
    expect(html).not.toMatch(/\b(?:src|href)\s*=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\((?!\s*['"]?data:)/i);
    expect(html).toContain('default-src &#39;none&#39;');
    expect(html).toContain('form-action &#39;none&#39;');
    expect(html).toContain('base-uri &#39;none&#39;');
  });

  it('prints text from the tree as text, whatever it holds', () => {
    const nasty = '<script>alert(1)</script> "quoted" <img src=x onerror=alert(1)>';
    const out = renderHtml({
      title: nasty,
      subtitle: nasty,
      metadata: [{ label: nasty, value: [nasty] }],
      sections: [
        {
          title: nasty,
          blocks: [
            { kind: 'heading', level: 3, text: nasty },
            { kind: 'paragraph', content: [nasty, personSpan(shownPerson(nasty, nasty))] },
            { kind: 'keyValues', rows: [{ label: nasty, value: [nasty] }] },
            {
              kind: 'table',
              caption: nasty,
              head: [nasty],
              rows: [[[nasty]]],
            },
            { kind: 'list', ordered: false, items: [[nasty]] },
          ],
        },
      ],
    });
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toMatch(/<[a-z][^>]* onerror=/i);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot;');
  });

  it('names a person with no name', () => {
    expect(personLabel(shownPerson(''))).toBe('Name not recorded');
    expect(personLabel(LIVING_REF)).toBe('Living');
  });
});

describe('checkSvg', () => {
  const plain =
    '<svg viewBox="0 0 10 10"><rect width="5" height="5"/><text x="1" y="1">Ada</text></svg>';

  it('lets a plain drawing through and prints it inside a labelled figure', () => {
    expect(checkSvg(plain)).toBe(plain);
    const html = renderHtml({
      title: 'Chart',
      metadata: [],
      sections: [{ title: '', blocks: [{ kind: 'svg', title: 'A "chart"', svg: plain }] }],
    });
    expect(html).toContain(`<figure role="img" aria-label="A &quot;chart&quot;">${plain}`);
  });

  it.each([
    ['a script', '<svg><script>alert(1)</script></svg>'],
    ['an event handler', '<svg><rect onload="x()"/></svg>'],
    ['a link', '<svg><a href="#x"><rect/></a></svg>'],
    ['an address', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ['a picture', '<svg><image/></svg>'],
    ['a style that fetches', '<svg><style>@import "x";</style></svg>'],
    ['a url()', '<svg><rect fill="url(#a)"/></svg>'],
    ['a foreignObject', '<svg><foreignObject></foreignObject></svg>'],
    ['an onload with no space', '<svg/onload=x></svg>'],
    ['an onload with a quoted slash', '<svg/onload="x()"></svg>'],
    ['an object', '<svg><object data="x"></object></svg>'],
    ['an embed', '<svg><embed src="x"/></svg>'],
    ['an iframe', '<svg><iframe></iframe></svg>'],
    ['an img', '<svg><img/></svg>'],
    ['a meta refresh', '<svg><meta http-equiv="refresh" content="0"/></svg>'],
    ['a form between two svgs', '<svg></svg><form action="x"><input/></form><svg></svg>'],
    ['a second root', '<svg></svg><svg></svg>'],
    ['a form inside', '<svg><form></form></svg>'],
    ['text outside a text element', '<svg>loose text</svg>'],
    ['markup in an attribute', '<svg><rect fill="a>b"/></svg>'],
    ['a style attribute', '<svg><rect style="fill:red"/></svg>'],
    ['an unquoted attribute', '<svg><rect width=5/></svg>'],
    ['mismatched tags', '<svg><g></svg></g>'],
    ['an unclosed element', '<svg><g></svg>'],
    ['an uppercase tag', '<SVG></SVG>'],
    ['not one svg', '<div></div>'],
    ['trailing markup', '<svg></svg><p></p>'],
  ])('refuses a drawing with %s', (_what, svg) => {
    expect(() => checkSvg(svg)).toThrow(ReportError);
    expect(() =>
      renderHtml({
        title: 'Chart',
        metadata: [],
        sections: [{ title: '', blocks: [{ kind: 'svg', title: 't', svg }] }],
      }),
    ).toThrow(ReportError);
  });
});
