import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billedAccount } from './dunning-test-helpers.js';
import { buildEmvQr, crc16, parseEmvQr } from './emv-qr.js';
import { createArrangement, arrangementStatus, exportAgencyFile, listPlacements, recallPlacement } from './collections.js';
import { evaluateByRules, explainLadder, getDunningPayments, setDunningPayments } from './dunning-engine.js';
import { deleteDunningRule, dunningRuleProblems, getDunningRule, lateFeeAmount, listDunningRules, listLateFees, pickDunningRule, dunningContextOf, saveDunningRule, saveLateFee, deleteLateFee, type DunningRuleInput } from './dunning-rules.js';
import { MARKET_FACTS, SEA_MARKETS, seedDunningRules } from './seed-dunning-rules.js';
import { addDays, today } from './dates.js';
import type { Db } from './db.js';
import { createCase, transitionCase } from './cases.js';
import { payInvoice } from './billing.js';
import { runDunning } from './lifecycle-service.js';
import { updateCustomer } from './customers.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const T = today();
const svcState = async (accountId: string) => (await db.query('SELECT status, bar_level FROM services WHERE account_id=$1', [accountId])).rows[0]!;
const outbox = async (accountId: string, instruction: string) => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE account_id=$1 AND instruction=$2 ORDER BY id`, [accountId, instruction])).rows.map((r) => r.payload as Record<string, any>);
/** Makes the account's oldest unpaid invoice `day` days past due and walks its ladder as of today. */
async function at(a: { accountId: string; invoiceId: string }, day: number) {
  await db.query('UPDATE invoices SET due_date = $2 WHERE id=$1', [a.invoiceId, addDays(T, -day)]);
  return evaluateByRules(db, a.accountId, T);
}
const names = (r: Awaited<ReturnType<typeof at>>) => (r ?? []).map((s) => `${s.action}:${s.status}`);

describe('QR payment codes', () => {
  it('uses the EMVCo checksum and writes PromptPay and PayNow codes that read back', () => {
    expect(crc16('123456789')).toBe('29B1');
    const th = buildEmvQr({ scheme: 'PROMPTPAY', merchant: { proxy: '0812345678', name: 'Meridian Telecom', city: 'Bangkok' }, currency: 'THB', amountMinor: 123450, reference: 'INV-2026-000123' });
    const p = parseEmvQr(th);
    expect(p.ok).toBe(true);
    expect(p.fields).toMatchObject({ '00': '01', '01': '12', '53': '764', '54': '1234.50', '58': 'TH', '59': 'Meridian Telecom' });
    expect(p.fields['29']).toBe('0016A00000067701011101130066812345678');
    const sg = parseEmvQr(buildEmvQr({ scheme: 'PAYNOW', merchant: { uen: '201912345a', name: 'Meridian', city: 'Singapore' }, currency: 'SGD', amountMinor: 5000 }));
    expect(sg.ok).toBe(true);
    expect(sg.fields['26']).toBe('0009SG.PAYNOW010120210201912345A03010');
    expect(sg.fields['54']).toBe('50.00');
    expect(parseEmvQr(th.replace('1234.50', '1234.51')).ok).toBe(false);
  });
  it('takes the acquirer’s own merchant field for the other schemes, and refuses an incomplete setup', () => {
    const q = buildEmvQr({ scheme: 'QRIS', merchant: { accounts: { '51': '0014ID.CO.QRIS.WWW0215ID1234567890123' }, name: 'Meridian', city: 'Jakarta' }, currency: 'IDR', amountMinor: 150000, exponent: 0 });
    expect(parseEmvQr(q)).toMatchObject({ ok: true, fields: { '51': '0014ID.CO.QRIS.WWW0215ID1234567890123', '54': '150000', '58': 'ID' } });
    expect(() => buildEmvQr({ scheme: 'DUITNOW', merchant: { name: 'M', city: 'KL' }, currency: 'MYR', amountMinor: 100 })).toThrow(/acquirer/);
    expect(() => buildEmvQr({ scheme: 'PAYNOW', merchant: { uen: 'x', name: 'M', city: 'S' }, currency: 'SGD' })).toThrow(/UEN/);
    expect(() => buildEmvQr({ scheme: 'PROMPTPAY', merchant: { proxy: '0812345678', name: '', city: 'B' }, currency: 'THB' })).toThrow(/name and city/);
  });
});

describe('late fees and rule validation', () => {
  it('works out a flat fee or a percentage between a least and a most', () => {
    expect(lateFeeAmount({ mode: 'FLAT', flatMinor: 500, percentBps: 0, minMinor: 0, maxMinor: null }, 99999)).toBe(500);
    const pct = { mode: 'PERCENT' as const, flatMinor: 0, percentBps: 150, minMinor: 500, maxMinor: 10000 };
    expect([lateFeeAmount(pct, 10000), lateFeeAmount(pct, 100000), lateFeeAmount(pct, 9_000_000)]).toEqual([500, 1500, 10000]);
  });
  it('saves and checks late fees, and keeps one that a rule uses', async () => {
    await expect(saveLateFee(db, 't', { name: 'x', mode: 'FLAT' })).rejects.toThrow(/amount/);
    await expect(saveLateFee(db, 't', { name: 'x', mode: 'PERCENT', percentBps: 150, minMinor: 900, maxMinor: 100 })).rejects.toThrow(/most/);
    const f = await saveLateFee(db, 't', { name: 'Unused fee', mode: 'FLAT', flatMinor: 100 });
    expect((await deleteLateFee(db, 't', f.id)).ok).toBe(true);
  });
  const base = (steps: DunningRuleInput['steps']): DunningRuleInput => ({ code: 't', name: 'T', description: '', active: true, priority: 50, market: null, customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial: null, steps });
  const step = (name: string, day: number, action: string, params: object = {}) => ({ position: 0, name, enabled: true, trigger: { kind: 'DAYS_PAST_DUE' as const, days: day }, action: action as never, params, exclusions: {} });
  it('refuses ladders that make no sense', async () => {
    const msgs = await dunningRuleProblems(db, base([step('Notice', 5, 'NOTIFY', { channels: ['SMS'], template: 'FIRST_NOTICE' }), step('Early', 3, 'SOFT_BAR'), step('Hard', 9, 'HARD_BAR'), step('Soft again', 12, 'SOFT_BAR'), step('End', 20, 'TERMINATE'), step('After', 25, 'NOTIFY', { channels: ['SMS'], template: 'FIRST_NOTICE' })]));
    const text = msgs.join(' | ');
    expect(text).toMatch(/“Early” \(day 3\) comes after a step on day 5/);
    expect(text).toMatch(/“Soft again” cannot come after a harder step/);
    expect(text).toMatch(/Nothing can come after the termination/);
    expect((await dunningRuleProblems(db, base([step('Notify', 1, 'NOTIFY', {})]))).join()).toMatch(/at least one channel/);
    expect((await dunningRuleProblems(db, base([step('Fee', 1, 'LATE_FEE', {})]))).join()).toMatch(/choose a late fee/);
    expect((await dunningRuleProblems(db, { ...base([step('Bar', 1, 'SOFT_BAR')]), segments: ['NO-SUCH'] })).join()).toMatch(/no customer segment/);
    expect((await dunningRuleProblems(db, { ...base([step('Bar', 1, 'SOFT_BAR')]), partial: { thresholdPercent: 0, action: 'PAUSE', pauseDays: 7 } })).join()).toMatch(/threshold/);
    await expect(saveDunningRule(db, 't', base([]))).rejects.toThrow(/at least one step/);
  });
});

describe('the SEA market rules', () => {
  it('installs a late fee and four rules for each market, once', async () => {
    for (const mk of SEA_MARKETS) {
      const r = await seedDunningRules(db, { market: mk, actor: 'seed' });
      expect(r.created).toEqual([`consumer-standard-${mk.toLowerCase()}`, `consumer-vip-${mk.toLowerCase()}`, `enterprise-${mk.toLowerCase()}`, `high-risk-${mk.toLowerCase()}`]);
      expect((await seedDunningRules(db, { market: mk })).created).toEqual([]);
    }
    const fees = await listLateFees(db);
    expect(fees.find((f) => f.code === 'late-fee-sg')).toMatchObject({ mode: 'FLAT', flatMinor: 500, taxable: false });
    expect(fees.find((f) => f.code === 'late-fee-id')).toMatchObject({ mode: 'FLAT', flatMinor: 2500000 });
    expect(fees.find((f) => f.code === 'late-fee-my')).toMatchObject({ mode: 'PERCENT', percentBps: 150 });
    const sg = (await listDunningRules(db)).find((r) => r.code === 'consumer-standard-sg')!;
    expect(sg.steps.map((s) => [s.trigger.kind === 'DAYS_PAST_DUE' ? s.trigger.days : -1, s.action])).toEqual([[1, 'NOTIFY'], [7, 'NOTIFY'], [7, 'LATE_FEE'], [14, 'SOFT_BAR'], [21, 'HARD_BAR'], [35, 'NOTIFY'], [45, 'TERMINATE']]);
    expect(sg.steps[0]!.params).toMatchObject({ channels: ['SMS', 'WHATSAPP'], includeQr: true, qrScheme: 'PAYNOW' });
    expect(MARKET_FACTS.TH.qr).toBe('PROMPTPAY');
    const ent = (await listDunningRules(db)).find((r) => r.code === 'enterprise-sg')!;
    expect(ent.steps.filter((s) => s.action === 'SOFT_BAR' || s.action === 'HARD_BAR').map((s) => (s.trigger as { days: number }).days)).toEqual([30, 60]);
    expect(ent.steps.find((s) => s.action === 'CASE_TASK')!.params).toMatchObject({ holdsLaterBars: true });
  });
  it('picks the most specific rule for a customer', async () => {
    const rules = (await listDunningRules(db)).filter((r) => r.market === 'SG');
    const ctx = (o: Partial<Awaited<ReturnType<typeof dunningContextOf>>>) => ({ accountId: 'a', customerId: 'c', name: 'n', segment: 'CONSUMER', customerKind: 'INDIVIDUAL' as const, vip: false, highRisk: false, market: 'SG', currency: 'SGD', ...o });
    expect(pickDunningRule(rules, ctx({}))!.code).toBe('consumer-standard-sg');
    expect(pickDunningRule(rules, ctx({ vip: true }))!.code).toBe('consumer-vip-sg');
    expect(pickDunningRule(rules, ctx({ customerKind: 'BUSINESS' }))!.code).toBe('enterprise-sg');
    expect(pickDunningRule(rules, ctx({ vip: true, highRisk: true }))!.code).toBe('high-risk-sg');   // priority beats the rest
    expect(pickDunningRule(rules, ctx({ market: 'MY' }))).toBeNull();                                  // no rule for that market
    expect(pickDunningRule(rules.map((r) => ({ ...r, active: false })), ctx({}))).toBeNull();
  });
  it('can be edited with steps kept, and a rule in use cannot be deleted', async () => {
    const r = (await listDunningRules(db)).find((x) => x.code === 'high-risk-sg')!;
    const edited = await saveDunningRule(db, 'admin', { ...r, name: 'High risk SG v2', steps: [...r.steps].reverse().reverse() }, r.id);
    expect([edited.version, edited.name, edited.steps.map((s) => s.id)]).toEqual([r.version + 1, 'High risk SG v2', r.steps.map((s) => s.id)]);
    await expect(deleteDunningRule(db, 'admin', r.id)).resolves.toEqual({ ok: true });
    await seedDunningRules(db, { market: 'SG' });
  });
});

describe('walking an account down the consumer ladder', () => {
  it('reminds with a QR code, charges the late fee, bars in two stages, warns, then terminates, writes off and places the debt', async () => {
    await setDunningPayments(db, 'admin', { baseUrl: 'https://pay.example.com', merchants: { PAYNOW: { uen: '201912345A', name: 'Meridian Telecom', city: 'Singapore' } } });
    const a = await billedAccount(db);
    expect(await at(a, 0)).toEqual([]);                                                     // not yet overdue
    const d1 = await at(a, 1);
    expect(names(d1)).toEqual(['NOTIFY:APPLIED']);
    const rem = (await outbox(a.accountId, 'DUNNING_NOTICE'))[0]!;
    expect(rem).toMatchObject({ channels: ['SMS', 'WHATSAPP'], currency: 'SGD', daysPastDue: 1 });
    expect(rem.message).toMatch(/was due on/);
    expect(rem.message).toContain('SGQR / PayNow');
    expect(rem.payUrl).toMatch(/^https:\/\/pay\.example\.com\/pay\/INV-/);
    expect(parseEmvQr(rem.qr.payload)).toMatchObject({ ok: true, fields: { '53': '702', '58': 'SG' } });
    expect(await at(a, 1)).toEqual([]);                                                     // each step once
    const d7 = await at(a, 7);
    expect(names(d7)).toEqual(['NOTIFY:APPLIED', 'LATE_FEE:APPLIED']);
    const fee = d7![1]!.outcome as { invoice: string; amountMinor: number };
    expect(fee.amountMinor).toBe(500);                                                      // flat S$5, no tax on it
    expect((await db.query(`SELECT kind, tax_minor FROM invoices WHERE number=$1`, [fee.invoice])).rows[0]).toMatchObject({ kind: 'ADJUSTMENT', taxMinor: 0 });
    expect(await svcState(a.accountId)).toMatchObject({ status: 'ACTIVE', barLevel: 'NONE' });
    const d14 = await at(a, 14);
    expect(names(d14)).toEqual(['SOFT_BAR:APPLIED']);
    expect(await svcState(a.accountId)).toMatchObject({ status: 'ACTIVE', barLevel: 'SOFT' });
    const bar = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE account_id=$1 AND instruction='BAR_OUTGOING'`, [a.accountId])).rows[0]!.payload;
    expect(bar).toMatchObject({ incoming: 'ALLOWED', zeroRated: ['SELF_SERVE_APP', 'PAYMENT_PORTAL'], emergencyCalls: 'ALLOWED' });
    expect(names(await at(a, 21))).toEqual(['HARD_BAR:APPLIED']);
    expect(await svcState(a.accountId)).toMatchObject({ status: 'SUSPENDED', barLevel: 'HARD' });
    const d35 = await at(a, 35);
    expect(names(d35)).toEqual(['NOTIFY:APPLIED']);
    const fin = (await outbox(a.accountId, 'DUNNING_NOTICE')).at(-1)!;
    expect(fin).toMatchObject({ final: true });
    expect(fin.message).toMatch(/FINAL NOTICE/); expect(fin.message).toMatch(/terminated on \d{4}-\d{2}-\d{2}/);
    const d45 = await at(a, 45);
    expect(names(d45)).toEqual(['TERMINATE:APPLIED']);
    expect((await svcState(a.accountId)).status).toBe('TERMINATED');
    const written = (await db.query(`SELECT status FROM invoices WHERE account_id=$1 AND status='WRITTEN_OFF'`, [a.accountId])).rows;
    expect(written.length).toBeGreaterThanOrEqual(1);
    const placed = (await listPlacements(db)).find((p) => p.accountId === a.accountId)!;
    expect([placed.writtenOff, placed.status]).toEqual([true, 'PLACED']);
    expect((await db.query(`SELECT quarantine FROM (SELECT count(*) AS quarantine FROM msisdn_quarantine) x`)).rows[0]!.quarantine).toBeTruthy();
    const log = (await db.query(`SELECT step_name, status FROM dunning_steps WHERE run_id=(SELECT id FROM dunning_runs WHERE account_id=$1) ORDER BY id`, [a.accountId])).rows;
    expect(log.map((l) => l.status)).toEqual(Array(7).fill('APPLIED'));
    expect((await db.query(`SELECT status, rule_code FROM dunning_runs WHERE account_id=$1`, [a.accountId])).rows[0]).toMatchObject({ status: 'TERMINATED', ruleCode: 'consumer-standard-sg' });
    // the file for the collection agency
    const file = await exportAgencyFile(db, 'billing');
    expect(file.count).toBeGreaterThanOrEqual(1);
    expect(file.batchId).toMatch(/^COL-\d{8}-001$/);
    expect(file.csv.split('\r\n')[0]).toContain('placement_id');
    expect(file.csv).toContain(a.accountId);
    expect((await exportAgencyFile(db, 'billing')).count).toBe(0);                          // sent once
  });

  it('a late visit catches up with the harshest bar due and skips the softer one', async () => {
    const a = await billedAccount(db);
    const r = await at(a, 30);
    expect(names(r)).toEqual(['NOTIFY:APPLIED', 'NOTIFY:APPLIED', 'LATE_FEE:APPLIED', 'SOFT_BAR:SUPERSEDED', 'HARD_BAR:APPLIED']);
    expect(await svcState(a.accountId)).toMatchObject({ barLevel: 'HARD' });
    expect(await at(a, 31)).toEqual([]);
  });

  it('shows what is next without doing anything', async () => {
    const a = await billedAccount(db);
    await db.query('UPDATE invoices SET due_date=$2 WHERE id=$1', [a.invoiceId, addDays(T, -8)]);
    const v = await explainLadder(db, a.accountId, T, await listDunningRules(db, { activeOnly: true }));
    expect(v.rule?.code).toBe('consumer-standard-sg');
    expect([v.daysPastDue, v.steps.map((s) => s.state)]).toEqual([8, ['DUE', 'DUE', 'DUE', 'LATER', 'LATER', 'LATER', 'LATER']]);
    expect(v.steps[3]!.dueOn).toBe(addDays(addDays(T, -8), 14));
    expect((await svcState(a.accountId)).barLevel).toBe('NONE');
  });
});

