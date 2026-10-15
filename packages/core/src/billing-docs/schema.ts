import { formatDate, formatMoney, type RegionalSettings } from '@meridian/types';

/**
 * The invoice template model. A template is a page set-up and three lists of blocks (header and footer, repeated on every page, and the body that flows across
 * pages). Text may hold tokens such as {{customer.name}} that are filled from the invoice. One layout engine places the blocks and both the PDF and the designer's
 * preview draw its result, so what is on the screen is where it is printed.
 */
export const PAGE_SIZES_MM = { A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 }, LETTER: { w: 215.9, h: 279.4 } } as const;
export type PageSizeId = keyof typeof PAGE_SIZES_MM;
export const PT_PER_MM = 72 / 25.4;

export interface Style { size?: number; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; color?: string; bg?: string; mt?: number; mb?: number }
/** A block placed at a fixed spot on a page (millimetres from the top-left of the trimmed page) instead of flowing: legacy layouts are of this kind. */
export interface Placement { x: number; y: number; w?: number; page?: number }
interface Base { id: string; placement?: Placement }

export type ItemColumn = 'description' | 'service' | 'net' | 'tax' | 'total';
export type SummaryRow = 'net' | 'tax' | 'total' | 'paid' | 'credited' | 'balance' | 'due';
export type Block = Base & (
  | { type: 'text'; text: string; style?: Style }
  | { type: 'heading'; text: string; level: 1 | 2 | 3; style?: Style }
  | { type: 'image'; src: string; widthMm: number; align?: 'left' | 'center' | 'right' }
  | { type: 'spacer'; heightMm: number }
  | { type: 'rule'; color?: string }
  | { type: 'band'; text?: string; heightMm: number; bg: string; color?: string; bleed?: boolean; size?: number }
  | { type: 'rect'; heightMm: number; bg?: string; border?: string }
  | { type: 'columns'; columns: Block[][]; gapMm?: number; widths?: number[] }
  | { type: 'keyvalue'; rows: Array<{ label: string; value: string }>; style?: Style }
  | { type: 'summary'; title?: string; rows: SummaryRow[] }
  | { type: 'items'; title: string; filter: { streams?: string[]; kinds?: string[] }; columns: ItemColumn[]; showSubtotal?: boolean; hideIfEmpty?: boolean }
  | { type: 'qr'; value: string; sizeMm: number; caption?: string; hideIfEmpty?: boolean }
  | { type: 'barcode'; value: string; heightMm: number; widthMm?: number; caption?: string }
  | { type: 'terms'; title?: string; points: string[] }
  | { type: 'pagebreak' }
);
export type BlockType = Block['type'];
export const BLOCK_TYPES: Array<{ type: BlockType; label: string; hint: string }> = [
  { type: 'heading', label: 'Heading', hint: 'A title' }, { type: 'text', label: 'Text', hint: 'A paragraph with tokens' }, { type: 'image', label: 'Logo or image', hint: 'The logo, or a picture' },
  { type: 'band', label: 'Colour band', hint: 'A coloured strip, optionally running to the page edge' }, { type: 'columns', label: 'Columns', hint: 'Blocks side by side' },
  { type: 'keyvalue', label: 'Details', hint: 'Labels and values: invoice number, dates' }, { type: 'summary', label: 'Bill summary', hint: 'Net, tax, total, paid, balance' },
  { type: 'items', label: 'Itemised charges', hint: 'A table of charges: plans, usage, services, instalments, ETC' }, { type: 'qr', label: 'QR pay code', hint: 'A QR code that opens the payment page' },
  { type: 'barcode', label: 'Barcode', hint: 'A Code 128 barcode' }, { type: 'terms', label: 'Terms and conditions', hint: 'Numbered points' },
  { type: 'rule', label: 'Line', hint: 'A thin divider' }, { type: 'spacer', label: 'Space', hint: 'Empty space' }, { type: 'pagebreak', label: 'Page break', hint: 'Start a new page' },
];

export interface PageSpec { size: PageSizeId; marginsMm: { top: number; right: number; bottom: number; left: number }; colorMode: 'RGB' | 'CMYK' }
export interface Theme { text: string; muted: string; accent: string; tableHead: string; baseSize: number }
export interface TemplateSchema { version: 1; page: PageSpec; theme: Theme; header: Block[]; body: Block[]; footer: Block[] }

