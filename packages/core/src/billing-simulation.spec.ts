import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateNode } from './catalog.js';
import { deleteSimulation, getSimulation, listSimulations, previewTermination, projectAccount, purgeSimulations, resolveService, saveSimulation, simulatePlanChange } from './billing-simulation.js';
import { addDays, addMonths, dayOf, today } from './dates.js';
import type { Db, Row } from './db.js';
import { terminateService } from './lifecycle.js';
import { advanceOrder, placeOrder } from './orders.js';
import { reconcile } from './reports.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await updateNode(db, 'good-phone-outright', { deals: [{ termMonths: 24, subsidyMinor: 40000 }, { termMonths: 12, subsidyMinor: 20000, waiveInLastMonths: 2 }] }, 'admin');
});
afterAll(async () => { await db.close(); });

/** A customer with a plan, a phone on a 24-month contract paid over 12 months, delivered. */
async function contractCustomer(cycleDay = 10) {
  const { customer, account } = await newCustomer(db);
  await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, cycleDay]);
  const placed = await placeOrder(db, { customerId: customer.id, accountId: account!.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: '1 Test Road',
    lines: [{ offerId: 'plan-sim-5g' }, { offerId: 'good-phone-outright', attachTo: 0, dealTermMonths: 24, payment: { mode: 'INSTALLMENT', months: 12 } }] } as never);
  await advanceOrder(db, placed.id, { type: 'ship' });
  const done = await advanceOrder(db, placed.id, { type: 'deliver' });
  const svc = done.services.find((s: any) => s.type === 'MOBILE');
  await db.query(`UPDATE services SET activated_at = now() - interval '100 days' WHERE id=$1`, [svc.id]);
  return { customer, account: account!, svc };
}
const count = async (t: string) => Number((await db.query(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);

describe('projection', () => {
  it('forecasts the next 24 bills: the plan every month, the phone for 12, the balance falling to nothing, and what leaving would cost', async () => {
    const { account } = await contractCustomer();
    const before = { inv: await count('invoices'), gl: await count('gl_entries'), ch: Number((await db.query(`SELECT sum(remaining_cycles) AS n FROM service_charges`)).rows[0]!.n) };
    const p = await projectAccount(db, account.id, { months: 24 });
    expect(p.months).toHaveLength(24);
    expect(p.months[0]!.billDate).toBe(p.from);
    expect(dayOf(p.from)).toBe(10);
    expect(p.months[1]!.billDate).toBe(addMonths(p.from, 1));
    const monthly = p.months[0]!.recurringMinor;
    expect(monthly).toBeGreaterThan(0);
    p.months.forEach((m: any) => expect(m.recurringMinor).toBe(monthly));
    // the phone instalments appear on the first 12 bills and then stop
    const withPhone = p.months.filter((m: any) => m.instalmentMinor > 0).map((m: any) => m.index);
    expect(withPhone).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // the balance falls instalment by instalment to nothing at the 12th
    expect(p.equipmentBalanceNowMinor).toBeGreaterThan(0);
    expect(p.months[0]!.equipmentBalanceMinor).toBeLessThan(p.equipmentBalanceNowMinor);
    expect(p.months[11]!.equipmentBalanceMinor).toBe(0);
    expect(p.months[11]!.equipmentBalanceMinor).toBeLessThanOrEqual(p.months[10]!.equipmentBalanceMinor);
    expect(p.finalInstalment).toMatchObject({ index: 12, settled: true, balanceAfterMinor: 0 });
    // leaving gets cheaper as the contract runs down, and costs nothing at the end
    expect(p.months[0]!.etcIfEndedMinor).toBeGreaterThan(p.months[11]!.etcIfEndedMinor);
    expect(p.months[23]!.etcIfEndedMinor).toBe(0);
    expect(p.totals.totalMinor).toBe(p.months.reduce((s: number, m: any) => s + m.totalMinor, 0));
    expect(p.months[23]!.cumulativeMinor).toBe(p.totals.totalMinor);
    expect(p.contracts[0]).toMatchObject({ termMonths: 24 });
    // it wrote nothing
    expect(await count('invoices')).toBe(before.inv);
    expect(await count('gl_entries')).toBe(before.gl);
    expect(Number((await db.query(`SELECT sum(remaining_cycles) AS n FROM service_charges`)).rows[0]!.n)).toBe(before.ch);
  });

  it('the first projected bill is exactly the bill that would be issued', async () => {
    const { account } = await contractCustomer(dayOf(today()));
    const p = await projectAccount(db, account.id, { months: 3 });
    expect(p.months[0]!.billDate).toBe(today());
    const { runBillCycle } = await import('./billing.js');
    await runBillCycle(db, today(), { accountId: account.id });
    const inv = (await db.query(`SELECT total_minor, tax_minor FROM invoices WHERE account_id=$1`, [account.id])).rows[0]!;
    expect(inv.totalMinor).toBe(p.months[0]!.totalMinor);
    expect(inv.taxMinor).toBe(p.months[0]!.taxMinor);
    // and once it is billed, the projection starts at the next one
    const after = await projectAccount(db, account.id, { months: 2 });
    expect(after.months[0]!.billDate).toBe(addMonths(today(), 1));
    expect(after.months[0]!.instalmentMinor).toBe(p.months[1]!.instalmentMinor); // one instalment fewer left
  });

  it('accepts a service number in place of the account, and refuses an unreasonable horizon', async () => {
    const { svc, account } = await contractCustomer();
    expect((await projectAccount(db, svc.identifier, { months: 2 })).account.id).toBe(account.id);
    await expect(projectAccount(db, account.id, { months: 0 })).rejects.toThrow(/1 to 60/);
    await expect(projectAccount(db, account.id, { months: 61 })).rejects.toThrow(/1 to 60/);
    await expect(projectAccount(db, '+6500000000', { months: 2 })).rejects.toThrow(/not found/);
  });
});

describe('termination preview', () => {
  it('matches the real termination to the cent, and changes nothing', async () => {
    const { svc, account } = await contractCustomer();
    const snapshot = { inv: await count('invoices'), svc: (await db.query('SELECT status FROM services WHERE id=$1', [svc.id])).rows[0]!.status };
    const when = addDays(today(), 0);
    const pre = await previewTermination(db, svc.id, { date: when, unbilledUsageMinor: 1234 });
    expect(await count('invoices')).toBe(snapshot.inv);
    expect(snapshot.svc).toBe('ACTIVE');
    expect(pre.etc.chargeMinor).toBe(40000); // nothing of 24 months elapsed
    expect(pre.etc.monthsRemaining).toBe(24);
    expect(pre.unbilledUsageMinor).toBe(1234);
    expect(pre.unbilledRecurringMinor).toBeGreaterThan(0);
    expect(pre.lines.map((l: Row) => l.kind).sort()).toEqual(['ADJUSTMENT', 'ETC', 'RECURRING']);
    expect(pre.instalmentBalanceCancelledMinor).toBeGreaterThan(0);
    expect(pre.notes.join(' ')).toMatch(/instalments are still to come/);
    const real = await terminateService(db, svc.id, { reason: 'check', unbilledUsageMinor: 1234 });
    expect(real.etcMinor).toBe(pre.etc.chargeMinor);
    expect(real.unbilledRecurringMinor).toBe(pre.unbilledRecurringMinor);
    expect(real.invoice!.totalMinor).toBe(pre.invoiceTotalMinor);
    expect(real.invoice!.taxMinor).toBe(pre.taxMinor);
    expect(pre.payNowMinor).toBe(pre.invoiceTotalMinor);
    expect((await reconcile(db)).ok).toBe(true);
    void account;
  });

  it('shows a waived charge and an adjusted one with the reason, the deposit that would be applied, and refuses the past and the ended', async () => {
    const { svc, account } = await contractCustomer();
    const waived = await previewTermination(db, svc.id, { etcAdjust: { waive: true, reason: 'Retention: customer staying on a new plan' } }, 'agent');
    expect(waived.etc).toMatchObject({ quotedMinor: 40000, chargeMinor: 0, waived: true });
    expect(waived.etc.adjustedBy).toMatch(/agent: Retention/);
    const half = await previewTermination(db, svc.id, { etcAdjust: { percent: 50, reason: 'Goodwill' } });
    expect(half.etc.chargeMinor).toBe(20000);
    await expect(previewTermination(db, svc.id, { etcAdjust: { percent: 50, reason: ' ' } })).rejects.toThrow(/reason/);
    await db.query('UPDATE accounts SET deposit_minor = 5000 WHERE id=$1', [account.id]);
    const dep = await previewTermination(db, svc.id, { refundDeposit: true });
    expect(dep.depositHeldMinor).toBe(5000);
    expect(dep.depositAppliedMinor).toBe(5000);
    expect(dep.payNowMinor).toBe(dep.invoiceTotalMinor - 5000);
    await expect(previewTermination(db, svc.id, { date: '2020-01-01' })).rejects.toThrow(/past/);
    await terminateService(db, svc.id, { reason: 'x' });
    await expect(previewTermination(db, svc.id)).rejects.toThrow(/already ended/);
  });

  it('shows no charge once the contract has run its term', async () => {
    const { svc } = await contractCustomer();
    await db.query(`UPDATE services SET contract_start = now() - interval '25 months' WHERE id=$1`, [svc.id]);
    const pre = await previewTermination(db, svc.id);
    expect(pre.etc.chargeMinor).toBe(0);
  });
});

describe('plan change', () => {
  it('pro-rates the old plan to the date and the new one from it, and compares with doing nothing', async () => {
    // The bill day is kept about ten days ahead of today so the effective date (three days out) always falls inside the current period, whatever day the test runs.
    const billDay = ((new Date().getUTCDate() + 9) % 28) + 1;
    const { svc } = await contractCustomer(billDay);
    const eff = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 3); return d.toISOString().slice(0, 10); })();
    const sim = await simulatePlanChange(db, svc.identifier, { newOfferId: 'plan-family-member', effectiveDate: eff });
    expect(sim.from.offerId).toBe('plan-sim-5g');
    expect(sim.to.offerId).toBe('plan-family-member');
    expect(sim.daysBefore + sim.daysAfter).toBeGreaterThanOrEqual(28);
    expect(dayOf(sim.statementDate)).toBe(billDay);
    expect(sim.periodEnd).toBe(addDays(sim.statementDate, -1));
    expect(sim.withChange.lines).toHaveLength(2);
    expect(sim.withChange.lines[0].description).toMatch(/until/);
    expect(sim.withChange.lines[1].description).toMatch(/from/);
    expect(sim.ifNothingChanges.totalMinor).toBe(3500);
    // a cheaper plan (1500 vs 3500): the statement is lower by about the new share of the difference
    expect(sim.differenceMinor).toBeLessThan(0);
    expect(Math.abs(sim.differenceMinor + Math.round((2000 * sim.daysAfter) / (sim.daysBefore + sim.daysAfter)))).toBeLessThanOrEqual(2);
    expect(sim.followingStatement.totalMinor).toBe(1500);
    expect(sim.followingDifferenceMinor).toBe(-2000);
    expect(sim.notes.join(' ')).toMatch(/downgrade/);
    expect(sim.notes.join(' ')).toMatch(/24-month contract/);
  });

  it('refuses the same plan, a plan that does not exist or is not on sale, and a date in the past', async () => {
    const { svc } = await contractCustomer(20);
    await expect(simulatePlanChange(db, svc.id, { newOfferId: 'plan-sim-5g' })).rejects.toThrow(/already on that plan/);
    await expect(simulatePlanChange(db, svc.id, { newOfferId: 'nope' })).rejects.toThrow(/not found/);
    await expect(simulatePlanChange(db, svc.id, { newOfferId: 'plan-family-member', effectiveDate: '2020-01-01' })).rejects.toThrow(/past/);
    await db.query(`UPDATE catalog_nodes SET status='RETIRED' WHERE id='plan-family-member'`);
    await expect(simulatePlanChange(db, svc.id, { newOfferId: 'plan-family-member' })).rejects.toThrow(/not on sale/);
    await db.query(`UPDATE catalog_nodes SET status='ACTIVE' WHERE id='plan-family-member'`);
  });
});

