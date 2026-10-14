import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoaRule, deleteCoaRule, listCoaRules, pickRule, previewCoaRule, unmappedLines, updateCoaRule, type CoaRule } from './coa.js';
import type { Db } from './db.js';
import { acknowledgeBatch, getBatchFile, redeliverBatch, runDailyClose, runJournalBatch } from './journal-batches.js';
import { getReport, listReports, reconcileBatch, reconcilePeriod } from './reconciliation.js';
import { reconcile } from './reports.js';
import { cleanSapSettings, getSapSettings, RestTransport, SapExporter, setSapSettings, SAP_FORMATS, type SapTransport } from './sap-exporter.js';
import { SubLedgerEngine, type LedgerEvent } from './sub-ledger.js';
import { freshDb } from './test-helpers.js';

let db: Db;
let engine: SubLedgerEngine;
beforeAll(async () => { db = await freshDb(); engine = new SubLedgerEngine(db); });
afterAll(async () => { await db.close(); });

const at = '2026-03-10T04:00:00Z';
let n = 0;
const id = () => `evt-${++n}`;
const invoice = (o: Partial<LedgerEvent> = {}): LedgerEvent => ({ eventId: id(), eventType: 'INVOICE_GENERATED', occurredAt: at, currency: 'SGD', reference: `INV-${n}`, taxMinor: 360, lines: [{ stream: 'SUBSCRIPTION', netMinor: 3000 }, { stream: 'THIRD_PARTY', netMinor: 1000 }], ...o });
const journalSums = async (journalId: string) => { const r = (await db.query('SELECT sum(debit_minor) AS d, sum(credit_minor) AS c, count(*) AS n FROM gl_entries WHERE journal_id=$1', [journalId])).rows[0]!; return { d: Number(r.d), c: Number(r.c), n: Number(r.n) }; };

