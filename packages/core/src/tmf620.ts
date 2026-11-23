import { currencyInfo, LINE_ITEM_TYPES, type CatalogNode, type LineItemNode, type OfferNode, type PriceComponent } from '@meridian/types';
import { createNode, deleteNode, getNode, moveNode, setStatus, toNode, updateNode, type NodeInput, type NodePatch } from './catalog.js';
import type { Queryable, Row } from './db.js';
import { invalid, notFound } from './errors.js';

/**
 * TM Forum TMF620 Product Catalog Management (v4 profile) over the working catalog:
 *
 *   Catalog               one catalog, "meridian"                                     /catalog
 *   Category              network type > category > group (the hierarchy above offers) /category
 *   ProductOffering       an offer: prices, term, dependencies, channels, markets      /productOffering
 *   ProductSpecification  what an offer includes: its line items as characteristics   /productSpecification  (one per offer, same id)
 *
 * It is a profile, not the whole specification: the resources and attributes below, offset/limit paging with X-Total-Count, `fields` selection and the status
 * vocabulary. Prices are embedded in the offering (ProductOfferingPrice values) rather than served as a resource of their own. What TMF620 has no place for
 * (offer type, fulfilment, device deals and variants, OCS plan, group terms, suspension terms, characteristics) travels in the `@meridian` extension, so a client
 * that reads an offering and writes it back loses nothing. Every write goes through the same functions as the Catalog screen, so the same rules apply: a sold
 * offer cannot be repriced, a SKU is reserved once, a prerequisite must exist.
 */
export const TMF620 = 'productCatalogManagement/v4';
const CATALOG_ID = 'meridian';
const ref = (base: string, path: string, id: string) => `${base}/api/tmf-api/${TMF620}/${path}/${id}`;

const exponent = (currency: string) => currencyInfo(currency)?.exponent ?? 2;

// ───────────────────────── lifecycle ─────────────────────────
/** Draft and Scheduled are both "In design": a scheduled offer is In design with a validFor.startDateTime in the future. */
const LIFECYCLE: Record<string, string> = { DRAFT: 'In design', SCHEDULED: 'In design', ACTIVE: 'Active', RETIRED: 'Retired' };

/** What a TMF lifecycleStatus (and an optional start date) means for the catalog: the status to set, and the go-live date for a scheduled one. */
export function statusFromLifecycle(lifecycle: unknown, startDateTime?: unknown): { status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'RETIRED'; activeFrom?: string } {
  switch (String(lifecycle)) {
    case 'Active': case 'Launched': return { status: 'ACTIVE' };
    case 'Retired': case 'Obsolete': return { status: 'RETIRED' };
    case 'In design': case 'In study': case 'In test': {
      const start = typeof startDateTime === 'string' ? new Date(startDateTime) : null;
      if (start && !Number.isNaN(start.getTime()) && start.getTime() > Date.now()) return { status: 'SCHEDULED', activeFrom: start.toISOString() };
      return { status: 'DRAFT' };
    }
    default: throw invalid('lifecycleStatus is In design, Active or Retired (In study and In test count as In design; Launched as Active; Obsolete as Retired).');
  }
}

const STATUSES_FOR_LIFECYCLE: Record<string, string[]> = { 'In design': ['DRAFT', 'SCHEDULED'], 'In study': ['DRAFT', 'SCHEDULED'], 'In test': ['DRAFT', 'SCHEDULED'], Active: ['ACTIVE'], Launched: ['ACTIVE'], Retired: ['RETIRED'], Obsolete: ['RETIRED'] };

// ───────────────────────── prices and terms ─────────────────────────
const PRICE_TYPE = { ONE_TIME: 'oneTime', RECURRING: 'recurring', USAGE: 'usage' } as const;
const PRICE_TYPE_IN: Record<string, PriceComponent['type']> = { onetime: 'ONE_TIME', recurring: 'RECURRING', usage: 'USAGE' };