describe('saved simulations', () => {
  it('keeps a quote with its figures, lists it, and removes it; the ledger rows sit in the account\'s cycle partition', async () => {
    const { svc, account } = await contractCustomer(12);
    const quote = await previewTermination(db, svc.id, { unbilledUsageMinor: 500 });
    const run = await saveSimulation(db, 'agent-1', 'TERMINATION', { serviceId: svc.id, unbilledUsageMinor: 500 }, quote, 'Quote to Mr Tan');
    expect(run).toMatchObject({ kind: 'TERMINATION', title: 'Quote to Mr Tan', accountId: account.id, cycleDay: 12, createdBy: 'agent-1' });
    const got = await getSimulation(db, run.id);
    expect(got.summary.payNowMinor).toBe(quote.payNowMinor);
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]).toMatchObject({ kind: 'SETTLEMENT', totalMinor: quote.invoiceTotalMinor });
    expect(Number((await db.query(`SELECT count(*) AS n FROM simulation_ledger_c12 WHERE run_id=$1`, [run.id])).rows[0]!.n)).toBe(1);
    const proj = await projectAccount(db, account.id, { months: 6 });
    const pr = await saveSimulation(db, 'fin', 'PROJECTION', { accountId: account.id, months: 6 }, proj);
    expect((await getSimulation(db, pr.id)).rows).toHaveLength(6);
    expect((await listSimulations(db, { accountId: account.id })).items.map((r: Row) => r.id)).toEqual([pr.id, run.id]);
    expect((await listSimulations(db, { kind: 'TERMINATION' })).items.every((r: Row) => r.kind === 'TERMINATION')).toBe(true);
    await deleteSimulation(db, 'fin', pr.id);
    await expect(getSimulation(db, pr.id)).rejects.toThrow(/not found/);
    await db.query(`UPDATE simulation_runs SET created_at = now() - interval '100 days' WHERE id=$1`, [run.id]);
    expect(await purgeSimulations(db, 90)).toBeGreaterThanOrEqual(1);
    expect(Number((await db.query(`SELECT count(*) AS n FROM simulation_ledger WHERE run_id=$1`, [run.id])).rows[0]!.n)).toBe(0);
  });

  it('finds a service by id or by number', async () => {
    const { svc } = await contractCustomer();
    expect((await resolveService(db, svc.id)).identifier).toBe(svc.identifier);
    expect((await resolveService(db, svc.identifier)).id).toBe(svc.id);
    await expect(resolveService(db, ' ')).rejects.toThrow(/Give a service/);
    void backdate;
  });
});
