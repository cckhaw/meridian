import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommissionCalculator, cleanPolicyDraft, cleanRuleDraft, cleanSlabs, clawbackBps, pickCommissionRule, pickPolicy, type Plan, type PlanRule, type Sale, type Seller } from './commission-calculator.js';
import { assignPlan, createPlan, deleteCommissionRule, deletePlan, dealerTree, listEntries, listPlans, loadPlan, previewCommission, saveClawbackPolicy, saveCommissionRule, setDealerChannel, uplinesOf } from './commission.js';
import { approveDue, approveEntries, closePeriod, clawBack, confirmPayoutBatch, createPayoutBatch, generateStatements, getStatement, listStatements, runCommissionDaily, statementCsv, sweepClawbacks } from './commission-processor.js';
import { addDays, today } from './dates.js';
import type { Db } from './db.js';
import { createAgent, createDealer } from './dealers.js';
import { terminateService } from './lifecycle.js';
import { placeOrder } from './orders.js';
import { reconcile } from './reports.js';
import { freshDb, newCustomer } from './test-helpers.js';

const rule = (o: Partial<PlanRule>): PlanRule => ({ id: 'r', name: 'r', priority: 100, matchKinds: [], matchOfferIds: [], minTermMonths: null, maxTermMonths: null, matchTiers: [], calc: 'PERCENT', rateBps: 500, fixedMinor: 0, slabMode: 'MARGINAL', slabs: [], status: 'ACTIVE', ...o });
const plan = (rules: PlanRule[], o: Partial<Plan> = {}): Plan => ({ id: 'p', name: 'p', holdDays: 0, overrideBps: [], rules, clawbacks: [], ...o });
const seller: Seller = { kind: 'DEALER', id: 'DLR-1', tier: 'DEALER', dealerId: 'DLR-1', uplines: [] };
const sale = (lines: Sale['lines']): Sale => ({ orderId: 'o1', completedOn: '2026-03-10', currency: 'SGD', lines });
const line = (o: Partial<Sale['lines'][number]> = {}): Sale['lines'][number] => ({ lineId: 'l1', offerId: 'plan-a', offerKind: 'PLAN', termMonths: 0, quantity: 1, basisMinor: 10_000, createsService: true, ...o });