export function toOfferingPrice(p: PriceComponent, offerId: string, i: number): Record<string, unknown> {
  const money = { unit: p.amount.currency, value: p.amount.amountMinor / 10 ** exponent(p.amount.currency) };
  return {
    id: `${offerId}-price-${i + 1}`, name: p.type === 'RECURRING' ? 'Monthly fee' : p.type === 'USAGE' ? 'Usage' : 'One-time price',
    priceType: PRICE_TYPE[p.type],
    ...(p.type === 'RECURRING' ? { recurringChargePeriodType: 'month', recurringChargePeriodLength: p.periodMonths ?? 1 } : {}),
    price: p.taxInclusive ? { taxIncludedAmount: money } : { dutyFreeAmount: money },
    '@type': 'ProductOfferingPrice',
  };
}

export function fromOfferingPrices(list: unknown): PriceComponent[] {
  if (!Array.isArray(list) || !list.length) throw invalid('productOfferingPrice needs at least one price.');
  return list.map((p: any, i) => {
    const where = `productOfferingPrice[${i}]`;
    const type = PRICE_TYPE_IN[String(p?.priceType ?? '').toLowerCase()];
    if (!type) throw invalid(`${where}.priceType is oneTime, recurring or usage.`);
    const inclusive = p.price?.taxIncludedAmount, free = p.price?.dutyFreeAmount;
    const m = inclusive ?? free;
    if (!m || typeof m.unit !== 'string' || typeof m.value !== 'number' || !(m.value >= 0)) throw invalid(`${where}.price needs taxIncludedAmount or dutyFreeAmount as {unit, value}, value 0 or more.`);
    const amountMinor = Math.round(m.value * 10 ** exponent(m.unit));
    let periodMonths: number | undefined;
    if (type === 'RECURRING') {
      const len = Number(p.recurringChargePeriodLength ?? 1), unit = String(p.recurringChargePeriodType ?? 'month').toLowerCase().replace(/s$/, '');
      if (unit !== 'month' && unit !== 'year') throw invalid(`${where}.recurringChargePeriodType is month or year.`);
      if (!Number.isInteger(len) || len < 1) throw invalid(`${where}.recurringChargePeriodLength is a whole number of 1 or more.`);
      periodMonths = unit === 'year' ? len * 12 : len;
    }
    return { type, amount: { amountMinor, currency: m.unit }, ...(periodMonths ? { periodMonths } : {}), taxInclusive: !!inclusive } as PriceComponent;
  });
}

const termsOut = (o: OfferNode) => (o.contract?.termMonths ? [{ name: `${o.contract.termMonths}-month contract`, duration: { amount: o.contract.termMonths, units: 'month' }, '@type': 'ProductOfferingTerm' }] : []);

function termMonthsIn(list: unknown): number {
  if (!Array.isArray(list) || !list.length) return 0;
  const d = (list[0] as any)?.duration, n = Number(d?.amount), unit = String(d?.units ?? 'month').toLowerCase().replace(/s$/, '');
  if (unit !== 'month' && unit !== 'year') throw invalid('productOfferingTerm.duration.units is month or year.');
  const months = unit === 'year' ? n * 12 : n;
  if (![12, 24, 36].includes(months)) throw invalid('productOfferingTerm.duration is 12, 24 or 36 months (leave the term out for no contract).');
  return months;
}

// ───────────────────────── lookups ─────────────────────────
type Known = Map<string, { level: string; name: string }>;
async function lookup(q: Queryable, ids: string[]): Promise<Known> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = (await q.query('SELECT id, level, name FROM catalog_nodes WHERE id = ANY($1)', [uniq])).rows;
  return new Map(rows.map((r: Row) => [r.id as string, { level: r.level as string, name: r.name as string }]));
}
const REFERRED = (level?: string) => (level === 'OFFER' || !level ? 'ProductOffering' : 'Category');

