import { XMLParser } from 'fast-xml-parser';

/**
 * The small amount of geometry the coverage engine needs: distances, bounding boxes, point-in-polygon, and reading GeoJSON and KML.
 * Coordinates are [longitude, latitude] in GeoJSON and in everything here that holds a ring.
 */
export type Ring = Array<[number, number]>;
export interface PolygonGeometry { type: 'Polygon'; coordinates: Ring[] }
export interface MultiPolygonGeometry { type: 'MultiPolygon'; coordinates: Ring[][] }
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;
export interface Box { minLat: number; maxLat: number; minLng: number; maxLng: number }

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Metres between two points on the ground (haversine). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A box that surely contains every point within `m` metres of the given point, for indexed prefiltering. */
export function boxAround(p: { lat: number; lng: number }, m: number): Box {
  const dLat = (m / R) * (180 / Math.PI);
  const dLng = dLat / Math.max(0.01, Math.cos(rad(p.lat)));
  return { minLat: p.lat - dLat, maxLat: p.lat + dLat, minLng: p.lng - dLng, maxLng: p.lng + dLng };
}

const polygons = (g: AreaGeometry): Ring[][] => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

export function boxOf(g: AreaGeometry): Box {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const poly of polygons(g)) for (const [lng, lat] of poly[0] ?? []) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); }
  return { minLat, maxLat, minLng, maxLng };
}

const inRing = (ring: Ring, lat: number, lng: number): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
/** Whether the point is inside the area: inside an outer ring and outside every hole. */
export function pointInArea(g: AreaGeometry, p: { lat: number; lng: number }): boolean {
  return polygons(g).some(([outer, ...holes]) => !!outer && inRing(outer, p.lat, p.lng) && !holes.some((h) => inRing(h, p.lat, p.lng)));
}

/** The centre of a point set, for placing an unlocated postcode. */
/** A row with lat and lng columns as a plain point. */
export const ll = (r: { lat?: any; lng?: any }): { lat: number; lng: number } => ({ lat: r.lat, lng: r.lng });
export const centroid = (pts: Array<{ lat: number; lng: number }>) => ({ lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length });

/** A circle as a polygon (for drawing a DP's reach on a map). */
export function circleRing(c: { lat: number; lng: number }, m: number, steps = 32): Ring {
  const b = boxAround(c, m); const dLat = (b.maxLat - b.minLat) / 2, dLng = (b.maxLng - b.minLng) / 2;
  const ring: Ring = [];
  for (let i = 0; i < steps; i++) { const t = (2 * Math.PI * i) / steps; ring.push([c.lng + dLng * Math.cos(t), c.lat + dLat * Math.sin(t)]); }
  ring.push(ring[0]!);
  return ring;
}

// ───────────────────────── reading files ─────────────────────────
export interface ParsedFeature { kind: 'POINT' | 'AREA'; properties: Record<string, unknown>; point?: { lat: number; lng: number }; area?: AreaGeometry }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
function ringOk(r: unknown): r is Ring { return Array.isArray(r) && r.length >= 4 && r.every((c) => Array.isArray(c) && finite(c[0]) && finite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90); }
function areaOf(g: any): AreaGeometry | null {
  if (g?.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length && g.coordinates.every(ringOk)) return { type: 'Polygon', coordinates: g.coordinates };
  if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length && g.coordinates.every((p: unknown) => Array.isArray(p) && p.length && p.every(ringOk))) return { type: 'MultiPolygon', coordinates: g.coordinates };
  return null;
}

/** GeoJSON (a FeatureCollection, a Feature or a bare geometry) into points and areas. Anything unreadable is reported with its position, never skipped silently. */
export function parseGeoJson(text: string): { features: ParsedFeature[]; errors: string[] } {
  const errors: string[] = []; const features: ParsedFeature[] = [];
  let doc: any;
  try { doc = JSON.parse(text); } catch { return { features, errors: ['The file is not valid JSON.'] }; }
  const list: any[] = doc?.type === 'FeatureCollection' ? doc.features ?? [] : doc?.type === 'Feature' ? [doc] : doc?.type ? [{ type: 'Feature', properties: {}, geometry: doc }] : [];
  if (!list.length) errors.push('No features found. Expect a GeoJSON FeatureCollection.');
  list.forEach((f, i) => {
    const g = f?.geometry; const props = (f?.properties ?? {}) as Record<string, unknown>;
    if (g?.type === 'Point' && finite(g.coordinates?.[0]) && finite(g.coordinates?.[1]) && Math.abs(g.coordinates[1]) <= 90 && Math.abs(g.coordinates[0]) <= 180) features.push({ kind: 'POINT', properties: props, point: { lat: g.coordinates[1], lng: g.coordinates[0] } });
    else { const a = areaOf(g); if (a) features.push({ kind: 'AREA', properties: props, area: a }); else errors.push(`Feature ${i + 1}: expected a Point, Polygon or MultiPolygon with valid coordinates.`); }
  });
  return { features, errors };
}