describe('commission calculator', () => {
  const slabs = [{ from: 1, to: 50, rateBps: 500 }, { from: 51, to: 100, rateBps: 800 }, { from: 101, to: null, rateBps: 1200 }];
  it('pays each activation at the volume band its position falls in', () => {
    const p = plan([rule({ slabs })]);
    const at = (before: number, qty = 1) => CommissionCalculator.calculate(p, sale([line({ quantity: qty, basisMinor: 10_000 * qty })]), seller, () => before)[0]!;
    expect(at(0).amountMinor).toBe(500);
    expect(at(49).amountMinor).toBe(500);       // the 50th
    expect(at(50).amountMinor).toBe(800);       // the 51st
    expect(at(100).amountMinor).toBe(1200);     // the 101st
    const split = at(49, 3);                    // positions 50, 51, 52 straddle a band
    expect(split.amountMinor).toBe(500 + 800 + 800);
    expect((split.calc as any).segments).toHaveLength(2);
    expect(split.units).toBe(3);
  });
  it('lifts every activation to the reached band when the rule is retroactive, paying the difference at close', () => {
    const r = rule({ slabs, slabMode: 'RETROACTIVE' });
    const earnings = Array.from({ length: 60 }, () => ({ basisMinor: 10_000, units: 1 }));
    const t = CommissionCalculator.retroactiveTarget(r, earnings);
    expect(t.slab?.rateBps).toBe(800);
    expect(t.targetMinor).toBe(60 * 800);   // all 60 at 8%
    expect(CommissionCalculator.retroactiveTarget(rule({ slabs, slabMode: 'MARGINAL' }), earnings).targetMinor).toBe(0);
  });
  it('pays more for a 24-month device contract than a SIM-only plan, choosing the most specific rule', () => {
    const p = plan([rule({ id: 'any', name: 'Any', rateBps: 300 }), rule({ id: 'sim', name: 'SIM only', maxTermMonths: 0, rateBps: 500 }), rule({ id: 'long', name: '24+', minTermMonths: 24, rateBps: 1000 })]);
    expect(pickCommissionRule(p.rules, line({ termMonths: 0 }))?.id).toBe('sim');
    expect(pickCommissionRule(p.rules, line({ termMonths: 24 }))?.id).toBe('long');
    expect(pickCommissionRule(p.rules, line({ termMonths: 12 }))?.id).toBe('any');
    const byOffer = [...p.rules, rule({ id: 'one', name: 'One offer', matchOfferIds: ['plan-a'], rateBps: 1500 })];
    expect(pickCommissionRule(byOffer, line({ termMonths: 24 }))?.id).toBe('one');
    expect(pickCommissionRule([rule({ matchTiers: ['MASTER_DISTRIBUTOR'] })], line(), 'DEALER')).toBeNull();
    expect(pickCommissionRule([rule({ status: 'INACTIVE' })], line())).toBeNull();
  });
  it('pays a fixed amount per activation and splits the basis across units without losing a cent', () => {
    const e = CommissionCalculator.calculate(plan([rule({ calc: 'FIXED', rateBps: 0, fixedMinor: 2500 })]), sale([line({ quantity: 3, basisMinor: 10_000 })]), seller, () => 0)[0]!;
    expect(e.amountMinor).toBe(7500);
    const p = CommissionCalculator.calculate(plan([rule({ rateBps: 1000 })]), sale([line({ quantity: 3, basisMinor: 10_000 })]), seller, () => 0)[0]!;
    expect(p.amountMinor).toBe(Math.round(3333 * 0.1) + Math.round(3333 * 0.1) + Math.round(3334 * 0.1));
  });
  it('pays upline override commission by level', () => {
    const s: Seller = { ...seller, uplines: [{ dealerId: 'DLR-P', tier: 'MASTER_DISTRIBUTOR' }, { dealerId: 'DLR-G', tier: 'MASTER_DISTRIBUTOR' }] };
    const out = CommissionCalculator.calculate(plan([rule({ rateBps: 500 })], { overrideBps: [100, 50] }), sale([line()]), s, () => 0);
    expect(out.map((e) => [e.entryType, e.beneficiaryId, e.amountMinor])).toEqual([['EARNING', 'DLR-1', 500], ['OVERRIDE', 'DLR-P', 100], ['OVERRIDE', 'DLR-G', 50]]);
  });
  it('validates volume bands, rules and claw-back policies', () => {
    expect(() => cleanSlabs([{ from: 1, to: 50 }, { from: 40, to: 80 }])).toThrow(/overlap/);
    expect(() => cleanSlabs([{ from: 1, to: null }, { from: 10, to: 20 }])).toThrow(/last band/);
    expect(cleanSlabs([{ from: 51, to: 100, rateBps: 800 }, { from: 1, to: 50, rateBps: 500 }])[0]!.from).toBe(1);
    expect(() => cleanRuleDraft({ name: 'x', rateBps: 0 })).toThrow(/needs a rate/);
    expect(() => cleanRuleDraft({ name: 'x', rateBps: 100, minTermMonths: 24, maxTermMonths: 12 })).toThrow(/below the minimum/);
    expect(() => cleanRuleDraft({ name: 'x', rateBps: 100, matchTiers: ['KING'] })).toThrow(/unknown seller tier/);
    expect(() => cleanPolicyDraft({ name: 'x', tiers: [] })).toThrow(/claw-back windows/);
    expect(() => cleanPolicyDraft({ name: 'x', tiers: [{ withinDays: 30, percentBps: 10000 }], triggers: ['BAD'] })).toThrow(/unknown claw-back trigger/);
  });
  it('takes back the share of the window the service ended in, and nothing after it', () => {
    const pol = cleanPolicyDraft({ name: 'Churn', tiers: [{ withinDays: 90, percentBps: 5000 }, { withinDays: 30, percentBps: 10000 }] });
    const policy = { ...pol, id: 'x' };
    expect(clawbackBps(policy, 10)).toBe(10000);
    expect(clawbackBps(policy, 30)).toBe(10000);
    expect(clawbackBps(policy, 31)).toBe(5000);
    expect(clawbackBps(policy, 91)).toBe(0);
    const long = { ...policy, id: 'long', minTermMonths: 24, tiers: [{ withinDays: 180, percentBps: 10000 }] };
    expect(pickPolicy([policy, long], 'TERMINATION', 24)?.id).toBe('long');
    expect(pickPolicy([policy, long], 'TERMINATION', 12)?.id).toBe('x');
    expect(pickPolicy([{ ...policy, triggers: ['PORT_OUT'] }], 'TERMINATION', 0)).toBeNull();
  });
});

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const retail = { storeId: 'STORE-SG-001', salespersonId: 'agent-1' };
/** Edits a ledger row the way a test needs to age it; the guard trigger that stops anyone doing this in production is lifted for the statement only. */
const aged = async (sql: string, p: unknown[]) => { await db.query('ALTER TABLE agent_ledger_entries DISABLE TRIGGER agent_ledger_immutable'); try { await db.query(sql, p); } finally { await db.query('ALTER TABLE agent_ledger_entries ENABLE TRIGGER agent_ledger_immutable'); } };
const sum = async (sql: string, p: unknown[] = []) => Number((await db.query(sql, p)).rows[0]!.n);