describe('posting events', () => {
  it('every event type becomes a balanced journal', async () => {
    const events: LedgerEvent[] = [
      { eventId: id(), eventType: 'PAYMENT_SUCCESS', occurredAt: at, currency: 'SGD', reference: 'PAY-1', amountMinor: 4360 },
      invoice(),
      { eventId: id(), eventType: 'ADJUSTMENT_POSTED', occurredAt: at, currency: 'SGD', reference: 'CN-1', direction: 'CREDIT', taxMinor: 90, lines: [{ stream: 'USAGE', netMinor: 1000 }] },
      { eventId: id(), eventType: 'ADJUSTMENT_POSTED', occurredAt: at, currency: 'SGD', reference: 'DN-1', direction: 'DEBIT', taxMinor: 90, lines: [{ stream: 'DEVICE_INSTALMENT', netMinor: 1000 }] },
      { eventId: id(), eventType: 'ETC_CHARGED', occurredAt: at, currency: 'SGD', reference: 'ETC-1', netMinor: 20000, taxMinor: 1800 },
    ];
    for (const e of events) {
      const r = await engine.post(e);
      expect(r.duplicate).toBe(false);
      const s = await journalSums(r.journalId!);
      expect(s.d).toBe(s.c);
      expect(s.n).toBeGreaterThanOrEqual(2);
    }
    const etc = (await db.query(`SELECT account_code, stream, credit_minor FROM gl_entries WHERE event_type='ETC_CHARGED' AND credit_minor>0 ORDER BY credit_minor DESC`)).rows;
    expect(etc[0]).toMatchObject({ accountCode: '4000', stream: 'ETC' });
    const dn = (await db.query(`SELECT account_code FROM gl_entries WHERE source_id='DN-1' AND stream='DEVICE_INSTALMENT'`)).rows;
    expect(dn[0]!.accountCode).toBe('4100'); // instalments are goods revenue
    expect((await reconcile(db)).checks.find((c) => c.name === 'Ledger balances')!.ok).toBe(true);
  });

  it('is idempotent on eventId and rejects the same id with different content', async () => {
    const e = invoice();
    const first = await engine.post(e);
    const again = await engine.post(e);
    expect(again).toMatchObject({ duplicate: true, journalId: first.journalId });
    expect((await db.query('SELECT count(DISTINCT journal_id) AS n FROM gl_entries WHERE event_id=$1', [e.eventId])).rows[0]!.n).toBe(1);
    await expect(engine.post({ ...e, taxMinor: 999 })).rejects.toThrow(/different content/);
  });

  it('validates amounts, currency, streams and event types', async () => {
    await expect(engine.post(invoice({ currency: 'USD' }))).rejects.toThrow(/currency must be SGD/);
    await expect(engine.post(invoice({ taxMinor: 1.5 }))).rejects.toThrow(/whole number/);
    await expect(engine.post(invoice({ lines: [{ stream: 'SUBSCRIPTION', netMinor: -1 }] }))).rejects.toThrow(/whole number/);
    await expect(engine.post(invoice({ lines: [{ stream: 'MAGIC' as never, netMinor: 5 }] }))).rejects.toThrow(/Unknown revenue stream/);
    await expect(engine.post({ ...invoice(), eventType: 'NOPE' as never })).rejects.toThrow(/Unknown event type/);
    await expect(engine.post({ eventId: id(), eventType: 'PAYMENT_SUCCESS', occurredAt: 'yesterday', currency: 'SGD', amountMinor: 5 })).rejects.toThrow(/ISO/);
  });

  it('dates the posting in the company time zone', () => {
    expect(SubLedgerEngine.build(invoice({ occurredAt: '2026-03-10T17:30:00Z' }), 'Asia/Singapore').date).toBe('2026-03-11');
    expect(SubLedgerEngine.build(invoice({ occurredAt: '2026-03-10T17:30:00Z' }), 'UTC').date).toBe('2026-03-10');
  });

  it('dead-letters a bad message from the bus and can retry it after the cause is fixed', async () => {
    const bad = await engine.ingest({ topic: 't', key: 'k', value: '{not json' });
    expect(bad.ok).toBe(false);
    const wrongCcy = await engine.ingest({ value: invoice({ currency: 'USD' }) });
    expect(wrongCcy.ok).toBe(false);
    const open = await engine.deadLetters();
    expect(open.length).toBe(2);
    const retry = await engine.retryDeadLetter(open.find((d) => /currency/.test(d.error))!.id);
    expect(retry.ok).toBe(false); // still the wrong currency
    const fixed = JSON.stringify(invoice());
    const dl = (await db.query(`INSERT INTO ledger_dead_letters (payload, error) VALUES ($1,'was down') RETURNING id`, [fixed])).rows[0]!;
    expect(await engine.retryDeadLetter(Number(dl.id))).toMatchObject({ ok: true });
    expect((await engine.deadLetters()).some((d) => d.id === dl.id)).toBe(false);
  });
});

describe('immutability and partitions', () => {
  it('forbids delete and edits, but allows stamping the export batch once', async () => {
    const r = await engine.post(invoice());
    await expect(db.query('DELETE FROM gl_entries WHERE journal_id=$1', [r.journalId])).rejects.toThrow();
    await expect(db.query('UPDATE gl_entries SET debit_minor=debit_minor+1 WHERE journal_id=$1', [r.journalId])).rejects.toThrow();
    await expect(db.query(`UPDATE gl_entries SET account_code='9999' WHERE journal_id=$1`, [r.journalId])).rejects.toThrow();
    const b = (await db.query(`INSERT INTO gl_batches (entry_count, debit_minor, credit_minor) VALUES (0,0,0) RETURNING id`)).rows[0]!;
    await db.query('UPDATE gl_entries SET exported_batch_id=$2 WHERE journal_id=$1', [r.journalId, b.id]);
    const b2 = (await db.query(`INSERT INTO gl_batches (entry_count, debit_minor, credit_minor) VALUES (0,0,0) RETURNING id`)).rows[0]!;
    await expect(db.query('UPDATE gl_entries SET exported_batch_id=$2 WHERE journal_id=$1', [r.journalId, b2.id])).rejects.toThrow();
    await expect(db.query('UPDATE gl_entries SET exported_batch_id=NULL WHERE journal_id=$1', [r.journalId])).rejects.toThrow();
  });

  it('creates monthly partitions ahead of time and is repeatable', async () => {
    const first = await engine.ensurePartitions(14);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(await engine.ensurePartitions(14)).toBe(0);
    const parts = (await db.query(`SELECT count(*) AS n FROM pg_inherits WHERE inhparent='gl_entries'::regclass`)).rows[0]!;
    expect(Number(parts.n)).toBeGreaterThan(12);
  });
});

