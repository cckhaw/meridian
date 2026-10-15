import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml, type HTMLElement, type Node } from 'node-html-parser';
import { defaultTemplate, PAGE_SIZES_MM, TOKENS, validateTemplate, type Block, type ItemColumn, type PageSizeId, type Placement, type Style, type TemplateSchema } from './schema.js';

/**
 * Brings a template made for another system into Meridian's own model. Three kinds of input are understood: an HTML page with CSS (a flowing layout), a JSON design
 * (a list of elements, placed at fixed positions or flowing), and an XML layout (the same elements in XML). What cannot be carried over is listed in the report, never
 * dropped silently, and the result is a draft the designer opens like any other.
 */
export interface ConversionReport {
  format: 'HTML' | 'JSON' | 'XML';
  blocks: number;
  warnings: string[];
  /** Elements or properties that were not converted. */
  unsupported: string[];
  tokens: { mapped: Record<string, string>; unknown: string[] };
}
export interface Conversion { template: TemplateSchema; report: ConversionReport }

// ───────────────────────── tokens ─────────────────────────
const ALIASES: Record<string, string> = {
  customername: 'customer.name', custname: 'customer.name', clientname: 'customer.name', name: 'customer.name', subscribername: 'customer.name',
  address: 'customer.address', customeraddress: 'customer.address', billingaddress: 'customer.address', addr: 'customer.address', mailingaddress: 'customer.address',
  email: 'customer.email', customeremail: 'customer.email', phone: 'customer.phone', msisdn: 'customer.phone', mobile: 'customer.phone', customerphone: 'customer.phone', customerid: 'customer.id',
  invoiceno: 'invoice.number', invoicenumber: 'invoice.number', billno: 'invoice.number', billnumber: 'invoice.number', invno: 'invoice.number', invoiceid: 'invoice.number',
  invoicedate: 'invoice.issueDate', billdate: 'invoice.issueDate', issuedate: 'invoice.issueDate', date: 'invoice.issueDate', statementdate: 'invoice.issueDate',
  duedate: 'invoice.dueDate', paymentdue: 'invoice.dueDate', payby: 'invoice.dueDate', paymentduedate: 'invoice.dueDate',
  periodstart: 'invoice.periodStart', fromdate: 'invoice.periodStart', billfrom: 'invoice.periodStart', cyclestart: 'invoice.periodStart', periodend: 'invoice.periodEnd', todate: 'invoice.periodEnd', billto: 'invoice.periodEnd', cycleend: 'invoice.periodEnd',
  subtotal: 'invoice.net', net: 'invoice.net', netamount: 'invoice.net', amountbeforetax: 'invoice.net', tax: 'invoice.tax', gst: 'invoice.tax', vat: 'invoice.tax', taxamount: 'invoice.tax', taxname: 'invoice.taxName',
  total: 'invoice.total', totalamount: 'invoice.total', grandtotal: 'invoice.total', invoicetotal: 'invoice.total', amountdue: 'invoice.balance', totaldue: 'invoice.balance', balance: 'invoice.balance', outstanding: 'invoice.balance', balancedue: 'invoice.balance',
  paid: 'invoice.paid', amountpaid: 'invoice.paid', currency: 'invoice.currency',
  accountno: 'account.id', accountnumber: 'account.id', accountid: 'account.id', acct: 'account.id', accountname: 'account.name',
  company: 'company.name', companyname: 'company.name', operator: 'company.name', page: 'page.number', pageno: 'page.number', pagenumber: 'page.number', pages: 'page.count', totalpages: 'page.count', pagecount: 'page.count',
  paymenturl: 'payment.url', paylink: 'payment.url', qrurl: 'payment.url', qr: 'payment.url', paymentref: 'payment.reference', reference: 'payment.reference', paymentreference: 'payment.reference',
};
const CANONICAL = new Set(TOKENS.map((t) => t.token));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// {{x}}  ${x}  [[x]]  %x%  <%= x %>  {x}
const TOKEN_FORMS = [/\{\{\s*([A-Za-z0-9_.\- ]+?)\s*\}\}/g, /\$\{\s*([A-Za-z0-9_.\- ]+?)\s*\}/g, /\[\[\s*([A-Za-z0-9_.\- ]+?)\s*\]\]/g, /<%=?\s*([A-Za-z0-9_.\- ]+?)\s*%>/g, /%([A-Za-z][A-Za-z0-9_]{2,})%/g];