/** KML Placemarks (Point, Polygon, MultiGeometry) into points and areas. ExtendedData values become properties. */
export function parseKml(text: string): { features: ParsedFeature[]; errors: string[] } {
  const features: ParsedFeature[] = []; const errors: string[] = [];
  let doc: any;
  try { doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: true }).parse(text); } catch { return { features, errors: ['The file is not valid KML.'] }; }
  const marks: any[] = [];
  const walk = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); for (const [k, v] of Object.entries(n)) { if (k === 'Placemark') marks.push(...(Array.isArray(v) ? v : [v])); else walk(v); } };
  walk(doc);
  if (!marks.length) errors.push('No Placemarks found in the KML.');
  const coords = (s: unknown): Ring => String(s ?? '').trim().split(/\s+/).filter(Boolean).map((t) => t.split(',').map(Number)).filter((c) => finite(c[0]) && finite(c[1])).map((c) => [c[0]!, c[1]!] as [number, number]);
  const polysOf = (pm: any): Ring[][] => {
    const out: Ring[][] = [];
    const one = (p: any) => { const outer = coords(p?.outerBoundaryIs?.LinearRing?.coordinates); if (outer.length) { const inner = ([] as any[]).concat(p?.innerBoundaryIs ?? []).map((b) => coords(b?.LinearRing?.coordinates)).filter((r) => r.length); out.push([outer, ...inner]); } };
    ([] as any[]).concat(pm.Polygon ?? []).forEach(one);
    ([] as any[]).concat(pm.MultiGeometry?.Polygon ?? []).forEach(one);
    return out;
  };
  marks.forEach((pm, i) => {
    const props: Record<string, unknown> = { name: typeof pm.name === 'string' ? pm.name : pm.name != null ? String(pm.name) : undefined };
    for (const d of ([] as any[]).concat(pm.ExtendedData?.Data ?? [])) if (d?.['@_name']) props[String(d['@_name'])] = d.value;
    for (const d of ([] as any[]).concat(pm.ExtendedData?.SchemaData?.SimpleData ?? [])) if (d?.['@_name']) props[String(d['@_name'])] = d['#text'];
    const pt = coords(pm.Point?.coordinates ?? pm.MultiGeometry?.Point?.coordinates)[0];
    const polys = polysOf(pm);
    if (polys.length) {
      const area = areaOf(polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys });
      if (area) features.push({ kind: 'AREA', properties: props, area }); else errors.push(`Placemark ${i + 1}: the polygon is not closed or has invalid coordinates.`);
    } else if (pt && Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90) features.push({ kind: 'POINT', properties: props, point: { lat: pt[1], lng: pt[0] } });
    else errors.push(`Placemark ${i + 1}: expected a Point or a Polygon.`);
  });
  return { features, errors };
}

// ───────────────────────── addresses ─────────────────────────
export interface AddressParts { country?: string; postalCode?: string; state?: string; city?: string; district?: string; street?: string; building?: string; unit?: string }
const squash = (s?: string | null) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const ABBREV: Array<[RegExp, string]> = [[/\broad\b/g, 'rd'], [/\bstreet\b/g, 'st'], [/\bavenue\b/g, 'ave'], [/\bjalan\b/g, 'jln'], [/\bdrive\b/g, 'dr'], [/\blane\b/g, 'ln'], [/\bblock\b/g, 'blk'], [/\bbuilding\b/g, 'bldg']];
const abbreviate = (s: string) => ABBREV.reduce((t, [re, to]) => t.replace(re, to), s);
/** The same place written differently ("Orchard Road" / "orchard rd.") gives the same key. */
export function normalizeAddress(a: AddressParts): { key: string; parts: Required<Pick<AddressParts, 'country'>> & AddressParts } {
  const parts = { ...a, country: (a.country ?? 'SG').toUpperCase(), postalCode: (a.postalCode ?? '').replace(/\s+/g, '').toUpperCase() || undefined };
  const key = [parts.country, parts.postalCode ?? '', abbreviate(squash(a.building)), abbreviate(squash(a.street)), squash(a.unit)].join('|');
  return { key, parts };
}
/** Pulls what it can out of a one-line address: a trailing or embedded postcode, and the rest as street text. */
export function parseAddressLine(line: string, country = 'SG'): AddressParts {
  const text = line.trim().replace(/\s+/g, ' ');
  const post = country === 'SG' ? /\b(\d{6})\b/.exec(text) : /\b(\d{5,6})\b/.exec(text);
  const unit = /#\s?([0-9A-Za-z-]+)/.exec(text)?.[1] ?? /\bunit\s+([0-9A-Za-z-]+)/i.exec(text)?.[1];
  const street = text.replace(post?.[0] ?? '', '').replace(/#\s?[0-9A-Za-z-]+/, '').replace(/\bunit\s+[0-9A-Za-z-]+/i, '').replace(/[,\s]+$/g, '').replace(/^[,\s]+/g, '');
  return { country, postalCode: post?.[1], unit, street: street || undefined };
}