describe('posting rules', () => {
  const rule = (o: Partial<CoaRule>): CoaRule => ({ id: 'r', name: 'r', priority: 100, matchAccount: null, matchStream: null, matchEvent: null, matchSource: null, sapAccount: '1', costCenter: null, profitCenter: null, taxCode: null, status: 'ACTIVE', validFrom: null, validTo: null, note: null, ...o });
  const facts = { accountCode: '4000', stream: 'THIRD_PARTY', eventType: 'INVOICE_GENERATED', sourceType: 'INVOICE', entryDate: '2026-03-10' };

  it('picks the most specific rule, then the lowest priority, and honours status and validity', () => {
    const fallback = rule({ id: 'a', matchAccount: '4000', sapAccount: 'FALL' });
    const stream = rule({ id: 'b', matchAccount: '4000', matchStream: 'THIRD_PARTY', sapAccount: 'NETFLIX' });
    expect(pickRule([fallback, stream], facts)?.sapAccount).toBe('NETFLIX');
    expect(pickRule([fallback, stream], { ...facts, stream: 'USAGE' })?.sapAccount).toBe('FALL');
    const tie1 = rule({ id: 'c', matchAccount: '4000', priority: 5, sapAccount: 'LOW' });
    expect(pickRule([fallback, tie1], facts)?.sapAccount).toBe('LOW');
    expect(pickRule([rule({ matchAccount: '4000', status: 'INACTIVE' })], facts)).toBeNull();
    expect(pickRule([rule({ matchAccount: '4000', validTo: '2026-01-01' })], facts)).toBeNull();
    expect(pickRule([rule({ matchAccount: '4000', validFrom: '2026-04-01' })], facts)).toBeNull();
  });

  it('splits revenue streams to their own SAP accounts, cost centres and profit centres', async () => {
    const p = await previewCoaRule(db, { accountCode: '4000', stream: 'THIRD_PARTY', eventType: 'INVOICE_GENERATED', sourceType: 'INVOICE', entryDate: '2026-03-10' });
    expect(p).toMatchObject({ sapAccount: '420100', profitCenter: 'PC-DIGITAL' });
    expect((await previewCoaRule(db, { accountCode: '4000', stream: 'ETC' }))?.sapAccount).toBe('440100');
    expect((await previewCoaRule(db, { accountCode: '4100', stream: 'DEVICE_INSTALMENT' }))?.sapAccount).toBe('410200');
  });

  it('edits rules without a deployment, validates them, and reports lines no rule covers', async () => {
    const created = await createCoaRule(db, 'finance', { name: 'Test rule', matchAccount: '7777', sapAccount: '777000', costCenter: 'CC-1' });
    expect((await listCoaRules(db)).some((r) => r.id === created.id)).toBe(true);
    await expect(createCoaRule(db, 'finance', { name: '', sapAccount: '1' } as never)).rejects.toThrow();
    await expect(createCoaRule(db, 'finance', { name: 'x', sapAccount: '', matchAccount: '1' })).rejects.toThrow();
    const upd = await updateCoaRule(db, 'finance', created.id, { name: 'Test rule', matchAccount: '7777', sapAccount: '777001' });
    expect(upd.sapAccount).toBe('777001');
    await engine.post(invoice());
    await db.query(`DELETE FROM coa_mappings WHERE match_account='1200'`);
    expect((await unmappedLines(db)).some((u) => u.accountCode === '1200')).toBe(true);
    await createCoaRule(db, 'finance', { name: 'AR restored', matchAccount: '1200', sapAccount: '121000' });
    expect((await unmappedLines(db)).some((u) => u.accountCode === '1200')).toBe(false);
    await deleteCoaRule(db, 'finance', created.id);
    expect((await listCoaRules(db)).some((r) => r.id === created.id)).toBe(false);
    expect((await db.query(`SELECT count(*) AS n FROM audit_log WHERE entity IN ('coa_mapping','coa') `)).rows[0]!.n).toBeGreaterThan(0);
  });
});

