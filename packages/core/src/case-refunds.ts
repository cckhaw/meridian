import { audit } from './audit.js';
import { creditInvoiceIn } from './billing.js';
import { ACTIVE_STATUSES, caseLog, notifySupervisors } from './cases.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, forbidden, invalid, notFound, rejected } from './errors.js';

/**
 * Refunds on billing-dispute cases, approved by amount. The tiers (Settings → Cases) say how much each group of roles may approve: by default an agent up to 20.00,
 * a team lead up to 100.00 and a finance manager above that. A refund within the asker's own limit is applied at once; a larger one waits for someone in a high
 * enough tier, who must not be the person who asked (dual control). Approving credits the invoice in the same transaction that claims the request, so two
 * approvers cannot both pay it, and a case cannot be resolved while a refund on it is waiting.
 */
export interface RefundTier { label: string; /** The most this tier may approve, in minor units; null for no limit. */ maxMinor: number | null; roleIds: string[] }
export const DEFAULT_REFUND_TIERS: RefundTier[] = [
  { label: 'Agent', maxMinor: 2_000, roleIds: ['call-center', 'customer-service'] },
  { label: 'Team lead', maxMinor: 10_000, roleIds: ['team-lead'] },
  { label: 'Finance manager', maxMinor: null, roleIds: ['finance', 'billing-ops'] },
];
export interface RefundActor { username: string; roles: string[]; isSuperuser?: boolean }

export async function getRefundTiers(q: Queryable): Promise<RefundTier[]> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='caseRefundTiers'`)).rows[0]?.value as RefundTier[] | undefined;
  return Array.isArray(v) && v.length ? v : DEFAULT_REFUND_TIERS;
}
export async function setRefundTiers(q: Queryable, actor: string, tiers: RefundTier[]): Promise<RefundTier[]> {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 6) throw invalid('Set from 1 to 6 approval tiers.');
  let prev = 0;
  tiers.forEach((t, i) => {
    if (!t.label?.trim() || t.label.length > 40) throw invalid('Each tier needs a name of up to 40 characters.');
    if (!Array.isArray(t.roleIds) || !t.roleIds.length || t.roleIds.some((r) => !/^[a-z0-9][a-z0-9-]{0,40}$/.test(r))) throw invalid(`${t.label}: name at least one role.`);
    const last = i === tiers.length - 1;
    if (last ? t.maxMinor !== null : t.maxMinor === null) throw invalid(last ? 'The top tier has no limit.' : `${t.label}: only the top tier can have no limit.`);
    if (t.maxMinor !== null) { if (!Number.isInteger(t.maxMinor) || t.maxMinor <= prev) throw invalid('Limits are whole amounts, each larger than the one before.'); prev = t.maxMinor; }
  });
  const clean = tiers.map((t) => ({ label: t.label.trim(), maxMinor: t.maxMinor, roleIds: [...new Set(t.roleIds)] }));
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('caseRefundTiers', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(clean), actor]);
  await audit(q, actor, 'settings', 'caseRefundTiers', 'update', { tiers: clean.length });
  return clean;
}

/** The lowest tier whose limit covers the amount. */
export const tierFor = (tiers: RefundTier[], amountMinor: number) => tiers.findIndex((t) => t.maxMinor === null || amountMinor <= t.maxMinor);
/** The highest tier a person belongs to, or -1. A super user belongs to the top one. */
export const tierOfPrincipal = (tiers: RefundTier[], p: RefundActor) => (p.isSuperuser ? tiers.length - 1 : tiers.reduce((best, t, i) => (t.roleIds.some((r) => p.roles.includes(r)) ? i : best), -1));

const out = (r: Row, tiers: RefundTier[]) => ({ ...r, tierLabel: tiers[r.requiredTier]?.label ?? null });

export async function requestRefund(db: Db, caseId: string, i: { invoiceId: string; amountMinor: number; reason: string }, who: RefundActor): Promise<Row> {
  return db.tx(async (q) => {
    const tiers = await getRefundTiers(q);
    const c = (await q.query('SELECT * FROM cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
    if (!c) throw notFound('case', caseId);
    if (c.type !== 'BILLING_REFUND') throw invalid('Refunds are asked for on a billing-dispute case.');
    if (!ACTIVE_STATUSES.includes(c.status)) throw rejected('This case is not open.');
    const amount = i.amountMinor;
    if (!Number.isInteger(amount) || amount <= 0) throw invalid('The amount must be a positive whole number of minor units.');
    const reason = (i.reason ?? '').trim();
    if (reason.length < 3) throw invalid('Say why the customer is being refunded.');
    const inv = (await q.query('SELECT id, number, customer_id, total_minor, credited_minor, currency, status FROM invoices WHERE id=$1', [i.invoiceId])).rows[0];
    if (!inv) throw notFound('invoice', i.invoiceId);
    if (inv.customerId !== c.customerId) throw invalid('That invoice belongs to another customer.');
    if (inv.status === 'VOID') throw rejected('That invoice is void.');
    const pending = Number((await q.query(`SELECT COALESCE(sum(amount_minor),0) AS n FROM case_refund_requests WHERE invoice_id=$1 AND status='PENDING'`, [i.invoiceId])).rows[0]!.n);
    const room = Number(inv.totalMinor) - Number(inv.creditedMinor) - pending;
    if (amount > room) throw rejected(`Only ${room} (minor units) of ${inv.number} is left to credit${pending ? `, with ${pending} already waiting for approval` : ''}.`);
    const required = tierFor(tiers, amount);
    const mine = tierOfPrincipal(tiers, who);
    const row = (await q.query(
      `INSERT INTO case_refund_requests (case_id, invoice_id, amount_minor, currency, reason, required_tier, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [caseId, i.invoiceId, amount, inv.currency, reason, required, who.username])).rows[0]!;
    if (mine >= required) {   // within the asker's own limit
      await execute(q, row, who.username, 'Within the requester’s own approval limit.', c);
      return out((await q.query('SELECT * FROM case_refund_requests WHERE id=$1', [row.id])).rows[0]!, tiers);
    }
    await caseLog(q, caseId, who.username, 'REFUND_REQUESTED', { detail: { amountMinor: amount, invoice: inv.number, tier: tiers[required]!.label } });
    await notifySupervisors(q, c, 'CASE_REFUND_APPROVAL', `A refund of ${amount} (minor units) on case ${c.number} needs approval by ${tiers[required]!.label}.`, { roleIds: tiers.slice(required).flatMap((t) => t.roleIds), refundId: row.id });
    return out(row, tiers);
  });
}

