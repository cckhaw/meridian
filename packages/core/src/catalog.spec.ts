import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogTree, checkDependencies, createNode, deleteNode, getNode, listNodes, moveNode, nodeUsage, reorderNode, updateNode, type NodeInput } from './catalog.js';
import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
const sgd = (n: number) => ({ amountMinor: n, currency: 'SGD' as const });
const base = { status: 'ACTIVE' as const, markets: ['SG'] };
const offer = (id: string, parentId: string, over: Partial<NodeInput> = {}): NodeInput => ({
  ...base, id, level: 'OFFER', code: id, name: id, path: '', parentId, kind: 'VAS', prices: [{ type: 'RECURRING', amount: sgd(500), periodMonths: 1, taxInclusive: true }],
  contract: { termMonths: 0 }, fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, characteristics: {}, requires: [], excludes: [], ...over,
} as NodeInput);

describe('prerequisites ("a phone before its insurance")', () => {
  beforeAll(async () => {
    await createNode(db, { ...base, id: 'grp-insurance', level: 'GROUP', code: 'grp-insurance', name: 'Insurance', path: '', parentId: 'mobile-postpaid' } as NodeInput);
    // Device care needs ANY offer in the device group.
    await createNode(db, offer('device-care', 'grp-insurance', { name: 'Device Care', requires: ['grp-device'] }));
  });

  it('is refused on its own, and accepted alongside a phone in the same order', async () => {
    const { customer } = await newCustomer(db);
    const alone = placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'device-care' }] });
    await expect(alone).rejects.toThrow(/Device Care requires any .* offer.*same order or own one already/);
    const together = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-24' }, { offerId: 'device-care' }] });
    expect(together.state).toBe('COMPLETED');
  });

  it('is satisfied by something the customer already owns', async () => {
    const { customer } = await newCustomer(db);
    expect(await checkDependencies(db, customer.id, ['device-care'])).toHaveLength(1);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-12' }] });
    expect(await checkDependencies(db, customer.id, ['device-care'])).toEqual([]);
    const later = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'device-care' }] });
    expect(later.state).toBe('COMPLETED');
  });

  it('counts a completed purchase of a physical good as owning it', async () => {
    await createNode(db, offer('screen-cover', 'grp-electronics', { name: 'Screen cover', kind: 'PHYSICAL_GOOD', prices: [{ type: 'ONE_TIME', amount: sgd(1500), taxInclusive: true }], requires: ['good-phone-outright'],
      fulfilment: { requiresShipping: true, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] } }));
    const { customer } = await newCustomer(db);
    expect(await checkDependencies(db, customer.id, ['screen-cover'])).toHaveLength(1);
    const phone = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'good-phone-outright' }] });
    expect(phone.state).toBe('COMPLETED');
    expect(await checkDependencies(db, customer.id, ['screen-cover'])).toEqual([]);
  });

  it('a terminated service no longer satisfies it', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-12' }] });
    await db.query(`UPDATE services SET status='TERMINATED' WHERE order_id=$1`, [o.id]);
    await db.query(`UPDATE orders SET state='CANCELLED' WHERE id=$1`, [o.id]);
    expect(await checkDependencies(db, customer.id, ['device-care'])).toHaveLength(1);
  });

  it('rejects unknown references, self references, circular chains and requiring-and-excluding', async () => {
    await expect(createNode(db, offer('bad-1', 'grp-insurance', { requires: ['nope'] }))).rejects.toThrow(/unknown/);
    await expect(createNode(db, offer('bad-2', 'grp-insurance', { requires: ['grp-insurance'] }))).rejects.toThrow(/require itself/);
    await expect(createNode(db, offer('bad-3', 'grp-insurance', { requires: ['plan-sim-5g'], excludes: ['plan-sim-5g'] }))).rejects.toThrow('invalid offer');
    await expect(createNode(db, offer('bad-3b', 'grp-insurance', { requires: ['grp-sim-only'], excludes: ['plan-sim-5g'] }))).rejects.toThrow(/both required and excluded/); // via a group
    await expect(createNode(db, offer('bad-4', 'grp-insurance', { excludes: ['grp-device'] }))).rejects.toThrow(/must list offers/);
    await createNode(db, offer('chain-a', 'grp-insurance'));
    await createNode(db, offer('chain-b', 'grp-insurance', { requires: ['chain-a'] }));
    await expect(updateNode(db, 'chain-a', { requires: ['chain-b'] })).rejects.toThrow(/circular dependency: chain-a → chain-b → chain-a/);
    await expect(updateNode(db, 'chain-a', { requires: ['grp-insurance'] })).rejects.toThrow(/require itself/);
  });

  it('enforces conflicts and per-channel sales', async () => {
    await createNode(db, offer('limited', 'grp-insurance', { excludes: ['vas-roaming'], salesChannels: ['SELF_SERVE'] }));
    const { customer } = await newCustomer(db);
    await expect(placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CASH' }, lines: [{ offerId: 'limited' }, { offerId: 'vas-roaming' }] })).rejects.toThrow(/cannot be combined/);
    await expect(placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'limited' }] })).rejects.toThrow(/not sold through this channel/);
    expect((await listNodes(db, { level: 'OFFER', channel: 'RETAIL_ASSISTED' })).some((o) => o.id === 'limited')).toBe(false);
    expect((await listNodes(db, { level: 'OFFER', channel: 'SELF_SERVE' })).some((o) => o.id === 'limited')).toBe(true);
    expect((await listNodes(db, { level: 'OFFER', channel: 'SELF_SERVE' })).some((o) => o.id === 'plan-sim-5g')).toBe(true); // no channel list = sold everywhere
  });
});

