import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../csv.js';
import type { Db } from '../db.js';
import { placeOrder } from '../orders.js';
import { freshDb, newCustomer } from '../test-helpers.js';
import { DOMAINS, ENTITIES, createExportJob, publishTemplates, startExport, templateCsv, templateJson, templateVersion, entityById, maskValue, looksMasked } from './index.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  const { customer } = await newCustomer(db, { idDocument: 'S1234567A', email: 'zed@example.com' });
  await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
  await db.query(`INSERT INTO dealers (id, name, bank_account_no, bank_code) VALUES ('DLR-77777','Export Dealer','0011223344556','DBS')`);
  await db.query(`INSERT INTO dealer_agents (id, dealer_id, name) VALUES ('DLR-77777-A001','DLR-77777','Agent One')`);
});
afterAll(async () => { await db.close(); });

async function download(jobId: string, actor = 'root'): Promise<Buffer> {
  const { stream } = await startExport(db, jobId, actor);
  const chunks: Buffer[] = [];
  const r = stream.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(Buffer.from(value)); }
  return Buffer.concat(chunks);
}
/** Reads the archive with an independent tool (Python's zipfile), so the writer is checked against a real reader. */
function unzip(buf: Buffer): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  const file = join(dir, 'x.zip');
  writeFileSync(file, buf);
  const out = execFileSync('python3', ['-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({n: z.read(n).decode('utf-8') for n in z.namelist()}))`, file], { maxBuffer: 200 * 1024 * 1024 }).toString();
  return JSON.parse(out);
}

describe('export', () => {
  it('writes a valid ZIP of one CSV per data set, in load order, with a manifest that matches the files', async () => {
    const job = await createExportJob(db, 'root', { domains: ['operations', 'customer'], format: 'CSV' }, { canUnmask: false });
    expect(job).toMatchObject({ status: 'PENDING', masked: true });
    const files = unzip(await download(job.id));
    const names = Object.keys(files);
    expect(names[0]).toBe('README.txt');
    expect(names.at(-1)).toBe('manifest.json');
    expect(names.indexOf('p2-dealers.csv')).toBeLessThan(names.indexOf('p3-customers.csv'));
    expect(names.indexOf('p3-customers.csv')).toBeLessThan(names.indexOf('p3-accounts.csv'));
    const manifest = JSON.parse(files['manifest.json']!);
    for (const f of manifest.files) {
      expect(createHash('sha256').update(files[f.file]!).digest('hex'), f.file).toBe(f.sha256);
      expect(f.complete).toBe(true);
    }
    const dealers = parseCsv(files['p2-dealers.csv']!);
    expect(dealers[0]!.cells[0]).toBe('id');
    expect(dealers.find((r) => r.cells[0] === 'DLR-77777')).toBeTruthy();
    const done = (await db.query('SELECT * FROM migration_jobs WHERE id=$1', [job.id])).rows[0]!;
    expect(done).toMatchObject({ status: 'COMPLETED', percent: 100 });
    expect(Number(done.rowsDone)).toBeGreaterThan(0);
  });

  it('masks sensitive fields unless the super user asks, with a reason, and can be downloaded only once', async () => {
    const masked = unzip(await download((await createExportJob(db, 'root', { entities: ['dealers', 'customers'], format: 'CSV' }, { canUnmask: false })).id));
    expect(masked['p2-dealers.csv']).not.toContain('0011223344556');
    expect(masked['p2-dealers.csv']).toContain('****4556');
    const cust = parseCsv(masked['p3-customers.csv']!);
    const hashCol = cust[0]!.cells.indexOf('id_document_hash');
    expect(cust[1]!.cells[hashCol]).toMatch(/^h:[0-9a-f]{16}$/);
    expect(masked['p3-customers.csv']).not.toMatch(/[0-9a-f]{64}/);

    await expect(createExportJob(db, 'admin', { entities: ['dealers'], format: 'CSV', unmasked: true, reason: 'DR copy for migration' }, { canUnmask: false })).rejects.toThrow(/super user/);
    await expect(createExportJob(db, 'root', { entities: ['dealers'], format: 'CSV', unmasked: true, reason: 'short' }, { canUnmask: true })).rejects.toThrow(/at least 10/);
    const job = await createExportJob(db, 'root', { entities: ['dealers', 'customers'], format: 'CSV', unmasked: true, reason: 'Disaster recovery copy for the cut-over' }, { canUnmask: true });
    const clear = unzip(await download(job.id));
    expect(clear['p2-dealers.csv']).toContain('0011223344556');
    expect(clear['p3-customers.csv']).toMatch(/[0-9a-f]{64}/);
    expect(JSON.parse(clear['manifest.json']!).masked).toBe(false);
    expect((await db.query(`SELECT detail FROM audit_log WHERE entity_id=$1 AND action='EXPORT_UNMASKED_REQUESTED'`, [job.id])).rows[0]!.detail).toMatchObject({ reason: 'Disaster recovery copy for the cut-over' });
    await expect(startExport(db, job.id, 'root')).rejects.toThrow(/downloaded once/);
    await expect(startExport(db, job.id, 'someone-else')).rejects.toThrow(/not found|No export/i);
  });

  it('nests children under their parents in JSON, and keeps what masking and typing promise', async () => {
    const job = await createExportJob(db, 'root', { entities: ['customers', 'accounts', 'services', 'dealers', 'agents'], format: 'JSON' }, { canUnmask: false });
    const files = unzip(await download(job.id));
    expect(Object.keys(files).filter((n) => n.endsWith('.json') && n !== 'manifest.json').sort()).toEqual(['p2-dealers.json', 'p3-customers.json']); // accounts, services and agents ride inside their parents
    const customers = JSON.parse(files['p3-customers.json']!);
    expect(customers).toMatchObject({ entity: 'customers', masked: true });
    const withService = customers.records.find((c: any) => c.accounts.some((a: any) => a.services.length));
    expect(withService.accounts[0].services[0]).toMatchObject({ type: 'MOBILE', status: 'ACTIVE', offer_id: 'plan-sim-5g' });
    expect(typeof withService.accounts[0].credit_limit_minor === 'number' || withService.accounts[0].credit_limit_minor === null).toBe(true);
    const d = JSON.parse(files['p2-dealers.json']!).records.find((r: any) => r.id === 'DLR-77777');
    expect(d.agents).toEqual([expect.objectContaining({ id: 'DLR-77777-A001', name: 'Agent One' })]);
    expect(d.bank_account_no).toBe('****4556');
  });

  it('takes a big table in parts, with the cursor to continue from', async () => {
    await db.query(`INSERT INTO dealers (id, name) SELECT 'DLR-8' || lpad(g::text, 4, '0'), 'Bulk ' || g FROM generate_series(1, 25) g`);
    const first = await createExportJob(db, 'root', { entities: ['dealers'], format: 'CSV', maxRowsPerEntity: 10 }, { canUnmask: false });
    const a = unzip(await download(first.id));
    expect(parseCsv(a['p2-dealers.csv']!)).toHaveLength(1 + 10);
    const summary = (await db.query('SELECT summary FROM migration_jobs WHERE id=$1', [first.id])).rows[0]!.summary;
    expect(summary).toMatchObject({ partial: true });
    expect(summary.resume.dealers).toBeTruthy();
    const second = await createExportJob(db, 'root', { entities: ['dealers'], format: 'CSV', maxRowsPerEntity: 10, resume: summary.resume }, { canUnmask: false });
    const b = unzip(await download(second.id));
    const ids = (t: string) => parseCsv(t).slice(1).map((r) => r.cells[0]);
    expect(ids(b['p2-dealers.csv']!).some((i) => ids(a['p2-dealers.csv']!).includes(i))).toBe(false); // no overlap between parts
    expect(ids(a['p2-dealers.csv']!).at(-1)! < ids(b['p2-dealers.csv']!)[0]!).toBe(true);
  });

  it('validates the request', async () => {
    await expect(createExportJob(db, 'root', { format: 'CSV' }, { canUnmask: false })).rejects.toThrow(/Choose what to export/);
    await expect(createExportJob(db, 'root', { entities: ['nope'], format: 'CSV' }, { canUnmask: false })).rejects.toThrow(/Unknown data set/);
    await expect(createExportJob(db, 'root', { domains: ['nope'], format: 'CSV' }, { canUnmask: false })).rejects.toThrow(/Unknown domain/);
    await expect(createExportJob(db, 'root', { entities: ['dealers'], format: 'XML' as never }, { canUnmask: false })).rejects.toThrow(/CSV or JSON/);
  });
});

describe('templates and masking', () => {
  it('every data set can be exported and has a template with its header, constraints and examples', async () => {
    const all = await createExportJob(db, 'root', { domains: DOMAINS.map((d) => d.id), format: 'CSV' }, { canUnmask: false });
    const files = unzip(await download(all.id));
    const manifest = JSON.parse(files['manifest.json']!);
    expect(manifest.files.map((f: any) => f.id).sort()).toEqual(ENTITIES.map((e) => e.id).sort());
    for (const def of ENTITIES) {
      const t = await templateCsv(db, def);
      const header = parseCsv(t).find((r) => !r.cells[0]!.startsWith('#'))!.cells;
      if (def.id !== 'offers') {
        expect(t, def.id).toContain(`version ${templateVersion(def)}`);
        expect(t).toMatch(/# Example 1:/);
        const wanted = def.fields.filter((f) => !f.jsonOnly && !f.importOnly || f.importOnly).filter((f) => !f.jsonOnly).map((f) => f.name);
        expect(header, def.id).toEqual(wanted);
      } else {
        expect(header).toContain('offer_id');
      }
      const j = JSON.parse(templateJson(def));
      expect(j.template.entity).toBe(def.id);
      expect(j.records).toEqual([]);
      expect(j.examples).toHaveLength(2);
    }
    const cust = templateJson(entityById('customers')!);
    expect(JSON.parse(cust).template.fields.find((f: any) => f.name === 'segment')).toMatchObject({ required: true, pointsAt: 'customer_segments' });
  });

  it('publishes templates to the registry and changes a version only when a column does', async () => {
    const first = await publishTemplates(db);
    expect(first).toHaveLength(ENTITIES.length);
    const row = (await db.query(`SELECT version, columns FROM data_templates WHERE entity='services'`)).rows[0]!;
    expect(row.version).toBe(templateVersion(entityById('services')!));
    expect(row.columns.find((c: any) => c.name === 'identifier')).toMatchObject({ required: true });
    const before = (await db.query(`SELECT updated_at FROM data_templates WHERE entity='stores'`)).rows[0]!.updatedAt;
    await publishTemplates(db);
    expect((await db.query(`SELECT updated_at FROM data_templates WHERE entity='stores'`)).rows[0]!.updatedAt).toBe(before);
    expect(templateVersion(entityById('stores')!)).not.toBe(templateVersion(entityById('dealers')!));
  });

  it('masks by keeping the end, or with a keyed code that is stable and cannot be reversed; masked values are recognisable', () => {
    expect(maskValue('MASK', '0011223344556')).toBe('****4556');
    expect(maskValue('MASK', '12345')).toBe('****45');
    expect(maskValue('MASK', '123')).toBe('****');
    const p = maskValue('PSEUDONYM', 'abc') as string;
    expect(p).toMatch(/^h:[0-9a-f]{16}$/);
    expect(maskValue('PSEUDONYM', 'abc')).toBe(p);
    expect(maskValue('PSEUDONYM', 'abd')).not.toBe(p);
    expect(maskValue('MASK', null)).toBeNull();
    expect(looksMasked('****4556') && looksMasked(p) && !looksMasked('3456')).toBe(true);
  });
});
