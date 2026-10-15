import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db, Row } from '../db.js';
import { reconcile } from '../reports.js';
import { freshDb } from '../test-helpers.js';
import { cancelJob, completeUpload, createImportJob, createUpload, explodeJson, jobReportCsv, putChunk, rollbackJob, runMigrationSlice, startImport, getMigrationJob } from './index.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
// A job that was checked and left (or never started) would hold up everything that depends on it, as it should: tests clean up after themselves.
afterEach(async () => { await db.query(`UPDATE migration_jobs SET status='CANCELLED', claimed_until=NULL WHERE status IN ('PENDING','VALIDATED')`); });

const ACTOR = 'root';
/** Uploads a text file the way the browser does (in pieces), and closes the upload. */
async function upload(name: string, text: string | Buffer): Promise<string> {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const u = await createUpload(db, ACTOR, { fileName: name, totalBytes: buf.length }, {});
  for (let n = 0; n * u.chunkBytes < buf.length; n++) await putChunk(db, ACTOR, u.id, n, buf.subarray(n * u.chunkBytes, (n + 1) * u.chunkBytes));
  return (await completeUpload(db, ACTOR, u.id, {})).uploads[0]!.id;
}
/** Runs a job in short slices until it stops by itself. */
async function drive(id: string, until: string[] = ['VALIDATED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK']): Promise<Row> {
  for (let i = 0; i < 400; i++) {
    const r = await runMigrationSlice(db, id, { budgetMs: 50 });
    if (until.includes(r.job.status)) return r.job;
  }
  throw new Error('job did not settle');
}
async function load(entity: string, name: string, text: string, o: Partial<Parameters<typeof createImportJob>[2]> = {}): Promise<Row> {
  const job = await createImportJob(db, ACTOR, { uploadId: await upload(name, text), entity, ...o });
  const checked = await drive(job.id);
  if (checked.status !== 'VALIDATED') return checked;
  if (!checked.summary.validation.canStart) return checked;
  await startImport(db, ACTOR, job.id);
  return drive(job.id);
}

