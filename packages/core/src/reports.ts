import { ACTIVE_SQL } from './cases.js';
import type { OfferNode } from '@meridian/types';
import { monthlyFee } from './catalog.js';
import { GL, GL_NAMES } from './config.js';
import type { Db, Queryable, Row } from './db.js';
import { customerLineage, getCustomer, listAccounts, listChildren } from './customers.js';
import { today } from './dates.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';

// ───────────────────────── Customer 360 ─────────────────────────
export interface Recommendation { id: string; title: string; reason: string; offerId?: string; kind: 'UPSELL' | 'RETENTION' | 'CROSS_SELL' | 'COLLECTIONS' }

/**
 * Rules-based next-best-action. Deliberately transparent and deterministic; a model-driven ranker can replace
 * `recommend` later without changing the API (each item already carries a human-readable reason).
 */
async function recommend(q: Queryable, customerId: string, overdue: number): Promise<Recommendation[]> {
  const out: Recommendation[] = [];
  const svc = (await q.query(
    `SELECT s.type, s.identifier, s.offer_id, s.contract_start, s.contract_term_months, c.kind FROM services s JOIN catalog_nodes c ON c.id = s.offer_id
     WHERE s.customer_id=$1 AND s.status IN ('ACTIVE','SUSPENDED') LIMIT 500`, [customerId])).rows;
  if (overdue > 0) out.push({ id: 'collect', kind: 'COLLECTIONS', title: 'Offer a payment plan', reason: 'Account has overdue invoices; contact before the suspension date.' });
  const hasKind = (k: string) => svc.some((s) => s.kind === k);
  const renewing = svc.filter((s) => s.contractTermMonths > 0 && s.contractStart &&
    (Date.now() - new Date(s.contractStart).getTime()) / 2_629_800_000 >= s.contractTermMonths - 3);
  for (const s of renewing.slice(0, 3)) out.push({ id: `renew-${s.identifier}`, kind: 'RETENTION', title: `Renew ${s.identifier}`, reason: 'Contract ends within 3 months: offer a device upgrade to retain.' });
  if (hasKind('SIM_ONLY') && !hasKind('SIM_DEVICE')) out.push({ id: 'device', kind: 'UPSELL', offerId: 'plan-phone-24', title: '5G plan with a new phone', reason: 'SIM-only customer; device bundles raise ARPU and retention.' });
  if (svc.some((s) => s.type === 'MOBILE') && !hasKind('FIBER')) out.push({ id: 'fiber', kind: 'CROSS_SELL', offerId: 'fiber-1g', title: 'Add home fibre', reason: 'Mobile-only household; convergence reduces churn.' });
  if (svc.some((s) => s.type === 'MOBILE') && !hasKind('NON_TELCO_SUBSCRIPTION')) out.push({ id: 'ott', kind: 'CROSS_SELL', offerId: 'netflix-premium', title: 'Bundle Netflix', reason: 'No entertainment subscription on this account.' });
  return out.slice(0, 6);
}

export async function customer360(q: Queryable, id: string): Promise<Row> {
  const customer = await getCustomer(q, id);
  // Everything here is a count or a short slice. Accounts, services, members and departments are listed (paged) by their own calls.
  const [accounts, svcSummary, orders, invoices, cases, children, groupCount, lineage, balance, acctCount] = await Promise.all([
    listAccounts(q, id, { limit: 20 }),
    q.query(`SELECT type, status, count(*) AS n FROM services WHERE customer_id=$1 GROUP BY type, status ORDER BY type, status`, [id]),
    q.query(`SELECT o.id, o.number, o.state, o.channel, o.total_minor, o.currency, o.created_at,
        (SELECT string_agg(ol.description, ', ') FROM order_lines ol WHERE ol.order_id = o.id) AS summary FROM orders o WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 10`, [id]),
    q.query(`SELECT i.id, i.number, i.status, i.issue_date, i.due_date, i.total_minor, i.currency, i.total_minor - i.paid_minor - i.credited_minor AS balance_minor FROM invoices i WHERE i.customer_id=$1 ORDER BY i.issue_date DESC, i.number DESC LIMIT 10`, [id]),
    q.query(`SELECT id, number, type, status, priority, subject, created_at FROM cases WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 10`, [id]),
    listChildren(q, id, { limit: 10 }),
    q.query(`SELECT count(*) AS n FROM service_groups WHERE customer_id=$1 AND status='ACTIVE'`, [id]),
    customerLineage(q, id),
    q.query(`SELECT COALESCE(sum(CASE WHEN status='OVERDUE' THEN total_minor - paid_minor - credited_minor END),0) AS overdue,
      COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS outstanding FROM invoices WHERE customer_id=$1 AND status IN ('ISSUED','OVERDUE')`, [id]),
    q.query(`SELECT count(*) AS n FROM accounts WHERE customer_id=$1`, [id]),
  ]);
  const b = balance.rows[0]!;
  const childCount = (await q.query('SELECT count(*) AS n FROM customers WHERE parent_customer_id=$1', [id])).rows[0]!.n;
  return {
    customer, accounts: accounts.items, accountCount: acctCount.rows[0]!.n, serviceSummary: svcSummary.rows, recentOrders: orders.rows, recentInvoices: invoices.rows, cases: cases.rows,
    children: children.items, childCount, groupCount: groupCount.rows[0]!.n, ancestors: lineage.ancestors,
    outstandingMinor: b.outstanding, overdueMinor: b.overdue,
    recommendations: await recommend(q, id, b.overdue),
  };
}

