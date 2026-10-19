import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@meridian/core';
import {
  CoverageService, DEFAULT_FIBER_SETTINGS, Tmf645Adapter, activateReservation, boxOf, cancelWaitlist, circleRing, classifyPorts, confirmReservation, distanceM, exhaustionReport, getFiberSettings, importCoverage, joinWaitlist, listPorts, mapFeatures,
  moduleEnabled, normalizeAddress, notifyWaitlist, parseAddressLine, parseGeoJson, parseKml, pointInArea, providerView, qualifyAddress, releaseReservation, requestExpansion, reservePort, saveCabinet, saveDp, savePolygon, saveProvider,
  setFiberHttp, setFiberSettings, setModuleEnabled, setPortState, sweepExpiredLocks, updateExpansion, upsertAddress, type AreaGeometry,
} from './index.js';

let db: Db;
let own: string, tm: string, allo: string;
beforeAll(async () => { db = await openDb({}); setFiberHttp(async () => Response.json({ data: { covered: false } })); });
afterAll(async () => { await db.close(); setFiberHttp(null); });

const square = (lng: number, lat: number, d = 0.01): AreaGeometry => ({ type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] });

describe('geometry', () => {
  it('measures distance, tests polygons with holes and reads GeoJSON and KML', () => {
    expect(Math.round(distanceM({ lat: 1.3, lng: 103.8 }, { lat: 1.3, lng: 103.81 }))).toBeGreaterThan(1100);
    const donut: AreaGeometry = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
    expect(pointInArea(donut, { lat: 1, lng: 1 })).toBe(true);
    expect(pointInArea(donut, { lat: 5, lng: 5 })).toBe(false);
    expect(boxOf(donut)).toEqual({ minLat: 0, maxLat: 10, minLng: 0, maxLng: 10 });
    expect(circleRing({ lat: 1, lng: 103 }, 100)).toHaveLength(33);
    const gj = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [103.8, 1.3] } }, { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0]]] } }] }));
    expect(gj.features).toHaveLength(1); expect(gj.errors[0]).toMatch(/Feature 2/);
    const kml = parseKml(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Area A</name><ExtendedData><Data name="provider"><value>ALLO</value></Data></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>103.80,1.30,0 103.81,1.30,0 103.81,1.31,0 103.80,1.31,0 103.80,1.30,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark><Placemark><name>P</name><Point><coordinates>103.8,1.3,0</coordinates></Point></Placemark></Document></kml>`);
    expect(kml.errors).toEqual([]); expect(kml.features.map((f) => f.kind)).toEqual(['AREA', 'POINT']); expect(kml.features[0]!.properties.provider).toBe('ALLO');
    expect(normalizeAddress({ postalCode: '238 801', street: 'Orchard Road' }).key).toBe(normalizeAddress({ postalCode: '238801', street: 'orchard rd.' }).key);
    expect(parseAddressLine('1 Orchard Road #05-01, Singapore 238801')).toMatchObject({ postalCode: '238801', unit: '05-01' });
  });
});

describe('providers, network and ports', () => {
  it('keeps providers with their commercial terms and never returns the adapter secret', async () => {
    const p = await saveProvider(db, 'planner', { code: 'OWN_FTTH', name: 'Meridian Fibre', type: 'OWNED_INFRASTRUCTURE', installLeadDays: 5 });
    own = p.id;
    const t = await saveProvider(db, 'planner', { code: 'TIME_DOTCOM', name: 'Time dotCom', type: 'WHOLESALE_PARTNER', agreementId: 'WA-2024-07', costPerPortMinor: 4500, installLeadDays: 10, slaResponseHours: 24, adapterKind: 'REST', adapterUrl: 'https://partner.example.com/coverage', adapterSecret: 's3cret', adapterEnabled: true,
      adapterConfig: { paths: { serviceable: 'data.covered', portStatus: 'data.ports', speedsMbps: 'data.speeds', leadDays: 'data.lead', reference: 'data.ref' } } });
    tm = t.id;
    allo = (await saveProvider(db, 'planner', { code: 'ALLO', name: 'Allo', type: 'WHOLESALE_PARTNER', installLeadDays: 14, speedTiersMbps: [300, 1000] })).id;
    expect(JSON.stringify(providerView(t))).not.toContain('s3cret');
    expect(providerView(t)).toMatchObject({ agreementId: 'WA-2024-07', costPerPortMinor: 4500, hasAdapterSecret: true });
    expect(providerView(t, false)).not.toHaveProperty('costPerPortMinor');
    await expect(saveProvider(db, 'planner', { code: 'ALLO', name: 'x', type: 'WHOLESALE_PARTNER' })).rejects.toThrow(/already exists/);
    await expect(saveProvider(db, 'planner', { code: 'bad code', name: 'x', type: 'WHOLESALE_PARTNER' })).rejects.toThrow(/capital letters/);
    await expect(saveProvider(db, 'planner', { code: 'NOURL', name: 'x', type: 'WHOLESALE_PARTNER', adapterKind: 'REST', adapterEnabled: true })).rejects.toThrow(/partner address/);
  });
  it('creates a DP with its ports, counts them by state, and refuses to shrink under busy ports', async () => {
    const cab = await saveCabinet(db, 'planner', { providerId: own, code: 'CAB-1', name: 'Orchard cabinet', lat: 1.3048, lng: 103.8318, city: 'Singapore' });
    const dp = await saveDp(db, 'planner', { providerId: own, cabinetId: cab.id, code: 'DP-1', name: 'Orchard DP 1', lat: 1.3048, lng: 103.8318, splitterRatio: 8, radiusM: 200, usedPorts: 3, faultyPorts: 1 });
    const ports = await listPorts(db, dp.id);
    expect(ports.map((p) => p.state).sort()).toEqual(['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'FAULTY', 'IN_USE', 'IN_USE', 'IN_USE', 'AVAILABLE'].sort());
    await expect(saveDp(db, 'planner', { providerId: own, code: 'DP-X', name: 'x', lat: 1, lng: 1, splitterRatio: 5 })).rejects.toThrow(/splitter/);
    await expect(saveDp(db, 'planner', { providerId: own, code: 'DP-X', name: 'x', lat: 1, lng: 1, splitterRatio: 8, usedPorts: 6, faultyPorts: 4 })).rejects.toThrow(/exceed/);
    await expect(saveDp(db, 'planner', { providerId: own, cabinetId: cab.id, code: 'DP-1', name: 'Orchard DP 1', lat: 1.3048, lng: 103.8318, splitterRatio: 2 }, dp.id)).rejects.toThrow(/in use or reserved/);
    const faulty = ports.find((p) => p.state === 'AVAILABLE')!;
    await setPortState(db, 'ops', faulty.id, 'FAULTY', 'cut fibre');
    await setPortState(db, 'ops', faulty.id, 'AVAILABLE');
    const inUse = ports.find((p) => p.state === 'IN_USE')!;
    await expect(setPortState(db, 'ops', inUse.id, 'FAULTY')).rejects.toThrow(/in use/);
  });
});

describe('serviceability', () => {
  it('answers from our own spatial data: covered with a free port, covered but full, and not covered', async () => {
    await upsertAddress(db, { postalCode: '238801', street: 'Orchard Road', building: 'ION Orchard', city: 'Singapore', lat: 1.3049, lng: 103.8319 });
    await upsertAddress(db, { postalCode: '238801', street: 'Orchard Road', building: 'Tower B', city: 'Singapore', lat: 1.3047, lng: 103.8317 });
    await upsertAddress(db, { postalCode: '999999', street: 'Faraway Lane', lat: 1.45, lng: 103.9 });
    const a = await qualifyAddress(db, { address: '2 Orchard Road ION Orchard #05-01 Singapore 238801', postalCode: '238801', building: 'ION Orchard', street: 'Orchard Road', speedMbps: 500 });
    expect(a.availability).toBe('AVAILABLE');
    expect(a.location.precision).toBe('ADDRESS');
    expect(a.recommended).toMatchObject({ providerCode: 'OWN_FTTH', status: 'AVAILABLE', ownerType: 'OWNED_INFRASTRUCTURE', estimatedInstallDays: 5, meetsRequestedSpeed: true, speedTiersMbps: [100, 500, 1000], ports: { available: 4, total: 8 }, source: 'OWNED_SPATIAL' });
    expect(a.recommended!.dp!.code).toBe('DP-1');
    // GPS in
    const g = await qualifyAddress(db, { lat: 1.3048, lng: 103.8318 });
    expect(g.location.precision).toBe('GPS'); expect(g.availability).toBe('AVAILABLE');
    // speed beyond every tier: covered but no option meets it
    expect((await qualifyAddress(db, { lat: 1.3048, lng: 103.8318, speedMbps: 10_000 })).availability).not.toBe('AVAILABLE');
    // postcode fallback
    expect((await qualifyAddress(db, { postalCode: '238801' })).location.precision).toBe('POSTCODE');
    // outside
    const far = await qualifyAddress(db, { postalCode: '999999' });
    expect(far.availability).toBe('UNSERVICEABLE'); expect(far.options.every((o) => o.status === 'UNSERVICEABLE')).toBe(true);   // the partner that was asked said no
    await expect(qualifyAddress(db, { address: 'Nowhere 000000' })).rejects.toThrow(/could not find that address/);
    await expect(qualifyAddress(db, {})).rejects.toThrow(/address or a postcode/);
    await expect(qualifyAddress(db, { lat: 95, lng: 0 })).rejects.toThrow(/within range/);
  });

  it('reads a partner live, remembers its answer for the cache time, and answers without a partner that fails', async () => {
    let calls = 0; let mode: 'ok' | 'down' | 'full' = 'ok'; let seen: any;
    setFiberHttp(async (url, init) => {
      calls++; seen = { url: String(url), auth: (init!.headers as Record<string, string>).Authorization, body: JSON.parse(String(init!.body)) };
      if (mode === 'down') return new Response('x', { status: 503 });
      return Response.json({ data: { covered: true, ports: mode === 'full' ? 'FULL' : 'OK', speeds: [100, 500, 2000], lead: 12, ref: 'TD-9' } });
    });
    const q1 = await qualifyAddress(db, { lat: 1.4, lng: 103.7 });
    const time = q1.options.find((o) => o.providerCode === 'TIME_DOTCOM')!;
    expect(time).toMatchObject({ status: 'AVAILABLE', speedTiersMbps: [100, 500, 2000], estimatedInstallDays: 12, source: 'PARTNER_LIVE', reference: 'TD-9', slaResponseHours: 24 });
    expect(seen).toMatchObject({ auth: 'Bearer s3cret', body: { lat: 1.4, lng: 103.7 } });
    const q2 = await qualifyAddress(db, { lat: 1.4, lng: 103.7 });
    expect(calls).toBe(1);
    expect(q2.options.find((o) => o.providerCode === 'TIME_DOTCOM')!.source).toBe('PARTNER_CACHE');
    await qualifyAddress(db, { lat: 1.4, lng: 103.7, refresh: true }); expect(calls).toBe(2);
    mode = 'full';
    const q3 = await qualifyAddress(db, { lat: 1.41, lng: 103.7 });
    expect(q3.availability).toBe('PORT_EXHAUSTED_WAITLIST'); expect(q3.options[0]).toMatchObject({ status: 'PORT_EXHAUSTED_WAITLIST' });
    mode = 'down';
    const q4 = await qualifyAddress(db, { lat: 1.42, lng: 103.7 });
    expect(q4.partial).toBe(true); expect(q4.partnerErrors[0]).toMatchObject({ provider: 'TIME_DOTCOM' }); expect(q4.availability).toBe('UNKNOWN');
    // a partner switched off in the admin hub is not called at all
    await setFiberSettings(db, 'planner', { adapters: { TIME_DOTCOM: false } });
    const before = calls;
    await qualifyAddress(db, { lat: 1.43, lng: 103.7 });
    expect(calls).toBe(before);
    await setFiberSettings(db, 'planner', { adapters: {} });
  });

  it('uses a partner’s imported coverage when it has no live adapter, with its own speed tiers', async () => {
    await savePolygon(db, 'planner', { providerId: allo, name: 'Allo Bukit', geometry: square(103.75, 1.35), speedTiersMbps: [300, 1000] });
    const r = await qualifyAddress(db, { lat: 1.35, lng: 103.75 });
    expect(r.recommended).toMatchObject({ providerCode: 'ALLO', source: 'PARTNER_IMPORT', speedTiersMbps: [300, 1000], estimatedInstallDays: 14, ports: null });
    await savePolygon(db, 'planner', { providerId: allo, name: 'Allo Full', geometry: square(103.6, 1.35), capacityStatus: 'EXHAUSTED' });
    expect((await qualifyAddress(db, { lat: 1.35, lng: 103.6 })).availability).toBe('PORT_EXHAUSTED_WAITLIST');
  });

  it('answers quickly', async () => {
    const t = Date.now();
    for (let i = 0; i < 20; i++) await qualifyAddress(db, { lat: 1.3048, lng: 103.8318 });
    expect((Date.now() - t) / 20).toBeLessThan(100);
  });
});

describe('port locks', () => {
  let dpId: string;
  beforeAll(async () => { dpId = (await saveDp(db, 'planner', { providerId: own, code: 'DP-LOCK', name: 'Lock DP', lat: 1.5, lng: 103.5, splitterRatio: 2, radiusM: 200 })).id; });

  it('never gives the same port to two checkouts, renews the same customer’s lock, and frees it on release or expiry', async () => {
    const [a, b, c] = await Promise.allSettled([reservePort(db, { providerId: own, dpId, customerRef: 'cust-A' }), reservePort(db, { providerId: own, dpId, customerRef: 'cust-B' }), reservePort(db, { providerId: own, dpId, customerRef: 'cust-C' })]);
    expect([a, b, c].filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    const lost = [a, b, c].find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(String(lost.reason.message)).toMatch(/Every port/);
    const rA = (a as PromiseFulfilledResult<any>).value;
    const ports = (await listPorts(db, dpId)).map((p) => p.state);
    expect(ports).toEqual(['RESERVED_CHECKOUT', 'RESERVED_CHECKOUT']);
    // the same customer again renews instead of taking a second port
    const again = await reservePort(db, { providerId: own, dpId, customerRef: 'cust-A' });
    expect(again.id).toBe(rA.id);
    expect(Number((await db.query(`SELECT count(*) AS n FROM fiber_ports WHERE dp_id=$1 AND state='RESERVED_CHECKOUT'`, [dpId])).rows[0]!.n)).toBe(2);
    // confirm for an order, activate when installed
    const conf = await confirmReservation(db, rA.id, 'ORD-1');
    expect(conf).toMatchObject({ state: 'CONFIRMED', orderRef: 'ORD-1', expiresAt: null });
    expect(await confirmReservation(db, rA.id, 'ORD-1')).toMatchObject({ state: 'CONFIRMED' });
    await expect(confirmReservation(db, rA.id, 'ORD-2')).rejects.toThrow(/confirmed/);
    expect((await listPorts(db, dpId)).map((p) => p.state).sort()).toEqual(['RESERVED_CHECKOUT', 'RESERVED_ORDER']);
    await activateReservation(db, rA.id);
    expect((await listPorts(db, dpId)).map((p) => p.state).sort()).toEqual(['IN_USE', 'RESERVED_CHECKOUT']);
    // release the other and it is free again
    const other = (await db.query(`SELECT id FROM fiber_reservations WHERE dp_id=$1 AND state='ACTIVE'`, [dpId])).rows[0]!.id;
    await releaseReservation(db, other);
    expect((await listPorts(db, dpId)).map((p) => p.state).sort()).toEqual(['AVAILABLE', 'IN_USE']);
    // an expired lock cannot be confirmed and is swept
    const r = await reservePort(db, { providerId: own, dpId, customerRef: 'cust-D' });
    await db.query(`UPDATE fiber_reservations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [r.id]);
    await db.query(`UPDATE fiber_ports SET reserved_until = now() - interval '1 minute' WHERE reservation_id=$1`, [r.id]);
    expect((await listPorts(db, dpId)).map((p) => p.state).sort()).toEqual(['AVAILABLE', 'IN_USE']);   // already counts as free
    await expect(confirmReservation(db, r.id, 'ORD-3')).rejects.toThrow(/ran out/);
    expect(await sweepExpiredLocks(db)).toEqual({ released: 1 });
    expect((await db.query('SELECT state FROM fiber_reservations WHERE id=$1', [r.id])).rows[0]!.state).toBe('EXPIRED');
  });
  it('holds a soft lock for a partner with no port inventory', async () => {
    const r = await reservePort(db, { providerId: tm, customerRef: 'cust-E', speedMbps: 500 });
    expect(r).toMatchObject({ state: 'ACTIVE', portId: null, dpId: null });
    await releaseReservation(db, r.id);
  });
});

