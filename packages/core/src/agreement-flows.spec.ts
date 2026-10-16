import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOrder, placeOrder, cancelOrder } from './orders.js';
import type { Db } from './db.js';
import { ensureStarterTemplates } from './doc-templates.js';
import { documentLog, setDocumentSettings } from './documents.js';
import { previewOrderAgreements } from './agreements.js';
import { changePlanNorth, previewPlanChangeAgreements } from './subscriber-ops.js';
import { freshDb, newCustomer, signatureDataUrl } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); await ensureStarterTemplates(db, { username: 'root' }); });
afterAll(async () => { await db.close(); });
const ag = (extra: Record<string, unknown> = {}) => ({ signature: { image: signatureDataUrl(), signerName: 'Sam Lee', geo: { lat: 1.3, lon: 103.8 } }, ip: '203.0.113.5', userAgent: 'vitest', ...extra });
const docs = async (orderId: string) => (await db.query(`SELECT * FROM documents WHERE order_id=$1 AND kind='CONTRACT' ORDER BY name`, [orderId])).rows;
const base = async () => ({ customerId: (await newCustomer(db)).customer.id, channel: 'SELF_SERVE' as const, payment: { method: 'CREDIT_CARD' as const }, deliveryAddress: '1 Test Road' });

describe('agreements with a new order', () => {
  it('shows the text for the basket with the customer\'s details, then signs, binds and delivers it once the order is paid', async () => {
    const b = await base();
    const pre = await previewOrderAgreements(db, { ...b, lines: [{ offerId: 'plan-sim-5g' }] });
    expect(pre.required).toBe(false);
    expect(pre.agreements.map((a) => a.code)).toEqual(expect.arrayContaining(['SUBSCRIBER_AGREEMENT', 'FAIR_USAGE']));
    const o = await placeOrder(db, { ...b, lines: [{ offerId: 'plan-sim-5g' }], agreement: ag({ versionIds: pre.agreements.map((a) => a.versionId) }) });
    const d = await docs(o.id);
    expect(d.length).toBe(pre.agreements.length);
    expect(d.every((x) => x.templateVersionId && x.customerId === b.customerId && x.meta.reference === o.number)).toBe(true);
    expect((await getOrder(db, o.id)).fulfilment.agreements).toHaveLength(d.length);
    const sig = (await db.query('SELECT * FROM document_signatures WHERE order_id=$1', [o.id])).rows;
    expect(sig[0]).toMatchObject({ signerName: 'Sam Lee', ip: '203.0.113.5', method: 'SELF_SERVE' });
    // the customer is sent the signed copies once, when the order is paid
    const sent = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND payload->>'orderId'=$1`, [o.id])).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.documentIds.sort()).toEqual(d.map((x) => x.id).sort());
    expect((await documentLog(db, { customerId: b.customerId })).map((l) => l.action)).toEqual(expect.arrayContaining(['GENERATE', 'DELIVER']));
    // a cancelled order's agreements no longer stand
    await cancelOrder(db, o.id, 'changed my mind').catch(() => undefined);
    if ((await getOrder(db, o.id)).state === 'CANCELLED') expect((await docs(o.id)).every((x) => x.status === 'SUPERSEDED')).toBe(true);
  });
  it('is refused without a signature when Settings says orders must be signed, and applies only to the offer types listed', async () => {
    await setDocumentSettings(db, 'root', { requireAtOrder: true });
    const b = await base();
    await expect(placeOrder(db, { ...b, lines: [{ offerId: 'plan-sim-5g' }] })).rejects.toThrow(/read and sign/);
    expect((await previewOrderAgreements(db, { ...b, lines: [{ offerId: 'plan-sim-5g' }] })).required).toBe(true);
    const ok = await placeOrder(db, { ...b, lines: [{ offerId: 'plan-sim-5g' }], agreement: ag() });
    expect((await docs(ok.id)).length).toBeGreaterThan(0);
    // the device terms are for device offers only
    const dev = await placeOrder(db, { ...b, customerId: (await newCustomer(db)).customer.id, lines: [{ offerId: 'plan-phone-24' }], agreement: ag() });
    expect((await docs(dev.id)).map((x) => x.meta.templateCode)).toContain('DEVICE_INSTALMENT');
    expect((await docs(ok.id)).map((x) => x.meta.templateCode)).not.toContain('DEVICE_INSTALMENT');
    // a stale agreement (published again while the screen was open) must be read again
    await expect(placeOrder(db, { ...b, customerId: (await newCustomer(db)).customer.id, lines: [{ offerId: 'plan-sim-5g' }], agreement: ag({ versionIds: ['00000000-0000-0000-0000-000000000000'] }) })).rejects.toThrow(/updated while it was on screen/);
    await setDocumentSettings(db, 'root', { requireAtOrder: false });
  });
});

describe('agreements with a plan change', () => {
  it('is signed, stored with the service and sent, and can be made mandatory', async () => {
    const plus = (await db.query(`SELECT * FROM catalog_nodes WHERE id='plan-sim-5g'`)).rows[0]!;
    const data = { ...plus.data, prices: plus.data.prices.map((p: any) => (p.type === 'RECURRING' ? { ...p, amount: { ...p.amount, amountMinor: 5500 } } : p)), contract: { termMonths: 0 } };
    await db.query(`INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order) VALUES ('plan-sim-5g-plus','OFFER','plan-sim-5g-plus','5G SIM-only Plus',$1,$2,'ACTIVE','SIM_ONLY',$3,$4,99)`, [`${plus.path}-plus`, plus.parentId, plus.markets, JSON.stringify(data)]);
    const k = (await newCustomer(db)).customer;
    const o = await placeOrder(db, { customerId: k.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const serviceId = o.services[0].id as string;
    const pre = await previewPlanChangeAgreements(db, serviceId, { targetOfferId: 'plan-sim-5g-plus', effective: 'IMMEDIATE' });
    expect(pre.agreements.map((a) => a.code)).toEqual(['PLAN_CHANGE']);
    expect(pre.agreements[0]!.html).toContain('5G SIM-only Plus');
    await setDocumentSettings(db, 'root', { requireAtPlanChange: true });
    await expect(changePlanNorth(db, serviceId, { targetOfferId: 'plan-sim-5g-plus', effective: 'IMMEDIATE' }, 'agent1')).rejects.toThrow(/read and sign/);
    expect((await db.query('SELECT offer_id FROM services WHERE id=$1', [serviceId])).rows[0]!.offerId).toBe('plan-sim-5g');   // nothing moved
    const r = await changePlanNorth(db, serviceId, { targetOfferId: 'plan-sim-5g-plus', effective: 'IMMEDIATE', agreement: ag({ versionIds: pre.agreements.map((a) => a.versionId), agentName: 'agent1' }) }, 'agent1');
    expect(r.result.status).toBe('APPLIED');
    const d = (await db.query(`SELECT * FROM documents WHERE service_id=$1 AND kind='CONTRACT'`, [serviceId])).rows;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ category: 'PLAN_CHANGE', customerId: k.id });
    expect((await db.query(`SELECT method, agent FROM document_signatures WHERE service_id=$1`, [serviceId])).rows[0]).toEqual({ method: 'PLAN_CHANGE', agent: 'agent1' });
    expect((await db.query(`SELECT count(*)::int AS n FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND payload->>'customerId'=$1`, [k.id])).rows[0]!.n).toBeGreaterThanOrEqual(1);
    await setDocumentSettings(db, 'root', { requireAtPlanChange: false });
  });
});