describe('dealer channel hierarchy', () => {
  it('builds tiers, refuses loops and over-deep chains, and lists uplines nearest first', async () => {
    const mk = async (name: string) => (await createDealer(db, 'admin', { name })).id as string;
    const [a, b, c, d] = [await mk('Master'), await mk('Dealer'), await mk('Sub'), await mk('Franchise')];
    await setDealerChannel(db, 'admin', a, { tier: 'MASTER_DISTRIBUTOR' });
    await setDealerChannel(db, 'admin', b, { tier: 'DEALER', parentDealerId: a });
    await setDealerChannel(db, 'admin', c, { tier: 'SUB_DEALER', parentDealerId: b });
    await setDealerChannel(db, 'admin', d, { tier: 'FRANCHISE' });
    expect((await uplinesOf(db, c)).map((u) => [u.dealerId, u.tier])).toEqual([[b, 'DEALER'], [a, 'MASTER_DISTRIBUTOR']]);
    await expect(setDealerChannel(db, 'admin', a, { parentDealerId: c })).rejects.toThrow(/own sub-dealers/);
    await expect(setDealerChannel(db, 'admin', a, { parentDealerId: a })).rejects.toThrow(/own parent/);
    await expect(setDealerChannel(db, 'admin', a, { tier: 'KING' })).rejects.toThrow(/tier is one of/);
    const tree = await dealerTree(db);
    expect(tree.find((r) => r.id === c)!.depth).toBe(2);
    expect(tree.find((r) => r.id === a)!.depth).toBe(0);
  });
});

