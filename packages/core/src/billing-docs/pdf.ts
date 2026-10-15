import fontkit from '@pdf-lib/fontkit';
import { cmyk, degrees, PDFDocument, rgb, type Color, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { code128Bars } from './codes.js';
import { INTER_BOLD_B64, INTER_REGULAR_B64 } from './fonts.generated.js';
import { imageInfo, layoutInvoice, SENT_C, SENT_N, type Layout, type LayoutPage, type Measurer, type Op } from './layout.js';
import { PT_PER_MM, type InvoiceDoc, type TemplateSchema } from './schema.js';

/**
 * The PDF drawer. It draws the layout engine's pages with pdf-lib: subset fonts (only the glyphs used are embedded), vector QR codes and barcodes, and, for the print
 * house, colours in CMYK, a bleed and trim box with crop marks, optical (OMR) marks and a barcode on every sheet. Output is deterministic: the same invoice and template
 * give the same bytes, so a package can be rebuilt and checked against its checksum.
 */
export interface OmrSpec {
  /** Distance of the marks from the left edge of the trimmed page, the first mark's distance from the top, the gap between channels, a mark's length and thickness, in mm. */
  xMm: number; yMm: number; pitchMm: number; lengthMm: number; thicknessMm: number;
  /** Mark channel 3: tells the inserter to add the enclosed insert (a leaflet) to this envelope. */
  insert: boolean;
}
export interface SheetBarcode { xMm: number; yMm: number; widthMm: number; heightMm: number }
export interface PrintProfile {
  bleedMm: number; slugMm: number; cropMarks: boolean;
  colorMode: 'RGB' | 'CMYK';
  omr: OmrSpec | null;
  barcode: SheetBarcode | null;
}
export const SCREEN_PROFILE: PrintProfile = { bleedMm: 0, slugMm: 0, cropMarks: false, colorMode: 'RGB', omr: null, barcode: null };
export const DEFAULT_PRINT_PROFILE: PrintProfile = {
  bleedMm: 3, slugMm: 9, cropMarks: true, colorMode: 'CMYK',
  omr: { xMm: 4, yMm: 100, pitchMm: 5, lengthMm: 7, thicknessMm: 0.5, insert: false },
  barcode: { xMm: 120, yMm: 6, widthMm: 74, heightMm: 7 },
};

// ───────────────────────── the typeface ─────────────────────────
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
let loaded: { regular: Uint8Array; bold: Uint8Array; kr: ReturnType<typeof fontkit.create>; kb: ReturnType<typeof fontkit.create> } | null = null;
function typeface() {
  if (!loaded) {
    const regular = bytes(INTER_REGULAR_B64), bold = bytes(INTER_BOLD_B64);
    loaded = { regular, bold, kr: fontkit.create(Buffer.from(regular)), kb: fontkit.create(Buffer.from(bold)) };
  }
  return loaded;
}
const MM_PER_PT = 25.4 / 72;
const has = (f: ReturnType<typeof fontkit.create>, ch: string) => { const g = 'glyphForCodePoint' in f ? (f as { glyphForCodePoint(c: number): { id: number } }).glyphForCodePoint(ch.codePointAt(0)!) : null; return !g || g.id !== 0 || ch === ' '; };
/** Text with characters the typeface does not have replaced by "?", and which those were. */
export function printable(text: string, missing?: Set<string>): string {
  const { kr } = typeface();
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || has(kr, ch)) out += ch; else { out += '?'; missing?.add(ch); }
  }
  return out;
}
/** The typeface's own widths, so the layout and the print agree. */
export function interMeasurer(missing?: Set<string>): Measurer {
  const { kr, kb } = typeface();
  return { width: (text, size, bold) => { const f = bold ? kb : kr; const t = printable(text.replaceAll(SENT_N, '00').replaceAll(SENT_C, '00'), missing); return (f.layout(t).advanceWidth / f.unitsPerEm) * size * MM_PER_PT; } };
}