// ───────────────────────── Dashboard ─────────────────────────
// The dashboard's totals scan whole tables, so on a big database they are computed at most once per interval and shared by everyone who opens it.
// MERIDIAN_DASHBOARD_TTL is in seconds (default 30 in production, 0 = always live elsewhere).
const dashCache = new WeakMap<object, { at: number; value: Row }>();
const dashTtlMs = () => Number(process.env.MERIDIAN_DASHBOARD_TTL ?? (process.env.NODE_ENV === 'production' ? 30 : 0)) * 1000;

export async function dashboard(q: Queryable): Promise<Row> {
  const ttl = dashTtlMs();
  const hit = ttl > 0 ? dashCache.get(q) : undefined;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await computeDashboard(q);
  if (ttl > 0) dashCache.set(q, { at: Date.now(), value });
  return value;
}

async function computeDashboard(q: Queryable): Promise<Row> {
  const one = async (sql: string) => (await q.query(sql)).rows[0]!;
  const [cust, svc, orders, ar, rev, cases, byOffer, byState, recentOrders] = await Promise.all([
    one('SELECT count(*) AS n FROM customers'),
    one(`SELECT count(*) FILTER (WHERE status='ACTIVE') AS active, count(*) FILTER (WHERE status='SUSPENDED') AS suspended FROM services`),
    one(`SELECT count(*) AS open FROM orders WHERE state NOT IN ('COMPLETED','CANCELLED','FAILED')`),
    one(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS receivable,
        COALESCE(sum(total_minor - paid_minor - credited_minor) FILTER (WHERE status='OVERDUE'),0) AS overdue FROM invoices WHERE status IN ('ISSUED','OVERDUE')`),
    one(`SELECT COALESCE(sum(credit_minor - debit_minor),0) AS revenue FROM gl_entries WHERE account_code IN ('4000','4100','4900')`),
    one(`SELECT count(*) AS open FROM cases WHERE status IN ${ACTIVE_SQL}`),
    q.query(`SELECT s.offer_id, c.name, c.data, c.kind, count(*) AS n FROM services s JOIN catalog_nodes c ON c.id = s.offer_id WHERE s.status='ACTIVE' GROUP BY s.offer_id, c.name, c.data, c.kind`),
    q.query(`SELECT state, count(*) AS n FROM orders GROUP BY state ORDER BY n DESC`),
    q.query(`SELECT o.id, o.number, o.state, o.total_minor, o.currency, o.created_at, c.display_name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC LIMIT 6`),
  ]);
  // Monthly recurring revenue (net of nothing: list price per month) across active services.
  let mrr = 0;
  const topOffers = byOffer.rows.map((r) => {
    const fee = monthlyFee({ prices: r.data.prices ?? [] } as OfferNode);
    const monthly = fee ? Math.round(fee.amount.amountMinor / (fee.periodMonths ?? 1)) : 0;
    mrr += monthly * r.n;
    return { offerId: r.offerId, name: r.name, kind: r.kind, services: r.n, mrrMinor: monthly * r.n };
  }).sort((a, b) => b.services - a.services).slice(0, 6);
  return {
    customers: cust.n, activeServices: svc.active, suspendedServices: svc.suspended, openOrders: orders.open,
    receivableMinor: ar.receivable, overdueMinor: ar.overdue, ledgerRevenueMinor: rev.revenue, openCases: cases.open, mrrMinor: mrr,
    topOffers, ordersByState: byState.rows, recentOrders: recentOrders.rows,
  };
}

// ───────────────────────── GL: journals, SAP export, reconciliation ─────────────────────────
export async function listGl(q: Queryable, f: { exported?: boolean; limit?: number; cursor?: string } = {}): Promise<Page<Row> & { unexported: Row }> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.exported !== undefined) where.push(f.exported ? 'exported_batch_id IS NOT NULL' : 'exported_batch_id IS NULL');
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`id < ${p(cur[0])}::bigint`);
  const rows = (await q.query(`SELECT * FROM gl_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  const unexported = (await q.query(`SELECT count(*) AS n, COALESCE(sum(debit_minor),0) AS debit FROM gl_entries WHERE exported_batch_id IS NULL`)).rows[0]!;
  return { ...toPage(rows, limit, (r) => [r.id as number]), unexported };
}

export interface ReconCheck { name: string; expected: number; actual: number; ok: boolean; note: string }

/** Reconciles the ledger against the sub-ledgers. Any failed check means a posting bug or manual DB change. */
export async function reconcile(q: Queryable): Promise<{ ok: boolean; checks: ReconCheck[]; trialBalance: Row[] }> {
  const sum = async (sql: string) => Number((await q.query(sql)).rows[0]!.v);
  const dr = await sum('SELECT COALESCE(sum(debit_minor),0) AS v FROM gl_entries');
  const cr = await sum('SELECT COALESCE(sum(credit_minor),0) AS v FROM gl_entries');
  const glAr = await sum(`SELECT COALESCE(sum(debit_minor - credit_minor),0) AS v FROM gl_entries WHERE account_code='${GL.AR}'`);
  const subAr = await sum(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS v FROM invoices WHERE status NOT IN ('VOID','WRITTEN_OFF')`);
  const glCash = await sum(`SELECT COALESCE(sum(debit_minor - credit_minor),0) AS v FROM gl_entries WHERE account_code='${GL.CASH}'`);
  const subCash = await sum(`SELECT COALESCE(sum(amount_minor - refunded_minor),0) AS v FROM payments WHERE status IN ('CAPTURED','REFUNDED')`);
  const unbalanced = await sum(`SELECT count(*) AS v FROM (SELECT journal_id FROM gl_entries GROUP BY journal_id HAVING sum(debit_minor) <> sum(credit_minor)) t`);
  const checks: ReconCheck[] = [
    { name: 'Ledger balances', expected: dr, actual: cr, ok: dr === cr, note: 'Total debits equal total credits' },
    { name: 'Every journal balances', expected: 0, actual: unbalanced, ok: unbalanced === 0, note: 'Count of unbalanced journals' },
    { name: 'AR control account = open invoices', expected: subAr, actual: glAr, ok: glAr === subAr, note: `GL ${GL.AR} vs sum of invoice balances` },
    { name: 'Cash account = captured payments', expected: subCash, actual: glCash, ok: glCash === subCash, note: `GL ${GL.CASH} vs payments table net of refunds` },
  ];
  const trialBalance = (await q.query(
    `SELECT account_code, sum(debit_minor) AS debit_minor, sum(credit_minor) AS credit_minor, sum(debit_minor) - sum(credit_minor) AS balance_minor FROM gl_entries GROUP BY account_code ORDER BY account_code`)).rows
    .map((r) => ({ ...r, accountName: GL_NAMES[r.accountCode] ?? r.accountCode }));
  return { ok: checks.every((c) => c.ok), checks, trialBalance };
}

export async function auditLog(q: Queryable, f: { entity?: string; entityId?: string; actor?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.entity) where.push(`entity = ${p(f.entity)}`);
  if (f.entityId) where.push(`entity_id = ${p(f.entityId)}`);
  if (f.actor?.trim()) where.push(`actor = ${p(f.actor.trim())}`);
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`id < ${p(cur[0])}::bigint`);
  const rows = (await q.query(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.id as number]);
}
export { today };
