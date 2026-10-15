import { audit } from './audit.js';
import { addDays, today } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { adjustStock, recordMovement } from './inventory.js';
import { auditIdentifier } from './nrm.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { assertStockLocation } from './warehouses.js';

/**
 * Moving stock between warehouses and stores, in three steps so nothing is ever in two places or in none:
 *   REQUESTED  asked for; nothing has moved (availability is checked now and again at dispatch)
 *   IN_TRANSIT the sender dispatched it: the stock has left the sender and is not yet anywhere
 *   RECEIVED   the receiver counted it in: the stock is theirs. Fewer than sent is recorded as a discrepancy
 * A request can be cancelled; a transfer on the road can be sent back (RETURNED), which puts the stock back with the sender.
 * Goods move by SKU. Physical SIM cards move one by one; a SIM on the road cannot be sold. A SIM that never arrives is written off as lost in transit.
 */
export interface StockTransferSims { iccids?: string[]; /** The next free cards at the sender. */ count?: number }
export interface StockTransferInput { from: string; to: string; lines?: Array<{ sku: string; quantity: number }>; sims?: StockTransferSims; note?: string }
export interface StockTransferScope { storeId?: string | null }

const sku_ = (s: string) => s.trim().toUpperCase();
const isWarehouse = async (q: Queryable, id: string) => (await q.query('SELECT 1 FROM warehouses WHERE id=$1', [id])).rows.length > 0;

/** A store user may only handle transfers into or out of their own store. */
function checkScope(t: { from: string; to: string }, scope: StockTransferScope, side: 'from' | 'to' | 'either') {
  if (!scope.storeId) return;
  const ok = side === 'from' ? t.from === scope.storeId : side === 'to' ? t.to === scope.storeId : t.from === scope.storeId || t.to === scope.storeId;
  if (!ok) throw rejected(side === 'from' ? 'Only the sending location can do this.' : side === 'to' ? 'Only the receiving location can do this.' : 'That transfer does not involve your store.');
}

export async function nextTransferNumber(q: Queryable): Promise<string> {
  const n = Number((await q.query(`SELECT nextval('stock_transfer_seq') AS n`)).rows[0]!.n);
  return `TRF-${today().replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
}

async function loadTransfer(q: Queryable, id: string, lock = false): Promise<Row> {
  const t = (await q.query(`SELECT * FROM stock_transfers WHERE ${/^TRF-/.test(id) ? 'number' : 'id'}=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!t) throw notFound('transfer', id);
  return t;
}
export async function getTransfer(q: Queryable, id: string): Promise<Row> {
  const t = await loadTransfer(q, id);
  const [lines, sims] = await Promise.all([
    q.query('SELECT sku, quantity, received FROM stock_transfer_lines WHERE transfer_id=$1 ORDER BY sku', [t.id]),
    q.query('SELECT iccid, received FROM stock_transfer_sims WHERE transfer_id=$1 ORDER BY iccid LIMIT 500', [t.id]),
  ]);
  const simCount = Number((await q.query('SELECT count(*) AS n FROM stock_transfer_sims WHERE transfer_id=$1', [t.id])).rows[0]!.n);
  return { ...t, lines: lines.rows, sims: sims.rows, simCount };
}