describe('journal batches to SAP', () => {
  it('fails the run, exports nothing and flags the exception when a line has no posting rule', async () => {
    const hold = (await db.query(`SELECT * FROM coa_mappings WHERE match_account='2100'`)).rows;
    await db.query(`DELETE FROM coa_mappings WHERE match_account='2100'`);
    await engine.post(invoice());
    const stamped = async () => Number((await db.query('SELECT count(*) AS n FROM gl_entries WHERE exported_batch_id IS NOT NULL')).rows[0]!.n);
    const stampedBefore = await stamped();
    await expect(runJournalBatch(db, { runType: 'MANUAL', actor: 'finance' })).rejects.toThrow(/No posting rule for 2100/);
    const failed = (await db.query(`SELECT * FROM gl_batches WHERE status='FAILED'`)).rows;
    expect(failed.length).toBe(1);
    expect(await stamped()).toBe(stampedBefore);
    const rep = (await listReports(db, { status: 'MISMATCH' })).items;
    expect(rep.length).toBeGreaterThan(0);
    for (const h of hold) await db.query(`INSERT INTO coa_mappings (name, priority, match_account, sap_account, cost_center, profit_center, tax_code, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`, [h.name, h.priority, h.matchAccount, h.sapAccount, h.costCenter, h.profitCenter, h.taxCode]);
  });

  it.each(SAP_FORMATS)('%s file totals equal the ledger totals it came from', async (format) => {
    await engine.post(invoice());
    await engine.post({ eventId: id(), eventType: 'PAYMENT_SUCCESS', occurredAt: at, currency: 'SGD', reference: `PAY-${n}`, amountMinor: 1234 });
    const pending = (await db.query('SELECT sum(debit_minor) AS d, sum(credit_minor) AS c FROM gl_entries WHERE exported_batch_id IS NULL')).rows[0]!;
    const r = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format });
    expect(r.batch).not.toBeNull();
    expect(Number(r.batch!.debitMinor)).toBe(Number(pending.d));
    expect(Number(r.batch!.creditMinor)).toBe(Number(pending.c));
    const parsed = SapExporter.parse(r.file!.content, format, 2);
    expect(parsed.debitMinor).toBe(Number(pending.d));
    expect(parsed.creditMinor).toBe(Number(pending.c));
    expect(r.reconciliation!.status).toBe('OK');
    expect((await db.query('SELECT count(*) AS n FROM gl_entries WHERE exported_batch_id IS NULL')).rows[0]!.n).toBe(0);
    expect((await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format })).batch).toBeNull();
  });

  it('summarises by day by default and keeps one document per journal in DETAIL mode', async () => {
    await engine.post(invoice()); await engine.post(invoice());
    const summary = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format: 'JSON' });
    expect(summary.batch!.documentCount).toBe(1);
    await setSapSettings(db, 'finance', { ...(await getSapSettings(db)), aggregate: 'DETAIL' });
    await engine.post(invoice()); await engine.post(invoice());
    const detail = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format: 'JSON' });
    expect(detail.batch!.documentCount).toBe(2);
    await setSapSettings(db, 'finance', { ...(await getSapSettings(db)), aggregate: 'DAILY_SUMMARY' });
  });

  it('carries cost centre and profit centre onto the SAP lines', async () => {
    await engine.post(invoice());
    const r = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format: 'CSV' });
    expect(r.file!.content).toContain('420100');
    expect(r.file!.content).toContain('PC-DIGITAL');
  });

  it('SAP acknowledging a different total raises RECONCILIATION_MISMATCH and an event in the outbox', async () => {
    await engine.post(invoice());
    const r = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format: 'FLAT' });
    const before = Number((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='RECONCILIATION_MISMATCH'`)).rows[0]!.n);
    const rep = await acknowledgeBatch(db, r.batch!.id, { reference: 'SAP-1', debitMinor: Number(r.batch!.debitMinor) - 100, creditMinor: Number(r.batch!.creditMinor) }, 'finance');
    expect(rep.status).toBe('MISMATCH');
    const full = await getReport(db, rep.id);
    expect(full.exceptions.some((e: any) => e.code === 'RECONCILIATION_MISMATCH' && e.severity === 'ERROR')).toBe(true);
    expect(Number((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='RECONCILIATION_MISMATCH'`)).rows[0]!.n)).toBe(before + 1);
    const ok = await acknowledgeBatch(db, r.batch!.id, { reference: 'SAP-1', debitMinor: Number(r.batch!.debitMinor), creditMinor: Number(r.batch!.creditMinor) }, 'finance');
    expect(ok.status).toBe('OK');
  });

  it('a stored file that was altered no longer matches the ledger', async () => {
    await engine.post(invoice());
    const r = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', format: 'JSON' });
    const f = await getBatchFile(db, r.batch!.id);
    await db.query('UPDATE journal_batch_files SET content=$2 WHERE batch_id=$1', [r.batch!.id, f.content.replace(/"AMT_DOCCUR": ?"?(\d)/, '"AMT_DOCCUR": "9')]);
    const rep = await reconcileBatch(db, r.batch!.id, 'audit');
    expect(rep.status).toBe('MISMATCH');
  });

  it('delivers by REST, records a failure, and can send the stored file again', async () => {
    await setSapSettings(db, 'finance', { ...(await getSapSettings(db)), transport: 'REST', endpoint: 'https://sap.example/api/journals' });
    await engine.post(invoice());
    const calls: string[] = [];
    let status = 500;
    const transport: SapTransport = new RestTransport('https://sap.example/api/journals', 'tok', (async (_u: unknown, init: RequestInit) => { calls.push(String((init.headers as Record<string, string>)['idempotency-key'])); return new Response(JSON.stringify({ reference: 'SAPDOC-9' }), { status }); }) as never);
    const r = await runJournalBatch(db, { runType: 'MANUAL', actor: 'finance', transport });
    expect(r.delivery!.ok).toBe(false);
    expect((await db.query('SELECT delivery_status FROM gl_batches WHERE id=$1', [r.batch!.id])).rows[0]!.deliveryStatus).toBe('FAILED');
    status = 200;
    const again = await redeliverBatch(db, r.batch!.id, 'finance', transport);
    expect(again).toMatchObject({ ok: true, reference: 'SAPDOC-9' });
    expect(calls).toEqual([r.batch!.id, r.batch!.id]); // same idempotency key on the retry
    const b = (await db.query('SELECT delivery_status, sap_reference FROM gl_batches WHERE id=$1', [r.batch!.id])).rows[0]!;
    expect(b).toMatchObject({ deliveryStatus: 'DELIVERED', sapReference: 'SAPDOC-9' });
    await setSapSettings(db, 'finance', { ...(await getSapSettings(db)), transport: 'MANUAL', endpoint: '' });
  });

  it('exports each event at once when real-time export is on', async () => {
    await setSapSettings(db, 'finance', { ...(await getSapSettings(db)), realtime: true });
    const e = invoice();
    const r = await engine.post(e);
    const rows = (await db.query('SELECT DISTINCT exported_batch_id FROM gl_entries WHERE journal_id=$1', [r.journalId])).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]!.exportedBatchId).not.toBeNull();
    expect((await db.query('SELECT run_type FROM gl_batches WHERE id=$1', [rows[0]!.exportedBatchId])).rows[0]!.runType).toBe('REALTIME');
    await setSapSettings(db, 'finance', { ...(await getSapSettings(db)), realtime: false });
  });

  it('the daily close needs switching on, exports through yesterday only, and a rerun finds nothing', async () => {
    expect((await runDailyClose(db, {})).ran).toBe(false);
    await engine.post(invoice({ occurredAt: '2026-01-05T04:00:00Z' }));
    const r = await runDailyClose(db, { force: true, asOf: '2026-02-01' });
    expect(r.ran).toBe(true);
    expect(r.batch).not.toBeNull();
    expect(r.batch!.runType).toBe('SCHEDULED');
    expect((await runDailyClose(db, { force: true, asOf: '2026-02-01' })).batch).toBeNull();
    const rec = await reconcilePeriod(db, { from: '2026-01-01', to: '2026-12-31', actor: 'audit' });
    expect(rec.scope).toBe('PERIOD');
  });

  it('validates SAP settings', () => {
    expect(() => cleanSapSettings({ ...{ companyCode: 'TOOLONGCODE', documentType: 'SA', format: 'FLAT', aggregate: 'DETAIL', transport: 'MANUAL' } })).toThrow(/company code/);
    expect(() => cleanSapSettings({ companyCode: '1000', documentType: 'SA', format: 'FLAT', aggregate: 'DETAIL', transport: 'REST', endpoint: 'http://x' })).toThrow(/https/);
  });
});