describe('earning, claw-back, settlement and payout', () => {
  it('a completed dealer order earns on the dealer plan, with override for the parent, and posts to the GL', async () => {
    const parent = (await createDealer(db, 'admin', { name: 'Parent Distribution' })).id as string;
    const child = (await createDealer(db, 'admin', { name: 'Child Dealer' })).id as string;
    await setDealerChannel(db, 'admin', parent, { tier: 'MASTER_DISTRIBUTOR', bankAccountName: 'Parent Distribution', bankAccountNo: '123456', bankCode: 'DBSSSGSG', sapVendorNo: 'V100' });
    await setDealerChannel(db, 'admin', child, { tier: 'SUB_DEALER', parentDealerId: parent, bankAccountName: 'Child', bankAccountNo: '777', bankCode: 'DBSSSGSG' });
    const agent = (await createAgent(db, 'admin', child, { name: 'Agent Lee' })).id as string;
    const p = await createPlan(db, 'finance', { name: 'Distributor plan', holdDays: 0, overrideBps: [100] });
    await saveCommissionRule(db, 'finance', p.id, null, { name: 'Device contracts', minTermMonths: 24, rateBps: 1000 });
    await saveCommissionRule(db, 'finance', p.id, null, { name: 'SIM only', maxTermMonths: 0, slabs: [{ from: 1, to: 1, rateBps: 400 }, { from: 2, to: null, rateBps: 600 }], rateBps: 400 });
    await saveClawbackPolicy(db, 'finance', p.id, null, { name: 'Early churn', tiers: [{ withinDays: 30, percentBps: 10000 }, { withinDays: 90, percentBps: 5000 }] });
    await assignPlan(db, 'finance', p.id, 'DEALER', parent); // the parent's plan covers its sub-dealers
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'DEALER', attribution: { dealerId: child, dealerAgentId: agent }, payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] });
    expect(o.state).toBe('COMPLETED');
    const entries = (await db.query(`SELECT * FROM agent_ledger_entries WHERE order_id=$1 ORDER BY id`, [o.id])).rows;
    const earning = entries.find((e) => e.entryType === 'EARNING')!;
    const override = entries.find((e) => e.entryType === 'OVERRIDE')!;
    expect(earning).toMatchObject({ beneficiaryKind: 'DEALER', beneficiaryId: child, dealerAgentId: agent, status: 'APPROVED', planId: p.id });
    expect(earning.calc.rule).toBe('SIM only');
    expect(override).toMatchObject({ beneficiaryId: parent, entryType: 'OVERRIDE' });
    expect(override.amountMinor).toBe(Math.round(earning.basisMinor * 0.01));
    // the earning is booked: expense against payable, in the same ledger SAP is fed from
    expect(await sum(`SELECT sum(credit_minor) AS n FROM gl_entries WHERE account_code='2300' AND source_type='COMMISSION'`)).toBe(earning.amountMinor + override.amountMinor);
    expect((await reconcile(db)).ok).toBe(true);
    // a second call for the same order earns nothing more
    expect(await sum(`SELECT count(*) AS n FROM agent_ledger_entries WHERE order_id=$1`, [o.id])).toBe(entries.length);
    // the ledger cannot be edited or deleted
    await expect(db.query('DELETE FROM agent_ledger_entries WHERE id=$1', [earning.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query('UPDATE agent_ledger_entries SET amount_minor=amount_minor+1 WHERE id=$1', [earning.id])).rejects.toThrow(/cannot be edited/);
    // what-if
    const pv = await previewCommission(db, { dealerId: child, offerKind: 'PLAN', termMonths: 24, quantity: 1, basisMinor: 10_000 });
    expect(pv.entries[0]!.amountMinor).toBe(1000);   // a 24-month device contract pays 10%, SIM-only 4%
  });

  it('claws commission back when the customer leaves inside the window: partly, then fully, never past the window', async () => {
    const dealer = (await createDealer(db, 'admin', { name: 'Churn Dealer' })).id as string;
    const agent = (await createAgent(db, 'admin', dealer, { name: 'A' })).id as string;
    await setDealerChannel(db, 'admin', dealer, { bankAccountName: 'Churn', bankAccountNo: '9', bankCode: 'B' });
    const p = await createPlan(db, 'finance', { name: 'Churn plan', holdDays: 5 });
    await saveCommissionRule(db, 'finance', p.id, null, { name: 'All', rateBps: 1000 });
    await saveClawbackPolicy(db, 'finance', p.id, null, { name: 'Churn', tiers: [{ withinDays: 30, percentBps: 10000 }, { withinDays: 90, percentBps: 5000 }] });
    await assignPlan(db, 'finance', p.id, 'DEALER', dealer);
    const place = async () => placeOrder(db, { customerId: (await newCustomer(db)).customer.id, channel: 'DEALER', attribution: { dealerId: dealer, dealerAgentId: agent }, payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const early = await place(), mid = await place(), late = await place();
    const earningOf = async (orderId: string) => (await db.query(`SELECT * FROM agent_ledger_entries WHERE order_id=$1 AND entry_type='EARNING'`, [orderId])).rows[0]!;
    expect((await earningOf(early.id)).status).toBe('PENDING'); // the plan holds it for 5 days
    const end = async (orderId: string, daysAfter: number) => {
      const s = (await db.query('SELECT id FROM services WHERE order_id=$1', [orderId])).rows[0]!;
      await aged(`UPDATE agent_ledger_entries SET earned_on = earned_on - $2::int WHERE order_id=$1 AND entry_type='EARNING'`, [orderId, daysAfter]); // as if the sale were that long ago
      await db.query(`UPDATE services SET activated_at = activated_at - ($2 || ' days')::interval WHERE id=$1`, [s.id, String(daysAfter)]);
      await terminateService(db, s.id, { reason: 'customer request' });
    };
    await end(early.id, 10);   // inside 30 days: all of it
    await end(mid.id, 60);     // inside 90: half
    await end(late.id, 120);   // past the window: none
    const e1 = await earningOf(early.id), e2 = await earningOf(mid.id), e3 = await earningOf(late.id);
    expect(e1.status).toBe('CLAWED_BACK');                      // unpaid and fully taken back: it never reaches a statement
    expect(e2.clawedMinor).toBe(Math.round(e2.amountMinor * 0.5));
    expect(e3.clawedMinor).toBe(0);
    const cb = (await db.query(`SELECT * FROM agent_ledger_entries WHERE entry_type='CLAWBACK' AND dealer_id=$1`, [dealer])).rows;
    expect(cb).toHaveLength(2);
    expect(cb.every((c) => c.amountMinor < 0 && c.reversesId != null)).toBe(true);
    // the GL carries the reversal, so payable equals what is still owed
    const owed = e2.amountMinor - e2.clawedMinor + e3.amountMinor;
    expect(await sum(`SELECT sum(credit_minor - debit_minor) AS n FROM gl_entries WHERE account_code='2300' AND source_id LIKE $1`, [`${dealer}:%`])).toBe(owed);
    // running the sweep afterwards finds nothing new, and a repeat claw-back changes nothing
    expect((await sweepClawbacks(db, today())).clawed).toBe(0);
    expect((await db.tx((q) => clawBack(q, { orderId: mid.id, trigger: 'TERMINATION', on: today() }))).entries).toBe(0);

    // after the hold, earnings are approved with their claw-backs, and a statement nets them
    await aged(`UPDATE agent_ledger_entries SET earned_on = earned_on - 10 WHERE dealer_id=$1`, [dealer]);
    expect(await db.tx((q) => approveDue(q, today()))).toBeGreaterThan(0);
    const per = today().slice(0, 7);
    const st = await generateStatements(db, per, 'finance');
    const mine = st.statements.find((s) => s.beneficiaryId === dealer)!;
    expect(mine.netMinor).toBe(owed);
    expect(mine.clawbackMinor).toBeLessThan(0);
    expect((await getStatement(db, mine.id)).entries.some((e: any) => e.entryType === 'CLAWBACK')).toBe(true);
    expect((await statementCsv(db, mine.id)).split('\r\n')[0]).toContain('Statement,Beneficiary');
  });

  it('month close pays the retroactive accelerator and the band bonus once, then statements, a payout file, and confirmation books it', async () => {
    const dealer = (await createDealer(db, 'admin', { name: 'Volume Dealer' })).id as string;
    const agent = (await createAgent(db, 'admin', dealer, { name: 'V' })).id as string;
    await setDealerChannel(db, 'admin', dealer, { bankAccountName: 'Volume Dealer Pte', bankAccountNo: '555', bankCode: 'OCBC', sapVendorNo: 'V555' });
    const p = await createPlan(db, 'finance', { name: 'Volume plan' });
    await saveCommissionRule(db, 'finance', p.id, null, { name: 'Volume', rateBps: 500, slabMode: 'RETROACTIVE', slabs: [{ from: 1, to: 1, rateBps: 500 }, { from: 2, to: null, rateBps: 800, bonusMinor: 5000 }] });
    await assignPlan(db, 'finance', p.id, 'DEALER', dealer);
    for (let i = 0; i < 3; i++) await placeOrder(db, { customerId: (await newCustomer(db)).customer.id, channel: 'DEALER', attribution: { dealerId: dealer, dealerAgentId: agent }, payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const earned = await sum(`SELECT sum(amount_minor) AS n FROM agent_ledger_entries WHERE dealer_id=$1 AND entry_type='EARNING'`, [dealer]);
    const basis = await sum(`SELECT sum(basis_minor) AS n FROM agent_ledger_entries WHERE dealer_id=$1 AND entry_type='EARNING'`, [dealer]);
    const per = today().slice(0, 7);
    const c1 = await closePeriod(db, per, 'finance');
    expect(c1.accelerators).toBeGreaterThanOrEqual(1);
    const acc = await sum(`SELECT sum(amount_minor) AS n FROM agent_ledger_entries WHERE dealer_id=$1 AND entry_type='ACCELERATOR'`, [dealer]);
    expect(earned + acc).toBeGreaterThanOrEqual(Math.round(basis * 0.08) - 2);   // every activation now at 8%
    expect(await sum(`SELECT sum(amount_minor) AS n FROM agent_ledger_entries WHERE dealer_id=$1 AND entry_type='BONUS'`, [dealer])).toBe(5000);
    const again = await closePeriod(db, per, 'finance');                             // closing twice pays nothing twice
    expect([again.accelerators, again.bonuses]).toEqual([0, 0]);
    const st = (await listStatements(db, { period: per, beneficiaryId: dealer }))[0]!;
    expect(st).toMatchObject({ payoutMethod: 'BANK', status: 'ISSUED' });
    expect(st.netMinor).toBe(earned + acc + 5000);

    const { batch, skipped } = await createPayoutBatch(db, { period: per, actor: 'finance' });
    expect(batch).not.toBeNull();
    expect(skipped.every((s) => /bank account/.test(s.reason))).toBe(true);
    const file = (await db.query('SELECT content FROM commission_payout_batches WHERE id=$1', [batch!.id])).rows[0]!.content as string;
    expect(file).toContain('OCBC');
    expect(file).toContain('V555');
    expect(file).toContain(st.statementNo);
    await expect(confirmPayoutBatch(db, batch!.id, 'finance')).resolves.toMatchObject({ status: 'PAID' });
    await expect(confirmPayoutBatch(db, batch!.id, 'finance')).rejects.toThrow(/already confirmed/);
    expect(await sum(`SELECT count(*) AS n FROM agent_ledger_entries WHERE dealer_id=$1 AND status <> 'PAID' AND status <> 'CLAWED_BACK'`, [dealer])).toBe(0);
    expect(await sum(`SELECT sum(debit_minor) AS n FROM gl_entries WHERE source_type='COMMISSION_PAYOUT' AND source_id=$1`, [st.statementNo])).toBe(st.netMinor);
    expect(await sum(`SELECT sum(credit_minor - debit_minor) AS n FROM gl_entries WHERE account_code='2300' AND source_id LIKE $1`, [`${dealer}:%`])).toBe(earned + acc + 5000);   // accrued; the payout is booked against it separately
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('house commission is tracked but never booked or paid; a negative balance carries forward', async () => {
    const p = await createPlan(db, 'finance', { name: 'Store plan' });
    await saveCommissionRule(db, 'finance', p.id, null, { name: 'All', rateBps: 200 });
    await assignPlan(db, 'finance', p.id, 'STORE', 'STORE-SG-002');
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-002' }, payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] });
    {
      const e = (await db.query(`SELECT * FROM agent_ledger_entries WHERE order_id=$1`, [o.id])).rows;
      expect(e.every((x) => x.beneficiaryKind === 'STORE')).toBe(true);
      expect(await sum(`SELECT count(*) AS n FROM gl_entries WHERE source_type='COMMISSION' AND source_id LIKE 'STORE-SG-002:%'`)).toBe(0);
    }
    // a beneficiary whose claw-backs exceed earnings gets no statement and the balance rolls on
    await db.query(`INSERT INTO agent_ledger_entries (beneficiary_kind, beneficiary_id, entry_type, status, amount_minor, currency, period, earned_on) VALUES ('DEALER','DLR-NEG','ADJUSTMENT','APPROVED',-500,'SGD','2020-01','2020-01-15')`);
    const r = await generateStatements(db, '2020-01', 'finance');
    expect(r.carriedForward.some((c) => c.beneficiaryId === 'DLR-NEG' && c.netMinor === -500)).toBe(true);
    expect(r.statements.some((s) => s.beneficiaryId === 'DLR-NEG')).toBe(false);
  });

  it('manual approval, plan management rules and the daily job', async () => {
    const p = await createPlan(db, 'finance', { name: 'Disposable' });
    const r = await saveCommissionRule(db, 'finance', p.id, null, { name: 'x', rateBps: 100 });
    expect((await loadPlan(db, p.id)).rules).toHaveLength(1);
    await deleteCommissionRule(db, 'finance', p.id, r.id);
    await deletePlan(db, 'finance', p.id);
    expect((await listPlans(db)).some((x) => x.id === p.id)).toBe(false);
    const used = (await listPlans(db)).find((x) => x.entries > 0)!;
    await expect(deletePlan(db, 'finance', used.id)).rejects.toThrow(/Switch it off/);
    await expect(assignPlan(db, 'finance', used.id, 'DEALER', 'DLR-NOPE')).rejects.toThrow();
    const pend = (await listEntries(db, { status: 'PENDING' })).items.map((e) => e.id as number);
    if (pend.length) expect(await db.tx((q) => approveEntries(q, 'finance', pend))).toBe(pend.length);
    const d = await runCommissionDaily(db, { asOf: addDays(today(), 1) });
    expect(d).toMatchObject({ closed: null });
    const first = `${addDays(today(), 40).slice(0, 7)}-01`;
    expect((await runCommissionDaily(db, { asOf: first, force: true })).closed?.period).toBe(addDays(first, -1).slice(0, 7));
  });
});