// ───────────────────────── the data a template draws from ─────────────────────────
export interface InvoiceDoc {
  company: { name: string; logo: string | null; lines: string[] };
  customer: { id: string; name: string; email: string; phone: string; lines: string[]; postcode: string; city: string; country: string; addressMissing: boolean };
  account: { id: string; name: string; currency: string };
  invoice: { id: string; number: string; kind: string; status: string; issueDate: string; dueDate: string; periodStart: string; periodEnd: string; currency: string;
    netMinor: number; taxMinor: number; totalMinor: number; paidMinor: number; creditedMinor: number; balanceMinor: number; taxName: string };
  lines: Array<{ kind: string; stream: string; description: string; serviceId: string | null; identifier: string; netMinor: number; taxMinor: number }>;
  payment: { url: string; reference: string };
  regional: RegionalSettings;
}

export const STREAMS: Record<string, string> = { SUBSCRIPTION: 'Plans', USAGE: 'Usage (voice, data and messages)', THIRD_PARTY: 'Partner services', DEVICE_INSTALMENT: 'Device instalments', ETC: 'Early termination', GOODS: 'Goods', ONE_TIME: 'One-time charges' };

type Kind = 'text' | 'money' | 'date';
/** Every token a template may use, with what it means and a sample, for the designer's picker and for checking a template. */
export const TOKENS: Array<{ token: string; label: string; group: string; kind: Kind; get: (d: InvoiceDoc) => string | number; sample: string | number }> = [
  { token: 'company.name', label: 'Company name', group: 'Company', kind: 'text', get: (d) => d.company.name, sample: 'Meridian Telecom' },
  { token: 'customer.name', label: 'Customer name', group: 'Customer', kind: 'text', get: (d) => d.customer.name, sample: 'Alex Tan' },
  { token: 'customer.address', label: 'Customer address (all lines)', group: 'Customer', kind: 'text', get: (d) => d.customer.lines.join('\n'), sample: '391 Orchard Road\n#12-01 Ngee Ann City\nSingapore 238872' },
  { token: 'customer.email', label: 'Customer e-mail', group: 'Customer', kind: 'text', get: (d) => d.customer.email, sample: 'alex@example.com' },
  { token: 'customer.phone', label: 'Customer phone', group: 'Customer', kind: 'text', get: (d) => d.customer.phone, sample: '+6591234567' },
  { token: 'customer.id', label: 'Customer id', group: 'Customer', kind: 'text', get: (d) => d.customer.id, sample: '3f2a9c1e-0000-4000-8000-000000000001' },
  { token: 'account.name', label: 'Account name', group: 'Account', kind: 'text', get: (d) => d.account.name, sample: 'Main account' },
  { token: 'account.id', label: 'Account id', group: 'Account', kind: 'text', get: (d) => d.account.id, sample: '8d4b7a20-0000-4000-8000-000000000002' },
  { token: 'invoice.number', label: 'Invoice number', group: 'Invoice', kind: 'text', get: (d) => d.invoice.number, sample: 'INV-2026-000123' },
  { token: 'invoice.issueDate', label: 'Issue date', group: 'Invoice', kind: 'date', get: (d) => d.invoice.issueDate, sample: '2026-10-01' },
  { token: 'invoice.dueDate', label: 'Due date', group: 'Invoice', kind: 'date', get: (d) => d.invoice.dueDate, sample: '2026-10-15' },
  { token: 'invoice.periodStart', label: 'Period start', group: 'Invoice', kind: 'date', get: (d) => d.invoice.periodStart, sample: '2026-09-01' },
  { token: 'invoice.periodEnd', label: 'Period end', group: 'Invoice', kind: 'date', get: (d) => d.invoice.periodEnd, sample: '2026-09-30' },
  { token: 'invoice.net', label: 'Amount before tax', group: 'Amounts', kind: 'money', get: (d) => d.invoice.netMinor, sample: 9174 },
  { token: 'invoice.tax', label: 'Tax', group: 'Amounts', kind: 'money', get: (d) => d.invoice.taxMinor, sample: 826 },
  { token: 'invoice.taxName', label: 'Tax name (GST, VAT…)', group: 'Amounts', kind: 'text', get: (d) => d.invoice.taxName, sample: 'GST' },
  { token: 'invoice.total', label: 'Total', group: 'Amounts', kind: 'money', get: (d) => d.invoice.totalMinor, sample: 10000 },
  { token: 'invoice.paid', label: 'Paid so far', group: 'Amounts', kind: 'money', get: (d) => d.invoice.paidMinor, sample: 0 },
  { token: 'invoice.balance', label: 'Amount due', group: 'Amounts', kind: 'money', get: (d) => d.invoice.balanceMinor, sample: 10000 },
  { token: 'invoice.currency', label: 'Currency code', group: 'Amounts', kind: 'text', get: (d) => d.invoice.currency, sample: 'SGD' },
  { token: 'payment.url', label: 'Payment page address', group: 'Payment', kind: 'text', get: (d) => d.payment.url, sample: 'https://pay.example.com/INV-2026-000123' },
  { token: 'payment.reference', label: 'Payment reference', group: 'Payment', kind: 'text', get: (d) => d.payment.reference, sample: 'INV-2026-000123' },
  { token: 'page.number', label: 'Page number', group: 'Page', kind: 'text', get: () => '', sample: 1 },
  { token: 'page.count', label: 'Number of pages', group: 'Page', kind: 'text', get: () => '', sample: 2 },
];
const TOKEN_MAP = new Map(TOKENS.map((t) => [t.token, t]));
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function tokensIn(text: string): string[] { return [...text.matchAll(TOKEN_RE)].map((m) => m[1]!); }
/** Fills the tokens of a text from an invoice. A token that is not known is left empty. */
export function fillTokens(text: string, d: InvoiceDoc, page: { number: number; count: number }): string {
  return text.replace(TOKEN_RE, (_, name: string) => {
    if (name === 'page.number') return String(page.number);
    if (name === 'page.count') return String(page.count);
    const t = TOKEN_MAP.get(name);
    if (!t) return '';
    const v = t.get(d);
    return t.kind === 'money' ? formatMoney(Number(v), d.regional) : t.kind === 'date' ? formatDate(String(v), d.regional) : String(v ?? '');
  });
}

