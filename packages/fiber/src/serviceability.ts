import { type Queryable, type Row } from '@meridian/core';
import { askPartner, type PartnerAnswer } from './adapters.js';
import { boxAround, distanceM, ll, pointInArea, type AreaGeometry } from './geo.js';
import { locate, type LocateInput, type Located } from './gazetteer.js';
import { getFiberSettings, type FiberSettings } from './settings.js';

/**
 * Can this place be served, by whom, at what speeds, and is there a free port? One call, answered from three sources:
 *  1. our own inventory: distribution points whose reach covers the place, and coverage areas that contain it (indexed bounding boxes, then exact geometry);
 *  2. each wholesale partner with a live adapter, asked in parallel (a slow or failing partner is left out, never fatal) and remembered for the cache time;
 *  3. each partner's imported coverage files, when it has no live adapter or its adapter is off or failed.
 */
export const AVAILABILITY = ['AVAILABLE', 'PORT_EXHAUSTED_WAITLIST', 'UNSERVICEABLE', 'UNKNOWN'] as const;
export type Availability = (typeof AVAILABILITY)[number];

export interface QualifyInput extends LocateInput { speedMbps?: number; refresh?: boolean }
export interface QualificationOption {
  providerId: string; providerCode: string; providerName: string; ownerType: 'OWNED_INFRASTRUCTURE' | 'WHOLESALE_PARTNER';
  status: Availability; speedTiersMbps: number[]; meetsRequestedSpeed: boolean | null;
  ports: { available: number; total: number } | null;
  dp: { id: string; code: string; name: string; distanceM: number } | null;
  estimatedInstallDays: number | null; slaResponseHours: number;
  source: 'OWNED_SPATIAL' | 'PARTNER_LIVE' | 'PARTNER_CACHE' | 'PARTNER_IMPORT'; reference: string | null; note?: string;
}
export interface Qualification {
  location: { lat: number; lng: number; precision: Located['precision']; address: Located['address'] };
  availability: Availability; options: QualificationOption[]; recommended: QualificationOption | null;
  partial: boolean; partnerErrors: Array<{ provider: string; error: string }>; tookMs: number; generatedAt: string;
}

const rank: Record<Availability, number> = { AVAILABLE: 0, PORT_EXHAUSTED_WAITLIST: 1, UNKNOWN: 2, UNSERVICEABLE: 3 };
const MAX_REACH_M = 5000;

interface Spatial { tiers: number[]; ports: { available: number; total: number } | null; dp: QualificationOption['dp']; status: Availability; capacityHint?: boolean }

