import type { Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';
import { audit } from './audit.js';
import { assertStockLocation } from './warehouses.js';

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

export async function reserve(q: Queryable, orderId: string, locationId: string, sku: string, qty: number, group?: string) {
  const r = await q.query(
    `UPDATE inventory_stock SET reserved = reserved + $3 WHERE location_id = $1 AND sku = $2 AND on_hand - reserved >= $3`,
    [locationId, sku, qty],
  );
  if (!r.rowCount) {
    const have = (await q.query('SELECT on_hand - reserved AS avail FROM inventory_stock WHERE location_id=$1 AND sku=$2', [locationId, sku])).rows[0];
    throw rejected(`insufficient stock for ${sku} at ${locationId} (available ${have?.avail ?? 0}, need ${qty})`);
  }
  await q.query('INSERT INTO inventory_reservations (order_id, location_id, sku, quantity, fulfil_group) VALUES ($1,$2,$3,$4,$5)', [orderId, locationId, sku, qty, group ?? null]);
}

/** Goods leave the building: on_hand and reserved both drop. */
export async function consumeReservations(q: Queryable, orderId: string, group?: string) {
  const rs = (await q.query('SELECT * FROM inventory_reservations WHERE order_id=$1 AND consumed_at IS NULL AND released_at IS NULL AND ($2::text IS NULL OR fulfil_group = $2)', [orderId, group ?? null])).rows;
  for (const r of rs) {
    await q.query('UPDATE inventory_stock SET on_hand = on_hand - $3, reserved = reserved - $3 WHERE location_id=$1 AND sku=$2', [r.locationId, r.sku, r.quantity]);
    await q.query('UPDATE inventory_reservations SET consumed_at = now() WHERE id=$1', [r.id]);
  }
}

export async function releaseReservations(q: Queryable, orderId: string, group?: string) {
  const rs = (await q.query('SELECT * FROM inventory_reservations WHERE order_id=$1 AND consumed_at IS NULL AND released_at IS NULL AND ($2::text IS NULL OR fulfil_group = $2)', [orderId, group ?? null])).rows;
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

/** Goods that were handed over come back into stock (a return in good condition). */
export async function restockConsumed(q: Queryable, orderId: string, group: string) {
  const rs = (await q.query('SELECT * FROM inventory_reservations WHERE order_id=$1 AND consumed_at IS NOT NULL AND fulfil_group=$2', [orderId, group])).rows;
  for (const r of rs) await q.query('UPDATE inventory_stock SET on_hand = on_hand + $3 WHERE location_id=$1 AND sku=$2', [r.locationId, r.sku, r.quantity]);
  return rs.length;
}

// ───────────────────────── stock movements: receipts, write-offs, history ─────────────────────────
export const WRITE_OFF_REASONS = ['DAMAGED', 'LOST', 'EXPIRED', 'THEFT', 'COUNT', 'OTHER'] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];
export type MovementKind = 'RECEIPT' | 'IMPORT' | 'WRITE_OFF' | 'COUNT' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'TRANSFER_SHORT';

/** Leaves a line in the stock history. `onHand` is the quantity after the movement. */
export async function recordMovement(q: Queryable, m: { locationId: string; sku: string; delta: number; onHand: number; kind: MovementKind; reason?: string | null; note?: string | null; actor: string }) {
  await q.query(
    `INSERT INTO stock_movements (location_id, sku, delta, on_hand, kind, reason, note, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [m.locationId, m.sku, m.delta, m.onHand, m.kind, m.reason ?? null, m.note?.trim().slice(0, 300) || null, m.actor]);
}

const sku_ = (s: string) => s.trim().toUpperCase();

/** Goods receipt, one SKU at a time (for bigger deliveries use the CSV import). */
export async function receiveStock(q: Queryable, actor: string, i: { locationId: string; sku: string; quantity: number; note?: string }) {
  if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 1_000_000) throw invalid('Receive a whole number of units, at least 1.');
  const sku = sku_(i.sku);
  await assertStockLocation(q, i.locationId);
  const r = await adjustStock(q, i.locationId, sku, i.quantity);
  await recordMovement(q, { locationId: i.locationId, sku, delta: i.quantity, onHand: Number(r?.onHand), kind: 'RECEIPT', note: i.note, actor });
  await audit(q, actor, 'inventory', `${i.locationId}/${sku}`, 'RECEIVED', { quantity: i.quantity });
  return r;
}

/** Writing stock off (damaged, lost, expired, stolen, or a count that came up short). Needs a reason, and never goes below what is reserved. */
export async function writeOffStock(q: Queryable, actor: string, i: { locationId: string; sku: string; quantity: number; reason: string; note?: string }) {
  if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 1_000_000) throw invalid('Write off a whole number of units, at least 1.');
  if (!(WRITE_OFF_REASONS as readonly string[]).includes(i.reason)) throw invalid(`Choose why the stock is written off: ${WRITE_OFF_REASONS.join(', ')}.`);
  if (i.reason === 'OTHER' && !(i.note ?? '').trim()) throw invalid('Say what happened when the reason is Other.');
  const sku = sku_(i.sku);
  const cur = (await q.query('SELECT on_hand, reserved FROM inventory_stock WHERE location_id=$1 AND sku=$2 FOR UPDATE', [i.locationId, sku])).rows[0];
  if (!cur) throw notFound('stock record', `${sku}@${i.locationId}`);
  const free = Number(cur.onHand) - Number(cur.reserved);
  if (i.quantity > free) throw rejected(`Only ${free} of ${sku} at ${i.locationId} can be written off${Number(cur.reserved) ? ` (${cur.reserved} are reserved for orders)` : ''}; you asked for ${i.quantity}.`);
  const r = await adjustStock(q, i.locationId, sku, -i.quantity);
  await recordMovement(q, { locationId: i.locationId, sku, delta: -i.quantity, onHand: Number(r?.onHand), kind: 'WRITE_OFF', reason: i.reason, note: i.note, actor });
  await audit(q, actor, 'inventory', `${i.locationId}/${sku}`, 'WRITTEN_OFF', { quantity: i.quantity, reason: i.reason });
  return r;
}

export async function listMovements(q: Queryable, f: { locationId?: string; sku?: string; kind?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.locationId) where.push(`location_id = ${p(f.locationId)}`);
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.sku?.trim()) where.push(`sku LIKE ${p(likePrefix(f.sku.trim().toUpperCase()))}`);
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`id < ${p(Number(cur[0]))}::bigint`);
  const rows = (await q.query(`SELECT id::text AS id, at, location_id, sku, delta, on_hand, kind, reason, note, actor FROM stock_movements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.id as string]);
}
