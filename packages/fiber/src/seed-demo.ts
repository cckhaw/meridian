import type { Db } from '@meridian/core';
import { circleRing, type AreaGeometry } from './geo.js';
import { upsertAddress } from './gazetteer.js';
import { saveCabinet, saveDp, savePolygon } from './network.js';
import { saveProvider } from './providers.js';

/**
 * Sample Singapore coverage for demos and screenshots: an owned network with distribution points in a few estates (some nearly full, one exhausted), two wholesale
 * partners with coverage areas, and addresses to look up. Safe to run twice (it does nothing if the owned provider exists). Never run it against a production database.
 */
export async function seedFiberDemo(root: Db, actor = 'demo'): Promise<boolean> {
  return root.tx(async (db) => {
  if ((await db.query(`SELECT 1 FROM fiber_providers WHERE code='OWN_FTTH'`)).rows[0]) return false;
  const own = await saveProvider(db, actor, { code: 'OWN_FTTH', name: 'Meridian Fibre', type: 'OWNED_INFRASTRUCTURE', installLeadDays: 5, slaResponseHours: 24, speedTiersMbps: [100, 500, 1000, 2000] });
  const time = await saveProvider(db, actor, { code: 'TIME_DOTCOM', name: 'Time dotCom', type: 'WHOLESALE_PARTNER', agreementId: 'WA-2024-07', costPerPortMinor: 4500, installLeadDays: 10, slaResponseHours: 24, speedTiersMbps: [100, 500, 1000] });
  const netlink = await saveProvider(db, actor, { code: 'NETLINK', name: 'NetLink Trust', type: 'WHOLESALE_PARTNER', agreementId: 'NLT-0193', costPerPortMinor: 3900, installLeadDays: 14, slaResponseHours: 48, speedTiersMbps: [500, 1000, 2000] });
  const estates: Array<[string, string, number, number, number, number, number, string]> = [
    // name, city, lat, lng, DPs, used per DP, faulty per DP, postcode
    ['Orchard', 'Singapore', 1.3048, 103.8318, 3, 2, 0, '238801'], ['Marina Bay', 'Singapore', 1.2830, 103.8607, 2, 3, 1, '018956'], ['Tampines', 'Singapore', 1.3530, 103.9450, 3, 4, 1, '529510'],
    ['Jurong East', 'Singapore', 1.3330, 103.7430, 2, 5, 0, '609731'], ['Woodlands', 'Singapore', 1.4360, 103.7860, 2, 10, 0, '730001'],
  ];
  for (const [name, city, lat, lng, n, used, faulty, postal] of estates) {
    const cab = await saveCabinet(db, actor, { providerId: own.id, code: `CAB-${name.slice(0, 3).toUpperCase()}`, name: `${name} cabinet`, lat, lng, city });
    for (let i = 0; i < n; i++) {
      await saveDp(db, actor, { providerId: own.id, cabinetId: cab.id, code: `DP-${name.slice(0, 3).toUpperCase()}-${i + 1}`, name: `${name} DP ${i + 1}`, kind: i === 0 ? 'FDP' : 'DP', lat: lat + (i - 1) * 0.0022, lng: lng + (i % 2 ? 0.002 : -0.002), splitterRatio: i === 0 ? 16 : 8, radiusM: 180,
        usedPorts: Math.min(used + i, (i === 0 ? 16 : 8) - faulty), faultyPorts: faulty, city, postalCode: postal });
    }
    for (let k = 0; k < 4; k++) await upsertAddress(db, { postalCode: String(Number(postal) + k), street: `${name} Avenue ${k + 1}`, building: k % 2 ? `${name} Tower` : undefined, city, lat: lat + (k - 1.5) * 0.0015, lng: lng + (k - 1.5) * 0.0012 });
  }
  const box = (lat: number, lng: number, dLat: number, dLng: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] });
  await savePolygon(db, actor, { providerId: time.id, name: 'Time dotCom: Central', geometry: box(1.3, 103.84, 0.03, 0.04), source: 'IMPORT:demo' });
  await savePolygon(db, actor, { providerId: time.id, name: 'Time dotCom: East', geometry: box(1.35, 103.95, 0.02, 0.03), capacityStatus: 'EXHAUSTED', source: 'IMPORT:demo' });
  await savePolygon(db, actor, { providerId: netlink.id, name: 'NetLink: West', geometry: box(1.34, 103.72, 0.04, 0.05), speedTiersMbps: [1000, 2000], source: 'IMPORT:demo' });
  await savePolygon(db, actor, { providerId: netlink.id, name: 'NetLink: North', geometry: { type: 'Polygon', coordinates: [circleRing({ lat: 1.4360, lng: 103.7860 }, 1800)] }, source: 'IMPORT:demo' });
  return true;
  });
}