// ───────────────────────── ProductOffering ─────────────────────────
export function toProductOffering(o: OfferNode & { updatedAt?: unknown }, base: string, known: Known = new Map()): Record<string, unknown> {
  const rel = (id: string, relationshipType: string) => ({ id, href: ref(base, known.get(id)?.level === 'OFFER' || !known.get(id) ? 'productOffering' : 'category', id), relationshipType, name: known.get(id)?.name, '@referredType': REFERRED(known.get(id)?.level) });
  return {
    id: o.id, href: ref(base, 'productOffering', o.id), name: o.name, description: o.description ?? '', version: String(o.version ?? 1), lastUpdate: o.updatedAt,
    lifecycleStatus: LIFECYCLE[o.status], ...(o.status === 'SCHEDULED' && o.activeFrom ? { validFor: { startDateTime: o.activeFrom } } : {}),
    isBundle: false,
    category: o.parentId ? [{ id: o.parentId, href: ref(base, 'category', o.parentId), name: known.get(o.parentId)?.name, '@referredType': 'Category' }] : [],
    channel: (o.salesChannels ?? []).map((c) => ({ id: c, name: c })),
    place: (o.markets ?? []).map((m) => ({ id: m, name: m, role: 'market', '@referredType': 'GeographicSite' })),
    productSpecification: { id: o.id, href: ref(base, 'productSpecification', o.id), name: o.name, '@referredType': 'ProductSpecification' },
    productOfferingPrice: (o.prices ?? []).map((p, i) => toOfferingPrice(p, o.id, i)),
    productOfferingTerm: termsOut(o),
    productOfferingRelationship: [...(o.requires ?? []).map((id) => rel(id, 'dependency')), ...(o.excludes ?? []).map((id) => rel(id, 'exclusivity'))],
    '@type': 'ProductOffering',
    '@meridian': {
      kind: o.kind, contract: o.contract, fulfilment: o.fulfilment, characteristics: o.characteristics ?? {}, partnerCode: o.partnerCode, validityDays: o.validityDays, ocs: o.ocs,
      variants: o.variants ?? [], deals: o.deals ?? [], suspension: o.suspension, group: o.group,
    },
  };
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 54);
const ID_OK = /^[a-z0-9][a-z0-9-]*$/;
/** The id a client asked for, or one made from the name (with a short suffix when taken). */
async function newId(q: Queryable, asked: unknown, name: string): Promise<string> {
  if (typeof asked === 'string' && asked) { if (!ID_OK.test(asked) || asked.length > 60) throw invalid('id is lowercase letters, digits and dashes, up to 60 characters.'); return asked; }
  const base = slug(name) || 'offer';
  let id = base;
  for (let n = 2; (await q.query('SELECT 1 FROM catalog_nodes WHERE id=$1', [id])).rows.length; n++) id = `${base}-${n}`.slice(0, 60);
  return id;
}

const relIds = (list: unknown, type: string): string[] | undefined =>
  Array.isArray(list) ? list.filter((r: any) => String(r?.relationshipType).toLowerCase() === type && typeof r?.id === 'string').map((r: any) => r.id as string) : undefined;
const marketsIn = (place: unknown): string[] | undefined => Array.isArray(place) ? place.map((p: any) => String(p?.id ?? p?.name ?? '').toUpperCase()).filter((m) => /^[A-Z]{2}$/.test(m)) : undefined;
const channelsIn = (channel: unknown): string[] | undefined => Array.isArray(channel) ? channel.map((c: any) => String(c?.id ?? c?.name ?? '')).filter(Boolean) : undefined;

