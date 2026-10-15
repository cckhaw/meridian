import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertTemplate, createTemplate, deleteTemplate, importLegacy, invoicePdf, previewTemplatePdf, publishTemplate, publishedSchema, saveDraft, setDefaultTemplate } from './billing-templates.js';
import { defaultTemplate } from './billing-docs/schema.js';
import type { Db } from './db.js';
import { exportPrintPackage } from './print-house.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

/** The archive read with Python's zipfile (an independent reader); text files as text, PDFs as base64. */
function unzip(buf: Buffer): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'ph-')); const file = join(dir, 'x.zip'); writeFileSync(file, buf);
  return JSON.parse(execFileSync('python3', ['-c', `
import zipfile, json, sys, base64
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({n: (base64.b64encode(z.read(n)).decode() if n.endswith('.pdf') else z.read(n).decode('utf-8')) for n in z.namelist()}))`, file], { maxBuffer: 200 * 1024 * 1024 }).toString());
}
async function collect(s: ReadableStream<Uint8Array>) { const c: Buffer[] = []; const r = s.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; c.push(Buffer.from(value)); } return Buffer.concat(c); }

async function invoiceFor(name: string, o: { address?: boolean; lines?: number } = {}) {
  const { customer, account } = await newCustomer(db, { displayName: name, address: o.address === false ? undefined : { line1: `${name} Road 1`, postcode: '123456', city: 'Singapore', country: 'SG' } });
  const num = `T-${name.replace(/\W/g, '')}`;
  const inv = (await db.query(`INSERT INTO invoices (shard_id, number, account_id, customer_id, kind, period_start, period_end, issue_date, due_date, status, currency, net_minor, tax_minor, total_minor)
    VALUES ($1,$2,$3,$4,'CYCLE','2026-09-01','2026-09-30','2026-10-01','2026-10-15','ISSUED','SGD',1000,90,1090) RETURNING id`, [account!.shardId, num, account!.id, customer.id])).rows[0]!;
  for (let i = 0; i < (o.lines ?? 2); i++) await db.query(`INSERT INTO invoice_lines (invoice_id, kind, revenue_account, description, net_minor, tax_minor, stream) VALUES ($1,'RECURRING','4000',$2,500,45,'SUBSCRIPTION')`, [inv.id, `Plan line ${i}`]);
  return inv.id as string;
}

describe('bill templates', () => {
  it('drafts, validation, publishing, default and versions', async () => {
    const t = await createTemplate(db, 'ops', { name: 'Standard' });
    expect(t.version).toBe(0);
    await expect(setDefaultTemplate(db, 'ops', t.id)).rejects.toThrow(/Publish/);
    await expect(saveDraft(db, 'ops', t.id, { template: { ...t.draft, body: [{ id: 'z', type: 'text', text: '{{no.such}}' }] } })).rejects.toThrow(/problem/);
    const p1 = await publishTemplate(db, 'ops', t.id, 'first');
    expect(p1).toMatchObject({ version: 1, isDefault: true });
    // editing the draft does not change the published version
    const edited = { ...t.draft, body: [{ id: 'z', type: 'text' as const, text: 'Only this' }] };
    await saveDraft(db, 'ops', t.id, { template: edited });
    expect((await publishedSchema(db, t.id)).schema.body).toHaveLength(t.draft.body.length);
    const p2 = await publishTemplate(db, 'ops', t.id);
    expect(p2.version).toBe(2);
    expect((await publishedSchema(db, t.id)).schema.body).toHaveLength(1);
    expect((await publishedSchema(db, t.id, 1)).schema.body).toHaveLength(t.draft.body.length);
    await expect(deleteTemplate(db, 'ops', t.id)).rejects.toThrow(/default/);
  });
  it('a legacy HTML template is kept as a draft with its conversion report', async () => {
    const r = await importLegacy(db, 'ops', { name: 'Old bill', format: 'HTML', content: '<h1>Bill {{invoice_number}}</h1><p>{{mystery}}</p>' });
    expect(r.source).toBe('LEGACY_HTML');
    expect(r.report?.tokens.unknown).toContain('mystery');
    expect(() => convertTemplate({ format: 'XML', content: '<<<' })).toThrow();
  });
  it('previews a draft and renders an issued invoice', async () => {
    const pv = await previewTemplatePdf(db, { template: defaultTemplate() });
    expect(Buffer.from(pv.pdf).subarray(0, 4).toString()).toBe('%PDF');
    const id = await invoiceFor('Preview Pat');
    const r = await invoicePdf(db, id);
    expect(r.number).toBe('T-PreviewPat');
    expect((await PDFDocument.load(r.pdf)).getPageCount()).toBe(r.pages);
  });
});

describe('print-house package', () => {
  it('batches bills into PDFs with control files, a manifest with matching hashes, and exceptions for missing addresses', async () => {
    const ids = [] as string[];
    for (const n of ['Ann', 'Ben', 'Cat', 'Dan', 'Eve']) ids.push(await invoiceFor(`Print ${n}`));
    ids.push(await invoiceFor('Print NoAddr', { address: false }));
    const r = await exportPrintPackage(db, 'ops', { selection: { invoiceIds: ids }, batchSize: 2, mailClass: 'PRIORITY' });
    const files = unzip(await collect(r.stream));
    const m = JSON.parse(files['manifest.json']!);
    expect(m.totals).toMatchObject({ invoices: 5, batches: 3, exceptions: 1 });
    expect(m.batches.map((b: any) => b.invoices)).toEqual([2, 2, 1]);
    expect(m.exceptions[0]).toMatchObject({ invoiceNumber: 'T-PrintNoAddr' });
    for (const b of m.batches) {
      const pdf = Buffer.from(files[`pdf/${b.file}`]!, 'base64');
      expect(createHash('sha256').update(pdf).digest('hex')).toBe(b.sha256);
      const doc = await PDFDocument.load(pdf);
      expect(doc.getPageCount()).toBe(b.pages);
      expect(doc.getPage(0).getBleedBox().width).toBeGreaterThan(doc.getPage(0).getTrimBox().width);
    }
    const csv = files[m.files.csv]!.trim().split('\r\n');
    expect(csv).toHaveLength(6);
    expect(csv[1]).toContain('PRIORITY');
    const dat = files[m.files.dat]!.trim().split('\r\n');
    expect(dat[0]).toMatch(/^H\|/);
    expect(dat[dat.length - 1]).toBe(`T|5|${m.totals.pages}|3`);
    expect(files['exceptions.csv']).toContain('No postal address');
    const job = (await db.query('SELECT * FROM print_jobs WHERE id=$1', [r.jobId])).rows[0]!;
    expect(job).toMatchObject({ status: 'COMPLETED', invoiceCount: 5, templateVersion: 2 });
  });
  it('refuses an empty selection or crop marks with no room', async () => {
    const id = await invoiceFor('Print Det');
    await expect(exportPrintPackage(db, 'ops', { selection: {} })).rejects.toThrow(/Choose what to print/);
    await expect(exportPrintPackage(db, 'ops', { selection: { invoiceIds: [id] }, profile: { bleedMm: 1, slugMm: 1 } })).rejects.toThrow(/Crop marks/);
  });
});
