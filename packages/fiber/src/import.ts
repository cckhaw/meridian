import { audit, invalid, parseCsv, type Db, type Queryable, type Row } from '@meridian/core';
import { parseGeoJson, parseKml, type ParsedFeature } from './geo.js';
import { upsertAddress } from './gazetteer.js';
import { savePolygon, saveDp, saveCabinet, type DpInput } from './network.js';
import { clearProviderCache } from './serviceability.js';

/**
 * Bulk coverage import (CSV, GeoJSON, KML), the way wholesale partners send national updates. Two steps, like the other importers: a check that changes nothing and
 * reports every problem with its row, then the load, which is all-or-nothing. Points become distribution points, areas become coverage polygons, and a CSV of
 * addresses loads the gazetteer. Rows are matched by (provider, code) for points and (provider, name) for areas, so sending the same file again updates instead of duplicating.
 */
export type ImportFormat = 'CSV' | 'GEOJSON' | 'KML';
export interface ImportInput { format: ImportFormat; text: string; /** Provider code, when the file does not name one per row. */ provider?: string; apply: boolean; actor: string }
export interface ImportReport { jobId: string; format: ImportFormat; applied: boolean; summary: { dps: { create: number; update: number }; areas: { create: number; update: number }; addresses: { create: number; update: number } }; errors: string[] }

const MAX_BYTES = 20_000_000, MAX_ITEMS = 100_000;
const num = (v: unknown): number | undefined => { if (v === undefined || v === null || String(v).trim() === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const tiers = (v: unknown): number[] | undefined => { if (v === undefined || v === null || v === '') return undefined; const a = Array.isArray(v) ? v : String(v).split(/[,;|\s]+/).filter(Boolean); const n = a.map(Number); return n.every((x) => Number.isInteger(x) && x > 0) && n.length ? n : [NaN]; };
const text = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());
const lower = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[\s_-]/g, ''), v]));

type Planned =
  | { type: 'dp'; at: string; provider?: string; cabinet?: string; input: Omit<DpInput, 'providerId'> }
  | { type: 'area'; at: string; provider?: string; name: string; geometry: any; kind?: string; dp?: string; tiers?: number[]; capacity?: 'AVAILABLE' | 'EXHAUSTED' }
  | { type: 'address'; at: string; input: Parameters<typeof upsertAddress>[1] };