/** A made-up invoice for the designer and for a first look: it has every kind of charge so every table can be seen. */
export function sampleInvoice(regional: RegionalSettings, company = 'Meridian Telecom'): InvoiceDoc {
  const lines = [
    { kind: 'RECURRING', stream: 'SUBSCRIPTION', description: '5G Plan 100GB +6591234567 (1 Sep 2026 to 30 Sep 2026)', serviceId: 's1', identifier: '+6591234567', netMinor: 3211, taxMinor: 289 },
    { kind: 'RECURRING', stream: 'SUBSCRIPTION', description: 'Family Member line +6591234568 (pro-rated 20/30 days)', serviceId: 's2', identifier: '+6591234568', netMinor: 917, taxMinor: 83 },
    { kind: 'ADJUSTMENT', stream: 'USAGE', description: 'Roaming data, Malaysia, 1.2 GB', serviceId: 's1', identifier: '+6591234567', netMinor: 1500, taxMinor: 135 },
    { kind: 'RECURRING', stream: 'THIRD_PARTY', description: 'Streaming Premium', serviceId: 's1', identifier: '+6591234567', netMinor: 1834, taxMinor: 166 },
    { kind: 'INSTALLMENT', stream: 'DEVICE_INSTALMENT', description: 'Phone X1 128GB instalment (12 mo), 4 of 12', serviceId: 's1', identifier: '+6591234567', netMinor: 1712, taxMinor: 154 },
  ];
  const net = lines.reduce((s, l) => s + l.netMinor, 0), tax = lines.reduce((s, l) => s + l.taxMinor, 0);
  return {
    company: { name: company, logo: null, lines: ['1 Raffles Quay', 'Singapore 048583', 'billing@example.com'] },
    customer: { id: '3f2a9c1e-0000-4000-8000-000000000001', name: 'Alex Tan', email: 'alex@example.com', phone: '+6591234567', lines: ['391 Orchard Road', '#12-01 Ngee Ann City'], postcode: '238872', city: 'Singapore', country: 'SG', addressMissing: false },
    account: { id: '8d4b7a20-0000-4000-8000-000000000002', name: 'Main account', currency: regional.currency },
    invoice: { id: 'sample', number: 'INV-2026-000123', kind: 'CYCLE', status: 'ISSUED', issueDate: '2026-10-01', dueDate: '2026-10-15', periodStart: '2026-09-01', periodEnd: '2026-09-30', currency: regional.currency, netMinor: net, taxMinor: tax, totalMinor: net + tax, paidMinor: 0, creditedMinor: 0, balanceMinor: net + tax, taxName: 'GST' },
    lines, payment: { url: 'https://pay.example.com/INV-2026-000123', reference: 'INV-2026-000123' }, regional,
  };
}