describe('import: a whole migration in phase order', () => {
  it('loads catalog structure, SIM/IMSI/number pools, customers, accounts, services, balances and dunning, and the ledger still reconciles', async () => {
    // Phase 1
    let j = await load('catalog_structure', 'cat.csv', 'id,level,name,parent_id,network_type\nlegacy-mobile,NETWORK_TYPE,Legacy mobile,,mobile\nlegacy-plans,CATEGORY,Legacy plans,legacy-mobile,\nlegacy-grp,GROUP,Legacy group,legacy-plans,\n');
    expect(j.status, JSON.stringify([j.summary, (await getMigrationJob(db, j.id)).items])).toBe('COMPLETED');
    j = await load('offers', 'offers.csv', 'group_id,name,type,offer_id,monthly_fee\nlegacy-grp,Legacy 30,SIM_ONLY,legacy-30,30.00\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    j = await load('sims', 'sims.csv', 'iccid,kind,state,imsi\n8960123456789012345,PHYSICAL,WAREHOUSE_INVENTORY,525010000000001\n8960123456789012346,PHYSICAL,WAREHOUSE_INVENTORY,\n');
    expect(j).toMatchObject({ status: 'COMPLETED', rowsOk: 2 });
    j = await load('imsis', 'imsis.csv', 'imsi,state\n525010000000001,POOL_UNASSIGNED\n');
    expect(j.rowsOk).toBe(1);
    j = await load('msisdns', 'num.csv', 'msisdn,state\n+6591110001,AVAILABLE\n+6591110002,AVAILABLE\n+6598888888,AVAILABLE\n');
    expect(j.rowsOk).toBe(3);
    expect((await db.query(`SELECT tier FROM msisdn_inventory WHERE msisdn='+6598888888'`)).rows[0]!.tier).not.toBe('STANDARD'); // classified by the VIP patterns

    // Phase 3: a company with a department, and two people
    j = await load('customers', 'cust.csv',
      'id,segment,display_name,id_document,market_code,parent_customer_id,email,kyc_status\n' +
      'C-1,CONSUMER,Alex Tan,S1234567A,SG,,alex@example.com,VERIFIED\n' +
      'C-2,CONSUMER,Bea Lim,S7654321B,SG,,,\n' +
      'E-1,ENTERPRISE,Acme Pte Ltd,,SG,,,\n' +
      'E-1-D1,ENTERPRISE,Acme Finance,,SG,E-1,,\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    expect(j.rowsOk).toBe(4);
    const dept = (await db.query(`SELECT c.hierarchy_path::text AS p, c.parent_customer_id AS parent FROM customers c JOIN migration_refs r ON r.internal_id = c.id::text AND r.entity='customers' WHERE r.ref='E-1-D1'`)).rows[0]!;
    const root = (await db.query(`SELECT internal_id FROM migration_refs WHERE entity='customers' AND ref='E-1'`)).rows[0]!.internalId;
    expect(dept.parent).toBe(root);
    expect(dept.p.split('.').length).toBe(2);
    // Meridian never stores the raw ID number
    const alex = (await db.query(`SELECT id_document_ref, id_document_hash FROM customers c JOIN migration_refs r ON r.internal_id=c.id::text WHERE r.entity='customers' AND r.ref='C-1'`)).rows[0]!;
    expect(alex.idDocumentRef).not.toContain('S1234567A');
    expect(alex.idDocumentHash).toMatch(/^[0-9a-f]{64}$/);

    j = await load('accounts', 'acc.csv', 'id,customer_id,name,bill_cycle_day,currency,credit_limit_minor\nA-1,C-1,Alex main,5,SGD,50000\nA-2,C-2,Bea main,DAILY,,\nA-E1,E-1,Acme main,,SGD,\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    expect((await db.query(`SELECT bill_cycle_day, credit_limit_minor FROM accounts a JOIN migration_refs r ON r.internal_id=a.id::text WHERE r.ref='A-2'`)).rows[0]).toMatchObject({ billCycleDay: null });

    // Phase 4
    j = await load('services', 'svc.csv',
      'id,account_id,type,identifier,offer_id,status,activated_at,contract_term_months,iccid,imsi\n' +
      'S-1,A-1,MOBILE,+6591110001,legacy-30,ACTIVE,2023-02-01T00:00:00Z,24,8960123456789012345,525010000000001\n' +
      'S-2,A-2,MOBILE,+6591110002,legacy-30,SUSPENDED,2023-03-01T00:00:00Z,,,\n' +
      'S-3,A-2,MOBILE,+6591110003,legacy-30,TERMINATED,2021-03-01T00:00:00Z,,,\n'.replace('TERMINATED,2021', 'TERMINATED,2021'));
    // S-3 is terminated and lacks terminated_at: the check rejects it, and the job stops before loading anything
    expect(j.status).toBe('VALIDATED');
    expect(j.summary.validation).toMatchObject({ errors: 1, canStart: false });
    const rep = await jobReportCsv(db, j.id);
    expect(rep).toContain('terminated_at');
    expect((await db.query(`SELECT count(*) AS n FROM migration_refs WHERE entity='services'`)).rows[0]!.n).toBe(0);
    await cancelJob(db, ACTOR, j.id);

    j = await load('services', 'svc2.csv',
      'id,account_id,type,identifier,offer_id,status,activated_at,contract_term_months,iccid,imsi\n' +
      'S-1,A-1,MOBILE,+6591110001,legacy-30,ACTIVE,2023-02-01T00:00:00Z,24,8960123456789012345,525010000000001\n' +
      'S-2,A-2,MOBILE,+6591110002,legacy-30,SUSPENDED,2023-03-01T00:00:00Z,,,\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    // numbers, SIM and IMSI are now in use
    expect((await db.query(`SELECT state FROM msisdn_inventory WHERE msisdn='+6591110001'`)).rows[0]!.state).toBe('ASSIGNED_ACTIVE');
    expect((await db.query(`SELECT state FROM iccid_inventory WHERE iccid='8960123456789012345'`)).rows[0]!.state).toBe('ACTIVE');
    expect((await db.query(`SELECT state FROM imsi_inventory WHERE imsi='525010000000001'`)).rows[0]!.state).toBe('ACTIVE');
    expect((await db.query(`SELECT count(*) AS n FROM identifier_registry WHERE identifier IN ('+6591110001','+6591110002')`)).rows[0]!.n).toBe(2);

    // Phase 5
    j = await load('account_balances', 'bal.csv', 'account_id,balance_minor,due_date\nA-1,12500,2020-01-31\nA-2,3000,2099-01-31\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    const inv = (await db.query(`SELECT kind, status, total_minor FROM invoices WHERE kind='OPENING' ORDER BY total_minor DESC`)).rows;
    expect(inv).toEqual([{ kind: 'OPENING', status: 'OVERDUE', totalMinor: 12500 }, { kind: 'OPENING', status: 'ISSUED', totalMinor: 3000 }]);
    const rec = await reconcile(db);
    expect(rec.ok, JSON.stringify(rec.checks.filter((c) => !c.ok))).toBe(true);

    j = await load('dunning_states', 'dun.csv', 'account_id,stage,anchor_due,last_step\nA-1,2,2020-01-31,REMIND\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    expect((await db.query(`SELECT dunning_stage FROM accounts a JOIN migration_refs r ON r.internal_id=a.id::text WHERE r.ref='A-1'`)).rows[0]!.dunningStage).toBe(2);
    expect((await db.query(`SELECT status FROM dunning_runs`)).rows).toHaveLength(1);
  });

  it('loading the same file again changes nothing (keys already loaded are skipped)', async () => {
    const before = Number((await db.query('SELECT count(*) AS n FROM customers')).rows[0]!.n);
    const j = await load('customers', 'cust-again.csv', 'id,segment,display_name,id_document\nC-1,CONSUMER,Alex Tan,S1234567A\nC-2,CONSUMER,Bea Lim,S7654321B\nC-NEW,CONSUMER,New Person,S2222222C\n');
    expect(j).toMatchObject({ status: 'COMPLETED', rowsOk: 1, rowsSkipped: 2 });
    expect(Number((await db.query('SELECT count(*) AS n FROM customers')).rows[0]!.n)).toBe(before + 1);
  });
});

describe('import: the check and the error report', () => {
  it('reports every row-level problem with its line and field, and loads nothing when the job stops at the first problem', async () => {
    const before = Number((await db.query('SELECT count(*) AS n FROM customers')).rows[0]!.n);
    const j = await load('customers', 'bad.csv',
      'id,segment,display_name,id_document,email,market_code\n' +
      'B-1,CONSUMER,Good One,S3333333D,good@example.com,SG\n' +
      'B-2,NOPE,Bad Segment,S4444444E,,SG\n' +
      'B-3,CONSUMER,Bad Mail,S5555555F,not-an-email,SG\n' +
      'B-4,CONSUMER,,S6666666G,,SG\n' +
      'B-5,CONSUMER,Dup Doc,S3333333D,,SG\n' +
      'B-6,CONSUMER,Masked,****4556,,SG\n');
    expect(j.status).toBe('VALIDATED');
    expect(j.summary.validation).toMatchObject({ rows: 6, ok: 2 - 1 + 0 + 0 || 1, errors: 5, canStart: false });
    const items = (await getMigrationJob(db, j.id)).items;
    const by = (line: number) => items.filter((i) => i.line === line).map((i) => i.code);
    expect(by(3)).toContain('UNKNOWN_REFERENCE'); // line 1 is the header
    expect(by(4)).toContain('BAD_FORMAT');
    expect(by(5)).toContain('REQUIRED');
    expect(by(6)).toContain('DUPLICATE_CUSTOMER');
    expect(Number((await db.query('SELECT count(*) AS n FROM customers')).rows[0]!.n)).toBe(before);
    await expect(startImport(db, ACTOR, j.id)).rejects.toThrow(/problem/);
    const csv = await jobReportCsv(db, j.id);
    expect(csv).toContain('pass,line,severity,field,code,message');
    expect(csv).toContain('Bad Mail'.length ? 'BAD_FORMAT' : '');
  });

  it('skips the bad rows and loads the good ones when the job allows it, up to a threshold', async () => {
    const text = 'id,segment,display_name,id_document\n' + Array.from({ length: 20 }, (_, i) => `K-${i},CONSUMER,Person ${i},${i === 7 ? '' : `SK${1000 + i}`}`).join('\n') + '\n';
    const j = await load('customers', 'skip.csv', text, { onError: 'SKIP', errorThresholdPercent: 10 });
    expect(j).toMatchObject({ status: 'COMPLETED', rowsOk: 19, rowsError: 1 });
    // a threshold the file breaches: the job will not start
    const text2 = 'id,segment,display_name,id_document\n' + Array.from({ length: 10 }, (_, i) => `L-${i},${i < 3 ? 'NOPE' : 'CONSUMER'},P ${i},SL${100 + i}`).join('\n') + '\n';
    const j2 = await load('customers', 'skip2.csv', text2, { onError: 'SKIP', errorThresholdPercent: 10 });
    expect(j2.status).toBe('VALIDATED');
    expect(j2.summary.validation).toMatchObject({ errors: 3, canStart: false });
  });

  it('refuses a wrong header or a file from another template, before reading any row', async () => {
    const j = await createImportJob(db, ACTOR, { uploadId: await upload('h.csv', 'id,segment,colour\nX,CONSUMER,red\n'), entity: 'customers' });
    const r = await drive(j.id);
    expect(r.status).toBe('FAILED');
    expect(r.summary.problem).toMatch(/colour|display_name/);
    await expect(createImportJob(db, ACTOR, { uploadId: await upload('t.csv', '# Meridian import template: Stores (stores) · version 00000000 · load phase 2\r\nname\r\nX\r\n'), entity: 'customers' })).rejects.toThrow(/Stores/);
  });
});

describe('import: sequencing, slices, rollback', () => {
  it('makes a job wait for the data it points at, then carries on by itself', async () => {
    const a = await createImportJob(db, ACTOR, { uploadId: await upload('p1.csv', 'id,segment,display_name,id_document\nQ-1,CONSUMER,Queue One,SQ1\n'), entity: 'customers' });
    const b = await createImportJob(db, ACTOR, { uploadId: await upload('p2.csv', 'id,customer_id\nQA-1,Q-1\n'), entity: 'accounts' });
    const w = await runMigrationSlice(db, b.id, { budgetMs: 50 });
    expect(w.waitingFor).toBe('Customers');
    expect(w.job.status).toBe('PENDING');
    await drive(a.id); // checked, not yet loaded: the accounts job still waits
    expect((await runMigrationSlice(db, b.id, { budgetMs: 50 })).job.status).toBe('PENDING');
    await startImport(db, ACTOR, a.id);
    await drive(a.id);
    expect((await drive(b.id)).status).toBe('VALIDATED');
    await expect(startImport(db, ACTOR, b.id)).resolves.toMatchObject({ status: 'IMPORTING' });
    expect((await drive(b.id)).status).toBe('COMPLETED');
  });

  it('works in resumable slices: a tiny time budget and a big file still finish, each row once', async () => {
    const n = 1800;
    const text = 'iccid,state\n' + Array.from({ length: n }, (_, i) => `89601234567${String(10000000 + i)}`).join(',WAREHOUSE_INVENTORY\n') + ',WAREHOUSE_INVENTORY\n';
    const job = await createImportJob(db, ACTOR, { uploadId: await upload('many.csv', text), entity: 'sims', batchSize: 100 });
    let slices = 0;
    for (;;) { const r = await runMigrationSlice(db, job.id, { budgetMs: 1 }); slices++; if (r.job.status === 'VALIDATED') break; if (slices > 500) throw new Error('stuck'); }
    expect(slices).toBeGreaterThan(3); // it really did take several requests
    const v = (await db.query('SELECT * FROM migration_jobs WHERE id=$1', [job.id])).rows[0]!;
    expect(v).toMatchObject({ rowsTotal: n });
    await startImport(db, ACTOR, job.id);
    const done = await drive(job.id);
    expect(done).toMatchObject({ status: 'COMPLETED', rowsOk: n, rowsError: 0 });
    expect(Number((await db.query(`SELECT count(*) AS n FROM iccid_inventory WHERE batch IS NULL AND iccid LIKE '89601234567%'`)).rows[0]!.n)).toBeGreaterThanOrEqual(n);
  });

  it('only one request works on a job at a time', async () => {
    const job = await createImportJob(db, ACTOR, { uploadId: await upload('lease.csv', 'imsi,state\n525019999999901,POOL_UNASSIGNED\n'), entity: 'imsis' });
    await db.query(`UPDATE migration_jobs SET claimed_until = now() + interval '1 minute' WHERE id=$1`, [job.id]);
    expect((await runMigrationSlice(db, job.id, { budgetMs: 50 })).busy).toBe(true);
    await db.query(`UPDATE migration_jobs SET claimed_until = NULL WHERE id=$1`, [job.id]);
    expect((await drive(job.id)).status).toBe('VALIDATED');
  });

  it('rolls a load back, and refuses when something depends on it', async () => {
    const j = await load('customers', 'rb.csv', 'id,segment,display_name,id_document\nR-1,CONSUMER,Roll One,SR1\nR-2,CONSUMER,Roll Two,SR2\n');
    expect(j.status).toBe('COMPLETED');
    const mine = async () => Number((await db.query(`SELECT count(*) AS n FROM customers WHERE display_name LIKE 'Roll %'`)).rows[0]!.n);
    expect(await mine()).toBe(2);
    await rollbackJob(db, ACTOR, j.id, 'wrong file');
    expect((await drive(j.id, ['ROLLED_BACK'])).status).toBe('ROLLED_BACK');
    expect(await mine()).toBe(0);
    expect((await db.query(`SELECT count(*) AS n FROM migration_refs WHERE entity='customers' AND ref IN ('R-1','R-2')`)).rows[0]!.n).toBe(0);
    // the same file can now be loaded again
    expect((await load('customers', 'rb2.csv', 'id,segment,display_name,id_document\nR-1,CONSUMER,Roll One,SR1\n')).rowsOk).toBe(1);
    // accounts opened on those customers stop an attempt to take the customers out ... (accounts are separate jobs; customers do not block, accounts do)
    const acc = await load('accounts', 'rb3.csv', 'id,customer_id\nRA-1,R-1\n');
    expect(acc.status).toBe('COMPLETED');
    await db.query(`INSERT INTO services (shard_id, account_id, customer_id, type, identifier, offer_id, status) SELECT shard_id, id, customer_id, 'MOBILE', '+6590000001', 'legacy-30', 'ACTIVE' FROM accounts a JOIN migration_refs r ON r.internal_id=a.id::text WHERE r.ref='RA-1'`);
    await rollbackJob(db, ACTOR, acc.id);
    const stopped = await drive(acc.id, ['FAILED', 'ROLLED_BACK']);
    expect(stopped.status).toBe('FAILED');
    expect(stopped.summary.problem).toMatch(/services or invoices/);
  });

  it('refuses to roll back data sets that cannot be taken out safely', async () => {
    const j = await load('stores', 'st.csv', 'id,name\n,Migrated Store\n');
    expect(j.status, JSON.stringify(j.summary)).toBe('COMPLETED');
    await expect(rollbackJob(db, ACTOR, j.id)).rejects.toThrow(/cannot be taken out/);
  });
});

describe('import: other file shapes', () => {
  it('reads NDJSON, and a nested JSON document is split into one file per data set in load order', async () => {
    const doc = { entity: 'customers', records: [{ id: 'J-1', segment: 'CONSUMER', display_name: 'Json One', id_document: 'SJ1', accounts: [{ id: 'JA-1', name: 'Json acct' }] }] };
    const parts = explodeJson(doc);
    expect(parts.map((p) => p.entity)).toEqual(['customers', 'accounts']);
    expect(parts[1]!.records[0]).toMatchObject({ id: 'JA-1', customer_id: 'J-1' });
    const buf = Buffer.from(JSON.stringify(doc));
    const u = await createUpload(db, ACTOR, { fileName: 'nested.json', totalBytes: buf.length }, {});
    await putChunk(db, ACTOR, u.id, 0, buf);
    const done = await completeUpload(db, ACTOR, u.id, {});
    expect(done.uploads.map((x) => x.entity)).toEqual(['customers', 'accounts']);
    for (const p of done.uploads) {
      const j = await createImportJob(db, ACTOR, { uploadId: p.id, entity: p.entity! });
      expect((await drive(j.id)).status).toBe('VALIDATED');
      await startImport(db, ACTOR, j.id);
      expect((await drive(j.id)).status).toBe('COMPLETED');
    }
    expect((await db.query(`SELECT count(*) AS n FROM migration_refs WHERE ref IN ('J-1','JA-1')`)).rows[0]!.n).toBe(2);
    // a file that is for another data set is refused
    await expect(createImportJob(db, ACTOR, { uploadId: done.uploads[1]!.id, entity: 'customers' })).rejects.toThrow(/not Customers/);
  });

  it('refuses masked values, and CSV formula guards are undone', async () => {
    const j = await load('customers', 'guard.csv', "id,segment,display_name,id_document_hash\nG-1,CONSUMER,'=Guarded,h:0123456789abcdef\n");
    expect(j.status).toBe('VALIDATED');
    expect((await getMigrationJob(db, j.id)).items.map((i) => i.code)).toContain('MASKED_VALUE');
    const k = await load('customers', 'guard2.csv', "id,segment,display_name,id_document\nG-2,CONSUMER,'=Guarded,SG2\n");
    expect(k.status).toBe('COMPLETED');
    expect((await db.query(`SELECT display_name FROM customers c JOIN migration_refs r ON r.internal_id=c.id::text WHERE r.ref='G-2'`)).rows[0]!.displayName).toBe('=Guarded');
  });
});
