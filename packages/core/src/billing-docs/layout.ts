import { formatMoney } from '@meridian/types';
import { code128Bars, qrMatrix } from './codes.js';
import { fillTokens, PAGE_SIZES_MM, STREAMS, type Block, type InvoiceDoc, type Placement, type Style, type TemplateSchema } from './schema.js';

/**
 * The one layout engine. It turns a template and an invoice into pages of drawing operations in millimetres from the top-left of the trimmed page, so the PDF
 * and the designer's preview are drawn from the same positions. Text widths come from a `Measurer` (the typeface's real metrics on the server).
 */
export interface Measurer { /** Width in millimetres of `text` set at `size` points. */ width(text: string, size: number, bold: boolean): number }
export type Op =
  | { t: 'text'; x: number; y: number; text: string; size: number; bold: boolean; italic: boolean; color: string; block?: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokeW?: number; bleed?: boolean; block?: string }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; w: number }
  | { t: 'image'; x: number; y: number; w: number; h: number; src: string; block?: string }
  | { t: 'qr'; x: number; y: number; size: number; modules: boolean[][]; color: string; block?: string }
  | { t: 'bars'; x: number; y: number; w: number; h: number; bars: Array<[number, number]>; modules: number; color: string; block?: string };
export interface LayoutPage { ops: Op[]; blocks: Array<{ id: string; x: number; y: number; w: number; h: number }> }
export interface Layout { widthMm: number; heightMm: number; pages: LayoutPage[]; warnings: string[] }

const MM_PER_PT = 25.4 / 72;
const LINE = 1.35;
export const SENT_N = '\u0001N\u0001', SENT_C = '\u0001C\u0001';

/** Pixel size of a PNG or JPEG data URI, to keep an image's proportions. */
export function imageInfo(src: string): { w: number; h: number; kind: 'png' | 'jpg' } | null {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(src);
  if (!m) return null;
  const b = Buffer.from(m[2]!, 'base64');
  if (m[1] === 'png') return b.length > 24 && b.toString('ascii', 1, 4) === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kind: 'png' } : null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), kind: 'jpg' };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

