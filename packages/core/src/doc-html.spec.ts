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
