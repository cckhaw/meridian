import type { Db, Queryable, Row } from './db.js';
import { audit } from './audit.js';
import { invalid, rejected } from './errors.js';
import { getRegional } from './settings.js';

/**
 * The store desk: what a retail manager needs to run one store. Sales by day, salesperson and payment method (with the commission each sale earned),
 * and the end-of-day cash drawer: the cash the system expects against the cash counted, with the difference recorded and signed off.
 */
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);

export interface StoreSales {
  storeId: string; from: string; to: string; currency: string;
  totals: { orders: number; salesMinor: number; refundedMinor: number; cashMinor: number };
  byDay: Row[]; bySalesperson: Row[]; byMethod: Row[]; commissionMinor: number;
}

export async function storeSales(q: Queryable, storeId: string, o: { from?: string; to?: string } = {}): Promise<StoreSales> {
  const to = o.to ?? today(); const from = o.from ?? new Date(Date.parse(to) - 6 * 86_400_000).toISOString().slice(0, 10);
  if (!isDate(from) || !isDate(to) || from > to) throw invalid('Give the dates as YYYY-MM-DD, the first no later than the last.');
  const currency = (await getRegional(q)).currency;
  const base = `o.store_id=$1 AND o.created_at >= $2::date AND o.created_at < $3::date + 1 AND o.state NOT IN ('CANCELLED','DRAFT')`;
  const args = [storeId, from, to];
  const byDay = (await q.query(`SELECT o.created_at::date::text AS day, count(*)::int AS orders, COALESCE(sum(o.total_minor),0)::bigint AS sales_minor, COALESCE(sum(o.refunded_minor),0)::bigint AS refunded_minor FROM orders o WHERE ${base} GROUP BY 1 ORDER BY 1 DESC`, args)).rows;
  const bySalesperson = (await q.query(`SELECT COALESCE(o.salesperson_id,'(none)') AS salesperson, count(*)::int AS orders, COALESCE(sum(o.total_minor),0)::bigint AS sales_minor FROM orders o WHERE ${base} GROUP BY 1 ORDER BY 3 DESC`, args)).rows;
  const byMethod = (await q.query(`SELECT p.method::text AS method, count(*)::int AS payments, COALESCE(sum(p.amount_minor),0)::bigint AS amount_minor FROM payments p JOIN orders o ON o.id=p.order_id WHERE ${base} AND p.status IN ('CAPTURED','REFUNDED') GROUP BY 1 ORDER BY 3 DESC`, args)).rows;
  // Commission attributed to this store's sales: what the ledger recorded against the store or against its sales people on these orders.
  const commission = Number((await q.query(`SELECT COALESCE(sum(e.amount_minor),0) AS m FROM agent_ledger_entries e JOIN orders o ON o.id=e.order_id WHERE ${base} AND e.status <> 'CLAWED_BACK'`, args)).rows[0]!.m);
  const n = (k: string) => byDay.reduce((s, r) => s + Number(r[k]), 0);
  return { storeId, from, to, currency, byDay, bySalesperson, byMethod, commissionMinor: commission,
    totals: { orders: n('orders'), salesMinor: n('salesMinor'), refundedMinor: n('refundedMinor'), cashMinor: Number(byMethod.find((m) => m.method === 'CASH')?.amountMinor ?? 0) } };
}

/** Cash the system expects in the drawer for a business day: captured cash payments on the store's orders, less cash refunded. */
export async function expectedCash(q: Queryable, storeId: string, date: string): Promise<number> {
  if (!isDate(date)) throw invalid('Give the date as YYYY-MM-DD.');
  const r = (await q.query(
    `SELECT COALESCE(sum(CASE WHEN p.status='CAPTURED' THEN p.amount_minor ELSE 0 END),0)::bigint AS taken,
            COALESCE(sum(COALESCE(p.refunded_minor,0)),0)::bigint AS refunded
       FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE o.store_id=$1 AND p.method='CASH' AND p.status IN ('CAPTURED','REFUNDED') AND p.created_at >= $2::date AND p.created_at < $2::date + 1`, [storeId, date])).rows[0]!;
  return Number(r.taken) - Number(r.refunded);
}

export async function drawerStatus(q: Queryable, storeId: string, date: string): Promise<{ date: string; expectedMinor: number; closing: Row | null; currency: string }> {
  return { date, expectedMinor: await expectedCash(q, storeId, date), currency: (await getRegional(q)).currency,
    closing: (await q.query('SELECT * FROM cash_drawer_closings WHERE store_id=$1 AND business_date=$2', [storeId, date])).rows[0] ?? null };
}

/** Closes the day: records the count against the expected cash. A day closes once; a variance needs a note. */
export async function closeDrawer(db: Db, storeId: string, i: { date: string; countedMinor: number; note?: string }, actor: string): Promise<Row> {
  if (!isDate(i.date) || i.date > today()) throw invalid('Close a day that has started: give the date as YYYY-MM-DD.');
  if (!Number.isInteger(i.countedMinor) || i.countedMinor < 0) throw invalid('Enter the cash counted, as an amount of zero or more.');
  return db.tx(async (q) => {
    const expected = await expectedCash(q, storeId, i.date);
    const variance = i.countedMinor - expected;
    if (variance !== 0 && !i.note?.trim()) throw rejected('The count does not match what the system expects. Add a note saying why.');
    const currency = (await getRegional(q)).currency;
    const r = await q.query(
      `INSERT INTO cash_drawer_closings (store_id, business_date, expected_minor, counted_minor, variance_minor, currency, note, closed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (store_id, business_date) DO NOTHING RETURNING *`, [storeId, i.date, expected, i.countedMinor, variance, currency, i.note?.trim() || null, actor]);
    if (!r.rows[0]) throw rejected('That day is already closed.');
    await audit(q, actor, 'store', storeId, 'CASH_DRAWER_CLOSED', { date: i.date, expectedMinor: expected, countedMinor: i.countedMinor, varianceMinor: variance, security: variance !== 0 });
    return r.rows[0];
  });
}

export async function listClosings(q: Queryable, storeId: string, limit = 31): Promise<Row[]> {
  return (await q.query('SELECT * FROM cash_drawer_closings WHERE store_id=$1 ORDER BY business_date DESC LIMIT $2', [storeId, Math.min(limit, 366)])).rows;
}
