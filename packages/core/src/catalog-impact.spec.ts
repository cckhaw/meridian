import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, getNode } from './catalog.js';
import { cancelRelease, createRelease, stageChange, stageReprice } from './catalog-release.js';
import { deletePersona, listPersonas, releaseImpact, releaseWhatIf, savePersona } from './catalog-impact.js';
import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
const who = 'maker';
beforeAll(async () => { db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });

const basket = (offerId: string, extra: Record<string, unknown> = {}) => ({ channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId, ...extra }] }) as never;
const rel = (name: string) => createRelease(db, who, { name });
const monthly = (o: any) => o.prices.find((p: any) => p.type === 'RECURRING').amount.amountMinor as number;

describe('release impact: who is affected', () => {
  it('counts live services and in-flight orders on a retired offer and names what depends on it', async () => {
    const { customer } = await newCustomer(db);
    await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-12' }] } as never);
    await createNode(db, { level: 'OFFER', id: 'imp-needs', code: 'imp-needs', name: 'Needs the phone plan', path: '', parentId: 'grp-vas', status: 'ACTIVE', markets: [], kind: 'VAS', prices: [{ type: 'RECURRING', amount: { amountMinor: 500, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }], contract: { termMonths: 0 }, fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, requires: ['plan-phone-12'], excludes: [], salesChannels: [], variants: [], deals: [] } as never, 'seed');
    const r = await rel('Retire');
    await stageChange(db, who, r.id, { op: 'STATUS', nodeId: 'plan-phone-12', payload: { status: 'RETIRED' } } as never);
    const imp = await releaseImpact(db, r.id);
    const o = imp.offers.find((x) => x.id === 'plan-phone-12')!;
    expect(o.why).toContain('retired');
    expect(o.inFlightOrders).toBeGreaterThanOrEqual(1);
    expect(o.dependents).toContainEqual({ id: 'imp-needs', name: 'Needs the phone plan', via: 'requires' });
    expect(imp.cap).toBe(10_000);
    expect(imp.skipped).toBe(0);
    await cancelRelease(db, who, r.id);
  });

  it('does not list offers the release only adds, and counts nothing for an unsold offer', async () => {
    const r = await rel('Unsold edit');
    await stageChange(db, who, r.id, { op: 'UPDATE', nodeId: 'plan-sim-5g', payload: { patch: { description: 'x' } } } as never);
    const imp = await releaseImpact(db, r.id);
    expect(imp.offers.map((x) => [x.id, x.why, x.services, x.inFlightOrders])).toEqual([['plan-sim-5g', ['changed'], 0, 0]]);
    await cancelRelease(db, who, r.id);
  });
});

describe('sample baskets', () => {
  it('are saved, listed by name, unique, updated and deleted, and the basket is checked for shape', async () => {
    const p = await savePersona(db, who, { name: 'Student on 5G SIM', description: 'one line', basket: basket('plan-sim-5g') });
    expect((await listPersonas(db)).map((x) => x.name)).toContain('Student on 5G SIM');
    await expect(savePersona(db, who, { name: 'Student on 5G SIM', basket: basket('plan-sim-5g') })).rejects.toThrow(/already exists/);
    await expect(savePersona(db, who, { name: 'Empty', basket: { channel: 'SELF_SERVE', payment: { method: 'CASH' }, lines: [] } as never })).rejects.toThrow();
    const u = await savePersona(db, who, { name: 'Student 5G', basket: basket('plan-sim-5g', { quantity: 2 }) }, p.id);
    expect(u.name).toBe('Student 5G');
    await deletePersona(db, who, p.id);
    await expect(deletePersona(db, who, p.id)).rejects.toThrow(/not found/i);
    expect((await listPersonas(db)).map((x) => x.name)).not.toContain('Student 5G');
  });
});

describe('what-if: the price of sample baskets before and after a release', () => {
  it('prices with the real pricing on live and on the release state, shows the difference in minor units, and stores nothing', async () => {
    const live = (await getNode(db, 'plan-sim-5g')) as any;
    const persona = await savePersona(db, who, { name: 'whatif-5g', basket: basket('plan-sim-5g') });
    await savePersona(db, who, { name: 'whatif-other', basket: basket('plan-phone-12') });
    const newPrices = live.prices.map((p: any) => (p.type === 'RECURRING' ? { ...p, amount: { ...p.amount, amountMinor: p.amount.amountMinor + 700 } } : p));
    const r = await rel('Price up');
    await stageChange(db, who, r.id, { op: 'UPDATE', nodeId: 'plan-sim-5g', payload: { patch: { prices: newPrices } } } as never);
    const before = await db.query('SELECT (SELECT count(*) FROM audit_log) AS a, (SELECT count(*) FROM catalog_nodes) AS n');
    const { rows } = await releaseWhatIf(db, r.id, { personaIds: [persona.id] });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.changed).toBe(true);
    expect(row.delta!.monthlyPlanMinor).toBeGreaterThan(0);                     // tax-inclusive, so a little more than +700 is not possible: it is the gross of +700
    expect((row.after as any).monthlyPlanMinor - (row.before as any).monthlyPlanMinor).toBe(row.delta!.monthlyPlanMinor);
    expect(monthly(await getNode(db, 'plan-sim-5g'))).toBe(monthly(live));       // live is untouched
    const after = await db.query('SELECT (SELECT count(*) FROM audit_log) AS a, (SELECT count(*) FROM catalog_nodes) AS n');
    expect(after.rows[0]).toEqual(before.rows[0]);                               // nothing written
    const all = await releaseWhatIf(db, r.id);
    expect(all.rows.find((x) => x.name === 'whatif-other')!.changed).toBe(false); // a basket the release does not touch is the same
    await cancelRelease(db, who, r.id);
  });

  it('says why a basket cannot be priced after the release instead of a price, and prices ad-hoc baskets', async () => {
    const live = (await getNode(db, 'plan-phone-12')) as any;
    const r = await rel('Version');
    const res = await stageReprice(db, who, r.id, { offerId: 'plan-phone-12', prices: live.prices.map((p: any) => ({ ...p, amount: { ...p.amount, amountMinor: p.amount.amountMinor + 500 } })) });
    const { rows } = await releaseWhatIf(db, r.id, { personaIds: [], baskets: [{ name: 'old plan', basket: basket('plan-phone-12') }, { name: 'new plan', basket: basket(res.newId) }] });
    const old = rows.find((x) => x.name === 'old plan')!, nu = rows.find((x) => x.name === 'new plan')!;
    expect('error' in old.before).toBe(false);
    expect(old.after).toHaveProperty('error');                                  // retired by the release
    expect(old.delta).toBeUndefined();
    expect(nu.before).toHaveProperty('error');                                  // not live yet
    expect('error' in nu.after).toBe(false);
    await cancelRelease(db, who, r.id);
  });
});
