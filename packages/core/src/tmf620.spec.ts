import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';
import {
  assertIfMatch, etagMatches, fromOfferingPrices, nodeEtag, statusFromLifecycle, tmfCreateCategory, tmfCreateOffering, tmfDelete, tmfGetCategory, tmfGetOffering, tmfGetSpecification, tmfListCategories, tmfListOfferings,
  tmfPatchOffering, tmfPatchSpecification, toCategory, toProductOffering, toProductSpecification,
} from './tmf620.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const B = 'https://x.test';
const price = (type: string, value: number, extra: Record<string, unknown> = {}) => ({ priceType: type, price: { taxIncludedAmount: { unit: 'SGD', value } }, ...extra });
const body = (over: Record<string, unknown> = {}) => ({
  id: 'tmf-addon', name: 'TMF add-on', description: 'via TMF620', category: [{ id: 'grp-insurance' }], lifecycleStatus: 'Active',
  productOfferingPrice: [price('recurring', 5.5, { recurringChargePeriodType: 'month', recurringChargePeriodLength: 1 })],
  '@meridian': { kind: 'VAS' }, ...over,
});

describe('TMF620: lifecycle and prices', () => {
  it('maps lifecycle both ways, with a scheduled offer as In design plus a future start', () => {
    expect(statusFromLifecycle('Active')).toEqual({ status: 'ACTIVE' });
    expect(statusFromLifecycle('Retired').status).toBe('RETIRED');
    expect(statusFromLifecycle('In design').status).toBe('DRAFT');
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    expect(statusFromLifecycle('In design', soon)).toEqual({ status: 'SCHEDULED', activeFrom: soon });
    expect(() => statusFromLifecycle('Whatever')).toThrow(/lifecycleStatus/);
  });
  it('converts prices to and from minor units, tax-inclusive or not, and refuses nonsense', () => {
    const [p] = fromOfferingPrices([price('recurring', 12.5, { recurringChargePeriodType: 'month' })]);
    expect(p).toMatchObject({ type: 'RECURRING', amount: { amountMinor: 1250, currency: 'SGD' }, periodMonths: 1, taxInclusive: true });
    const [y] = fromOfferingPrices([{ priceType: 'recurring', recurringChargePeriodType: 'year', recurringChargePeriodLength: 1, price: { dutyFreeAmount: { unit: 'SGD', value: 120 } } }]);
    expect(y).toMatchObject({ periodMonths: 12, taxInclusive: false });
    expect(() => fromOfferingPrices([])).toThrow(/at least one/);
    expect(() => fromOfferingPrices([{ priceType: 'weird', price: {} }])).toThrow(/priceType/);
    expect(() => fromOfferingPrices([{ priceType: 'oneTime', price: { taxIncludedAmount: { unit: 'SGD', value: -1 } } }])).toThrow(/value 0 or more/);
  });
});

