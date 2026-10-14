import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { MAIN_WAREHOUSE } from './inventory.js';

const text = (v: string | undefined | null, max: number, what: string): string | null => {
  const t = (v ?? '').trim();
  if (t.length > max) throw invalid(`${what} can be at most ${max} characters`);
  return t || null;
};

/** Warehouses with how much stock each holds. */
export async function listWarehouses(q: Queryable): Promise<Row[]> {
  return (await q.query(
    `SELECT w.id, w.name, w.status, w.address, w.created_at,
            COALESCE(s.lines, 0)::int AS stock_lines, COALESCE(s.units, 0)::int AS units
       FROM warehouses w
       LEFT JOIN (SELECT location_id, count(*) AS lines, sum(on_hand) AS units FROM inventory_stock GROUP BY location_id) s ON s.location_id = w.id
      ORDER BY (w.id = $1) DESC, w.name LIMIT 500`, [MAIN_WAREHOUSE])).rows;
}

async function getWarehouse(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM warehouses WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('warehouse', id);
  return r;
}

export async function createWarehouse(q: Queryable, actor: string, i: { name: string; address?: string }): Promise<Row> {
  const name = text(i.name, 80, 'the name');
  if (!name) throw invalid('a warehouse needs a name');
  if ((await q.query('SELECT 1 FROM warehouses WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already a warehouse called ${name}`);
  const w = (await q.query(
    `INSERT INTO warehouses (id, name, address, created_by) VALUES ('WH-' || lpad(nextval('warehouse_id_seq')::text, 5, '0'), $1, $2, $3) RETURNING *`,
    [name, text(i.address, 300, 'the address'), actor])).rows[0]!;
  await audit(q, actor, 'warehouse', w.id as string, 'create', { name });
  return w;
}

export async function updateWarehouse(q: Queryable, actor: string, id: string, p: { name?: string; address?: string; status?: 'ACTIVE' | 'INACTIVE' }): Promise<Row> {
  const cur = await getWarehouse(q, id);
  if (id === MAIN_WAREHOUSE && p.status === 'INACTIVE') throw rejected('The main warehouse is where online orders are fulfilled from, so it cannot be switched off.');
  const name = p.name === undefined ? (cur.name as string) : text(p.name, 80, 'the name');
  if (!name) throw invalid('a warehouse needs a name');
  if (name.toLowerCase() !== String(cur.name).toLowerCase() && (await q.query('SELECT 1 FROM warehouses WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already a warehouse called ${name}`);
  const w = (await q.query(
    `UPDATE warehouses SET name=$2, address=$3, status=$4, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, name, p.address === undefined ? cur.address : text(p.address, 300, 'the address'), p.status ?? cur.status])).rows[0]!;
  await audit(q, actor, 'warehouse', id, 'update', { ...p });
  return w;
}

/** A warehouse can be removed once it holds nothing. Stock lines at zero go with it; the movement history stays. */
export async function deleteWarehouse(q: Queryable, actor: string, id: string): Promise<{ deleted: string }> {
  const w = await getWarehouse(q, id);
  if (id === MAIN_WAREHOUSE) throw rejected('The main warehouse is where online orders are fulfilled from, so it cannot be removed.');
  const held = (await q.query('SELECT count(*) AS lines, COALESCE(sum(on_hand),0) AS units FROM inventory_stock WHERE location_id=$1 AND on_hand > 0', [id])).rows[0]!;
  if (Number(held.units) > 0) throw rejected(`${w.name} still holds ${held.units} unit${Number(held.units) === 1 ? '' : 's'} across ${held.lines} SKU${Number(held.lines) === 1 ? '' : 's'}. Write them off or move them out first, or switch the warehouse off instead.`);
  await q.query('DELETE FROM inventory_reservations WHERE location_id=$1 AND consumed_at IS NULL AND released_at IS NULL', [id]);
  await q.query('DELETE FROM inventory_stock WHERE location_id=$1', [id]);
  await q.query('DELETE FROM warehouses WHERE id=$1', [id]);
  await audit(q, actor, 'warehouse', id, 'delete', { name: w.name });
  return { deleted: id };
}

/** Stock can be received at, or written off from, a store or a warehouse that is switched on. */
export async function assertStockLocation(q: Queryable, locationId: string, o: { allowInactive?: boolean } = {}): Promise<void> {
  const w = (await q.query('SELECT status FROM warehouses WHERE id=$1', [locationId])).rows[0];
  if (w) { if (w.status !== 'ACTIVE' && !o.allowInactive) throw rejected(`Warehouse ${locationId} is switched off.`); return; }
  if ((await q.query('SELECT 1 FROM stores WHERE id=$1', [locationId])).rows.length) return;
  throw invalid(`Unknown location “${locationId}”. Use a warehouse or a store.`);
}
