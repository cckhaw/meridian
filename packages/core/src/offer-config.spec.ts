import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, getNode, listNodes, pageOffers, updateNode } from './catalog.js';
import type { Db } from './db.js';
import { createFulfilmentOption, createOfferType, deleteFulfilmentOption, deleteOfferType, expandKinds, listFulfilmentOptions, listOfferTypes, updateFulfilmentOption, updateOfferType } from './offer-config.js';
import { createsService } from './order-pricing.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const price = (amountMinor: number, type = 'RECURRING') => ({ type, amount: { amountMinor, currency: 'SGD' }, taxInclusive: true, ...(type === 'RECURRING' ? { periodMonths: 1 } : {}) });
const offer = (id: string, extra: Record<string, unknown> = {}) => createNode(db, {
  id, level: 'OFFER', name: id, parentId: 'grp-sim-only', kind: 'SIM_ONLY', status: 'DRAFT', markets: [], prices: [price(2000)], contract: { termMonths: 0 }, characteristics: {}, requires: [], excludes: [],
  fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, ...extra,
} as never) as Promise<any>;

describe('offer types', () => {
  it('starts with the eight built-in types and lets the operator add, rename and switch off types', async () => {
    expect((await listOfferTypes(db)).map((t) => t.id)).toEqual(['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE', 'FIBER', 'IOT_CONNECTIVITY', 'VAS', 'NON_TELCO_SUBSCRIPTION', 'PHYSICAL_GOOD']);
    const t = await createOfferType(db, 'admin', { name: 'Prepaid SIM', description: 'Top-up SIMs', template: 'SIM_ONLY' });
    expect(t).toMatchObject({ id: 'PREPAID_SIM', template: 'SIM_ONLY', status: 'ACTIVE', isBuiltin: false });
    await expect(createOfferType(db, 'admin', { name: 'prepaid sim', template: 'VAS' })).rejects.toThrow(/already an offer type/);
    await expect(createOfferType(db, 'admin', { name: 'Odd', template: 'NOPE' })).rejects.toThrow(/behaves like/);
    expect((await updateOfferType(db, 'admin', 'SIM_ONLY', { name: 'SIM-only plan' })).name).toBe('SIM-only plan');
    expect((await listOfferTypes(db, { withUsage: true })).find((x) => x.id === 'SIM_ONLY')!.offers).toBeGreaterThan(0);
  });

  it('gives an offer of a custom type the behaviour of its template', async () => {
    await createOfferType(db, 'admin', { name: 'Gift card', template: 'PHYSICAL_GOOD' });
    const o = await offer('gift-card-50', { kind: 'GIFT_CARD', fulfilment: { options: ['SHIP'], inventorySkus: ['GC-50'] }, prices: [price(5000, 'ONE_TIME')] });
    expect(o).toMatchObject({ kind: 'GIFT_CARD', template: 'PHYSICAL_GOOD' });
    expect(o.fulfilment).toMatchObject({ requiresShipping: true, requiresCollection: false, options: ['SHIP'] });
    expect(createsService(o)).toBe(false); // behaves like outright goods: nothing to bill
    await expect(offer('gift-bad', { kind: 'GIFT_CARD', fulfilment: { options: [], inventorySkus: [] }, prices: [price(1000, 'ONE_TIME')] })).rejects.toMatchObject({ details: expect.arrayContaining(['goods must be delivered or collected in store']) });
    await expect(offer('gift-ghost', { kind: 'NOPE' })).rejects.toThrow(/unknown offer type/);
  });

  it('filters by type id or by template, so sales screens find custom types too', async () => {
    await createOfferType(db, 'admin', { name: 'Student SIM', template: 'SIM_ONLY' });
    await offer('student-5g', { kind: 'STUDENT_SIM', status: 'ACTIVE', fulfilment: { options: ['SIM'], inventorySkus: [] } });
    expect(await expandKinds(db, ['SIM_ONLY'])).toEqual(expect.arrayContaining(['SIM_ONLY', 'STUDENT_SIM']));
    const page = await pageOffers(db, { status: 'ACTIVE', kind: 'SIM_ONLY', limit: 100 });
    expect(page.items.map((n) => n.id)).toEqual(expect.arrayContaining(['student-5g']));
    expect((await pageOffers(db, { status: 'ACTIVE', notKind: 'SIM_ONLY', limit: 100 })).items.map((n) => n.id)).not.toContain('student-5g');
  });

  it('switched-off types cannot be chosen for new offers, but existing offers keep working; unused custom types can be removed', async () => {
    await createOfferType(db, 'admin', { name: 'Trial plan', template: 'SIM_ONLY' });
    await offer('trial-1', { kind: 'TRIAL_PLAN' });
    await updateOfferType(db, 'admin', 'TRIAL_PLAN', { status: 'INACTIVE' });
    await expect(offer('trial-2', { kind: 'TRIAL_PLAN' })).rejects.toThrow(/switched off/);
    expect((await updateNode(db, 'trial-1', { name: 'Trial plan one' })).name).toBe('Trial plan one'); // still editable
    await expect(deleteOfferType(db, 'admin', 'TRIAL_PLAN')).rejects.toThrow(/1 offer uses/);
    await expect(deleteOfferType(db, 'admin', 'SIM_ONLY')).rejects.toThrow(/built-in/);
    await createOfferType(db, 'admin', { name: 'Unused', template: 'VAS' });
    await deleteOfferType(db, 'admin', 'UNUSED');
    expect((await listOfferTypes(db)).some((t) => t.id === 'UNUSED')).toBe(false);
  });
});

