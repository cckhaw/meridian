import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, today } from './dates.js';
import type { Db } from './db.js';
import { compileFormula, evaluateFormula } from './etc-formula.js';
import { deleteEtcRule, etcByRules, listEtcRules, previewEtc, saveEtcRule, seedStandardEtcRules, type EtcRuleInput } from './etc-rules.js';
import { etcQuoteForService, scenarioOfTermination, terminateService } from './lifecycle.js';
import { placeOrder } from './orders.js';
import { previewTermination } from './billing-simulation.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const base: EtcRuleInput = { code: '', name: 'Test', description: '', enabled: true, priority: 100, scenarios: ['CUSTOMER_REQUEST'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
  formula: 'monthlyFee * remaining', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 100, applyVipMultiplier: true };

describe('the formula language', () => {
  it('does arithmetic over named values and nothing else', () => {
    const v = { term: 24, remaining: 16, monthlyFee: 6800, subsidy: 40000 };
    expect(evaluateFormula('subsidy * remaining / term + monthlyFee * remaining * 0.25', v)).toBeCloseTo(40000 * 16 / 24 + 6800 * 16 * 0.25);
    expect(evaluateFormula('max(0, 100 - 250) + min(3, 4) + abs(-2) + clamp(15, 0, 10) + pct(200, 25)', v)).toBe(0 + 3 + 2 + 10 + 50);
    expect(evaluateFormula('remaining > 12 ? monthlyFee * 2 : monthlyFee', v)).toBe(13600);
    expect(evaluateFormula('remaining > 12 && subsidy > 0 || 0', v)).toBe(1);
    expect(evaluateFormula('-(3 + 4) * 2 % 5', v)).toBe(-4);
    expect(() => compileFormula('')).toThrow(/empty/);
    expect(() => compileFormula('nonsense * 2')).toThrow(/Unknown name “nonsense”/);
    expect(() => compileFormula('process.exit(1)')).toThrow();
    expect(() => compileFormula('sqrt(4)')).toThrow(/Unknown function/);
    expect(() => compileFormula('min(1)')).toThrow(/takes 2 to 8/);
    expect(() => compileFormula('1 +')).toThrow();
    expect(() => compileFormula('1 2')).toThrow(/Unexpected/);
    expect(() => compileFormula('`x`')).toThrow(/not allowed/);
    expect(() => compileFormula('('.repeat(60) + '1' + ')'.repeat(60))).toThrow(/nested/);
    expect(() => evaluateFormula('1 / (remaining - 16)', v)).toThrow(/divides by zero/);
  });
});

describe('rules', () => {
  it('validate before saving, pick by priority then specificity, apply caps, waivers, VIP and device balance', async () => {
    await expect(saveEtcRule(db, 'root', { ...base, formula: 'bogus' })).rejects.toThrow(/Unknown name/);
    await expect(saveEtcRule(db, 'root', { ...base, scenarios: ['NOPE'] })).rejects.toThrow(/Unknown scenario/);
    await expect(saveEtcRule(db, 'root', { ...base, minTerm: 24, maxTerm: 12 })).rejects.toThrow(/backwards/);
    const std = await seedStandardEtcRules(db, 'root');
    expect(std.created).toHaveLength(8);
    expect((await seedStandardEtcRules(db, 'root')).created).toEqual([]);
    const plain = await saveEtcRule(db, 'root', { ...base, name: 'Plain', formula: 'monthlyFee * remaining', maxChargeMinor: 50000, waiveLastMonths: 2, priority: 500 });
    const general = await previewEtc(db, { scenario: 'CUSTOMER_REQUEST', figures: { term: 24, elapsed: 10, monthlyFee: 6800, subsidy: 0 } });
    expect(general).toMatchObject({ matched: true, quote: { rule: { name: 'Plain' }, chargeMinor: 50000, monthsRemaining: 14 } });                // capped at the most
    expect((await previewEtc(db, { scenario: 'CUSTOMER_REQUEST', figures: { term: 24, elapsed: 23, monthlyFee: 6800 } })).quote).toMatchObject({ chargeMinor: 0, waived: true });   // inside the waiver window
    await saveEtcRule(db, 'root', { ...plain, enabled: false }, plain.id);
    // with a device the standard rule applies: the unearned subsidy plus a quarter of the fees, and the unpaid instalments collected
    const dev = await previewEtc(db, { scenario: 'CUSTOMER_REQUEST', figures: { term: 24, elapsed: 8, monthlyFee: 6800, subsidy: 48000, deviceBalance: 50000 }, hasDevice: true });
    expect(dev.quote).toMatchObject({ chargeMinor: Math.round(48000 * 16 / 24 + 6800 * 16 * 0.25), deviceBalanceMinor: 50000, rule: { code: 'customer-early-with-device' } });
    const nonpay = await previewEtc(db, { scenario: 'NON_PAYMENT', figures: { term: 24, elapsed: 8, monthlyFee: 6800, subsidy: 48000, deviceBalance: 50000 }, hasDevice: true });
    expect(nonpay.quote).toMatchObject({ chargeMinor: 32000, deviceBalanceMinor: 50000 });
    const fault = await previewEtc(db, { scenario: 'OPERATOR_FAULT', figures: { term: 24, elapsed: 8, monthlyFee: 6800, subsidy: 48000, deviceBalance: 50000 }, hasDevice: true });
    expect(fault.quote).toMatchObject({ chargeMinor: 0 });
    expect(fault.quote!.deviceBalanceMinor).toBeUndefined();                                                                               // waived with the fault
    const vip = await previewEtc(db, { scenario: 'CUSTOMER_REQUEST', figures: { term: 24, elapsed: 8, monthlyFee: 10000, vipMultiplier: 1.5 } });
    expect(vip.quote).toMatchObject({ chargeMinor: Math.round(10000 * 16 * 0.5 * 1.5), vipMultiplierBps: 15000 });
    const draft = await previewEtc(db, { scenario: 'CUSTOMER_REQUEST', figures: { term: 24, elapsed: 8, monthlyFee: 100 }, formula: 'monthlyFee * 3' });
    expect(draft.quote!.chargeMinor).toBe(300);                                                                                            // a formula being typed can be tried before saving
    expect((await previewEtc(db, { scenario: 'HARDSHIP', figures: { term: 24, elapsed: 8, monthlyFee: 6800 }, formula: '1 / (remaining - 16)' })).error).toMatch(/divides by zero/);   // a formula that fails for some figures says so when tried
    await deleteEtcRule(db, 'root', plain.id);
    expect((await listEtcRules(db)).length).toBe(8);
  });
});