describe('TMF620: product offerings', () => {
  it('creates an offering, reads it back with its price, category and extension, and round-trips it', async () => {
    const o = await tmfCreateOffering(db, body(), 'studio');
    expect(o.id).toBe('tmf-addon');
    const { offer, known } = await tmfGetOffering(db, 'tmf-addon');
    const out = toProductOffering(offer, B, known) as any;
    expect(out).toMatchObject({ id: 'tmf-addon', lifecycleStatus: 'Active', '@type': 'ProductOffering', href: `${B}/api/tmf-api/productCatalogManagement/v4/productOffering/tmf-addon` });
    expect(out.category[0]).toMatchObject({ id: 'grp-insurance', '@referredType': 'Category' });
    expect(out.productOfferingPrice[0]).toMatchObject({ priceType: 'recurring', recurringChargePeriodType: 'month', price: { taxIncludedAmount: { unit: 'SGD', value: 5.5 } } });
    expect(out['@meridian'].kind).toBe('VAS');
    // Writing what was read changes nothing and is accepted.
    await tmfPatchOffering(db, 'tmf-addon', out, 'studio');
    expect(toProductOffering((await tmfGetOffering(db, 'tmf-addon')).offer, B) as any).toMatchObject({ name: 'TMF add-on', version: expect.any(String) });
  });

  it('asks for a client id only in the right shape, makes one from the name otherwise, and refuses a duplicate with a conflict', async () => {
    await expect(tmfCreateOffering(db, body({ id: 'Bad Id' }), 'studio')).rejects.toThrow(/lowercase/);
    const made = await tmfCreateOffering(db, body({ id: undefined, name: 'Generated Id Offer' }), 'studio');
    expect(made.id).toBe('generated-id-offer');
    await expect(tmfCreateOffering(db, body(), 'studio')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('needs a category, a price and an offer type, and applies the catalog rules (not a group-only retired parent, a real currency)', async () => {
    await expect(tmfCreateOffering(db, body({ category: undefined, id: 'n1' }), 'studio')).rejects.toThrow(/category/);
    await expect(tmfCreateOffering(db, body({ productOfferingPrice: undefined, id: 'n2' }), 'studio')).rejects.toThrow(/productOfferingPrice/);
    await expect(tmfCreateOffering(db, body({ '@meridian': {}, id: 'n3' }), 'studio')).rejects.toThrow(/@meridian\.kind/);
    await expect(tmfCreateOffering(db, body({ id: 'n4', productOfferingPrice: [{ priceType: 'oneTime', price: { taxIncludedAmount: { unit: 'XXX', value: 1 } } }] }), 'studio')).rejects.toThrow();
  });

  it('patches only what is named, and moves an offering between groups', async () => {
    await tmfPatchOffering(db, 'tmf-addon', { description: 'changed' }, 'studio');
    const { offer } = await tmfGetOffering(db, 'tmf-addon');
    expect(offer.description).toBe('changed');
    expect(offer.prices[0]!.amount.amountMinor).toBe(550);
    await tmfPatchOffering(db, 'tmf-addon', { category: [{ id: 'grp-device' }] }, 'studio');
    expect((await tmfGetOffering(db, 'tmf-addon')).offer.parentId).toBe('grp-device');
  });

  it('refuses to reprice an offer that has been sold, but still lets it be retired', async () => {
    const { customer } = await newCustomer(db);
    const sold = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-12' }] });
    expect(sold.state).toBe('COMPLETED');
    await expect(tmfPatchOffering(db, 'plan-phone-12', { productOfferingPrice: [price('recurring', 1, { recurringChargePeriodType: 'month' })] }, 'studio')).rejects.toMatchObject({ code: 'REJECTED' });
    await tmfPatchOffering(db, 'plan-phone-12', { description: 'still editable' }, 'studio');
    await tmfPatchOffering(db, 'tmf-addon', { lifecycleStatus: 'Retired' }, 'studio');
    expect(statusOf((await tmfGetOffering(db, 'tmf-addon')).offer)).toBe('RETIRED');
  });

  it('records dependencies and exclusions as productOfferingRelationship', async () => {
    await tmfPatchOffering(db, 'tmf-addon', { productOfferingRelationship: [{ id: 'plan-phone-12', relationshipType: 'dependency' }, { id: 'device-care', relationshipType: 'exclusivity' }] }, 'studio');
    const { offer, known } = await tmfGetOffering(db, 'tmf-addon');
    const rel = (toProductOffering(offer, B, known) as any).productOfferingRelationship;
    expect(rel.map((r: any) => [r.id, r.relationshipType])).toEqual([['plan-phone-12', 'dependency'], ['device-care', 'exclusivity']]);
    await expect(tmfPatchOffering(db, 'tmf-addon', { productOfferingRelationship: [{ id: 'no-such-offer', relationshipType: 'dependency' }] }, 'studio')).rejects.toThrow();
  });

  it('lists with filters, a total and offset/limit, and rejects a bad offset', async () => {
    const all = await tmfListOfferings(db, { offset: 0, limit: 5 });
    expect(all.items.length).toBeLessThanOrEqual(5);
    expect(all.total).toBeGreaterThan(5);
    const retired = await tmfListOfferings(db, { offset: 0, limit: 50, lifecycleStatus: 'Retired' });
    expect(retired.items.every((o) => o.status === 'RETIRED')).toBe(true);
    const inGroup = await tmfListOfferings(db, { offset: 0, limit: 50, categoryId: 'grp-device' });
    expect(inGroup.items.every((o) => o.parentId === 'grp-device')).toBe(true);
    const since = await tmfListOfferings(db, { offset: 0, limit: 50, updatedAfter: new Date(Date.now() + 60_000).toISOString() });
    expect(since.total).toBe(0);
    await expect(tmfListOfferings(db, { offset: -1, limit: 5 })).rejects.toThrow(/offset/);
    await expect(tmfListOfferings(db, { offset: 0, limit: 5, lifecycleStatus: 'Nope' })).rejects.toThrow(/lifecycleStatus/);
  });
});

const statusOf = (o: { status: string }) => o.status;

describe('TMF620: categories', () => {
  it('builds the hierarchy: a network type, a category under it, a group under that, and refuses a category under a group', async () => {
    const nt = await tmfCreateCategory(db, { id: 'tmf-nt', name: 'TMF network', '@meridian': { networkType: 'mobile' } }, 'studio');
    const cat = await tmfCreateCategory(db, { id: 'tmf-cat', name: 'TMF category', parentId: nt.id }, 'studio');
    const grp = await tmfCreateCategory(db, { id: 'tmf-grp', name: 'TMF group', parentId: cat.id, lifecycleStatus: 'Active' }, 'studio');
    expect([nt.level, cat.level, grp.level]).toEqual(['NETWORK_TYPE', 'CATEGORY', 'GROUP']);
    await expect(tmfCreateCategory(db, { name: 'Too deep', parentId: grp.id }, 'studio')).rejects.toThrow(/holds offerings/);
    await expect(tmfCreateCategory(db, { name: 'No type' }, 'studio')).rejects.toThrow(/networkType/);
    const r = await tmfGetCategory(db, 'tmf-cat');
    const out = toCategory(r.node, B, r.children, r.parentName) as any;
    expect(out).toMatchObject({ id: 'tmf-cat', isRoot: false, parentId: 'tmf-nt', '@type': 'Category' });
    expect(out.subCategory.map((c: any) => c.id)).toEqual(['tmf-grp']);
    const roots = await tmfListCategories(db, { offset: 0, limit: 50, root: true });
    expect(roots.items.every((n) => n.parentId === null)).toBe(true);
    await expect(tmfGetCategory(db, 'tmf-addon')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('puts an offering under the new group and deletes empty things by the catalog rule', async () => {
    await tmfCreateOffering(db, body({ id: 'tmf-in-grp', name: 'In group', category: [{ id: 'tmf-grp' }] }), 'studio');
    await expect(tmfDelete(db, 'tmf-grp', 'category', 'studio')).rejects.toThrow(/still contains/);
    await tmfDelete(db, 'tmf-in-grp', 'offering', 'studio');
    await tmfDelete(db, 'tmf-grp', 'category', 'studio');
    await expect(tmfDelete(db, 'tmf-cat', 'offering', 'studio')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('TMF620: product specifications (line items)', () => {
  it('sets, updates and removes what an offering includes as one complete list', async () => {
    await tmfCreateOffering(db, body({ id: 'tmf-spec', name: 'TMF spec', '@meridian': { kind: 'VAS' } }), 'studio');
    let s = await tmfPatchSpecification(db, 'tmf-spec', { productSpecCharacteristic: [
      { name: '100 GB data', productSpecCharacteristicValue: [{ value: 100, unitOfMeasure: 'GB' }], '@meridian': { itemType: 'DATA' } },
      { name: 'Calls', productSpecCharacteristicValue: [{ value: 'Unlimited' }], '@meridian': { itemType: 'VOICE' } },
    ] }, 'studio');
    let out = toProductSpecification(s.offer, s.items, B) as any;
    expect(out.productSpecCharacteristic).toHaveLength(2);
    expect(out.productSpecCharacteristic[0]).toMatchObject({ name: '100 GB data', productSpecCharacteristicValue: [{ value: 100, unitOfMeasure: 'GB' }], '@meridian': { itemType: 'DATA', unlimited: false } });
    expect(out.productSpecCharacteristic[1]['@meridian'].unlimited).toBe(true);
    const keepId = out.productSpecCharacteristic[0].id;
    s = await tmfPatchSpecification(db, 'tmf-spec', { productSpecCharacteristic: [{ id: keepId, name: '200 GB data', productSpecCharacteristicValue: [{ value: 200, unitOfMeasure: 'GB' }], '@meridian': { itemType: 'DATA' } }] }, 'studio');
    out = toProductSpecification(s.offer, s.items, B) as any;
    expect(out.productSpecCharacteristic.map((c: any) => [c.id, c.name])).toEqual([[keepId, '200 GB data']]);
    await expect(tmfPatchSpecification(db, 'tmf-spec', { productSpecCharacteristic: [{ name: 'x', '@meridian': { itemType: 'BOGUS' } }] }, 'studio')).rejects.toThrow(/itemType/);
    expect((await tmfGetSpecification(db, 'tmf-spec')).items).toHaveLength(1);
  });
});

describe('TMF620: ETag and If-Match', () => {
  it('matches strong and weak validators, lists and *, and refuses a stale If-Match with a 412', () => {
    expect(nodeEtag({ version: 3 })).toBe('"3"');
    expect(nodeEtag({})).toBe('"1"');
    expect(etagMatches('"3"', '"3"')).toBe(true);
    expect(etagMatches('W/"3"', '"3"')).toBe(true);
    expect(etagMatches('"1", "3"', '"3"')).toBe(true);
    expect(etagMatches('*', '"3"')).toBe(true);
    expect(etagMatches('"2"', '"3"')).toBe(false);
    expect(etagMatches('', '"3"')).toBe(false);
    expect(etagMatches(null, '"3"')).toBe(false);
    expect(() => assertIfMatch(undefined, '"3"')).not.toThrow();
    expect(() => assertIfMatch(null, '"3"')).not.toThrow();
    expect(() => assertIfMatch('"3"', '"3"')).not.toThrow();
    expect(() => assertIfMatch('"2"', '"3"')).toThrow(/changed since you read it/);
    try { assertIfMatch('"2"', '"3"'); } catch (e) { expect((e as { status: number; code: string }).status).toBe(412); expect((e as { code: string }).code).toBe('PRECONDITION_FAILED'); }
  });

  it('raises the version of an offering when what it includes changes, and of a node when it is moved, so the ETag changes with the resource', async () => {
    await tmfCreateOffering(db, body({ id: 'etag-core', category: [{ id: 'grp-insurance' }], lifecycleStatus: 'In design' }), 'studio');
    const v = async (id: string) => Number((await db.query('SELECT version FROM catalog_nodes WHERE id=$1', [id])).rows[0]!.version);
    const v0 = await v('etag-core');
    await tmfPatchSpecification(db, 'etag-core', { productSpecCharacteristic: [{ name: '1 GB', productSpecCharacteristicValue: [{ value: 1, unitOfMeasure: 'GB' }], '@meridian': { itemType: 'DATA' } }] }, 'studio');
    const v1 = await v('etag-core');
    expect(v1).toBeGreaterThan(v0);                                     // a line item added
    const spec = await tmfGetSpecification(db, 'etag-core');
    await tmfPatchSpecification(db, 'etag-core', { productSpecCharacteristic: [{ id: spec.items[0]!.id, name: '2 GB', productSpecCharacteristicValue: [{ value: 2, unitOfMeasure: 'GB' }], '@meridian': { itemType: 'DATA' } }] }, 'studio');
    const v2 = await v('etag-core');
    expect(v2).toBeGreaterThan(v1);                                     // a line item changed
    await tmfPatchSpecification(db, 'etag-core', { productSpecCharacteristic: [] }, 'studio');
    expect(await v('etag-core')).toBeGreaterThan(v2);                   // a line item removed
    const before = await v('etag-core');
    await tmfPatchOffering(db, 'etag-core', { category: [{ id: 'grp-vas' }] }, 'studio');
    expect(await v('etag-core')).toBeGreaterThan(before);               // moved to another group
  });

  it('refuses a stale If-Match on every write, checking inside the write, and lets the right one through', async () => {
    await tmfCreateOffering(db, body({ id: 'etag-guard', lifecycleStatus: 'In design' }), 'studio');
    const tag = async () => nodeEtag((await tmfGetOffering(db, 'etag-guard')).offer);
    const t1 = await tag();
    await expect(tmfPatchOffering(db, 'etag-guard', { description: 'x' }, 'studio', { ifMatch: '"0"' })).rejects.toThrow(/changed since you read it/);
    await tmfPatchOffering(db, 'etag-guard', { description: 'x' }, 'studio', { ifMatch: t1 });
    expect(await tag()).not.toBe(t1);
    await expect(tmfPatchOffering(db, 'etag-guard', { description: 'y' }, 'studio', { ifMatch: t1 })).rejects.toThrow(/changed since you read it/);
    await expect(tmfPatchSpecification(db, 'etag-guard', { productSpecCharacteristic: [] }, 'studio', { ifMatch: t1 })).rejects.toThrow(/changed since you read it/);
    await expect(tmfDelete(db, 'etag-guard', 'offering', 'studio', { ifMatch: t1 })).rejects.toThrow(/changed since you read it/);
    await tmfDelete(db, 'etag-guard', 'offering', 'studio', { ifMatch: await tag() });
    await expect(tmfGetOffering(db, 'etag-guard')).rejects.toThrow(/not found/);
  });
});
