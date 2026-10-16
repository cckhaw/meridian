import { audit, invalid, rejected, type Queryable, type Row } from '@meridian/core';
import { centroid, ll, normalizeAddress, parseAddressLine, type AddressParts } from './geo.js';

/**
 * Turning what a customer typed (or their phone's GPS) into a point on the map. The gazetteer is our own table of addresses, loaded from the national
 * postal data; a postcode with no exact match falls back to the middle of the addresses sharing it, and says so (`precision`). An outside geocoder can be
 * plugged in with `setGeocoder` for places the gazetteer does not know.
 */
export type Precision = 'GPS' | 'ADDRESS' | 'POSTCODE' | 'GEOCODER';
export interface Located { lat: number; lng: number; precision: Precision; address: AddressParts & { normalizedKey?: string; formatted?: string } }
export type Geocoder = (a: AddressParts & { line?: string }) => Promise<{ lat: number; lng: number } | null>;
let geocoder: Geocoder | null = null;
export const setGeocoder = (g: Geocoder | null) => { geocoder = g; };

export interface LocateInput { lat?: number; lng?: number; address?: string; postalCode?: string; country?: string; street?: string; building?: string; unit?: string; city?: string; state?: string }

const fmt = (a: AddressParts) => [a.unit && `#${a.unit}`, a.building, a.street, a.city, a.state, a.postalCode].filter(Boolean).join(', ');

export async function locate(q: Queryable, i: LocateInput): Promise<Located> {
  if (i.lat !== undefined || i.lng !== undefined) {
    if (typeof i.lat !== 'number' || typeof i.lng !== 'number' || !(Math.abs(i.lat) <= 90) || !(Math.abs(i.lng) <= 180)) throw invalid('Latitude and longitude must both be numbers within range.');
    return { lat: i.lat, lng: i.lng, precision: 'GPS', address: { country: (i.country ?? 'SG').toUpperCase(), postalCode: i.postalCode } };
  }
  const line = i.address?.trim();
  if (!line && !i.postalCode && !i.street) throw invalid('Give an address or a postcode, or the latitude and longitude.');
  const parsed = line ? parseAddressLine(line, i.country) : {};
  const { key, parts } = normalizeAddress({ ...parsed, country: i.country ?? parsed.country, postalCode: i.postalCode ?? parsed.postalCode, street: i.street ?? parsed.street, building: i.building, unit: i.unit ?? parsed.unit, city: i.city, state: i.state });
  const exact = (await q.query('SELECT * FROM fiber_addresses WHERE normalized_key=$1', [key])).rows[0];
  if (exact) return { lat: exact.lat, lng: exact.lng, precision: 'ADDRESS', address: { ...rowAddress(exact), normalizedKey: key, formatted: fmt(rowAddress(exact)) } };
  // The same building without the unit is as good a place as any for a fibre check.
  if (parts.postalCode && parts.unit) {
    const { key: noUnit } = normalizeAddress({ ...parts, unit: undefined });
    const b = (await q.query('SELECT * FROM fiber_addresses WHERE normalized_key=$1', [noUnit])).rows[0];
    if (b) return { lat: b.lat, lng: b.lng, precision: 'ADDRESS', address: { ...rowAddress(b), unit: parts.unit, normalizedKey: key, formatted: fmt({ ...rowAddress(b), unit: parts.unit }) } };
  }
  if (geocoder) {
    const g = await geocoder({ ...parts, line }).catch(() => null);
    if (g) return { ...g, precision: 'GEOCODER', address: { ...parts, normalizedKey: key, formatted: line ?? fmt(parts) } };
  }
  if (parts.postalCode) {
    const rows = (await q.query('SELECT * FROM fiber_addresses WHERE country=$1 AND postal_code=$2 LIMIT 500', [parts.country, parts.postalCode])).rows;
    if (rows.length) { const c = centroid(rows.map(ll)); const r0 = rows[0]!; return { ...c, precision: 'POSTCODE', address: { ...rowAddress(r0), building: undefined, unit: undefined, street: parts.street ?? r0.street, normalizedKey: key, formatted: fmt({ ...rowAddress(r0), building: undefined, unit: undefined }) } }; }
  }
  throw rejected('We could not find that address. Check the postcode, or pin the location on the map.');
}
const rowAddress = (r: Row): AddressParts => ({ country: r.country?.trim(), postalCode: r.postalCode, state: r.state ?? undefined, city: r.city ?? undefined, district: r.district ?? undefined, street: r.street ?? undefined, building: r.building ?? undefined, unit: r.unit ?? undefined });

export interface AddressInput extends AddressParts { lat: number; lng: number }
export async function upsertAddress(q: Queryable, a: AddressInput, actor?: string): Promise<Row> {
  if (!a.postalCode?.trim()) throw invalid('An address needs a postcode.');
  if (!(Math.abs(a.lat) <= 90) || !(Math.abs(a.lng) <= 180)) throw invalid('The address needs valid coordinates.');
  const { key, parts } = normalizeAddress(a);
  const r = (await q.query(
    `INSERT INTO fiber_addresses (country, postal_code, state, city, district, street, building, unit, lat, lng, normalized_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (normalized_key) DO UPDATE SET state=EXCLUDED.state, city=EXCLUDED.city, district=EXCLUDED.district, lat=EXCLUDED.lat, lng=EXCLUDED.lng RETURNING *`,
    [parts.country, parts.postalCode, a.state ?? null, a.city ?? null, a.district ?? null, a.street ?? null, a.building ?? null, a.unit ?? null, a.lat, a.lng, key])).rows[0]!;
  if (actor) await audit(q, actor, 'fiber_address', r.id, 'UPSERT', { postalCode: parts.postalCode });
  return r;
}

/** TM Forum 673 search: by postcode, street, city or free text. */
export async function searchAddresses(q: Queryable, f: { postalCode?: string; street?: string; city?: string; state?: string; text?: string; limit?: number }): Promise<Row[]> {
  const where: string[] = []; const v: unknown[] = [];
  const add = (sql: string, val: unknown) => { v.push(val); where.push(sql.replace('?', `$${v.length}`)); };
  if (f.postalCode) add('postal_code = ?', f.postalCode.replace(/\s+/g, '').toUpperCase());
  if (f.street) add(`lower(street) LIKE ?`, `%${f.street.toLowerCase().replace(/[%_]/g, '')}%`);
  if (f.city) add('lower(city) = ?', f.city.toLowerCase());
  if (f.state) add('lower(state) = ?', f.state.toLowerCase());
  if (f.text) add(`lower(coalesce(building,'') || ' ' || coalesce(street,'') || ' ' || postal_code) LIKE ?`, `%${f.text.toLowerCase().replace(/[%_]/g, '')}%`);
  if (!where.length) throw invalid('Give a postcode, street, city or text to search for.');
  v.push(Math.min(f.limit ?? 20, 100));
  return (await q.query(`SELECT * FROM fiber_addresses WHERE ${where.join(' AND ')} ORDER BY postal_code, street, building, unit LIMIT $${v.length}`, v)).rows;
}
export const addressView = (r: Row) => ({ id: r.id, ...rowAddress(r), lat: r.lat, lng: r.lng, formatted: fmt(rowAddress(r)) });
