import type { Db, Queryable } from './db.js';
import { audit } from './audit.js';
import { invalid, rejected } from './errors.js';
import { adjustStock, MAIN_WAREHOUSE } from './inventory.js';

export const IMPORT_MAX_ROWS = 5000;
const MAX_QTY = 1_000_000;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;

/** A small CSV reader: quoted cells, doubled quotes, commas and line breaks inside quotes, CRLF, a leading byte-order mark. Each row remembers the line it started on. */
export function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const src = text.replace(/^﻿/, '');
  const rows: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [], cell = '', quoted = false, line = 1, start = 1, touched = false;
  const endCell = () => { cells.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (touched || cells.some((c) => c.length)) rows.push({ line: start, cells }); cells = []; touched = false; start = line + 1; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"' && cell === '') { quoted = true; touched = true; }
    else if (ch === ',') { endCell(); touched = true; }
    else if (ch === '\r') { /* part of CRLF */ }
    else if (ch === '\n') { endRow(); line++; start = line; }
    else { cell += ch; touched = true; }
  }
  if (quoted) throw invalid('The file has a quotation mark that is never closed.');
  if (cell.length || cells.length || touched) endRow();
  return rows;
}
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export type ImportAction = 'RECEIVE' | 'REMOVE' | 'SET';
const ACTIONS: Record<string, ImportAction> = { RECEIVE: 'RECEIVE', ADD: 'RECEIVE', IN: 'RECEIVE', REMOVE: 'REMOVE', WRITE_OFF: 'REMOVE', WRITEOFF: 'REMOVE', OUT: 'REMOVE', SET: 'SET', COUNT: 'SET' };
const COLUMNS: Record<string, 'location' | 'sku' | 'quantity' | 'action'> = {
  location_id: 'location', location: 'location', locationid: 'location', store: 'location', warehouse: 'location',
  sku: 'sku', quantity: 'quantity', qty: 'quantity', count: 'quantity', action: 'action', type: 'action',
};

export interface ImportRowResult {
  line: number; locationId: string; sku: string; action: string; quantity: number | null;
  before: number | null; after: number | null; status: 'OK' | 'WARNING' | 'ERROR' | 'SKIPPED'; message?: string;
}
export interface ImportResult {
  applied: boolean; canApply: boolean; rows: ImportRowResult[];
  summary: { ok: number; warnings: number; errors: number; skipped: number; unitsAdded: number; unitsRemoved: number };
}

/** SKUs that offers (their own, their colour/storage options) and line items reserve, optionally only those in `only`. */
async function catalogSkus(q: Queryable, only?: string[]): Promise<string[]> {
  const r = await q.query(
    `SELECT DISTINCT sku FROM (
       SELECT jsonb_array_elements_text(COALESCE(data->'fulfilment'->'inventorySkus','[]'::jsonb)) AS sku FROM catalog_nodes WHERE level='OFFER' AND status <> 'RETIRED'
       UNION ALL SELECT v->>'sku' FROM catalog_nodes, jsonb_array_elements(COALESCE(data->'variants','[]'::jsonb)) v WHERE level='OFFER' AND status <> 'RETIRED'
       UNION ALL SELECT data->>'sku' FROM catalog_nodes WHERE level='LINE_ITEM' AND status <> 'RETIRED' AND data->>'sku' IS NOT NULL
     ) s WHERE sku IS NOT NULL AND ($1::text[] IS NULL OR sku = ANY($1)) ORDER BY sku LIMIT ${IMPORT_MAX_ROWS}`, [only ?? null]);
  return r.rows.map((x) => x.sku as string);
}

/** The file admins fill in. With `withSkus` it lists every SKU the catalog uses at the chosen location, quantity blank: fill in what arrived, and blank rows are ignored. */
export async function stockTemplate(q: Queryable, o: { locationId?: string; withSkus?: boolean } = {}): Promise<string> {
  const loc = o.locationId?.trim() || MAIN_WAREHOUSE;
  const head = [
    '# Meridian stock import. Lines that start with # are ignored; keep the header row below.',
    '# location_id: WH-MAIN for the warehouse, or a store id such as STORE-00001.',
    '# sku: the stock code used on offers (letters, digits, dash, dot, underscore).',
    '# quantity: a whole number. A row with no quantity is skipped.',
    '# action: RECEIVE adds to stock (default), REMOVE writes off, SET is a stock count (on hand becomes this number).',
    '# Example: WH-MAIN,PHONE-X1-128,50,RECEIVE',
    'location_id,sku,quantity,action',
  ];
  const rows = o.withSkus ? (await catalogSkus(q)).map((s) => `${csvCell(loc)},${csvCell(s)},,RECEIVE`) : [];
  return [...head, ...rows].join('\r\n') + '\r\n';
}

