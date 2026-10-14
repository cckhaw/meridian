import { randomUUID } from 'node:crypto';
import type { OfferNode } from '@meridian/types';
import { audit } from './audit.js';
import { monthlyFee } from './catalog.js';
import { GL, INVOICE_TERMS_DAYS, paymentMode } from './config.js';
import { marketFor } from './settings.js';
import type { Db, Queryable, Row } from './db.js';
import { addDays, addMonths, dayOf, diffDays, fmt, today, toDate, type DateStr } from './dates.js';
import { invalid, notFound, rejected } from './errors.js';
import { postJournal } from './ledger.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { customerIdsMatching, likePrefix, parseQuery } from './search.js';
import { taxSplit } from './tax.js';
import { liftCreditRestrictions, restoreAfterPayment, voluntarySuspendedDays } from './lifecycle-state.js';

export interface DraftLine { serviceId?: string | null; kind: 'RECURRING' | 'INSTALLMENT' | 'ETC' | 'ADJUSTMENT'; revenueAccount: string; description: string; amountMinor: number; taxInclusive: boolean }

/** Persists an invoice from priced draft lines and posts Dr AR / Cr revenue / Cr tax. Returns null when the total is zero. */
export async function issueInvoice(
  q: Queryable,
  acct: Row,
  o: { kind: 'CYCLE' | 'FINAL' | 'ADJUSTMENT'; periodStart: DateStr; periodEnd: DateStr; issueDate: DateStr; lines: DraftLine[] },
): Promise<Row | null> {
  const customer = (await q.query('SELECT market_code FROM customers WHERE id=$1', [acct.customerId])).rows[0]!;
  const mk = await marketFor(q, customer.marketCode);
  const priced = o.lines.map((l) => ({ ...l, ...taxSplit(l.amountMinor, mk.taxBps, l.taxInclusive) })).filter((l) => l.gross !== 0);
  const net = priced.reduce((s, l) => s + l.net, 0);
  const tax = priced.reduce((s, l) => s + l.tax, 0);
  if (net + tax <= 0) return null;
  const year = o.issueDate.slice(0, 4);
  const seq = (await q.query(`SELECT nextval('invoice_seq') AS n`)).rows[0]!.n as number;
  const id = randomUUID();
  const number = `INV-${year}-${String(seq).padStart(6, '0')}`;
  await q.query(
    `INSERT INTO invoices (id, shard_id, number, account_id, customer_id, kind, period_start, period_end, issue_date, due_date, currency, net_minor, tax_minor, total_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, acct.shardId, number, acct.id, acct.customerId, o.kind, o.periodStart, o.periodEnd, o.issueDate, addDays(o.issueDate, INVOICE_TERMS_DAYS), acct.currency, net, tax, net + tax],
  );
  const revenue = new Map<string, number>();
  for (const l of priced) {
    await q.query(
      `INSERT INTO invoice_lines (invoice_id, service_id, kind, revenue_account, description, net_minor, tax_minor) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, l.serviceId ?? null, l.kind, l.revenueAccount, l.description, l.net, l.tax],
    );
    revenue.set(l.revenueAccount, (revenue.get(l.revenueAccount) ?? 0) + l.net);
  }
  await postJournal(q, {
    date: o.issueDate, sourceType: 'INVOICE', sourceId: id, currency: acct.currency,
    lines: [
      { account: GL.AR, debit: net + tax, description: `Invoice ${number}` },
      ...[...revenue].map(([account, credit]) => ({ account, credit, description: `Invoice ${number} revenue` })),
      { account: GL.TAX_PAYABLE, credit: tax, description: `Invoice ${number} ${mk.taxName}` },
    ],
  });
  return (await q.query('SELECT * FROM invoices WHERE id=$1', [id])).rows[0]!;
}

export interface BillRunResult { asOf: DateStr; accounts: number; invoices: number; skipped: number; totalMinor: number; errors: Array<{ accountId: string; error: string }> }

/**
 * Bills every account whose cycle falls on `asOf` (day-of-month 1-28, or every day for daily-cycle accounts), in arrears for the
 * period ending the day before. Safe to re-run: a unique index on (account, period) makes the second run a no-op.
 * Each account bills in its own transaction so one bad account cannot block the run.
 */