/** The offer's own attributes in a request, as the catalog's patch shape. Only what the request names; `undefined` means "leave as it is". */
function offeringFields(body: Record<string, any>): NodePatch {
  const m: Record<string, any> = body['@meridian'] && typeof body['@meridian'] === 'object' ? body['@meridian'] : {};
  const out: Record<string, unknown> = {};
  if (body.name !== undefined) out.name = String(body.name);
  if (body.description !== undefined) out.description = String(body.description ?? '');
  if (body.productOfferingPrice !== undefined) out.prices = fromOfferingPrices(body.productOfferingPrice);
  if (body.productOfferingTerm !== undefined || m.contract !== undefined) {
    const months = body.productOfferingTerm !== undefined ? termMonthsIn(body.productOfferingTerm) : (m.contract?.termMonths ?? 0);
    out.contract = { ...(m.contract ?? {}), termMonths: months };
  }
  if (body.productOfferingRelationship !== undefined) { out.requires = relIds(body.productOfferingRelationship, 'dependency') ?? []; out.excludes = relIds(body.productOfferingRelationship, 'exclusivity') ?? []; }
  if (body.channel !== undefined) out.salesChannels = channelsIn(body.channel) ?? [];
  if (body.place !== undefined) out.markets = marketsIn(body.place) ?? [];
  for (const k of ['kind', 'fulfilment', 'characteristics', 'partnerCode', 'validityDays', 'ocs', 'variants', 'deals', 'suspension', 'group']) if (m[k] !== undefined) out[k] = m[k];
  return out as NodePatch;
}

export async function tmfCreateOffering(q: Queryable, body: Record<string, any>, actor: string): Promise<OfferNode> {
  if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('name is required.');
  const parentId = Array.isArray(body.category) ? body.category[0]?.id : undefined;
  if (typeof parentId !== 'string') throw invalid('category needs the group the offering sits in: category: [{ id }].');
  const f = offeringFields(body) as Record<string, any>;
  if (!f.prices) throw invalid('productOfferingPrice is required.');
  if (typeof f.kind !== 'string' || !f.kind) throw invalid('@meridian.kind is required: the offer type id (Settings → Catalog → Offer types).');
  const st = statusFromLifecycle(body.lifecycleStatus ?? 'In design', body.validFor?.startDateTime);
  const id = await newId(q, body.id, body.name);
  const input = {
    id, level: 'OFFER', code: id, name: f.name.trim(), path: '', parentId, status: st.status, activeFrom: st.activeFrom, markets: f.markets ?? [], kind: f.kind, description: f.description,
    prices: f.prices, contract: f.contract ?? { termMonths: 0 }, fulfilment: f.fulfilment ?? { requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] },
    partnerCode: f.partnerCode, validityDays: f.validityDays, ocs: f.ocs ?? undefined, characteristics: f.characteristics ?? {}, requires: f.requires ?? [], excludes: f.excludes ?? [],
    salesChannels: f.salesChannels ?? [], variants: f.variants ?? [], deals: f.deals ?? [], suspension: f.suspension, group: f.group ?? undefined,
  } as unknown as NodeInput;
  return (await createNode(q, input, actor)) as OfferNode;
}

/** TMF620 PATCH (merge-patch): the attributes named are changed, the rest stay. Lifecycle and category changes use the catalog's own status and move rules. */
export async function tmfPatchOffering(q: Queryable, id: string, body: Record<string, any>, actor: string): Promise<OfferNode> {
  const cur = await getNode(q, id);
  if (cur.level !== 'OFFER') throw notFound('productOffering', id);
  const fields = offeringFields(body);
  if (Object.values(fields).some((v) => v !== undefined)) await updateNode(q, id, fields, actor);
  const toParent = Array.isArray(body.category) ? body.category[0]?.id : undefined;
  if (typeof toParent === 'string' && toParent !== cur.parentId) await moveNode(q, id, toParent, actor);
  if (body.lifecycleStatus !== undefined || body.validFor !== undefined) {
    const st = statusFromLifecycle(body.lifecycleStatus ?? LIFECYCLE[cur.status], body.validFor?.startDateTime ?? (cur.status === 'SCHEDULED' ? cur.activeFrom : undefined));
    if (st.status !== cur.status || st.activeFrom !== (cur.activeFrom ?? undefined)) await setStatus(q, id, st.status, actor, st.activeFrom);
  }
  return (await getNode(q, id)) as OfferNode;
}

