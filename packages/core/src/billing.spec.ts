import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creditInvoice, getInvoice, payInvoice, runBillCycle, runDunning } from './billing.js';
import { addDays, dayOf, today } from './dates.js';
import type { Db } from './db.js';
import { exportGl, glCsv, reconcile } from './reports.js';
import { advanceOrder, placeOrder } from './orders.js';
import { resumeService } from './lifecycle.js';
import { taxSplit } from './tax.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
async function subscriber(offers: string[], days: number, extra: { payment?: any; cycleDay?: number } = {}) {
  const { customer, account } = await newCustomer(db);
  await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, extra.cycleDay ?? dayOf(today())]);
  await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: extra.payment ?? { method: 'CASH' }, lines: offers.map((offerId) => ({ offerId })) });
  await backdate(db, customer.id, days);
  return { customer, account: account! };
}
const invoiceOf = async (accountId: string) => (await db.query(`SELECT * FROM invoices WHERE account_id=$1 ORDER BY issue_date DESC`, [accountId])).rows[0]!;

describe('tax', () => {
  it('splits inclusive and exclusive prices without losing a cent', () => {
    for (const amt of [1, 99, 3500, 29900, 129900, 1234567]) for (const bps of [700, 800, 900, 1100]) {
      const inc = taxSplit(amt, bps, true), exc = taxSplit(amt, bps, false);
      expect(inc.net + inc.tax).toBe(amt);
      expect(inc.gross).toBe(amt);
      expect(exc.net + exc.tax).toBe(exc.gross);
    }
    expect(taxSplit(10900, 900, true)).toEqual({ net: 10000, tax: 900, gross: 10900 });
  });
});

