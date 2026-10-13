import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';

/** Retail stores: master data kept in the CRM. A store user is bound to one store and sees only its orders and stock. */
const text = (v: string | undefined | null, max: number, what: string) => { const t = v?.trim(); if (t && t.length > max) throw invalid(`${what} is too long (max ${max} characters)`); return t || null; };

export interface StoreInput { name: string; address?: string; phone?: string; marketCode?: string }

export async function listStores(q: Queryable, f: { q?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  const term = f.q?.trim();
  if (term) where.push(`(upper(s.id) LIKE ${p(likePrefix(term.toUpperCase()))} OR lower(s.name) LIKE ${p(likePrefix(term.toLowerCase()))})`);
  if (f.status) where.push(`s.status = ${p(f.status)}`);
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`s.id > ${p(cur[0])}::text`);
  const rows = (await q.query(
    `SELECT s.id, s.name, s.status, s.market_code, s.address, s.phone, s.created_at,
            (SELECT count(*) FROM users u WHERE u.store_id = s.id AND u.status = 'ACTIVE') AS staff_count
       FROM stores s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.id as string]);
}

export async function getStore(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM stores WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('store', id);
  return r;
}

/** The store id is issued by the system (STORE-00001, …) and never edited, so staff, orders and stock can always be traced to it. */
export async function createStore(q: Queryable, actor: string, i: StoreInput): Promise<Row> {
  const name = text(i.name, 120, 'the name');
  if (!name) throw invalid('a store needs a name');
  if ((await q.query('SELECT 1 FROM stores WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already a store called ${name}`);
  const r = await q.query(
    `INSERT INTO stores (id, name, market_code, address, phone, created_by) VALUES ('STORE-' || lpad(nextval('store_id_seq')::text, 5, '0'), $1,$2,$3,$4,$5) RETURNING *`,
    [name, i.marketCode?.trim().toUpperCase().slice(0, 2) || null, text(i.address, 300, 'the address'), text(i.phone, 40, 'the phone number'), actor]);
  const s = r.rows[0]!;
  await audit(q, actor, 'store', s.id as string, 'create', { name });
  return s;
}

export async function updateStore(q: Queryable, actor: string, id: string, p: Partial<StoreInput> & { status?: 'ACTIVE' | 'INACTIVE' }): Promise<Row> {
  const cur = await getStore(q, id);
  const name = p.name === undefined ? cur.name : text(p.name, 120, 'the name');
  if (!name) throw invalid('a store needs a name');
  if (String(name).toLowerCase() !== String(cur.name).toLowerCase() && (await q.query('SELECT 1 FROM stores WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already a store called ${name}`);
  const r = await q.query(
    `UPDATE stores SET name=$2, status=$3, address=$4, phone=$5, market_code=$6, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, name, p.status ?? cur.status, p.address === undefined ? cur.address : text(p.address, 300, 'the address'), p.phone === undefined ? cur.phone : text(p.phone, 40, 'the phone number'),
     p.marketCode === undefined ? cur.marketCode : (p.marketCode.trim().toUpperCase().slice(0, 2) || null)]);
  await audit(q, actor, 'store', id, 'update', { ...p });
  return r.rows[0]!;
}

/** A store that has never been used can be removed. One with staff, orders or stock is kept for the record: switch it off instead. */
export async function deleteStore(q: Queryable, actor: string, id: string): Promise<void> {
  await getStore(q, id);
  const used = (await q.query(
    `SELECT (SELECT count(*) FROM users WHERE store_id=$1) AS staff, (SELECT count(*) FROM orders WHERE store_id=$1) AS orders, (SELECT count(*) FROM inventory_stock WHERE location_id=$1) AS stock`, [id])).rows[0]!;
  if (Number(used.staff) || Number(used.orders) || Number(used.stock)) {
    const what = [Number(used.staff) && `${used.staff} staff`, Number(used.orders) && `${used.orders} orders`, Number(used.stock) && 'stock records'].filter(Boolean).join(', ');
    throw rejected(`this store has ${what}, so it cannot be removed. Switch it off instead: it stays in the record but cannot be chosen any more.`);
  }
  await q.query('DELETE FROM stores WHERE id=$1', [id]);
  await audit(q, actor, 'store', id, 'delete', {});
}

/** A store a user may be bound to or an order may be sold at: it must exist and be switched on. */
export async function assertStoreUsable(q: Queryable, id: string): Promise<Row> {
  const s = (await q.query('SELECT id, name, status FROM stores WHERE id=$1', [id])).rows[0];
  if (!s) throw invalid(`unknown store ${id}: stores are set up under Stores`);
  if (s.status !== 'ACTIVE') throw invalid(`${s.name} is switched off`);
  return s;
}