/** What our own data says about one provider at the point, or null if it does not reach the place. */
async function spatialFor(q: Queryable, p: Row, at: { lat: number; lng: number }): Promise<Spatial | null> {
  const b = boxAround(at, MAX_REACH_M);
  const dps: Row[] = (await q.query(
    `SELECT d.id, d.code, d.name, d.lat, d.lng, d.radius_m,
            count(*) FILTER (WHERE pt.state='AVAILABLE' OR (pt.state='RESERVED_CHECKOUT' AND pt.reserved_until < now()))::int AS available, count(pt.id)::int AS total
       FROM fiber_dps d LEFT JOIN fiber_ports pt ON pt.dp_id=d.id
      WHERE d.provider_id=$1 AND d.status='ACTIVE' AND d.lat BETWEEN $2 AND $3 AND d.lng BETWEEN $4 AND $5 GROUP BY d.id`, [p.id, b.minLat, b.maxLat, b.minLng, b.maxLng])).rows
    .map((d: Row) => ({ ...d, distanceM: Math.round(distanceM(at, ll(d))) })).filter((d: Row) => d.distanceM <= d.radiusM).sort((x: Row, y: Row) => x.distanceM - y.distanceM);
  const polys = (await q.query(
    `SELECT id, dp_id, geometry, speed_tiers_mbps, capacity_status FROM fiber_coverage_polygons WHERE provider_id=$1 AND min_lat <= $2 AND max_lat >= $2 AND min_lng <= $3 AND max_lng >= $3`, [p.id, at.lat, at.lng])).rows
    .filter((g) => pointInArea(g.geometry as AreaGeometry, at));
  if (!dps.length && !polys.length) return null;
  // Distribution points named by a matching polygon count too, even beyond their circle.
  const named = polys.map((g) => g.dpId).filter(Boolean) as string[];
  let all: Row[] = dps;
  if (named.some((id) => !dps.some((d) => d.id === id))) {
    const extra: Row[] = (await q.query(`SELECT d.id, d.code, d.name, d.lat, d.lng, d.radius_m, count(*) FILTER (WHERE pt.state='AVAILABLE' OR (pt.state='RESERVED_CHECKOUT' AND pt.reserved_until < now()))::int AS available, count(pt.id)::int AS total FROM fiber_dps d LEFT JOIN fiber_ports pt ON pt.dp_id=d.id WHERE d.id = ANY($1::uuid[]) AND d.status='ACTIVE' GROUP BY d.id`, [named.filter((id) => !dps.some((d) => d.id === id))])).rows.map((d) => ({ ...d, distanceM: Math.round(distanceM(at, ll(d))) }));
    all = [...dps, ...extra].sort((x, y) => x.distanceM - y.distanceM);
  }
  const tiers = [...new Set((polys.find((g) => g.speedTiersMbps?.length)?.speedTiersMbps as number[] | undefined) ?? (p.speedTiersMbps as number[]))].sort((a, c) => a - c);
  if (all.length) {
    const free = all.find((d) => d.available > 0);
    const pick = free ?? all[0]!;
    return { tiers, ports: { available: pick.available, total: pick.total }, dp: { id: pick.id, code: pick.code, name: pick.name, distanceM: pick.distanceM }, status: free ? 'AVAILABLE' : 'PORT_EXHAUSTED_WAITLIST' };
  }
  return { tiers, ports: null, dp: null, status: polys.some((g) => g.capacityStatus === 'AVAILABLE') ? 'AVAILABLE' : 'PORT_EXHAUSTED_WAITLIST', capacityHint: true };
}

const cacheKey = (loc: Located, speed?: number) => `${loc.precision === 'GPS' ? '' : `${loc.address.normalizedKey ?? ''}|`}${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}${speed ? `|${speed}` : ''}`;

