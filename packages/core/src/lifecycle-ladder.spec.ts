import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { payInvoice, runBillCycle } from './billing.js';
import { addDays, addMonths, dayOf, diffDays, today } from './dates.js';
import type { Db } from './db.js';
import { updateNode } from './catalog.js';
import { completePortOut, requestPortOut, resumeService, suspendService, suspendVoluntary, terminateService, autoResumeDue } from './lifecycle.js';
import { DEFAULT_LIFECYCLE, getLifecycleSettings, setLifecycleSettings } from './lifecycle-config.js';
import { evaluateCreditLimit, evaluateDunningLadder, LifecycleService, releaseQuarantinedNumbers, runDunning } from './lifecycle-service.js';
import { receiveDeposit } from './deposits.js';
import { placeOrder } from './orders.js';
import { reconcile } from './reports.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
async function subscriber(offerId = 'plan-sim-5g', days = 100) {
  const { customer, account } = await newCustomer(db);
  await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, dayOf(today())]);
  const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId }] });
  await backdate(db, customer.id, days);
  return { customer, account: account!, serviceId: o.services[0].id as string };
}
const svc = async (id: string) => (await db.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
const outbox = async (instruction: string, filter: { accountId?: string; serviceId?: string }) =>
  (await db.query(`SELECT * FROM lifecycle_outbox WHERE instruction=$1 AND ($2::uuid IS NULL OR account_id=$2::uuid) AND ($3::uuid IS NULL OR service_id=$3::uuid) ORDER BY id`, [instruction, filter.accountId ?? null, filter.serviceId ?? null])).rows;
async function billed(accountId: string) {
  await runBillCycle(db, today(), { accountId });
  return (await db.query(`SELECT * FROM invoices WHERE account_id=$1 AND kind='CYCLE' ORDER BY issue_date DESC LIMIT 1`, [accountId])).rows[0]!;
}
const configure = async (patch: (c: ReturnType<typeof structuredClone<typeof DEFAULT_LIFECYCLE>>) => void) => {
  const c = structuredClone(await getLifecycleSettings(db));
  patch(c);
  return setLifecycleSettings(db, 'test', c);
};

describe('A. voluntary suspension', () => {
  it('suspends for a capped time, keeps the number and SIM, and the customer can come back at once', async () => {
    const s = await subscriber();
    const before = await svc(s.serviceId);
    const r = await suspendVoluntary(db, s.serviceId, { months: 3, channel: 'SELF_SERVE' }, 'customer');
    expect([r.status, r.suspensionKind, r.barLevel]).toEqual(['SUSPENDED', 'VOLUNTARY', 'HARD']);
    expect(String(r.suspendUntil).slice(0, 10)).toBe(addMonths(today(), 3));
    expect([r.identifier, r.iccid]).toEqual([before.identifier, before.iccid]); // MSISDN and SIM stay
    const net = (await outbox('BAR_ALL', { serviceId: s.serviceId }))[0]!;
    expect(net.payload).toMatchObject({ retainMsisdn: true, retainSim: true, emergencyCalls: 'ALLOWED' });
    await expect(suspendVoluntary(db, s.serviceId, {}, 'customer')).rejects.toThrow(/Only ACTIVE/);
    const back = await resumeService(db, s.serviceId, 'customer', { channel: 'SELF_SERVE' });
    expect([back.status, back.barLevel, back.suspensionKind]).toEqual(['ACTIVE', 'NONE', null]);
    expect((await db.query('SELECT end_reason, ended_on::text FROM service_suspensions WHERE service_id=$1', [s.serviceId])).rows[0]).toMatchObject({ endReason: 'RESUMED', endedOn: today() });
    expect((await outbox('RESTORE', { serviceId: s.serviceId })).length).toBe(1);
  });

  it('refuses more than the cap, an unpaid account, and self-service when it is switched off', async () => {
    const s = await subscriber();
    await expect(suspendVoluntary(db, s.serviceId, { months: 7 }, 'agent')).rejects.toThrow(/at most 6 months/);
    await expect(suspendVoluntary(db, s.serviceId, { until: addDays(today(), -1) }, 'agent')).rejects.toThrow(/end after today/);
    await configure((c) => { c.voluntary.maxMonths = 2; });
    await expect(suspendVoluntary(db, s.serviceId, { months: 3 }, 'agent')).rejects.toThrow(/at most 2 months/);
    await configure((c) => { c.voluntary.maxMonths = 6; c.voluntary.selfServe = false; });
    await expect(suspendVoluntary(db, s.serviceId, { months: 1, channel: 'SELF_SERVE' }, 'customer')).rejects.toThrow(/switched off/);
    expect((await suspendVoluntary(db, s.serviceId, { months: 1, channel: 'STAFF' }, 'agent')).status).toBe('SUSPENDED'); // staff can still do it for them
    await configure((c) => { c.voluntary.selfServe = true; });

    const owing = await subscriber();
    await billed(owing.account.id);
    await db.query(`UPDATE invoices SET status='OVERDUE' WHERE account_id=$1`, [owing.account.id]);
    await expect(suspendVoluntary(db, owing.serviceId, { months: 1 }, 'agent')).rejects.toThrow(/overdue/);
  });

  it('resumes by itself on the end date, and only staff can lift a fraud suspension', async () => {
    const s = await subscriber();
    await suspendVoluntary(db, s.serviceId, { months: 1 }, 'agent');
    await db.query(`UPDATE services SET suspend_until = current_date - 1 WHERE id=$1`, [s.serviceId]);
    expect((await autoResumeDue(db, today())).resumed).toBeGreaterThanOrEqual(1);
    expect((await svc(s.serviceId)).status).toBe('ACTIVE');
    expect((await db.query('SELECT end_reason FROM service_suspensions WHERE service_id=$1', [s.serviceId])).rows[0]!.endReason).toBe('AUTO_RESUMED');

    await suspendService(db, s.serviceId, 'FRAUD', 'analyst');
    await expect(resumeService(db, s.serviceId, 'customer', { channel: 'SELF_SERVE' })).rejects.toThrow(/only be lifted by our staff/);
    await expect(suspendVoluntary(db, s.serviceId, {}, 'x')).rejects.toThrow(/Only ACTIVE/);
    expect((await resumeService(db, s.serviceId, 'analyst')).status).toBe('ACTIVE');
    const log = (await new LifecycleService(db).history(s.serviceId)).map((e) => e.action);
    expect(log).toEqual(expect.arrayContaining(['SUSPEND', 'AUTO_RESUME', 'RESUME']));
  });

  it('pauses or reduces the recurring charge, and prorates it on the bill after the return', async () => {
    const s = await subscriber('plan-sim-5g', 100);
    await updateNode(db, 'plan-sim-5g', { suspension: { mode: 'MAINTENANCE_FEE', monthlyFeeMinor: 600 } });
    const periodStart = addMonths(today(), -1), periodEnd = addDays(today(), -1);
    const days = diffDays(periodEnd, periodStart) + 1;
    // Suspended for the first 10 days of the period, then back.
    await db.query(`INSERT INTO service_suspensions (service_id, account_id, started_on, ended_on, end_reason, requested_by) VALUES ($1,$2,$3,$4,'RESUMED','agent')`, [s.serviceId, s.account.id, periodStart, addDays(periodStart, 10)]);
    const inv = await billed(s.account.id);
    const lines = (await db.query('SELECT description, net_minor, tax_minor FROM invoice_lines WHERE invoice_id=$1 ORDER BY description', [inv.id])).rows;
    expect(lines).toHaveLength(2);
    const gross = (l: any) => Number(l.netMinor) + Number(l.taxMinor);
    const rec = lines.find((l) => /pro-rated/.test(l.description))!, fee = lines.find((l) => /Maintenance fee/.test(l.description))!;
    expect(rec.description).toMatch(/suspended 10/);
    expect(gross(rec)).toBe(Math.round((3500 * (days - 10)) / days));
    expect(gross(fee)).toBe(Math.round((600 * 10) / days));
    // A paused offer (the default) has no fee line at all.
    await updateNode(db, 'plan-sim-5g', { suspension: { mode: 'PAUSE' } });
    const p = await subscriber('plan-sim-5g', 100);
    await db.query(`INSERT INTO service_suspensions (service_id, account_id, started_on, ended_on, end_reason, requested_by) VALUES ($1,$2,$3,$4,'RESUMED','agent')`, [p.serviceId, p.account.id, periodStart, addDays(periodStart, 10)]);
    const inv2 = await billed(p.account.id);
    expect((await db.query('SELECT 1 FROM invoice_lines WHERE invoice_id=$1', [inv2.id])).rows).toHaveLength(1);
    expect((await reconcile(db)).ok).toBe(true);
  });
});

describe('B. credit limit', () => {
  it('warns at 80%, soft-bars at 100% and lifts when usage drops or the next bill comes', async () => {
    const s = await subscriber();
    await db.query('UPDATE accounts SET credit_limit_minor = 10000 WHERE id=$1', [s.account.id]);
    expect((await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 7900 })).state).toBe('OK');
    const warn = await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 8000 });
    expect([warn.state, warn.actions.warned, warn.percent]).toEqual(['WARNED', true, 80]);
    expect((await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 8100 })).actions.warned).toBe(false); // told once
    expect(await outbox('CREDIT_WARNING', { accountId: s.account.id })).toHaveLength(1);
    expect((await svc(s.serviceId)).barLevel).toBe('NONE');

    const block = await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 10000 });
    expect([block.state, block.actions.barred]).toEqual(['BLOCKED', 1]);
    const bar = await svc(s.serviceId);
    expect([bar.status, bar.barLevel, bar.suspensionKind]).toEqual(['ACTIVE', 'SOFT', 'CREDIT']); // incoming still works
    expect((await outbox('BAR_OUTGOING', { serviceId: s.serviceId }))[0]!.payload).toMatchObject({ incoming: 'ALLOWED', emergencyCalls: 'ALLOWED' });
    expect((await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 10500 })).actions.barred).toBe(0); // not barred twice

    const lifted = await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 4000 });
    expect([lifted.state, lifted.actions.lifted]).toEqual(['OK', 1]);
    expect((await svc(s.serviceId)).barLevel).toBe('NONE');

    // Throttle instead of bar, and the bill resets it.
    await configure((c) => { c.credit.blockAction = 'THROTTLE'; });
    await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 20000 });
    expect((await svc(s.serviceId)).barLevel).toBe('THROTTLE');
    expect(await outbox('THROTTLE_DATA', { serviceId: s.serviceId })).toHaveLength(1);
    await billed(s.account.id);
    expect((await svc(s.serviceId)).barLevel).toBe('NONE');
    expect((await db.query('SELECT credit_state FROM accounts WHERE id=$1', [s.account.id])).rows[0]!.creditState).toBe('OK');
    await configure((c) => { c.credit.blockAction = 'SOFT_BAR'; });
  });

  it('does nothing without a limit, and leaves a dunning bar alone', async () => {
    const s = await subscriber();
    expect((await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 999_999 })).limitMinor).toBeNull();
    await db.query('UPDATE accounts SET credit_limit_minor = 1000 WHERE id=$1', [s.account.id]);
    await suspendService(db, s.serviceId, 'DUNNING', 'dunning');
    expect((await evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: 5000 })).actions.barred).toBe(0);
    await expect(evaluateCreditLimit(db, s.account.id, { unbilledUsageMinor: -1 })).rejects.toThrow(/whole amount/);
  });
});

