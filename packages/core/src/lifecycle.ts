import { audit } from './audit.js';
import { etcQuoteForOffer } from './catalog.js';
import { issueInvoice, invoiceBalance } from './billing.js';
import { getRegional, marketFor } from './settings.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { GL } from './config.js';
import { today } from './dates.js';
import { createAccount } from './customers.js';

async function lockService(q: Queryable, id: string): Promise<Row> {
  const s = (await q.query('SELECT * FROM services WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!s) throw notFound('service', id);
  return s;
}
const overdueFor = async (q: Queryable, accountId: string) =>
  (await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS d FROM invoices WHERE account_id=$1 AND status='OVERDUE'`, [accountId])).rows[0]!.d as number;

export async function suspendService(db: Db, id: string, reason = 'CUSTOMER_REQUEST', actor = 'system') {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status !== 'ACTIVE') throw rejected(`only ACTIVE services can be suspended (this one is ${s.status})`);
    await q.query(`UPDATE services SET status='SUSPENDED', suspended_reason=$2, version=version+1, updated_at=now() WHERE id=$1`, [id, reason]);
    await audit(q, actor, 'service', id, 'SUSPEND', { reason });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

export async function resumeService(db: Db, id: string, actor = 'system') {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status !== 'SUSPENDED') throw rejected(`only SUSPENDED services can be resumed (this one is ${s.status})`);
    if (s.suspendedReason === 'DUNNING' && (await overdueFor(q, s.accountId)) > 0) throw rejected('service is suspended for non-payment; settle the overdue balance first');
    await q.query(`UPDATE services SET status='ACTIVE', suspended_reason=NULL, version=version+1, updated_at=now() WHERE id=$1`, [id]);
    await audit(q, actor, 'service', id, 'RESUME');
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

export async function changeSim(db: Db, id: string, iccid: string, actor = 'system') {
  if (!/^89\d{17,18}$/.test(iccid)) throw invalid('ICCID must be 19-20 digits starting with 89');
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.type !== 'MOBILE') throw rejected('SIM change applies to mobile services');
    if (s.status === 'TERMINATED') throw rejected('service is terminated');
    const used = (await q.query('SELECT 1 FROM services WHERE iccid=$1 AND id <> $2 LIMIT 1', [iccid, id])).rows.length;
    if (used) throw conflict('this SIM is already assigned to another service');
    await q.query('UPDATE services SET iccid=$2, version=version+1, updated_at=now() WHERE id=$1', [id, iccid]);
    await audit(q, actor, 'service', id, 'SIM_CHANGE', { from: s.iccid, to: iccid });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

export async function changeMsisdn(db: Db, id: string, newMsisdn?: string, actor = 'system') {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.type !== 'MOBILE') throw rejected('number change applies to mobile services');
    if (s.status !== 'ACTIVE') throw rejected(`service must be ACTIVE (is ${s.status})`);
    const cust = (await q.query('SELECT market_code FROM customers WHERE id=$1', [s.customerId])).rows[0]!;
    const next = newMsisdn ?? (await marketFor(q, cust.marketCode)).dialCode + (await q.query(`SELECT nextval('msisdn_seq') AS n`)).rows[0]!.n;
    if (!/^\+\d{8,15}$/.test(next)) throw invalid('MSISDN must be E.164, e.g. +6591234567');
    try {
      await q.query(`INSERT INTO identifier_registry (type, identifier, service_id) VALUES ('MOBILE', $1, $2)`, [next, id]);
    } catch (e) {
      if (/duplicate key/.test((e as Error).message)) throw conflict(`${next} is already in service`);
      throw e;
    }
    await q.query('UPDATE services SET identifier=$2, version=version+1, updated_at=now() WHERE id=$1', [id, next]);
    await audit(q, actor, 'service', id, 'MSISDN_CHANGE', { from: s.identifier, to: next });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

/** Ownership transfer: moves the service (and its billing) to another customer. Blocked while the current account owes money. */
export async function transferOwnership(db: Db, id: string, toCustomerId: string, toAccountId?: string, actor = 'system') {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status !== 'ACTIVE') throw rejected(`service must be ACTIVE (is ${s.status})`);
    if (s.customerId === toCustomerId) throw invalid('service already belongs to this customer');
    if ((await overdueFor(q, s.accountId)) > 0) throw rejected('transfer blocked: the current account has an overdue balance');
    const to = (await q.query('SELECT id, status, shard_id FROM customers WHERE id=$1', [toCustomerId])).rows[0];
    if (!to) throw notFound('customer', toCustomerId);
    if (to.status !== 'ACTIVE') throw rejected('receiving customer is not active');
    let acct = toAccountId;
    if (acct) {
      const a = (await q.query('SELECT customer_id FROM accounts WHERE id=$1', [acct])).rows[0];
      if (!a || a.customerId !== toCustomerId) throw invalid('toAccountId does not belong to the receiving customer');
    } else {
      acct = (await q.query(`SELECT id FROM accounts WHERE customer_id=$1 AND status='ACTIVE' ORDER BY created_at LIMIT 1`, [toCustomerId])).rows[0]?.id
        ?? (await createAccount(q, toCustomerId, {})).id;
    }
    // shard_id follows the owning customer; the row is re-homed in place (cross-shard moves need the shard router).
    if (to.shardId !== s.shardId) throw rejected('cross-shard transfers must go through the shard migration job');
    await q.query('UPDATE services SET customer_id=$2, account_id=$3, version=version+1, updated_at=now() WHERE id=$1', [id, toCustomerId, acct]);
    await q.query('UPDATE service_charges SET account_id=$2 WHERE service_id=$1 AND remaining_cycles>0', [id, acct]);
    await audit(q, actor, 'service', id, 'OWNERSHIP_TRANSFER', { from: s.customerId, to: toCustomerId });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

export interface TerminationResult { service: Row; etcMinor: number; waived: boolean; invoice: Row | null }

/** Terminates a service. A fixed-term contract still running triggers an Early Termination Charge on a final invoice. */
export async function terminateService(db: Db, id: string, o: { reason?: string; date?: Date } = {}, actor = 'system'): Promise<TerminationResult> {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status === 'TERMINATED') throw rejected('service is already terminated');
    const when = o.date ?? new Date();
    let etc = 0, waived = false, invoice: Row | null = null;
    if (s.contractTermMonths > 0 && s.contractStart) {
      const quote = await etcQuoteForOffer(q, s.offerId, new Date(s.contractStart), when);
      etc = quote.chargeMinor; waived = quote.waived;
    }
    await q.query(`UPDATE services SET status='TERMINATED', terminated_at=$2, version=version+1, updated_at=now() WHERE id=$1`, [id, when.toISOString()]);
    await q.query('UPDATE service_charges SET remaining_cycles = 0 WHERE service_id=$1', [id]); // outstanding instalments fall due in the ETC
    if (etc > 0) {
      const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0]!;
      const d = today();
      invoice = await issueInvoice(q, acct, { kind: 'FINAL', periodStart: d, periodEnd: d, issueDate: d,
        lines: [{ serviceId: id, kind: 'ETC', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: false, description: `Early termination charge ${s.identifier} (${s.contractTermMonths}-month contract)`, amountMinor: etc }] });
    }
    await audit(q, actor, 'service', id, 'TERMINATE', { reason: o.reason ?? 'unspecified', etcMinor: etc, waived });
    return { service: (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!, etcMinor: etc, waived, invoice };
  });
}

// ───────── MNP (mobile number portability) ─────────
export async function requestPortOut(db: Db, id: string, o: { recipientOperator: string; portingCode?: string }, actor = 'system') {
  if (!o.recipientOperator.trim()) throw invalid('recipientOperator is required');
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.type !== 'MOBILE') throw rejected('only mobile numbers can be ported');
    if (s.status !== 'ACTIVE') throw rejected(`service must be ACTIVE to port out (is ${s.status})`);
    await q.query(`UPDATE services SET status='PORTING_OUT', version=version+1, updated_at=now() WHERE id=$1`, [id]);
    const seq = (await q.query(`SELECT nextval('case_seq') AS n`)).rows[0]!.n;
    const c = (await q.query(
      `INSERT INTO cases (number, customer_id, service_id, type, priority, subject, notes) VALUES ($1,$2,$3,'MNP_PORT_OUT','HIGH',$4,$5) RETURNING *`,
      [`CS-${String(seq).padStart(6, '0')}`, s.customerId, id, `Port-out of ${s.identifier} to ${o.recipientOperator}`,
       JSON.stringify([{ at: new Date().toISOString(), by: actor, text: `Port-out requested to ${o.recipientOperator}${o.portingCode ? `, porting code ${o.portingCode}` : ''}` }])])).rows[0]!;
    await audit(q, actor, 'service', id, 'PORT_OUT_REQUESTED', { to: o.recipientOperator });
    return c;
  });
}

export async function completePortOut(db: Db, id: string, actor = 'system') {
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [id])).rows[0];
  if (!s) throw notFound('service', id);
  if (s.status !== 'PORTING_OUT') throw rejected(`service is ${s.status}, not PORTING_OUT`);
  const r = await terminateService(db, id, { reason: 'PORTED_OUT' }, actor);
  await db.query(`UPDATE cases SET status='RESOLVED', updated_at=now() WHERE service_id=$1 AND type='MNP_PORT_OUT' AND status IN ('OPEN','IN_PROGRESS')`, [id]);
  return r;
}

export async function cancelPortOut(db: Db, id: string, actor = 'system') {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status !== 'PORTING_OUT') throw rejected(`service is ${s.status}, not PORTING_OUT`);
    await q.query(`UPDATE services SET status='ACTIVE', version=version+1, updated_at=now() WHERE id=$1`, [id]);
    await q.query(`UPDATE cases SET status='CLOSED', updated_at=now() WHERE service_id=$1 AND type='MNP_PORT_OUT' AND status IN ('OPEN','IN_PROGRESS')`, [id]);
    await audit(q, actor, 'service', id, 'PORT_OUT_CANCELLED');
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

export async function listServices(q: Queryable, f: { customerId?: string; accountId?: string; status?: string; q?: string; limit?: number; cursor?: string }): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.customerId) where.push(`s.customer_id = ${p(f.customerId)}`);
  if (f.accountId) where.push(`s.account_id = ${p(f.accountId)}`);
  if (f.status) where.push(`s.status = ${p(f.status)}`);
  const text = (f.q ?? '').trim().replace(/[\s()-]/g, '');
  if (text) { // a number (or part of its start); with or without the country code
    const dial = (await getRegional(q)).dialCode;
    const bare = text.replace(/^\+/, '');
    const prefixes = text.startsWith('+') ? [text] : /^\d+$/.test(text) ? [`+${bare}`, `${dial}${bare}`, text] : [text.toUpperCase()];
    where.push(`(${prefixes.map((x) => `s.identifier LIKE ${p(likePrefix(x))}`).join(' OR ')})`);
  }
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(s.identifier, s.id) > (${p(cur[0])}::text, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT s.*, c.name AS offer_name FROM services s LEFT JOIN catalog_nodes c ON c.id = s.offer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.identifier, s.id LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.identifier as string, r.id as string]);
}

export { invoiceBalance };
