import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, getDb, type Db } from '@meridian/core';
import { setFiberHttp } from '@meridian/fiber';
import { dispatch } from './router';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username;
process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password;
process.env.MERIDIAN_SEED = 'none';
delete process.env.DATABASE_URL;
process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED = 'off';
const ORIGIN = 'http://fiber.test';

let db: Db; let cookie = ''; let key = '';
async function call(method: string, path: string, o: { body?: unknown; cookie?: string; key?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: 'fiber.test', 'content-type': 'application/json' };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  if (o.origin !== null && method !== 'GET') headers.origin = o.origin ?? ORIGIN;
  const res = await dispatch(new Request(ORIGIN + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), path.replace(/^\/(api\/)?/, '').split('?')[0]!.split('/'));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}
const admin = (m: string, p: string, body?: unknown) => call(m, `/api${p}`, { body, cookie });
const client = (m: string, p: string, body?: unknown) => call(m, p.startsWith('/tmf-api') ? p : `/api${p}`, { body, key });

beforeAll(async () => {
  db = await getDb();
  setFiberHttp(async () => Response.json({ covered: true, portStatus: 'OK', speedsMbps: [100, 500], leadDays: 9 }));
  const r = await call('POST', '/api/admin/login', { body: SU });
  if (!r.headers.get('set-cookie')) throw new Error(`login failed: ${JSON.stringify(r.json)}`);
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  key = (await createApiClient(db, 'test', { name: 'storefront', scopes: ['fiber'] })).key;
});
afterAll(async () => { setFiberHttp(null); await db.close(); });

describe('who may call what', () => {
  it('serves the liveness check and the module status to anyone, and refuses everything else without credentials', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200);
    expect((await call('GET', '/api/v1/coverage/status')).json).toEqual({ enabled: false });
    expect((await call('GET', '/api/admin/providers')).status).toBe(401);
    expect((await call('GET', '/api/v1/coverage/qualify-address?postalCode=238801')).status).toBe(401);
    expect((await call('GET', '/api/v1/coverage/qualify-address?postalCode=1', { key: 'mk_test_aaaaaaaaaa_' + 'x'.repeat(40) })).status).toBe(401);
    expect((await call('POST', '/api/admin/providers', { cookie, origin: 'http://evil.example', body: {} })).status).toBe(403);   // cross-site
    expect((await call('GET', '/api/nothing')).status).toBe(404);
    expect((await call('DELETE', '/api/admin/providers')).status).toBe(405);
  });
  it('turns the whole client API off with the module switch, and on again', async () => {
    const off = await client('GET', '/v1/coverage/qualify-address?postalCode=238801');
    expect(off.status).toBe(503); expect(off.json.error.code).toBe('MODULE_DISABLED');
    expect((await call('GET', '/tmf-api/serviceQualificationManagement/v4/serviceQualification', { key })).json).toMatchObject({ '@type': 'Error', reason: 'MODULE_DISABLED', status: '503' });
    expect((await admin('PUT', '/admin/module', { enabled: true })).json).toEqual({ enabled: true });
    expect((await call('GET', '/api/v1/coverage/status')).json).toEqual({ enabled: true });
  });
});