// ───────────────────────── the template that comes with the system ─────────────────────────
let n = 0;
const id = () => `b${++n}`;
export function defaultTemplate(): TemplateSchema {
  n = 0;
  return {
    version: 1,
    page: { size: 'A4', marginsMm: { top: 16, right: 16, bottom: 18, left: 16 }, colorMode: 'RGB' },
    theme: { text: '#1d1d1f', muted: '#6e6e73', accent: '#0071e3', tableHead: '#f2f2f7', baseSize: 9.5 },
    header: [
      { id: id(), type: 'columns', widths: [60, 40], columns: [
        [{ id: id(), type: 'image', src: 'logo', widthMm: 38 }, { id: id(), type: 'text', text: '{{company.name}}', style: { bold: true, size: 13, color: '#0071e3' } }],
        [{ id: id(), type: 'text', text: 'Invoice', style: { size: 18, bold: true, align: 'right' } }, { id: id(), type: 'text', text: '{{invoice.number}}', style: { align: 'right', color: '#6e6e73' } }],
      ] },
    ],
    body: [
      { id: id(), type: 'columns', widths: [55, 45], gapMm: 8, columns: [
        [{ id: id(), type: 'text', text: '{{customer.name}}', style: { bold: true, size: 11 } }, { id: id(), type: 'text', text: '{{customer.address}}' }, { id: id(), type: 'text', text: '{{customer.email}}', style: { color: '#6e6e73' } }],
        [{ id: id(), type: 'keyvalue', rows: [
          { label: 'Invoice date', value: '{{invoice.issueDate}}' }, { label: 'Due date', value: '{{invoice.dueDate}}' },
          { label: 'Billing period', value: '{{invoice.periodStart}} to {{invoice.periodEnd}}' }, { label: 'Account', value: '{{account.name}}' },
        ] }],
      ] },
      { id: id(), type: 'spacer', heightMm: 6 },
      { id: id(), type: 'band', heightMm: 14, bg: '#f2f2f7', text: 'Amount due  {{invoice.balance}}   by {{invoice.dueDate}}', color: '#1d1d1f', size: 13 },
      { id: id(), type: 'spacer', heightMm: 6 },
      { id: id(), type: 'items', title: 'Plans', filter: { streams: ['SUBSCRIPTION'] }, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true },
      { id: id(), type: 'items', title: 'Usage (voice, data and messages)', filter: { streams: ['USAGE'] }, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true },
      { id: id(), type: 'items', title: 'Partner services', filter: { streams: ['THIRD_PARTY'] }, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true },
      { id: id(), type: 'items', title: 'Device instalments', filter: { streams: ['DEVICE_INSTALMENT'] }, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true },
      { id: id(), type: 'items', title: 'Early termination', filter: { streams: ['ETC'] }, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true },
      { id: id(), type: 'items', title: 'Other charges', filter: { streams: ['GOODS', 'ONE_TIME'] }, columns: ['description', 'net', 'tax', 'total'], showSubtotal: true, hideIfEmpty: true },
      { id: id(), type: 'spacer', heightMm: 4 },
      { id: id(), type: 'summary', title: 'Summary', rows: ['net', 'tax', 'total', 'paid', 'balance'] },
      { id: id(), type: 'spacer', heightMm: 8 },
      { id: id(), type: 'columns', widths: [70, 30], columns: [
        [{ id: id(), type: 'heading', level: 3, text: 'How to pay' }, { id: id(), type: 'text', text: 'Scan the code to pay online, or quote {{payment.reference}} at any of our stores. Payment is due by {{invoice.dueDate}}.' }],
        [{ id: id(), type: 'qr', value: '{{payment.url}}', sizeMm: 28, caption: 'Scan to pay', hideIfEmpty: true }],
      ] },
      { id: id(), type: 'spacer', heightMm: 6 },
      { id: id(), type: 'terms', title: 'Terms and conditions', points: ['Payment is due by the due date shown. Late payment may lead to suspension of service.', 'Queries about this invoice must be raised within 30 days of the invoice date.', 'Charges for usage are shown as reported by the network at the time of billing.'] },
    ],
    footer: [
      { id: id(), type: 'rule' },
      { id: id(), type: 'columns', widths: [70, 30], columns: [
        [{ id: id(), type: 'text', text: '{{company.name}} · {{invoice.number}}', style: { size: 8, color: '#6e6e73' } }],
        [{ id: id(), type: 'text', text: 'Page {{page.number}} of {{page.count}}', style: { size: 8, color: '#6e6e73', align: 'right' } }],
      ] },
    ],
  };
}

