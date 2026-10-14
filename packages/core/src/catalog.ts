import type { CatalogNode, CatalogNodeLevel, ContractTerms, EtcQuote, LineItemNode, OfferNode, PriceComponent } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { quoteEtc } from './etc.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { validateLineItem, validateOffer, validateParent } from './hierarchy.js';
import { expandKinds, prepareOffer } from './offer-config.js';
import { getRegional, marketMode } from './settings.js';

export type NodeInput = Omit<CatalogNode, 'createdAt' | 'updatedAt' | 'version'> & Partial<OfferNode> & Partial<Pick<LineItemNode, 'itemType' | 'quantity' | 'unit' | 'unlimited' | 'sku'>> & { networkType?: string };

const toNode = (r: Row): CatalogNode & { sortOrder: number } => {
  const d = r.data ?? {};
  return {
    id: r.id, level: r.level, code: r.code, name: r.name, path: r.path, parentId: r.parentId, status: r.status, activeFrom: r.activeFrom ? new Date(r.activeFrom).toISOString() : null,
    markets: r.markets, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt, sortOrder: r.sortOrder ?? 0,
    ...(r.level === 'NETWORK_TYPE' ? { networkType: d.networkType } : {}),
    ...(r.level === 'OFFER'
      ? { kind: r.kind, template: d.template ?? r.kind, description: d.description, prices: d.prices ?? [], contract: d.contract, fulfilment: d.fulfilment, partnerCode: d.partnerCode,
          characteristics: d.characteristics ?? {}, requires: d.requires ?? [], excludes: d.excludes ?? [], salesChannels: d.salesChannels ?? [], variants: d.variants ?? [], deals: d.deals ?? [] }
      : {}),
    ...(r.level === 'LINE_ITEM'
      ? { itemType: d.itemType, description: d.description, quantity: d.quantity, unit: d.unit, unlimited: !!d.unlimited, sku: d.sku }
      : {}),
  } as CatalogNode & { sortOrder: number };
};

const lineItemData = (i: Partial<LineItemNode>) => ({ itemType: i.itemType, description: i.description || undefined, quantity: i.unlimited ? undefined : i.quantity, unit: i.unit || undefined, unlimited: !!i.unlimited, sku: i.sku || undefined });

const offerData = (o: Partial<OfferNode>) => ({
  template: o.template, description: o.description, prices: o.prices, contract: o.contract, fulfilment: o.fulfilment, partnerCode: o.partnerCode,
  characteristics: o.characteristics ?? {}, requires: o.requires ?? [], excludes: o.excludes ?? [], salesChannels: o.salesChannels ?? [], variants: o.variants ?? [], deals: o.deals ?? [], suspension: o.suspension,
});

