import { audit } from './audit.js';
import { invoiceBalance } from './billing.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { queueOutbox } from './lifecycle-state.js';

/**
 * Payment arrangements and collection placements.
 *
 * An ARRANGEMENT is a customer's agreed plan to pay what they owe in instalments. While they keep to it, steps that carry the "payment arrangement" exclusion
 * are held back. Keeping to it means: by each instalment's date plus a short grace, the payments received since the arrangement began add up to the instalments
 * due so far. Missing that breaks the arrangement and dunning carries on from where it was.
 *
 * A PLACEMENT is debt handed to an external collection agency (a step of the ladder, or after termination). Placements wait until the agency file is exported;
 * paying the debt later recovers or recalls the placement.
 */
export interface Instalment { dueDate: string; amountMinor: number }
const DAY = 86_400_000;
const dayOf = (v: unknown) => String(v).slice(0, 10);

export async function createArrangement(q: Queryable, accountId: string, i: { installments: Instalment[]; reason?: string; graceDays?: number }, actor: string): Promise<Row> {
  const acct = (await q.query('SELECT id, customer_id, currency FROM accounts WHERE id=$1', [accountId])).rows[0];
  if (!acct) throw notFound('account', accountId);
  const inst = [...(i.installments ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  if (!inst.length || inst.length > 36) throw invalid('An arrangement has from 1 to 36 instalments.');
  for (const x of inst) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.dueDate) || Number.isNaN(Date.parse(x.dueDate))) throw invalid('Each instalment needs a due date.');
    if (!Number.isInteger(x.amountMinor) || x.amountMinor <= 0) throw invalid('Each instalment is a positive whole amount.');
  }
  if (new Set(inst.map((x) => x.dueDate)).size !== inst.length) throw invalid('Two instalments cannot fall on the same day.');
  if (new Date(inst[inst.length - 1]!.dueDate).getTime() - Date.now() > 400 * DAY) throw invalid('An arrangement runs for at most about a year.');
  const total = inst.reduce((s, x) => s + x.amountMinor, 0);
  const owed = Number((await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS n FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE')`, [accountId])).rows[0]!.n);
  if (owed <= 0) throw rejected('This account owes nothing, so there is nothing to arrange.');
  if (total < owed) throw invalid(`The instalments add up to ${total}, less than the ${owed} owed.`);
  const grace = i.graceDays ?? 2;
  if (!Number.isInteger(grace) || grace < 0 || grace > 14) throw invalid('Grace is 0 to 14 days.');
  if ((await q.query(`SELECT 1 FROM payment_arrangements WHERE account_id=$1 AND status='ACTIVE'`, [accountId])).rows.length) throw conflict('This account already has an arrangement. Cancel it first.');
  const r = (await q.query(`INSERT INTO payment_arrangements (account_id, customer_id, total_minor, currency, installments, grace_days, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [accountId, acct.customerId, total, acct.currency, JSON.stringify(inst), grace, (i.reason ?? '').slice(0, 300), actor])).rows[0]!;
  await audit(q, actor, 'payment_arrangement', r.id, 'CREATE', { accountId, total, installments: inst.length });
  await queueOutbox(q, { kind: 'NOTIFY', instruction: 'ARRANGEMENT_AGREED', accountId, payload: { arrangementId: r.id, installments: inst, totalMinor: total } });
  return r;
}

export async function cancelArrangement(q: Queryable, id: string, actor: string, why = 'Cancelled'): Promise<Row> {
  const r = await q.query(`UPDATE payment_arrangements SET status='CANCELLED', ended_at=now(), end_reason=$2 WHERE id=$1 AND status='ACTIVE' RETURNING *`, [id, why.slice(0, 200)]);
  if (!r.rowCount) throw conflict('That arrangement is not active.');
  await audit(q, actor, 'payment_arrangement', id, 'CANCEL', { why });
  return r.rows[0]!;
}
export const listArrangements = async (q: Queryable, accountId: string): Promise<Row[]> => (await q.query('SELECT * FROM payment_arrangements WHERE account_id=$1 ORDER BY created_at DESC', [accountId])).rows;

/** What has been paid on the account since a moment. */
async function paidSince(q: Queryable, accountId: string, since: string): Promise<number> {
  return Number((await q.query(`SELECT COALESCE(sum(p.amount_minor),0) AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.account_id=$1 AND p.status='CAPTURED' AND p.created_at >= $2`, [accountId, since])).rows[0]!.n);
}

/**
 * Brings the account's arrangement up to date and says whether it is being kept: completed once everything is paid, broken when an instalment is missed
 * (after its grace), otherwise active and kept.
 */
export async function arrangementStatus(q: Queryable, accountId: string, asOf: string): Promise<{ kept: boolean; id: string | null; state: 'NONE' | 'ACTIVE' | 'BROKEN' | 'COMPLETED' }> {
  const a = (await q.query(`SELECT * FROM payment_arrangements WHERE account_id=$1 AND status='ACTIVE'`, [accountId])).rows[0];
  if (!a) return { kept: false, id: null, state: 'NONE' };
  const inst = a.installments as Instalment[];
  const paid = await paidSince(q, accountId, a.createdAt);
  if (paid >= Number(a.totalMinor)) { await q.query(`UPDATE payment_arrangements SET status='COMPLETED', ended_at=now(), end_reason='Paid in full' WHERE id=$1`, [a.id]); return { kept: false, id: a.id, state: 'COMPLETED' }; }
  const cutoff = new Date(Date.parse(asOf) - a.graceDays * DAY).toISOString().slice(0, 10);
  const due = inst.filter((x) => x.dueDate <= cutoff).reduce((s, x) => s + x.amountMinor, 0);
  if (paid < due) {
    await q.query(`UPDATE payment_arrangements SET status='BROKEN', ended_at=now(), end_reason=$2 WHERE id=$1`, [a.id, `Instalment missed: ${paid} paid, ${due} due by ${cutoff}.`]);
    await audit(q, 'dunning', 'payment_arrangement', a.id, 'BROKEN', { paid, due });
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'ARRANGEMENT_BROKEN', accountId, payload: { arrangementId: a.id } });
    return { kept: false, id: a.id, state: 'BROKEN' };
  }
  return { kept: true, id: a.id, state: 'ACTIVE' };
}

// ───────────────────────── placements with a collection agency ─────────────────────────
/** Places the account's unpaid invoices with the agency. Returns null when nothing is owed or the debt is already placed. */
export async function placeWithAgency(q: Queryable, accountId: string, o: { runId?: number | null; writtenOff?: boolean; reason?: string; actor: string }): Promise<Row | null> {
  const acct = (await q.query('SELECT id, customer_id, currency FROM accounts WHERE id=$1', [accountId])).rows[0];
  if (!acct) throw notFound('account', accountId);
  const open = (await q.query(`SELECT * FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE','WRITTEN_OFF') AND collections_at IS NULL AND total_minor - paid_minor - credited_minor > 0 ORDER BY due_date`, [accountId])).rows;
  if (!open.length) return null;
  const total = open.reduce((s, i) => s + invoiceBalance(i), 0);
  const r = (await q.query(`INSERT INTO collection_placements (account_id, customer_id, run_id, balance_minor, currency, invoices, written_off, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [accountId, acct.customerId, o.runId ?? null, total, acct.currency, JSON.stringify(open.map((i) => ({ number: i.number, dueDate: dayOf(i.dueDate), balanceMinor: invoiceBalance(i) }))), !!o.writtenOff, o.reason ?? 'NON_PAYMENT'])).rows[0]!;
  await q.query(`UPDATE invoices SET collections_at = now() WHERE id = ANY($1::uuid[])`, [open.map((i) => i.id)]);
  await queueOutbox(q, { kind: 'COLLECTIONS', instruction: 'HAND_OVER', accountId, payload: { placementId: r.id, balanceMinor: total, invoices: open.map((i) => i.number), writtenOff: !!o.writtenOff } });
  await audit(q, o.actor, 'account', accountId, 'DEBT_TO_COLLECTIONS', { balanceMinor: total, placementId: r.id });
  return r;
}

/** Payments after a placement reduce it; a debt paid in full marks it recovered. Called when a payment lands on an account that has placements. */
export async function recordRecovery(q: Queryable, accountId: string): Promise<void> {
  const rows = (await q.query(`SELECT * FROM collection_placements WHERE account_id=$1 AND status='PLACED'`, [accountId])).rows;
  for (const p of rows) {
    const nums = (p.invoices as Array<{ number: string; balanceMinor: number }>).map((i) => i.number);
    const left = Number((await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS n FROM invoices WHERE number = ANY($1::text[])`, [nums])).rows[0]!.n);
    const recovered = Math.max(0, Number(p.balanceMinor) - left);
    if (left <= 0) await q.query(`UPDATE collection_placements SET status='RECOVERED', recovered_minor=$2 WHERE id=$1`, [p.id, Number(p.balanceMinor)]);
    else if (recovered !== Number(p.recoveredMinor)) await q.query(`UPDATE collection_placements SET recovered_minor=$2 WHERE id=$1`, [p.id, recovered]);
  }
}

export async function recallPlacement(q: Queryable, id: string, actor: string, why: string): Promise<Row> {
  const r = await q.query(`UPDATE collection_placements SET status='RECALLED' WHERE id=$1 AND status='PLACED' RETURNING *`, [id]);
  if (!r.rowCount) throw conflict('That placement is not with the agency.');
  await audit(q, actor, 'collection_placement', id, 'RECALL', { why });
  return r.rows[0]!;
}

export async function listPlacements(q: Queryable, f: { status?: string; pending?: boolean; limit?: number } = {}): Promise<Row[]> {
  const where: string[] = [], args: unknown[] = [];
  if (f.status) { args.push(f.status); where.push(`p.status = $${args.length}`); }
  if (f.pending) where.push('p.exported_at IS NULL');
  args.push(Math.min(f.limit ?? 100, 500));
  return (await q.query(`SELECT p.*, c.display_name AS customer_name FROM collection_placements p LEFT JOIN customers c ON c.id = p.customer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.placed_at DESC LIMIT $${args.length}`, args)).rows;
}

const csv = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/**
 * The file for the collection agency: every placement not yet sent, as CSV, marked as sent under a batch number. Identity documents are the masked form held
 * by Meridian; the agency gets what it needs to make contact and state the debt, no more.
 */
export async function exportAgencyFile(db: Db, actor: string, o: { limit?: number } = {}): Promise<{ batchId: string; count: number; totalMinor: number; csv: string }> {
  return db.tx(async (q) => {
    const rows = (await q.query(
      `SELECT p.*, c.display_name, c.id_document_ref, c.email, c.phone, c.address FROM collection_placements p JOIN customers c ON c.id = p.customer_id
        WHERE p.status='PLACED' AND p.exported_at IS NULL ORDER BY p.placed_at LIMIT $1 FOR UPDATE OF p`, [Math.min(o.limit ?? 5000, 20000)])).rows;
    if (!rows.length) return { batchId: '', count: 0, totalMinor: 0, csv: '' };
    const seq = Number((await q.query(`SELECT count(DISTINCT batch_id) AS n FROM collection_placements WHERE batch_id LIKE $1`, [`COL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-%`])).rows[0]!.n) + 1;
    const batchId = `COL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;
    const head = ['batch_id', 'placement_id', 'customer_id', 'customer_name', 'id_document', 'email', 'phone', 'address', 'account_id', 'currency', 'balance_minor', 'written_off', 'invoices', 'oldest_due_date', 'placed_at'];
    const lines = [head.join(',')];
    for (const r of rows) {
      const a = (r.address ?? {}) as Record<string, string>;
      const inv = r.invoices as Array<{ number: string; dueDate: string }>;
      lines.push([batchId, r.id, r.customerId, r.displayName, r.idDocumentRef, r.email, r.phone, [a.line1, a.line2, a.city, a.postcode, a.country].filter(Boolean).join(', '), r.accountId, String(r.currency).trim(), r.balanceMinor,
        r.writtenOff ? 'Y' : 'N', inv.map((i) => i.number).join(' '), inv.map((i) => i.dueDate).sort()[0] ?? '', new Date(r.placedAt).toISOString()].map(csv).join(','));
    }
    await q.query(`UPDATE collection_placements SET batch_id=$2, exported_at=now() WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id), batchId]);
    await audit(q, actor, 'collection_placement', batchId, 'EXPORT', { count: rows.length });
    return { batchId, count: rows.length, totalMinor: rows.reduce((s, r) => s + Number(r.balanceMinor), 0), csv: lines.join('\r\n') + '\r\n' };
  });
}
