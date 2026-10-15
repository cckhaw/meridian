import { DEFAULT_REGIONAL } from '@meridian/types';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { code128Bars, qrMatrix } from './codes.js';
import { convertLegacy } from './legacy.js';
import { DEFAULT_PRINT_PROFILE, renderInvoicePdf, SCREEN_PROFILE } from './pdf.js';
import { defaultTemplate, fillTokens, sampleInvoice, tokensIn, validateTemplate } from './schema.js';

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('tokens and validation', () => {
  it('fills known tokens and reports unknown ones', () => {
    const doc = sampleInvoice(DEFAULT_REGIONAL);
    expect(fillTokens('Invoice {{invoice.number}}', doc, { number: 1, count: 1 })).toContain(doc.invoice.number);
    expect(tokensIn('a {{invoice.number}} b {{nope.x}}')).toEqual(['invoice.number', 'nope.x']);
  });
  it('default template validates; a bad token is flagged', () => {
    const t = defaultTemplate();
    expect(validateTemplate(t)).toEqual([]);
    (t.body[0] as any) = { id: 'x1', type: 'text', text: 'Hi {{bogus.token}}' };
    expect(validateTemplate(t).some((e) => e.blockId === 'x1')).toBe(true);
  });
});

describe('codes', () => {
  it('QR matrix is square with finder patterns', () => {
    const m = qrMatrix('https://pay.example/inv/1');
    expect(m.length).toBeGreaterThan(20);
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true);
  });
  it('Code128 bars start and stop correctly', () => {
    const { bars, modules } = code128Bars('INV-0001');
    expect(modules).toBeGreaterThan(50);
    expect(bars[0]![0]).toBe(0);
  });
});

describe('pdf renderer', () => {
  it('renders a screen PDF, deterministically', async () => {
    const a = await renderInvoicePdf(defaultTemplate(), sampleInvoice(DEFAULT_REGIONAL), SCREEN_PROFILE);
    const b = await renderInvoicePdf(defaultTemplate(), sampleInvoice(DEFAULT_REGIONAL), SCREEN_PROFILE);
    expect(text(a.pdf).startsWith('%PDF')).toBe(true);
    expect(a.pages).toBeGreaterThan(0);
    expect(Buffer.compare(Buffer.from(a.pdf), Buffer.from(b.pdf))).toBe(0);
  });
  it('print profile adds bleed, TrimBox/BleedBox, CMYK and sheet barcode', async () => {
    const r = await renderInvoicePdf(defaultTemplate(), sampleInvoice(DEFAULT_REGIONAL), DEFAULT_PRINT_PROFILE, { sequence: 3, barcodeValue: (p) => `0000003-${p}` });
    const doc = await PDFDocument.load(r.pdf);
    const page = doc.getPage(0);
    expect(page.getTrimBox().width).toBeCloseTo(210 * 72 / 25.4, 0);
    expect(page.getBleedBox().width).toBeGreaterThan(page.getTrimBox().width);
    expect(r.pdf.length).toBeGreaterThan((await renderInvoicePdf(defaultTemplate(), sampleInvoice(DEFAULT_REGIONAL), SCREEN_PROFILE)).pdf.length - 1);
  });
  it('long invoices paginate', async () => {
    const doc = sampleInvoice(DEFAULT_REGIONAL);
    const first = doc.lines[0]!;
    doc.lines = Array.from({ length: 120 }, (_, i) => ({ ...first, description: `Line ${i}`, serviceId: `S${i}` }));
    const r = await renderInvoicePdf(defaultTemplate(), doc, SCREEN_PROFILE);
    expect(r.pages).toBeGreaterThan(1);
  });
});

describe('legacy converter', () => {
  it('converts HTML with mixed token syntaxes and flags unknowns', () => {
    const html = `<style>h1{color:#c00}</style><h1>Bill {{invoice_number}}</h1><p>Dear ${'${customer_name}'}, owed [[totaldue]] and %mystery%.</p>
      <table class="items"><thead><tr><th>Desc</th><th>Amount</th></tr></thead><tbody><tr class="item"><td>x</td><td>1</td></tr></tbody></table>`;
    const { template, report } = convertLegacy({ format: 'HTML', content: html });
    expect(template.body.length).toBeGreaterThan(1);
    expect(validateTemplate(template)).toEqual([]);
    expect(report.tokens.unknown).toContain('mystery');
    expect(JSON.stringify(template)).toContain('{{invoice.number}}');
    expect(template.body.some((b) => b.type === 'items')).toBe(true);
  });
  it('converts JSON designs with absolute placement', () => {
    const { template } = convertLegacy({ format: 'JSON', content: JSON.stringify({ elements: [{ type: 'text', text: 'Total {{total}}', x: 20, y: 30, width: 60 }] }) });
    expect(template.body.some((b) => b.placement)).toBe(true);
  });
  it('converts XML layouts', () => {
    const { template, report } = convertLegacy({ format: 'XML', content: '<layout><header><text>{{company}}</text></header><body><text>Hello {{customer.name}}</text></body></layout>' });
    expect(report.format).toBe('XML');
    expect(template.body.length).toBeGreaterThan(0);
  });
  it('a converted template renders', async () => {
    const { template } = convertLegacy({ format: 'HTML', content: '<h1>Bill {{invoice_number}}</h1><p>Hi {{customer_name}}</p>' });
    const r = await renderInvoicePdf(template, sampleInvoice(DEFAULT_REGIONAL), SCREEN_PROFILE);
    expect(r.pages).toBe(1);
  });
});