describe('the Fiber Ops hub and the client API end to end', () => {
  let own = '', partner = '', dp = '';
  it('sets up providers, a DP and addresses, and the engine answers from them', async () => {
    own = (await admin('POST', '/admin/providers', { code: 'OWN_FTTH', name: 'Own fibre', type: 'OWNED_INFRASTRUCTURE', installLeadDays: 4 })).json.id;
    const tm = await admin('POST', '/admin/providers', { code: 'TIME', name: 'Time dotCom', type: 'WHOLESALE_PARTNER', agreementId: 'WA-1', costPerPortMinor: 4000, adapterKind: 'REST', adapterUrl: 'https://partner.example.com/c', adapterSecret: 'tok', adapterEnabled: true, adapterConfig: { paths: { serviceable: 'covered' } } });
    expect(tm.status).toBe(201); expect(JSON.stringify(tm.json)).not.toContain('tok"'); expect(tm.json.hasAdapterSecret).toBe(true);
    partner = tm.json.id;
    expect((await admin('POST', '/admin/providers', { code: 'bad', name: 'x', type: 'OWNED_INFRASTRUCTURE' })).status).toBe(400);
    dp = (await admin('POST', '/admin/dps', { providerId: own, code: 'DP-1', name: 'DP one', lat: 1.3048, lng: 103.8318, splitterRatio: 4, radiusM: 200 })).json.id;
    expect((await admin('POST', '/admin/import', { format: 'CSV', apply: true, text: 'postalCode,street,building,lat,lng\n238801,Orchard Road,ION,1.3049,103.8319\n' })).json.applied).toBe(true);
    const test = await admin('POST', `/admin/providers/${partner}/test`, { lat: 1.3, lng: 103.8 });
    expect(test.json).toMatchObject({ ok: true, answer: { serviceable: true, speedsMbps: [100, 500], leadDays: 9 } });
    const r = await client('GET', '/v1/coverage/qualify-address?postalCode=238801&street=Orchard%20Road&building=ION&speedMbps=500');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ availability: 'AVAILABLE', location: { precision: 'ADDRESS' } });
    expect(r.json.options.map((o: any) => o.providerCode).sort()).toEqual(['OWN_FTTH', 'TIME']);
    expect(JSON.stringify(r.json)).not.toMatch(/costPerPort|agreement/);   // commercial terms stay inside
    expect((await client('POST', '/v1/coverage/qualify-address', { lat: 1.3048, lng: 103.8318 })).json.recommended.providerCode).toBe('OWN_FTTH');
    expect((await client('POST', '/v1/coverage/qualify-address', { lat: 500, lng: 0 })).status).toBe(400);
  });
  it('locks, confirms and releases a port, and shows it in the hub', async () => {
    const r = await client('POST', '/v1/coverage/reservations', { providerId: own, dpId: dp, customerRef: 'cust-1', speedMbps: 500 });
    expect(r.status).toBe(201); expect(r.json).toMatchObject({ state: 'ACTIVE' });
    expect((await admin('GET', `/admin/dps/${dp}/ports`)).json.items.map((p: any) => p.state).sort()).toEqual(['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'RESERVED_CHECKOUT']);
    expect((await client('POST', `/v1/coverage/reservations/${r.json.id}/confirm`, { orderRef: 'ORD-77' })).json).toMatchObject({ state: 'CONFIRMED' });
    expect((await client('GET', `/v1/coverage/reservations/${r.json.id}`)).json.orderRef).toBe('ORD-77');
    const r2 = await client('POST', '/v1/coverage/reservations', { providerId: own, dpId: dp, customerRef: 'cust-2' });
    expect((await client('POST', `/v1/coverage/reservations/${r2.json.id}/release`)).json.state).toBe('RELEASED');
    expect((await admin('GET', '/admin/reservations')).json.items).toHaveLength(2);
    expect((await admin('POST', '/admin/sweep')).json).toMatchObject({ released: 0 });
  });
  it('shows pressure, the waitlist and expansion requests', async () => {
    for (const c of ['a', 'b', 'c']) await client('POST', '/v1/coverage/reservations', { providerId: own, dpId: dp, customerRef: `fill-${c}` });
    expect((await client('POST', '/v1/coverage/reservations', { providerId: own, dpId: dp, customerRef: 'fill-d' })).status).toBe(409);
    expect((await client('POST', '/v1/coverage/waitlist', { providerId: own, dpId: dp, contact: 'w@example.com' })).status).toBe(201);
    const cap = (await admin('GET', '/admin/capacity')).json;
    expect(cap.summary).toMatchObject({ EXHAUSTED: 1, waiting: 1 }); expect(cap.items[0]).toMatchObject({ code: 'DP-1', level: 'EXHAUSTED', waiting: 1 });
    expect((await admin('POST', `/admin/dps/${dp}/expansion`, { note: 'add splitter' })).status).toBe(201);
    expect((await admin('POST', `/admin/dps/${dp}/expansion`, {})).status).toBe(409);
    const ex = (await admin('GET', '/admin/expansions')).json.items[0];
    expect((await admin('PATCH', `/admin/expansions/${ex.id}`, { status: 'DONE' })).json.status).toBe('DONE');
  });
  it('imports files, draws the map and edits settings and partner switches', async () => {
    const bad = await admin('POST', '/admin/import', { format: 'GEOJSON', apply: true, text: '{"type":"nope"}' });
    expect(bad.json.applied).toBe(false); expect(bad.json.errors.length).toBeGreaterThan(0);
    const poly = await admin('POST', '/admin/polygons', { providerId: partner, name: 'Hand-drawn', geometry: { type: 'Polygon', coordinates: [[[103.7, 1.3], [103.71, 1.3], [103.71, 1.31], [103.7, 1.31], [103.7, 1.3]]] } });
    expect(poly.status).toBe(201);
    expect((await admin('GET', '/admin/map')).json.features.some((f: any) => f.properties.layer === 'area')).toBe(true);
    expect((await admin('GET', '/admin/polygons')).json.items).toHaveLength(1);
    expect((await admin('DELETE', `/admin/polygons/${poly.json.id}`)).status).toBe(200);
    expect((await admin('GET', '/admin/import/templates')).json.dps).toContain('code,name,provider');
    expect((await admin('GET', '/admin/import/jobs')).json.items.length).toBeGreaterThan(1);
    expect((await admin('PATCH', '/admin/settings', { adapters: { TIME: false } })).json.adapters).toEqual({ TIME: false });
    expect((await admin('PATCH', '/admin/settings', { lockMinutes: 0 })).status).toBe(400);
    expect((await admin('PATCH', '/admin/settings', { adapters: {} })).status).toBe(200);
    const k = await admin('POST', '/admin/api-keys', { name: 'CRM' });
    expect(k.json.key).toMatch(/^mk_/);
    expect((await admin('GET', '/admin/api-keys')).json.items.length).toBeGreaterThanOrEqual(2);
    expect((await admin('DELETE', `/admin/api-keys/${k.json.client.id}`)).status).toBe(200);
    expect((await admin('DELETE', `/admin/providers/${own}`)).status).toBe(409);   // still has a DP
  });
  it('speaks TM Forum 645 and 673 with the TMF error shape', async () => {
    await admin('POST', '/admin/dps', { providerId: own, code: 'DP-2', name: 'DP two', lat: 1.3048, lng: 103.8318, splitterRatio: 4, radiusM: 200 });   // the first one is full by now
    const q = await client('POST', '/tmf-api/serviceQualificationManagement/v4/serviceQualification', { serviceQualificationItem: [{ service: { serviceCharacteristic: [{ name: 'speed', value: 500 }], place: [{ postcode: '238801', streetName: 'Orchard Road' }] } }] });
    expect(q.status).toBe(201);
    expect(q.json).toMatchObject({ '@type': 'ServiceQualification', state: 'done' });
    expect(q.json.href).toBe(`http://fiber.test/tmf-api/serviceQualificationManagement/v4/serviceQualification/${q.json.id}`);
    expect(q.json.serviceQualificationItem[0].qualificationItemResult).toBe('qualified');
    expect((await client('GET', `/tmf-api/serviceQualificationManagement/v4/serviceQualification/${q.json.id}`)).json.id).toBe(q.json.id);
    const addrs = await client('GET', '/tmf-api/geographicAddressManagement/v4/geographicAddress?postcode=238801');
    expect(addrs.json[0]).toMatchObject({ '@type': 'GeographicAddress', postcode: '238801' });
    expect((await client('POST', '/tmf-api/geographicAddressManagement/v4/geographicAddressValidation', { submittedGeographicAddress: { postcode: '238801' } })).json.validationResult).toMatch(/success|partial/);
    const bad = await client('POST', '/tmf-api/serviceQualificationManagement/v4/serviceQualification', { serviceQualificationItem: [] });
    expect(bad.status).toBe(400); expect(bad.json).toMatchObject({ '@type': 'Error', status: '400' });
  });
});
