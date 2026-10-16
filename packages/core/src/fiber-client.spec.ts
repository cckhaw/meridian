import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { fiberConfirmLock, fiberModuleEnabled, fiberQualify, fiberReserve, fiberStatus, fiberVerifyLock, hiddenFixedKinds, setFiberFetch, setFiberModuleEnabled } from './fiber-client.js';
import { pageOffers } from './catalog.js';
import { priceBasket } from './order-pricing.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); setFiberFetch(null); });
afterEach(() => { setFiberFetch(null); });
process.env.MERIDIAN_FIBER_URL = 'https://fiber.example.com';
process.env.MERIDIAN_FIBER_API_KEY = 'mk_test_aaaaaaaaaa_' + 'k'.repeat(40);

describe('the module switch', () => {
  it('starts from the environment, then follows the administrator, and hides fixed broadband from sale while off', async () => {
    delete process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED;
    expect(await fiberModuleEnabled(db)).toBe(true);   // unset: fibre stays on sale, as before the module existed
    process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED = 'off';
    expect(await fiberModuleEnabled(db)).toBe(false);
    expect(await hiddenFixedKinds(db)).toContain('FIBER');
    const listed = async (extra: object = {}) => (await pageOffers(db, { status: 'ACTIVE', ...extra, limit: 100 })).items.map((o) => o.id);
    expect(await listed()).toContain('fiber-1g');                       // the catalogue pages still show it
    expect(await listed({ step: 'PLAN' })).not.toContain('fiber-1g');   // but nothing for sale does
    expect(await listed({ forSale: true, kind: 'FIBER' })).toEqual([]);
    const c = await newCustomer(db);
    await expect(priceBasket(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'fiber-1g' }], payment: { method: 'CASH' } })).rejects.toThrow(/not on sale/);
    await setFiberModuleEnabled(db, 'admin', true);
    expect(await fiberModuleEnabled(db)).toBe(true);
    expect(await hiddenFixedKinds(db)).toEqual([]);
    expect(await listed({ step: 'PLAN' })).toContain('fiber-1g');
    expect((await priceBasket(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'fiber-1g' }], payment: { method: 'CASH' } })).lines).toHaveLength(1);
    expect(await fiberStatus(db)).toMatchObject({ enabled: true, configured: true, host: 'fiber.example.com' });
    await setFiberModuleEnabled(db, 'admin', false);
    expect(await fiberModuleEnabled(db)).toBe(false);
  });
});

describe('the coverage client', () => {
  const calls: Array<{ url: string; method: string; auth: string; body: any }> = [];
  const reply = (status: number, json: unknown) => setFiberFetch(async (url, init) => { calls.push({ url: String(url), method: init!.method!, auth: (init!.headers as Record<string, string>).authorization!, body: init!.body ? JSON.parse(String(init!.body)) : undefined }); return new Response(JSON.stringify(json), { status }); });
  it('refuses while the module is off, and otherwise calls the service with the key', async () => {
    await setFiberModuleEnabled(db, 'admin', false);
    await expect(fiberQualify(db, { postalCode: '238801' })).rejects.toThrow(/switched off/);
    await setFiberModuleEnabled(db, 'admin', true);
    reply(200, { availability: 'AVAILABLE', options: [] });
    expect(await fiberQualify(db, { postalCode: '238801', speedMbps: 500 })).toMatchObject({ availability: 'AVAILABLE' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://fiber.example.com/api/v1/coverage/qualify-address', method: 'POST', body: { postalCode: '238801', speedMbps: 500 } });
    expect(calls.at(-1)!.auth).toMatch(/^Bearer mk_test_/);
  });
  it('turns the service being down into a message the order screen can show, and a lost port into a conflict', async () => {
    reply(503, { error: { code: 'MODULE_DISABLED', message: 'off' } });
    await expect(fiberQualify(db, { postalCode: '1' })).rejects.toThrow(/not available right now/);
    setFiberFetch(async () => { throw new Error('ECONNREFUSED'); });
    await expect(fiberQualify(db, { postalCode: '1' })).rejects.toThrow(/not available right now/);
    reply(409, { error: { code: 'CONFLICT', message: 'Every port on that distribution point is taken.' } });
    await expect(fiberReserve(db, { providerId: '00000000-0000-0000-0000-000000000001', dpId: '00000000-0000-0000-0000-000000000002' })).rejects.toThrow(/taken/);
  });
  it('checks that a held port is still held before an order, and confirms it afterwards without ever failing the order', async () => {
    reply(200, { state: 'ACTIVE', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await fiberVerifyLock(db, '11111111-1111-1111-1111-111111111111');
    reply(200, { state: 'ACTIVE', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(fiberVerifyLock(db, 'x')).rejects.toThrow(/released/);
    reply(200, { state: 'CONFIRMED', expiresAt: null });
    await expect(fiberVerifyLock(db, 'x')).rejects.toThrow(/already taken/);
    await fiberVerifyLock(db, undefined);   // nothing held: nothing to check
    reply(200, { state: 'CONFIRMED' });
    expect(await fiberConfirmLock(db, 'res-1', 'ORD-1', 'agent')).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: 'https://fiber.example.com/api/v1/coverage/reservations/res-1/confirm', body: { orderRef: 'ORD-1' } });
    reply(422, { error: { message: 'The port lock ran out' } });
    expect(await fiberConfirmLock(db, 'res-2', 'ORD-2', 'agent')).toBe(false);
    expect((await db.query(`SELECT action FROM audit_log WHERE entity_id='ORD-2'`)).rows[0]!.action).toBe('FIBER_CONFIRM_FAILED');
    await setFiberModuleEnabled(db, 'admin', false);
    await fiberVerifyLock(db, 'anything');   // module off: no call, no check
  });
});