// ───────────────────────── colours ─────────────────────────
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** RGB to CMYK for print: neutral greys and black become a single black ink (small type must not be printed in four inks that can drift out of register). */
export function toCmyk(h: string): [number, number, number, number] {
  const [r, g, b] = hex(h);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 0.03) return [0, 0, 0, round(1 - (r + g + b) / 3)];
  const k = 1 - Math.max(r, g, b);
  return k >= 1 ? [0, 0, 0, 1] : [round((1 - r - k) / (1 - k)), round((1 - g - k) / (1 - k)), round((1 - b - k) / (1 - k)), round(k)];
}
const round = (n: number) => Math.round(n * 1000) / 1000;
const ink = (h: string, mode: 'RGB' | 'CMYK'): Color => { if (mode === 'RGB') { const [r, g, b] = hex(h); return rgb(r, g, b); } const [c, m, y, k] = toCmyk(h); return cmyk(c, m, y, k); };

// ───────────────────────── geometry shared with the preview ─────────────────────────
/** A QR code is drawn with a four-module quiet zone inside the size the block was given. */
export function qrGeometry(size: number, n: number) { const mod = size / (n + 8); return { mod, off: 4 * mod }; }

export interface Stamp { sequence: number; barcodeValue: (page: number) => string; omrInsert?: boolean }

/** One document, or a whole batch of them, being written. */
export class PdfWriter {
  private constructor(readonly pdf: PDFDocument, private regular: PDFFont, private bold: PDFFont, readonly profile: PrintProfile) {}
  readonly missing = new Set<string>();
  readonly warnings: string[] = [];
  pages = 0;

  static async create(profile: PrintProfile, title: string, date: string): Promise<PdfWriter> {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.registerFontkit(fontkit);
    const t = typeface();
    const d = new Date(`${date}T00:00:00Z`);
    pdf.setTitle(title); pdf.setProducer('Meridian'); pdf.setCreator('Meridian'); pdf.setCreationDate(d); pdf.setModificationDate(d);
    const regular = await pdf.embedFont(t.regular, { subset: true }), bold = await pdf.embedFont(t.bold, { subset: true });
    return new PdfWriter(pdf, regular, bold, profile);
  }

  /** Lays one invoice out and adds its pages. Returns the number of pages. */
  async addInvoice(template: TemplateSchema, doc: InvoiceDoc, stamp?: Stamp): Promise<{ pages: number; warnings: string[] }> {
    const layout = layoutInvoice(template, doc, interMeasurer(this.missing));
    await this.prepareImages(layout);
    const mode = this.profile.colorMode === 'CMYK' || template.page.colorMode === 'CMYK' ? 'CMYK' : 'RGB';
    if (this.profile.omr && template.page.marginsMm.left < this.profile.omr.xMm + this.profile.omr.lengthMm + 2) layout.warnings.push(`The left margin (${template.page.marginsMm.left} mm) is narrower than the optical marks need (${this.profile.omr.xMm + this.profile.omr.lengthMm + 2} mm): the marks would touch the text.`);
    if (mode === 'CMYK' && layout.pages.some((p) => p.ops.some((o) => o.t === 'image'))) layout.warnings.push('Images stay in RGB: convert the logo to CMYK before printing if colour accuracy matters.');
    layout.pages.forEach((lp, i) => this.drawPage(layout, lp, mode, i, layout.pages.length, stamp));
    this.pages += layout.pages.length;
    return { pages: layout.pages.length, warnings: layout.warnings };
  }

  async save(): Promise<Uint8Array> {
    if (this.missing.size) this.warnings.push(`Characters the invoice font cannot print were replaced by “?”: ${[...this.missing].slice(0, 12).join(' ')}.`);
    return this.pdf.save({ useObjectStreams: false });
  }