/**
 * Checks a stock file (and, with `apply`, loads it). Every row is judged first and the file loads only if no row is an error, all in one transaction:
 * a file is never half loaded. RECEIVE adds, REMOVE writes off, SET makes on-hand equal a counted number. Reserved stock is never taken away.
 */
export async function importStock(db: Db, text: string, o: { apply: boolean; actor: string; storeId?: string | null }): Promise<ImportResult> {
  const parsed = parseCsv(text).filter((r) => !(r.cells[0] ?? '').trimStart().startsWith('#') && r.cells.some((c) => c.trim()));
  if (!parsed.length) throw invalid('The file is empty. Download the template and fill it in.');
  const header = parsed[0]!.cells.map((c) => c.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col: Partial<Record<'location' | 'sku' | 'quantity' | 'action', number>> = {};
  header.forEach((h, i) => { const k = COLUMNS[h]; if (k && col[k] === undefined) col[k] = i; });
  const missing = (['location', 'sku', 'quantity'] as const).filter((k) => col[k] === undefined);
  if (missing.length) throw invalid(`The header row needs these columns: location_id, sku, quantity (and optionally action). Missing: ${missing.map((m) => (m === 'location' ? 'location_id' : m)).join(', ')}. Found: ${header.join(', ') || 'nothing'}.`);
  const body = parsed.slice(1);
  if (!body.length) throw invalid('The file has a header but no rows.');
  if (body.length > IMPORT_MAX_ROWS) throw invalid(`A file can have at most ${IMPORT_MAX_ROWS} rows (this one has ${body.length}). Split it into several files.`);

  const cell = (cells: string[], k: 'location' | 'sku' | 'quantity' | 'action') => (col[k] === undefined ? '' : (cells[col[k]!] ?? '').trim());
  const rows: ImportRowResult[] = body.map((r) => ({ line: r.line, locationId: cell(r.cells, 'location'), sku: cell(r.cells, 'sku'), action: (cell(r.cells, 'action') || 'RECEIVE').toUpperCase(), quantity: null, before: null, after: null, status: 'OK' }));
  const fail = (r: ImportRowResult, m: string) => { r.status = 'ERROR'; r.message = m; };

  // Which locations exist: the warehouse, every store, and anywhere that already holds stock.
  const locs = [...new Set(rows.map((r) => r.locationId).filter(Boolean))];
  const known = new Set<string>([MAIN_WAREHOUSE]);
  if (locs.length) {
    for (const r of (await db.query('SELECT id FROM stores WHERE id = ANY($1)', [locs])).rows) known.add(r.id as string);
    for (const r of (await db.query('SELECT DISTINCT location_id FROM inventory_stock WHERE location_id = ANY($1)', [locs])).rows) known.add(r.locationId as string);
  }
  const seen = new Map<string, number>();
  body.forEach((src, i) => {
    const r = rows[i]!;
    const qtyText = cell(src.cells, 'quantity');
    if (!r.locationId && !r.sku && !qtyText) { r.status = 'SKIPPED'; r.message = 'Empty row.'; return; }
    if (!qtyText) { r.status = 'SKIPPED'; r.message = 'No quantity: skipped.'; return; } // the template lists every SKU; only filled-in rows load
    if (!r.locationId) return fail(r, 'Enter the location (WH-MAIN or a store id).');
    if (o.storeId && r.locationId !== o.storeId) return fail(r, `You can only load stock for your own store (${o.storeId}).`);
    if (!known.has(r.locationId)) return fail(r, `Unknown location “${r.locationId}”. Use WH-MAIN or a store id from Stores.`);
    if (!SKU_RE.test(r.sku)) return fail(r, r.sku ? `“${r.sku}” is not a valid SKU (letters, digits, dash, dot, underscore).` : 'Enter the SKU.');
    const action = ACTIONS[r.action];
    if (!action) return fail(r, `Unknown action “${r.action}”. Use RECEIVE, REMOVE or SET.`);
    r.action = action;
    if (!/^\d+$/.test(qtyText)) return fail(r, `“${qtyText}” is not a whole number.`);
    const qty = Number(qtyText);
    if (qty > MAX_QTY) return fail(r, `The quantity can be at most ${MAX_QTY.toLocaleString()}.`);
    if (qty === 0 && action !== 'SET') return fail(r, 'The quantity must be at least 1 (use SET for a count of zero).');
    r.quantity = qty;
    const key = `${r.locationId}\u0000${r.sku}`;
    if (seen.has(key)) return fail(r, `${r.sku} at ${r.locationId} is already on line ${seen.get(key)}. Combine them into one row.`);
    seen.set(key, r.line);
  });

  const live = rows.filter((r) => r.status === 'OK');
  const stock = new Map<string, { onHand: number; reserved: number }>();
  if (live.length) {
    const res = await db.query('SELECT s.location_id, s.sku, s.on_hand, s.reserved FROM inventory_stock s JOIN unnest($1::text[], $2::text[]) AS w(l, k) ON s.location_id = w.l AND s.sku = w.k', [live.map((r) => r.locationId), live.map((r) => r.sku)]);
    for (const s of res.rows) stock.set(`${s.locationId}\u0000${s.sku}`, { onHand: Number(s.onHand), reserved: Number(s.reserved) });
  }
  const inCatalog = new Set(live.length ? await catalogSkus(db, [...new Set(live.map((r) => r.sku))]) : []);
  for (const r of live) {
    const s = stock.get(`${r.locationId}\u0000${r.sku}`) ?? { onHand: 0, reserved: 0 };
    r.before = s.onHand;
    const next = r.action === 'RECEIVE' ? s.onHand + r.quantity! : r.action === 'REMOVE' ? s.onHand - r.quantity! : r.quantity!;
    if (next < s.reserved) { fail(r, `${s.reserved} ${s.reserved === 1 ? 'unit is' : 'units are'} reserved for orders, so on hand cannot go below ${s.reserved}.`); continue; }
    r.after = next;
    if (!inCatalog.has(r.sku)) { r.status = 'WARNING'; r.message = 'No offer uses this SKU yet (check for a typo).'; }
  }

  const summary = {
    ok: rows.filter((r) => r.status === 'OK').length, warnings: rows.filter((r) => r.status === 'WARNING').length, errors: rows.filter((r) => r.status === 'ERROR').length, skipped: rows.filter((r) => r.status === 'SKIPPED').length,
    unitsAdded: rows.reduce((t, r) => t + (r.after !== null && r.after > r.before! ? r.after - r.before! : 0), 0), unitsRemoved: rows.reduce((t, r) => t + (r.after !== null && r.after < r.before! ? r.before! - r.after : 0), 0),
  };
  const applicable = rows.filter((r) => r.status === 'OK' || r.status === 'WARNING');
  const canApply = summary.errors === 0 && applicable.length > 0;
  if (!o.apply) return { applied: false, canApply, rows, summary };
  if (summary.errors) throw rejected(`${summary.errors} ${summary.errors === 1 ? 'row has' : 'rows have'} a problem, so nothing was loaded. Fix ${summary.errors === 1 ? 'it' : 'them'} and try again.`);
  if (!applicable.length) throw rejected('There is nothing to load: every row was skipped.');

  await db.tx(async (q) => {
    for (const r of applicable) {
      // Re-read inside the transaction: stock may have moved since the check. adjustStock refuses to go below reserved.
      const cur = (await q.query('SELECT on_hand FROM inventory_stock WHERE location_id=$1 AND sku=$2 FOR UPDATE', [r.locationId, r.sku])).rows[0];
      const onHand = cur ? Number(cur.onHand) : 0;
      const delta = r.action === 'RECEIVE' ? r.quantity! : r.action === 'REMOVE' ? -r.quantity! : r.quantity! - onHand;
      if (delta !== 0) await adjustStock(q, r.locationId, r.sku, delta);
      else if (!cur) await q.query('INSERT INTO inventory_stock (location_id, sku, on_hand) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [r.locationId, r.sku]);
    }
    await audit(q, o.actor, 'inventory', 'import', 'STOCK_IMPORTED', { rows: applicable.length, unitsAdded: summary.unitsAdded, unitsRemoved: summary.unitsRemoved, locations: [...new Set(applicable.map((r) => r.locationId))].slice(0, 20) });
  });
  return { applied: true, canApply: false, rows, summary };
}