/** Claims a pending request and credits the invoice, in the caller's transaction. */
async function execute(q: Queryable, r: Row, by: string, note: string, c: Row) {
  const claim = await q.query(`UPDATE case_refund_requests SET status='EXECUTED', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1 AND status='PENDING' RETURNING id`, [r.id, by, note]);
  if (!claim.rowCount) throw conflict('Someone else has already decided this request.');
  await creditInvoiceIn(q, r.invoiceId, Number(r.amountMinor), `Refund on case ${c.number}: ${r.reason}`, by, c.id);
  await caseLog(q, c.id, by, 'REFUND_EXECUTED', { detail: { amountMinor: Number(r.amountMinor), requestedBy: r.requestedBy, note } });
}

export async function decideRefund(db: Db, requestId: string, d: { decision: 'APPROVE' | 'REJECT'; note?: string }, who: RefundActor): Promise<Row> {
  if (d.decision !== 'APPROVE' && d.decision !== 'REJECT') throw invalid('Decide to approve or reject.');
  return db.tx(async (q) => {
    const tiers = await getRefundTiers(q);
    const r = (await q.query('SELECT * FROM case_refund_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
    if (!r) throw notFound('refund request', requestId);
    if (r.status !== 'PENDING') throw conflict(`This request was already ${String(r.status).toLowerCase()}.`);
    const mine = tierOfPrincipal(tiers, who);
    if (mine < r.requiredTier) throw forbidden(`Approving ${r.amountMinor} needs ${tiers[r.requiredTier]!.label} or above.`);
    const c = (await q.query('SELECT * FROM cases WHERE id=$1', [r.caseId])).rows[0]!;
    const note = (d.note ?? '').trim();
    if (d.decision === 'REJECT') {
      if (note.length < 3) throw invalid('Say why the refund is rejected.');
      await q.query(`UPDATE case_refund_requests SET status='REJECTED', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [requestId, who.username, note]);
      await caseLog(q, c.id, who.username, 'REFUND_REJECTED', { detail: { amountMinor: Number(r.amountMinor), note } });
    } else {
      if (r.requestedBy === who.username) throw forbidden('Someone other than the person who asked must approve this refund.');
      await execute(q, r, who.username, note || 'Approved.', c);
    }
    return out((await q.query('SELECT * FROM case_refund_requests WHERE id=$1', [requestId])).rows[0]!, tiers);
  });
}

export async function cancelRefund(q: Queryable, requestId: string, who: RefundActor): Promise<Row> {
  const r = (await q.query('SELECT * FROM case_refund_requests WHERE id=$1', [requestId])).rows[0];
  if (!r) throw notFound('refund request', requestId);
  if (r.requestedBy !== who.username && !who.isSuperuser) throw forbidden('Only the person who asked can withdraw the request.');
  const upd = await q.query(`UPDATE case_refund_requests SET status='CANCELLED', decided_by=$2, decided_at=now(), decision_note='Withdrawn.' WHERE id=$1 AND status='PENDING'`, [requestId, who.username]);
  if (!upd.rowCount) throw conflict('This request has already been decided.');
  await caseLog(q, r.caseId, who.username, 'REFUND_CANCELLED', { detail: { amountMinor: Number(r.amountMinor) } });
  return out((await q.query('SELECT * FROM case_refund_requests WHERE id=$1', [requestId])).rows[0]!, await getRefundTiers(q));
}

export async function listRefunds(q: Queryable, caseId: string): Promise<Row[]> {
  const tiers = await getRefundTiers(q);
  return (await q.query('SELECT r.*, i.number AS invoice_number FROM case_refund_requests r LEFT JOIN invoices i ON i.id = r.invoice_id WHERE r.case_id=$1 ORDER BY r.requested_at DESC', [caseId])).rows.map((r) => out(r, tiers));
}

/** Requests the person may decide: at or below their tier, and not their own. */
export async function listRefundsToDecide(q: Queryable, who: RefundActor): Promise<Row[]> {
  const tiers = await getRefundTiers(q);
  const mine = tierOfPrincipal(tiers, who);
  if (mine < 0) return [];
  return (await q.query(
    `SELECT r.*, k.number AS case_number, i.number AS invoice_number, c.display_name AS customer_name FROM case_refund_requests r JOIN cases k ON k.id = r.case_id
       LEFT JOIN invoices i ON i.id = r.invoice_id LEFT JOIN customers c ON c.id = k.customer_id WHERE r.status='PENDING' AND r.required_tier <= $1 AND r.requested_by <> $2 ORDER BY r.requested_at LIMIT 100`, [mine, who.username])).rows.map((r) => out(r, tiers));
}

/** A case with a refund waiting cannot be resolved. */
export async function pendingRefundCount(q: Queryable, caseId: string): Promise<number> {
  return Number((await q.query(`SELECT count(*) AS n FROM case_refund_requests WHERE case_id=$1 AND status='PENDING'`, [caseId])).rows[0]!.n);
}
