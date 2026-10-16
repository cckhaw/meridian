import { invalid, notFound, type Queryable, type Row } from '@meridian/core';
import { addressView, locate, searchAddresses, type LocateInput } from './gazetteer.js';
import { qualifyAddress, type Qualification, type QualificationOption } from './serviceability.js';

/**
 * TM Forum Open APIs for the coverage service:
 *   TMF 645 Service Qualification  (checkServiceQualification, retrieve, list)
 *   TMF 673 Geographic Address Management  (retrieve and list geographic addresses, validate an address)
 * Internal storefronts and external partners use these; the plain `/api/v1/coverage/*` endpoints return the same answer in our own shape.
 *
 * Mapping: each qualification item names a place (a GeographicAddress with a postcode or a geographicLocation) and, as service characteristics, the speed wanted.
 * An item is `qualified` when a port is available at a speed that meets it, `unqualified` when the place cannot be served, and `alternate` when it can be served
 * but only at another speed or only after a wait (the alternate proposals carry the options).
 */
const BASE = '/tmf-api';
const href = (origin: string, path: string) => `${origin}${BASE}${path}`;

interface TmfPlace { '@type'?: string; id?: string; postcode?: string; streetName?: string; streetNr?: string; streetType?: string; city?: string; stateOfProvince?: string; country?: string; geographicLocation?: { geometry?: { type?: string; coordinates?: [number, number] } }; geographicSubAddress?: Array<{ subUnitNumber?: string; buildingName?: string }> }
interface TmfItem { id?: string; service?: { serviceCharacteristic?: Array<{ name: string; value: unknown }>; place?: TmfPlace[]; serviceSpecification?: { id?: string } }; state?: string }

export function placeToLocate(p: TmfPlace | undefined): LocateInput {
  if (!p) throw invalid('Each qualification item needs a place.');
  const c = p.geographicLocation?.geometry?.coordinates;
  if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') return { lat: c[1], lng: c[0] };
  return { postalCode: p.postcode, street: [p.streetNr, p.streetName, p.streetType].filter(Boolean).join(' ') || undefined, building: p.geographicSubAddress?.[0]?.buildingName, unit: p.geographicSubAddress?.[0]?.subUnitNumber, city: p.city, state: p.stateOfProvince, country: p.country };
}
const wantedSpeed = (it: TmfItem): number | undefined => {
  const ch = it.service?.serviceCharacteristic?.find((x) => /^(downloadSpeed|speed|speedMbps|bandwidth)$/i.test(x.name));
  const n = Number(ch?.value); return Number.isFinite(n) && n > 0 ? n : undefined;
};

const optionProposal = (o: QualificationOption) => ({ '@type': 'AlternateServiceProposal', id: `${o.providerCode}`, state: o.status === 'AVAILABLE' ? 'available' : 'waitlist', service: { serviceCharacteristic: [
  { name: 'provider', value: o.providerCode }, { name: 'ownerType', value: o.ownerType }, { name: 'speedTiersMbps', value: o.speedTiersMbps }, { name: 'availability', value: o.status }, { name: 'estimatedInstallDays', value: o.estimatedInstallDays }] } });

export function toTmf645(origin: string, id: string, items: TmfItem[], qualifications: Qualification[], createdAt: string, requester?: string) {
  return {
    id, href: href(origin, `/serviceQualificationManagement/v4/serviceQualification/${id}`), '@type': 'ServiceQualification', state: 'done', description: 'Fibre coverage qualification',
    effectiveQualificationDate: createdAt, expectedQualificationCompletionDate: createdAt, qualificationDate: createdAt, ...(requester ? { relatedParty: [{ role: 'requester', name: requester }] } : {}),
    serviceQualificationItem: items.map((it, n) => {
      const q = qualifications[n]!; const want = wantedSpeed(it);
      const best = q.recommended;
      const result = best ? 'qualified' : q.availability === 'PORT_EXHAUSTED_WAITLIST' || q.options.some((o) => o.status === 'AVAILABLE') ? 'alternate' : 'unqualified';
      return {
        id: it.id ?? String(n + 1), '@type': 'ServiceQualificationItem', state: 'approved', qualificationItemResult: result,
        ...(result === 'unqualified' ? { eligibilityUnavailabilityReason: [{ code: q.availability === 'UNKNOWN' ? 'PARTNER_UNAVAILABLE' : 'NO_COVERAGE', label: q.availability === 'UNKNOWN' ? 'Coverage could not be confirmed right now' : 'No fibre network reaches this address' }] } : {}),
        ...(result === 'alternate' ? { eligibilityUnavailabilityReason: [{ code: 'PORT_EXHAUSTED', label: 'No free port at the requested speed: join the waitlist or choose another option' }] } : {}),
        service: { ...(it.service ?? {}), '@type': 'Service', state: 'feasibilityChecked', serviceCharacteristic: [...(it.service?.serviceCharacteristic ?? []), { name: 'availability', value: q.availability }, { name: 'speedTiersMbps', value: best?.speedTiersMbps ?? [] }, ...(want ? [{ name: 'requestedSpeedMbps', value: want }] : [])],
          place: [{ '@type': 'GeographicAddress', ...(q.location.address.postalCode ? { postcode: q.location.address.postalCode } : {}), geographicLocation: { '@type': 'GeoJsonPoint', geometry: { type: 'Point', coordinates: [q.location.lng, q.location.lat] } } }] },
        ...(q.options.length ? { alternateServiceProposal: q.options.map(optionProposal) } : {}),
        ...(best ? { expectedDeliveryDate: new Date(Date.parse(createdAt) + (best.estimatedInstallDays ?? 0) * 86_400_000).toISOString() } : {}),
      };
    }),
  };
}