export interface TmfCatalogFilter { offset: number; limit: number; lifecycleStatus?: string; categoryId?: string; name?: string; kind?: string; updatedAfter?: string }
const OFFSET_MAX = 10_000;
function pageArgs(f: { offset: number; limit: number }) {
  if (!Number.isInteger(f.offset) || f.offset < 0 || f.offset > OFFSET_MAX) throw invalid(`offset is 0 to ${OFFSET_MAX}. Narrow the search to go further.`);
  if (!Number.isInteger(f.limit) || f.limit < 1) throw invalid('limit must be a positive whole number.');
  return { offset: f.offset, limit: Math.min(f.limit, 100) };
}

/** A page of offers (counted up to 100,001) with what they refer to looked up in one query, ready for `toProductOffering`. */
export async function tmfListOfferings(q: Queryable, f: TmfCatalogFilter): Promise<{ items: Array<OfferNode & { updatedAt?: unknown }>; total: number; known: Known }> {
  const { offset, limit } = pageArgs(f);
  const args: unknown[] = [], p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where = [`level = 'OFFER'`];
  if (f.lifecycleStatus) { const st = STATUSES_FOR_LIFECYCLE[f.lifecycleStatus]; if (!st) throw invalid('lifecycleStatus is In design, Active or Retired.'); where.push(`status = ANY(${p(st)})`); }
  if (f.categoryId) where.push(`parent_id = ${p(f.categoryId)}`);
  if (f.name) where.push(`name = ${p(f.name)}`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.updatedAfter) { if (Number.isNaN(new Date(f.updatedAfter).getTime())) throw invalid('lastUpdate.gt is an ISO date-time.'); where.push(`updated_at > ${p(new Date(f.updatedAfter))}`); }
  const w = where.join(' AND ');
  const total = Number((await q.query(`SELECT count(*) AS n FROM (SELECT 1 FROM catalog_nodes WHERE ${w} LIMIT 100001) x`, args)).rows[0]!.n);
  const items = (await q.query(`SELECT * FROM catalog_nodes WHERE ${w} ORDER BY sort_order, name, id OFFSET ${p(offset)} LIMIT ${p(limit)}`, args)).rows.map(toNode) as Array<OfferNode & { updatedAt?: unknown }>;
  const known = await lookup(q, items.flatMap((o) => [o.parentId ?? '', ...(o.requires ?? []), ...(o.excludes ?? [])]));
  return { items, total, known };
}

export async function tmfGetOffering(q: Queryable, id: string): Promise<{ offer: OfferNode & { updatedAt?: unknown }; known: Known }> {
  const offer = await getNode(q, id);
  if (offer.level !== 'OFFER') throw notFound('productOffering', id);
  return { offer: offer as OfferNode, known: await lookup(q, [offer.parentId ?? '', ...(offer.requires ?? []), ...(offer.excludes ?? [])]) };
}

// ───────────────────────── Category (the hierarchy above offers) ─────────────────────────
type Child = { id: string; name: string };
export function toCategory(n: CatalogNode & { updatedAt?: unknown }, base: string, children: Child[] = [], parentName?: string): Record<string, unknown> {
  return {
    id: n.id, href: ref(base, 'category', n.id), name: n.name, version: String(n.version ?? 1), lastUpdate: n.updatedAt, lifecycleStatus: LIFECYCLE[n.status],
    ...(n.status === 'SCHEDULED' && n.activeFrom ? { validFor: { startDateTime: n.activeFrom } } : {}),
    isRoot: !n.parentId, ...(n.parentId ? { parentId: n.parentId } : {}),
    subCategory: children.map((c) => ({ id: c.id, href: ref(base, 'category', c.id), name: c.name, '@referredType': 'Category' })),
    ...(parentName ? { parent: { id: n.parentId, name: parentName } } : {}),
    '@type': 'Category',
    '@meridian': { level: n.level, ...(n.level === 'NETWORK_TYPE' ? { networkType: (n as { networkType?: string }).networkType } : {}) },
  };
}