  private drawPage(layout: Layout, lp: LayoutPage, mode: 'RGB' | 'CMYK', index: number, count: number, stamp?: Stamp) {
    const { bleedMm: bleed, slugMm: slug } = this.profile;
    const o = bleed + slug;
    const W = layout.widthMm, H = layout.heightMm;
    const page = this.pdf.addPage([(W + 2 * o) * PT_PER_MM, (H + 2 * o) * PT_PER_MM]);
    if (o > 0) {
      page.setTrimBox(o * PT_PER_MM, o * PT_PER_MM, W * PT_PER_MM, H * PT_PER_MM);
      page.setBleedBox((o - bleed) * PT_PER_MM, (o - bleed) * PT_PER_MM, (W + 2 * bleed) * PT_PER_MM, (H + 2 * bleed) * PT_PER_MM);
    }
    const X = (x: number) => (o + x) * PT_PER_MM, Y = (y: number) => (o + H - y) * PT_PER_MM;
    const col = (h: string) => ink(h, mode);
    for (const op of lp.ops) this.drawOp(page, op, { X, Y, col, bleed, W, mode });
    if (this.profile.cropMarks && o > 0) this.cropMarks(page, o, W, H, bleed);
    if (this.profile.omr) this.omr(page, X, Y, index, count, stamp?.omrInsert ?? this.profile.omr.insert);
    if (this.profile.barcode && stamp) this.sheetBarcode(page, X, Y, stamp.barcodeValue(index + 1));
  }