// ───────────────────────── reads ─────────────────────────
export async function getNode(q: Queryable, id: string): Promise<CatalogNode> {
  const r = (await q.query('SELECT * FROM catalog_nodes WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('catalog node', id);
  return toNode(r);
}

export async function getOffer(q: Queryable, id: string): Promise<OfferNode> {
  const n = await getNode(q, id);
  if (n.level !== 'OFFER') throw invalid(`${id} is not an offer`);
  return n;
}

export async function listNodes(q: Queryable, f: { status?: string; level?: string; kind?: string; pathPrefix?: string; q?: string; market?: string; channel?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (f.status) where.push(`status = ${p(f.status)}`);
  if (f.level) where.push(`level = ${p(f.level)}`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.pathPrefix) where.push(`(path = ${p(f.pathPrefix)} OR path LIKE ${p(f.pathPrefix + '/%')})`);
  if (f.q) where.push(`(name ILIKE ${p(`%${f.q}%`)} OR code ILIKE $${params.length})`);
  if (f.market && (await marketMode(q)).multiple) where.push(`(cardinality(markets) = 0 OR ${p(f.market)} = ANY(markets))`);
  // An offer with no channel list is sold everywhere; otherwise the channel must be listed.
  if (f.channel) where.push(`(level <> 'OFFER' OR jsonb_array_length(COALESCE(data->'salesChannels','[]'::jsonb)) = 0 OR data->'salesChannels' ? ${p(f.channel)})`);
  const sql = `SELECT * FROM catalog_nodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY path`;
  return (await q.query(sql, params)).rows.map(toNode);
}

export type CatalogTreeNode = CatalogNode & {
  sortOrder: number;
  children: CatalogTreeNode[];
  /** Offers beneath this node (all statuses), and how many of those are ACTIVE. */
  offerCount: number;
  activeOfferCount: number;
  /** Offers only: how much it is already sold, which decides what can still be edited in place. */
  usage?: { services: number; orders: number };
};

/** The whole hierarchy as a nested tree, siblings in the operator's order. */
export async function catalogTree(q: Queryable): Promise<CatalogTreeNode[]> {
  const rows = (await q.query('SELECT * FROM catalog_nodes')).rows.map(toNode);
  const usage = new Map<string, { services: number; orders: number }>();
  for (const r of (await q.query('SELECT offer_id, count(*) AS n FROM services GROUP BY offer_id')).rows) usage.set(r.offerId, { services: r.n, orders: 0 });
  for (const r of (await q.query('SELECT offer_id, count(*) AS n FROM order_lines GROUP BY offer_id')).rows) usage.set(r.offerId, { services: usage.get(r.offerId)?.services ?? 0, orders: r.n });
  const nodes = new Map<string, CatalogTreeNode>(rows.map((n) => [n.id, { ...n, children: [], offerCount: 0, activeOfferCount: 0, ...(n.level === 'OFFER' ? { usage: usage.get(n.id) ?? { services: 0, orders: 0 } } : {}) } as CatalogTreeNode]));
  const roots: CatalogTreeNode[] = [];
  for (const n of nodes.values()) (n.parentId ? nodes.get(n.parentId)?.children : roots)?.push(n);
  const order = (a: CatalogTreeNode, b: CatalogTreeNode) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const walk = (n: CatalogTreeNode): void => {
    n.children.sort(order);
    for (const c of n.children) { walk(c); n.offerCount += c.level === 'OFFER' ? 1 : c.offerCount; n.activeOfferCount += c.level === 'OFFER' ? (c.status === 'ACTIVE' ? 1 : 0) : c.activeOfferCount; }
  };
  roots.sort(order);
  roots.forEach(walk);
  return roots;
}

// ───────────────────────── dependencies ─────────────────────────
interface Graph { nodes: Map<string, { id: string; name: string; path: string; level: CatalogNodeLevel; requires: string[] }>; offers: string[] }

async function loadGraph(q: Queryable): Promise<Graph> {
  const rows = (await q.query(`SELECT id, name, path, level, data->'requires' AS requires FROM catalog_nodes`)).rows;
  const nodes = new Map(rows.map((r) => [r.id as string, { id: r.id, name: r.name, path: r.path, level: r.level, requires: (r.requires ?? []) as string[] }]));
  return { nodes, offers: rows.filter((r) => r.level === 'OFFER').map((r) => r.id) };
}

/** A requirement token is an offer id or a hierarchy node id; returns the offers it stands for ("any offer beneath this node"). */
function expand(g: Graph, token: string): string[] {
  const n = g.nodes.get(token);
  if (!n) return [];
  if (n.level === 'OFFER') return [n.id];
  return [...g.nodes.values()].filter((o) => o.level === 'OFFER' && (o.path === n.path || o.path.startsWith(n.path + '/'))).map((o) => o.id);
}

/** Rejects references to things that do not exist, self-references, and circular chains (A needs B needs A). */
async function assertDependenciesValid(q: Queryable, offerId: string, offerPath: string, requires: string[], excludes: string[]) {
  const graph = await loadGraph(q);
  // The offer being created/edited must be part of the graph (with its new requirements), or a requirement on its own group or a cycle through a group would go unseen.
  graph.nodes.set(offerId, { id: offerId, name: graph.nodes.get(offerId)?.name ?? offerId, path: offerPath, level: 'OFFER', requires });
  const missing = [...requires, ...excludes].filter((t) => !graph.nodes.has(t));
  if (missing.length) throw invalid(`unknown product or hierarchy node: ${missing.join(', ')}`);
  if ([...requires, ...excludes].some((t) => graph.nodes.get(t)!.level === 'LINE_ITEM')) throw invalid('a line item cannot be a prerequisite or conflict; choose the offer or a hierarchy level');
  if (excludes.some((t) => graph.nodes.get(t)!.level !== 'OFFER')) throw invalid('"cannot be combined with" must list offers, not hierarchy levels');
  const self = requires.filter((t) => expand(graph, t).includes(offerId));
  if (self.length) throw invalid('an offer cannot require itself (or the group it belongs to)');
  const clash = requires.filter((t) => excludes.some((e) => expand(graph, t).includes(e)));
  if (clash.length) throw invalid(`${clash.join(', ')} is both required and excluded`);
  // Walk what this offer would require; if the chain returns here, it is circular.
  const seen = new Set<string>();
  const dfs = (id: string, path: string[]): string[] | null => {
    if (id === offerId && path.length) return path;
    if (seen.has(id)) return null;
    seen.add(id);
    const toks = id === offerId ? requires : graph.nodes.get(id)?.requires ?? [];
    for (const t of toks) for (const next of expand(graph, t)) { const r = dfs(next, [...path, next]); if (r) return r; }
    return null;
  };
  const cyc = dfs(offerId, []);
  if (cyc) throw invalid(`circular dependency: ${[offerId, ...cyc].map((i) => graph.nodes.get(i)?.name ?? i).join(' → ')}`);
}

/** Offers the customer already holds: a live service, or a completed purchase (physical goods have no service). */
export async function ownedOfferIds(q: Queryable, customerId: string | null, among: string[]): Promise<Set<string>> {
  if (!customerId || !among.length) return new Set();
  const rows = (await q.query(
    `SELECT DISTINCT offer_id FROM services WHERE customer_id=$1 AND status IN ('ACTIVE','SUSPENDED','PORTING_OUT') AND offer_id = ANY($2::text[])
     UNION
     SELECT DISTINCT ol.offer_id FROM order_lines ol JOIN orders o ON o.shard_id = ol.shard_id AND o.id = ol.order_id
       WHERE o.customer_id=$1 AND o.state = 'COMPLETED' AND ol.offer_id = ANY($2::text[])`, [customerId, among])).rows;
  return new Set(rows.map((r) => r.offerId as string));
}

/**
 * Checks prerequisites and conflicts for a basket. A prerequisite is met by the same order or by what the customer already owns.
 * Returns human-readable violations (empty = fine).
 */
export async function checkDependencies(q: Queryable, customerId: string | null, offerIds: string[]): Promise<string[]> {
  if (!offerIds.length) return [];
  // Only the offers in the basket and the nodes they point at are read, so checking a basket costs the same in a catalog of ten offers or ten thousand.
  const rows = (await q.query(`SELECT id, name, path, data->'requires' AS requires, data->'excludes' AS excludes FROM catalog_nodes WHERE id = ANY($1::text[])`, [offerIds])).rows;
  const tokens = [...new Set(rows.flatMap((r) => (r.requires ?? []) as string[]))];
  const nodes = new Map<string, Row>((tokens.length ? (await q.query(`SELECT id, name, level, path FROM catalog_nodes WHERE id = ANY($1::text[])`, [tokens])).rows : []).map((r) => [r.id as string, r]));
  const beneath = (t: Row, o: Row) => o.id === t.id || o.path === t.path || o.path.startsWith(`${t.path}/`);
  const owned = new Map<string, boolean>();
  const owns = async (t: Row): Promise<boolean> => {
    if (!customerId) return false;
    if (!owned.has(t.id)) {
      const r = await q.query(
        `SELECT 1 FROM catalog_nodes c WHERE (c.id = $2 OR c.path LIKE $3) AND c.level = 'OFFER' AND (
           EXISTS (SELECT 1 FROM services s WHERE s.customer_id = $1 AND s.offer_id = c.id AND s.status IN ('ACTIVE','SUSPENDED','PORTING_OUT'))
           OR EXISTS (SELECT 1 FROM order_lines ol JOIN orders o ON o.shard_id = ol.shard_id AND o.id = ol.order_id WHERE o.customer_id = $1 AND o.state = 'COMPLETED' AND ol.offer_id = c.id)) LIMIT 1`,
        [customerId, t.id, `${String(t.path).replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`]);
      owned.set(t.id, r.rows.length > 0);
    }
    return owned.get(t.id)!;
  };
  const out: string[] = [];
  const inCart = new Set(offerIds);
  for (const me of rows) {
    for (const t of (me.requires ?? []) as string[]) {
      const tn = nodes.get(t);
      if (tn && (rows.some((o) => beneath(tn, o)) || (await owns(tn)))) continue;
      out.push(`${me.name} requires ${tn?.level === 'OFFER' ? tn.name : `any ${tn?.name ?? t} offer`}. Buy one in the same order or own one already.`);
    }
  }
  const excluded = [...new Set(rows.flatMap((r) => (r.excludes ?? []) as string[]).filter((e) => inCart.has(e)))];
  const names = new Map<string, string>((excluded.length ? (await q.query(`SELECT id, name FROM catalog_nodes WHERE id = ANY($1::text[])`, [excluded])).rows : []).map((r) => [r.id as string, r.name as string]));
  for (const r of rows) for (const e of (r.excludes ?? []) as string[]) if (inCart.has(e)) out.push(`${r.name} cannot be combined with ${names.get(e) ?? e}.`);
  return out;
}

// ───────────────────────── writes ─────────────────────────
/** Every price is in the currency set in Settings → Regional: one deployment, one currency. */
async function assertCurrency(q: Queryable, prices: PriceComponent[]) {
  const { currency } = await getRegional(q);
  const bad = prices.find((p) => p.amount.currency !== currency);
  if (bad) throw invalid(`prices are in ${currency} (Settings → Regional); this one is in ${bad.amount.currency}`);
}

/** A SKU is reserved from exactly one place: the offer's fulfilment list, or a single line item of that offer. */
async function assertSkuFree(q: Queryable, offerId: string, sku: string, exceptItemId: string | null) {
  const offer = (await q.query(`SELECT data->'fulfilment'->'inventorySkus' AS skus FROM catalog_nodes WHERE id=$1`, [offerId])).rows[0];
  if (((offer?.skus ?? []) as string[]).includes(sku)) throw invalid(`SKU ${sku} is already reserved by the offer itself; list it in one place only`);
  const other = (await q.query(`SELECT name FROM catalog_nodes WHERE parent_id=$1 AND level='LINE_ITEM' AND data->>'sku'=$2 AND id <> $3 LIMIT 1`, [offerId, sku, exceptItemId ?? ''])).rows[0];
  if (other) throw invalid(`SKU ${sku} is already used by the line item “${other.name}”`);
}

export async function createNode(q: Queryable, input: NodeInput, actor = 'system'): Promise<CatalogNode> {
  if (!input.id || !/^[a-z0-9][a-z0-9-]*$/.test(input.id)) throw invalid('node id must be lowercase letters, digits and dashes');
  const parent = input.parentId ? (await q.query('SELECT level, path FROM catalog_nodes WHERE id=$1', [input.parentId])).rows[0] : null;
  if (input.parentId && !parent) throw notFound('parent', input.parentId);
  const err = validateParent(input, parent as { level: CatalogNode['level'] } | null);
  if (err) throw invalid(err);
  const path = parent ? `${parent.path}/${input.id}` : input.id;     // the path is always derived, never trusted from the client
  if (input.level === 'OFFER') {
    Object.assign(input, await prepareOffer(q, input as unknown as OfferNode)); // the type's behaviour template, and the fulfilment flags from the chosen options
    await assertCurrency(q, (input as unknown as OfferNode).prices ?? []);
    const errs = validateOffer(input as unknown as OfferNode);
    if (errs.length) throw invalid('invalid offer', errs);
    await assertDependenciesValid(q, input.id, path, input.requires ?? [], input.excludes ?? []);
  }
  if ((input.level as CatalogNodeLevel) === 'LINE_ITEM') {
    const errs = validateLineItem(input as unknown as LineItemNode);
    if (errs.length) throw invalid(errs.join(' '), errs);
    if (input.sku) await assertSkuFree(q, input.parentId!, input.sku, null);
  }
  const level: CatalogNodeLevel = input.level;
  const data = level === 'OFFER' ? offerData(input) : level === 'LINE_ITEM' ? lineItemData(input as unknown as Partial<LineItemNode>) : { networkType: input.networkType };
  const next = (await q.query('SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM catalog_nodes WHERE parent_id IS NOT DISTINCT FROM $1', [input.parentId ?? null])).rows[0]!.n as number;
  try {
    await q.query(
      `INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order, active_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [input.id, input.level, input.id, input.name, path, input.parentId ?? null, input.status ?? 'DRAFT', input.kind ?? null, input.markets ?? [], JSON.stringify(data), next, input.status === 'SCHEDULED' ? scheduleDate(input.activeFrom) : null],
    );
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw conflict(`catalog node ${input.id} or path ${path} already exists`);
    throw e;
  }
  await audit(q, actor, 'catalog', input.id, 'NODE_CREATED', { level: input.level });
  return getNode(q, input.id);
}

export interface NodePatch {
  itemType?: string; quantity?: number | null; unit?: string; unlimited?: boolean; sku?: string;
  name?: string; networkType?: string; markets?: string[];
  kind?: string; description?: string; prices?: PriceComponent[]; contract?: ContractTerms; fulfilment?: OfferNode['fulfilment'];
  partnerCode?: string; characteristics?: OfferNode['characteristics']; requires?: string[]; excludes?: string[]; salesChannels?: string[]; variants?: OfferNode['variants']; deals?: OfferNode['deals']; suspension?: OfferNode['suspension'];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function nodeUsage(q: Queryable, id: string): Promise<{ services: number; orders: number; referencedBy: string[] }> {
  const s = (await q.query('SELECT count(*) AS n FROM services WHERE offer_id=$1', [id])).rows[0]!.n as number;
  const o = (await q.query('SELECT count(*) AS n FROM order_lines WHERE offer_id=$1', [id])).rows[0]!.n as number;
  const refs = (await q.query(
    `SELECT name FROM catalog_nodes WHERE id <> $1 AND (data->'requires' ? $1 OR data->'excludes' ? $1)`, [id])).rows.map((r) => r.name as string);
  return { services: s, orders: o, referencedBy: refs };
}

/**
 * Edits a node. Names, descriptions, fulfilment, dependencies, channels and markets can always change.
 * Price, contract and type of an offer that has been sold cannot: existing subscribers are billed from the catalog, so the change would
 * silently reprice them. For those, create a new version and retire the old one.
 */
export async function updateNode(q: Queryable, id: string, patch: NodePatch, actor = 'system'): Promise<CatalogNode> {
  const cur = (await q.query('SELECT * FROM catalog_nodes WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw notFound('catalog node', id);
  const node = toNode(cur);
  const name = patch.name?.trim() ?? node.name;
  if (!name) throw invalid('name is required');
  const data = { ...(cur.data ?? {}) };
  let kind = cur.kind as string | null;
  let markets = patch.markets ?? (cur.markets as string[]);

  if (node.level === 'NETWORK_TYPE') {
    if (patch.networkType) data.networkType = patch.networkType;
  } else if (node.level === 'LINE_ITEM') {
    const li = node as LineItemNode;
    const next = {
      ...li, itemType: (patch.itemType ?? li.itemType) as LineItemNode['itemType'], description: patch.description ?? li.description,
      unlimited: patch.unlimited ?? li.unlimited, quantity: patch.unlimited ? undefined : patch.quantity !== undefined ? (patch.quantity ?? undefined) : li.quantity,
      unit: patch.unit ?? li.unit, sku: patch.sku !== undefined ? (patch.sku || undefined) : li.sku,
    } as LineItemNode;
    const errs = validateLineItem(next);
    if (errs.length) throw invalid(errs.join(' '), errs);
    if (next.sku) await assertSkuFree(q, cur.parentId, next.sku, id);
    Object.assign(data, lineItemData(next));
  } else if (node.level === 'OFFER') {
    const o = node as OfferNode;
    const next = {
      ...o, name, markets,
      kind: (patch.kind ?? o.kind) as OfferNode['kind'], description: patch.description ?? o.description, prices: patch.prices ?? o.prices,
      contract: patch.contract ?? o.contract, fulfilment: patch.fulfilment ?? o.fulfilment, partnerCode: patch.partnerCode ?? o.partnerCode,
      characteristics: patch.characteristics ?? o.characteristics, requires: patch.requires ?? o.requires, excludes: patch.excludes ?? o.excludes, salesChannels: patch.salesChannels ?? o.salesChannels ?? [], variants: patch.variants ?? o.variants ?? [], deals: patch.deals ?? o.deals ?? [], suspension: patch.suspension ?? o.suspension,
    } as OfferNode;
    const commercialChange = !same(next.prices, o.prices) || !same(next.contract, o.contract) || next.kind !== o.kind;
    if (commercialChange) {
      const u = await nodeUsage(q, id);
      if (u.services + u.orders > 0) throw rejected(`This offer is already sold (${u.services} services, ${u.orders} order lines), so its price, contract or type can’t change in place: existing subscribers would be repriced. Create a new version and retire this one.`);
    }
    const prepared = await prepareOffer(q, next, { kind: o.kind, options: o.fulfilment?.options });
    Object.assign(next, prepared);
    if (patch.prices) await assertCurrency(q, next.prices);
    const errs = validateOffer(next);
    if (errs.length) throw invalid('invalid offer', errs);
    // A SKU is reserved once: either on the offer's fulfilment or on one of its line items.
    const itemSkus = (await q.query(`SELECT data->>'sku' AS sku FROM catalog_nodes WHERE parent_id=$1 AND level='LINE_ITEM' AND data->>'sku' IS NOT NULL`, [id])).rows.map((r) => r.sku as string);
    const dupe = (next.fulfilment?.inventorySkus ?? []).filter((x) => itemSkus.includes(x));
    if (dupe.length) throw invalid(`stock SKU ${dupe.join(', ')} is already reserved by one of this offer's line items`);
    await assertDependenciesValid(q, id, cur.path, next.requires, next.excludes);
    Object.assign(data, offerData(next));
    kind = next.kind;
  }
  await q.query(`UPDATE catalog_nodes SET name=$2, kind=$3, markets=$4, data=$5, version=version+1, updated_at=now() WHERE id=$1`, [id, name, kind, markets, JSON.stringify(data)]);
  await audit(q, actor, 'catalog', id, 'NODE_UPDATED', { fields: Object.keys(patch) });
  return getNode(q, id);
}

/** A go-live date must be a real date in the future. */
function scheduleDate(v: string | null | undefined): Date {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw invalid('choose the date it goes live');
  if (d.getTime() <= Date.now()) throw invalid('the go-live date must be in the future');
  return d;
}

export async function setStatus(q: Queryable, id: string, status: 'ACTIVE' | 'RETIRED' | 'DRAFT' | 'SCHEDULED', actor = 'system', activeFrom?: string | null) {
  const when = status === 'SCHEDULED' ? scheduleDate(activeFrom) : null;
  const r = await q.query('UPDATE catalog_nodes SET status=$2, active_from=$3, version=version+1, updated_at=now() WHERE id=$1', [id, status, when]);
  if (!r.rowCount) throw notFound('catalog node', id);
  await audit(q, actor, 'catalog', id, `STATUS_${status}`, when ? { activeFrom: when.toISOString() } : undefined);
  return getNode(q, id);
}

/** Makes every scheduled node whose date has arrived live. Cheap (partial index), so it is safe to call often. */
export async function activateDueNodes(q: Queryable): Promise<number> {
  const r = await q.query(`UPDATE catalog_nodes SET status='ACTIVE', version=version+1, updated_at=now() WHERE status='SCHEDULED' AND active_from <= now() RETURNING id`);
  for (const row of r.rows) await audit(q, 'system', 'catalog', row.id as string, 'STATUS_ACTIVE', { scheduled: true });
  return r.rowCount ?? 0;
}

/** Moves a node under another parent of the correct level and rewrites the paths of everything beneath it. */
export async function moveNode(q: Queryable, id: string, newParentId: string | null, actor = 'system'): Promise<CatalogNode> {
  const cur = (await q.query('SELECT * FROM catalog_nodes WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw notFound('catalog node', id);
  const parent = newParentId ? (await q.query('SELECT id, level, path FROM catalog_nodes WHERE id=$1', [newParentId])).rows[0] : null;
  if (newParentId && !parent) throw notFound('parent', newParentId);
  const err = validateParent({ level: cur.level }, (parent ?? null) as { level: CatalogNode["level"] } | null);
  if (err) throw invalid(err);
  if (parent && (parent.path === cur.path || parent.path.startsWith(cur.path + '/'))) throw invalid('cannot move a node under itself');
  if ((cur.parentId ?? null) === (newParentId ?? null)) return getNode(q, id);
  const newPath = parent ? `${parent.path}/${id}` : id;
  if ((await q.query('SELECT 1 FROM catalog_nodes WHERE path=$1', [newPath])).rows.length) throw conflict(`${newPath} already exists`);
  const next = (await q.query('SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM catalog_nodes WHERE parent_id IS NOT DISTINCT FROM $1', [newParentId])).rows[0]!.n as number;
  const old = cur.path as string;
  await q.query(`UPDATE catalog_nodes SET path = $2 || substr(path, length($1) + 1), updated_at = now() WHERE path = $1 OR path LIKE $1 || '/%'`, [old, newPath]);
  await q.query('UPDATE catalog_nodes SET parent_id=$2, sort_order=$3 WHERE id=$1', [id, newParentId, next]);
  await audit(q, actor, 'catalog', id, 'NODE_MOVED', { from: old, to: newPath });
  return getNode(q, id);
}

/** Swaps a node with its previous or next sibling. */
export async function reorderNode(q: Queryable, id: string, direction: 'up' | 'down', actor = 'system') {
  const cur = (await q.query('SELECT id, parent_id, sort_order FROM catalog_nodes WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound('catalog node', id);
  const sibs = (await q.query('SELECT id, sort_order FROM catalog_nodes WHERE parent_id IS NOT DISTINCT FROM $1 ORDER BY sort_order, name', [cur.parentId])).rows;
  const i = sibs.findIndex((s) => s.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= sibs.length) return;
  // Re-number so ties and gaps never make a swap a no-op.
  const order = sibs.map((s) => s.id as string);
  [order[i], order[j]] = [order[j]!, order[i]!];
  for (const [k, sid] of order.entries()) await q.query('UPDATE catalog_nodes SET sort_order=$2 WHERE id=$1', [sid, (k + 1) * 10]);
  await audit(q, actor, 'catalog', id, 'NODE_REORDERED', { direction });
}

/** Deletes an empty, never-sold, unreferenced node. Anything else should be retired instead. */
export async function deleteNode(q: Queryable, id: string, actor = 'system') {
  const cur = (await q.query('SELECT id, level FROM catalog_nodes WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound('catalog node', id);
  const kids = (await q.query('SELECT count(*) AS n FROM catalog_nodes WHERE parent_id=$1', [id])).rows[0]!.n as number;
  // An offer's line items are part of it: they go with it. Every other level must be emptied first.
  if (kids && cur.level !== 'OFFER') throw rejected(`It still contains ${kids} item${kids === 1 ? '' : 's'}. Move or delete them first, or retire it instead.`);
  const u = await nodeUsage(q, id);
  if (u.services + u.orders > 0) throw rejected(`It has been sold (${u.services} services, ${u.orders} order lines). Retire it instead; history is kept.`);
  if (u.referencedBy.length) throw rejected(`It is used as a dependency by: ${u.referencedBy.join(', ')}. Remove those dependencies first.`);
  if (kids) await q.query('DELETE FROM catalog_nodes WHERE parent_id=$1 AND level=\'LINE_ITEM\'', [id]);
  await q.query('DELETE FROM catalog_nodes WHERE id=$1', [id]);
  await audit(q, actor, 'catalog', id, 'NODE_DELETED', { level: cur.level });
}

/** Copies one offer's line items onto another (used when creating a new version of an offer). SKUs are not copied twice onto an offer that already lists them. */
export async function copyLineItems(q: Queryable, fromOfferId: string, toOfferId: string, actor = 'system'): Promise<number> {
  await getOffer(q, fromOfferId); await getOffer(q, toOfferId);
  const items = (await q.query(`SELECT * FROM catalog_nodes WHERE parent_id=$1 AND level='LINE_ITEM' ORDER BY sort_order, name`, [fromOfferId])).rows.map(toNode) as Array<LineItemNode & { sortOrder: number }>;
  let n = 0;
  for (const it of items) {
    let id = `${toOfferId}-${it.id.slice(fromOfferId.length + 1) || `i${n + 1}`}`.slice(0, 70);
    while ((await q.query('SELECT 1 FROM catalog_nodes WHERE id=$1', [id])).rows.length) id = `${id}x`.slice(0, 70);
    await createNode(q, { id, level: 'LINE_ITEM', code: id, name: it.name, path: '', parentId: toOfferId, status: it.status === 'RETIRED' ? 'DRAFT' : it.status, markets: [], itemType: it.itemType, description: it.description, quantity: it.quantity, unit: it.unit, unlimited: it.unlimited, sku: it.sku } as unknown as NodeInput, actor);
    n++;
  }
  return n;
}

export const monthlyFee = (o: OfferNode): PriceComponent | undefined => o.prices.find((p) => p.type === 'RECURRING');

export async function etcQuoteForOffer(q: Queryable, offerId: string, contractStart: Date, terminationDate: Date): Promise<EtcQuote> {
  const o = await getOffer(q, offerId);
  if (!o.contract) throw invalid('offer has no contract');
  return quoteEtc({ offerId, contract: o.contract as ContractTerms, contractStart, terminationDate, monthlyRecurring: monthlyFee(o)?.amount });
}


// ───────────────────────── lazy reads for the catalog browser ─────────────────────────
// The browser never loads the tree. It asks for one level at a time (browse), searches by words (search), and opens one node (detail).
// Each is bounded and uses an index: children by (parent_id, sort_order, name), search by the full-text index, counts by parent_id.

export type BrowseNode = CatalogNode & { sortOrder: number; offerCount: number; activeOfferCount: number; lineItemCount: number };
export interface TrailStep { id: string; name: string; level: CatalogNodeLevel }

/** Offers beneath each node, counted level by level through `parent_id` (index-only), so a page of 50 categories costs one query. */
async function decorate(q: Queryable, nodes: Array<CatalogNode & { sortOrder: number }>): Promise<BrowseNode[]> {
  const counts = new Map<string, { n: number; a: number }>();
  const items = new Map<string, number>();
  const byLevel = (l: string) => nodes.filter((n) => n.level === l).map((n) => n.id);
  const add = (rows: Row[]) => { for (const r of rows) counts.set(r.k, { n: Number(r.n), a: Number(r.a) }); };
  const groups = byLevel('GROUP'), cats = byLevel('CATEGORY'), nets = byLevel('NETWORK_TYPE'), offers = byLevel('OFFER');
  if (groups.length) add((await q.query(`SELECT o.parent_id AS k, count(*) AS n, count(*) FILTER (WHERE o.status='ACTIVE') AS a FROM catalog_nodes o WHERE o.level='OFFER' AND o.parent_id = ANY($1) GROUP BY o.parent_id`, [groups])).rows);
  if (cats.length) add((await q.query(`SELECT g.parent_id AS k, count(*) AS n, count(*) FILTER (WHERE o.status='ACTIVE') AS a FROM catalog_nodes g JOIN catalog_nodes o ON o.parent_id = g.id AND o.level='OFFER' WHERE g.parent_id = ANY($1) GROUP BY g.parent_id`, [cats])).rows);
  if (nets.length) add((await q.query(`SELECT c.parent_id AS k, count(*) AS n, count(*) FILTER (WHERE o.status='ACTIVE') AS a FROM catalog_nodes c JOIN catalog_nodes g ON g.parent_id = c.id JOIN catalog_nodes o ON o.parent_id = g.id AND o.level='OFFER' WHERE c.parent_id = ANY($1) GROUP BY c.parent_id`, [nets])).rows);
  if (offers.length) for (const r of (await q.query(`SELECT parent_id AS k, count(*) AS n FROM catalog_nodes WHERE level='LINE_ITEM' AND parent_id = ANY($1) GROUP BY parent_id`, [offers])).rows) items.set(r.k, Number(r.n));
  return nodes.map((n) => ({ ...n, offerCount: counts.get(n.id)?.n ?? 0, activeOfferCount: counts.get(n.id)?.a ?? 0, lineItemCount: items.get(n.id) ?? 0 }));
}

/** One level of the catalog (null parent = the network types), a page at a time. Line items are not structure; they come with their offer. */
export async function browseChildren(q: Queryable, f: { parentId?: string | null; activeOnly?: boolean; limit?: number; cursor?: string } = {}): Promise<Page<BrowseNode>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where = [f.parentId ? `parent_id = ${p(f.parentId)}` : 'parent_id IS NULL', `level <> 'LINE_ITEM'`];
  if (f.activeOnly) where.push(`status = 'ACTIVE'`);
  const cur = decodeCursor(f.cursor, 3);
  if (cur) where.push(`(sort_order, name, id) > (${p(cur[0])}::int, ${p(cur[1])}::text, ${p(cur[2])}::text)`);
  const rows = (await q.query(`SELECT * FROM catalog_nodes WHERE ${where.join(' AND ')} ORDER BY sort_order, name, id LIMIT ${p(limit + 1)}`, params)).rows.map(toNode);
  const page = toPage(rows, limit, (n) => [n.sortOrder, n.name, n.id]);
  return { items: await decorate(q, page.items), nextCursor: page.nextCursor };
}

export interface Ancestor extends TrailStep { status: string }
/** Ancestors of each node, root first, found by following `parent_id` (so catalogs whose stored paths are stale still resolve), in one query. */
export async function ancestorsFor(q: Queryable, ids: string[]): Promise<Map<string, Ancestor[]>> {
  const out = new Map<string, Ancestor[]>(ids.map((i) => [i, []]));
  if (!ids.length) return out;
  const rows = (await q.query(
    `WITH RECURSIVE up AS (
       SELECT id AS leaf, parent_id AS pid, 1 AS depth FROM catalog_nodes WHERE id = ANY($1) AND parent_id IS NOT NULL
       UNION ALL
       SELECT up.leaf, p.parent_id, up.depth + 1 FROM up JOIN catalog_nodes p ON p.id = up.pid WHERE p.parent_id IS NOT NULL AND up.depth < 8
     ) SELECT up.leaf, n.id, n.name, n.level, n.status, up.depth FROM up JOIN catalog_nodes n ON n.id = up.pid ORDER BY up.leaf, up.depth DESC`, [ids])).rows;
  for (const r of rows) out.get(r.leaf)!.push({ id: r.id, name: r.name, level: r.level, status: r.status });
  return out;
}

async function trailsFor(q: Queryable, nodes: Array<{ id: string }>): Promise<Map<string, TrailStep[]>> {
  const a = await ancestorsFor(q, nodes.map((n) => n.id));
  return new Map([...a].map(([k, v]) => [k, v.map(({ status: _s, ...t }) => t)]));
}

/** Word search over names and codes ("100gb fam" finds "Family 100GB"), returning where each result lives. Never `%term%`. */
export async function searchNodes(q: Queryable, f: { q: string; level?: string; activeOnly?: boolean; limit?: number; cursor?: string }): Promise<Page<BrowseNode & { trail: TrailStep[] }>> {
  const limit = pageSize(f.limit, 30, 100);
  const words = f.q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5);
  const levels = (f.level ?? '').split(',').filter(Boolean); // e.g. "GROUP,CATEGORY"
  if (!words.length && !levels.length) return { items: [], nextCursor: null };
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (words.length) where.push(`(to_tsvector('simple', name || ' ' || code) @@ to_tsquery('simple', ${p(words.map((w) => `${w}:*`).join(' & '))}) OR id = ${p(f.q.trim().toLowerCase())})`);
  if (levels.length) where.push(`level = ANY(${p(levels)})`); // with no words this lists that level in path order, for pickers
  // Sales-only users never see anything that sits under a node which is not live.
  if (f.activeOnly) where.push(`status = 'ACTIVE' AND NOT EXISTS (
    WITH RECURSIVE up(id, parent_id, status) AS (
      SELECT a.id, a.parent_id, a.status FROM catalog_nodes a WHERE a.id = catalog_nodes.parent_id
      UNION ALL SELECT a.id, a.parent_id, a.status FROM catalog_nodes a JOIN up ON a.id = up.parent_id)
    SELECT 1 FROM up WHERE status <> 'ACTIVE')`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(path, id) > (${p(cur[0])}::text, ${p(cur[1])}::text)`);
  const rows = (await q.query(`SELECT * FROM catalog_nodes WHERE ${where.join(' AND ')} ORDER BY path, id LIMIT ${p(limit + 1)}`, params)).rows.map(toNode);
  const page = toPage(rows, limit, (n) => [n.path, n.id]);
  const [dec, trails] = await Promise.all([decorate(q, page.items), trailsFor(q, page.items)]);
  return { items: dec.map((n) => ({ ...n, trail: trails.get(n.id) ?? [] })), nextCursor: page.nextCursor };
}

/** The same search for sellable offers, as full nodes (price, contract, rules) — what a sales screen needs to list and add them. */
export async function pageOffers(q: Queryable, f: { q?: string; status?: string; market?: string; channel?: string; kind?: string; notKind?: string; limit?: number; cursor?: string }): Promise<Page<CatalogNode>> {
  const limit = pageSize(f.limit, 24, 100);
  const { params, p } = sqlBuilder();
  const where = [`level = 'OFFER'`];
  if (f.status) where.push(`status = ${p(f.status)}`);
  // Comma-separated, and each may be a type id or a behaviour template ("every SIM + device type").
  if (f.kind) where.push(`kind = ANY(${p(await expandKinds(q, f.kind.split(',').filter(Boolean)))})`);
  if (f.notKind) where.push(`kind <> ALL(${p(await expandKinds(q, f.notKind.split(',').filter(Boolean)))})`);
  if (f.market && (await marketMode(q)).multiple) where.push(`(cardinality(markets) = 0 OR ${p(f.market)} = ANY(markets))`);
  if (f.channel) where.push(`(jsonb_array_length(COALESCE(data->'salesChannels','[]'::jsonb)) = 0 OR data->'salesChannels' ? ${p(f.channel)})`);
  const words = (f.q ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5);
  if (words.length) where.push(`to_tsvector('simple', name || ' ' || code) @@ to_tsquery('simple', ${p(words.map((w) => `${w}:*`).join(' & '))})`);
  const cur = decodeCursor(f.cursor, 3);
  if (cur) where.push(`(sort_order, name, id) > (${p(cur[0])}::int, ${p(cur[1])}::text, ${p(cur[2])}::text)`);
  const rows = (await q.query(`SELECT * FROM catalog_nodes WHERE ${where.join(' AND ')} ORDER BY sort_order, name, id LIMIT ${p(limit + 1)}`, params)).rows.map(toNode);
  return toPage(rows, limit, (n) => [n.sortOrder, n.name, n.id]);
}

export interface NodeDetail {
  node: BrowseNode;
  trail: TrailStep[];
  lineItems: CatalogNode[];
  requires: Array<{ id: string; name: string; level: CatalogNodeLevel } | { id: string; missing: true }>;
  excludes: Array<{ id: string; name: string; level: CatalogNodeLevel } | { id: string; missing: true }>;
  /** Offers only. Counted up to 100,000 so opening a best-seller never scans millions of rows; `capped` says the real number is higher. */
  usage?: { services: number; orders: number; capped: boolean };
}

const CAP = 100_000;
export async function nodeDetail(q: Queryable, id: string, opts: { activeOnly?: boolean } = {}): Promise<NodeDetail> {
  const raw = (await q.query('SELECT * FROM catalog_nodes WHERE id=$1', [id])).rows[0];
  if (!raw) throw notFound('catalog node', id);
  const base = toNode(raw);
  const [node] = await decorate(q, [base]);
  const chain = (await ancestorsFor(q, [id])).get(id) ?? [];
  const trail: TrailStep[] = chain.map(({ status: _s, ...t }) => t);
  if (opts.activeOnly && (base.status !== 'ACTIVE' || chain.some((a) => a.status !== 'ACTIVE'))) throw notFound('catalog node', id);
  const out: NodeDetail = { node: node!, trail, lineItems: [], requires: [], excludes: [] };
  if (base.level === 'OFFER') {
    out.lineItems = (await q.query(`SELECT * FROM catalog_nodes WHERE parent_id=$1 AND level='LINE_ITEM'${opts.activeOnly ? ` AND status='ACTIVE'` : ''} ORDER BY sort_order, name, id LIMIT 200`, [id])).rows.map(toNode);
    const o = base as OfferNode;
    const refIds = [...new Set([...o.requires, ...o.excludes])];
    const known = new Map<string, TrailStep>((refIds.length ? (await q.query('SELECT id, name, level FROM catalog_nodes WHERE id = ANY($1)', [refIds])).rows : []).map((r) => [r.id as string, { id: r.id, name: r.name, level: r.level }]));
    const ref = (rid: string) => known.get(rid) ?? { id: rid, missing: true as const };
    out.requires = o.requires.map(ref); out.excludes = o.excludes.map(ref);
    const cnt = async (t: string) => Number((await q.query(`SELECT count(*) AS n FROM (SELECT 1 FROM ${t} WHERE offer_id=$1 LIMIT ${CAP + 1}) x`, [id])).rows[0]!.n);
    const [services, orders] = await Promise.all([cnt('services'), cnt('order_lines')]);
    out.usage = { services: Math.min(services, CAP), orders: Math.min(orders, CAP), capped: services > CAP || orders > CAP };
  }
  return out;
}

/** Totals for the catalog overview, in one grouped pass over the (small) level index. */
export async function catalogSummary(q: Queryable, opts: { activeOnly?: boolean } = {}): Promise<{ levels: Record<string, number>; offersLive: number; offers: number }> {
  const rows = (await q.query(`SELECT level, count(*) AS n, count(*) FILTER (WHERE status='ACTIVE') AS a FROM catalog_nodes ${opts.activeOnly ? `WHERE status='ACTIVE'` : ''} GROUP BY level`)).rows;
  const levels: Record<string, number> = {};
  for (const r of rows) levels[r.level] = Number(r.n);
  const offer = rows.find((r) => r.level === 'OFFER');
  return { levels, offers: Number(offer?.n ?? 0), offersLive: Number(offer?.a ?? 0) };
}
