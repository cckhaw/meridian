import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addExclusion, approveBillRun, cancelBillRun, createBillRun, DEFAULT_BILL_RUN_SETTINGS, executeBillRun, getBillRun, getBillRunSettings, includeAccounts, listBillRunItems, listExclusions, previewRunAccount, rejectBillRun, remock, removeExclusion, retryFailedItems, runBillRunSlice, setBillRunSettings, submitForApproval, updateCycleConfig } from './bill-runs.js';
import type { Db, Row } from './db.js';
import { placeOrder } from './orders.js';
import { reconcile } from './reports.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';

let db: Db;
const DAY = 17;
/** The next 17th (or the 17th just gone, within three days): a bill date that falls on the cycle day. */
const onDay = (day: number) => { const d = new Date(); d.setUTCDate(day); if (d.getTime() < Date.now() - 86_400_000 * 3) d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
const asOf = onDay(DAY);
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
async function subscriber(offers: string[], o: { cycleDay?: number; days?: number; parent?: string; segment?: string } = {}) {
  const { customer, account } = await newCustomer(db, { parentCustomerId: o.parent, segment: (o.segment as 'CONSUMER') ?? 'CONSUMER' });
  await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, o.cycleDay ?? DAY]);
  if (offers.length) { await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: offers.map((offerId) => ({ offerId })) }); await backdate(db, customer.id, o.days ?? 100); }
  return { customer, account: account! };
}
async function drive(id: string, until: string[]): Promise<Row> {
  for (let i = 0; i < 300; i++) { const r = await runBillRunSlice(db, id, { budgetMs: 50 }); if (until.includes(r.run.status)) return r.run; }
  throw new Error('run did not settle');
}
const mock = async (o: Parameters<typeof createBillRun>[2]) => { const r = await createBillRun(db, 'ops', o); return drive(r.id, ['MOCK_COMPLETED', 'FAILED']); };
const items = async (runId: string, f: Parameters<typeof listBillRunItems>[2] = {}) => (await listBillRunItems(db, runId, { limit: 100, ...f })).items;
const latest = async (status: string) => (await db.query(`SELECT id FROM bill_runs WHERE status=$1 ORDER BY created_at DESC LIMIT 1`, [status])).rows[0]!;

