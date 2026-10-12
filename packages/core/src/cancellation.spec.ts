import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, deleteRule, describeRule, getCancellationSettings, listRules, moveRule, resetRules, saveRule, setCancellationSettings, simulate, termsFor, validateCancellationRule, type CancellationRule } from './cancellation.js';
import type { Db } from './db.js';
import { advanceOrder, cancelOrder, getOrder, placeOrder, returnGoods, sweepOrders } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const DAY = 86_400_000;
const group = (o: any, kind: string) => o.groups.find((g: any) => g.kind === kind);
const rule = (id: string) => DEFAULT_RULES.find((r) => r.id === id)!;
const edit = (id: string, patch: Partial<CancellationRule>) => saveRule(db, 'admin', { ...rule(id), ...patch }, false);
const fibre = async (slotHours?: number, channel: 'SELF_SERVE' | 'TELESALES' = 'SELF_SERVE') => {
  const { customer } = await newCustomer(db);
  return placeOrder(db, { customerId: customer.id, channel, payment: { method: 'CASH', confirmed: true, reference: 'R' }, lines: [{ offerId: 'fiber-1g' }], ...(slotHours ? { installationSlot: new Date(Date.now() + slotHours * 3_600_000).toISOString() } : {}) });
};
const phone = async () => {
  const { customer } = await newCustomer(db);
  const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-24' }] });
  await advanceOrder(db, o.id, { type: 'ship' });
  return advanceOrder(db, o.id, { type: 'deliver' });
};

