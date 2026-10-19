import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DUNNING_LIMIT_BOUNDS, DUNNING_LIMIT_DEFAULTS, DUNNING_LIMITS, dunningRulesOverLimits, getDunningLimits, setDunningLimits } from './dunning-limits.js';
import { dunningRuleProblems, getDunningRule, listDunningRules, saveDunningRule, setDunningRuleActive, type DunningRuleInput } from './dunning-rules.js';
import { buildEmvQr, isQrMerchantTag, qrMerchantProblem, QR_MERCHANT_TAG_MAX, QR_MERCHANT_TAG_MIN } from './emv-qr.js';
import { setDunningPayments } from './dunning-engine.js';
import type { Db } from './db.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const step = (i: number) => ({ position: i, name: `Soft ${i}`, enabled: true, trigger: { kind: 'DAYS_PAST_DUE' as const, days: i + 1 }, action: 'NOTIFY' as const, params: { channels: ['SMS' as const], template: 'FIRST_NOTICE' as const }, exclusions: {} });
const rule = (n: number, priority = 50, name = 'Limits rule'): DunningRuleInput => ({ code: name, name, description: '', active: true, priority, market: null, customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial: null, steps: Array.from({ length: n }, (_, i) => step(i)) });

describe('dunning limits', () => {
  it('start at the standard values, shared by the screen and the server', async () => {
    const l = await getDunningLimits(db);
    expect(l).toMatchObject({ maxSteps: 30, maxPriority: 1000, nameMax: DUNNING_LIMITS.nameMax, dayMax: 365, bounds: DUNNING_LIMIT_BOUNDS, defaults: DUNNING_LIMIT_DEFAULTS });
    expect(await dunningRuleProblems(db, rule(30, 1000))).toEqual([]);
    expect((await dunningRuleProblems(db, rule(31))).join()).toMatch(/at most 30 steps/);
    expect((await dunningRuleProblems(db, rule(1, 1001))).join()).toMatch(/from 0 to 1000/);
    expect((await dunningRuleProblems(db, rule(1, -1))).join()).toMatch(/from 0 to 1000/);
  });

  it('are enforced from the setting', async () => {
    await setDunningLimits(db, 'admin', { maxSteps: 40, maxPriority: 5000 });
    expect(await dunningRuleProblems(db, rule(40, 5000))).toEqual([]);
    expect((await dunningRuleProblems(db, rule(41))).join()).toMatch(/at most 40 steps/);
    expect((await dunningRuleProblems(db, rule(1, 5001))).join()).toMatch(/from 0 to 5000/);
    const saved = await saveDunningRule(db, 'admin', rule(35, 4000, 'Big'));
    expect(saved.steps).toHaveLength(35);
    expect((await getDunningLimits(db))).toMatchObject({ maxSteps: 40, maxPriority: 5000 });
  });

  it('refuse a setting outside its range, and leave the stored one alone', async () => {
    for (const bad of [{ maxSteps: 0 }, { maxSteps: 101 }, { maxSteps: 2.5 }, { maxPriority: 0 }, { maxPriority: 100_001 }, { maxPriority: Number.NaN }]) await expect(setDunningLimits(db, 'admin', bad)).rejects.toThrow(/whole number/);
    expect(await getDunningLimits(db)).toMatchObject({ maxSteps: 40, maxPriority: 5000 });
    const top = await setDunningLimits(db, 'admin', { maxSteps: DUNNING_LIMIT_BOUNDS.maxSteps.max, maxPriority: DUNNING_LIMIT_BOUNDS.maxPriority.max });
    expect(top).toMatchObject({ maxSteps: 100, maxPriority: 100_000 });
    await setDunningLimits(db, 'admin', { maxSteps: 1 });
    expect((await getDunningLimits(db)).maxSteps).toBe(1);
  });

  it('a stored value outside the range falls back to the standard value', async () => {
    await db.query(`UPDATE settings SET value='{"maxSteps":0,"maxPriority":"many"}' WHERE key='dunningLimits'`);
    expect(await getDunningLimits(db)).toMatchObject({ maxSteps: 30, maxPriority: 1000 });
  });

  it('lowering a limit leaves existing rules loading and viewable; saving one asks for a fix; switching off still works', async () => {
    await setDunningLimits(db, 'admin', { maxSteps: 40, maxPriority: 5000 });
    const big = (await listDunningRules(db)).find((r) => r.name === 'Big')!;
    const out = await setDunningLimits(db, 'admin', { maxSteps: 10, maxPriority: 100 });
    expect(out.rulesOverLimit.map((r) => r.name)).toContain('Big');
    expect(out.rulesOverLimit.find((r) => r.name === 'Big')!.reasons).toHaveLength(2);
    const still = await getDunningRule(db, big.id);
    expect(still.steps).toHaveLength(35);
    expect(still.priority).toBe(4000);
    expect((await listDunningRules(db)).find((r) => r.id === big.id)!.steps).toHaveLength(35);
    expect((await dunningRulesOverLimits(db)).some((r) => r.id === big.id)).toBe(true);
    // saving it unchanged is refused with a message that says what to fix
    await expect(saveDunningRule(db, 'admin', { ...still, steps: still.steps }, big.id)).rejects.toThrow(/at most 10 steps; this one has 35. Remove 25/);
    await expect(saveDunningRule(db, 'admin', { ...still, steps: still.steps.slice(0, 10) }, big.id)).rejects.toThrow(/from 0 to 100 \(this rule has 4000/);
    // switching it off does not need the fix
    expect((await setDunningRuleActive(db, 'admin', big.id, false)).active).toBe(false);
    // fixed: both under the limits, it saves
    const fixed = await saveDunningRule(db, 'admin', { ...still, active: false, priority: 100, steps: still.steps.slice(0, 10) }, big.id);
    expect(fixed.steps).toHaveLength(10);
    expect((await dunningRulesOverLimits(db)).some((r) => r.id === big.id)).toBe(false);
  });

  it('checks the fixed limits from the same definition', async () => {
    await setDunningLimits(db, 'admin', { maxSteps: 30, maxPriority: 1000 });
    const r = rule(1);
    r.steps[0]!.trigger = { kind: 'DAYS_PAST_DUE', days: DUNNING_LIMITS.dayMax + 1 };
    expect((await dunningRuleProblems(db, r)).join()).toContain(`0 to ${DUNNING_LIMITS.dayMax}`);
    expect((await dunningRuleProblems(db, { ...rule(1), description: 'x'.repeat(DUNNING_LIMITS.descriptionMax + 1) })).join()).toMatch(/description/);
    const t = rule(1);
    t.steps[0] = { ...t.steps[0]!, action: 'CASE_TASK', params: { dueHours: DUNNING_LIMITS.dueHoursMax + 1, waitDays: DUNNING_LIMITS.waitDaysMax + 1, holdsLaterBars: true } };
    const msg = (await dunningRuleProblems(db, t)).join();
    expect(msg).toContain(`1 to ${DUNNING_LIMITS.dueHoursMax.toLocaleString('en-US')} hours`);
    expect(msg).toContain(`1 to ${DUNNING_LIMITS.waitDaysMax} days`);
  });
});

describe('QR merchant account tags', () => {
  it('are 26 to 51, the EMV merchant account information range the code writes into', () => {
    expect([QR_MERCHANT_TAG_MIN, QR_MERCHANT_TAG_MAX]).toEqual([26, 51]);
    for (const t of ['26', '29', '40', '51']) expect(isQrMerchantTag(t)).toBe(true);
    for (const t of ['00', '01', '02', '25', '52', '63', '5', '051', 'ab']) expect(isQrMerchantTag(t)).toBe(false);
    const m = (tag: string) => ({ name: 'M', city: 'KL', accounts: { [tag]: '0014A' } });
    expect(qrMerchantProblem('DUITNOW', m('26'))).toBeNull();
    expect(qrMerchantProblem('DUITNOW', m('51'))).toBeNull();
    expect(qrMerchantProblem('DUITNOW', m('25'))).toMatch(/26 to 51/);
    expect(qrMerchantProblem('DUITNOW', m('02'))).toMatch(/26 to 51/);
    expect(qrMerchantProblem('DUITNOW', m('52'))).toMatch(/26 to 51/);
    expect(() => buildEmvQr({ scheme: 'DUITNOW', merchant: m('09'), currency: 'MYR' })).toThrow(/26 to 51/);
  });
  it('the setting refuses a tag outside the range', async () => {
    await expect(setDunningPayments(db, 'admin', { merchants: { QRIS: { name: 'M', city: 'J', accounts: { '10': '0014A' } } } })).rejects.toThrow(/26 to 51/);
    await expect(setDunningPayments(db, 'admin', { merchants: { QRIS: { name: 'M', city: 'J', accounts: { '51': '0014A' } } } })).resolves.toBeTruthy();
  });
});