const CATEGORY_LEVELS = ['NETWORK_TYPE', 'CATEGORY', 'GROUP'];
export async function tmfListCategories(q: Queryable, f: { offset: number; limit: number; parentId?: string; root?: boolean; lifecycleStatus?: string; name?: string }) {
  const { offset, limit } = pageArgs(f);
  const args: unknown[] = [], p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where = [`level IN ('NETWORK_TYPE','CATEGORY','GROUP')`];
  if (f.root) where.push('parent_id IS NULL');
  if (f.parentId) where.push(`parent_id = ${p(f.parentId)}`);
  if (f.name) where.push(`name = ${p(f.name)}`);
  if (f.lifecycleStatus) { const st = STATUSES_FOR_LIFECYCLE[f.lifecycleStatus]; if (!st) throw invalid('lifecycleStatus is In design, Active or Retired.'); where.push(`status = ANY(${p(st)})`); }
  const w = where.join(' AND ');
  const total = Number((await q.query(`SELECT count(*) AS n FROM catalog_nodes WHERE ${w}`, args)).rows[0]!.n);
  const items = (await q.query(`SELECT * FROM catalog_nodes WHERE ${w} ORDER BY path, sort_order, id OFFSET ${p(offset)} LIMIT ${p(limit)}`, args)).rows.map(toNode);
  return { items, total, children: await childrenOf(q, items.map((n) => n.id)), known: await lookup(q, items.map((n) => n.parentId ?? '')) };
}

async function childrenOf(q: Queryable, ids: string[]): Promise<Map<string, Child[]>> {
  const out = new Map<string, Child[]>();
  if (!ids.length) return out;
  const rows = (await q.query(`SELECT id, name, parent_id FROM catalog_nodes WHERE parent_id = ANY($1) AND level IN ('CATEGORY','GROUP') ORDER BY sort_order, name, id`, [ids])).rows;
  for (const r of rows) out.set(r.parentId, [...(out.get(r.parentId) ?? []), { id: r.id, name: r.name }]);
  return out;
}

export async function tmfGetCategory(q: Queryable, id: string) {
  const n = await getNode(q, id);
  if (!CATEGORY_LEVELS.includes(n.level)) throw notFound('category', id);
  return { node: n, children: (await childrenOf(q, [id])).get(id) ?? [], parentName: n.parentId ? (await lookup(q, [n.parentId])).get(n.parentId)?.name : undefined };
}

const LEVEL_UNDER: Record<string, 'CATEGORY' | 'GROUP'> = { NETWORK_TYPE: 'CATEGORY', CATEGORY: 'GROUP' };
export async function tmfCreateCategory(q: Queryable, body: Record<string, any>, actor: string): Promise<CatalogNode> {
  if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('name is required.');
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : undefined;
  let level: 'NETWORK_TYPE' | 'CATEGORY' | 'GROUP' = 'NETWORK_TYPE';
  if (parentId) {
    const parent = await getNode(q, parentId).catch(() => null);
    if (!parent) throw invalid(`parentId ${parentId} is not a category.`);
    if (parent.level === 'OFFER' || parent.level === 'LINE_ITEM' || parent.level === 'GROUP') throw invalid('A group holds offerings, not categories: create a productOffering with this group as its category.');
    level = LEVEL_UNDER[parent.level]!;
  }
  const st = statusFromLifecycle(body.lifecycleStatus ?? 'In design');
  if (st.status !== 'DRAFT' && st.status !== 'ACTIVE') throw invalid('A category is created In design or Active.');
  const networkType = body['@meridian']?.networkType;
  if (level === 'NETWORK_TYPE' && !['mobile', 'fiber', 'iot', 'none'].includes(networkType)) throw invalid('A root category is a network type: @meridian.networkType is mobile, fiber, iot or none.');
  const id = await newId(q, body.id, body.name);
  return createNode(q, { id, level, code: id, name: body.name.trim(), path: '', parentId: parentId ?? null, status: st.status, markets: [], ...(level === 'NETWORK_TYPE' ? { networkType } : {}) } as unknown as NodeInput, actor);
}