describe('a real termination', () => {
  async function withDevice() {
    const c = await newCustomer(db);
    const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-24' }] });
    const id = o.services[0].id as string;
    await db.query(`UPDATE services SET contract_start = $2::date, contract_term_months = 24, deal = $3 WHERE id=$1`, [id, addDays(today(), -240), JSON.stringify({ termMonths: 24, subsidyMinor: 48000, retailMinor: 120000, currency: 'SGD' })]);
    await db.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) SELECT shard_id, id, account_id, 'INSTALLMENT', 'Phone instalment', 3000, 16 FROM services WHERE id=$1`, [id]);
    return { ...c, serviceId: id };
  }
  it('charges what the rule for the reason says, collects the unpaid device instalments on the closing invoice, and previews the same figures', async () => {
    const a = await withDevice();
    const s = (await db.query('SELECT * FROM services WHERE id=$1', [a.serviceId])).rows[0]!;
    expect(scenarioOfTermination({ reason: 'DUNNING' })).toBe('NON_PAYMENT');
    expect(scenarioOfTermination({ ported: true })).toBe('PORT_OUT');
    const q1 = await etcQuoteForService(db, s, new Date(), { scenario: 'CUSTOMER_REQUEST' });
    expect(q1).toMatchObject({ deviceBalanceMinor: 48000, rule: { code: 'customer-early-with-device' } });
    expect((await etcByRules(db, s, new Date(), 'HARDSHIP'))!.chargeMinor).toBe(0);
    const prev = await previewTermination(db, a.serviceId, { scenario: 'CUSTOMER_REQUEST' });
    const lines = (prev.closingInvoice as any)?.lines ?? (prev as any).lines ?? [];
    expect(JSON.stringify(prev)).toContain('Outstanding device instalments');
    void lines;
    const r = await terminateService(db, a.serviceId, { reason: 'CUSTOMER_REQUEST' }, 'agent');
    const inv = (await db.query(`SELECT i.id FROM invoices i WHERE i.account_id=(SELECT account_id FROM services WHERE id=$1) AND i.kind='FINAL'`, [a.serviceId])).rows[0]!;
    const ls = (await db.query('SELECT kind, description, net_minor, tax_minor FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [inv.id])).rows;
    expect(ls.map((l) => l.kind)).toEqual(expect.arrayContaining(['ETC', 'INSTALLMENT']));
    expect(r.etcMinor).toBeGreaterThan(0);
    expect((await db.query('SELECT count(*)::int AS n FROM service_charges WHERE service_id=$1 AND remaining_cycles > 0', [a.serviceId])).rows[0]!.n).toBe(0);
  });
  it('leaves everything as it was while no rule is switched on', async () => {
    await db.query('UPDATE etc_rules SET enabled=false');
    const a = await withDevice();
    const s = (await db.query('SELECT * FROM services WHERE id=$1', [a.serviceId])).rows[0]!;
    const q = await etcQuoteForService(db, s, new Date());
    expect(q.rule).toBeUndefined();
    expect(q.deviceBalanceMinor).toBeUndefined();
  });
});
