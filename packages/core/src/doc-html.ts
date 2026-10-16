/**
 * The agreement text. Authors write it in a rich-text editor, so what is stored is HTML, but only a small, safe subset of it: headings, paragraphs,
 * emphasis, lists, simple tables and rules. Everything else (scripts, styles, links, images, event handlers, unknown tags and attributes) is
 * removed on the way in, so the same text can be shown in the CRM, turned into a PDF, and never carries anything executable.
 */
const BLOCK = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div']);
const INLINE = new Set(['strong', 'b', 'em', 'i', 'u', 'span']);
const VOID = new Set(['br', 'hr']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'head', 'title']);
const ALIGN = new Set(['left', 'center', 'right', 'justify']);
const NORMAL: Record<string, string> = { b: 'strong', i: 'em', div: 'p' };

const unescapeText = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&');
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const alignOf = (attrs: string): string | null => {
  const m = /text-align\s*:\s*(left|center|right|justify)/i.exec(attrs) ?? /\balign\s*=\s*["']?(left|center|right|justify)/i.exec(attrs);
  return m && ALIGN.has(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : null;
};

export function sanitizeHtml(input: string): string {
  const src = String(input ?? '').slice(0, 400_000);
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>|([^<]+)|</g;
  const out: string[] = [], stack: string[] = [];
  let skipUntil: string | null = null, m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const whole = m[0];
    if (whole.startsWith('<!--')) continue;
    if (m[3] !== undefined) { if (!skipUntil) out.push(escapeHtml(unescapeText(m[3]))); continue; }
    if (!m[1]) { if (!skipUntil) out.push('&lt;'); continue; }
    const raw = m[1].toLowerCase(), closing = whole.startsWith('</');
    if (skipUntil) { if (closing && raw === skipUntil) skipUntil = null; continue; }
    if (DROP_WITH_CONTENT.has(raw)) { if (!closing && !whole.endsWith('/>')) skipUntil = raw; continue; }
    const tag = NORMAL[raw] ?? raw;
    if (VOID.has(tag)) { if (!closing) out.push(`<${tag}>`); continue; }
    if (!BLOCK.has(raw) && !INLINE.has(raw)) continue;      // unknown tag: its text is kept, the tag is not
    if (closing) {
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
    } else {
      const a = alignOf(m[2] ?? '');
      const align = a && ['p', 'h1', 'h2', 'h3', 'th', 'td', 'li', 'blockquote'].includes(tag) ? ` data-align="${a}"` : '';
      if ((tag === 'li' && !['ul', 'ol'].includes(stack[stack.length - 1] ?? '')) ) { out.push('<ul>'); stack.push('ul'); }
      stack.push(tag); out.push(`<${tag}${align}>`);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('');
}

export interface Run { text: string; bold?: boolean; italic?: boolean; underline?: boolean }
export interface Block { type: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'hr' | 'row'; runs: Run[]; align: string; ordered?: boolean; index?: number; depth?: number; cells?: Run[][] }

/** Sanitised HTML as the list of blocks the PDF writer lays out. */
export function toBlocks(html: string): Block[] {
  const clean = sanitizeHtml(html), re = /<(\/?)([a-z0-9]+)((?:\s+data-align="[a-z]+")?)>|([^<]+)/g;
  const blocks: Block[] = [];
  const fmt = { bold: 0, italic: 0, underline: 0 };
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let cur: Block | null = null, cell: Run[] | null = null, row: Block | null = null, m: RegExpExecArray | null;
  const open = (type: Block['type'], align: string, extra: Partial<Block> = {}) => { cur = { type, runs: [], align: align || 'left', ...extra }; blocks.push(cur); };
  while ((m = re.exec(clean))) {
    if (m[4] !== undefined) {
      const text = unescapeText(m[4]);
      if (!text.trim() && !cur && !cell) continue;
      const run: Run = { text, ...(fmt.bold ? { bold: true } : {}), ...(fmt.italic ? { italic: true } : {}), ...(fmt.underline ? { underline: true } : {}) };
      if (cell) cell.push(run); else { if (!cur) open('p', 'left'); cur!.runs.push(run); }
      continue;
    }
    const closing = m[1] === '/', tag = m[2]!, align = /"(\w+)"/.exec(m[3] ?? '')?.[1] ?? '';
    switch (tag) {
      case 'strong': fmt.bold += closing ? -1 : 1; break;
      case 'em': fmt.italic += closing ? -1 : 1; break;
      case 'u': fmt.underline += closing ? -1 : 1; break;
      case 'h1': case 'h2': case 'h3': case 'p': case 'blockquote': if (cell) break; if (closing) cur = null; else open(tag === 'blockquote' ? 'quote' : tag, align); break;
      case 'ul': case 'ol': if (closing) lists.pop(); else lists.push({ ordered: tag === 'ol', n: 0 }); cur = null; break;
      case 'li': if (closing) cur = null; else { const l = lists[lists.length - 1]; if (l) l.n++; open('li', align, { ordered: l?.ordered, index: l?.n, depth: Math.max(0, lists.length - 1) }); } break;
      case 'br': if (cell) cell.push({ text: ' ' }); else { if (!cur) open('p', 'left'); cur!.runs.push({ text: '\n' }); } break;
      case 'hr': cur = null; blocks.push({ type: 'hr', runs: [], align: 'left' }); break;
      case 'tr': if (closing) { if (row) blocks.push(row); row = null; } else row = { type: 'row', runs: [], align: 'left', cells: [] }; cur = null; break;
      case 'th': case 'td': if (closing) { if (cell && row) row.cells!.push(cell); cell = null; } else cell = []; break;
      default: break;
    }
  }
  return blocks;
}

/** The plain words of some HTML, for diffs and search. */
export const textLines = (html: string): string[] => toBlocks(html).map((b) => (b.type === 'row' ? (b.cells ?? []).map((c) => c.map((r) => r.text).join('')).join(' | ') : b.type === 'hr' ? '———' : b.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim())).filter(Boolean);

/** A line-by-line comparison of two versions: lines kept, removed and added, in reading order. */
export function diffLines(a: string[], b: string[]): Array<{ op: 'same' | 'del' | 'add'; text: string }> {
  const n = a.length, m = b.length, lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Array<{ op: 'same' | 'del' | 'add'; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: 'del', text: a[i++]! });
    else out.push({ op: 'add', text: b[j++]! });
  }
  while (i < n) out.push({ op: 'del', text: a[i++]! });
  while (j < m) out.push({ op: 'add', text: b[j++]! });
  return out;
}