export async function listTransfers(q: Queryable, f: { status?: string; location?: string; limit?: number; cursor?: string }): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 30, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.status) where.push(`t.status = ${p(f.status)}`);
  if (f.location) where.push(`(t.from_location = ${p(f.location)} OR t.to_location = ${p(f.location)})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(t.requested_at, t.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT t.*, (SELECT COALESCE(sum(quantity),0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS units, (SELECT count(*) FROM stock_transfer_sims s WHERE s.transfer_id = t.id) AS sims
       FROM stock_transfers t ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.requested_at DESC, t.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [new Date(r.requestedAt).toISOString(), r.id as string]);
}

/** Picks the cards: those named (they must be at the sender, free and not already on the road), or the next free ones. */
async function pickSims(q: Queryable, from: string, sel: StockTransferSims): Promise<string[]> {
  const iccids = [...new Set((sel.iccids ?? []).map((s) => s.trim()))].filter(Boolean);
  if (iccids.length) {
    const rows = (await q.query(`SELECT iccid, kind, state, location_id, transfer_id FROM iccid_inventory WHERE iccid = ANY($1::text[]) FOR UPDATE`, [iccids])).rows;
    const by = new Map(rows.map((r) => [r.iccid as string, r]));
    for (const i of iccids) {
      const r = by.get(i);
      if (!r) throw notFound('SIM', i);
      if (r.kind !== 'PHYSICAL') throw rejected(`${i} is an eSIM profile; only physical cards are moved.`);
      if (!['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(r.state) || r.transferId) throw rejected(`${i} is ${r.transferId ? 'already on a transfer' : String(r.state).toLowerCase().replace(/_/g, ' ')} and cannot be moved.`);
      if (r.locationId !== from) throw rejected(`${i} is at ${r.locationId ?? 'no location'}, not at ${from}.`);
    }
    return iccids;
  }
  const n = sel.count ?? 0;
  if (!Number.isInteger(n) || n < 1 || n > 20000) throw invalid('Ask for 1 to 20,000 SIM cards.');
  const rows = (await q.query(`SELECT iccid FROM iccid_inventory WHERE kind='PHYSICAL' AND location_id=$1 AND state IN ('WAREHOUSE_INVENTORY','DISTRIBUTED_DEALER') AND transfer_id IS NULL ORDER BY iccid LIMIT $2 FOR UPDATE SKIP LOCKED`, [from, n])).rows;
  if (rows.length < n) throw rejected(`${from} has only ${rows.length} free SIM cards; you asked for ${n}.`);
  return rows.map((r) => r.iccid as string);
}

export async function requestTransfer(db: Db, actor: string, i: StockTransferInput, scope: StockTransferScope = {}): Promise<Row> {
  return db.tx(async (q) => {
    if (!i.from || !i.to) throw invalid('Choose where the stock comes from and where it goes.');
    if (i.from === i.to) throw invalid('The sender and the receiver are the same place.');
    await assertStockLocation(q, i.from); await assertStockLocation(q, i.to);
    checkScope(i, scope, 'either');
    const lines = (i.lines ?? []).filter((l) => l.sku?.trim()).map((l) => ({ sku: sku_(l.sku), quantity: l.quantity }));
    if (new Set(lines.map((l) => l.sku)).size !== lines.length) throw invalid('A product appears twice; combine the quantities.');
    for (const l of lines) if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 1_000_000) throw invalid(`${l.sku}: move a whole number of units, at least 1.`);
    const wantSims = !!(i.sims?.iccids?.length || i.sims?.count);
    if (!lines.length && !wantSims) throw invalid('Add at least one product or some SIM cards.');
    for (const l of lines) {
      const st = (await q.query('SELECT on_hand, reserved FROM inventory_stock WHERE location_id=$1 AND sku=$2', [i.from, l.sku])).rows[0];
      const free = st ? Number(st.onHand) - Number(st.reserved) : 0;
      if (l.quantity > free) throw rejected(`${i.from} has ${free} of ${l.sku} free to move${st && Number(st.reserved) ? ` (${st.reserved} are reserved for orders)` : ''}; you asked for ${l.quantity}.`);
    }
    const sims = wantSims ? await pickSims(q, i.from, i.sims!) : [];
    const number = await nextTransferNumber(q);
    const t = (await q.query(`INSERT INTO stock_transfers (number, from_location, to_location, note, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [number, i.from, i.to, i.note?.trim().slice(0, 300) || null, actor])).rows[0]!;
    for (const l of lines) await q.query('INSERT INTO stock_transfer_lines (transfer_id, sku, quantity) VALUES ($1,$2,$3)', [t.id, l.sku, l.quantity]);
    for (const s of sims) await q.query('INSERT INTO stock_transfer_sims (transfer_id, iccid) VALUES ($1,$2)', [t.id, s]);
    // the cards are held for this transfer so nobody sells them meanwhile
    if (sims.length) await q.query(`UPDATE iccid_inventory SET transfer_id=$2, updated_at=now() WHERE iccid = ANY($1::text[])`, [sims, t.id]);
    await audit(q, actor, 'stock_transfer', t.id, 'REQUEST', { number, from: i.from, to: i.to, lines: lines.length, sims: sims.length });
    return getTransfer(q, t.id);
  });
}

