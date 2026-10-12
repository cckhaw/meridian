import type { Queryable } from './db.js';
import { invalid, notFound, rejected } from './errors.js';

export const MAIN_WAREHOUSE = 'WH-MAIN';

export async function listStock(q: Queryable, f: { locationId?: string; sku?: string } = {}) {
  const params: unknown[] = []; const where: string[] = [];
  if (f.locationId) where.push(`location_id = $${params.push(f.locationId)}`);
  if (f.sku) where.push(`sku ILIKE $${params.push(`%${f.sku}%`)}`);
  return (await q.query(
    `SELECT location_id, sku, on_hand, reserved, on_hand - reserved AS available FROM inventory_stock ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY location_id, sku`,
    params,
  )).rows;
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
