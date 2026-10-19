import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COA_LIMITS, cleanRule, cleanRuleChecked, createCoaRule, updateCoaRule } from './coa.js';
import type { Db } from './db.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const ok = { name: 'Rule', sapAccount: '400100' };

describe('posting rule limits', () => {
  it('priority is COA_LIMITS.priorityMin to priorityMax, and a blank priority is the default', () => {
    expect(cleanRule(ok).priority).toBe(COA_LIMITS.priorityDefault);
    expect(cleanRule({ ...ok, priority: COA_LIMITS.priorityMin }).priority).toBe(1);
    expect(cleanRule({ ...ok, priority: COA_LIMITS.priorityMax }).priority).toBe(9999);
    for (const p of [0, -1, COA_LIMITS.priorityMax + 1, 1.5, Number.NaN]) expect(() => cleanRule({ ...ok, priority: p })).toThrow(/from 1 to 9999/);
  });
  it('refuses over-long names and codes instead of cutting them', () => {
    expect(() => cleanRule({ ...ok, name: 'x'.repeat(COA_LIMITS.nameMax + 1) })).toThrow(/2 to 80/);
    expect(() => cleanRule({ ...ok, name: 'x' })).toThrow(/2 to 80/);
    expect(cleanRule({ ...ok, name: 'x'.repeat(COA_LIMITS.nameMax) }).name).toHaveLength(80);
    expect(() => cleanRule({ ...ok, sapAccount: 'A'.repeat(COA_LIMITS.sapAccountMax + 1) })).toThrow(/up to 10/);
    expect(() => cleanRule({ ...ok, costCenter: 'A'.repeat(COA_LIMITS.costCenterMax + 1) })).toThrow(/cost centre is up to 10/);
    expect(() => cleanRule({ ...ok, profitCenter: 'A'.repeat(COA_LIMITS.profitCenterMax + 1) })).toThrow(/profit centre is up to 10/);
    expect(() => cleanRule({ ...ok, taxCode: 'A'.repeat(COA_LIMITS.taxCodeMax + 1) })).toThrow(/tax code is up to 4/);
    expect(() => cleanRule({ ...ok, matchEvent: 'A'.repeat(COA_LIMITS.eventMax + 1) })).toThrow(/event type is up to 40/);
    expect(() => cleanRule({ ...ok, status: 'PAUSED' as never })).toThrow(/active or inactive/);
    expect(() => cleanRule({ ...ok, costCenter: 5 as never })).toThrow(/must be text/);
  });
  it('says what it changed: capitals, spaces at the ends, a shortened note', () => {
    const { rule, adjustments } = cleanRuleChecked({ ...ok, name: ' Rule ', sapAccount: 'ab-1', taxCode: 'v1', note: 'n'.repeat(COA_LIMITS.noteMax + 25) });
    expect(rule).toMatchObject({ name: 'Rule', sapAccount: 'AB-1', taxCode: 'V1' });
    expect(rule.note).toHaveLength(COA_LIMITS.noteMax);
    const by = Object.fromEntries(adjustments.map((a) => [a.field + ':' + a.kind, a]));
    expect(by['note:SHORTENED']!.message).toBe('Note: only the first 200 characters were kept (25 dropped).');
    expect(by['sapAccount:UPPERCASED']).toMatchObject({ from: 'ab-1', to: 'AB-1', label: 'SAP G/L account' });
    expect(by['taxCode:UPPERCASED']).toBeTruthy();
    expect(by['name:TRIMMED']).toBeTruthy();
  });
  it('reports nothing when nothing was changed', () => {
    expect(cleanRuleChecked({ ...ok, note: 'n'.repeat(COA_LIMITS.noteMax), sapAccount: 'AB1', matchStream: 'ETC' }).adjustments).toEqual([]);
  });
  it('returns the adjustments when a rule is created or updated', async () => {
    const made = await createCoaRule(db, 'finance', { ...ok, matchAccount: '7777x', note: 'z'.repeat(300) });
    expect(made.note).toHaveLength(200);
    expect(made.matchAccount).toBe('7777X');
    expect(made.adjustments.map((a) => a.field).sort()).toEqual(['matchAccount', 'note']);
    const clean = await updateCoaRule(db, 'finance', made.id, { ...ok, matchAccount: '7777X', note: 'short' });
    expect(clean.adjustments).toEqual([]);
    await expect(createCoaRule(db, 'finance', { ...ok, priority: 0 })).rejects.toThrow(/from 1 to 9999/);
  });
});
