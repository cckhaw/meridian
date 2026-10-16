import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { importImsis, importMsisdns, importSims } from './nrm-pools.js';
import { placeOrder } from './orders.js';
import { audit } from './audit.js';
import { createCustomer } from './customers.js';
import { assertNotBlacklisted, blacklistAdd, blacklistHash, blacklistHit, blacklistRemove, hardBar, listAlerts, listBlacklist, raiseAlert, recentSimSwaps, releaseBar, resolveAlert, scanSimSwaps } from './fraud.js';
import { closeDrawer, drawerStatus, expectedCash, listClosings, storeSales } from './store-desk.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await importImsis(db, { csv: Array.from({ length: 6 }, (_, i) => `52501${String(2_000_000_000 + i * 13)}`).join('\n') }, { apply: true, actor: 'ops' });
  await importSims(db, { csv: `iccid\n${Array.from({ length: 6 }, (_, i) => `8961${String(1_000_000_000_000_000 + (i + 1) * 7).slice(1)}`).join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN' });
  await importMsisdns(db, { range: { from: '+6582000000', to: '+6582000049' } }, { apply: true, actor: 'ops' });
});
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
async function mobile(attribution: Record<string, string> = retail, method = 'CASH') {
  const c = await newCustomer(db);
  const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution, payment: { method: method as 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
  return { ...c, order: o, serviceId: o.services[0].id as string, msisdn: o.services[0].identifier as string };
}

describe('fraud alerts', () => {
  it('opens one alert per dedupe key and lets an analyst confirm or dismiss it once', async () => {
    const a = await raiseAlert(db, { kind: 'USAGE_SPIKE', severity: 'HIGH', summary: '40 GB in an hour on +6582…', identifier: '+658200', source: 'NETWORK', dedupeKey: 'spike:1' });
    expect(a.created).toBe(true);
    const again = await raiseAlert(db, { kind: 'USAGE_SPIKE', summary: 'again', dedupeKey: 'spike:1' });
    expect(again.created).toBe(false); expect(again.alert.id).toBe(a.alert.id);
    await expect(raiseAlert(db, { kind: 'USAGE_SPIKE', summary: '  ' })).rejects.toThrow(/what looks wrong/);
    const done = await resolveAlert(db, a.alert.id, 'DISMISSED', 'analyst', 'roaming user');
    expect(done).toMatchObject({ status: 'DISMISSED', handledBy: 'analyst', note: 'roaming user' });
    await expect(resolveAlert(db, a.alert.id, 'CONFIRMED', 'analyst')).rejects.toThrow(/already closed/);
    // once closed, the same key can open a fresh alert
    expect((await raiseAlert(db, { kind: 'USAGE_SPIKE', summary: 'again', dedupeKey: 'spike:1' })).created).toBe(true);
    const list = await listAlerts(db, { status: 'OPEN' });
    expect(list.open).toBe(1); expect(list.items).toHaveLength(1);
  });
});

describe('SIM-swap anomalies', () => {
  it('flags a service swapped twice in the window and a swap right after a number change; leaves a single swap alone', async () => {
    const twice = await mobile(); const single = await mobile(); const moved = await mobile();
    await audit(db, 'ivr', 'service', twice.serviceId, 'SIM_SWAP', { reason: 'LOST' });
    await audit(db, 'ivr', 'service', twice.serviceId, 'SIM_SWAP', { reason: 'LOST' });
    await audit(db, 'ivr', 'service', single.serviceId, 'SIM_SWAP', { reason: 'DAMAGED' });
    await audit(db, 'ivr', 'service', moved.serviceId, 'MSISDN_CHANGE', {});
    await audit(db, 'ivr', 'service', moved.serviceId, 'SIM_SWAP', { reason: 'STOLEN' });
    const r = await scanSimSwaps(db);
    expect(r).toEqual({ scanned: 3, raised: 2 });
    const alerts = (await listAlerts(db, { kind: 'SIM_SWAP_ANOMALY' })).items;
    expect(alerts.map((a) => a.serviceId).sort()).toEqual([twice.serviceId, moved.serviceId].sort());
    expect(alerts.every((a) => a.severity === 'HIGH' && a.status === 'OPEN')).toBe(true);
    expect(await scanSimSwaps(db)).toEqual({ scanned: 3, raised: 0 });   // running again adds nothing
    const swaps = await recentSimSwaps(db);
    expect(swaps.find((s) => s.serviceId === twice.serviceId)).toMatchObject({ swapsInWindow: 2 });
  });
});

describe('hard bar', () => {
  it('suspends a service for fraud, and only a fraud release brings it back', async () => {
    const a = await mobile();
    await expect(hardBar(db, a.serviceId, ' ', 'fa')).rejects.toThrow(/why/);
    const s = await hardBar(db, a.serviceId, 'SIM-swap takeover', 'fa');
    expect(s).toMatchObject({ status: 'SUSPENDED', suspensionKind: 'FRAUD' });
    await releaseBar(db, a.serviceId, 'owner verified in store', 'fa');
    expect((await db.query('SELECT status FROM services WHERE id=$1', [a.serviceId])).rows[0]!.status).toBe('ACTIVE');
    await expect(releaseBar(db, a.serviceId, 'again', 'fa')).rejects.toThrow(/not under a fraud bar/);
    const acts = (await db.query(`SELECT action FROM audit_log WHERE entity='service' AND entity_id=$1 AND action LIKE 'FRAUD_%' ORDER BY id`, [a.serviceId])).rows.map((r) => r.action);
    expect(acts).toEqual(['FRAUD_BAR', 'FRAUD_RELEASE']);
  });
});

describe('blacklist', () => {
  it('keeps only a hash, blocks sign-up by ID document and e-mail, and lifts when removed', async () => {
    const e = await blacklistAdd(db, { kind: 'ID_DOCUMENT', value: 'x1234567z', reason: 'forged papers', actor: 'fa' });
    expect(JSON.stringify(e)).not.toMatch(/1234567/);
    await expect(blacklistAdd(db, { kind: 'ID_DOCUMENT', value: ' X1234567Z ', reason: 'dup', actor: 'fa' })).rejects.toThrow(/already/);
    expect(await blacklistHit(db, { idHash: blacklistHash('ID_DOCUMENT', 'X1234567Z') })).toBe('ID_DOCUMENT');
    await expect(createCustomer(db, { segment: 'CONSUMER', displayName: 'Mallory', idDocument: 'X1234567Z' })).rejects.toThrow(/cannot be accepted/);
    await blacklistAdd(db, { kind: 'EMAIL', value: 'Bad@Example.com', reason: 'chargebacks', actor: 'fa' });
    await expect(assertNotBlacklisted(db, { email: 'bad@example.com' })).rejects.toThrow(/cannot be accepted/);
    expect((await listBlacklist(db)).map((x) => x.kind).sort()).toEqual(['EMAIL', 'ID_DOCUMENT']);
    await blacklistRemove(db, e.id, 'fa');
    await expect(createCustomer(db, { segment: 'CONSUMER', displayName: 'Mallory', idDocument: 'X1234567Z' })).resolves.toBeTruthy();
  });
  it('refuses an order from a listed customer', async () => {
    const c = await newCustomer(db);
    const h = (await db.query('SELECT id_document_hash FROM customers WHERE id=$1', [c.customer.id])).rows[0]!.idDocumentHash;
    await blacklistAdd(db, { kind: 'ID_DOCUMENT', hash: h, hint: '…xyz', reason: 'fraud ring', actor: 'fa' });
    await expect(placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] })).rejects.toThrow(/cannot be accepted/);
  });
});

describe('store desk', () => {
  it('reports sales for the store and reconciles the cash drawer', async () => {
    const store = { storeId: 'STORE-DESK-9', salespersonId: 'mgr1' };
    const cash = await mobile(store, 'CASH'); await mobile({ ...store, salespersonId: 'mgr2' }, 'CASH'); await mobile({ storeId: 'OTHER', salespersonId: 'x' }, 'CASH');
    const day = new Date().toISOString().slice(0, 10);
    const sales = await storeSales(db, 'STORE-DESK-9', { from: day, to: day });
    expect(sales.totals.orders).toBe(2);
    expect(sales.bySalesperson.map((s) => s.salesperson).sort()).toEqual(['mgr1', 'mgr2']);
    expect(sales.byMethod[0]).toMatchObject({ method: 'CASH', payments: 2 });
    expect(sales.totals.cashMinor).toBe(sales.totals.salesMinor);
    await expect(storeSales(db, 'STORE-DESK-9', { from: '2026-02-30x' })).rejects.toThrow(/YYYY-MM-DD/);
    const exp = await expectedCash(db, 'STORE-DESK-9', day);
    expect(exp).toBe(sales.totals.cashMinor);
    expect(exp).toBeGreaterThan(0);
    expect((await drawerStatus(db, 'STORE-DESK-9', day)).closing).toBeNull();
    await expect(closeDrawer(db, 'STORE-DESK-9', { date: day, countedMinor: exp - 500 }, 'mgr1')).rejects.toThrow(/add a note/i);
    const c = await closeDrawer(db, 'STORE-DESK-9', { date: day, countedMinor: exp - 500, note: 'a coin tray went missing' }, 'mgr1');
    expect(c).toMatchObject({ expectedMinor: exp, varianceMinor: -500, closedBy: 'mgr1' });
    await expect(closeDrawer(db, 'STORE-DESK-9', { date: day, countedMinor: exp }, 'mgr1')).rejects.toThrow(/already closed/);
    await expect(closeDrawer(db, 'STORE-DESK-9', { date: '2999-01-01', countedMinor: 1 }, 'mgr1')).rejects.toThrow(/started/);
    expect(await listClosings(db, 'STORE-DESK-9')).toHaveLength(1);
    void cash;
  });
});