export async function runBillCycle(db: Db, asOf: DateStr = today(), opts: { accountId?: string } = {}): Promise<BillRunResult> {
  const res: BillRunResult = { asOf, accounts: 0, invoices: 0, skipped: 0, totalMinor: 0, errors: [] };
  const accts = (await db.query(
    `SELECT * FROM accounts WHERE status='ACTIVE' AND (bill_cycle_day = $1 OR bill_cycle_day IS NULL) AND ($2::uuid IS NULL OR id = $2::uuid) ORDER BY id`,
    [dayOf(asOf), opts.accountId ?? null],
  )).rows;
  for (const a of accts) {
    res.accounts++;
    try {
      const inv = await db.tx((q) => billAccount(q, a, asOf));
      if (inv === 'EXISTS') res.skipped++;
      else if (inv) { res.invoices++; res.totalMinor += inv.totalMinor; } else res.skipped++;
    } catch (e) {
      res.errors.push({ accountId: a.id, error: (e as Error).message });
    }
  }
  return res;
}

async function billAccount(q: Queryable, a: Row, asOf: DateStr): Promise<Row | null | 'EXISTS'> {
  const daily = a.billCycleDay === null;
  const periodStart = daily ? addDays(asOf, -1) : addMonths(asOf, -1);
  const periodEnd = addDays(asOf, -1);
  const exists = (await q.query(`SELECT 1 FROM invoices WHERE account_id=$1 AND kind='CYCLE' AND period_start=$2 AND period_end=$3`, [a.id, periodStart, periodEnd])).rows.length;
  if (exists) return 'EXISTS';
  const days = diffDays(periodEnd, periodStart) + 1;
  const lines: DraftLine[] = [];

  // Services the customer asked to suspend during this period are billed on their own lines below: recurring charge prorated for the days
  // in service, and the offer's maintenance fee (if it has one) for the days suspended.
  const suspended = await voluntarySuspendedDays(q, { accountId: a.id as string }, periodStart, periodEnd);
  const skip = [...suspended.keys()];
  // Recurring: group fully-active services per offer (one line, scales to IoT fleets); list part-period ones individually.
  const full = (await q.query(
    `SELECT s.offer_id, count(*) AS n FROM services s WHERE s.account_id=$1 AND s.status='ACTIVE' AND s.activated_at::date <= $2::date AND s.id <> ALL($3::uuid[]) GROUP BY s.offer_id`, [a.id, periodStart, skip])).rows;
  const partial = (await q.query(
    `SELECT s.id, s.identifier, s.offer_id, s.activated_at::date::text AS activated FROM services s
     WHERE s.account_id=$1 AND s.status='ACTIVE' AND s.activated_at::date > $2::date AND s.activated_at::date <= $3::date AND s.id <> ALL($4::uuid[]) ORDER BY s.identifier LIMIT 5000`, [a.id, periodStart, periodEnd, skip])).rows;
  const offers = new Map<string, OfferNode>();
  const offer = async (id: string) => {
    if (!offers.has(id)) {
      const r = (await q.query('SELECT * FROM catalog_nodes WHERE id=$1', [id])).rows[0];
      if (!r) throw notFound('offer', id);
      offers.set(id, { id, name: r.name, kind: r.kind, ...r.data } as OfferNode);
    }
    return offers.get(id)!;
  };
  const periodFee = async (id: string) => {
    const o = await offer(id);
    const f = monthlyFee(o);
    if (!f) return null;
    const monthly = f.amount.amountMinor / (f.periodMonths ?? 1);
    return { o, f, monthly, amount: daily ? Math.round(monthly / 30) : Math.round(monthly) };
  };
  for (const r of full) {
    const p = await periodFee(r.offerId);
    if (!p) continue;
    lines.push({ kind: 'RECURRING', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: p.f.taxInclusive,
      description: `${p.o.name}${r.n > 1 ? ` x ${r.n}` : ''} (${periodStart} to ${periodEnd})`, amountMinor: p.amount * r.n });
  }
  for (const s of partial) {
    const p = await periodFee(s.offerId);
    if (!p) continue;
    const active = diffDays(periodEnd, s.activated) + 1;
    lines.push({ serviceId: s.id, kind: 'RECURRING', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: p.f.taxInclusive,
      description: `${p.o.name} ${s.identifier} (pro-rated ${active}/${days} days)`, amountMinor: daily ? p.amount : Math.round((p.monthly * active) / days) });
  }
  if (skip.length) {
    const rows = (await q.query(`SELECT id, identifier, offer_id, activated_at::date::text AS activated FROM services WHERE id = ANY($1::uuid[]) AND status <> 'TERMINATED' AND activated_at IS NOT NULL AND activated_at::date <= $2::date ORDER BY identifier`, [skip, periodEnd])).rows;
    for (const s of rows) {
      const p = await periodFee(s.offerId);
      if (!p) continue;
      const off = suspended.get(s.id as string) ?? 0;
      const from = s.activated > periodStart ? (s.activated as string) : periodStart;
      const inService = Math.max(0, diffDays(periodEnd, from) + 1 - off);
      const base = daily ? p.amount : p.monthly;
      if (inService > 0) lines.push({ serviceId: s.id, kind: 'RECURRING', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: p.f.taxInclusive,
        description: `${p.o.name} ${s.identifier} (pro-rated ${inService}/${days} days, suspended ${off})`, amountMinor: Math.round((base * inService) / days) });
      const sus = p.o.suspension;
      if (sus?.mode === 'MAINTENANCE_FEE' && (sus.monthlyFeeMinor ?? 0) > 0 && off > 0) {
        const feeBase = daily ? (sus.monthlyFeeMinor! / 30) : sus.monthlyFeeMinor!;
        lines.push({ serviceId: s.id, kind: 'ADJUSTMENT', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: p.f.taxInclusive,
          description: `Maintenance fee while suspended ${s.identifier} (${off} days)`, amountMinor: Math.round((feeBase * off) / days) });
      }
    }
  }
  // Group benefit: a percentage off the recurring fee of each supplementary service in a group of this account.
  const discounted = (await q.query(
    `SELECT s.id, s.identifier, s.offer_id, s.activated_at::date::text AS activated, (g.benefits->>'discountBps')::int AS bps, g.name AS group_name
       FROM service_group_members m JOIN service_groups g ON g.id = m.group_id AND g.status = 'ACTIVE'
       JOIN services s ON s.id = m.service_id
      WHERE g.account_id=$1 AND m.role='SUPPLEMENTARY' AND s.status='ACTIVE' AND s.activated_at::date <= $2::date AND COALESCE((g.benefits->>'discountBps')::int, 0) > 0
      ORDER BY g.name, s.identifier LIMIT 5000`, [a.id, periodEnd])).rows;
  for (const s of discounted) {
    const p = await periodFee(s.offerId);
    if (!p) continue;
    const active = s.activated > periodStart ? diffDays(periodEnd, s.activated) + 1 : days;
    const fee = daily || s.activated <= periodStart ? p.amount : Math.round((p.monthly * active) / days);
    const off = Math.round((fee * s.bps) / 10_000);
    if (off > 0) lines.push({ serviceId: s.id, kind: 'ADJUSTMENT', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: p.f.taxInclusive, description: `Group discount ${s.groupName}: ${s.identifier} (${s.bps / 100}% off)`, amountMinor: -off });
  }
  // Instalments and one-off adjustments
  const charges = (await q.query(`SELECT * FROM service_charges WHERE account_id=$1 AND remaining_cycles > 0 ORDER BY created_at`, [a.id])).rows;
  for (const c of charges) {
    lines.push({ serviceId: c.serviceId, kind: c.kind === 'INSTALLMENT' ? 'INSTALLMENT' : 'ADJUSTMENT', revenueAccount: GL.GOODS_REVENUE, taxInclusive: c.taxInclusive, description: c.description, amountMinor: c.amountMinor });
    await q.query('UPDATE service_charges SET remaining_cycles = remaining_cycles - 1 WHERE id=$1', [c.id]);
  }
  const inv = await issueInvoice(q, a, { kind: 'CYCLE', periodStart, periodEnd, issueDate: asOf, lines });
  await liftCreditRestrictions(q, a.id as string); // a new bill starts the unbilled usage from zero
  if (inv) await audit(q, 'billing', 'invoice', inv.id, 'ISSUED', { number: inv.number, total: inv.totalMinor });
  return inv;
}

