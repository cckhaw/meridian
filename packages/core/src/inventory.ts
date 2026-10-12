import type { Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';

export const MAIN_WAREHOUSE = 'WH-MAIN';

export async function listStock(q: Queryable, f: { locationId?: string; sku?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.locationId) where.push(`location_id = ${p(f.locationId)}`);
  if (f.sku?.trim()) where.push(`sku LIKE ${p(likePrefix(f.sku.trim().toUpperCase()))}`); // SKUs are upper-case; prefix search uses the index
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(location_id, sku) > (${p(cur[0])}::text, ${p(cur[1])}::text)`);
  const rows = (await q.query(
    `SELECT location_id, sku, on_hand, reserved, on_hand - reserved AS available FROM inventory_stock ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY location_id, sku LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.locationId as string, r.sku as string]);
}

/** Distinct locations holding stock — a small list (stores and warehouses), derived without scanning every SKU row via a recursive skip-scan. */
export async function listStockLocations(q: Queryable): Promise<string[]> {
  const r = await q.query(
    `WITH RECURSIVE loc AS (
       (SELECT location_id FROM inventory_stock ORDER BY location_id LIMIT 1)
       UNION ALL
       SELECT (SELECT location_id FROM inventory_stock WHERE location_id > loc.location_id ORDER BY location_id LIMIT 1) FROM loc WHERE loc.location_id IS NOT NULL
     ) SELECT location_id FROM loc WHERE location_id IS NOT NULL LIMIT 500`);
  return r.rows.map((x) => x.locationId as string);
}

/** Goods receipt (positive) or write-off / count correction (negative). Never lets on_hand drop below reserved. */
export async function adjustStock(q: Queryable, locationId: string, sku: string, delta: number) {
  if (!Number.isInteger(delta) || delta === 0) throw invalid('delta must be a non-zero integer');
  const r = await q.query(
    `INSERT INTO inventory_stock (location_id, sku, on_hand) VALUES ($1,$2,GREATEST($3,0))
     ON CONFLICT (location_id, sku) DO UPDATE SET on_hand = inventory_stock.on_hand + $3
     WHERE inventory_stock.on_hand + $3 >= inventory_stock.reserved RETURNING on_hand, reserved`,
    [locationId, sku, delta],
  );
  if (!r.rowCount) throw rejected(`cannot reduce ${sku} at ${locationId} below reserved quantity (or below zero)`);
  return r.rows[0];
}

export async function reserve(q: Queryable, orderId: string, locationId: string, sku: string, qty: number) {
  const r = await q.query(
    `UPDATE inventory_stock SET reserved = reserved + $3 WHERE location_id = $1 AND sku = $2 AND on_hand - reserved >= $3`,
    [locationId, sku, qty],
  );
  if (!r.rowCount) {
    const have = (await q.query('SELECT on_hand - reserved AS avail FROM inventory_stock WHERE location_id=$1 AND sku=$2', [locationId, sku])).rows[0];
    throw rejected(`insufficient stock for ${sku} at ${locationId} (available ${have?.avail ?? 0}, need ${qty})`);
  }
  await q.query('INSERT INTO inventory_reservations (order_id, location_id, sku, quantity) VALUES ($1,$2,$3,$4)', [orderId, locationId, sku, qty]);
}

/** Goods leave the building: on_hand and reserved both drop. */
export async function consumeReservations(q: Queryable, orderId: string) {
  const rs = (await q.query('SELECT * FROM inventory_reservations WHERE order_id=$1 AND consumed_at IS NULL AND released_at IS NULL', [orderId])).rows;
  for (const r of rs) {
    await q.query('UPDATE inventory_stock SET on_hand = on_hand - $3, reserved = reserved - $3 WHERE location_id=$1 AND sku=$2', [r.locationId, r.sku, r.quantity]);
    await q.query('UPDATE inventory_reservations SET consumed_at = now() WHERE id=$1', [r.id]);
  }
}

export async function releaseReservations(q: Queryable, orderId: string) {
  const rs = (await q.query('SELECT * FROM inventory_reservations WHERE order_id=$1 AND consumed_at IS NULL AND released_at IS NULL', [orderId])).rows;
  for (const r of rs) {
    await q.query('UPDATE inventory_stock SET reserved = reserved - $3 WHERE location_id=$1 AND sku=$2', [r.locationId, r.sku, r.quantity]);
    await q.query('UPDATE inventory_reservations SET released_at = now() WHERE id=$1', [r.id]);
  }
}

export async function stockAt(q: Queryable, locationId: string, sku: string) {
  const r = (await q.query('SELECT on_hand, reserved FROM inventory_stock WHERE location_id=$1 AND sku=$2', [locationId, sku])).rows[0];
  if (!r) throw notFound('stock record', `${sku}@${locationId}`);
  return r;
}