describe('waitlist, dashboard and expansion', () => {
  it('ranks distribution points by pressure, notifies the first in line when a port frees up, and tracks one expansion request', async () => {
    const dp = (await db.query(`SELECT id FROM fiber_dps WHERE code='DP-LOCK'`)).rows[0]!.id;
    const rep = await exhaustionReport(db);
    expect(rep.items.find((x) => x.code === 'DP-LOCK')).toMatchObject({ available: 1, inUse: 1, level: 'LOW' });
    const full = await reservePort(db, { providerId: own, dpId: dp, customerRef: 'cust-F' });
    expect((await exhaustionReport(db)).items[0]).toMatchObject({ code: 'DP-LOCK', level: 'EXHAUSTED' });
    const w1 = await joinWaitlist(db, { providerId: own, dpId: dp, contact: 'a@example.com', address: '1 Lock St' });
    expect((await joinWaitlist(db, { providerId: own, dpId: dp, contact: 'a@example.com' })).id).toBe(w1.id);   // no duplicates
    await joinWaitlist(db, { providerId: own, dpId: dp, contact: 'b@example.com' });
    await expect(joinWaitlist(db, { providerId: own, dpId: dp })).rejects.toThrow(/way to reach/);
    expect((await exhaustionReport(db)).items[0]).toMatchObject({ waiting: 2 });
    await expect(notifyWaitlist(db, dp, 'ops')).rejects.toThrow(/no free port/);
    const ex = await requestExpansion(db, 'planner', dp, 'Add a splitter');
    expect(ex).toMatchObject({ waiting: 2, status: 'OPEN' });
    await expect(requestExpansion(db, 'planner', dp)).rejects.toThrow(/already open/);
    expect((await exhaustionReport(db)).items[0]!.expansion).toMatchObject({ status: 'OPEN' });
    await releaseReservation(db, full.id);
    expect(await notifyWaitlist(db, dp, 'ops')).toEqual({ notified: 1 });
    expect((await db.query(`SELECT contact FROM fiber_waitlist WHERE status='NOTIFIED'`)).rows.map((r) => r.contact)).toEqual(['a@example.com']);
    expect((await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='FIBER_PORT_AVAILABLE'`)).rows).toHaveLength(1);
    await cancelWaitlist(db, (await db.query(`SELECT id FROM fiber_waitlist WHERE status='WAITING'`)).rows[0]!.id);
    expect(await updateExpansion(db, 'planner', ex.id, 'DONE')).toMatchObject({ status: 'DONE' });
  });
});

describe('bulk import', () => {
  it('checks without changing anything, then loads all or nothing, and updates on a second load', async () => {
    const csv = 'code,name,provider,cabinet,lat,lng,splitter,radiusM,usedPorts\nIMP-1,Import one,ALLO,C9,1.6,103.9,16,120,5\nIMP-2,Import two,ALLO,,1.61,103.91,8,100,0\n';
    const check = await importCoverage(db, { format: 'CSV', text: csv, apply: false, actor: 'planner' });
    expect(check).toMatchObject({ applied: false, errors: [], summary: { dps: { create: 2, update: 0 } } });
    expect(Number((await db.query(`SELECT count(*) AS n FROM fiber_dps WHERE code LIKE 'IMP-%'`)).rows[0]!.n)).toBe(0);
    const bad = await importCoverage(db, { format: 'CSV', text: csv + 'IMP-3,Bad,NOPE,,1.6,103.9,8,100,0\nIMP-4,Bad 2,ALLO,,xx,103.9,8,100,0\n', apply: true, actor: 'planner' });
    expect(bad.applied).toBe(false); expect(bad.errors.join(' ')).toMatch(/no provider with code NOPE/); expect(bad.errors.join(' ')).toMatch(/latitude and longitude/);
    expect(Number((await db.query(`SELECT count(*) AS n FROM fiber_dps WHERE code LIKE 'IMP-%'`)).rows[0]!.n)).toBe(0);
    const ok = await importCoverage(db, { format: 'CSV', text: csv, apply: true, actor: 'planner' });
    expect(ok).toMatchObject({ applied: true, summary: { dps: { create: 2 } } });
    expect((await db.query(`SELECT count(*) FILTER (WHERE p.state='IN_USE')::int AS used FROM fiber_ports p JOIN fiber_dps d ON d.id=p.dp_id WHERE d.code='IMP-1'`)).rows[0]!.used).toBe(5);
    expect((await importCoverage(db, { format: 'CSV', text: csv.replace('Import one', 'Import 1 renamed'), apply: true, actor: 'planner' })).summary.dps).toEqual({ create: 0, update: 2 });
    const geo = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Import area', provider: 'ALLO', speedTiers: '300,1000', dp: 'IMP-1' }, geometry: square(103.9, 1.6) }, { type: 'Feature', properties: { code: 'IMP-9', name: 'Nine', provider: 'ALLO' }, geometry: { type: 'Point', coordinates: [103.95, 1.65] } }] });
    expect(await importCoverage(db, { format: 'GEOJSON', text: geo, apply: true, actor: 'planner' })).toMatchObject({ applied: true, summary: { areas: { create: 1 }, dps: { create: 1 } } });
    const r = await qualifyAddress(db, { lat: 1.6, lng: 103.9 });
    expect(r.recommended).toMatchObject({ providerCode: 'ALLO', status: 'AVAILABLE', speedTiersMbps: [300, 1000] });
    const kml = `<kml><Placemark><name>KML area</name><ExtendedData><Data name="provider"><value>ALLO</value></Data></ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>103.2,1.2 103.3,1.2 103.3,1.3 103.2,1.3 103.2,1.2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    expect((await importCoverage(db, { format: 'KML', text: kml, apply: true, actor: 'planner' })).summary.areas.create).toBe(1);
    const addr = await importCoverage(db, { format: 'CSV', text: 'postalCode,street,building,city,lat,lng\n119999,Kent Ridge Dr,NUS,Singapore,1.2966,103.7764\n', apply: true, actor: 'planner' });
    expect(addr.summary.addresses.create).toBe(1);
    expect((await qualifyAddress(db, { postalCode: '119999' })).location.precision).toBe('POSTCODE');
  });
  it('draws everything on the map', async () => {
    const fc: any = await mapFeatures(db);
    const layers = new Set(fc.features.map((f: any) => f.properties.layer));
    expect([...layers].sort()).toEqual(['area', 'cabinet', 'dp', 'reach']);
  });
});

describe('low-port classification', () => {
  const set = { lowPortsAbsolute: 2, lowPortsPercent: 15 };
  const c = (available: number, total = 32, faulty = 0) => ({ available, total, faulty });
  it('is exhausted only when nothing is free, whatever the thresholds', () => {
    expect(classifyPorts(c(0), set)).toBe('EXHAUSTED');
    expect(classifyPorts(c(0, 0), { lowPortsAbsolute: 0, lowPortsPercent: 0 })).toBe('EXHAUSTED');
    expect(classifyPorts(c(1), { lowPortsAbsolute: 0, lowPortsPercent: 0 })).toBe('OK');
  });
  it('is low at or under the count threshold, even when the share is large', () => {
    expect(classifyPorts(c(2, 4), set)).toBe('LOW');                                   // 50% free but only 2
    expect(classifyPorts(c(3, 100), { lowPortsAbsolute: 3, lowPortsPercent: 0 })).toBe('LOW');
    expect(classifyPorts(c(4, 100), { lowPortsAbsolute: 3, lowPortsPercent: 0 })).toBe('OK');
  });
  it('is low at or under the share threshold, even when the count is large', () => {
    expect(classifyPorts(c(15, 100), { lowPortsAbsolute: 0, lowPortsPercent: 15 })).toBe('LOW');   // exactly 15%
    expect(classifyPorts(c(16, 100), { lowPortsAbsolute: 0, lowPortsPercent: 15 })).toBe('OK');
    expect(classifyPorts(c(40, 400), set)).toBe('LOW');                                 // 10% of 400 is 40 ports
  });
  it('treats either threshold as enough, and needs both to be missed for OK', () => {
    expect(classifyPorts(c(3, 20), set)).toBe('LOW');                                   // 15% exactly, 3 > 2
    expect(classifyPorts(c(3, 19), set)).toBe('OK');                                    // 15.8% and 3 > 2
    expect(classifyPorts(c(2, 100), { lowPortsAbsolute: 1, lowPortsPercent: 1 })).toBe('OK');
  });
  it('leaves faulty ports out of the share, and never divides by zero', () => {
    expect(classifyPorts(c(3, 20, 5), { lowPortsAbsolute: 0, lowPortsPercent: 20 })).toBe('LOW');   // 3 of 15 usable = 20%
    expect(classifyPorts(c(3, 20, 0), { lowPortsAbsolute: 0, lowPortsPercent: 20 })).toBe('LOW');   // 15%
    expect(classifyPorts(c(4, 20, 5), { lowPortsAbsolute: 0, lowPortsPercent: 20 })).toBe('OK');    // 4 of 15 = 26.7% (would be 20% with no faults)
    expect(classifyPorts(c(1, 5, 5), { lowPortsAbsolute: 0, lowPortsPercent: 50 })).toBe('OK');     // all faulty: usable floors at 1, so 100%
  });
  it('colours the map and the Ports and waitlist page from the same settings, and tells the map which', async () => {
    const dp = (await db.query(`SELECT d.id, d.code FROM fiber_dps d WHERE (SELECT count(*) FROM fiber_ports p WHERE p.dp_id=d.id) >= 4 LIMIT 1`)).rows[0]!;
    const before = await getFiberSettings(db);
    try {
      for (const s of [{ lowPortsAbsolute: 0, lowPortsPercent: 0 }, { lowPortsAbsolute: 64, lowPortsPercent: 0 }, { lowPortsAbsolute: 0, lowPortsPercent: 100 }, { lowPortsAbsolute: 2, lowPortsPercent: 15 }]) {
        await setFiberSettings(db, 'planner', s);
        const fc: any = await mapFeatures(db);
        expect(fc.settings).toEqual(s);
        const onMap = new Map<string, string>(fc.features.filter((f: any) => f.properties.layer === 'dp').map((f: any) => [f.properties.id, f.properties.level]));
        const report = await exhaustionReport(db);
        for (const r of report.items) if (onMap.has(r.dpId)) expect(onMap.get(r.dpId)).toBe(r.level);
        expect(onMap.has(dp.id)).toBe(true);
      }
    } finally { await setFiberSettings(db, 'planner', { lowPortsAbsolute: before.lowPortsAbsolute, lowPortsPercent: before.lowPortsPercent }); }
  });
});

describe('TM Forum 645 and 673', () => {
  it('qualifies an address in the TMF 645 shape and can fetch it again', async () => {
    const tmf = new Tmf645Adapter(db, 'https://fiber.example.com');
    const q = await tmf.check({ serviceQualificationItem: [
      { id: '1', service: { serviceCharacteristic: [{ name: 'downloadSpeed', value: 500 }], place: [{ '@type': 'GeographicAddress', geographicLocation: { geometry: { type: 'Point', coordinates: [103.8318, 1.3048] } } }] } },
      { id: '2', service: { place: [{ postcode: '999999' }] } },
    ] }, 'storefront') as any;
    expect(q).toMatchObject({ '@type': 'ServiceQualification', state: 'done', href: expect.stringContaining('https://fiber.example.com/tmf-api/serviceQualificationManagement/v4/serviceQualification/') });
    expect(q.serviceQualificationItem[0]).toMatchObject({ qualificationItemResult: 'qualified', state: 'approved' });
    expect(q.serviceQualificationItem[0].alternateServiceProposal[0].service.serviceCharacteristic).toContainEqual({ name: 'provider', value: 'OWN_FTTH' });
    expect(q.serviceQualificationItem[1]).toMatchObject({ qualificationItemResult: 'unqualified', eligibilityUnavailabilityReason: [{ code: 'NO_COVERAGE' }] });
    expect(await tmf.retrieve(q.id)).toEqual(q);
    expect((await tmf.list(5)).length).toBeGreaterThan(0);
    await expect(tmf.check({ serviceQualificationItem: [] })).rejects.toThrow(/required/);
    await expect(tmf.retrieve('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
  });
  it('searches and validates geographic addresses (TMF 673)', async () => {
    const tmf = new Tmf645Adapter(db, 'https://fiber.example.com');
    const list = await tmf.addresses({ postcode: '238801' }) as any[];
    expect(list).toHaveLength(2); expect(list[0]).toMatchObject({ '@type': 'GeographicAddress', postcode: '238801', geographicLocation: { geometry: { type: 'Point' } } });
    expect(await tmf.address(list[0].id)).toMatchObject({ id: list[0].id });
    const ok = await tmf.validate({ submittedGeographicAddress: { postcode: '238801', streetName: 'Orchard Road', geographicSubAddress: [{ buildingName: 'ION Orchard' }] } }) as any;
    expect(ok).toMatchObject({ validationResult: 'success', validGeographicAddress: { postcode: '238801' } });
    expect(await tmf.validate({ submittedGeographicAddress: { postcode: '238801' } })).toMatchObject({ validationResult: 'partial' });
    expect(await tmf.validate({ submittedGeographicAddress: { postcode: '000000' } })).toMatchObject({ validationResult: 'fail' });
  });
});

describe('module switch and settings', () => {
  it('starts from the environment flag, then follows what an administrator set, and checks the settings', async () => {
    delete process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED;
    expect(await moduleEnabled(db)).toBe(true);   // unset: on, so existing deployments keep selling fibre
    process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED = 'off';
    expect(await moduleEnabled(db)).toBe(false);
    process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED = 'ON';
    expect(await moduleEnabled(db)).toBe(true);
    await setModuleEnabled(db, 'admin', false);
    expect(await moduleEnabled(db)).toBe(false);   // the stored choice wins over the environment
    const svc = new CoverageService(db);
    await svc.setEnabled('admin', true);
    expect(await svc.enabled()).toBe(true);
    delete process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED;
    expect(await getFiberSettings(db)).toEqual(DEFAULT_FIBER_SETTINGS);
    await expect(setFiberSettings(db, 'admin', { lockMinutes: 0 })).rejects.toThrow(/checkout lock/);
    expect((await setFiberSettings(db, 'admin', { lockMinutes: 15 })).lockMinutes).toBe(15);
    await setFiberSettings(db, 'admin', { lockMinutes: 30 });
  });
});
