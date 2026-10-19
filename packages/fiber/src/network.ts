import { audit, conflict, invalid, notFound, rejected, type Queryable, type Row } from '@meridian/core';
import { boxOf, circleRing, ll, type AreaGeometry } from './geo.js';
import { classifyPorts } from './port-level.js';
import { getFiberSettings } from './settings.js';

export const PORT_STATES = ['AVAILABLE', 'RESERVED_CHECKOUT', 'RESERVED_ORDER', 'IN_USE', 'FAULTY'] as const;
export type PortState = (typeof PORT_STATES)[number];
export const SPLITTER_RATIOS = [2, 4, 8, 16, 32, 64] as const;

const lat = (v: unknown) => { if (typeof v !== 'number' || !(v >= -90 && v <= 90)) throw invalid('Latitude is a number from -90 to 90.'); return v; };
const lng = (v: unknown) => { if (typeof v !== 'number' || !(v >= -180 && v <= 180)) throw invalid('Longitude is a number from -180 to 180.'); return v; };
const dup = (e: unknown, what: string): never => { if ((e as { code?: string }).code === '23505') throw conflict(`${what} already exists.`); throw e as Error; };

// ───────────────────────── cabinets ─────────────────────────
export interface CabinetInput { providerId: string; code: string; name: string; lat: number; lng: number; state?: string; city?: string; postalCode?: string; status?: string }
export async function saveCabinet(q: Queryable, actor: string, i: CabinetInput, id?: string): Promise<Row> {
  if (!/^[A-Za-z0-9_.\-/]{1,40}$/.test(i.code ?? '')) throw invalid('The cabinet code is up to 40 letters, digits or - _ . /');
  if (!i.name?.trim()) throw invalid('Give the cabinet a name.');
  lat(i.lat); lng(i.lng);
  try {
    const r = id
      ? (await q.query(`UPDATE fiber_cabinets SET provider_id=$2, code=$3, name=$4, lat=$5, lng=$6, state=$7, city=$8, postal_code=$9, status=$10 WHERE id=$1 RETURNING *`, [id, i.providerId, i.code, i.name.trim(), i.lat, i.lng, i.state ?? null, i.city ?? null, i.postalCode ?? null, i.status ?? 'ACTIVE'])).rows[0]
      : (await q.query(`INSERT INTO fiber_cabinets (provider_id, code, name, lat, lng, state, city, postal_code, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [i.providerId, i.code, i.name.trim(), i.lat, i.lng, i.state ?? null, i.city ?? null, i.postalCode ?? null, i.status ?? 'ACTIVE'])).rows[0];
    if (!r) throw notFound('cabinet', id!);
    await audit(q, actor, 'fiber_cabinet', r.id, id ? 'UPDATE' : 'CREATE', { code: i.code });
    return r;
  } catch (e) { return dup(e, 'A cabinet with that code for this provider'); }
}
export const listCabinets = async (q: Queryable, providerId?: string): Promise<Row[]> => (await q.query(`SELECT * FROM fiber_cabinets ${providerId ? 'WHERE provider_id=$1' : ''} ORDER BY code`, providerId ? [providerId] : [])).rows;

// ───────────────────────── distribution points ─────────────────────────
export interface DpInput {
  providerId: string; cabinetId?: string | null; code: string; name: string; kind?: 'FDP' | 'DP'; lat: number; lng: number; splitterRatio?: number; radiusM?: number;
  address?: string; state?: string; city?: string; postalCode?: string; status?: string;
  /** Ports already in use or faulty when the DP is created (from an import of existing inventory). */
  usedPorts?: number; faultyPorts?: number;
}
export async function saveDp(q: Queryable, actor: string, i: DpInput, id?: string): Promise<Row> {
  if (!/^[A-Za-z0-9_.\-/]{1,40}$/.test(i.code ?? '')) throw invalid('The DP code is up to 40 letters, digits or - _ . /');
  if (!i.name?.trim()) throw invalid('Give the distribution point a name.');
  lat(i.lat); lng(i.lng);
  const ratio = i.splitterRatio ?? 8;
  if (!(SPLITTER_RATIOS as readonly number[]).includes(ratio)) throw invalid(`The splitter is 1:${SPLITTER_RATIOS.join(', 1:')}.`);
  const radius = i.radiusM ?? 150;
  if (!Number.isInteger(radius) || radius < 10 || radius > 5000) throw invalid('The coverage radius is 10 to 5,000 metres.');
  const used = i.usedPorts ?? 0, faulty = i.faultyPorts ?? 0;
  if (!Number.isInteger(used) || !Number.isInteger(faulty) || used < 0 || faulty < 0 || used + faulty > ratio) throw invalid(`Used and faulty ports together cannot exceed the splitter size (${ratio}).`);
  try {
    if (id) {
      const have = Number((await q.query('SELECT count(*) AS n FROM fiber_ports WHERE dp_id=$1', [id])).rows[0]!.n);
      if (ratio < have) {
        const busy = Number((await q.query(`SELECT count(*) AS n FROM fiber_ports WHERE dp_id=$1 AND port_no > $2 AND state <> 'AVAILABLE'`, [id, ratio])).rows[0]!.n);
        if (busy) throw rejected('Ports above the new splitter size are in use or reserved. Free them before making the splitter smaller.');
        await q.query('DELETE FROM fiber_ports WHERE dp_id=$1 AND port_no > $2', [id, ratio]);
      } else if (ratio > have) await q.query(`INSERT INTO fiber_ports (dp_id, port_no) SELECT $1, g FROM generate_series($2::int + 1, $3::int) g`, [id, have, ratio]);
      const r = (await q.query(`UPDATE fiber_dps SET provider_id=$2, cabinet_id=$3, code=$4, name=$5, kind=$6, lat=$7, lng=$8, splitter_ratio=$9, radius_m=$10, address=$11, state=$12, city=$13, postal_code=$14, status=$15 WHERE id=$1 RETURNING *`,
        [id, i.providerId, i.cabinetId ?? null, i.code, i.name.trim(), i.kind ?? 'DP', i.lat, i.lng, ratio, radius, i.address ?? null, i.state ?? null, i.city ?? null, i.postalCode ?? null, i.status ?? 'ACTIVE'])).rows[0];
      if (!r) throw notFound('distribution point', id);
      await audit(q, actor, 'fiber_dp', id, 'UPDATE', { code: i.code, splitter: ratio });
      return r;
    }
    const r = (await q.query(`INSERT INTO fiber_dps (provider_id, cabinet_id, code, name, kind, lat, lng, splitter_ratio, radius_m, address, state, city, postal_code, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [i.providerId, i.cabinetId ?? null, i.code, i.name.trim(), i.kind ?? 'DP', i.lat, i.lng, ratio, radius, i.address ?? null, i.state ?? null, i.city ?? null, i.postalCode ?? null, i.status ?? 'ACTIVE'])).rows[0]!;
    await q.query(`INSERT INTO fiber_ports (dp_id, port_no, state) SELECT $1, g, CASE WHEN g <= $3::int THEN 'IN_USE' WHEN g <= $3::int + $4::int THEN 'FAULTY' ELSE 'AVAILABLE' END FROM generate_series(1, $2::int) g`, [r.id, ratio, used, faulty]);
    await audit(q, actor, 'fiber_dp', r.id, 'CREATE', { code: i.code, splitter: ratio });
    return r;
  } catch (e) { return dup(e, 'A distribution point with that code for this provider'); }
}

const COUNTS = `count(*) FILTER (WHERE p.state='AVAILABLE' OR (p.state='RESERVED_CHECKOUT' AND p.reserved_until < now()))::int AS available,
  count(*) FILTER (WHERE p.state='RESERVED_CHECKOUT' AND p.reserved_until >= now())::int AS reserved_checkout, count(*) FILTER (WHERE p.state='RESERVED_ORDER')::int AS reserved_order,
  count(*) FILTER (WHERE p.state='IN_USE')::int AS in_use, count(*) FILTER (WHERE p.state='FAULTY')::int AS faulty, count(*)::int AS total`;
export async function listDps(q: Queryable, f: { providerId?: string; limit?: number } = {}): Promise<Row[]> {
  return (await q.query(
    `SELECT d.*, pr.code AS provider_code, pr.name AS provider_name, ${COUNTS} FROM fiber_dps d JOIN fiber_providers pr ON pr.id=d.provider_id LEFT JOIN fiber_ports p ON p.dp_id=d.id
      ${f.providerId ? 'WHERE d.provider_id=$2' : ''} GROUP BY d.id, pr.code, pr.name ORDER BY d.code LIMIT $1`, f.providerId ? [Math.min(f.limit ?? 1000, 5000), f.providerId] : [Math.min(f.limit ?? 1000, 5000)])).rows;
}
export async function getDp(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query(`SELECT d.*, ${COUNTS} FROM fiber_dps d LEFT JOIN fiber_ports p ON p.dp_id=d.id WHERE d.id=$1 GROUP BY d.id`, [id])).rows[0];
  if (!r) throw notFound('distribution point', id);
  return r;
}
export async function listPorts(q: Queryable, dpId: string): Promise<Row[]> {
  return (await q.query(`SELECT id, port_no, CASE WHEN state='RESERVED_CHECKOUT' AND reserved_until < now() THEN 'AVAILABLE' ELSE state END AS state, reserved_until, reservation_id, note FROM fiber_ports WHERE dp_id=$1 ORDER BY port_no`, [dpId])).rows;
}
/** Marks a port faulty or healthy by hand. A port that is reserved or in use is released through its reservation, not here. */
export async function setPortState(q: Queryable, actor: string, portId: string, to: 'AVAILABLE' | 'FAULTY', note?: string): Promise<Row> {
  if (to !== 'AVAILABLE' && to !== 'FAULTY') throw invalid('A port is marked available or faulty.');
  const p = (await q.query('SELECT * FROM fiber_ports WHERE id=$1 FOR UPDATE', [portId])).rows[0];
  if (!p) throw notFound('port', portId);
  if (['RESERVED_ORDER', 'IN_USE'].includes(p.state) || (p.state === 'RESERVED_CHECKOUT' && new Date(p.reservedUntil) > new Date())) throw rejected('That port is reserved or in use by a customer.');
  const r = (await q.query(`UPDATE fiber_ports SET state=$2, note=$3, reservation_id=NULL, reserved_until=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [portId, to, note ?? null])).rows[0]!;
  await audit(q, actor, 'fiber_port', portId, to === 'FAULTY' ? 'MARK_FAULTY' : 'MARK_HEALTHY', { dp: p.dpId, port: p.portNo, note });
  return r;
}

// ───────────────────────── coverage polygons ─────────────────────────
export interface PolygonInput { providerId: string; name: string; kind?: string; geometry: AreaGeometry; cabinetId?: string | null; dpId?: string | null; speedTiersMbps?: number[] | null; capacityStatus?: 'AVAILABLE' | 'EXHAUSTED'; source?: string }
export async function savePolygon(q: Queryable, actor: string, i: PolygonInput, id?: string): Promise<Row> {
  if (!i.name?.trim()) throw invalid('Give the coverage area a name.');
  if (!i.geometry || (i.geometry.type !== 'Polygon' && i.geometry.type !== 'MultiPolygon')) throw invalid('The area must be a GeoJSON Polygon or MultiPolygon.');
  const b = boxOf(i.geometry);
  if (!(b.minLat <= b.maxLat) || !Number.isFinite(b.minLat)) throw invalid('The area has no valid coordinates.');
  const args = [i.providerId, i.cabinetId ?? null, i.dpId ?? null, i.name.trim(), i.kind ?? 'SERVICE_AREA', JSON.stringify(i.geometry), b.minLat, b.maxLat, b.minLng, b.maxLng, i.speedTiersMbps ?? null, i.capacityStatus ?? 'AVAILABLE', i.source ?? 'MANUAL'];
  const r = id
    ? (await q.query(`UPDATE fiber_coverage_polygons SET provider_id=$2, cabinet_id=$3, dp_id=$4, name=$5, kind=$6, geometry=$7, min_lat=$8, max_lat=$9, min_lng=$10, max_lng=$11, speed_tiers_mbps=$12, capacity_status=$13, source=$14 WHERE id=$1 RETURNING *`, [id, ...args])).rows[0]
    : (await q.query(`INSERT INTO fiber_coverage_polygons (provider_id, cabinet_id, dp_id, name, kind, geometry, min_lat, max_lat, min_lng, max_lng, speed_tiers_mbps, capacity_status, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, args)).rows[0];
  if (!r) throw notFound('coverage area', id!);
  await audit(q, actor, 'fiber_polygon', r.id, id ? 'UPDATE' : 'CREATE', { name: i.name });
  return r;
}
export async function deletePolygon(q: Queryable, actor: string, id: string): Promise<void> {
  const r = await q.query('DELETE FROM fiber_coverage_polygons WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('coverage area', id);
  await audit(q, actor, 'fiber_polygon', id, 'DELETE');
}

/**
 * Everything the map draws, as one GeoJSON FeatureCollection: DP points (with their port counts and `level`, by the same rule as the Ports and waitlist page), cabinet points,
 * coverage areas, and each DP's reach as a circle. `settings` carries the low-port thresholds used, so the map's legend states exactly what coloured the dots.
 */
export async function mapFeatures(q: Queryable, f: { providerId?: string; bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number } } = {}) {
  const pv = f.providerId ? [f.providerId] : [];
  const { lowPortsAbsolute, lowPortsPercent } = await getFiberSettings(q);
  const where = (a: string, extra = '') => `${f.providerId ? `${a}provider_id=$1` : 'TRUE'}${extra}`;
  const dps = (await q.query(`SELECT d.id, d.code, d.name, d.lat, d.lng, d.radius_m, d.splitter_ratio, d.status, pr.code AS provider_code, ${COUNTS}
    FROM fiber_dps d JOIN fiber_providers pr ON pr.id=d.provider_id LEFT JOIN fiber_ports p ON p.dp_id=d.id WHERE ${where('d.')} GROUP BY d.id, pr.code LIMIT 5000`, pv)).rows;
  const cabs = (await q.query(`SELECT c.id, c.code, c.name, c.lat, c.lng, c.status, pr.code AS provider_code FROM fiber_cabinets c JOIN fiber_providers pr ON pr.id=c.provider_id WHERE ${where('c.')} LIMIT 2000`, pv)).rows;
  const polys = (await q.query(`SELECT g.id, g.name, g.kind, g.geometry, g.capacity_status, g.speed_tiers_mbps, pr.code AS provider_code FROM fiber_coverage_polygons g JOIN fiber_providers pr ON pr.id=g.provider_id WHERE ${where('g.')} LIMIT 2000`, pv)).rows;
  const features: unknown[] = [];
  for (const g of polys) features.push({ type: 'Feature', geometry: g.geometry, properties: { layer: 'area', id: g.id, name: g.name, kind: g.kind, provider: g.providerCode, capacityStatus: g.capacityStatus, speedTiersMbps: g.speedTiersMbps } });
  for (const d of dps) {
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(ll(d), d.radiusM)] }, properties: { layer: 'reach', id: d.id, provider: d.providerCode } });
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [d.lng, d.lat] }, properties: { layer: 'dp', id: d.id, code: d.code, name: d.name, provider: d.providerCode, status: d.status, splitter: d.splitterRatio, available: d.available, reserved: d.reservedCheckout + d.reservedOrder, inUse: d.inUse, faulty: d.faulty, total: d.total, level: classifyPorts({ available: d.available, total: d.total, faulty: d.faulty }, { lowPortsAbsolute, lowPortsPercent }) } });
  }
  for (const c of cabs) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { layer: 'cabinet', id: c.id, code: c.code, name: c.name, provider: c.providerCode, status: c.status } });
  return { type: 'FeatureCollection', features, settings: { lowPortsAbsolute, lowPortsPercent } };
}

export async function listPolygons(q: Queryable, providerId?: string): Promise<Row[]> {
  return (await q.query(`SELECT g.id, g.name, g.kind, g.capacity_status, g.speed_tiers_mbps, g.source, g.dp_id, g.created_at, pr.code AS provider_code, pr.id AS provider_id FROM fiber_coverage_polygons g JOIN fiber_providers pr ON pr.id=g.provider_id ${providerId ? 'WHERE g.provider_id=$1' : ''} ORDER BY g.created_at DESC LIMIT 1000`, providerId ? [providerId] : [])).rows;
}