export async function tmfPatchCategory(q: Queryable, id: string, body: Record<string, any>, actor: string): Promise<CatalogNode> {
  const cur = await getNode(q, id);
  if (!CATEGORY_LEVELS.includes(cur.level)) throw notFound('category', id);
  const patch: NodePatch = {};
  if (body.name !== undefined) patch.name = String(body.name);
  if (body['@meridian']?.networkType !== undefined) patch.networkType = body['@meridian'].networkType;
  if (Object.keys(patch).length) await updateNode(q, id, patch, actor);
  if (typeof body.parentId === 'string' && body.parentId !== cur.parentId) await moveNode(q, id, body.parentId, actor);
  if (body.lifecycleStatus !== undefined) {
    const st = statusFromLifecycle(body.lifecycleStatus, body.validFor?.startDateTime);
    if (st.status !== cur.status) await setStatus(q, id, st.status, actor, st.activeFrom);
  }
  return getNode(q, id);
}

/** Deletes a category or an offering by the catalog's rule: empty, never sold, not used as a dependency. Otherwise retire it. */
export async function tmfDelete(q: Queryable, id: string, level: 'category' | 'offering', actor: string): Promise<void> {
  const n = await getNode(q, id);
  if (level === 'offering' ? n.level !== 'OFFER' : !CATEGORY_LEVELS.includes(n.level)) throw notFound(level === 'offering' ? 'productOffering' : 'category', id);
  await deleteNode(q, id, actor);
}

// ───────────────────────── Catalog (one) ─────────────────────────
export function toCatalog(roots: Child[], base: string): Record<string, unknown> {
  return {
    id: CATALOG_ID, href: ref(base, 'catalog', CATALOG_ID), name: 'Meridian catalogue', description: 'The product catalogue of this Meridian deployment', lifecycleStatus: 'Active', catalogType: 'ProductCatalog',
    category: roots.map((c) => ({ id: c.id, href: ref(base, 'category', c.id), name: c.name, '@referredType': 'Category' })), '@type': 'Catalog',
  };
}
export async function tmfCatalog(q: Queryable): Promise<Child[]> {
  return (await q.query(`SELECT id, name FROM catalog_nodes WHERE level = 'NETWORK_TYPE' ORDER BY sort_order, name, id`)).rows.map((r: Row) => ({ id: r.id as string, name: r.name as string }));
}
export const TMF_CATALOG_ID = CATALOG_ID;

// ───────────────────────── ProductSpecification (an offer's line items) ─────────────────────────
export function toProductSpecification(o: OfferNode & { updatedAt?: unknown }, items: LineItemNode[], base: string): Record<string, unknown> {
  return {
    id: o.id, href: ref(base, 'productSpecification', o.id), name: o.name, description: o.description ?? '', version: String(o.version ?? 1), lastUpdate: o.updatedAt, lifecycleStatus: LIFECYCLE[o.status],
    isBundle: false,
    productSpecCharacteristic: items.map((i) => ({
      id: i.id, name: i.name, description: i.description ?? '', valueType: i.unlimited || i.quantity === undefined ? 'string' : 'number', configurable: false, '@type': 'ProductSpecificationCharacteristic',
      productSpecCharacteristicValue: [{ value: i.unlimited ? 'Unlimited' : i.quantity ?? '', ...(i.unit ? { unitOfMeasure: i.unit } : {}), valueType: i.unlimited ? 'string' : 'number', isDefault: true }],
      '@meridian': { itemType: i.itemType, unlimited: !!i.unlimited, sku: i.sku, status: i.status },
    })),
    '@type': 'ProductSpecification',
  };
}

