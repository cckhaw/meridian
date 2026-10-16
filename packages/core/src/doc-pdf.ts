import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { printable } from './billing-docs/pdf.js';
import { INTER_BOLD_B64, INTER_REGULAR_B64 } from './billing-docs/fonts.generated.js';
import { toBlocks, type Block, type Run } from './doc-html.js';
import { SIGNATURE_MARK } from './doc-templates.js';

/**
 * Turns an agreement into a signed PDF: lays the (token-filled, sanitised) text out on A4, puts the customer's signature picture where the template
 * says (or at the end) with who/when/where, and seals the result. The seal is a SHA-256 over the final words, the signature picture and the signing
 * details; it is written into the PDF twice (document keywords, and invisible text on every page). The file itself is flat (nothing to edit), and its own
 * SHA-256 is kept in the vault, so any later change to the file is caught by `verifySealedPdf`.
 */
const MM = 72 / 25.4;
const PAGE = { w: 210 * MM, h: 297 * MM }, M = { l: 20 * MM, r: 20 * MM, t: 22 * MM, b: 22 * MM };
const SIZES = { h1: 18, h2: 13, h3: 11, p: 10, li: 10, quote: 10, hr: 10, row: 9.5 } as const;
let fonts: { regular: Uint8Array; bold: Uint8Array } | null = null;
const typeface = () => (fonts ??= { regular: new Uint8Array(Buffer.from(INTER_REGULAR_B64, 'base64')), bold: new Uint8Array(Buffer.from(INTER_BOLD_B64, 'base64')) });

export interface SignatureStamp {
  image: Buffer; imageType: 'image/png' | 'image/jpeg';
  signerName: string; signedAt: Date; ip?: string | null; geo?: { lat: number; lon: number; accuracy?: number } | null; agent?: string | null; method: string;
}
export interface AgreementInput { title: string; brand: string; reference: string; html: string; signature: SignatureStamp; version: string }

export const sealOf = (text: string[], sig: SignatureStamp, extra: Record<string, unknown> = {}): string =>
  createHash('sha256').update(JSON.stringify({ text, image: createHash('sha256').update(sig.image).digest('hex'), signer: sig.signerName, at: sig.signedAt.toISOString(), ip: sig.ip ?? null, geo: sig.geo ?? null, agent: sig.agent ?? null, method: sig.method, ...extra })).digest('hex');

interface Word { text: string; font: PDFFont; size: number; underline?: boolean; width: number; space: number }
const SEAL_PREFIX = 'meridian-seal:sha256:';