function dpFrom(p: Record<string, unknown>, at: string, point: { lat: number; lng: number }): Planned | string {
  const r = lower(p);
  const code = text(r.code ?? r.dpcode ?? r.id), name = text(r.name) ?? code;
  if (!code) return `${at}: a distribution point needs a code.`;
  const splitter = num(r.splitter ?? r.splitterratio ?? r.capacity), radius = num(r.radiusm ?? r.radius ?? r.reach), used = num(r.usedports ?? r.used), faulty = num(r.faultyports ?? r.faulty);
  for (const [v, w] of [[splitter, 'splitter'], [radius, 'radius'], [used, 'used ports'], [faulty, 'faulty ports']] as const) if (Number.isNaN(v)) return `${at}: ${w} must be a number.`;
  const st = text(r.status)?.toUpperCase();
  if (st && !['ACTIVE', 'PLANNED', 'DECOMMISSIONED'].includes(st)) return `${at}: status is ACTIVE, PLANNED or DECOMMISSIONED.`;
  return { type: 'dp', at, provider: text(r.provider ?? r.providercode), cabinet: text(r.cabinet ?? r.cabinetcode),
    input: { code, name: name!, kind: /^fdp$/i.test(String(r.kind ?? '')) ? 'FDP' : 'DP', lat: point.lat, lng: point.lng, splitterRatio: splitter, radiusM: radius, usedPorts: used, faultyPorts: faulty, address: text(r.address), state: text(r.state), city: text(r.city), postalCode: text(r.postalcode ?? r.postcode), status: text(r.status)?.toUpperCase() } };
}
function planFeatures(features: ParsedFeature[], errors: string[]): Planned[] {
  const out: Planned[] = [];
  features.forEach((f, i) => {
    const at = `Feature ${i + 1}`;
    if (f.kind === 'POINT') { const d = dpFrom(f.properties, at, f.point!); if (typeof d === 'string') errors.push(d); else out.push(d); return; }
    const r = lower(f.properties);
    const name = text(r.name ?? r.areaname ?? r.id);
    if (!name) { errors.push(`${at}: an area needs a name.`); return; }
    const t = tiers(r.speedtiers ?? r.speedtiersmbps ?? r.speeds);
    if (t && t.some((x) => Number.isNaN(x))) { errors.push(`${at}: speed tiers are whole numbers of Mbps, like 100, 500, 1000.`); return; }
    const cap = text(r.capacitystatus ?? r.capacity)?.toUpperCase();
    if (cap && cap !== 'AVAILABLE' && cap !== 'EXHAUSTED') { errors.push(`${at}: capacity status is AVAILABLE or EXHAUSTED.`); return; }
    out.push({ type: 'area', at, provider: text(r.provider ?? r.providercode), name, geometry: f.area, kind: text(r.kind)?.toUpperCase(), dp: text(r.dp ?? r.dpcode), tiers: t, capacity: cap as 'AVAILABLE' | 'EXHAUSTED' | undefined });
  });
  return out;
}
function planCsv(src: string, errors: string[]): Planned[] {
  const rows = parseCsv(src);
  if (rows.length < 2) { errors.push('The file has no rows.'); return []; }
  const head = rows[0]!.cells.map((h) => h.toLowerCase().replace(/[\s_-]/g, ''));
  const isAddress = head.includes('postalcode') && !head.includes('code');
  const out: Planned[] = [];
  for (const row of rows.slice(1)) {
    const rec = Object.fromEntries(head.map((h, i) => [h, row.cells[i] ?? '']));
    const at = `Row ${row.line}`;
    const lat = num(rec.lat ?? rec.latitude), lng = num(rec.lng ?? rec.lon ?? rec.longitude);
    if (lat === undefined || lng === undefined || Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { errors.push(`${at}: latitude and longitude are required numbers within range.`); continue; }
    if (isAddress) { const pc = text(rec.postalcode); if (!pc) { errors.push(`${at}: an address needs a postal code.`); continue; } out.push({ type: 'address', at, input: { country: text(rec.country), postalCode: pc, state: text(rec.state), city: text(rec.city), district: text(rec.district), street: text(rec.street), building: text(rec.building), unit: text(rec.unit), lat, lng } }); continue; }
    const d = dpFrom(rec, at, { lat, lng });
    if (typeof d === 'string') errors.push(d); else out.push(d);
  }
  return out;
}

class Rollback extends Error {}

export async function importCoverage(db: Db, i: ImportInput): Promise<ImportReport> {
  if (!['CSV', 'GEOJSON', 'KML'].includes(i.format)) throw invalid('The format is CSV, GEOJSON or KML.');
  if (!i.text || i.text.length > MAX_BYTES) throw invalid('Upload a file of up to 20 MB.');
  const errors: string[] = [];
  const parsed = i.format === 'CSV' ? { plan: planCsv(i.text, errors) } : (() => { const r = i.format === 'GEOJSON' ? parseGeoJson(i.text) : parseKml(i.text); errors.push(...r.errors); return { plan: planFeatures(r.features, errors) }; })();
  const plan = parsed.plan;
  if (plan.length > MAX_ITEMS) throw invalid(`A file can hold up to ${MAX_ITEMS.toLocaleString()} items.`);
  const summary: ImportReport['summary'] = { dps: { create: 0, update: 0 }, areas: { create: 0, update: 0 }, addresses: { create: 0, update: 0 } };
  const touched = new Set<string>();

  const run = async (q: Queryable, jobSource: string) => {
    const providers = new Map((await q.query('SELECT id, code FROM fiber_providers')).rows.map((r) => [r.code as string, r.id as string]));
    const need = (code: string | undefined, at: string): string | null => { const c = (code ?? i.provider)?.toUpperCase(); const id = c ? providers.get(c) : undefined; if (!id) { errors.push(`${at}: ${c ? `no provider with code ${c}` : 'say which provider this belongs to (a provider column, or choose one for the file)'}.`); return null; } return id; };
    for (const it of plan) {
      try {
        if (it.type === 'address') { const had = (await q.query(`SELECT 1 FROM fiber_addresses WHERE normalized_key=$1`, [(await import('./geo.js')).normalizeAddress(it.input).key])).rows[0]; await upsertAddress(q, it.input); summary.addresses[had ? 'update' : 'create']++; continue; }
        const providerId = need(it.provider, it.at); if (!providerId) continue;
        touched.add(providerId);
        if (it.type === 'dp') {
          let cabinetId: string | null = null;
          if (it.cabinet) {
            const c = (await q.query('SELECT id FROM fiber_cabinets WHERE provider_id=$1 AND code=$2', [providerId, it.cabinet])).rows[0];
            cabinetId = c?.id ?? (await saveCabinet(q, i.actor, { providerId, code: it.cabinet, name: it.cabinet, lat: it.input.lat, lng: it.input.lng, state: it.input.state, city: it.input.city, postalCode: it.input.postalCode })).id;
          }
          const ex = (await q.query('SELECT id FROM fiber_dps WHERE provider_id=$1 AND code=$2', [providerId, it.input.code])).rows[0];
          await saveDp(q, i.actor, { ...it.input, providerId, cabinetId }, ex?.id);
          summary.dps[ex ? 'update' : 'create']++;
        } else {
          let dpId: string | null = null;
          if (it.dp) { const d = (await q.query('SELECT id FROM fiber_dps WHERE provider_id=$1 AND code=$2', [providerId, it.dp])).rows[0]; if (!d) { errors.push(`${it.at}: no distribution point ${it.dp} for this provider (load the points first).`); continue; } dpId = d.id; }
          const ex = (await q.query('SELECT id FROM fiber_coverage_polygons WHERE provider_id=$1 AND name=$2', [providerId, it.name])).rows[0];
          await savePolygon(q, i.actor, { providerId, name: it.name, geometry: it.geometry, dpId, kind: it.kind && ['DP_BOUNDARY', 'CABINET_BOUNDARY', 'SERVICE_AREA'].includes(it.kind) ? it.kind : 'SERVICE_AREA', speedTiersMbps: it.tiers ?? null, capacityStatus: it.capacity, source: jobSource }, ex?.id);
          summary.areas[ex ? 'update' : 'create']++;
        }
      } catch (e) { errors.push(`${it.at}: ${(e as Error).message}`); }
    }
  };

  const jobId = (await db.query(`INSERT INTO fiber_import_jobs (format, status, created_by) VALUES ($1,'CHECKED',$2) RETURNING id`, [i.format, i.actor])).rows[0]!.id as string;
  let applied = false;
  try {
    await db.tx(async (q) => {
      await run(q, `IMPORT:${jobId}`);
      if (!i.apply || errors.length) throw new Rollback();   // a check changes nothing, and a file with any problem loads nothing
      applied = true;
      for (const pid of touched) await clearProviderCache(q, pid);
      await audit(q, i.actor, 'fiber_import', jobId, 'APPLY', { format: i.format, ...summary });
    });
  } catch (e) { if (!(e instanceof Rollback)) { await db.query(`UPDATE fiber_import_jobs SET status='FAILED', errors=$2 WHERE id=$1`, [jobId, JSON.stringify([(e as Error).message])]); throw e; } }
  await db.query(`UPDATE fiber_import_jobs SET status=$2, summary=$3, errors=$4 WHERE id=$1`, [jobId, applied ? 'APPLIED' : errors.length && i.apply ? 'FAILED' : 'CHECKED', JSON.stringify(summary), JSON.stringify(errors.slice(0, 200))]);
  return { jobId, format: i.format, applied, summary, errors: errors.slice(0, 200) };
}
export const listImportJobs = async (q: Queryable): Promise<Row[]> => (await q.query(`SELECT id, format, status, summary, errors, created_by, created_at FROM fiber_import_jobs ORDER BY created_at DESC LIMIT 30`)).rows;

/** Templates the admin page offers for download. */
export const IMPORT_TEMPLATES = {
  dps: 'code,name,provider,cabinet,lat,lng,splitter,radiusM,usedPorts,faultyPorts,address,city,state,postalCode\nDP-001,Orchard DP 1,TIME_DOTCOM,CAB-01,1.3048,103.8318,16,150,4,0,"Orchard Road",Singapore,Singapore,238801\n',
  addresses: 'postalCode,street,building,unit,city,state,lat,lng\n238801,Orchard Road,ION Orchard,,Singapore,Singapore,1.3040,103.8318\n',
  geojson: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Orchard service area', provider: 'TIME_DOTCOM', speedTiers: '100,500,1000', capacityStatus: 'AVAILABLE' }, geometry: { type: 'Polygon', coordinates: [[[103.83, 1.30], [103.84, 1.30], [103.84, 1.31], [103.83, 1.31], [103.83, 1.30]]] } }, { type: 'Feature', properties: { code: 'DP-002', name: 'Orchard DP 2', provider: 'TIME_DOTCOM', splitter: 8 }, geometry: { type: 'Point', coordinates: [103.835, 1.305] } }] }, null, 2),
} as const;