describe('fulfilment options', () => {
  it('starts with ship, collect in store, installation and SIM activation', async () => {
    expect((await listFulfilmentOptions(db)).map((o) => [o.id, o.mechanic, o.tracksStock])).toEqual([['SHIP', 'SHIP', true], ['COLLECT', 'COLLECT', true], ['INSTALL', 'INSTALL', false], ['SIM', 'SIM', false]]);
  });

  it('derives the order flags from the options chosen, including collect in store', async () => {
    const a = await offer('phone-collect', { kind: 'PHYSICAL_GOOD', prices: [price(30000, 'ONE_TIME')], fulfilment: { options: ['COLLECT'], inventorySkus: ['P-1'] } });
    expect(a.fulfilment).toMatchObject({ requiresShipping: false, requiresCollection: true });
    const b = await updateNode(db, 'phone-collect', { fulfilment: { options: ['SHIP', 'COLLECT'], inventorySkus: ['P-1'] } as never });
    expect((b as any).fulfilment).toMatchObject({ requiresShipping: true, requiresCollection: true, options: ['SHIP', 'COLLECT'] });
    await expect(offer('fibre-bad', { kind: 'FIBER', fulfilment: { options: ['SIM'], inventorySkus: [] } })).rejects.toThrow(/installation/);
  });

  it('lets the operator add an option on a mechanic, turn SIM stock tracking on, and remove unused options', async () => {
    const o = await createFulfilmentOption(db, 'admin', { name: 'Locker pickup', mechanic: 'COLLECT', tracksStock: true });
    expect(o).toMatchObject({ id: 'LOCKER_PICKUP', mechanic: 'COLLECT', isBuiltin: false });
    expect((await updateFulfilmentOption(db, 'admin', 'SIM', { tracksStock: true })).tracksStock).toBe(true);
    await expect(createFulfilmentOption(db, 'admin', { name: 'Odd', mechanic: 'TELEPORT' })).rejects.toThrow(/how the new option works/);
    await offer('locker-good', { kind: 'PHYSICAL_GOOD', prices: [price(1000, 'ONE_TIME')], fulfilment: { options: ['LOCKER_PICKUP'], inventorySkus: ['L-1'] } });
    await expect(deleteFulfilmentOption(db, 'admin', 'LOCKER_PICKUP')).rejects.toThrow(/1 offer uses/);
    await expect(deleteFulfilmentOption(db, 'admin', 'SHIP')).rejects.toThrow(/built-in/);
    await createFulfilmentOption(db, 'admin', { name: 'Spare', mechanic: 'SHIP' });
    await deleteFulfilmentOption(db, 'admin', 'SPARE');
    await updateFulfilmentOption(db, 'admin', 'SIM', { tracksStock: false });
  });
});

describe('prices follow the regional currency', () => {
  it('rejects a price in another currency than the one set in Settings', async () => {
    await expect(offer('usd-plan', { prices: [{ type: 'RECURRING', amount: { amountMinor: 1000, currency: 'USD' }, taxInclusive: true, periodMonths: 1 }] })).rejects.toThrow(/prices are in SGD/);
    expect(await getNode(db, 'phone-collect')).toBeTruthy();
    expect((await listNodes(db, { level: 'OFFER' })).length).toBeGreaterThan(0);
  });
});