let a1: Row, a2: Row, a3: Row;
describe('bill run governance', () => {
  it('a mock prices every account of the cycle and writes nothing: no invoice, no journal, no notification', async () => {
    a1 = (await subscriber(['plan-sim-5g'])).account; a2 = (await subscriber(['plan-sim-5g', 'netflix-premium'])).account; a3 = (await subscriber([])).account;
    await db.query(`INSERT INTO invoices (shard_id, number, account_id, customer_id, kind, period_start, period_end, issue_date, due_date, status, currency, net_minor, tax_minor, total_minor, paid_minor)
      SELECT shard_id, 'PREV-1', id, customer_id, 'CYCLE', current_date - 70, current_date - 41, current_date - 40, current_date - 26, 'PAID', 'SGD', 400, 36, 436, 436 FROM accounts WHERE id=$1`, [a1.id]); // last month a1 paid 4.36: this month's 35.00 is a spike
    const gl = Number((await db.query('SELECT count(*) AS n FROM gl_entries')).rows[0]!.n);
    const run = await mock({ cycleDay: DAY, asOf });
    expect(run.summary.problem ?? null).toBeNull();
    expect(run).toMatchObject({ status: 'MOCK_COMPLETED', kind: 'CYCLE', cycleDay: DAY, accountsTotal: 3, percent: 100 });
    expect(run.counts).toMatchObject({ MOCKED: 2, NO_INVOICE: 1 });
    expect(run.mockTotalMinor).toBe(3500 + 3500 + 1999);
    expect(run.mockTaxMinor).toBeGreaterThan(0);
    expect(run.mockNetMinor + run.mockTaxMinor).toBe(run.mockTotalMinor);
    expect(Object.keys(run.summary.byStream).sort()).toEqual(['SUBSCRIPTION', 'THIRD_PARTY']);
    expect(Object.values(run.summary.byMarket as Record<string, { tax: number }>)[0]!.tax).toBe(run.mockTaxMinor);
    expect(Number((await db.query(`SELECT count(*) AS n FROM invoices WHERE bill_run_id=$1`, [run.id])).rows[0]!.n)).toBe(0);
    expect(Number((await db.query('SELECT count(*) AS n FROM gl_entries')).rows[0]!.n)).toBe(gl);
    expect(Number((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='INVOICE_ISSUED'`)).rows[0]!.n)).toBe(0);
    expect(run.anomalyCounts).toMatchObject({ SPIKE: 1, NO_HISTORY: 1 });
    const spiked = await items(run.id, { anomaly: 'SPIKE' });
    expect(spiked.map((i) => i.accountId)).toEqual([a1.id]);
    expect(spiked[0]).toMatchObject({ prevTotalMinor: 436, totalMinor: 3500 });
  });

  it('shows one account line by line, from the same code that will bill it', async () => {
    const run = await latest('MOCK_COMPLETED');
    const p = await previewRunAccount(db, run.id, a2.id);
    expect(p.lines.map((l: Row) => l.stream).sort()).toEqual(['SUBSCRIPTION', 'THIRD_PARTY']);
    expect(p.netMinor + p.taxMinor).toBe(3500 + 1999);
    expect(p.history).toEqual([]);
  });

  it('refuses a second run for the same cycle and date, and a date that is not the cycle day', async () => {
    await expect(createBillRun(db, 'ops', { cycleDay: DAY, asOf })).rejects.toThrow(/already a run/);
    await expect(createBillRun(db, 'ops', { cycleDay: DAY, asOf: '2031-05-18' })).rejects.toThrow(/bill cycle 17 bills on that day/);
    await expect(createBillRun(db, 'ops', { cycleDay: 17, daily: true })).rejects.toThrow(/Choose one/);
    await updateCycleConfig(db, 'root', 3, { enabled: false });
    await expect(createBillRun(db, 'ops', { cycleDay: 3 })).rejects.toThrow(/switched off/);
    await updateCycleConfig(db, 'root', 3, { enabled: true });
  });

  it('excludes an account, or a whole enterprise customer with its departments, and lifting the exclusion brings them back', async () => {
    const run = await latest('MOCK_COMPLETED');
    await expect(addExclusion(db, 'ops', { accountId: a2.id, runId: run.id, reason: 'no' })).rejects.toThrow(/Say why/);
    await addExclusion(db, 'ops', { accountId: a2.id, runId: run.id, reason: 'Legal dispute LD-42' });
    let r = await getBillRun(db, run.id);
    expect(r.counts).toMatchObject({ MOCKED: 1, EXCLUDED: 1 });
    expect(r.mockTotalMinor).toBe(3500);
    expect((await items(run.id, { status: 'EXCLUDED' }))[0]).toMatchObject({ accountId: a2.id, excludedReason: 'Legal dispute LD-42' });
    const ent = await subscriber(['plan-sim-5g'], { segment: 'ENTERPRISE' });
    const dep = await subscriber(['plan-sim-5g'], { segment: 'ENTERPRISE', parent: ent.customer.id });
    await cancelBillRun(db, 'ops', run.id);
    const fresh = await mock({ cycleDay: DAY, asOf });
    expect(fresh.counts).toMatchObject({ MOCKED: 4 });
    await addExclusion(db, 'ops', { customerId: ent.customer.id, runId: fresh.id, reason: 'Fraud investigation FI-9' });
    r = await getBillRun(db, fresh.id);
    expect(r.counts).toMatchObject({ MOCKED: 2, EXCLUDED: 2 });
    expect((await items(fresh.id, { status: 'EXCLUDED' })).map((i) => i.accountId).sort()).toEqual([ent.account.id, dep.account.id].sort());
    const ex = (await listExclusions(db, { runId: fresh.id }))[0]!;
    expect(Number(ex.itemsHeld)).toBe(2);
    await removeExclusion(db, 'ops', ex.id);
    r = await drive(fresh.id, ['MOCK_COMPLETED']);
    expect(r.counts).toMatchObject({ MOCKED: 4 });
  });

  it('puts an account back with "include", but not one a standing exclusion holds', async () => {
    const run = await latest('MOCK_COMPLETED');
    await addExclusion(db, 'ops', { accountId: a1.id, runId: run.id, reason: 'Hold for credit review' });
    expect((await getBillRun(db, run.id)).counts.EXCLUDED).toBe(1);
    await includeAccounts(db, 'ops', run.id, [a1.id]);
    expect((await drive(run.id, ['MOCK_COMPLETED'])).counts).toMatchObject({ MOCKED: 4 });
    const standing = await addExclusion(db, 'ops', { accountId: a3.id, reason: 'Standing hold: fraud' });
    expect(standing.runId).toBeNull();
    await addExclusion(db, 'ops', { accountId: a2.id, reason: 'Standing hold: dispute' });
    expect((await getBillRun(db, run.id)).counts.EXCLUDED).toBe(2); // a standing exclusion applies to a run under review at once
    await expect(includeAccounts(db, 'ops', run.id, [a2.id])).rejects.toThrow(/standing exclusion/);
    for (const e of await listExclusions(db)) await removeExclusion(db, 'root', e.id);
    await drive(run.id, ['MOCK_COMPLETED']);
    expect((await getBillRun(db, run.id)).counts).toMatchObject({ MOCKED: 4 });
  });

  it('with dual control the approver is a second person; a cycle can opt out', async () => {
    const run = await latest('MOCK_COMPLETED');
    try {
      await setBillRunSettings(db, 'root', { ...DEFAULT_BILL_RUN_SETTINGS, dualControl: true });
      expect((await getBillRun(db, run.id)).dualControl).toBe(true);
      await expect(approveBillRun(db, 'fin', run.id)).rejects.toThrow(/submit it for approval first/);
      await submitForApproval(db, 'ops', run.id, 'Ready');
      await expect(approveBillRun(db, 'ops', run.id)).rejects.toThrow(/second person/);
      await expect(rejectBillRun(db, 'fin', run.id, '')).rejects.toThrow(/Say what/);
      expect((await rejectBillRun(db, 'fin', run.id, 'Check the spike on one account')).status).toBe('MOCK_COMPLETED');
      await submitForApproval(db, 'ops', run.id);
      await updateCycleConfig(db, 'root', DAY, { dualControl: false });
      expect((await getBillRun(db, run.id)).dualControl).toBe(false);
      await updateCycleConfig(db, 'root', DAY, { dualControl: null });
      expect((await getBillRun(db, run.id)).dualControl).toBe(true);
    } finally { await setBillRunSettings(db, 'root', DEFAULT_BILL_RUN_SETTINGS); }
  });

  it('refuses to approve a stale mock, and a re-mock makes it current', async () => {
    const run = await latest('PENDING_APPROVAL');
    await db.query(`UPDATE bill_runs SET mock_finished_at = now() - interval '30 hours' WHERE id=$1`, [run.id]);
    await expect(approveBillRun(db, 'fin', run.id)).rejects.toThrow(/Run the mock again/);
    await remock(db, 'ops', run.id);
    expect((await getBillRun(db, run.id)).status).toBe('MOCK_RUNNING');
    expect((await drive(run.id, ['MOCK_COMPLETED'])).counts).toMatchObject({ MOCKED: 4 });
  });

  it('approve and execute bills exactly what was mocked: invoices issued, journals posted, customers told, the ledger reconciles', async () => {
    const run = await latest('MOCK_COMPLETED');
    const before = await getBillRun(db, run.id);
    expect(await approveBillRun(db, 'fin', run.id, { note: 'Reviewed', execute: true })).toMatchObject({ status: 'PRODUCTION_RUNNING', approvedBy: 'fin' });
    const done = await drive(run.id, ['COMPLETED', 'FAILED']);
    expect(done).toMatchObject({ status: 'COMPLETED', billedInvoices: 4, percent: 100 });
    expect(done.billedTotalMinor).toBe(before.mockTotalMinor);
    expect(done.summary.result).toMatchObject({ billed: 4, failed: 0, variance: 0 });
    expect(Number((await db.query(`SELECT count(*) AS n FROM invoices WHERE bill_run_id=$1`, [run.id])).rows[0]!.n)).toBe(4);
    expect(Number((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='INVOICE_ISSUED'`)).rows[0]!.n)).toBe(4);
    expect((await db.query(`SELECT 1 FROM lifecycle_outbox WHERE instruction='BILL_RUN_COMPLETED'`)).rows).toHaveLength(1);
    expect((await reconcile(db)).ok).toBe(true);
    for (const it of await items(run.id, { status: 'BILLED' })) expect(it.billedTotalMinor).toBe(it.totalMinor);
    await expect(executeBillRun(db, 'fin', run.id)).rejects.toThrow(/not possible/);
    await expect(createBillRun(db, 'ops', { cycleDay: DAY, asOf })).rejects.toThrow(/already billed/);
  });

  it('an exclusion added after the mock still holds at production, and an account that fails is retried on its own', async () => {
    const x = await subscriber(['plan-sim-5g'], { cycleDay: 18 });
    const y = await subscriber(['plan-sim-5g'], { cycleDay: 18 });
    const z = await subscriber(['plan-sim-5g'], { cycleDay: 18 });
    const run = await mock({ cycleDay: 18, asOf: onDay(18) });
    expect(run.counts).toMatchObject({ MOCKED: 3 });
    await db.query(`UPDATE bill_runs SET status='APPROVED', approved_by='fin', approved_at=now() WHERE id=$1`, [run.id]);
    await addExclusion(db, 'ops', { accountId: y.account.id, reason: 'Dispute opened after the mock' });
    await db.query(`UPDATE services SET offer_id='no-such-offer' WHERE account_id=$1`, [z.account.id]);
    await executeBillRun(db, 'fin', run.id);
    const done = await drive(run.id, ['COMPLETED', 'FAILED']);
    expect(done.counts).toMatchObject({ BILLED: 1, EXCLUDED: 1, FAILED: 1 });
    expect(done.summary.result).toMatchObject({ billed: 1, failed: 1, excluded: 1 });
    const failed = await items(run.id, { status: 'FAILED' });
    expect(failed[0]).toMatchObject({ accountId: z.account.id });
    expect(failed[0]!.error).toMatch(/offer/);
    await db.query(`UPDATE services SET offer_id='plan-sim-5g' WHERE account_id=$1`, [z.account.id]);
    const invoicesBefore = Number((await db.query('SELECT count(*) AS n FROM invoices')).rows[0]!.n);
    await retryFailedItems(db, 'ops', run.id);
    const again = await drive(run.id, ['COMPLETED']);
    expect(again.counts).toMatchObject({ BILLED: 2, EXCLUDED: 1 });
    expect(Number((await db.query('SELECT count(*) AS n FROM invoices')).rows[0]!.n)).toBe(invoicesBefore + 1);
    void x;
  });

  it('runs only for chosen accounts (selective), and leaves the rest of the cycle alone', async () => {
    const s1 = await subscriber(['plan-sim-5g'], { cycleDay: 19 });
    await subscriber(['plan-sim-5g'], { cycleDay: 19 });
    const run = await mock({ accountIds: [s1.account.id, '00000000-0000-4000-8000-000000000000'], asOf });
    expect(run).toMatchObject({ kind: 'SELECTIVE', accountsTotal: 1 });
    expect(run.summary.warnings[0]).toMatch(/not active accounts/);
    await approveBillRun(db, 'fin', run.id, { execute: true });
    expect((await drive(run.id, ['COMPLETED'])).billedInvoices).toBe(1);
    expect(Number((await db.query(`SELECT count(*) AS n FROM invoices WHERE account_id=$1`, [s1.account.id])).rows[0]!.n)).toBe(1);
    await expect(createBillRun(db, 'ops', { accountIds: [] })).rejects.toThrow(/at least one/);
  });

  it('flags an account that has services but would get no bill, and a bill at or over the large-bill limit', async () => {
    const z = await subscriber(['plan-sim-5g'], { cycleDay: 20 });
    await db.query(`UPDATE services SET activated_at = now() + interval '90 days' WHERE account_id=$1`, [z.account.id]);
    await subscriber(['plan-sim-5g'], { cycleDay: 20 });
    await setBillRunSettings(db, 'root', { ...DEFAULT_BILL_RUN_SETTINGS, largeMinor: 3000 });
    try {
      const run = await mock({ cycleDay: 20, asOf: onDay(20) });
      expect(run.anomalyCounts).toMatchObject({ ZERO: 1, LARGE: 1 });
      await cancelBillRun(db, 'ops', run.id, 'test over');
      expect((await getBillRun(db, run.id)).status).toBe('CANCELLED');
      await expect(cancelBillRun(db, 'ops', run.id)).rejects.toThrow(/not possible/);
    } finally { await setBillRunSettings(db, 'root', DEFAULT_BILL_RUN_SETTINGS); }
  });

  it('validates the settings', async () => {
    await expect(setBillRunSettings(db, 'root', { ...DEFAULT_BILL_RUN_SETTINGS, dropPercent: 0 })).rejects.toThrow(/drop limit/);
    expect((await getBillRunSettings(db)).enforceGovernance).toBe(true);
  });
});
