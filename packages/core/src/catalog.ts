import type { CatalogNode, CatalogNodeLevel, ContractTerms, EtcQuote, OfferNode, PriceComponent } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { quoteEtc } from './etc.js';
import { validateOffer, validateParent } from './hierarchy.js';

export type NodeInput = Omit<CatalogNode, 'createdAt' | 'updatedAt' | 'version'> & Partial<OfferNode> & { networkType?: string };

const toNode = (r: Row): CatalogNode & { sortOrder: number } => {
  const d = r.data ?? {};
  return {
    id: r.id, level: r.level, code: r.code, name: r.name, path: r.path, parentId: r.parentId, status: r.status,
    markets: r.markets, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt, sortOrder: r.sortOrder ?? 0,
    ...(r.level === 'NETWORK_TYPE' ? { networkType: d.networkType } : {}),
    ...(r.level === 'OFFER'
      ? { kind: r.kind, description: d.description, prices: d.prices ?? [], contract: d.contract, fulfilment: d.fulfilment, partnerCode: d.partnerCode,
          characteristics: d.characteristics ?? {}, requires: d.requires ?? [], excludes: d.excludes ?? [], salesChannels: d.salesChannels ?? [] }
      : {}),
  } as CatalogNode & { sortOrder: number };
};

const offerData = (o: Partial<OfferNode>) => ({
  description: o.description, prices: o.prices, contract: o.contract, fulfilment: o.fulfilment, partnerCode: o.partnerCode,
  characteristics: o.characteristics ?? {}, requires: o.requires ?? [], excludes: o.excludes ?? [], salesChannels: o.salesChannels ?? [],
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
  if (f.market) where.push(`(cardinality(markets) = 0 OR ${p(f.market)} = ANY(markets))`);
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
  const g = await loadGraph(q);
  const inCart = new Set(offerIds);
  const out: string[] = [];
  const needed = new Set<string>();
  for (const id of offerIds) for (const t of g.nodes.get(id)?.requires ?? []) for (const o of expand(g, t)) needed.add(o);
  const owned = await ownedOfferIds(q, customerId, [...needed]);
  for (const id of offerIds) {
    const me = g.nodes.get(id);
    if (!me) continue;
    for (const t of me.requires) {
      const options = expand(g, t);
      if (options.some((o) => inCart.has(o) || owned.has(o))) continue;
      const tn = g.nodes.get(t);
      out.push(`${me.name} requires ${tn?.level === 'OFFER' ? tn.name : `any ${tn?.name ?? t} offer`}. Buy one in the same order or own one already.`);
    }
  }
  const ex = (await q.query(`SELECT id, name, data->'excludes' AS excludes FROM catalog_nodes WHERE id = ANY($1::text[])`, [offerIds])).rows;
  for (const r of ex) for (const e of (r.excludes ?? []) as string[]) if (inCart.has(e)) out.push(`${r.name} cannot be combined with ${g.nodes.get(e)?.name ?? e}.`);
  return out;
}

// ───────────────────────── writes ─────────────────────────
export async function createNode(q: Queryable, input: NodeInput, actor = 'system'): Promise<CatalogNode> {
  if (!input.id || !/^[a-z0-9][a-z0-9-]*$/.test(input.id)) throw invalid('node id must be lowercase letters, digits and dashes');
  const parent = input.parentId ? (await q.query('SELECT level, path FROM catalog_nodes WHERE id=$1', [input.parentId])).rows[0] : null;
  if (input.parentId && !parent) throw notFound('parent', input.parentId);
  const err = validateParent(input, parent as { level: CatalogNode['level'] } | null);
  if (err) throw invalid(err);
  const path = parent ? `${parent.path}/${input.id}` : input.id;     // the path is always derived, never trusted from the client
  if (input.level === 'OFFER') {
    const errs = validateOffer(input as unknown as OfferNode);
    if (errs.length) throw invalid('invalid offer', errs);
    await assertDependenciesValid(q, input.id, path, input.requires ?? [], input.excludes ?? []);
  }
  const data = input.level === 'OFFER' ? offerData(input) : { networkType: input.networkType };
  const next = (await q.query('SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM catalog_nodes WHERE parent_id IS NOT DISTINCT FROM $1', [input.parentId ?? null])).rows[0]!.n as number;
  try {
    await q.query(
      `INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.id, input.level, input.id, input.name, path, input.parentId ?? null, input.status ?? 'DRAFT', input.kind ?? null, input.markets ?? [], JSON.stringify(data), next],
    );
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw conflict(`catalog node ${input.id} or path ${path} already exists`);
    throw e;
  }
  await audit(q, actor, 'catalog', input.id, 'NODE_CREATED', { level: input.level });
  return getNode(q, input.id);
}

export interface NodePatch {
  name?: string; networkType?: string; markets?: string[];
  kind?: string; description?: string; prices?: PriceComponent[]; contract?: ContractTerms; fulfilment?: OfferNode['fulfilment'];
  partnerCode?: string; characteristics?: OfferNode['characteristics']; requires?: string[]; excludes?: string[]; salesChannels?: string[];
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
  } else if (node.level === 'OFFER') {
    const o = node as OfferNode;
    const next = {
      ...o, name, markets,
      kind: (patch.kind ?? o.kind) as OfferNode['kind'], description: patch.description ?? o.description, prices: patch.prices ?? o.prices,
      contract: patch.contract ?? o.contract, fulfilment: patch.fulfilment ?? o.fulfilment, partnerCode: patch.partnerCode ?? o.partnerCode,
      characteristics: patch.characteristics ?? o.characteristics, requires: patch.requires ?? o.requires, excludes: patch.excludes ?? o.excludes, salesChannels: patch.salesChannels ?? o.salesChannels ?? [],
    } as OfferNode;
    const commercialChange = !same(next.prices, o.prices) || !same(next.contract, o.contract) || next.kind !== o.kind;
    if (commercialChange) {
      const u = await nodeUsage(q, id);
      if (u.services + u.orders > 0) throw rejected(`This offer is already sold (${u.services} services, ${u.orders} order lines), so its price, contract or type can’t change in place: existing subscribers would be repriced. Create a new version and retire this one.`);
    }
    const errs = validateOffer(next);
    if (errs.length) throw invalid('invalid offer', errs);
    await assertDependenciesValid(q, id, cur.path, next.requires, next.excludes);
    Object.assign(data, offerData(next));
    kind = next.kind;
  }
  await q.query(`UPDATE catalog_nodes SET name=$2, kind=$3, markets=$4, data=$5, version=version+1, updated_at=now() WHERE id=$1`, [id, name, kind, markets, JSON.stringify(data)]);
  await audit(q, actor, 'catalog', id, 'NODE_UPDATED', { fields: Object.keys(patch) });
  return getNode(q, id);
}

export async function setStatus(q: Queryable, id: string, status: 'ACTIVE' | 'RETIRED' | 'DRAFT', actor = 'system') {
  const r = await q.query('UPDATE catalog_nodes SET status=$2, version=version+1, updated_at=now() WHERE id=$1', [id, status]);
  if (!r.rowCount) throw notFound('catalog node', id);
  await audit(q, actor, 'catalog', id, `STATUS_${status}`);
  return getNode(q, id);
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
  if (kids) throw rejected(`It still contains ${kids} item${kids === 1 ? '' : 's'}. Move or delete them first, or retire it instead.`);
  const u = await nodeUsage(q, id);
  if (u.services + u.orders > 0) throw rejected(`It has been sold (${u.services} services, ${u.orders} order lines). Retire it instead; history is kept.`);
  if (u.referencedBy.length) throw rejected(`It is used as a dependency by: ${u.referencedBy.join(', ')}. Remove those dependencies first.`);
  await q.query('DELETE FROM catalog_nodes WHERE id=$1', [id]);
  await audit(q, actor, 'catalog', id, 'NODE_DELETED', { level: cur.level });
}

export const monthlyFee = (o: OfferNode): PriceComponent | undefined => o.prices.find((p) => p.type === 'RECURRING');

export async function etcQuoteForOffer(q: Queryable, offerId: string, contractStart: Date, terminationDate: Date): Promise<EtcQuote> {
  const o = await getOffer(q, offerId);
  if (!o.contract) throw invalid('offer has no contract');
  return quoteEtc({ offerId, contract: o.contract as ContractTerms, contractStart, terminationDate, monthlyRecurring: monthlyFee(o)?.amount });
}