/** The sender hands the stock over: it leaves the sender now. */
export async function dispatchTransfer(db: Db, actor: string, id: string, scope: StockTransferScope = {}): Promise<Row> {
  return db.tx(async (q) => {
    const t = await loadTransfer(q, id, true);
    checkScope({ from: t.fromLocation, to: t.toLocation }, scope, 'from');
    if (t.status !== 'REQUESTED') throw conflict(`The transfer is ${String(t.status).toLowerCase().replace(/_/g, ' ')}; only a requested transfer can be dispatched.`);
    for (const l of (await q.query('SELECT sku, quantity FROM stock_transfer_lines WHERE transfer_id=$1 ORDER BY sku', [t.id])).rows) {
      const st = (await q.query('SELECT on_hand, reserved FROM inventory_stock WHERE location_id=$1 AND sku=$2 FOR UPDATE', [t.fromLocation, l.sku])).rows[0];
      const free = st ? Number(st.onHand) - Number(st.reserved) : 0;
      if (l.quantity > free) throw rejected(`${t.fromLocation} now has only ${free} of ${l.sku} free; the transfer needs ${l.quantity}.`);
      const r = await adjustStock(q, t.fromLocation, l.sku, -Number(l.quantity));
      await recordMovement(q, { locationId: t.fromLocation, sku: l.sku, delta: -Number(l.quantity), onHand: Number(r?.onHand), kind: 'TRANSFER_OUT', note: `${t.number} to ${t.toLocation}`, actor });
    }
    const sims = (await q.query(`SELECT s.iccid, i.state, i.location_id FROM stock_transfer_sims s JOIN iccid_inventory i ON i.iccid = s.iccid WHERE s.transfer_id=$1 FOR UPDATE OF i`, [t.id])).rows;
    for (const s of sims) {
      if (s.locationId !== t.fromLocation || !['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER'].includes(s.state)) throw rejected(`SIM ${s.iccid} is no longer free at ${t.fromLocation}.`);
      await q.query(`UPDATE iccid_inventory SET location_id=NULL, updated_at=now() WHERE iccid=$1`, [s.iccid]);          // on the road: at no place
      await auditIdentifier(q, { type: 'ICCID', id: s.iccid, from: s.locationId, to: 'IN_TRANSIT', actor, reason: `transfer ${t.number}`, detail: { from: t.fromLocation, to: t.toLocation } });
    }
    await q.query(`UPDATE stock_transfers SET status='IN_TRANSIT', dispatched_by=$2, dispatched_at=now() WHERE id=$1`, [t.id, actor]);
    await audit(q, actor, 'stock_transfer', t.id, 'DISPATCH', { number: t.number });
    return getTransfer(q, t.id);
  });
}