// ───────────────────────── checking a template ─────────────────────────
export interface TemplateProblem { blockId: string | null; message: string }
const COLOR = /^#[0-9a-fA-F]{6}$/;
const KNOWN = new Set<string>(BLOCK_TYPES.map((b) => b.type).concat(['rect']));

/** Everything wrong with a template, so the designer can say where; publishing needs none. */
export function validateTemplate(t: unknown): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  const bad = (blockId: string | null, message: string) => out.push({ blockId, message });
  if (!t || typeof t !== 'object') return [{ blockId: null, message: 'The template is empty.' }];
  const s = t as Partial<TemplateSchema>;
  if (s.version !== 1) bad(null, 'Unknown template version.');
  if (!s.page || !(s.page.size in PAGE_SIZES_MM)) bad(null, 'Choose a page size: A4, A5 or Letter.');
  else {
    const m = s.page.marginsMm;
    if (!m || [m.top, m.right, m.bottom, m.left].some((v) => typeof v !== 'number' || v < 5 || v > 60)) bad(null, 'Margins are 5 to 60 mm.');
    if (s.page.colorMode !== 'RGB' && s.page.colorMode !== 'CMYK') bad(null, 'The colour mode is RGB or CMYK.');
  }
  if (!s.theme || [s.theme.text, s.theme.muted, s.theme.accent, s.theme.tableHead].some((c) => !COLOR.test(c))) bad(null, 'Theme colours are written #rrggbb.');
  else if (!(s.theme.baseSize >= 6 && s.theme.baseSize <= 16)) bad(null, 'The base text size is 6 to 16 points.');
  const ids = new Set<string>();
  const walk = (blocks: unknown, where: string) => {
    if (!Array.isArray(blocks)) { bad(null, `${where} must be a list of blocks.`); return; }
    for (const b of blocks as Block[]) {
      if (!b || typeof b !== 'object' || !KNOWN.has((b as Block).type)) { bad(null, `${where} has a block of an unknown kind.`); continue; }
      if (!b.id || ids.has(b.id)) bad(b.id ?? null, 'Two blocks share an id.'); else ids.add(b.id);
      const texts: string[] = [];
      switch (b.type) {
        case 'text': case 'heading': texts.push(b.text); break;
        case 'band': if (b.text) texts.push(b.text); if (!COLOR.test(b.bg)) bad(b.id, 'The band colour is written #rrggbb.'); if (!(b.heightMm > 0 && b.heightMm <= 80)) bad(b.id, 'A band is up to 80 mm high.'); break;
        case 'keyvalue': for (const r of b.rows) texts.push(r.label, r.value); break;
        case 'qr': texts.push(b.value); if (!(b.sizeMm >= 10 && b.sizeMm <= 80)) bad(b.id, 'A QR code is 10 to 80 mm.'); break;
        case 'barcode': texts.push(b.value); if (!(b.heightMm >= 5 && b.heightMm <= 40)) bad(b.id, 'A barcode is 5 to 40 mm high.'); break;
        case 'terms': texts.push(...b.points); break;
        case 'items': if (!b.columns.length || !b.columns.includes('description')) bad(b.id, 'A table of charges needs a description column.'); for (const st of b.filter.streams ?? []) if (!(st in STREAMS)) bad(b.id, `“${st}” is not a kind of charge.`); break;
        case 'image': if (!(b.widthMm > 0 && b.widthMm <= 190)) bad(b.id, 'An image is up to 190 mm wide.'); if (b.src !== 'logo' && !/^data:image\/(png|jpeg);base64,/.test(b.src)) bad(b.id, 'An image is the logo, or a PNG or JPEG.'); break;
        case 'columns': if (!b.columns.length || b.columns.length > 4) bad(b.id, 'Columns are 1 to 4.'); b.columns.forEach((c, i) => walk(c, `Column ${i + 1}`)); break;
        default: break;
      }
      for (const text of texts) for (const tok of tokensIn(text)) if (!TOKEN_MAP.has(tok)) bad(b.id, `{{${tok}}} is not a field of an invoice.`);
    }
  };
  walk(s.header ?? [], 'The header'); walk(s.body ?? [], 'The body'); walk(s.footer ?? [], 'The footer');
  return out;
}