export async function qualifyAddress(q: Queryable, input: QualifyInput, o: { settings?: FiberSettings } = {}): Promise<Qualification> {
  const t0 = Date.now();
  const settings = o.settings ?? await getFiberSettings(q);
  const loc = await locate(q, input);
  const at = { lat: loc.lat, lng: loc.lng };
  const providers = (await q.query(`SELECT * FROM fiber_providers WHERE enabled ORDER BY type, name`)).rows;
  const partnerErrors: Array<{ provider: string; error: string }> = [];
  const meets = (tiers: number[]) => (input.speedMbps ? tiers.some((s) => s >= input.speedMbps!) : null);

  const optionFor = async (p: Row): Promise<QualificationOption | null> => {
    const base = { providerId: p.id as string, providerCode: p.code as string, providerName: p.name as string, ownerType: p.type as QualificationOption['ownerType'], slaResponseHours: p.slaResponseHours as number, reference: null as string | null };
    const live = p.type === 'WHOLESALE_PARTNER' && p.adapterKind !== 'NONE' && p.adapterEnabled && settings.adapters[p.code as string] !== false;
    if (live) {
      const key = cacheKey(loc, input.speedMbps);
      if (!input.refresh && settings.cacheHours > 0) {
        const hit = (await q.query(`SELECT result FROM fiber_serviceability_cache WHERE provider_id=$1 AND cache_key=$2 AND expires_at > now()`, [p.id, key])).rows[0];
        if (hit) return { ...(hit.result as QualificationOption), source: 'PARTNER_CACHE' };
      }
      try {
        const a: PartnerAnswer = await askPartner(p, { ...at, postalCode: loc.address.postalCode, address: loc.address.formatted, speedMbps: input.speedMbps }, settings.partnerTimeoutMs);
        const tiers = a.speedsMbps.length ? a.speedsMbps : (p.speedTiersMbps as number[]);
        const opt: QualificationOption = { ...base, status: !a.serviceable ? 'UNSERVICEABLE' : a.portStatus === 'EXHAUSTED' ? 'PORT_EXHAUSTED_WAITLIST' : 'AVAILABLE', speedTiersMbps: a.serviceable ? tiers : [], meetsRequestedSpeed: a.serviceable ? meets(tiers) : null,
          ports: null, dp: null, estimatedInstallDays: a.serviceable ? a.leadDays ?? p.installLeadDays : null, source: 'PARTNER_LIVE', reference: a.reference };
        if (settings.cacheHours > 0) await q.query(`INSERT INTO fiber_serviceability_cache (provider_id, cache_key, result, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4)) ON CONFLICT (provider_id, cache_key) DO UPDATE SET result=$3, expires_at=EXCLUDED.expires_at, created_at=now()`, [p.id, key, JSON.stringify(opt), settings.cacheHours]);
        return opt;
      } catch (e) {
        partnerErrors.push({ provider: p.code, error: (e as Error).message.slice(0, 160) });
        // fall through to whatever coverage files we hold for this partner
      }
    }
    const s = await spatialFor(q, p, at);
    if (!s) return live && partnerErrors.some((x) => x.provider === p.code) ? { ...base, status: 'UNKNOWN', speedTiersMbps: [], meetsRequestedSpeed: null, ports: null, dp: null, estimatedInstallDays: null, source: 'PARTNER_LIVE', note: 'The partner could not be reached.' } : null;
    return { ...base, status: s.status, speedTiersMbps: s.status === 'UNSERVICEABLE' ? [] : s.tiers, meetsRequestedSpeed: meets(s.tiers), ports: s.ports, dp: s.dp, estimatedInstallDays: s.status === 'UNSERVICEABLE' ? null : p.installLeadDays,
      source: p.type === 'OWNED_INFRASTRUCTURE' ? 'OWNED_SPATIAL' : 'PARTNER_IMPORT' };
  };

  const results = await Promise.all(providers.map((p) => optionFor(p)));
  const options = results.filter((x): x is QualificationOption => !!x)
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.ownerType === b.ownerType ? 0 : a.ownerType === 'OWNED_INFRASTRUCTURE' ? -1 : 1) || (a.estimatedInstallDays ?? 999) - (b.estimatedInstallDays ?? 999));
  const best = options.find((o) => o.status === 'AVAILABLE' && o.meetsRequestedSpeed !== false) ?? null;
  const availability: Availability = best ? 'AVAILABLE' : options.find((o) => o.status === 'PORT_EXHAUSTED_WAITLIST') ? 'PORT_EXHAUSTED_WAITLIST' : options.some((o) => o.status === 'UNKNOWN') ? 'UNKNOWN' : 'UNSERVICEABLE';
  return { location: { ...at, precision: loc.precision, address: loc.address }, availability, options, recommended: best, partial: partnerErrors.length > 0, partnerErrors, tookMs: Date.now() - t0, generatedAt: new Date().toISOString() };
}

/** Deletes cached partner answers that have expired (run now and then; reads already ignore them). */
export async function pruneCache(q: Queryable): Promise<number> {
  return (await q.query(`DELETE FROM fiber_serviceability_cache WHERE expires_at < now()`)).rowCount;
}
/** Forgets the cached answers for a provider (after its coverage changed or its adapter was reconfigured). */
export async function clearProviderCache(q: Queryable, providerId: string): Promise<number> {
  return (await q.query(`DELETE FROM fiber_serviceability_cache WHERE provider_id=$1`, [providerId])).rowCount;
}