describe('exclusions', () => {
  it('holds a bar while a billing dispute is open, and applies it once the dispute is closed', async () => {
    const a = await billedAccount(db);
    await at(a, 7);
    const dispute = await createCase(db, { customerId: a.customerId, issueTypeId: 'billing.dispute.amt', subject: 'Wrong amount' }, 'agent');
    const held = await at(a, 14);
    expect(held![0]).toMatchObject({ action: 'SOFT_BAR', status: 'HELD', reason: `Open billing dispute (${dispute.number})` });
    expect((await svcState(a.accountId)).barLevel).toBe('NONE');
    expect((await explainLadder(db, a.accountId, T)).steps.find((s) => s.action === 'SOFT_BAR')).toMatchObject({ state: 'HELD' });
    await transitionCase(db, dispute.id, 'IN_PROGRESS', { actor: 'a' }); await transitionCase(db, dispute.id, 'RESOLVED', { actor: 'a', resolution: 'Corrected the bill' });
    expect(names(await at(a, 14))).toEqual(['SOFT_BAR:APPLIED']);
    expect((await svcState(a.accountId)).barLevel).toBe('SOFT');
  });

  it('holds a bar while a payment arrangement is kept, and carries on when it is broken', async () => {
    const a = await billedAccount(db);
    await at(a, 7);
    const owed = Number((await db.query(`SELECT COALESCE(sum(total_minor - paid_minor),0) AS n FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE')`, [a.accountId])).rows[0]!.n);
    await expect(createArrangement(db, a.accountId, { installments: [{ dueDate: addDays(T, 5), amountMinor: 100 }] }, 'agent')).rejects.toThrow(/less than the/);
    const arr = await createArrangement(db, a.accountId, { installments: [{ dueDate: addDays(T, 3), amountMinor: Math.ceil(owed / 2) }, { dueDate: addDays(T, 10), amountMinor: Math.floor(owed / 2) + 1 }], reason: 'Salary delay' }, 'agent');
    await expect(createArrangement(db, a.accountId, { installments: [{ dueDate: addDays(T, 3), amountMinor: owed }] }, 'agent')).rejects.toThrow(/already has/);
    expect((await at(a, 14))![0]).toMatchObject({ action: 'SOFT_BAR', status: 'HELD', reason: 'A payment arrangement is being kept' });
    expect((await arrangementStatus(db, a.accountId, T)).kept).toBe(true);
    // the first instalment date and its grace go by with nothing paid
    const broken = await arrangementStatus(db, a.accountId, addDays(T, 6));
    expect([broken.state, broken.kept]).toEqual(['BROKEN', false]);
    expect((await db.query('SELECT status FROM payment_arrangements WHERE id=$1', [arr.id])).rows[0]!.status).toBe('BROKEN');
    expect(names(await at(a, 14))).toEqual(['SOFT_BAR:APPLIED']);
  });

  it('protects a VIP where a step says so, and waits for the account manager’s task before barring', async () => {
    await saveDunningRule(db, 'admin', { code: 'vip-guard', name: 'VIP guard', description: '', active: true, priority: 900, market: 'SG', customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial: null, steps: [
      { position: 0, name: 'Account task', enabled: true, trigger: { kind: 'DAYS_PAST_DUE', days: 2 }, action: 'CASE_TASK', params: { team: 'Account management', holdsLaterBars: true, waitDays: 5, dueHours: 24 }, exclusions: {} },
      { position: 1, name: 'Soft bar', enabled: true, trigger: { kind: 'DAYS_PAST_DUE', days: 4 }, action: 'SOFT_BAR', params: {}, exclusions: { vip: true } },
      { position: 2, name: 'Hard bar', enabled: true, trigger: { kind: 'DAYS_PAST_DUE', days: 6 }, action: 'HARD_BAR', params: {}, exclusions: {} },
    ] });
    const a = await billedAccount(db);
    await updateCustomer(db, a.customerId, { vip: true });
    const r = await at(a, 6);
    expect(r!.map((s) => `${s.name}:${s.status}`)).toEqual(['Account task:APPLIED', 'Soft bar:HELD', 'Hard bar:HELD']);
    expect(r![1]!.reason).toBe('VIP protection');
    expect(r![2]!.reason).toMatch(/Waiting for the account manager \(CS-/);
    const task = (await db.query(`SELECT * FROM cases WHERE customer_id=$1 AND issue_type_id='billing.collections.followup'`, [a.customerId])).rows[0]!;
    expect([task.team, task.status]).toEqual(['Account management', 'NEW']);
    await transitionCase(db, task.id, 'IN_PROGRESS', { actor: 'am' }); await transitionCase(db, task.id, 'RESOLVED', { actor: 'am', resolution: 'Spoke to the CFO' });
    expect(names(await at(a, 6))).toEqual(['SOFT_BAR:HELD', 'HARD_BAR:APPLIED']);                            // the task is done; the VIP still keeps the soft bar off
    await db.query(`UPDATE dunning_rules SET active=false WHERE code='vip-guard'`);
  });
});

describe('triggers by balance', () => {
  it('applies a step when the overdue balance reaches an amount (and its minimum days)', async () => {
    await saveDunningRule(db, 'admin', { code: 'big-debts', name: 'Big debts', description: '', active: true, priority: 950, market: 'SG', customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial: null, steps: [
      { position: 0, name: 'Large balance notice', enabled: true, trigger: { kind: 'BALANCE', balanceMinor: 1_000_000, minDays: 2 }, action: 'NOTIFY', params: { channels: ['EMAIL'], message: 'Dear {{name}}, {{balance}} is overdue.' }, exclusions: {} },
      { position: 1, name: 'Any balance bar', enabled: true, trigger: { kind: 'BALANCE', balanceMinor: 100, minDays: 5 }, action: 'SOFT_BAR', params: {}, exclusions: {} },
    ] });
    const a = await billedAccount(db);
    expect(await at(a, 3)).toEqual([]);                                                      // owes less than the threshold
    expect(names(await at(a, 5))).toEqual(['SOFT_BAR:APPLIED']);
    const n = (await outbox(a.accountId, 'DUNNING_NOTICE'));
    expect(n).toHaveLength(0);
    await db.query(`UPDATE dunning_rules SET active=false WHERE code='big-debts'`);
  });
});

describe('partial payments and restoring service', () => {
  it('a payment of 80% or more puts a hard-barred account back to a soft bar and pauses the ladder, which then picks up again', async () => {
    const a = await billedAccount(db);
    await at(a, 21);
    expect(await svcState(a.accountId)).toMatchObject({ status: 'SUSPENDED', barLevel: 'HARD' });
    const owed = Number((await db.query(`SELECT COALESCE(sum(total_minor - paid_minor),0) AS n FROM invoices WHERE account_id=$1 AND status='OVERDUE'`, [a.accountId])).rows[0]!.n);
    const below = Math.floor(owed * 0.5);
    await payInvoice(db, a.invoiceId, { amountMinor: below, method: 'CASH', reference: 'r1' }, 'cashier');
    expect(await svcState(a.accountId)).toMatchObject({ barLevel: 'HARD' });                  // under 80%: nothing changes
    const remaining = Number((await db.query(`SELECT COALESCE(sum(total_minor - paid_minor),0) AS n FROM invoices WHERE account_id=$1 AND status='OVERDUE'`, [a.accountId])).rows[0]!.n);
    await payInvoice(db, a.invoiceId, { amountMinor: Math.ceil(remaining * 0.9), method: 'CASH', reference: 'r2' }, 'cashier');
    expect(await svcState(a.accountId)).toMatchObject({ status: 'ACTIVE', barLevel: 'SOFT' });
    const run = (await db.query(`SELECT paused_until::text, resets FROM dunning_runs WHERE account_id=$1 AND status='ACTIVE'`, [a.accountId])).rows[0]!;
    expect([run.pausedUntil, run.resets]).toEqual([addDays(T, 7), 1]);
    expect((await outbox(a.accountId, 'PARTIAL_PAYMENT_RECEIVED'))[0]).toMatchObject({ action: 'RESET_TO_SOFT_BAR' });
    expect(await at(a, 25)).toEqual([]);                                                     // paused: no escalation
    await db.query(`UPDATE dunning_runs SET paused_until = $2 WHERE account_id=$1`, [a.accountId, addDays(T, -1)]);
    expect(names(await at(a, 25))).toEqual(['HARD_BAR:APPLIED']);                            // the pause is over: the bar applies again
    expect((await svcState(a.accountId)).barLevel).toBe('HARD');
  });

  it('paying everything restores service in the same transaction and queues the unbarring as urgent', async () => {
    const a = await billedAccount(db);
    await at(a, 21);
    await payInvoice(db, a.invoiceId, { method: 'CASH', reference: 'full' }, 'cashier');                                          // full balance
    await db.query(`UPDATE invoices SET status='PAID' WHERE account_id=$1 AND late_fee_run_id IS NOT NULL`, [a.accountId]);
    expect(await svcState(a.accountId)).toMatchObject({ status: 'ACTIVE', barLevel: 'NONE' });
    const restore = (await db.query(`SELECT payload, delivered_at FROM lifecycle_outbox WHERE account_id=$1 AND instruction='RESTORE'`, [a.accountId])).rows;
    expect(restore).toHaveLength(1);
    expect(restore[0]!.payload).toMatchObject({ bar: 'NONE', priority: 'URGENT' });
    expect((await db.query(`SELECT status FROM dunning_runs WHERE account_id=$1`, [a.accountId])).rows[0]!.status).toBe('PAID');
    expect((await outbox(a.accountId, 'PAYMENT_THANKS'))).toHaveLength(1);
  });

  it('a PAUSE policy leaves the bars as they are', async () => {
    const a = await billedAccount(db);
    await db.query(`UPDATE customers SET credit_risk='HIGH' WHERE id=$1`, [a.customerId]);
    const r = await at(a, 12);
    expect(r!.some((s) => s.action === 'HARD_BAR' && s.status === 'APPLIED')).toBe(true);     // the high-risk ladder is quick
    const owed = Number((await db.query(`SELECT COALESCE(sum(total_minor - paid_minor),0) AS n FROM invoices WHERE account_id=$1 AND status='OVERDUE'`, [a.accountId])).rows[0]!.n);
    await payInvoice(db, a.invoiceId, { amountMinor: Math.min(owed - 1, Math.max(1, owed)), method: 'CASH', reference: 'r3' }, 'cashier').catch(() => undefined);
    expect((await svcState(a.accountId)).barLevel).toBe('HARD');
  });
});

describe('runDunning with rules', () => {
  it('uses the rule that fits, and the Settings → Lifecycle ladder for a customer no rule fits', async () => {
    const a = await billedAccount(db);
    await db.query('UPDATE invoices SET due_date=$2 WHERE id=$1', [a.invoiceId, addDays(T, -8)]);
    const r = await runDunning(db, T);
    const mine = r.applied.filter((s) => s.accountId === a.accountId);
    expect(mine.map((s) => `${s.name}:${s.status}`)).toEqual(['Friendly reminder with QR payment:APPLIED', 'First notice, grace period over:APPLIED', 'Late payment charge:APPLIED']);
    // a customer in a market with no rule (Australia) gets the old ladder
    const b = await billedAccount(db);
    await db.query(`UPDATE customers SET market_code='AU' WHERE id=$1`, [b.customerId]);
    await db.query('UPDATE invoices SET due_date=$2 WHERE id=$1', [b.invoiceId, addDays(T, -8)]);
    const r2 = await runDunning(db, T);
    expect(r2.applied.filter((s) => s.accountId === b.accountId).map((s) => s.step)).toEqual(['REMIND', 'SOFT_BAR']);
    expect(r2.applied.find((s) => s.accountId === b.accountId)!.name).toBeUndefined();
  });
  it('recalls a placement and counts payments against placed debt as recovered', async () => {
    const a = await billedAccount(db);
    await db.query('UPDATE invoices SET due_date=$2 WHERE id=$1', [a.invoiceId, addDays(T, -2)]);
    await saveDunningRule(db, 'admin', { code: 'to-agency', name: 'To agency', description: '', active: true, priority: 990, market: 'SG', customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial: null, steps: [
      { position: 0, name: 'Place with the agency', enabled: true, trigger: { kind: 'DAYS_PAST_DUE', days: 1 }, action: 'COLLECTIONS_TRANSFER', params: {}, exclusions: {} }] });
    expect(names(await evaluateByRules(db, a.accountId, T))).toEqual(['COLLECTIONS_TRANSFER:APPLIED']);
    const p = (await listPlacements(db, { status: 'PLACED' })).find((x) => x.accountId === a.accountId)!;
    expect(Number(p.balanceMinor)).toBeGreaterThan(0);
    await payInvoice(db, a.invoiceId, { method: 'CASH', reference: 'full' }, 'cashier');
    expect((await db.query('SELECT status, recovered_minor FROM collection_placements WHERE id=$1', [p.id])).rows[0]).toMatchObject({ status: 'RECOVERED', recoveredMinor: Number(p.balanceMinor) });
    await expect(recallPlacement(db, p.id, 'ops', 'x')).rejects.toThrow(/not with the agency/);
    await db.query(`UPDATE dunning_rules SET active=false WHERE code='to-agency'`);
    expect((await getDunningPayments(db)).bureau).toBeTruthy();
  });
});