export function layoutInvoice(t: TemplateSchema, doc: InvoiceDoc, meas: Measurer): Layout {
  const warnings: string[] = [];
  const { w: W, h: H } = PAGE_SIZES_MM[t.page.size];
  const mg = t.page.marginsMm;
  const cw = W - mg.left - mg.right;
  const base = t.theme.baseSize;
  const pages: LayoutPage[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };

  const fill = (s: string) => fillTokens(s.replaceAll('{{page.number}}', SENT_N).replaceAll('{{page.count}}', SENT_C), doc, { number: 0, count: 0 });
  const wrap = (text: string, w: number, size: number, bold: boolean): string[] => {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        if (!word) continue;
        const next = line + word;
        if (line && meas.width(next.trimEnd(), size, bold) > w) {
          out.push(line.trimEnd());
          line = /^\s+$/.test(word) ? '' : word;
        } else line = next;
      }
      out.push(line.trimEnd());
    }
    return out.length ? out : [''];
  };

  /** Sink: where operations and block boxes go. Null ops = measuring only. */
  interface Sink { ops: Op[] | null; boxes: LayoutPage['blocks'] | null }
  const none: Sink = { ops: null, boxes: null };

  function text(s: Sink, raw: string, x: number, y: number, w: number, st: Style | undefined, o: { size?: number; bold?: boolean; color?: string; block?: string } = {}): number {
    const size = st?.size ?? o.size ?? base, bold = st?.bold ?? o.bold ?? false;
    const lh = size * MM_PER_PT * LINE;
    const lines = wrap(fill(raw), w, size, bold);
    const mt = st?.mt ?? 0;
    lines.forEach((ln, i) => {
      if (!s.ops || !ln) return;
      const lw = meas.width(ln, size, bold);
      const dx = st?.align === 'right' ? w - lw : st?.align === 'center' ? (w - lw) / 2 : 0;
      s.ops.push({ t: 'text', x: x + dx, y: y + mt + i * lh + size * MM_PER_PT * 1.02 + (lh - size * MM_PER_PT * 1.2) / 2, text: ln, size, bold, italic: !!st?.italic, color: st?.color ?? o.color ?? t.theme.text, block: o.block });
    });
    return mt + lines.length * lh + (st?.mb ?? 0);
  }

  function box(s: Sink, id: string, x: number, y: number, w: number, h: number) { s.boxes?.push({ id, x, y, w, h }); }

  /** Draws one block that does not split across pages and returns its height. */
  function draw(b: Block, s: Sink, x: number, y: number, w: number): number {
    switch (b.type) {
      case 'text': { const h = text(s, b.text, x, y, w, b.style, { block: b.id }); box(s, b.id, x, y, w, h); return h; }
      case 'heading': { const k = [1.9, 1.5, 1.2][b.level - 1]!; const h = text(s, b.text, x, y, w, { mb: 1.5, ...b.style }, { size: base * k, bold: true, block: b.id }); box(s, b.id, x, y, w, h); return h; }
      case 'spacer': return b.heightMm;
      case 'pagebreak': return 0;
      case 'rule': { s.ops?.push({ t: 'line', x1: x, y1: y + 0.75, x2: x + w, y2: y + 0.75, color: b.color ?? '#d2d2d7', w: 0.2 }); return 1.5; }
      case 'rect': { s.ops?.push({ t: 'rect', x, y, w, h: b.heightMm, fill: b.bg, stroke: b.border, strokeW: 0.2, block: b.id }); box(s, b.id, x, y, w, b.heightMm); return b.heightMm; }
      case 'band': {
        const atTop = y < 1;
        s.ops?.push({ t: 'rect', x, y, w, h: b.heightMm, fill: b.bg, bleed: !!b.bleed && w >= cw - 0.01, block: b.id });
        void atTop;
        if (b.text) { const size = b.size ?? base * 1.3; const th = wrap(fill(b.text), w - 8, size, true).length * size * MM_PER_PT * LINE; text(s, b.text, x + 4, y + (b.heightMm - th) / 2, w - 8, { color: b.color ?? '#ffffff', bold: true, size }, { block: b.id }); }
        box(s, b.id, x, y, w, b.heightMm);
        return b.heightMm;
      }
      case 'image': {
        const src = b.src === 'logo' ? doc.company.logo : b.src;
        if (!src) { if (b.src === 'logo') warn('No logo is set (Settings → Appearance), so the logo is left out.'); return 0; }
        const info = imageInfo(src);
        if (!info) { warn('The logo is not a PNG or JPEG, so it is left out of the PDF.'); return 0; }
        const iw = Math.min(b.widthMm, w), ih = (iw * info.h) / info.w;
        const dx = b.align === 'right' ? w - iw : b.align === 'center' ? (w - iw) / 2 : 0;
        s.ops?.push({ t: 'image', x: x + dx, y, w: iw, h: ih, src, block: b.id });
        box(s, b.id, x + dx, y, iw, ih);
        return ih + 1.5;
      }
      case 'columns': {
        const n = b.columns.length, gap = b.gapMm ?? 6;
        const total = (b.widths ?? b.columns.map(() => 100 / n)).reduce((a, c) => a + c, 0);
        const avail = w - gap * (n - 1);
        let cx = x, tallest = 0;
        const heights = b.columns.map((col, i) => {
          const cwid = (avail * (b.widths?.[i] ?? 100 / n)) / total;
          let cy = y;
          for (const child of col) cy += draw(child, s, cx, cy, cwid);
          cx += cwid + gap;
          return cy - y;
        });
        tallest = Math.max(0, ...heights);
        box(s, b.id, x, y, w, tallest);
        return tallest;
      }
      case 'keyvalue': {
        const lw = w * 0.38, vw = w - lw - 2;
        let cy = y;
        for (const r of b.rows) {
          const hv = text(s, r.value, x + lw + 2, cy, vw, { ...b.style, bold: true }, { block: b.id });
          const hl = text(s, r.label, x, cy, lw, { ...b.style, color: t.theme.muted }, { block: b.id });
          cy += Math.max(hv, hl) + 0.8;
        }
        box(s, b.id, x, y, w, cy - y);
        return cy - y;
      }
      case 'summary': {
        const lab: Record<string, string> = { net: 'Amount before tax', tax: doc.invoice.taxName || 'Tax', total: 'Total', paid: 'Paid', credited: 'Credited', balance: 'Amount due', due: 'Amount due' };
        const val: Record<string, number> = { net: doc.invoice.netMinor, tax: doc.invoice.taxMinor, total: doc.invoice.totalMinor, paid: doc.invoice.paidMinor, credited: doc.invoice.creditedMinor, balance: doc.invoice.balanceMinor, due: doc.invoice.balanceMinor };
        const bw = Math.min(w, 84), bx = x + w - bw;
        let cy = y;
        if (b.title) cy += text(s, b.title, bx, cy, bw, { mb: 1.5 }, { bold: true, size: base * 1.2, block: b.id });
        for (const r of b.rows) {
          const strong = r === 'total' || r === 'balance' || r === 'due';
          if (strong) { s.ops?.push({ t: 'line', x1: bx, y1: cy, x2: bx + bw, y2: cy, color: '#d2d2d7', w: 0.2 }); cy += 1; }
          const size = strong ? base * 1.15 : base;
          const hl = text(s, lab[r]!, bx, cy, bw * 0.55, { size, bold: strong, color: strong ? undefined : t.theme.muted }, { block: b.id });
          text(s, formatMoney(val[r]!, doc.regional), bx + bw * 0.45, cy, bw * 0.55, { size, bold: strong, align: 'right' }, { block: b.id });
          cy += hl + 0.6;
        }
        box(s, b.id, bx, y, bw, cy - y);
        return cy - y;
      }
      case 'qr': {
        const value = fill(b.value);
        if (!value) { if (!b.hideIfEmpty) warn('A QR code has nothing to encode: set the payment page address (Settings → Billing templates).'); return 0; }
        const size = Math.min(b.sizeMm, w);
        s.ops?.push({ t: 'qr', x, y, size, modules: qrMatrix(value), color: '#000000', block: b.id });
        let h = size;
        if (b.caption) h += text(s, b.caption, x, y + size + 0.5, size, { size: base * 0.85, align: 'center', color: t.theme.muted }, { block: b.id });
        box(s, b.id, x, y, size, h);
        return h + 1;
      }
      case 'barcode': {
        const value = fill(b.value);
        if (!value) return 0;
        let enc: ReturnType<typeof code128Bars>;
        try { enc = code128Bars(value); } catch (e) { warn((e as Error).message); return 0; }
        const bw = Math.min(b.widthMm ?? 60, w);
        s.ops?.push({ t: 'bars', x, y, w: bw, h: b.heightMm, bars: enc.bars, modules: enc.modules + 20, color: '#000000', block: b.id });
        let h = b.heightMm;
        h += text(s, b.caption ?? value, x, y + h + 0.5, bw, { size: base * 0.8, align: 'center', color: t.theme.muted }, { block: b.id });
        box(s, b.id, x, y, bw, h);
        return h + 1;
      }
      case 'terms': {
        let cy = y;
        if (b.title) cy += text(s, b.title, x, cy, w, { mb: 1 }, { bold: true, size: base * 1.1, block: b.id });
        b.points.forEach((p, i) => { cy += text(s, `${i + 1}. ${p}`, x, cy, w, { size: base * 0.85, color: t.theme.muted, mb: 0.6 }, { block: b.id }); });
        box(s, b.id, x, y, w, cy - y);
        return cy - y;
      }
      case 'items': return 0; // flowed by the page loop
    }
  }

  // ── header and footer: measured once (with a two-digit page number), drawn on every page later
  const hdr = (() => { let h = 0; for (const b of t.header) h += draw(b, none, mg.left, mg.top + h, cw); return h; })();
  const ftr = (() => { let h = 0; for (const b of t.footer) h += draw(b, none, mg.left, 0, cw); return h; })();
  const bodyTop = mg.top + (hdr ? hdr + 5 : 0);
  const bodyBottom = H - mg.bottom - (ftr ? ftr + 4 : 0);
  if (bodyBottom - bodyTop < 40) warn('The header and footer leave very little room for the body.');

  let page: LayoutPage = { ops: [], blocks: [] };
  pages.push(page);
  let y = bodyTop;
  const newPage = () => { page = { ops: [], blocks: [] }; pages.push(page); y = bodyTop; };
  const sink = (): Sink => ({ ops: page.ops, boxes: page.blocks });
  const ensure = (h: number) => { if (y + h > bodyBottom && y > bodyTop + 0.1) newPage(); };

  // ── charges tables
  function items(b: Extract<Block, { type: 'items' }>, x: number, w: number) {
    const rows = doc.lines.filter((l) => (!b.filter.streams?.length || b.filter.streams.includes(l.stream)) && (!b.filter.kinds?.length || b.filter.kinds.includes(l.kind)));
    if (!rows.length && b.hideIfEmpty) return;
    const cols = b.columns;
    const numW = 24, svcW = 30;
    const fixed = cols.filter((c) => c !== 'description').reduce((s, c) => s + (c === 'service' ? svcW : numW), 0);
    const descW = w - fixed - 2 * cols.length;
    const colW = (c: string) => (c === 'description' ? descW : c === 'service' ? svcW : numW);
    const size = base, lh = size * MM_PER_PT * LINE;
    const cell = (l: (typeof rows)[number], c: string) => (c === 'description' ? l.description : c === 'service' ? l.identifier : c === 'net' ? formatMoney(l.netMinor, doc.regional) : c === 'tax' ? formatMoney(l.taxMinor, doc.regional) : formatMoney(l.netMinor + l.taxMinor, doc.regional));
    const head = (c: string) => (c === 'description' ? 'Description' : c === 'service' ? 'Service' : c === 'net' ? 'Amount' : c === 'tax' ? doc.invoice.taxName || 'Tax' : 'Total');
    const rowHeight = (l: (typeof rows)[number]) => Math.max(...cols.map((c) => wrap(cell(l, c), colW(c), size, false).length)) * lh + 1.6;
    const drawHead = () => {
      const hh = lh + 2;
      const s = sink();
      s.ops!.push({ t: 'rect', x, y, w, h: hh, fill: t.theme.tableHead, block: b.id });
      let cx = x + 1;
      for (const c of cols) { text(s, head(c), cx, y + 1, colW(c), { size: size * 0.9, bold: true, color: t.theme.muted, align: c === 'description' || c === 'service' ? 'left' : 'right' }, { block: b.id }); cx += colW(c) + 2; }
      y += hh;
    };
    const titleH = text(none, b.title, x, 0, w, { mb: 1.5 }, { bold: true, size: base * 1.15 });
    ensure(titleH + lh + 2 + (rows[0] ? rowHeight(rows[0]) : lh + 2));
    const startY = y, startPage = page;
    text(sink(), b.title, x, y, w, { mb: 1.5 }, { bold: true, size: base * 1.15, block: b.id });
    y += titleH;
    drawHead();
    if (!rows.length) { y += text(sink(), 'None this period.', x + 1, y + 1, w, { color: t.theme.muted }, { block: b.id }) + 2; }
    for (const l of rows) {
      const rh = rowHeight(l);
      if (y + rh > bodyBottom) { page.blocks.push({ id: b.id, x, y: startPage === page ? startY : bodyTop, w, h: y - (startPage === page ? startY : bodyTop) }); newPage(); drawHead(); }
      const s = sink();
      let cx = x + 1;
      for (const c of cols) { text(s, cell(l, c), cx, y + 0.8, colW(c), { align: c === 'description' || c === 'service' ? 'left' : 'right' }, { block: b.id }); cx += colW(c) + 2; }
      s.ops!.push({ t: 'line', x1: x, y1: y + rh, x2: x + w, y2: y + rh, color: '#ececf0', w: 0.15 });
      y += rh;
    }
    if (b.showSubtotal && rows.length > 1) {
      const sum = rows.reduce((a, l) => ({ net: a.net + l.netMinor, tax: a.tax + l.taxMinor }), { net: 0, tax: 0 });
      const rh = lh + 2;
      if (y + rh > bodyBottom) { newPage(); }
      const s = sink();
      let cx = x + 1;
      for (const c of cols) {
        const v = c === 'description' ? `Subtotal, ${b.title.toLowerCase()}` : c === 'net' ? formatMoney(sum.net, doc.regional) : c === 'tax' ? formatMoney(sum.tax, doc.regional) : c === 'total' ? formatMoney(sum.net + sum.tax, doc.regional) : '';
        if (v) text(s, v, cx, y + 1, colW(c), { bold: true, align: c === 'description' || c === 'service' ? 'left' : 'right' }, { block: b.id });
        cx += colW(c) + 2;
      }
      y += rh;
    }
    page.blocks.push({ id: b.id, x, y: page === startPage ? startY : bodyTop, w, h: y - (page === startPage ? startY : bodyTop) });
    y += 4;
  }

  // ── the body, in order
  const absolute: Block[] = [];
  for (const b of t.body) {
    if (b.placement) { absolute.push(b); continue; }
    if (b.type === 'pagebreak') { if (y > bodyTop + 0.1) newPage(); continue; }
    if (b.type === 'items') { items(b, mg.left, cw); continue; }
    const h = draw(b, none, mg.left, y, cw);
    if (h === 0) continue;
    ensure(h);
    if (h > bodyBottom - bodyTop + 0.1) warn('A block is taller than a page and runs off it: shorten it or split it.');
    y += draw(b, sink(), mg.left, y, cw);
  }
  // ── blocks with a fixed place
  for (const b of absolute) {
    const p = b.placement as Placement;
    const target = pages[(p.page ?? 1) - 1];
    if (!target) { warn('A block is placed on a page that this invoice does not have.'); continue; }
    const s: Sink = { ops: target.ops, boxes: target.blocks };
    if (b.type === 'items') { const keep = page, ky = y; page = target; y = p.y; items(b, p.x, p.w ?? cw - p.x + mg.left); page = keep; y = ky; continue; }
    draw(b, s, p.x, p.y, p.w ?? Math.max(10, W - p.x - mg.right));
  }
  // ── header and footer on every page, now the page count is known
  const count = pages.length;
  pages.forEach((pg, i) => {
    const s: Sink = { ops: pg.ops, boxes: pg.blocks };
    let hy = mg.top;
    for (const b of t.header) hy += draw(b, s, mg.left, hy, cw);
    let fy = H - mg.bottom - ftr;
    for (const b of t.footer) fy += draw(b, s, mg.left, fy, cw);
    for (const op of pg.ops) if (op.t === 'text') op.text = op.text.replaceAll(SENT_N, String(i + 1)).replaceAll(SENT_C, String(count));
  });
  return { widthMm: W, heightMm: H, pages, warnings };
}

export { STREAMS };