describe('billing', () => {
  it('bills a full cycle with tax, is idempotent, and the ledger reconciles', async () => {
    const { account } = await subscriber(['plan-sim-5g', 'netflix-premium'], 100);
    const run = await runBillCycle(db, today(), { accountId: account.id });
    expect(run).toMatchObject({ invoices: 1, errors: [] });
    const inv = await getInvoice(db, (await invoiceOf(account.id)).id);
    expect(inv.totalMinor).toBe(3500 + 1999);
    expect(inv.taxMinor).toBe(taxSplit(3500, 900, true).tax + taxSplit(1999, 900, true).tax);
    expect(inv.lines).toHaveLength(2);
    expect(inv.dueDate).toBe(addDays(today(), 14));
    const again = await runBillCycle(db, today(), { accountId: account.id });
    expect(again).toMatchObject({ invoices: 0, skipped: 1 });
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('pro-rates a service that went live part-way through the period', async () => {
    const { account } = await subscriber(['plan-sim-5g'], 10); // 10 days old; period is ~30 days
    await runBillCycle(db, today(), { accountId: account.id });
    const inv = await getInvoice(db, (await invoiceOf(account.id)).id);
    expect(inv.totalMinor).toBeGreaterThan(0);
    expect(inv.totalMinor).toBeLessThan(3500);
    expect(inv.lines[0].description).toMatch(/pro-rated/);
  });

  it('bills a daily-cycle account for the previous day', async () => {
    const { customer, account } = await newCustomer(db, { account: { billCycleDay: null } });
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    await backdate(db, customer.id, 5);
    await runBillCycle(db, today(), { accountId: account!.id });
    const inv = await invoiceOf(account!.id);
    expect(inv.periodStart).toBe(addDays(today(), -1));
    expect(inv.totalMinor).toBe(Math.round(3500 / 30));
  });

  it('spreads instalments over the bills with exact totals', async () => {
    const { customer, account } = await newCustomer(db);
    await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, dayOf(today())]);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'INSTALLMENT', installmentMonths: 12 }, lines: [{ offerId: 'plan-phone-24' }] });
    expect(o.totalMinor).toBe(29900);
    expect(o.payments).toHaveLength(0); // nothing collected upfront
    await advanceOrder(db, o.id, { type: 'ship' });
    await advanceOrder(db, o.id, { type: 'deliver' }); // the service (and its instalment plan) exists once the order activates
    const rows = (await db.query(`SELECT kind, amount_minor, remaining_cycles FROM service_charges WHERE account_id=$1 ORDER BY kind`, [account!.id])).rows;
    const total = rows.reduce((s, r) => s + r.amountMinor * r.remainingCycles, 0);
    expect(total).toBe(29900); // 12 x 2491 + 8 rounding
  });

  it('partial then full payment, overpayment rejected', async () => {
    const { account } = await subscriber(['plan-sim-5g'], 100);
    await runBillCycle(db, today(), { accountId: account.id });
    const id = (await invoiceOf(account.id)).id;
    await expect(payInvoice(db, id, { amountMinor: 99999, method: 'CASH' })).rejects.toThrow(/exceeds/);
    let inv = await payInvoice(db, id, { amountMinor: 1000, method: 'CASH' });
    expect(inv).toMatchObject({ status: 'ISSUED', balanceMinor: 2500 });
    inv = await payInvoice(db, id, { method: 'QR' });
    expect(inv).toMatchObject({ status: 'PAID', balanceMinor: 0 });
    await expect(payInvoice(db, id, { method: 'CASH', amountMinor: 1 })).rejects.toThrow(/exceeds/);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('dunning suspends after 15 days overdue and payment lifts the suspension', async () => {
    const { customer, account } = await subscriber(['plan-sim-5g'], 100);
    await runBillCycle(db, today(), { accountId: account.id });
    const inv = await invoiceOf(account.id);
    const d1 = addDays(inv.dueDate, 3), d2 = addDays(inv.dueDate, 16);
    expect((await runDunning(db, d1)).markedOverdue).toBeGreaterThanOrEqual(1);
    const svc = async () => (await db.query('SELECT id, status FROM services WHERE customer_id=$1', [customer.id])).rows[0]!;
    expect((await svc()).status).toBe('ACTIVE'); // reminder stage only
    await runDunning(db, d2);
    const s = await svc();
    expect(s.status).toBe('SUSPENDED');
    await expect(resumeService(db, s.id)).rejects.toThrow(/non-payment/);
    await payInvoice(db, inv.id, { method: 'CASH' });
    expect((await svc()).status).toBe('ACTIVE');
    expect((await db.query('SELECT dunning_stage FROM accounts WHERE id=$1', [account.id])).rows[0]!.dunningStage).toBe(0);
  });

  it('credit note reduces what is owed; crediting a paid invoice refunds the customer', async () => {
    const { account } = await subscriber(['plan-sim-5g', 'netflix-premium'], 100);
    await runBillCycle(db, today(), { accountId: account.id });
    const id = (await invoiceOf(account.id)).id;
    let inv = await creditInvoice(db, id, 1999, 'Netflix billed twice');
    expect(inv.balanceMinor).toBe(3500);
    await payInvoice(db, id, { method: 'CASH' });
    inv = await creditInvoice(db, id, 500, 'goodwill');
    expect(inv.status).toBe('PAID');
    expect(inv.paidMinor).toBe(3000);
    expect(inv.payments.some((p: any) => p.status === 'REFUNDED' && p.amountMinor === -500)).toBe(true);
    await expect(creditInvoice(db, id, 999999, 'x')).rejects.toThrow(/exceeds/);
    expect((await reconcile(db)).ok).toBe(true);
  });
});

describe('general ledger export', () => {
  it('exports unexported journals once, balanced, in SAP-style CSV', async () => {
    const first = await exportGl(db);
    expect(first.batch).not.toBeNull();
    expect(first.batch!.debitMinor).toBe(first.batch!.creditMinor);
    const lines = first.csv.trim().split('\r\n');
    expect(lines[0]).toBe('CompanyCode,PostingDate,DocType,DocumentRef,Currency,LineNo,GLAccount,DC,Amount,Text,Reference');
    expect(lines.length - 1).toBe(first.batch!.entryCount);
    const second = await exportGl(db);
    expect(second.batch).toBeNull();
    expect((await reconcile(db)).ok).toBe(true);
  });
  it('escapes CSV fields', () => {
    const csv = glCsv([{ journalId: 'abcdefgh-1', entryDate: '2026-01-02', sourceType: 'INVOICE', sourceId: 'x', accountCode: '1200', description: 'Say "hi", ok', debitMinor: 1050, creditMinor: 0, currency: 'SGD' }]);
    expect(csv).toContain('"Say ""hi"", ok"');
    expect(csv).toContain(',D,10.50,');
  });
});