export function toTmf673(origin: string, a: ReturnType<typeof addressView> & { id?: string }) {
  return {
    id: a.id, href: href(origin, `/geographicAddressManagement/v4/geographicAddress/${a.id}`), '@type': 'GeographicAddress', country: a.country, postcode: a.postalCode, stateOfProvince: a.state, city: a.city, streetName: a.street,
    geographicLocation: { '@type': 'GeoJsonPoint', geometry: { type: 'Point', coordinates: [a.lng, a.lat] } },
    ...(a.building || a.unit ? { geographicSubAddress: [{ '@type': 'GeographicSubAddress', ...(a.building ? { buildingName: a.building } : {}), ...(a.unit ? { subUnitNumber: a.unit } : {}) }] } : {}),
  };
}

export class Tmf645Adapter {
  constructor(private q: Queryable, private origin: string) {}

  /** POST /serviceQualificationManagement/v4/serviceQualification */
  async check(body: any, requester?: string): Promise<Row> {
    const items: TmfItem[] = body?.serviceQualificationItem;
    if (!Array.isArray(items) || !items.length) throw invalid('serviceQualificationItem is required: one entry per place to check.');
    if (items.length > 20) throw invalid('Check up to 20 places in one request.');
    const results = await Promise.all(items.map((it) => qualifyAddress(this.q, { ...placeToLocate(it.service?.place?.[0]), speedMbps: wantedSpeed(it) })));
    const created = new Date().toISOString();
    const id = (await this.q.query(`INSERT INTO fiber_qualifications (requester, request, response) VALUES ($1,$2,'{}') RETURNING id`, [requester ?? null, JSON.stringify(body)])).rows[0]!.id as string;
    const out = toTmf645(this.origin, id, items, results, created, requester);
    await this.q.query('UPDATE fiber_qualifications SET response=$2 WHERE id=$1', [id, JSON.stringify(out)]);
    return out;
  }
  async retrieve(id: string): Promise<unknown> {
    const r = (await this.q.query('SELECT response FROM fiber_qualifications WHERE id=$1', [id])).rows[0];
    if (!r) throw notFound('service qualification', id);
    return r.response;
  }
  async list(limit = 20, offset = 0): Promise<unknown[]> {
    return (await this.q.query('SELECT response FROM fiber_qualifications ORDER BY created_at DESC LIMIT $1 OFFSET $2', [Math.min(limit, 100), offset])).rows.map((r) => r.response);
  }

  // ── TMF 673 ──
  async address(id: string): Promise<unknown> {
    const r = (await this.q.query('SELECT * FROM fiber_addresses WHERE id=$1', [id])).rows[0];
    if (!r) throw notFound('geographic address', id);
    return toTmf673(this.origin, addressView(r));
  }
  async addresses(f: { postcode?: string; streetName?: string; city?: string; stateOfProvince?: string; limit?: number }): Promise<unknown[]> {
    return (await searchAddresses(this.q, { postalCode: f.postcode, street: f.streetName, city: f.city, state: f.stateOfProvince, limit: f.limit })).map((r) => toTmf673(this.origin, addressView(r)));
  }
  /** POST /geographicAddressManagement/v4/geographicAddressValidation: does this address exist, and where is it. */
  async validate(body: any): Promise<unknown> {
    const a = body?.submittedGeographicAddress;
    if (!a) throw invalid('submittedGeographicAddress is required.');
    let validated: unknown = null; let result = 'success'; let reason: string | undefined;
    try {
      const loc = await locate(this.q, placeToLocate(a));
      validated = { '@type': 'GeographicAddress', country: loc.address.country, postcode: loc.address.postalCode, streetName: loc.address.street, city: loc.address.city, stateOfProvince: loc.address.state, geographicLocation: { '@type': 'GeoJsonPoint', geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] } }, ...(loc.precision === 'POSTCODE' ? { description: 'Located by postcode only' } : {}) };
      if (loc.precision === 'POSTCODE') result = 'partial';
    } catch (e) { result = 'fail'; reason = (e as Error).message; }
    return { '@type': 'GeographicAddressValidation', validationResult: result, ...(reason ? { validationFailureReason: reason } : {}), submittedGeographicAddress: a, ...(validated ? { validGeographicAddress: validated } : {}), state: 'done' };
  }
}