describe('C. the dunning ladder', () => {
  it('climbs D+1 reminder, D+7 soft bar, D+14 hard bar, D+30 final notice, D+45 termination with quarantine and collections', async () => {
    const s = await subscriber('plan-phone-24', 180);
    const inv = await billed(s.account.id);
    const D = String(inv.dueDate).slice(0, 10);
    const step = async (n: number) => (await evaluateDunningLadder(db, s.account.id, addDays(D, n))).map((r) => r.step);

    expect(await step(0)).toEqual([]); // due today is not late yet
    expect(await step(1)).toEqual(['REMIND']);
    expect((await svc(s.serviceId)).status).toBe('ACTIVE');
    expect(await outbox('PAYMENT_REMINDER', { accountId: s.account.id })).toHaveLength(1);
    expect(await step(1)).toEqual([]); // once only

    expect(await step(7)).toEqual(['SOFT_BAR']);
    let x = await svc(s.serviceId);
    expect([x.status, x.barLevel]).toEqual(['ACTIVE', 'SOFT']); // outgoing calls and data blocked, incoming allowed
    expect((await outbox('BAR_OUTGOING', { serviceId: s.serviceId })).length).toBe(1);

    expect(await step(14)).toEqual(['HARD_BAR']);
    x = await svc(s.serviceId);
    expect([x.status, x.barLevel, x.suspensionKind]).toEqual(['SUSPENDED', 'HARD', 'DUNNING']);
    expect((await outbox('BAR_ALL', { serviceId: s.serviceId }))[0]!.payload).toMatchObject({ emergencyCalls: 'ALLOWED' });
    await expect(resumeService(db, s.serviceId, 'agent')).rejects.toThrow(/non-payment/);

    expect(await step(30)).toEqual(['FINAL_NOTICE']);
    const notice = (await outbox('FINAL_NOTICE', { accountId: s.account.id }))[0]!;
    expect(notice.payload.balanceMinor).toBe(inv.totalMinor);
    expect(notice.payload.estimatedEtcMinor).toBeGreaterThan(0); // what termination will cost on top

    expect(await step(44)).toEqual([]);
    expect(await step(45)).toEqual(['TERMINATE']);
    x = await svc(s.serviceId);
    expect([x.status, x.terminatedReason, x.iccid]).toEqual(['TERMINATED', 'DUNNING', null]);
    const q = (await db.query('SELECT reason, release_on::text FROM msisdn_quarantine WHERE identifier=$1', [x.identifier])).rows[0]!;
    expect([q.reason, q.releaseOn]).toEqual(['DUNNING', addDays(D, 45 + 90)]);
    expect((await outbox('DEPROVISION', { serviceId: s.serviceId }))[0]!.payload).toMatchObject({ systems: ['HLR', 'HSS', 'PCRF'] });
    const debt = (await outbox('HAND_OVER', { accountId: s.account.id }))[0]!;
    expect(debt.payload.balanceMinor).toBeGreaterThan(Number(inv.totalMinor)); // the cycle bill plus the closing invoice with the ETC
    expect((await db.query(`SELECT count(*)::int AS n FROM invoices WHERE account_id=$1 AND collections_at IS NOT NULL`, [s.account.id])).rows[0]!.n).toBe(2);
    expect((await db.query(`SELECT status FROM dunning_runs WHERE account_id=$1`, [s.account.id])).rows[0]!.status).toBe('TERMINATED');
    expect((await db.query(`SELECT count(*)::int AS n FROM dunning_steps s JOIN dunning_runs r ON r.id=s.run_id WHERE r.account_id=$1`, [s.account.id])).rows[0]!.n).toBe(5);
    expect(await step(50)).toEqual([]);
    expect(await releaseQuarantinedNumbers(db, addDays(D, 45 + 89))).toBe(0);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('paying lifts the bars and ends the ladder; a late job catches up with only the harshest bar', async () => {
    const s = await subscriber();
    const inv = await billed(s.account.id);
    const D = String(inv.dueDate).slice(0, 10);
    const steps = await evaluateDunningLadder(db, s.account.id, addDays(D, 20));
    expect(steps.map((r) => r.step)).toEqual(['REMIND', 'SOFT_BAR', 'HARD_BAR']);
    expect(steps[1]!.outcome).toMatchObject({ skipped: expect.any(String) });
    expect((await svc(s.serviceId)).status).toBe('SUSPENDED');
    await db.query(`UPDATE invoices SET status='OVERDUE' WHERE id=$1`, [inv.id]);
    await payInvoice(db, inv.id, { method: 'CASH' });
    const x = await svc(s.serviceId);
    expect([x.status, x.barLevel, x.suspensionKind]).toEqual(['ACTIVE', 'NONE', null]);
    expect((await db.query(`SELECT status FROM dunning_runs WHERE account_id=$1`, [s.account.id])).rows[0]!.status).toBe('PAID');
    expect((await outbox('RESTORE', { serviceId: s.serviceId })).length).toBe(1);
    expect(await evaluateDunningLadder(db, s.account.id, addDays(D, 50))).toEqual([]);
  });

  it('writes the debt off to the ledger instead when that is the setting, and a hard bar overrides a voluntary suspension', async () => {
    await configure((c) => { c.termination.debtAction = 'WRITE_OFF'; });
    const s = await subscriber();
    const inv = await billed(s.account.id);
    const D = String(inv.dueDate).slice(0, 10);
    await db.query(`UPDATE invoices SET status='ISSUED' WHERE id=$1`, [inv.id]);
    await evaluateDunningLadder(db, s.account.id, addDays(D, 1));
    await db.query(`UPDATE services SET status='SUSPENDED', suspension_kind='VOLUNTARY', suspended_reason='VOLUNTARY', bar_level='HARD', suspend_until=current_date + 30 WHERE id=$1`, [s.serviceId]);
    await db.query(`INSERT INTO service_suspensions (service_id, account_id, started_on, requested_by) VALUES ($1,$2,current_date - 2,'agent')`, [s.serviceId, s.account.id]);
    await evaluateDunningLadder(db, s.account.id, addDays(D, 14));
    expect((await svc(s.serviceId)).suspensionKind).toBe('DUNNING');
    expect((await db.query('SELECT end_reason FROM service_suspensions WHERE service_id=$1', [s.serviceId])).rows[0]!.endReason).toBe('CONVERTED_TO_DUNNING');
    await evaluateDunningLadder(db, s.account.id, addDays(D, 45));
    expect((await db.query('SELECT status FROM invoices WHERE id=$1', [inv.id])).rows[0]!.status).toBe('WRITTEN_OFF');
    expect((await db.query(`SELECT sum(debit_minor)::int AS d FROM gl_entries WHERE source_type='WRITE_OFF' AND source_id=$1 AND account_code='6100'`, [inv.id])).rows[0]!.d).toBe(Number(inv.totalMinor));
    expect((await reconcile(db)).ok).toBe(true);
    await configure((c) => { c.termination.debtAction = 'COLLECTIONS'; });
  });

  it('follows the ladder in Settings, and refuses a ladder that makes no sense', async () => {
    await configure((c) => { c.dunning = [{ action: 'REMIND', day: 2 }, { action: 'HARD_BAR', day: 5 }, { action: 'TERMINATE', day: 20 }]; });
    const s = await subscriber();
    const inv = await billed(s.account.id);
    const D = String(inv.dueDate).slice(0, 10);
    expect((await evaluateDunningLadder(db, s.account.id, addDays(D, 3))).map((r) => r.step)).toEqual(['REMIND']);
    expect((await evaluateDunningLadder(db, s.account.id, addDays(D, 6))).map((r) => r.step)).toEqual(['HARD_BAR']);
    const bad = (dunning: any) => configure((c) => { c.dunning = dunning; });
    await expect(bad([{ action: 'HARD_BAR', day: 5 }, { action: 'SOFT_BAR', day: 9 }])).rejects.toThrow(/cannot come after a harder step/);
    await expect(bad([{ action: 'REMIND', day: 3 }, { action: 'REMIND', day: 4 }])).rejects.toThrow(/twice/);
    await expect(bad([{ action: 'TERMINATE', day: 10 }, { action: 'REMIND', day: 20 }])).rejects.toThrow(/after the termination/);
    await expect(bad([])).rejects.toThrow(/at least one step/);
    await configure((c) => { c.dunning = DEFAULT_LIFECYCLE.dunning; });
    const r = await runDunning(db, addDays(D, 1));
    expect(r.evaluated).toBeGreaterThanOrEqual(0);
  });
});

describe('D. termination and the early termination charge', () => {
  it('charges the remaining months plus the subsidy clawback, with retention and VIP adjustments', async () => {
    const a = await subscriber('plan-phone-24', 180);
    const quote = await terminateService(db, a.serviceId, { reason: 'customer request' }, 'agent');
    expect(quote.etcMinor).toBe(Math.round((90100 * (24 - 5)) / 24));
    expect(quote.etc.quotedMinor).toBe(quote.etcMinor);
    expect(quote.unbilledRecurringMinor).toBeGreaterThan(0); // recurring since the last bill
    expect((await svc(a.serviceId)).terminatedReason).toBe('customer request');

    const b = await subscriber('plan-phone-24', 180);
    await expect(terminateService(db, b.serviceId, { etcAdjust: { waive: true, reason: ' ' } }, 'agent')).rejects.toThrow(/reason is needed/);
    await expect(terminateService(db, b.serviceId, { etcAdjust: { percent: 150, reason: 'x' } }, 'agent')).rejects.toThrow(/0 to 100/);
    const half = await terminateService(db, b.serviceId, { etcAdjust: { percent: 50, reason: 'retention offer 1234' } }, 'agent');
    expect(half.etcMinor).toBe(Math.round(quote.etcMinor / 2));
    expect(half.etc.adjustedBy).toMatch(/retention offer 1234/);

    const c = await subscriber('plan-phone-24', 180);
    const waived = await terminateService(db, c.serviceId, { etcAdjust: { waive: true, reason: 'goodwill' } }, 'agent');
    expect([waived.etcMinor, waived.waived]).toEqual([0, true]);

    const d = await subscriber('plan-phone-24', 180);
    const seg = (await db.query('SELECT segment FROM customers WHERE id=$1', [d.customer.id])).rows[0]!.segment as string;
    await configure((x) => { x.termination.waiveEtcSegments = [seg]; });
    const vip = await terminateService(db, d.serviceId, { reason: 'x' }, 'agent');
    expect([vip.etcMinor, vip.etc.adjustedBy]).toEqual([0, expect.stringContaining(seg)]);
    await configure((x) => { x.termination.waiveEtcSegments = []; });
  });

  it('adds usage that has not been billed yet, quarantines the number and refuses to end it twice', async () => {
    const s = await subscriber('plan-sim-5g', 60);
    const before = await svc(s.serviceId);
    const r = await terminateService(db, s.serviceId, { reason: 'moving abroad', unbilledUsageMinor: 1250 }, 'agent');
    expect(r.unbilledUsageMinor).toBe(1250);
    expect(r.invoice!.kind).toBe('FINAL');
    expect((await db.query(`SELECT description FROM invoice_lines WHERE invoice_id=$1 ORDER BY description`, [r.invoice!.id])).rows.map((l) => l.description).join('|')).toMatch(/Usage not yet billed/);
    expect((await db.query('SELECT release_on::text FROM msisdn_quarantine WHERE identifier=$1', [before.identifier])).rows[0]!.releaseOn).toBe(addDays(today(), 90));
    await expect(terminateService(db, s.serviceId, {}, 'agent')).rejects.toThrow(/already terminated/);
    await expect(resumeService(db, s.serviceId, 'agent')).rejects.toThrow(/only SUSPENDED/);
    await expect(suspendService(db, s.serviceId, 'ADMIN', 'agent')).rejects.toThrow(/Only ACTIVE/);
  });
});

describe('E. port-out', () => {
  it('terminates on the clearinghouse confirmation: closing invoice with usage and ETC, deposit refund, resources released, and a repeat is harmless', async () => {
    const s = await subscriber('plan-phone-24', 180);
    await receiveDeposit(db, s.account.id, { amountMinor: 500000 });
    const number = (await svc(s.serviceId)).identifier;
    await expect(new LifecycleService(db).confirmPortOut({ serviceId: s.serviceId }, 'clearinghouse')).rejects.toThrow(/not PORTING_OUT/);
    await requestPortOut(db, s.serviceId, { recipientOperator: 'OtherTel', portingCode: 'PC1' }, 'agent');
    await expect(suspendService(db, s.serviceId, 'ADMIN', 'agent')).rejects.toThrow(/Only ACTIVE/); // mid-port: no other state change

    const r: any = await new LifecycleService(db).confirmPortOut({ identifier: number, reference: 'NCH-77', unbilledUsageMinor: 2000 });
    expect(r.alreadyDone).toBe(false);
    expect(r.service).toMatchObject({ status: 'TERMINATED', terminatedReason: 'PORTED_OUT', iccid: null });
    expect(r.etcMinor).toBeGreaterThan(0);
    expect(r.unbilledUsageMinor).toBe(2000);
    expect(r.invoice.kind).toBe('FINAL');
    expect(r.depositAppliedMinor + r.depositRefundedMinor).toBe(500000);
    expect(r.depositAppliedMinor).toBe(Number(r.invoice.totalMinor)); // the deposit covers the closing invoice, the rest goes back
    expect(r.invoice.status).toBe('PAID');
    expect((await db.query('SELECT deposit_minor FROM accounts WHERE id=$1', [s.account.id])).rows[0]!.depositMinor).toBe(0);
    const q = (await db.query('SELECT reason, release_on::text FROM msisdn_quarantine WHERE identifier=$1', [number])).rows[0]!;
    expect([q.reason, q.releaseOn]).toEqual(['PORTED_OUT', '9999-12-31']); // never recycled: it belongs to the other operator now
    expect((await outbox('DEPROVISION', { serviceId: s.serviceId }))[0]!.payload).toMatchObject({ ported: true });
    expect((await db.query(`SELECT status FROM cases WHERE service_id=$1 AND type='MNP_PORT_OUT'`, [s.serviceId])).rows[0]!.status).toBe('RESOLVED');

    expect((await completePortOut(db, s.serviceId, 'clearinghouse') as any).alreadyDone).toBe(true); // the clearinghouse retried
    expect((await db.query(`SELECT count(*)::int AS n FROM invoices WHERE account_id=$1 AND kind='FINAL'`, [s.account.id])).rows[0]!.n).toBe(1);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('the daily job resumes ended suspensions, runs dunning and releases numbers that have rested', async () => {
    const s = await subscriber();
    await suspendVoluntary(db, s.serviceId, { months: 1 }, 'agent');
    await db.query(`UPDATE services SET suspend_until = current_date WHERE id=$1`, [s.serviceId]);
    const gone = await subscriber();
    await terminateService(db, gone.serviceId, { reason: 'x' }, 'agent');
    const number = (await svc(gone.serviceId)).identifier;
    const out = await new LifecycleService(db).runDailyJobs(addDays(today(), 91));
    expect(out.resumed.resumed).toBeGreaterThanOrEqual(1);
    expect(out.releasedNumbers).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT 1 FROM identifier_registry WHERE identifier=$1`, [number])).rows).toHaveLength(0); // free to be given out again
  });
});