describe('the cancellation rule base', () => {
  it('installs the standard policy on first use and describes every rule in plain words', async () => {
    const rules = await listRules(db);
    expect(rules.map((r) => r.id).sort()).toEqual(DEFAULT_RULES.map((r) => r.id).sort());
    expect(await getCancellationSettings(db)).toEqual({ defaultAllow: false });
    expect(describeRule(rule('install-late'), 'SGD')).toBe('Before the technician is dispatched, less than 24 hours before the visit: it can be cancelled; SGD 50.00 is kept.');
    expect(describeRule(rule('goods-return-window'))).toBe('Once the goods are delivered, within 14 days of delivery: it can be returned for a full refund.');
    expect(describeRule(rule('install-auto-cancel'))).toBe('Before the technician is dispatched, after 21 days: it is cancelled automatically with a full refund.');
    expect(describeRule(rule('goods-shipped'))).toBe('Once the goods have shipped or once the goods are delivered: it cannot be cancelled.');
  });

  it('changing a rule changes behaviour immediately: a different fee and window for late installation cancels', async () => {
    const o = await fibre(36); // visit in 36 hours: free under the standard 24-hour window
    expect(group(o, 'INSTALL').feeMinor).toBe(0);
    await edit('install-late', { when: [{ fact: 'groupStatus', op: 'eq', value: 'PENDING' }, { fact: 'hoursToVisit', op: 'lt', value: 48 }], outcome: { allow: true, feeFixedMinor: 2000, feePercentBps: 1000 } });
    const again = await getOrder(db, o.id);
    expect(group(again, 'INSTALL').feeMinor).toBe(2000 + 500); // 20.00 plus 10% of the 50.00 paid
    const cancelled = await cancelOrder(db, o.id, 'x');
    expect(cancelled.refundedMinor).toBe(o.totalMinor - 2500);
    await resetRules(db, 'admin');
    expect(group(await fibre(36), 'INSTALL').feeMinor).toBe(0); // reset restores the standard policy
  });

  it('refuses everything no rule covers, unless the fallback is switched to allow', async () => {
    await edit('goods-before-shipping', { enabled: false });
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'good-phone-outright' }] });
    expect(group(o, 'GOODS').canCancel).toBe(false);
    expect(group(o, 'GOODS').why).toBe('No cancellation rule allows this.');
    await expect(cancelOrder(db, o.id, 'x')).rejects.toThrow(/No cancellation rule allows this/);
    await setCancellationSettings(db, 'admin', { defaultAllow: true });
    expect(group(await getOrder(db, o.id), 'GOODS').canCancel).toBe(true);
    await resetRules(db, 'admin');
    expect(await getCancellationSettings(db)).toEqual({ defaultAllow: false });
    expect(group(await getOrder(db, o.id), 'GOODS').canCancel).toBe(true);
  });

  it('asks for a supervisor when a rule says so, and different people can be treated differently', async () => {
    await saveRule(db, 'admin', { id: 'telesales-approval', name: 'Telesales fibre cancellations need approval', action: 'CANCEL', group: 'INSTALL', priority: 1, enabled: true, showInTerms: false,
      when: [{ fact: 'groupStatus', op: 'eq', value: 'PENDING' }, { fact: 'channel', op: 'eq', value: 'TELESALES' }], outcome: { allow: true, requiresOverride: true } }, true);
    const o = await fibre(undefined, 'TELESALES');
    expect(group(o, 'INSTALL')).toMatchObject({ canCancel: false, needsOverride: true, why: 'This needs a supervisor’s approval.' });
    await expect(cancelOrder(db, o.id, 'x')).rejects.toThrow(/supervisor/);
    const done = await cancelOrder(db, o.id, 'approved by the team lead', 'lead', { canOverride: true });
    expect(done.state).toBe('CANCELLED');
    // the same order placed through another channel is untouched by that rule
    expect(group(await fibre(), 'INSTALL').canCancel).toBe(true);

    await saveRule(db, 'admin', { id: 'customers-48h', name: 'Customers: no cancelling inside 48 hours of the visit', action: 'CANCEL', group: 'INSTALL', priority: 2, enabled: true, showInTerms: false,
      when: [{ fact: 'initiatedBy', op: 'eq', value: 'CUSTOMER' }, { fact: 'hoursToVisit', op: 'lt', value: 48 }], outcome: { allow: false } }, true);
    const s = await fibre(30);
    await expect(cancelOrder(db, s.id, 'x', 'cust', { initiatedBy: 'CUSTOMER' })).rejects.toThrow(/cannot be cancelled/);
    expect((await cancelOrder(db, s.id, 'staff did it', 'agent', { initiatedBy: 'STAFF' })).state).toBe('CANCELLED');
    await deleteRule(db, 'admin', 'telesales-approval'); await deleteRule(db, 'admin', 'customers-48h');
  });

  it('prices returns by the condition of the goods and caps the damage deduction', async () => {
    await saveRule(db, 'admin', { id: 'goods-return-damaged', name: 'Damaged returns: 70% refund', action: 'RETURN', group: 'GOODS', priority: 1, enabled: true, showInTerms: true,
      when: [{ fact: 'groupStatus', op: 'eq', value: 'DONE' }, { fact: 'returnCondition', op: 'eq', value: 'DAMAGED' }, { fact: 'daysSinceDelivered', op: 'lte', value: 14 }], outcome: { allow: true, refundBps: 7000, maxDeductionBps: 1000 } }, true);
    const a = await phone();
    const paid = a.lines[0].paidNowMinor;
    await expect(returnGoods(db, a.id, { reason: 'cracked', condition: 'DAMAGED', deductionMinor: Math.floor(paid * 0.2) })).rejects.toThrow(/deduction.*at most/);
    const r = await returnGoods(db, a.id, { reason: 'cracked', condition: 'DAMAGED', deductionMinor: Math.floor(paid * 0.1) });
    expect(group(r, 'GOODS').refundedMinor).toBe(Math.floor(paid * 0.7) - Math.floor(paid * 0.1)); // 70% back, less the 10% deduction
    const b = await phone();
    const good = await returnGoods(db, b.id, { reason: 'changed mind', condition: 'GOOD' });
    expect(group(good, 'GOODS').refundedMinor).toBe(paid); // the standard window refunds everything for goods in good condition
    await deleteRule(db, 'admin', 'goods-return-damaged');
  });

  it('runs the automatic rules from the rule base: new thresholds change what the sweep does', async () => {
    const o = await fibre();
    await edit('install-auto-cancel', { when: [{ fact: 'groupStatus', op: 'eq', value: 'PENDING' }, { fact: 'daysOpen', op: 'gte', value: 5 }], outcome: { allow: true, refundBps: 9000 } });
    expect((await sweepOrders(db, new Date(Date.now() + 4 * DAY))).cancelled).toBe(0);
    const swept = await sweepOrders(db, new Date(Date.now() + 6 * DAY));
    expect(swept.cancelled).toBeGreaterThanOrEqual(1);
    const c = await getOrder(db, o.id);
    expect(c.state).toBe('CANCELLED');
    expect(c.refundedMinor).toBe(o.totalMinor - Math.floor(o.totalMinor * 0.1)); // this rule refunds 90%
    await resetRules(db, 'admin');
    expect((await sweepOrders(db, new Date(Date.now() + 6 * DAY))).cancelled).toBe(0);
  });

  it('keeps order precedence under the editor’s control, and writes the terms customers see from the rules in force', async () => {
    const before = await termsFor(db, ['INSTALL'], 'SGD');
    expect(before[0]!.text).toMatch(/less than 24 hours before the visit.*SGD 50\.00 is kept/);
    await moveRule(db, 'admin', 'install-free', 'up'); // free cancellation now outranks the late-fee rule: the fee never applies
    expect(group(await fibre(2), 'INSTALL').feeMinor).toBe(0);
    await moveRule(db, 'admin', 'install-free', 'down');
    expect(group(await fibre(2), 'INSTALL').feeMinor).toBe(5000);
    await edit('install-late', { enabled: false });
    expect((await termsFor(db, ['INSTALL'], 'SGD'))[0]!.text).not.toMatch(/kept/);
    await edit('install-late', { message: 'A call-out fee applies when you cancel close to the visit.', enabled: true });
    expect((await termsFor(db, ['INSTALL'], 'SGD'))[0]!.text).toContain('A call-out fee applies when you cancel close to the visit.');
    await resetRules(db, 'admin');
  });

  it('rejects rules that make no sense', () => {
    const base = { ...rule('install-late') };
    expect(validateCancellationRule(base)).toEqual([]);
    expect(validateCancellationRule({ ...base, id: 'Bad Id' }).join()).toMatch(/lowercase/);
    expect(validateCancellationRule({ ...base, when: [{ fact: 'hoursToVisit', op: 'in', value: ['a'] }] }).join()).toMatch(/cannot be compared/);
    expect(validateCancellationRule({ ...base, when: [{ fact: 'bogus' as never, op: 'eq', value: 1 }] }).join()).toMatch(/unknown condition/);
    expect(validateCancellationRule({ ...base, when: [{ fact: 'groupStatus', op: 'eq', value: 'NOPE' }] }).join()).toMatch(/not a valid/);
    expect(validateCancellationRule({ ...base, outcome: { allow: false, feeFixedMinor: 100 } }).join()).toMatch(/refuses cannot also charge/);
    expect(validateCancellationRule({ ...base, outcome: { allow: true, refundBps: 20_000 } }).join()).toMatch(/between 0% and 100%/);
    expect(validateCancellationRule({ ...base, outcome: { allow: true, feeMinMinor: 10, feeMaxMinor: 5 } }).join()).toMatch(/minimum fee/);
  });

  it('simulates a situation and shows which rule decided and why the earlier ones did not', async () => {
    const r = await simulate(db, { action: 'CANCEL', group: 'INSTALL', facts: { groupStatus: 'PENDING', hoursToVisit: 6 }, paidMinor: 20_000, currency: 'SGD' });
    expect(r.decision).toMatchObject({ allow: true, rule: { id: 'install-late' }, retainedMinor: 5000, refundMinor: 15_000 });
    expect(r.trace.find((t) => t.id === 'goods-before-shipping')!.reason).toBe('applies to a different part');
    expect(r.trace.find((t) => t.id === 'install-late')!.matched).toBe(true);
    const far = await simulate(db, { action: 'CANCEL', group: 'INSTALL', facts: { groupStatus: 'PENDING', hoursToVisit: 90 }, paidMinor: 20_000 });
    expect(far.decision.rule!.id).toBe('install-free');
    expect(far.trace.find((t) => t.id === 'install-late')!.reason).toMatch(/condition not met: less than 24 hours before the visit/);
    const none = await simulate(db, { action: 'CANCEL', group: 'INSTALL', facts: { groupStatus: 'DONE' }, paidMinor: 0 });
    expect(none.decision.allow).toBe(false);
  });
});