export async function renderAgreementPdf(i: AgreementInput, seal: string): Promise<{ pdf: Uint8Array; pages: number }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const t = typeface(), regular = await pdf.embedFont(t.regular, { subset: true }), bold = await pdf.embedFont(t.bold, { subset: true });
  const img = i.signature.imageType === 'image/png' ? await pdf.embedPng(i.signature.image) : await pdf.embedJpg(i.signature.image);
  pdf.setTitle(printable(i.title)); pdf.setAuthor(printable(i.brand)); pdf.setSubject(`Agreement ${i.version} ${i.reference}`); pdf.setProducer('Meridian'); pdf.setCreator('Meridian');
  pdf.setKeywords([`${SEAL_PREFIX}${seal}`, `ref:${i.reference}`, `version:${i.version}`]);
  pdf.setCreationDate(i.signature.signedAt); pdf.setModificationDate(i.signature.signedAt);

  const pages: PDFPage[] = [];
  let page!: PDFPage, y = 0;
  const newPage = () => { page = pdf.addPage([PAGE.w, PAGE.h]); pages.push(page); y = PAGE.h - M.t; };
  const need = (h: number) => { if (y - h < M.b) newPage(); };
  newPage();
  const width = PAGE.w - M.l - M.r, ink = rgb(0.1, 0.1, 0.12), grey = rgb(0.42, 0.42, 0.46);

  const words = (runs: Run[], base: number, forceBold: boolean): Word[] => {
    const out: Word[] = [];
    for (const r of runs) {
      const font = forceBold || r.bold ? bold : regular, txt = printable(r.text);
      for (const part of txt.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { if (out.length) out[out.length - 1]!.space += font.widthOfTextAtSize(' ', base) * (part.includes('\n') ? 0 : 1); if (part.includes('\n')) out.push({ text: '\n', font, size: base, width: 0, space: 0 }); continue; }
        out.push({ text: part, font, size: base, underline: r.underline, width: font.widthOfTextAtSize(part, base), space: 0 });
      }
    }
    return out;
  };
  const drawWords = (ws: Word[], x0: number, w: number, align: string, size: number, color = ink) => {
    const lineH = size * 1.45;
    let line: Word[] = [], len = 0;
    const flush = (last: boolean) => {
      need(lineH);
      const total = line.reduce((a, c, k) => a + c.width + (k < line.length - 1 ? c.space : 0), 0);
      const x = align === 'center' ? x0 + (w - total) / 2 : align === 'right' ? x0 + w - total : x0;
      const gap = align === 'justify' && !last && line.length > 1 ? (w - line.reduce((a, c) => a + c.width, 0)) / (line.length - 1) : null;
      let cx = x;
      for (let k = 0; k < line.length; k++) {
        const wd = line[k]!;
        page.drawText(wd.text, { x: cx, y: y - size, font: wd.font, size: wd.size, color });
        if (wd.underline) page.drawLine({ start: { x: cx, y: y - size - 1.5 }, end: { x: cx + wd.width, y: y - size - 1.5 }, thickness: 0.5, color });
        cx += wd.width + (gap ?? wd.space);
      }
      y -= lineH; line = []; len = 0;
    };
    for (const wd of ws) {
      if (wd.text === '\n') { flush(true); continue; }
      if (line.length && len + wd.width > w) flush(false);
      line.push(wd); len += wd.width + wd.space;
    }
    if (line.length) flush(true);
  };

  const stampBlock = () => {
    const ratio = img.width / img.height, mw = 70 * MM, mh = 24 * MM;
    const iw = Math.min(mw, mh * ratio), ih = iw / ratio;
    const h = 16 + ih + 8 + 4 * 11.5 + 6;
    need(h + 8); const top = y;
    page.drawRectangle({ x: M.l, y: top - h, width: width, height: h, borderColor: grey, borderWidth: 0.6, color: rgb(0.985, 0.985, 0.99) });
    page.drawImage(img, { x: M.l + 8, y: top - 8 - ih, width: iw, height: ih });
    page.drawLine({ start: { x: M.l + 8, y: top - 12 - ih }, end: { x: M.l + 8 + Math.max(iw, 60 * MM), y: top - 12 - ih }, thickness: 0.5, color: grey });
    const s = i.signature, lines = [
      `Signed electronically by ${s.signerName}`,
      `${s.signedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC  ·  ${s.method === 'ASSISTED' ? 'taken at the counter' : s.method === 'PLAN_CHANGE' ? 'plan change' : 'online'}${s.agent ? `  ·  ${s.agent}` : ''}`,
      `${s.ip ? `IP ${s.ip}` : 'IP not recorded'}${s.geo ? `  ·  location ${s.geo.lat.toFixed(4)}, ${s.geo.lon.toFixed(4)}${s.geo.accuracy ? ` (±${Math.round(s.geo.accuracy)} m)` : ''}` : '  ·  location not recorded'}`,
      `Seal ${seal.slice(0, 16)}…  ·  ${i.reference}  ·  ${i.version}`,
    ];
    let ly = top - 16 - ih - 8;
    lines.forEach((l, k) => { page.drawText(printable(l), { x: M.l + 8, y: ly, font: k === 0 ? bold : regular, size: 8.5, color: k === 3 ? grey : ink }); ly -= 11.5; });
    y = top - h - 8;
  };

  let stamped = false;
  const blocks: Block[] = toBlocks(i.html);
  for (const b of blocks) {
    if (b.type === 'hr') { need(14); page.drawLine({ start: { x: M.l, y: y - 6 }, end: { x: M.l + width, y: y - 6 }, thickness: 0.6, color: grey }); y -= 14; continue; }
    if (b.type === 'row') {
      const cells = b.cells ?? [], cw = width / Math.max(cells.length, 1);
      const cellWords = cells.map((c) => words(c, SIZES.row, false));
      const startY = y; let minY = y;
      cells.forEach((_c, k) => { y = startY; drawWords(cellWords[k]!, M.l + k * cw + 3, cw - 8, 'left', SIZES.row); minY = Math.min(minY, y); });
      y = minY - 3; page.drawLine({ start: { x: M.l, y: y + 1 }, end: { x: M.l + width, y: y + 1 }, thickness: 0.3, color: rgb(0.8, 0.8, 0.83) });
      continue;
    }
    const plain = b.runs.map((r) => r.text).join('');
    if (plain.includes(SIGNATURE_MARK)) { const before = plain.replace(SIGNATURE_MARK, '').trim(); if (before) drawWords(words([{ text: before }], SIZES.p, false), M.l, width, b.align, SIZES.p); stampBlock(); stamped = true; continue; }
    const size = SIZES[b.type], head = b.type === 'h1' || b.type === 'h2' || b.type === 'h3';
    if (head) { need(size * 3); y -= b.type === 'h1' ? 2 : 8; }
    const indent = b.type === 'li' ? 14 + (b.depth ?? 0) * 14 : b.type === 'quote' ? 14 : 0;
    const ws = words(b.runs, size, head);
    if (b.type === 'li') { need(size * 1.45); page.drawText(b.ordered ? `${b.index}.` : '•', { x: M.l + indent - 12, y: y - size, font: regular, size, color: ink }); }
    if (b.type === 'quote') { const yy = y; drawWords(ws, M.l + indent, width - indent, b.align, size, grey); page.drawLine({ start: { x: M.l + 4, y: yy }, end: { x: M.l + 4, y }, thickness: 1.2, color: rgb(0.8, 0.8, 0.84) }); }
    else drawWords(ws, M.l + indent, width - indent, b.align, size);
    y -= head ? 3 : b.type === 'li' ? 1.5 : 5;
  }
  if (!stamped) { need(60); y -= 10; stampBlock(); }

  // footer and the invisible seal on every page
  const total = pages.length;
  pages.forEach((p, k) => {
    p.drawText(printable(`${i.brand}  ·  ${i.title}  ·  ${i.version}`), { x: M.l, y: M.b - 18, font: regular, size: 7.5, color: grey });
    const label = `Page ${k + 1} of ${total}`;
    p.drawText(label, { x: PAGE.w - M.r - regular.widthOfTextAtSize(label, 7.5), y: M.b - 18, font: regular, size: 7.5, color: grey });
    p.drawText(`${SEAL_PREFIX}${seal}`, { x: M.l, y: 6, font: regular, size: 0.5, color: rgb(1, 1, 1), opacity: 0 });
  });
  return { pdf: await pdf.save({ useObjectStreams: false }), pages: total };
}

/** Reads the seal back out of a PDF, and whether the file is the one that was stored. */
export async function verifySealedPdf(pdf: Uint8Array, o: { storedSha256: string; seal: string }): Promise<{ fileIntact: boolean; sealInFile: string | null; sealMatches: boolean }> {
  const fileIntact = createHash('sha256').update(pdf).digest('hex') === o.storedSha256;
  let sealInFile: string | null = null;
  try { const d = await PDFDocument.load(pdf, { updateMetadata: false }); const k = (d.getKeywords() ?? '').split(/\s+/).find((w) => w.startsWith(SEAL_PREFIX)); sealInFile = k ? k.slice(SEAL_PREFIX.length) : null; } catch { /* not a readable PDF */ }
  return { fileIntact, sealInFile, sealMatches: !!sealInFile && sealInFile === o.seal };
}
