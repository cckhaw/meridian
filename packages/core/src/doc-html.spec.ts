import { describe, expect, it } from 'vitest';
import { diffLines, sanitizeHtml, textLines, toBlocks } from './doc-html.js';

describe('agreement HTML', () => {
  it('keeps the safe subset and removes everything executable', () => {
    const dirty = `<h1 onclick="x()">Agreement</h1><script>alert(1)</script><p style="text-align:center;color:red">Hi <b>there</b> <a href="javascript:alert(1)">link</a><img src=x onerror=alert(1)></p><iframe src="//evil"></iframe><style>p{}</style>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).toBe('<h1>Agreement</h1><p data-align="center">Hi <strong>there</strong> link</p>');
    expect(sanitizeHtml('<p>1 < 2 & 3 > 2</p>')).toBe('<p>1 &lt; 2 &amp; 3 &gt; 2</p>');
    expect(sanitizeHtml('<p>unclosed <em>text')).toBe('<p>unclosed <em>text</em></p>');
    expect(sanitizeHtml('<li>loose</li>')).toBe('<ul><li>loose</li></ul>');
  });
  it('turns the text into blocks with their emphasis, lists and tables', () => {
    const b = toBlocks('<h2>Terms</h2><p>You <strong>must</strong> pay.</p><ol><li>one</li><li>two</li></ol><hr><table><tr><th>A</th><td>B</td></tr></table>');
    expect(b.map((x) => x.type)).toEqual(['h2', 'p', 'li', 'li', 'hr', 'row']);
    expect(b[1]!.runs.find((r) => r.bold)?.text).toBe('must');
    expect(b[3]).toMatchObject({ ordered: true, index: 2 });
    expect(b[5]!.cells!.map((c) => c.map((r) => r.text).join(''))).toEqual(['A', 'B']);
  });
  it('compares two versions line by line', () => {
    const d = diffLines(textLines('<p>A</p><p>B</p><p>C</p>'), textLines('<p>A</p><p>C</p><p>D</p>'));
    expect(d).toEqual([{ op: 'same', text: 'A' }, { op: 'del', text: 'B' }, { op: 'same', text: 'C' }, { op: 'add', text: 'D' }]);
  });
});

describe('agreement HTML against hostile input', () => {
  const vectors = [
    '<script>alert(1)</script>', '<ScRiPt>alert(1)</sCrIpT>', '<<script>script>alert(1)<</script>/script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)><circle/></svg>',
    '<a href="javascript:alert(1)">x</a>', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<p onclick="alert(1)" style="background:url(javascript:alert(1))">x</p>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '<!--><img src=x onerror=alert(1)>-->',
    '<p title="x" onmouseover=alert(1)>hover', '<p/onclick=alert(1)>x', '<form action=javascript:alert(1)><input type=submit></form>', '<object data="javascript:alert(1)"></object>', '<embed src=javascript:alert(1)>',
    '<base href="//evil/">', '<link rel=stylesheet href=//evil/x.css>', '<meta http-equiv=refresh content="0;url=//evil">', '<style>@import "//evil"</style>', '<template><script>alert(1)</script></template>',
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', '<p>&#60;img src=x onerror=alert(1)&#62;</p>', '<td data-align="javascript:alert(1)" align="center">x</td>', '<p align="expression(alert(1))">x</p>', '<b><i></b></i><u>', '<li><li><p>x',
  ];
  const ALLOWED = /^(?:<\/?(?:h1|h2|h3|p|ul|ol|li|blockquote|table|thead|tbody|tr|th|td|strong|em|u|span|br|hr)(?: data-align="(?:left|center|right|justify)")?>|[^<>]+)*$/;
  it('only ever produces the allowed tags with an optional recognised alignment, never an executable or linkable thing', () => {
    for (const v of vectors) {
      const out = sanitizeHtml(v);
      expect(out, v).toMatch(ALLOWED);
      const tags = out.match(/<[^>]*>/g) ?? [];                      // text may mention anything (it is escaped); what matters is the markup
      expect(tags.join(''), v).not.toMatch(/script|img|svg|iframe|<a[ >]|style|form|input|object|embed|link|meta|base|javascript:|on[a-z]+=/i);
    }
  });
  it('is stable: cleaning clean output changes nothing, so nothing can be turned into markup by a second pass', () => {
    for (const v of vectors) { const once = sanitizeHtml(v); expect(sanitizeHtml(once), v).toBe(once); }
  });
  it('keeps the text a person wrote, including characters that look like markup', () => {
    expect(sanitizeHtml('<p>Pay "on time" &amp; keep it &lt;safe&gt;</p>')).toBe('<p>Pay &quot;on time&quot; &amp; keep it &lt;safe&gt;</p>');
    expect(sanitizeHtml('<p>a&nbsp;b</p>')).toBe('<p>a b</p>');
    expect(sanitizeHtml('<p>line<br/>two</p><hr/>')).toBe('<p>line<br>two</p><hr>');
    expect(sanitizeHtml('<div style="text-align: right">x</div>')).toBe('<p data-align="right">x</p>');
    expect(sanitizeHtml('<td align="CENTER">x</td>')).toBe('<td data-align="center">x</td>');
  });
});