class Tokens {
  mapped: Record<string, string> = {};
  unknown = new Set<string>();
  constructor(private custom: Record<string, string> = {}) {}
  /** Rewrites every kind of token in a text into {{canonical}}; tokens that match nothing stay readable as «name». */
  text(s: string): string {
    let out = s;
    for (const re of TOKEN_FORMS) out = out.replace(re, (_, raw: string) => this.one(raw.trim()));
    return out;
  }
  one(raw: string): string {
    const key = raw.replace(/^(data|invoice\.data|model)\./i, '');
    const target = this.custom[raw] ?? this.custom[key] ?? (CANONICAL.has(key) ? key : ALIASES[norm(key)]);
    if (target && CANONICAL.has(target)) { if (target !== key) this.mapped[raw] = target; return `{{${target}}}`; }
    this.unknown.add(raw);
    return `«${raw}»`;
  }
}

// ───────────────────────── common helpers ─────────────────────────
const COLORS: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080', navy: '#000080', orange: '#ffa500', silver: '#c0c0c0', maroon: '#800000', teal: '#008080', purple: '#800080', yellow: '#ffff00' };
export function cssColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(t);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`;
  return COLORS[t];
}
const unitToMm = (n: number, unit: string): number => (unit === 'pt' ? n * 25.4 / 72 : unit === 'px' ? n * 25.4 / 96 : unit === 'in' ? n * 25.4 : unit === 'cm' ? n * 10 : n);
function length(v: string | number | undefined, unit = 'mm'): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return unitToMm(v, unit);
  const m = /^(-?[\d.]+)\s*(mm|cm|pt|px|in|em|rem)?$/.exec(String(v).trim());
  if (!m) return undefined;
  const u = m[2] ?? unit;
  return u === 'em' || u === 'rem' ? Number(m[1]) * 4.2 : unitToMm(Number(m[1]), u);
}
function sizePt(v: string | number | undefined, unit = 'pt'): number | undefined {
  if (v === undefined || v === '') return undefined;
  const m = /^([\d.]+)\s*(pt|px|em|rem|mm)?$/.exec(String(v).trim());
  if (!m) return undefined;
  const n = Number(m[1]), u = m[2] ?? unit;
  const pt = u === 'px' ? n * 0.75 : u === 'em' || u === 'rem' ? n * 10 : u === 'mm' ? n * 72 / 25.4 : n;
  return Math.round(pt * 10) / 10;
}
const STREAM_WORDS: Array<[RegExp, string]> = [[/usage|voice|data|sms|call|roam/i, 'USAGE'], [/vas|partner|content|third/i, 'THIRD_PARTY'], [/instal|device|handset|equipment/i, 'DEVICE_INSTALMENT'], [/\betc\b|terminat|penalt/i, 'ETC'], [/plan|subscri|recurr|rental|monthly/i, 'SUBSCRIPTION'], [/goods|hardware/i, 'GOODS'], [/one.?time|connection|activation/i, 'ONE_TIME']];
const COLUMN_WORDS: Array<[RegExp, ItemColumn]> = [[/desc|item|detail|charge|particular|name/i, 'description'], [/service|number|msisdn|line|circuit/i, 'service'], [/tax|gst|vat/i, 'tax'], [/total|gross|incl/i, 'total'], [/amount|net|price|cost|value|fee/i, 'net']];

interface Builder { blocks: number; unsupported: Set<string>; warnings: Set<string>; tokens: Tokens; nextId: number }
const bid = (b: Builder) => `b${++b.nextId}`;

/** An element of an item table: columns from field names or headings, and the kind of charge it lists from a name. */
function itemsBlock(b: Builder, title: string, source: string | undefined, fields: string[]): Block {
  const cols: ItemColumn[] = [];
  for (const f of fields) { const hit = COLUMN_WORDS.find(([re]) => re.test(f))?.[1]; if (hit && !cols.includes(hit)) cols.push(hit); else if (!hit) b.warnings.add(`The table column “${f}” has no counterpart (the columns are description, service, amount, tax, total) and was left out.`); }
  if (!cols.includes('description')) cols.unshift('description');
  const hit = source ? STREAM_WORDS.find(([re]) => re.test(source))?.[1] : undefined;
  if (source && !hit && !/^(lines|items|all|charges|rows)$/i.test(source)) b.warnings.add(`The table source “${source}” is not a kind of charge, so the table lists every charge.`);
  b.blocks++;
  return { id: bid(b), type: 'items', title: title || (hit ? ({ USAGE: 'Usage', THIRD_PARTY: 'Partner services', DEVICE_INSTALMENT: 'Device instalments', ETC: 'Early termination', SUBSCRIPTION: 'Plans', GOODS: 'Goods', ONE_TIME: 'One-time charges' } as Record<string, string>)[hit]! : 'Charges'), filter: hit ? { streams: [hit] } : {}, columns: cols, showSubtotal: true, hideIfEmpty: true };
}

// ───────────────────────── HTML ─────────────────────────
type Css = Array<{ sel: string; decl: Record<string, string> }>;
function parseCss(text: string): Css {
  const out: Css = [];
  for (const m of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const decl: Record<string, string> = {};
    for (const d of m[2]!.split(';')) { const i = d.indexOf(':'); if (i > 0) decl[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); }
    for (const sel of m[1]!.split(',')) out.push({ sel: sel.trim(), decl });
  }
  return out;
}
function styleOf(el: HTMLElement, css: Css): Record<string, string> {
  const tag = el.tagName?.toLowerCase() ?? '';
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const id = el.getAttribute('id');
  const merged: Record<string, string> = {};
  for (const r of css) if (r.sel === tag || (id && r.sel === `#${id}`) || classes.some((c) => r.sel === `.${c}` || r.sel === `${tag}.${c}`)) Object.assign(merged, r.decl);
  for (const d of (el.getAttribute('style') ?? '').split(';')) { const i = d.indexOf(':'); if (i > 0) merged[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); }
  return merged;
}
function blockStyle(st: Record<string, string>): Style {
  const s: Style = {};
  const size = sizePt(st['font-size'], 'px'); if (size) s.size = size;
  if (/bold|[6-9]00/.test(st['font-weight'] ?? '')) s.bold = true;
  if (/italic/.test(st['font-style'] ?? '')) s.italic = true;
  if (st['text-align'] === 'center' || st['text-align'] === 'right') s.align = st['text-align'];
  const c = cssColor(st.color); if (c) s.color = c;
  const bg = cssColor(st['background-color'] ?? (st.background && !/url|gradient/.test(st.background) ? st.background : undefined)); if (bg) s.bg = bg;
  const mt = length(st['margin-top'], 'px'), mb = length(st['margin-bottom'], 'px'); if (mt) s.mt = Math.min(20, mt); if (mb) s.mb = Math.min(20, mb);
  return s;
}
const textOf = (n: Node): string => {
  const el = n as HTMLElement;
  if (el.tagName?.toLowerCase() === 'br') return '\n';
  if (!el.childNodes?.length) return n.text;
  return el.childNodes.map(textOf).join('');
};
const cleanText = (s: string) => s.replace(/ /g, ' ').replace(/[ \t\r\f]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function htmlBlocks(nodes: Node[], css: Css, b: Builder, out: Block[]) {
  for (const n of nodes) {
    const el = n as HTMLElement;
    if (!el.tagName) { const t = cleanText(n.text); if (t) { out.push({ id: bid(b), type: 'text', text: b.tokens.text(t) }); b.blocks++; } continue; }
    const tag = el.tagName.toLowerCase();
    const st = styleOf(el, css);
    if (['script', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea'].includes(tag)) { b.unsupported.add(`<${tag}> (interactive or script content cannot be printed)`); continue; }
    if (['style', 'head', 'title', 'meta', 'link'].includes(tag)) continue;
    const brk = /always|page/.test(st['page-break-after'] ?? st['break-after'] ?? '') || /page-?break/.test(el.getAttribute('class') ?? '');
    if (/^h[1-6]$/.test(tag)) { out.push({ id: bid(b), type: 'heading', level: tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3, text: b.tokens.text(cleanText(textOf(el))), style: blockStyle(st) }); b.blocks++; }
    else if (tag === 'hr') { out.push({ id: bid(b), type: 'rule' }); b.blocks++; }
    else if (tag === 'br') { out.push({ id: bid(b), type: 'spacer', heightMm: 3 }); b.blocks++; }
    else if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      const w = length(el.getAttribute('width') ?? st.width, 'px') ?? 40;
      if (/^data:image\/(png|jpeg);base64,/.test(src)) out.push({ id: bid(b), type: 'image', src, widthMm: Math.min(w, 190) });
      else if (/logo|\{\{\s*logo|\$\{\s*logo|\[\[\s*logo/i.test(src + (el.getAttribute('alt') ?? '') + (el.getAttribute('class') ?? ''))) out.push({ id: bid(b), type: 'image', src: 'logo', widthMm: Math.min(w, 190) });
      else { b.unsupported.add(`<img src="${src.slice(0, 40)}${src.length > 40 ? '…' : ''}"> (only the logo and embedded PNG or JPEG images are carried over)`); continue; }
      b.blocks++;
    } else if (tag === 'table') {
      const rows = el.querySelectorAll('tr');
      const rep = rows.find((r) => r.hasAttribute('data-repeat') || r.hasAttribute('data-each') || /\b(item|line|charge)s?\b/i.test(r.getAttribute('class') ?? '') || /\{\{#(each|lines|items)|<%\s*for|\{%\s*for|th:each/i.test(r.outerHTML));
      const head = rows.find((r) => r.querySelector('th')) ?? rows[0];
      if (rep) {
        const heads = (head?.querySelectorAll('th,td') ?? []).map((c) => cleanText(textOf(c)));
        const fields = heads.length ? heads : rep.querySelectorAll('td').map((c) => cleanText(textOf(c)));
        const source = rep.getAttribute('data-repeat') ?? rep.getAttribute('data-each') ?? el.getAttribute('data-source') ?? el.getAttribute('summary') ?? el.getAttribute('id') ?? undefined;
        const title = el.querySelector('caption') ? cleanText(textOf(el.querySelector('caption')!)) : '';
        out.push(itemsBlock(b, title, source ?? title, fields));
      } else {
        const cells = rows.map((r) => r.querySelectorAll('th,td').map((c) => b.tokens.text(cleanText(textOf(c)))));
        if (cells.length && cells.every((r) => r.length === 2)) { out.push({ id: bid(b), type: 'keyvalue', rows: cells.map(([label, value]) => ({ label: label!, value: value! })) }); b.blocks++; }
        else {
          cells.forEach((r, i) => { const bold = i === 0 && !!rows[0]?.querySelector('th'); out.push({ id: bid(b), type: 'columns', columns: r.map((t) => [{ id: bid(b), type: 'text', text: t, style: bold ? { bold: true } : undefined }]) }); b.blocks++; });
          if (cells.length) b.warnings.add('A fixed table was turned into rows of columns: check its widths in the designer.');
        }
      }
    } else if (['ul', 'ol'].includes(tag)) {
      const lis = el.querySelectorAll('li').map((l, i) => `${tag === 'ol' ? `${i + 1}.` : '•'} ${cleanText(textOf(l))}`);
      out.push({ id: bid(b), type: 'text', text: b.tokens.text(lis.join('\n')), style: blockStyle(st) }); b.blocks++;
    } else if (tag === 'header' || tag === 'footer') { continue; }
    else {
      const blockKids = el.childNodes.filter((c) => { const t = (c as HTMLElement).tagName?.toLowerCase(); return t && ['div', 'p', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'hr', 'img', 'section', 'article'].includes(t); });
      const flex = /flex|grid/.test(st.display ?? '') && blockKids.length > 1;
      if (flex) {
        const cols = blockKids.map((k) => { const sub: Block[] = []; htmlBlocks([k], css, b, sub); return sub; });
        out.push({ id: bid(b), type: 'columns', columns: cols }); b.blocks++;
        b.warnings.add('A flex or grid row was turned into equal columns: adjust the widths in the designer.');
      } else if (blockKids.length) htmlBlocks(el.childNodes, css, b, out);
      else {
        const t = cleanText(textOf(el));
        if (t) {
          const s = blockStyle(st);
          if (s.bg && /^(div|p|section)$/.test(tag)) { out.push({ id: bid(b), type: 'band', bg: s.bg, color: s.color, heightMm: Math.max(8, 6 + t.split('\n').length * 5), size: s.size, text: b.tokens.text(t) }); }
          else { const { bg: _bg, ...rest } = s; out.push({ id: bid(b), type: 'text', text: b.tokens.text(t), style: rest }); }
          b.blocks++;
          if (/<(b|strong|i|em|u|span|a|font)\b/i.test(el.innerHTML)) b.warnings.add('Formatting inside a paragraph (bold or coloured words) is flattened: the paragraph keeps one style.');
        }
      }
    }
    if (brk) out.push({ id: bid(b), type: 'pagebreak' });
  }
}

function fromHtml(content: string, b: Builder, page: TemplateSchema): void {
  const root = parseHtml(content, { comment: false, blockTextElements: { script: false, noscript: false, style: true, pre: true } });
  const cssText = root.querySelectorAll('style').map((s) => s.text).join('\n');
  const css = parseCss(cssText);
  const at = /@page\s*\{([^}]*)\}/i.exec(cssText);
  if (at) {
    const size = /size\s*:\s*(A4|A5|letter)/i.exec(at[1]!); if (size) page.page.size = size[1]!.toUpperCase() as PageSizeId;
    const m = /margin\s*:\s*([\d.]+)\s*(mm|cm|pt|px|in)/i.exec(at[1]!); if (m) { const v = Math.min(60, Math.max(5, unitToMm(Number(m[1]), m[2]!.toLowerCase()))); page.page.marginsMm = { top: v, right: v, bottom: v, left: v }; }
  }
  const body = root.querySelector('body') ?? root;
  const hd = body.querySelector('header'), ft = body.querySelector('footer');
  if (hd) htmlBlocks(hd.childNodes, css, b, page.header);
  if (ft) htmlBlocks(ft.childNodes, css, b, page.footer);
  htmlBlocks(body.childNodes, css, b, page.body);
  const bst = body === root ? {} : styleOf(body as HTMLElement, css);
  const tc = cssColor(bst.color); if (tc) page.theme.text = tc;
  const fs = sizePt(bst['font-size'], 'px'); if (fs && fs >= 6 && fs <= 16) page.theme.baseSize = fs;
}

// ───────────────────────── JSON and XML: lists of elements ─────────────────────────
interface Elem { type: string; x?: number; y?: number; w?: number; h?: number; text?: string; style: Style; src?: string; fields?: string[]; source?: string; title?: string; page?: number; value?: string; caption?: string; section: 'header' | 'body' | 'footer'; level?: number; columns?: Elem[][] }

function elemBlocks(elems: Elem[], b: Builder, page: TemplateSchema) {
  for (const e of elems) {
    const place: Placement | undefined = e.x !== undefined && e.y !== undefined ? { x: Math.max(0, e.x), y: Math.max(0, e.y), w: e.w, page: e.page } : undefined;
    const tx = (s: string) => b.tokens.text(s);
    let blk: Block | null = null;
    switch (e.type) {
      case 'text': case 'label': case 'paragraph': blk = { id: bid(b), type: 'text', text: tx(e.text ?? ''), style: e.style }; break;
      case 'heading': case 'title': blk = { id: bid(b), type: 'heading', level: (e.level as 1 | 2 | 3) ?? 1, text: tx(e.text ?? ''), style: e.style }; break;
      case 'image': case 'logo': {
        const src = e.src ?? '';
        if (e.type === 'logo' || /logo/i.test(src) || /^\{\{?\s*logo/i.test(src)) blk = { id: bid(b), type: 'image', src: 'logo', widthMm: e.w ?? 40 };
        else if (/^data:image\/(png|jpeg);base64,/.test(src)) blk = { id: bid(b), type: 'image', src, widthMm: e.w ?? 40 };
        else b.unsupported.add(`image “${src.slice(0, 40)}” (only the logo and embedded PNG or JPEG images are carried over)`);
        break;
      }
      case 'line': case 'rule': case 'hr': blk = { id: bid(b), type: 'rule' }; break;
      case 'rect': case 'box': case 'shape': blk = e.style.bg && !place ? { id: bid(b), type: 'band', bg: e.style.bg, heightMm: e.h ?? 10 } : { id: bid(b), type: 'rect', heightMm: e.h ?? 10, bg: e.style.bg, border: e.style.color }; break;
      case 'band': blk = { id: bid(b), type: 'band', bg: e.style.bg ?? '#f2f2f7', color: e.style.color, heightMm: e.h ?? 12, text: e.text ? tx(e.text) : undefined, size: e.style.size }; break;
      case 'table': case 'items': blk = itemsBlock(b, e.title ?? '', e.source, e.fields ?? ['description', 'amount', 'tax', 'total']); break;
      case 'qr': case 'qrcode': blk = { id: bid(b), type: 'qr', value: tx(e.value ?? e.text ?? '{{payment.url}}'), sizeMm: e.w ?? e.h ?? 28, caption: e.caption, hideIfEmpty: true }; break;
      case 'barcode': blk = { id: bid(b), type: 'barcode', value: tx(e.value ?? e.text ?? '{{invoice.number}}'), heightMm: e.h ?? 12, widthMm: e.w, caption: e.caption }; break;
      case 'spacer': case 'space': blk = { id: bid(b), type: 'spacer', heightMm: e.h ?? 5 }; break;
      case 'pagebreak': blk = { id: bid(b), type: 'pagebreak' }; break;
      case 'columns': { const cols: Block[][] = []; for (const c of e.columns ?? []) { const tmp: TemplateSchema = { ...page, header: [], body: [], footer: [] }; elemBlocks(c.map((x) => ({ ...x, section: 'body' as const })), b, tmp); cols.push(tmp.body); } blk = { id: bid(b), type: 'columns', columns: cols }; break; }
      default: b.unsupported.add(`element “${e.type}”`); break;
    }
    if (!blk) continue;
    if (place && blk.type !== 'pagebreak') blk.placement = place;
    if (blk.type === 'rect' && !blk.placement) { b.warnings.add('A rectangle without a position was dropped.'); continue; }
    page[e.section].push(blk);
    b.blocks++;
  }
}

const num = (v: unknown, unit: string): number | undefined => (typeof v === 'number' || typeof v === 'string' ? length(v as string, unit) : undefined);
function jsonElem(raw: Record<string, unknown>, unit: string, section: Elem['section'], b: Builder): Elem {
  const type = String(raw.type ?? raw.kind ?? 'text').toLowerCase();
  const st: Style = {};
  const style = (raw.style ?? {}) as Record<string, unknown>;
  const get = (k: string, ...alt: string[]) => raw[k] ?? style[k] ?? alt.map((a) => raw[a] ?? style[a]).find((x) => x !== undefined);
  const size = get('fontSize', 'size', 'font_size'); const sz = sizePt(size as string, 'pt'); if (sz) st.size = sz;
  if (get('bold') === true || /bold|[6-9]00/.test(String(get('fontWeight', 'weight') ?? ''))) st.bold = true;
  if (get('italic') === true) st.italic = true;
  const al = get('align', 'textAlign'); if (al === 'center' || al === 'right') st.align = al;
  const c = cssColor(String(get('color') ?? '')); if (c) st.color = c;
  const bg = cssColor(String(get('fill', 'background', 'bg', 'backgroundColor') ?? '')); if (bg) st.bg = bg;
  const cols = (raw.columns ?? raw.fields) as unknown;
  const fields = Array.isArray(cols) ? cols.map((x) => (typeof x === 'string' ? x : String((x as Record<string, unknown>).title ?? (x as Record<string, unknown>).field ?? (x as Record<string, unknown>).name ?? ''))) : undefined;
  void b;
  return {
    type, section, style: st,
    x: num(raw.x ?? raw.left, unit), y: num(raw.y ?? raw.top, unit), w: num(raw.w ?? raw.width, unit), h: num(raw.h ?? raw.height, unit),
    text: raw.text !== undefined ? String(raw.text) : raw.content !== undefined ? String(raw.content) : raw.label !== undefined ? String(raw.label) : undefined,
    src: raw.src !== undefined ? String(raw.src) : raw.image !== undefined ? String(raw.image) : undefined,
    fields, source: raw.source !== undefined ? String(raw.source) : raw.data !== undefined ? String(raw.data) : undefined, title: raw.title !== undefined ? String(raw.title) : undefined,
    page: typeof raw.page === 'number' ? raw.page : undefined, value: raw.value !== undefined ? String(raw.value) : undefined, caption: raw.caption !== undefined ? String(raw.caption) : undefined,
    level: typeof raw.level === 'number' ? Math.min(3, Math.max(1, raw.level)) : undefined,
  };
}

function pageFromHints(page: TemplateSchema, p: Record<string, unknown> | undefined, unit: string) {
  if (!p) return;
  const s = typeof p.size === 'string' ? p.size.toUpperCase() : undefined;
  if (s && s in PAGE_SIZES_MM) page.page.size = s as PageSizeId;
  const w = num(p.width, unit), h = num(p.height, unit);
  if (w && h) { const best = (Object.entries(PAGE_SIZES_MM) as Array<[PageSizeId, { w: number; h: number }]>).sort((a, c) => Math.abs(a[1].w - w) + Math.abs(a[1].h - h) - (Math.abs(c[1].w - w) + Math.abs(c[1].h - h)))[0]!; page.page.size = best[0]; }
  const m = p.margin ?? p.margins;
  const v = typeof m === 'number' || typeof m === 'string' ? num(m, unit) : undefined;
  if (v !== undefined) { const c = Math.min(60, Math.max(5, v)); page.page.marginsMm = { top: c, right: c, bottom: c, left: c }; }
  else if (m && typeof m === 'object') { const mm = m as Record<string, unknown>; const g = (k: string, d: number) => Math.min(60, Math.max(5, num(mm[k], unit) ?? d)); page.page.marginsMm = { top: g('top', 16), right: g('right', 16), bottom: g('bottom', 18), left: g('left', 16) }; }
  if (typeof p.colorMode === 'string' && /cmyk/i.test(p.colorMode)) page.page.colorMode = 'CMYK';
}

function fromJson(content: string, b: Builder, page: TemplateSchema) {
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(content) as Record<string, unknown>; } catch { throw new Error('That is not valid JSON.'); }
  const pg = (doc.page ?? doc.pageSetup ?? doc.paper) as Record<string, unknown> | undefined;
  const unit = String((pg?.unit ?? doc.unit ?? 'mm')).toLowerCase();
  if (!['mm', 'pt', 'px', 'in', 'cm'].includes(unit)) throw new Error(`The unit “${unit}” is not one of mm, cm, in, pt or px.`);
  pageFromHints(page, pg, unit);
  const each = (list: unknown, section: Elem['section']): Elem[] => (Array.isArray(list) ? (list as Array<Record<string, unknown>>).filter((x) => x && typeof x === 'object').map((x) => jsonElem(x, unit, section, b)) : []);
  const sections = (doc.sections ?? doc) as Record<string, unknown>;
  const elems = [...each(sections.header, 'header'), ...each(sections.elements ?? sections.body ?? sections.blocks ?? sections.content ?? doc.elements, 'body'), ...each(sections.footer, 'footer')];
  if (!elems.length) throw new Error('No elements were found: a JSON design has a list called elements (or body, blocks or content).');
  const th = doc.theme as Record<string, unknown> | undefined;
  const tc = cssColor(String(th?.color ?? th?.text ?? '')); if (tc) page.theme.text = tc;
  const ac = cssColor(String(th?.accent ?? th?.primary ?? '')); if (ac) page.theme.accent = ac;
  elemBlocks(elems, b, page);
  for (const k of Object.keys(doc)) if (!['page', 'pageSetup', 'paper', 'unit', 'elements', 'body', 'blocks', 'content', 'header', 'footer', 'sections', 'theme', 'name', 'title', 'version', 'id', 'description'].includes(k)) b.unsupported.add(`property “${k}”`);
}

type XNode = Record<string, unknown>;
function fromXml(content: string, b: Builder, page: TemplateSchema) {
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true, processEntities: true });
  let tree: XNode[];
  try { tree = parser.parse(content) as XNode[]; } catch { throw new Error('That is not valid XML.'); }
  const rootEntry = tree.find((n) => Object.keys(n).some((k) => k !== ':@' && !k.startsWith('?') && !k.startsWith('!')));
  if (!rootEntry) throw new Error('That XML is empty.');
  const rootName = Object.keys(rootEntry).find((k) => k !== ':@')!;
  const attrs = (n: XNode): Record<string, unknown> => Object.fromEntries(Object.entries((n[':@'] ?? {}) as Record<string, unknown>).map(([k, v]) => [k.replace(/^@_/, ''), v]));
  const kids = (n: XNode, name: string): XNode[] => (n[name] ?? []) as XNode[];
  const nameOf = (n: XNode) => Object.keys(n).find((k) => k !== ':@')!;
  const textOfNode = (n: XNode): string => kids(n, nameOf(n)).map((c) => (typeof (c as XNode)['#text'] === 'string' || typeof (c as XNode)['#text'] === 'number' ? String((c as XNode)['#text']) : '')).join('');
  const unit = String(attrs(rootEntry).unit ?? 'mm').toLowerCase();
  const list = kids(rootEntry, rootName);
  const pageEl = list.find((n) => nameOf(n) === 'page');
  if (pageEl) pageFromHints(page, attrs(pageEl), unit);
  const toElem = (n: XNode, section: Elem['section']): Elem | null => {
    const tag = nameOf(n);
    if (['page', 'header', 'body', 'footer', 'column'].includes(tag)) return null;
    const a = attrs(n);
    const raw: Record<string, unknown> = { ...a, type: tag, text: a.text ?? (textOfNode(n) || undefined), value: a.value ?? (['qr', 'qrcode', 'barcode'].includes(tag) ? textOfNode(n) || undefined : undefined) };
    if (tag === 'table' || tag === 'items') raw.columns = kids(n, tag).filter((c) => nameOf(c) === 'column').map((c) => attrs(c));
    if (tag === 'columns') {
      const el = jsonElem(raw, unit, section, b);
      el.columns = kids(n, tag).filter((c) => nameOf(c) === 'column').map((c) => kids(c, 'column').map((x) => toElem(x, 'body')).filter((x): x is Elem => !!x));
      return el;
    }
    for (const bool of ['bold', 'italic']) if (typeof raw[bool] === 'string') raw[bool] = raw[bool] === 'true' || raw[bool] === '1';
    return jsonElem(raw, unit, section, b);
  };
  const elems: Elem[] = [];
  for (const section of ['header', 'body', 'footer'] as const) {
    const sec = list.find((n) => nameOf(n) === section);
    if (sec) for (const c of kids(sec, section)) { const e = toElem(c, section); if (e) elems.push(e); }
  }
  if (!list.some((n) => ['header', 'body', 'footer'].includes(nameOf(n)))) for (const c of list) { const e = toElem(c, 'body'); if (e) elems.push(e); }
  if (!elems.length) throw new Error('No elements were found in that XML layout.');
  elemBlocks(elems, b, page);
}

// ───────────────────────── entry point ─────────────────────────
export function convertLegacy(input: { format: 'HTML' | 'JSON' | 'XML'; content: string; tokenMap?: Record<string, string> }): Conversion {
  if (!input.content.trim()) throw new Error('The file is empty.');
  if (input.content.length > 2_000_000) throw new Error('The file is larger than 2 MB.');
  const page = defaultTemplate();
  page.header = []; page.body = []; page.footer = [];
  const b: Builder = { blocks: 0, unsupported: new Set(), warnings: new Set(), tokens: new Tokens(input.tokenMap), nextId: 0 };
  if (input.format === 'HTML') fromHtml(input.content, b, page);
  else if (input.format === 'JSON') fromJson(input.content, b, page);
  else fromXml(input.content, b, page);
  if (!page.body.length) throw new Error('Nothing in that file could be turned into a block.');
  const problems = validateTemplate(page);
  const warnings = [...b.warnings, ...(b.tokens.unknown.size ? [`${b.tokens.unknown.size} field${b.tokens.unknown.size === 1 ? '' : 's'} of the old template have no counterpart and are shown as «name»: ${[...b.tokens.unknown].slice(0, 8).join(', ')}. Replace them with fields from the picker.`] : []), ...problems.filter((p) => !/«/.test(p.message)).slice(0, 5).map((p) => `After conversion: ${p.message}`)];
  return { template: page, report: { format: input.format, blocks: b.blocks, warnings, unsupported: [...b.unsupported], tokens: { mapped: b.tokens.mapped, unknown: [...b.tokens.unknown] } } };
}
