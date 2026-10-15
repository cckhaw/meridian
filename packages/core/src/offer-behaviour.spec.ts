import { behaviourOf, describeSwitches, roleOfSteps, switchProblems, switchesOf, TEMPLATES } from '@meridian/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, pageOffers, setStatus, updateNode } from './catalog.js';
import type { Db } from './db.js';
import { terminateService, expireServices } from './lifecycle.js';
import { createOfferType, getOfferType, kindsForStep, listOfferTypes, updateOfferType } from './offer-config.js';
import { eligibleAddons } from './order-pricing.js';
import { placeOrder } from './orders.js';
import { reconcile } from './reports.js';
import { createServiceKind, deleteServiceKind, listServiceKinds, updateServiceKind } from './service-kinds.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const price = (amountMinor: number, type = 'RECURRING') => ({ type, amount: { amountMinor, currency: 'SGD' }, taxInclusive: true, ...(type === 'RECURRING' ? { periodMonths: 1 } : {}) });
const offer = (id: string, extra: Record<string, unknown> = {}) => createNode(db, {
  id, level: 'OFFER', name: id, parentId: 'grp-sim-only', kind: 'SIM_ONLY', status: 'DRAFT', markets: [], prices: [price(2000)], contract: { termMonths: 0 }, characteristics: {}, requires: [], excludes: [],
  fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] }, ...extra,
} as never) as Promise<any>;
const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };

describe('behaviour switches', () => {
  it('the built-in presets read back as the switches they always had', () => {
    expect(switchesOf(TEMPLATES.SIM_DEVICE)).toMatchObject({ service: 'MOBILE', goods: true, steps: ['PLAN'], exclusive: true });
    expect(switchesOf(TEMPLATES.WEARABLE).steps).toEqual(['PLAN', 'DEVICE']);
    expect(roleOfSteps(['DEVICE'])).toBe('GOODS');
    expect(describeSwitches(switchesOf(TEMPLATES.PHYSICAL_GOOD))).toMatch(/Creates no service.*sold outright.*step 2/);
  });

  it('refuses combinations the order engine cannot sell', () => {
    const base = switchesOf(TEMPLATES.VAS);
    expect(switchProblems(base)).toEqual([]);
    expect(switchProblems({ ...base, service: null })).toEqual([expect.stringMatching(/service or include a physical item/)]);
    expect(switchProblems({ ...base, steps: [] })).toEqual([expect.stringMatching(/at least one step/)]);
    expect(switchProblems({ ...switchesOf(TEMPLATES.PHYSICAL_GOOD), contract: 'optional' })).toEqual([expect.stringMatching(/no contract/)]);
    expect(switchProblems({ ...switchesOf(TEMPLATES.PHYSICAL_GOOD), service: 'MOBILE' })).toEqual(expect.arrayContaining([expect.stringMatching(/physical item with no service/)]));
    expect(switchProblems({ ...base, needsInstallation: true, service: null, goods: true })).toEqual([expect.stringMatching(/installation visit is for a service/)]);
    expect(switchProblems({ ...base, exclusive: true })).toEqual([expect.stringMatching(/step 1/)]);
  });

  it('a type with its own switches is stamped on its offers, and decides where they are picked', async () => {
    // an accessory pack: goods, no service, picked beside the devices
    const pack = await createOfferType(db, 'admin', { name: 'Accessory pack', template: 'PHYSICAL_GOOD', behaviour: { steps: ['DEVICE'] } });
    expect(pack).toMatchObject({ template: 'PHYSICAL_GOOD', behaviour: expect.objectContaining({ goods: true, service: null }) });
    // an add-on that ships a physical kit: a service, goods, picked as an add-on
    const kit = await createOfferType(db, 'admin', { name: 'Care kit', template: 'VAS', behaviour: { goods: true, steps: ['ADDON'] } });
    const a = await offer('acc-pack-1', { kind: pack.id, prices: [price(3000, 'ONE_TIME')], fulfilment: { options: ['SHIP'], inventorySkus: ['ACC-1'] } });
    const k = await offer('care-kit-1', { kind: kit.id, prices: [price(500)], fulfilment: { options: ['SHIP'], inventorySkus: ['KIT-1'] } });
    expect(a.behaviour).toMatchObject({ goods: true, service: null, steps: ['DEVICE'] });
    expect(behaviourOf(k)).toMatchObject({ service: 'SUBSCRIPTION', goods: true, role: 'ADDON' });
    await setStatus(db, a.id, 'ACTIVE'); await setStatus(db, k.id, 'ACTIVE');
    const device = (await pageOffers(db, { status: 'ACTIVE', step: 'DEVICE', limit: 100 })).items.map((n) => n.id);
    expect(device).toEqual(expect.arrayContaining(['acc-pack-1', 'good-phone-outright']));
    expect(device).not.toContain('care-kit-1');
    const plans = (await pageOffers(db, { status: 'ACTIVE', step: 'PLAN', limit: 100 })).items.map((n) => n.id);
    expect(plans).toContain('plan-sim-5g');
    expect(plans).not.toContain('acc-pack-1');
    // the add-ons step lists add-on types, including the custom one, and never devices
    const addons = (await eligibleAddons(db, { customerId: null, offerIds: [], channel: 'RETAIL_ASSISTED', marketCode: 'SG', limit: 100 })).items.map((i) => i.offer.id);
    expect(addons).toEqual(expect.arrayContaining(['care-kit-1', 'vas-roaming']));
    expect(addons).not.toContain('acc-pack-1');
    expect(await kindsForStep(db, 'DEVICE')).toEqual(expect.arrayContaining(['PHYSICAL_GOOD', 'WEARABLE', pack.id]));
  });

  it('what an order creates is locked once offers use the type; where it is picked is not', async () => {
    const t = await createOfferType(db, 'admin', { name: 'Gadget plan', template: 'SIM_ONLY', behaviour: { exclusive: false } });
    // nothing uses it yet: any switch can change
    expect((await updateOfferType(db, 'admin', t.id, { behaviour: { goods: true } })).effective.goods).toBe(true);
    await offer('gadget-1', { kind: t.id, fulfilment: { options: ['SHIP', 'SIM'], inventorySkus: [] } });
    await expect(updateOfferType(db, 'admin', t.id, { behaviour: { goods: false } })).rejects.toThrow(/1 offer uses this type/);
    const moved = await updateOfferType(db, 'admin', t.id, { behaviour: { steps: ['PLAN', 'DEVICE'], exclusive: true } });
    expect(moved.effective).toMatchObject({ steps: ['PLAN', 'DEVICE'], exclusive: true });
    expect(behaviourOf((await updateNode(db, 'gadget-1', { name: 'Gadget one' })) as never).steps).toEqual(['PLAN', 'DEVICE']); // restamped on the offer
    await expect(updateOfferType(db, 'admin', 'SIM_ONLY', { behaviour: { goods: true } })).rejects.toThrow(/built-in/);
    await expect(createOfferType(db, 'admin', { name: 'Nothing', template: 'VAS', behaviour: { service: null } })).rejects.toThrow(/service or include/);
    await expect(createOfferType(db, 'admin', { name: 'Ghost kind', template: 'VAS', behaviour: { service: 'GHOST_KIND' } })).rejects.toThrow(/unknown service kind/);
    expect((await listOfferTypes(db)).find((x) => x.id === 'SIM_ONLY')!.behaviour).toBeNull(); // presets stay presets
    expect((await getOfferType(db, t.id))!.behaviour).not.toBeNull();
  });
});