async function lineItems(q: Queryable, offerId: string): Promise<LineItemNode[]> {
  return (await q.query(`SELECT * FROM catalog_nodes WHERE parent_id=$1 AND level='LINE_ITEM' ORDER BY sort_order, name, id`, [offerId])).rows.map(toNode) as LineItemNode[];
}
export async function tmfGetSpecification(q: Queryable, id: string) {
  const { offer } = await tmfGetOffering(q, id);
  return { offer, items: await lineItems(q, id) };
}
export async function tmfListSpecifications(q: Queryable, f: { offset: number; limit: number }) {
  const page = await tmfListOfferings(q, f);
  const all = (await q.query(`SELECT * FROM catalog_nodes WHERE parent_id = ANY($1) AND level='LINE_ITEM' ORDER BY sort_order, name, id`, [page.items.map((o) => o.id)])).rows.map(toNode) as LineItemNode[];
  return { items: page.items.map((o) => ({ offer: o, items: all.filter((i) => i.parentId === o.id) })), total: page.total };
}

/**
 * PATCH of a specification: `productSpecCharacteristic`, when sent, is the complete list of what the offer includes. A characteristic with the id of an existing line
 * item updates it; one without an id (or an unknown id) adds a line item; a line item that is not in the list is removed. The catalog's rules apply to each.
 */
export async function tmfPatchSpecification(q: Queryable, id: string, body: Record<string, any>, actor: string) {
  const { offer } = await tmfGetOffering(q, id);
  if (Array.isArray(body.productSpecCharacteristic)) {
    const existing = await lineItems(q, id);
    const keep = new Set<string>();
    let n = existing.length;
    for (const [i, c] of (body.productSpecCharacteristic as any[]).entries()) {
      const where = `productSpecCharacteristic[${i}]`;
      if (typeof c?.name !== 'string' || !c.name.trim()) throw invalid(`${where}.name is required.`);
      const m = c['@meridian'] ?? {}, v = Array.isArray(c.productSpecCharacteristicValue) ? c.productSpecCharacteristicValue[0] : undefined;
      const itemType = String(m.itemType ?? 'OTHER');
      if (!(LINE_ITEM_TYPES as readonly string[]).includes(itemType)) throw invalid(`${where}.@meridian.itemType is one of ${LINE_ITEM_TYPES.join(', ')}.`);
      const unlimited = m.unlimited === true || /^unlimited$/i.test(String(v?.value ?? ''));
      const qty = unlimited || v?.value === undefined || v.value === '' ? undefined : Number(v.value);
      if (qty !== undefined && !Number.isFinite(qty)) throw invalid(`${where}.productSpecCharacteristicValue[0].value is a number, or "Unlimited".`);
      const fields = { name: c.name.trim(), itemType, description: c.description || undefined, quantity: qty, unit: v?.unitOfMeasure || undefined, unlimited, sku: m.sku || undefined };
      if (typeof c.id === 'string' && existing.some((e) => e.id === c.id)) {
        keep.add(c.id);
        await updateNode(q, c.id, { ...fields, quantity: qty ?? null } as unknown as NodePatch, actor);
      } else {
        let lid = `${id}-item-${++n}`.slice(0, 70);
        while ((await q.query('SELECT 1 FROM catalog_nodes WHERE id=$1', [lid])).rows.length) lid = `${id}-item-${++n}`.slice(0, 70);
        keep.add(lid);
        await createNode(q, { id: lid, level: 'LINE_ITEM', code: lid, parentId: id, path: '', status: offer.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT', markets: [], ...fields } as unknown as NodeInput, actor);
      }
    }
    for (const e of existing) if (!keep.has(e.id)) await deleteNode(q, e.id, actor);
  }
  return tmfGetSpecification(q, id);
}
