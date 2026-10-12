import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogTree, checkDependencies, copyLineItems, createNode, deleteNode, getNode, listNodes, moveNode, nodeUsage, reorderNode, setStatus, updateNode, type NodeInput } from './catalog.js';
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
  // The starter catalog ships grp-insurance and device-care (requires any offer in grp-device).

  it('is refused on its own, and accepted alongside a phone in the same order', async () => {
    const { customer } = await newCustomer(db);
    const alone = placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'device-care' }] });
    await expect(alone).rejects.toThrow(/Device Care.* requires any .* offer.*same order or own one already/);
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


describe('offer line items', () => {
  const item = (id: string, parentId: string, over: Record<string, unknown> = {}) => ({
    ...base, id, level: 'LINE_ITEM', code: id, name: id, path: '', parentId, itemType: 'DATA', quantity: 10, unit: 'GB', ...over,
  } as unknown as NodeInput);

  it('sits under an offer, derives its path, and is validated', async () => {
    const li = await createNode(db, item('plan-sim-5g-extra', 'plan-sim-5g', { name: 'Bonus data', quantity: 5 }));
    expect(li.path).toBe(`${(await getNode(db, 'plan-sim-5g')).path}/plan-sim-5g-extra`);
    expect(li).toMatchObject({ level: 'LINE_ITEM', itemType: 'DATA', quantity: 5, unit: 'GB' });
    await expect(createNode(db, item('bad-parent', 'grp-sim-only'))).rejects.toThrow(/parent must be OFFER/);
    await expect(createNode(db, item('bad-type', 'plan-sim-5g', { itemType: 'MAGIC' }))).rejects.toThrow(/kind of line item/);
    await expect(createNode(db, item('bad-qty', 'plan-sim-5g', { quantity: 0 }))).rejects.toThrow(/whole number/);
    await expect(createNode(db, item('bad-unl', 'plan-sim-5g', { unlimited: true, quantity: 5 }))).rejects.toThrow(/no quantity/);
    await expect(createNode(db, item('bad-sku', 'plan-sim-5g', { sku: 'a b' }))).rejects.toThrow(/SKU/);
    // an offer cannot be placed under a line item, and a line item is never a prerequisite
    await expect(createNode(db, offer('nested', 'plan-sim-5g-extra'))).rejects.toThrow(/parent must be GROUP/);
    await expect(createNode(db, offer('needs-item', 'grp-vas', { requires: ['plan-sim-5g-extra'] }))).rejects.toThrow(/line item cannot be a prerequisite/);
  });

  it('edits, reorders, moves between offers and rolls up under the tree without being counted as offers', async () => {
    await updateNode(db, 'plan-sim-5g-extra', { quantity: 8, unlimited: false, name: 'Bonus data 8' });
    expect(await getNode(db, 'plan-sim-5g-extra')).toMatchObject({ name: 'Bonus data 8', quantity: 8 });
    await updateNode(db, 'plan-sim-5g-extra', { unlimited: true });
    expect(await getNode(db, 'plan-sim-5g-extra')).toMatchObject({ unlimited: true, quantity: undefined });
    await reorderNode(db, 'plan-sim-5g-extra', 'up');
    const moved = await moveNode(db, 'plan-sim-5g-extra', 'plan-phone-12');
    expect(moved.path.endsWith('/plan-phone-12/plan-sim-5g-extra')).toBe(true);
    await expect(moveNode(db, 'plan-sim-5g-extra', 'grp-device')).rejects.toThrow(/parent must be OFFER/);
    const tree = await catalogTree(db);
    const find = (nodes: any[], id: string): any => { for (const n of nodes) { if (n.id === id) return n; const r = find(n.children, id); if (r) return r; } };
    expect(find(tree, 'plan-phone-12').children.map((c: any) => c.level)).toContain('LINE_ITEM');
    expect(find(tree, 'grp-device').offerCount).toBe(3); // line items are not offers
  });

  it('is deleted with an unsold offer, but blocks deleting a sold one', async () => {
    await createNode(db, offer('temp-offer', 'grp-vas'));
    await createNode(db, item('temp-offer-i1', 'temp-offer'));
    await deleteNode(db, 'temp-offer');
    await expect(getNode(db, 'temp-offer-i1')).rejects.toThrow(/not found/);
    const { customer } = await newCustomer(db);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    await expect(deleteNode(db, 'plan-sim-5g')).rejects.toThrow(/has been sold/);
    await deleteNode(db, 'plan-sim-5g-i1'); // a single line item of a sold offer can still be removed from the catalog entry
  });

  it('a line item with a SKU reserves its own stock; a SKU lives in one place only', async () => {
    await createNode(db, offer('bundle', 'grp-vas', { fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: ['WATCH-L1'] } }));
    await expect(createNode(db, item('bundle-watch', 'bundle', { itemType: 'DEVICE', sku: 'WATCH-L1', quantity: 1 }))).rejects.toThrow(/already reserved by the offer/);
    await createNode(db, item('bundle-phone', 'bundle', { itemType: 'DEVICE', sku: 'PHONE-X1-128', quantity: 2, unit: 'unit' }));
    await expect(createNode(db, item('bundle-phone2', 'bundle', { itemType: 'DEVICE', sku: 'PHONE-X1-128', quantity: 1 }))).rejects.toThrow(/already used by the line item/);
    await expect(updateNode(db, 'bundle', { fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: ['PHONE-X1-128'] } })).rejects.toThrow(/already reserved by one of this offer/);
    await setStatus(db, 'bundle', 'ACTIVE');
    const reserved = async () => (await db.query(`SELECT reserved FROM inventory_stock WHERE location_id='WH-MAIN' AND sku='PHONE-X1-128'`)).rows[0]!.reserved as number;
    const before = await reserved();
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'TELESALES', payment: { method: 'CASH' }, lines: [{ offerId: 'bundle', quantity: 3 }] });
    expect(o.state).not.toBe('FAILED');
    expect((await reserved()) - before).toBe(6); // 3 units ordered x line item quantity 2
  });

  it('can be copied onto a new version of an offer', async () => {
    await createNode(db, offer('plan-sim-5g-v2', 'grp-sim-only', { name: 'v2' }));
    const n = await copyLineItems(db, 'plan-sim-5g', 'plan-sim-5g-v2');
    expect(n).toBeGreaterThan(0);
    expect((await listNodes(db, { level: 'LINE_ITEM' })).filter((i) => i.parentId === 'plan-sim-5g-v2')).toHaveLength(n);
  });
});