  private drawOp(page: PDFPage, op: Op, g: { X: (x: number) => number; Y: (y: number) => number; col: (h: string) => Color; bleed: number; W: number; mode: 'RGB' | 'CMYK' }) {
    switch (op.t) {
      case 'text': {
        const text = printable(op.text, this.missing);
        if (!text) return;
        page.drawText(text, { x: g.X(op.x), y: g.Y(op.y), size: op.size, font: op.bold ? this.bold : this.regular, color: g.col(op.color), ...(op.italic ? { xSkew: degrees(10) } : {}) });
        return;
      }
      case 'rect': {
        let { x, y, w, h } = op;
        if (op.bleed) { const top = y < 1; x = -g.bleed; w = g.W + 2 * g.bleed; if (top) { y = -g.bleed; h += g.bleed; } }
        page.drawRectangle({ x: g.X(x), y: g.Y(y + h), width: w * PT_PER_MM, height: h * PT_PER_MM, ...(op.fill ? { color: g.col(op.fill) } : {}), ...(op.stroke ? { borderColor: g.col(op.stroke), borderWidth: (op.strokeW ?? 0.2) * PT_PER_MM } : {}) });
        return;
      }
      case 'line': page.drawLine({ start: { x: g.X(op.x1), y: g.Y(op.y1) }, end: { x: g.X(op.x2), y: g.Y(op.y2) }, thickness: op.w * PT_PER_MM, color: g.col(op.color) }); return;
      case 'image': {
        const img = this.imageCache.get(op.src);
        if (img) page.drawImage(img, { x: g.X(op.x), y: g.Y(op.y + op.h), width: op.w * PT_PER_MM, height: op.h * PT_PER_MM });
        return;
      }
      case 'qr': {
        const n = op.modules.length, { mod, off } = qrGeometry(op.size, n);
        const color = g.mode === 'CMYK' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0);
        for (let r = 0; r < n; r++) {
          let c = 0;
          while (c < n) {
            if (!op.modules[r]![c]) { c++; continue; }
            let e = c; while (e < n && op.modules[r]![e]) e++;
            page.drawRectangle({ x: g.X(op.x + off + c * mod), y: g.Y(op.y + off + (r + 1) * mod), width: (e - c) * mod * PT_PER_MM + 0.05, height: mod * PT_PER_MM + 0.05, color });
            c = e;
          }
        }
        return;
      }
      case 'bars': {
        const mod = op.w / op.modules;
        const color = g.mode === 'CMYK' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0);
        for (const [bx, bw] of op.bars) page.drawRectangle({ x: g.X(op.x + (10 + bx) * mod), y: g.Y(op.y + op.h), width: bw * mod * PT_PER_MM, height: op.h * PT_PER_MM, color });
      }
    }
  }
  private imageCache = new Map<string, PDFImage>();
  /** Embeds the images a layout uses before it is drawn (embedding is asynchronous, drawing is not). */
  async prepareImages(layout: Layout): Promise<void> {
    for (const p of layout.pages) for (const op of p.ops) {
      if (op.t !== 'image' || this.imageCache.has(op.src)) continue;
      const info = imageInfo(op.src);
      if (!info) continue;
      const b = Buffer.from(op.src.slice(op.src.indexOf(',') + 1), 'base64');
      this.imageCache.set(op.src, info.kind === 'png' ? await this.pdf.embedPng(b) : await this.pdf.embedJpg(b));
    }
  }

  private cropMarks(page: PDFPage, o: number, W: number, H: number, bleed: number) {
    const reg = cmyk(1, 1, 1, 1);
    const gap = bleed + 1, len = Math.min(5, o - gap - 0.5);
    if (len <= 0) return;
    const L = o * PT_PER_MM, R = (o + W) * PT_PER_MM, B = o * PT_PER_MM, T = (o + H) * PT_PER_MM;
    const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.25, color: reg });
    const g = gap * PT_PER_MM, l = len * PT_PER_MM;
    for (const [x, sx] of [[L, -1], [R, 1]] as const) for (const [y, sy] of [[B, -1], [T, 1]] as const) {
      line(x + sx * g, y, x + sx * (g + l), y); // horizontal tick
      line(x, y + sy * g, x, y + sy * (g + l)); // vertical tick
    }
  }

  /** Optical marks down the left edge: START (first sheet of a statement), END (last sheet), INSERT (add the leaflet), and a PARITY mark that keeps the number of marks odd. */
  private omr(page: PDFPage, X: (x: number) => number, Y: (y: number) => number, index: number, count: number, insert: boolean) {
    const s = this.profile.omr!;
    const ch = [index === 0, index === count - 1, insert];
    ch.push(ch.filter(Boolean).length % 2 === 0);
    const black = this.profile.colorMode === 'CMYK' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0);
    ch.forEach((on, i) => {
      if (!on) return;
      const y = s.yMm + i * s.pitchMm;
      page.drawRectangle({ x: X(s.xMm), y: Y(y + s.thicknessMm), width: s.lengthMm * PT_PER_MM, height: s.thicknessMm * PT_PER_MM, color: black });
    });
  }

  private sheetBarcode(page: PDFPage, X: (x: number) => number, Y: (y: number) => number, value: string) {
    const b = this.profile.barcode!;
    const enc = code128Bars(value);
    const modules = enc.modules + 20, mod = b.widthMm / modules;
    const black = this.profile.colorMode === 'CMYK' ? cmyk(0, 0, 0, 1) : rgb(0, 0, 0);
    for (const [bx, bw] of enc.bars) page.drawRectangle({ x: X(b.xMm + (10 + bx) * mod), y: Y(b.yMm + b.heightMm), width: bw * mod * PT_PER_MM, height: b.heightMm * PT_PER_MM, color: black });
    const size = 6;
    const w = this.regular.widthOfTextAtSize(value, size) / PT_PER_MM;
    page.drawText(value, { x: X(b.xMm + (b.widthMm - w) / 2), y: Y(b.yMm + b.heightMm + 2.4), size, font: this.regular, color: black });
  }
}

/** One invoice as a PDF. */
export async function renderInvoicePdf(template: TemplateSchema, doc: InvoiceDoc, profile: PrintProfile = SCREEN_PROFILE, stamp?: Stamp): Promise<{ pdf: Uint8Array; pages: number; warnings: string[] }> {
  const w = await PdfWriter.create(profile, `Invoice ${doc.invoice.number}`, doc.invoice.issueDate);
  const r = await w.addInvoice(template, doc, stamp);
  const pdf = await w.save();
  return { pdf, pages: r.pages, warnings: [...new Set([...r.warnings, ...w.warnings])] };
}