describe('service kinds the operator defines', () => {
  it('validates and protects them', async () => {
    expect((await listServiceKinds(db)).filter((k) => k.isBuiltin).map((k) => k.id)).toEqual(['MOBILE', 'FIBER', 'IOT', 'SUBSCRIPTION']);
    await expect(createServiceKind(db, 'admin', { name: '', })).rejects.toThrow(/needs a name/);
    await expect(createServiceKind(db, 'admin', { name: 'Bad', expires: true })).rejects.toThrow(/default length/);
    await expect(createServiceKind(db, 'admin', { name: 'Bad', provisionSystems: ['lower case!'] })).rejects.toThrow(/up to 8 systems/);
    await expect(createServiceKind(db, 'admin', { name: 'Bad', identifierPrefix: 'way too long prefix' })).rejects.toThrow(/prefix/);
    await expect(updateServiceKind(db, 'admin', 'MOBILE', { name: 'Phone' })).rejects.toThrow(/built-in/);
    await expect(deleteServiceKind(db, 'admin', 'MOBILE')).rejects.toThrow(/built-in/);
    const k = await createServiceKind(db, 'admin', { name: 'Voucher', identifierPrefix: 'VCH-' });
    expect(k).toMatchObject({ id: 'VOUCHER', expires: false, validityDays: null, provisionInstruction: 'PROVISION' });
    await expect(createServiceKind(db, 'admin', { name: 'voucher' })).rejects.toThrow(/already a service kind/);
    await deleteServiceKind(db, 'admin', 'VOUCHER');
  });

  it('a roaming pass: sold in the order wizard, started with instructions to its systems, ends by itself without an early-termination charge', async () => {
    const kind = await createServiceKind(db, 'admin', { name: 'Roaming pass', identifierPrefix: 'RP-', expires: true, validityDays: 7, provisionSystems: ['PCRF', 'ROAMING_GW'], provisionInstruction: 'ENABLE_ROAMING', deprovisionInstruction: 'DISABLE_ROAMING' });
    const type = await createOfferType(db, 'admin', { name: 'Roaming pass', template: 'VAS', behaviour: { service: kind.id, steps: ['ADDON'] } });
    await expect(updateServiceKind(db, 'admin', kind.id, { name: 'Roaming pass', status: 'INACTIVE' })).rejects.toThrow(/active offer type/);
    await expect(deleteServiceKind(db, 'admin', kind.id)).rejects.toThrow(/offer type creates it/);
    await expect(offer('roam-bad', { kind: type.id, validityDays: 0, prices: [price(1500, 'ONE_TIME')] })).rejects.toThrow(/1 to 3650/);
    const o3 = await offer('roam-3d', { kind: type.id, validityDays: 3, prices: [price(1500, 'ONE_TIME')] });
    const o7 = await offer('roam-7d', { kind: type.id, prices: [price(2500, 'ONE_TIME')] });
    expect(o3.validityDays).toBe(3);
    await setStatus(db, o3.id, 'ACTIVE'); await setStatus(db, o7.id, 'ACTIVE');
    const eligible = (await eligibleAddons(db, { customerId: null, offerIds: [], channel: 'RETAIL_ASSISTED', marketCode: 'SG', limit: 100 })).items.map((i) => i.offer.id);
    expect(eligible).toEqual(expect.arrayContaining(['roam-3d', 'roam-7d']));

    const { customer } = await newCustomer(db);
    const order = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'roam-3d' }, { offerId: 'roam-7d' }] });
    expect(order.state).toBe('COMPLETED');
    const svcs = (await db.query(`SELECT * FROM services WHERE order_id=$1 ORDER BY offer_id`, [order.id])).rows;
    expect(svcs.map((s) => [s.type, s.serviceKind, s.status, s.offerId])).toEqual([['SUBSCRIPTION', kind.id, 'ACTIVE', 'roam-3d'], ['SUBSCRIPTION', kind.id, 'ACTIVE', 'roam-7d']]);
    expect(svcs.every((s) => /^RP-\d+$/.test(s.identifier))).toBe(true);
    const days = (s: any) => Math.round((new Date(s.expiresAt).getTime() - Date.now()) / 86_400_000);
    expect([days(svcs[0]), days(svcs[1])]).toEqual([3, 7]); // the offer's own length, else the kind's default
    const started = (await db.query(`SELECT instruction, payload FROM lifecycle_outbox WHERE instruction='ENABLE_ROAMING' ORDER BY id`)).rows;
    expect(started).toHaveLength(2);
    expect(started[0]!.payload).toMatchObject({ serviceKind: kind.id, offerId: 'roam-3d', systems: ['PCRF', 'ROAMING_GW'] });
    expect(started[0]!.payload.validUntil).toBeTruthy();
    expect((await db.query(`SELECT count(*) AS n FROM invoice_lines WHERE kind='RECURRING' AND service_id = ANY($1::uuid[])`, [svcs.map((s) => s.id)])).rows[0]!.n).toBe(0); // a one-off pass is not billed monthly

    // time passes: only the pass that ran its length ends
    await db.query(`UPDATE services SET expires_at = now() - interval '1 hour' WHERE id=$1`, [svcs[0]!.id]);
    expect(await expireServices(db)).toEqual({ expired: 1 });
    const after = (await db.query(`SELECT id, status, terminated_reason FROM services WHERE order_id=$1 ORDER BY offer_id`, [order.id])).rows;
    expect(after.map((s) => [s.status, s.terminatedReason])).toEqual([['TERMINATED', 'EXPIRED'], ['ACTIVE', null]]);
    const ended = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='DISABLE_ROAMING'`)).rows;
    expect(ended).toHaveLength(1);
    expect(ended[0]!.payload).toMatchObject({ systems: ['PCRF', 'ROAMING_GW'], serviceKind: kind.id, reason: 'EXPIRED' });
    expect((await db.query(`SELECT count(*) AS n FROM invoices WHERE customer_id=$1 AND kind='FINAL'`, [customer.id])).rows[0]!.n).toBe(0); // nothing owed for a pass that ran its course
    expect(await expireServices(db)).toEqual({ expired: 0 }); // safe to run again
    await terminateService(db, svcs[1]!.id, { reason: 'customer request' });
    expect((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='DISABLE_ROAMING'`)).rows[0]!.n).toBe(2);
    expect((await reconcile(db)).ok).toBe(true);
    expect((await listServiceKinds(db, { withUsage: true })).find((k) => k.id === kind.id)).toMatchObject({ offerTypes: 1, services: 2 });
  });

  it('a kind with no expiry is a plain subscription with its own identifier and systems; bulk orders work too', async () => {
    const k = await createServiceKind(db, 'admin', { name: 'Smart tag', identifierPrefix: 'TAG', provisionSystems: ['IOT_HUB'] });
    const t = await createOfferType(db, 'admin', { name: 'Smart tag', template: 'IOT_CONNECTIVITY', behaviour: { service: k.id } });
    const o = await offer('tag-1', { kind: t.id, parentId: 'grp-sim-only', prices: [price(300)] });
    await setStatus(db, o.id, 'ACTIVE');
    const { customer } = await newCustomer(db);
    const order = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'tag-1', quantity: 3 }] });
    const svcs = (await db.query(`SELECT identifier, service_kind, expires_at FROM services WHERE order_id=$1`, [order.id])).rows;
    expect(svcs).toHaveLength(3);
    expect(svcs.every((s) => s.serviceKind === k.id && s.expiresAt === null && /^TAG\d+$/.test(s.identifier))).toBe(true);
    expect((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='PROVISION' AND payload->>'serviceKind'=$1`, [k.id])).rows[0]!.n).toBe(3);
  });
});