// ───────────────────────── payments, credit notes, dunning ─────────────────────────
export const invoiceBalance = (i: Row) => i.totalMinor - i.paidMinor - i.creditedMinor;

export async function getInvoice(q: Queryable, id: string): Promise<Row> {
  const inv = (await q.query(
    `SELECT i.*, c.display_name AS customer_name, c.email, c.market_code, a.name AS account_name FROM invoices i
     JOIN customers c ON c.id = i.customer_id JOIN accounts a ON a.id = i.account_id WHERE i.id=$1`, [id])).rows[0];
  if (!inv) throw notFound('invoice', id);
  const lines = (await q.query('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id', [id])).rows;
  const payments = (await q.query('SELECT id, method, status, amount_minor, reference, created_at FROM payments WHERE invoice_id=$1 ORDER BY created_at', [id])).rows;
  return { ...inv, balanceMinor: invoiceBalance(inv), lines, payments, taxName: (await marketFor(q, inv.marketCode)).taxName };
}

export async function listInvoices(q: Queryable, f: { customerId?: string; accountId?: string; status?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.customerId) where.push(`i.customer_id = ${p(f.customerId)}`);
  if (f.accountId) where.push(`i.account_id = ${p(f.accountId)}`);
  if (f.status) where.push(`i.status = ${p(f.status)}`);
  // Search: an invoice number prefix (INV-2026-00…), otherwise whoever the customer is.
  const text = (f.q ?? '').trim();
  if (/^inv/i.test(text)) where.push(`i.number LIKE ${p(likePrefix(text.toUpperCase()))}`);
  else { const ids = customerIdsMatching(await parseQuery(q, text), p); if (ids) where.push(`i.customer_id IN (${ids})`); }
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(i.issue_date, i.number) < (${p(cur[0])}::date, ${p(cur[1])}::text)`);
  const rows = (await q.query(
    `SELECT i.*, i.total_minor - i.paid_minor - i.credited_minor AS balance_minor, c.display_name AS customer_name
     FROM invoices i JOIN customers c ON c.id = i.customer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY i.issue_date DESC, i.number DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [String(r.issueDate).slice(0, 10), r.number as string]);
}