export interface StockReceiveInput { /** Units received by SKU; omitted = everything sent. */ received?: Record<string, number>; /** The cards received; omitted = all of them. */ iccids?: string[]; note?: string }
/** The receiver counts it in. Stock arrives at the receiver; less than sent is recorded as a discrepancy, and missing SIM cards are written off as lost in transit. */
export async function receiveTransfer(db: Db, actor: string, id: string, r: StockReceiveInput = {}, scope: StockTransferScope = {}): Promise<Row> {
  return db.tx(async (q) => {
    const t = await loadTransfer(q, id, true);
    checkScope({ from: t.fromLocation, to: t.toLocation }, scope, 'to');
    if (t.status !== 'IN_TRANSIT') throw conflict(`The transfer is ${String(t.status).toLowerCase().replace(/_/g, ' ')}; only a transfer on the road can be received.`);
    let short = false;
    for (const l of (await q.query('SELECT sku, quantity FROM stock_transfer_lines WHERE transfer_id=$1 ORDER BY sku', [t.id])).rows) {
      const got = r.received && l.sku in r.received ? r.received[l.sku]! : Number(l.quantity);
      if (!Number.isInteger(got) || got < 0 || got > Number(l.quantity)) throw invalid(`${l.sku}: received must be a whole number from 0 to ${l.quantity}.`);
      await q.query('UPDATE stock_transfer_lines SET received=$3 WHERE transfer_id=$1 AND sku=$2', [t.id, l.sku, got]);
      if (got > 0) { const a = await adjustStock(q, t.toLocation, l.sku, got); await recordMovement(q, { locationId: t.toLocation, sku: l.sku, delta: got, onHand: Number(a?.onHand), kind: 'TRANSFER_IN', note: `${t.number} from ${t.fromLocation}`, actor }); }
      if (got < Number(l.quantity)) { short = true; const cur = (await q.query('SELECT on_hand FROM inventory_stock WHERE location_id=$1 AND sku=$2', [t.toLocation, l.sku])).rows[0]; await recordMovement(q, { locationId: t.toLocation, sku: l.sku, delta: 0, onHand: Number(cur?.onHand ?? 0), kind: 'TRANSFER_SHORT', reason: 'LOST', note: `${t.number}: ${Number(l.quantity) - got} of ${l.quantity} did not arrive`, actor }); }
    }
    const sims = (await q.query('SELECT iccid FROM stock_transfer_sims WHERE transfer_id=$1', [t.id])).rows.map((x) => x.iccid as string);
    const arrived = new Set(r.iccids ?? sims);
    for (const i of arrived) if (!sims.includes(i)) throw invalid(`SIM ${i} was not on this transfer.`);
    const toState = (await isWarehouse(q, t.toLocation)) ? 'WAREHOUSE_INVENTORY' : 'DISTRIBUTED_DEALER';
    for (const iccid of sims) {
      if (arrived.has(iccid)) {
        await q.query(`UPDATE iccid_inventory SET location_id=$2, state=$3, transfer_id=NULL, updated_at=now() WHERE iccid=$1`, [iccid, t.toLocation, toState]);
        await auditIdentifier(q, { type: 'ICCID', id: iccid, from: 'IN_TRANSIT', to: toState, actor, reason: `transfer ${t.number}`, detail: { location: t.toLocation } });
      } else {
        short = true;
        await q.query(`UPDATE iccid_inventory SET state='DAMAGED_SCRAPPED', transfer_id=NULL, updated_at=now() WHERE iccid=$1`, [iccid]);
        await auditIdentifier(q, { type: 'ICCID', id: iccid, from: 'IN_TRANSIT', to: 'DAMAGED_SCRAPPED', actor, reason: `lost in transit (${t.number})` });
      }
      await q.query('UPDATE stock_transfer_sims SET received=$3 WHERE transfer_id=$1 AND iccid=$2', [t.id, iccid, arrived.has(iccid)]);
    }
    await q.query(`UPDATE stock_transfers SET status='RECEIVED', received_by=$2, received_at=now(), discrepancy=$3, note = COALESCE(NULLIF($4,''), note) WHERE id=$1`, [t.id, actor, short, r.note?.trim().slice(0, 300) ?? '']);
    await audit(q, actor, 'stock_transfer', t.id, short ? 'RECEIVE_SHORT' : 'RECEIVE', { number: t.number });
    return getTransfer(q, t.id);
  });
}

/** Drops a request (REQUESTED: nothing had moved), or sends a transfer on the road back (IN_TRANSIT: the stock returns to the sender). */
export async function cancelTransfer(db: Db, actor: string, id: string, scope: StockTransferScope = {}): Promise<Row> {
  return db.tx(async (q) => {
    const t = await loadTransfer(q, id, true);
    checkScope({ from: t.fromLocation, to: t.toLocation }, scope, 'either');
    if (t.status === 'REQUESTED') {
      await q.query(`UPDATE iccid_inventory SET transfer_id=NULL, updated_at=now() WHERE transfer_id=$1`, [t.id]);
      await q.query(`UPDATE stock_transfers SET status='CANCELLED', closed_by=$2, closed_at=now() WHERE id=$1`, [t.id, actor]);
    } else if (t.status === 'IN_TRANSIT') {
      for (const l of (await q.query('SELECT sku, quantity FROM stock_transfer_lines WHERE transfer_id=$1', [t.id])).rows) {
        const a = await adjustStock(q, t.fromLocation, l.sku, Number(l.quantity));
        await recordMovement(q, { locationId: t.fromLocation, sku: l.sku, delta: Number(l.quantity), onHand: Number(a?.onHand), kind: 'TRANSFER_IN', note: `${t.number} returned`, actor });
      }
      await q.query(`UPDATE iccid_inventory SET location_id=$2, transfer_id=NULL, updated_at=now() WHERE transfer_id=$1`, [t.id, t.fromLocation]);
      await q.query(`UPDATE stock_transfers SET status='RETURNED', closed_by=$2, closed_at=now() WHERE id=$1`, [t.id, actor]);
    } else throw conflict(`The transfer is ${String(t.status).toLowerCase()}; it can no longer be cancelled.`);
    await audit(q, actor, 'stock_transfer', t.id, t.status === 'REQUESTED' ? 'CANCEL' : 'RETURN', { number: t.number });
    return getTransfer(q, t.id);
  });
}
void addDays;
