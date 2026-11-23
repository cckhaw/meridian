import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activateDueNodes, createNode, deleteNode, moveNode, setStatus, updateNode } from './catalog.js';
import type { Db, Row } from './db.js';
import { fanOutEvents, resetEventGate } from './events.js';
import { registerTmfListener, saveHubWebhook } from './integration-hub.js';
import { tmfAttributes } from './catalog-events.js';
import { tmfCreateOffering, tmfPatchOffering } from './tmf620.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const price = (value: number) => ({ priceType: 'recurring', recurringChargePeriodType: 'month', recurringChargePeriodLength: 1, price: { taxIncludedAmount: { unit: 'SGD', value } } });
const offer = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Event offer ${id}`, category: [{ id: 'grp-insurance' }], lifecycleStatus: 'In design', productOfferingPrice: [price(5)], '@meridian': { kind: 'VAS' }, ...over });
const outbox = async (like = '%') => Number((await db.query(`SELECT count(*)::int AS n FROM lifecycle_outbox WHERE kind='EVENT' AND instruction LIKE $1`, [like])).rows[0]!.n);
const bodyOf = (r: Row) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, any>;

describe('TMF620 events', () => {
  it('writes nothing while nobody listens', async () => {
    resetEventGate();
    await tmfCreateOffering(db, offer('ev-quiet'), 'studio');
    await tmfPatchOffering(db, 'ev-quiet', { productOfferingPrice: [price(6)] }, 'studio');
    expect(await outbox('OFFERING_%')).toBe(0);
  });

  it('announces creates, changes, state changes, line item changes, moves, scheduled go-lives and deletes, to webhooks and to listeners that asked', async () => {
    await saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'Studio', targetUrl: 'https://studio.example.com/hook', authKind: 'HMAC', secret: 'a-signing-key-12345', events: [] });
    const states = await registerTmfListener(db, 'oauth:studio', { callback: 'https://studio.example.com/cb', query: 'eventType=ProductOfferingStateChangeEvent' });
    resetEventGate();

    await tmfCreateOffering(db, offer('ev-1'), 'studio');                                                     // OFFERING_CREATED
    await tmfPatchOffering(db, 'ev-1', { productOfferingPrice: [price(7)] }, 'studio');                       // OFFERING_CHANGED (price)
    await tmfPatchOffering(db, 'ev-1', { lifecycleStatus: 'Active' }, 'studio');                              // OFFERING_STATE_CHANGED
    await createNode(db, { level: 'LINE_ITEM', id: 'ev-1-i1', code: 'ev-1-i1', name: 'Extra data', path: '', parentId: 'ev-1', status: 'ACTIVE', markets: [], itemType: 'DATA', quantity: 5, unit: 'GB' } as never, 'studio');   // OFFERING_CHANGED (specification)
    await createNode(db, { level: 'GROUP', id: 'grp-ev', code: 'grp-ev', name: 'Event group', path: '', parentId: 'mobile-postpaid', status: 'ACTIVE', markets: [] } as never, 'studio');   // CATEGORY_CREATED
    await moveNode(db, 'ev-1', 'grp-ev', 'studio');                                                           // OFFERING_CHANGED (category)
    await setStatus(db, 'grp-ev', 'RETIRED', 'studio');                                                       // CATEGORY_STATE_CHANGED
    await updateNode(db, 'grp-ev', { name: 'Event group, renamed' }, 'studio');                              // CATEGORY_CHANGED
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    await tmfCreateOffering(db, offer('ev-sched', { validFor: { startDateTime: soon } }), 'studio');          // OFFERING_CREATED (scheduled)
    await db.query(`UPDATE catalog_nodes SET active_from = now() - interval '1 minute' WHERE id='ev-sched'`);
    expect(await activateDueNodes(db)).toBe(1);                                                               // OFFERING_STATE_CHANGED (go-live)
    await setStatus(db, 'ev-sched', 'ACTIVE', 'studio');                                                      // already active: nothing to announce
    await deleteNode(db, 'ev-sched', 'studio');                                                               // OFFERING_DELETED

    const fan = await fanOutEvents(db);
    expect(fan.events).toBe(11);
    const rows = (await db.query('SELECT event_type, tmf_type, subscription_id, payload FROM event_deliveries ORDER BY id')).rows;
    const hook = rows.filter((r) => r.subscriptionId !== states.id);
    expect(hook.map((r) => r.eventType).sort()).toEqual([
      'CATEGORY_CHANGED', 'CATEGORY_CREATED', 'CATEGORY_STATE_CHANGED', 'OFFERING_CHANGED', 'OFFERING_CHANGED', 'OFFERING_CHANGED', 'OFFERING_CREATED', 'OFFERING_CREATED', 'OFFERING_DELETED', 'OFFERING_STATE_CHANGED', 'OFFERING_STATE_CHANGED',
    ]);
    const byType = (t: string) => hook.filter((r) => r.eventType === t).map(bodyOf);

    const created = byType('OFFERING_CREATED')[0]!;
    expect(created).toMatchObject({ eventType: 'ProductOfferingCreateEvent', domain: 'productCatalogManagement', event: { productOffering: { id: 'ev-1', '@type': 'ProductOffering', lifecycleStatus: 'In design', version: '1', href: '/api/tmf-api/productCatalogManagement/v4/productOffering/ev-1', category: { id: 'grp-insurance' } } } });
    expect(created.event.productOffering).not.toHaveProperty('serviceId');

    const changes = byType('OFFERING_CHANGED').map((b) => b.event.productOffering);
    expect(changes.map((c) => c.changedAttributes).sort()).toEqual([['category'], ['productOfferingPrice'], ['productSpecification']]);
    expect(changes.find((c) => c.changedAttributes[0] === 'productSpecification')).toMatchObject({ id: 'ev-1' });              // the item's offering, not the item
    expect(changes.every((c) => b2(c))).toBe(true);

    const state = byType('OFFERING_STATE_CHANGED').map((b) => b.event.productOffering);
    expect(state.map((s) => [s.id, s.previousLifecycleStatus, s.lifecycleStatus]).sort()).toEqual([['ev-1', 'In design', 'Active'], ['ev-sched', 'In design', 'Active']]);
    expect(byType('CATEGORY_CREATED')[0]).toMatchObject({ eventType: 'CategoryCreateEvent', event: { category: { id: 'grp-ev', parentId: 'mobile-postpaid', '@type': 'Category' } } });
    expect(byType('CATEGORY_STATE_CHANGED')[0]!.event.category).toMatchObject({ previousLifecycleStatus: 'Active', lifecycleStatus: 'Retired' });
    expect(byType('CATEGORY_CHANGED')[0]!.event.category.changedAttributes).toEqual(['name']);
    expect(byType('OFFERING_DELETED')[0]).toMatchObject({ eventType: 'ProductOfferingDeleteEvent', event: { productOffering: { id: 'ev-sched' } } });

    // a listener that asked for state changes only hears those
    const mine = rows.filter((r) => r.subscriptionId === states.id);
    expect(mine.map((r) => r.tmfType)).toEqual(['ProductOfferingStateChangeEvent', 'ProductOfferingStateChangeEvent']);
  });

  it('names changed fields the way TMF620 does', () => {
    expect(tmfAttributes(['prices', 'contract', 'requires', 'excludes', 'salesChannels', 'markets', 'fulfilment'])).toEqual(['productOfferingPrice', 'productOfferingTerm', 'productOfferingRelationship', 'channel', 'place', '@meridian.fulfilment']);
  });
});

/** Every change carries the new version, so a consumer can tell which catalogue version is live. */
const b2 = (c: Record<string, any>) => typeof c.version === 'string' && Number(c.version) >= 1 && typeof c.lastUpdate === 'string';