export async function payInvoice(db: Db, invoiceId: string, o: { amountMinor?: number; method: 'CASH' | 'CREDIT_CARD' | 'QR'; reference?: string; idempotencyKey?: string; date?: DateStr }, actor = 'system') {
  return db.tx(async (q) => {
    const inv = (await q.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
    if (!inv) throw notFound('invoice', invoiceId);
    if (inv.status === 'VOID') throw rejected('invoice is void');
    const bal = invoiceBalance(inv);
    const amount = o.amountMinor ?? bal;
    if (!Number.isInteger(amount) || amount <= 0) throw invalid('amount must be a positive integer (minor units)');
    if (amount > bal) throw rejected(`payment ${amount} exceeds the outstanding balance ${bal}`);
    if (paymentMode() === 'manual' && !o.reference?.trim()) throw invalid('a payment reference (terminal approval, receipt or bank transfer number) is required');
    if (paymentMode() === 'simulated' && (o.reference ?? '').toUpperCase().startsWith('DECLINE')) throw rejected('payment declined by the gateway');
    const key = o.idempotencyKey ?? `inv-${invoiceId}-${randomUUID()}`;
    const dup = (await q.query('SELECT id FROM payments WHERE shard_id=$1 AND idempotency_key=$2', [inv.shardId, key])).rows[0];
    if (!dup) {
      await q.query(
        `INSERT INTO payments (shard_id, invoice_id, method, status, amount_minor, currency, reference, idempotency_key, gateway_ref) VALUES ($1,$2,$3,'CAPTURED',$4,$5,$6,$7,$8)`,
        [inv.shardId, invoiceId, o.method, amount, inv.currency, o.reference ?? null, key, `sim_${invoiceId.slice(0, 8)}`],
      );
      await q.query(`UPDATE invoices SET paid_minor = paid_minor + $2 WHERE id=$1`, [invoiceId, amount]);
      await postJournal(q, { date: o.date ?? today(), sourceType: 'PAYMENT', sourceId: invoiceId, currency: inv.currency, lines: [
        { account: GL.CASH, debit: amount, description: `Payment for ${inv.number} (${o.method})` },
        { account: GL.AR, credit: amount, description: `Payment for ${inv.number}` },
      ] });
      await audit(q, actor, 'invoice', invoiceId, 'PAYMENT', { amount, method: o.method });
    }
    await settle(q, inv.id);
    return getInvoice(q, invoiceId);
  });
}

/** Re-derives status from balance, and lifts a dunning suspension once the account has nothing overdue. */
export async function settle(q: Queryable, invoiceId: string) {
  const inv = (await q.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0]!;
  if (inv.status === 'VOID') return;
  if (invoiceBalance(inv) === 0) await q.query(`UPDATE invoices SET status='PAID' WHERE id=$1`, [invoiceId]);
  const stillOverdue = (await q.query(`SELECT 1 FROM invoices WHERE account_id=$1 AND status='OVERDUE' LIMIT 1`, [inv.accountId])).rows.length;
  if (!stillOverdue) await restoreAfterPayment(q, inv.accountId as string); // lifts the dunning bars and closes the ladder
}

/** Credit note. If the invoice was already (over)paid, the excess is refunded to the customer. */
export async function creditInvoice(db: Db, invoiceId: string, amountMinor: number, reason: string, actor = 'system', caseId?: string) {
  return db.tx(async (q) => {
    const inv = (await q.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId])).rows[0];
    if (!inv) throw notFound('invoice', invoiceId);
    if (inv.status === 'VOID') throw rejected('invoice is void');
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw invalid('amount must be a positive integer (minor units)');
    if (!reason.trim()) throw invalid('a reason is required');
    if (amountMinor > inv.totalMinor - inv.creditedMinor) throw rejected('credit exceeds the invoiced amount not yet credited');
    const tax = Math.round((amountMinor * inv.taxMinor) / inv.totalMinor);
    await postJournal(q, { date: today(), sourceType: 'CREDIT_NOTE', sourceId: invoiceId, currency: inv.currency, lines: [
      { account: GL.CREDIT_NOTES, debit: amountMinor - tax, description: `Credit note ${inv.number}: ${reason}` },
      { account: GL.TAX_PAYABLE, debit: tax, description: `Credit note ${inv.number} tax` },
      { account: GL.AR, credit: amountMinor, description: `Credit note ${inv.number}` },
    ] });
    await q.query('UPDATE invoices SET credited_minor = credited_minor + $2 WHERE id=$1', [invoiceId, amountMinor]);
    const after = (await q.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0]!;
    const excess = -invoiceBalance(after); // customer has paid more than is now owed
    if (excess > 0) {
      await q.query(`INSERT INTO payments (shard_id, invoice_id, method, status, amount_minor, currency, reference, idempotency_key) VALUES ($1,$2,'CASH','REFUNDED',$3,$4,$5,$6)`,
        [inv.shardId, invoiceId, -excess, inv.currency, `refund: ${reason}`, `refund-${randomUUID()}`]);
      await q.query('UPDATE invoices SET paid_minor = paid_minor - $2 WHERE id=$1', [invoiceId, excess]);
      await postJournal(q, { date: today(), sourceType: 'REFUND', sourceId: invoiceId, currency: inv.currency, lines: [
        { account: GL.AR, debit: excess, description: `Refund ${inv.number}` },
        { account: GL.CASH, credit: excess, description: `Refund ${inv.number}` },
      ] });
    }
    await settle(q, invoiceId);
    await audit(q, actor, 'invoice', invoiceId, 'CREDIT_NOTE', { amountMinor, reason, refunded: Math.max(excess, 0) });
    if (caseId) await q.query(`UPDATE cases SET notes = notes || $2::jsonb, updated_at = now() WHERE id=$1`, [caseId, JSON.stringify([{ at: new Date().toISOString(), by: actor, text: `Credit note ${amountMinor} issued on ${inv.number}: ${reason}` }])]);
    return getInvoice(q, invoiceId);
  });
}

export { fmt, toDate };
