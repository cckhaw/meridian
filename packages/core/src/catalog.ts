import type { CatalogNode, ContractTerms, EtcQuote, FulfilmentSpec, OfferKind, OfferNode, PriceComponent } from '@meridian/types';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { quoteEtc } from './etc.js';
import { validateOffer, validateParent } from './hierarchy.js';

export type NodeInput = Omit<CatalogNode, 'createdAt' | 'updatedAt' | 'version'> & Partial<OfferNode>;

const toNode = (r: Row): CatalogNode => {
  const d = r.data ?? {};
  return {
    id: r.id, level: r.level, code: r.code, name: r.name, path: r.path, parentId: r.parentId, status: r.status,
    markets: r.markets, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
    ...(r.level === 'NETWORK_TYPE' ? { networkType: d.networkType } : {}),
    ...(r.level === 'OFFER'
      ? { kind: r.kind, description: d.description, prices: d.prices ?? [], contract: d.contract, fulfilment: d.fulfilment, partnerCode: d.partnerCode,
          characteristics: d.characteristics ?? {}, requires: d.requires ?? [], excludes: d.excludes ?? [] }
      : {}),
  } as CatalogNode;
};

export async function createNode(q: Queryable, input: NodeInput): Promise<CatalogNode> {
  if (!input.id || !/^[a-z0-9][a-z0-9-]*$/.test(input.id)) throw invalid('node id must be lowercase letters, digits and dashes');
  const parent = input.parentId ? (await q.query('SELECT level FROM catalog_nodes WHERE id=$1', [input.parentId])).rows[0] : null;
  if (input.parentId && !parent) throw notFound('parent', input.parentId);
  const err = validateParent(input, parent as { level: CatalogNode['level'] } | null);
  if (err) throw invalid(err);
  if (input.level === 'OFFER') {
    const errs = validateOffer(input as unknown as OfferNode);
    if (errs.length) throw invalid('invalid offer', errs);
  }
  const o = input as Partial<OfferNode> & { networkType?: string };
  const data = input.level === 'OFFER'
    ? { description: o.description, prices: o.prices, contract: o.contract, fulfilment: o.fulfilment, partnerCode: o.partnerCode,
        characteristics: o.characteristics ?? {}, requires: o.requires ?? [], excludes: o.excludes ?? [] }
    : { networkType: o.networkType };
  try {
    await q.query(
      `INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [input.id, input.level, input.code, input.name, input.path, input.parentId, input.status ?? 'DRAFT', o.kind ?? null, input.markets ?? [], JSON.stringify(data)],
    );
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw conflict(`catalog node ${input.id} or path ${input.path} already exists`);
    throw e;
  }
  return getNode(q, input.id);
}

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

export async function listNodes(q: Queryable, f: { status?: string; level?: string; kind?: string; pathPrefix?: string; q?: string; market?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (f.status) where.push(`status = ${p(f.status)}`);
  if (f.level) where.push(`level = ${p(f.level)}`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.pathPrefix) where.push(`(path = ${p(f.pathPrefix)} OR path LIKE ${p(f.pathPrefix + '/%')})`);
  if (f.q) where.push(`(name ILIKE ${p(`%${f.q}%`)} OR code ILIKE $${params.length})`);
  if (f.market) where.push(`(cardinality(markets) = 0 OR ${p(f.market)} = ANY(markets))`);
  const sql = `SELECT * FROM catalog_nodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY path`;
  return (await q.query(sql, params)).rows.map(toNode);
}

export async function setStatus(q: Queryable, id: string, status: 'ACTIVE' | 'RETIRED' | 'DRAFT') {
  const r = await q.query('UPDATE catalog_nodes SET status=$2, version=version+1, updated_at=now() WHERE id=$1', [id, status]);
  if (!r.rowCount) throw notFound('catalog node', id);
  return getNode(q, id);
}

export const monthlyFee = (o: OfferNode): PriceComponent | undefined => o.prices.find((p) => p.type === 'RECURRING');

export async function etcQuoteForOffer(q: Queryable, offerId: string, contractStart: Date, terminationDate: Date): Promise<EtcQuote> {
  const o = await getOffer(q, offerId);
  if (!o.contract) throw invalid('offer has no contract');
  return quoteEtc({ offerId, contract: o.contract as ContractTerms, contractStart, terminationDate, monthlyRecurring: monthlyFee(o)?.amount });
}

export type { FulfilmentSpec, OfferKind };