describe('editing the hierarchy', () => {
  it('renames at every level and edits an unsold offer fully', async () => {
    expect((await updateNode(db, 'mobile', { name: 'Mobile services' })).name).toBe('Mobile services');
    expect((await updateNode(db, 'grp-sim-only', { name: 'SIM-only plans' })).name).toBe('SIM-only plans');
    await createNode(db, offer('editable', 'grp-vas', { name: 'Editable' }));
    const e = await updateNode(db, 'editable', { name: 'Edited', description: 'now with text', prices: [{ type: 'RECURRING', amount: sgd(999), periodMonths: 1, taxInclusive: true }], salesChannels: ['TELESALES'] });
    expect(e).toMatchObject({ name: 'Edited', description: 'now with text', salesChannels: ['TELESALES'] });
    expect((e as any).prices[0].amount.amountMinor).toBe(999);
    expect(e.version).toBeGreaterThan(1);
  });

  it('protects subscribers: a sold offer’s price cannot change in place, but its text and dependencies can', async () => {
    const { customer } = await newCustomer(db);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'netflix-premium' }] });
    expect((await nodeUsage(db, 'netflix-premium')).services).toBeGreaterThan(0);
    await expect(updateNode(db, 'netflix-premium', { prices: [{ type: 'RECURRING', amount: sgd(100), periodMonths: 1, taxInclusive: true }] })).rejects.toThrow(/already sold.*new version/);
    await expect(updateNode(db, 'netflix-premium', { kind: 'VAS' })).rejects.toThrow(/already sold/);
    const ok = await updateNode(db, 'netflix-premium', { description: 'HD streaming', requires: ['plan-sim-5g'] });
    expect((ok as any).description).toBe('HD streaming');
    const same = await getNode(db, 'netflix-premium');
    await updateNode(db, 'netflix-premium', { prices: (same as any).prices });   // resubmitting unchanged prices is fine
    await updateNode(db, 'netflix-premium', { requires: [] });
  });

  it('moves a group with everything beneath it and rewrites the paths', async () => {
    await createNode(db, { ...base, id: 'extras', level: 'CATEGORY', code: 'extras', name: 'Extras', path: '', parentId: 'iot' } as NodeInput);
    const before = await getNode(db, 'watch-lte');
    expect(before.path).toBe('mobile/mobile-wearables/grp-wearable/watch-lte');
    await moveNode(db, 'grp-wearable', 'extras');
    expect((await getNode(db, 'grp-wearable')).path).toBe('iot/extras/grp-wearable');
    expect((await getNode(db, 'watch-lte')).path).toBe('iot/extras/grp-wearable/watch-lte');
    expect((await getNode(db, 'watch-lte')).parentId).toBe('grp-wearable');
    await expect(moveNode(db, 'grp-wearable', 'mobile')).rejects.toThrow(/parent must be CATEGORY/);          // wrong level
    await expect(moveNode(db, 'mobile', 'mobile')).rejects.toThrow(/root|itself|NETWORK_TYPE/);
    await expect(moveNode(db, 'extras', 'extras')).rejects.toThrow();
    await moveNode(db, 'watch-lte', 'grp-vas');                                                                  // an offer to another group
    expect((await getNode(db, 'watch-lte')).path).toBe('mobile/mobile-postpaid/grp-vas/watch-lte');
  });

  it('refuses to move a node under its own descendant', async () => {
    await expect(moveNode(db, 'mobile', 'grp-vas')).rejects.toThrow();
  });

  it('reorders siblings', async () => {
    const names = async () => (await catalogTree(db)).find((n) => n.id === 'none')!.children.map((c) => c.id);
    const first = await names();
    await reorderNode(db, first[1]!, 'up');
    expect((await names())[0]).toBe(first[1]);
    await reorderNode(db, first[1]!, 'down');
    expect(await names()).toEqual(first);
    await reorderNode(db, first[0]!, 'up');                                  // already first: no-op
    expect(await names()).toEqual(first);
  });

  it('deletes only what is empty, never sold and unreferenced', async () => {
    await expect(deleteNode(db, 'grp-device')).rejects.toThrow(/still contains/);
    await expect(deleteNode(db, 'netflix-premium')).rejects.toThrow(/has been sold/);
    await createNode(db, offer('temp-offer', 'grp-vas'));
    await createNode(db, offer('needs-temp', 'grp-vas', { requires: ['temp-offer'] }));
    await expect(deleteNode(db, 'temp-offer')).rejects.toThrow(/dependency by: needs-temp/);
    await deleteNode(db, 'needs-temp');
    await deleteNode(db, 'temp-offer');
    await expect(getNode(db, 'temp-offer')).rejects.toThrow(/not found/);
  });

  it('builds a nested tree with counts and usage', async () => {
    const tree = await catalogTree(db);
    expect(tree.map((n) => n.level)).toEqual(Array(tree.length).fill('NETWORK_TYPE'));
    const mobile = tree.find((n) => n.id === 'mobile')!;
    expect(mobile.children.every((c) => c.level === 'CATEGORY')).toBe(true);
    expect(mobile.offerCount).toBeGreaterThan(3);
    expect(mobile.activeOfferCount).toBeLessThanOrEqual(mobile.offerCount);
    const flat = (n: any): any[] => [n, ...n.children.flatMap(flat)];
    expect(flat(mobile).find((n) => n.id === 'plan-sim-5g').usage).toEqual({ services: expect.any(Number), orders: expect.any(Number) });
  });
});
