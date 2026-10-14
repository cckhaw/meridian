import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { addDays, today } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { getLifecycleSettings } from './lifecycle-config.js';
import { assertMsisdnTransition, auditIdentifier } from './nrm.js';
import { activateResourcesTx, normalizeMsisdn } from './nrm-pools.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';

/**
 * Number portability INTO the operator (port-in). A line that brings a number from another operator carries the donor's details; the request goes to the
 * national clearinghouse, and the number switches over when the donor approves.
 *
 * While the port is processed the customer may use a TEMPORARY number from our own pool (the NRM assigns one). The service, its group membership, its
 * discounts and the group's shared quota all belong to the service, not to the number, so the switch-over only changes the number on the service
 * (and tells the network to swap it). Without a temporary number the service waits PENDING and starts when the number arrives.
 */
export interface PortInInput {
  donorOperator: string;
  /** The number being brought in, with its country code (a + is optional). */
  donorMsisdn: string;
  /** The account holder at the donor operator, as the donor has them. */
  holderName: string;
  holderIdType: string;
  holderIdNumber: string;
  /** Use a number from our pool in the meantime. */
  temporaryNumber?: boolean;
}
export const PORT_IN_STATUSES = ['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const;
export type PortInStatus = (typeof PORT_IN_STATUSES)[number];
export const PORT_IN_ID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'COMPANY_REG', 'OTHER'] as const;
const LIVE: PortInStatus[] = ['PENDING', 'APPROVED'];

const text = (v: unknown, what: string, max: number) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) throw invalid(`${what} is needed to port a number in.`);
  if (t.length > max) throw invalid(`${what} is limited to ${max} characters.`);
  return t;
};

/** Checks the donor details of a port-in line and returns them in the form that is stored. */
export function cleanPortIn(i: PortInInput): Required<Omit<PortInInput, 'temporaryNumber'>> & { temporaryNumber: boolean } {
  const n = normalizeMsisdn(i.donorMsisdn ?? '');
  if ('error' in n) throw invalid(`The number to port in: ${n.error}`);
  const idType = text(i.holderIdType, 'The ID type of the account holder', 20).toUpperCase();
  if (!(PORT_IN_ID_TYPES as readonly string[]).includes(idType)) throw invalid(`The ID type is one of ${PORT_IN_ID_TYPES.join(', ')}.`);
  return {
    donorOperator: text(i.donorOperator, 'The donor operator', 60), donorMsisdn: n.value, holderName: text(i.holderName, 'The account holder’s name', 100),
    holderIdType: idType, holderIdNumber: text(i.holderIdNumber, 'The account holder’s ID number', 40), temporaryNumber: !!i.temporaryNumber,
  };
}

/** The number must be free to bring in: not one of ours, and not already in service or being ported. */
export async function assertPortableNumber(q: Queryable, msisdn: string): Promise<void> {
  if ((await q.query('SELECT 1 FROM msisdn_inventory WHERE msisdn=$1', [msisdn])).rows.length) throw rejected(`${msisdn} is already one of our numbers, so it cannot be ported in.`);
  if ((await q.query(`SELECT 1 FROM identifier_registry WHERE type='MOBILE' AND identifier=$1`, [msisdn])).rows.length) throw conflict(`${msisdn} is already in service.`);
  if ((await q.query(`SELECT 1 FROM port_in_requests WHERE donor_msisdn=$1 AND status = ANY($2::text[])`, [msisdn, LIVE])).rows.length) throw conflict(`${msisdn} already has a port-in request in progress.`);
}

/** Records the request for a port-in line (inside the order's transaction) and points the service at it. */
export async function createPortInTx(q: Queryable, r: { customerId: string; orderId?: string; orderLineId?: string; serviceId: string; input: ReturnType<typeof cleanPortIn>; temporaryMsisdn?: string | null; actor: string }): Promise<Row> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO port_in_requests (id, customer_id, order_id, order_line_id, service_id, donor_operator, donor_msisdn, holder_name, holder_id_type, holder_id_number, temporary_msisdn, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, r.customerId, r.orderId ?? null, r.orderLineId ?? null, r.serviceId, r.input.donorOperator, r.input.donorMsisdn, r.input.holderName, r.input.holderIdType, r.input.holderIdNumber, r.temporaryMsisdn ?? null, r.actor]);
  await q.query(`UPDATE services SET port_in_id=$2, number_status=$3 WHERE id=$1`, [r.serviceId, id, r.temporaryMsisdn ? 'TEMPORARY' : null]);
  await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, instruction, payload) VALUES ('NETWORK', $1, 'PORT_IN_REQUEST', $2)`,
    [r.serviceId, JSON.stringify({ portInId: id, donorOperator: r.input.donorOperator, donorMsisdn: r.input.donorMsisdn, temporaryMsisdn: r.temporaryMsisdn ?? null })]);
  await audit(q, r.actor, 'port_in', id, 'REQUESTED', { donorMsisdn: r.input.donorMsisdn, donorOperator: r.input.donorOperator, temporary: !!r.temporaryMsisdn });
  return getPortIn(q, id);
}

export async function getPortIn(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query(
    `SELECT p.*, s.identifier AS service_identifier, s.status AS service_status, c.display_name AS customer_name
       FROM port_in_requests p LEFT JOIN services s ON s.id = p.service_id LEFT JOIN customers c ON c.id = p.customer_id WHERE p.id=$1`, [id])).rows[0];
  if (!r) throw notFound('port-in request', id);
  return r;
}

export async function listPortIns(q: Queryable, f: { status?: string; customerId?: string; q?: string; limit?: number; cursor?: string }): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.status) { if (!(PORT_IN_STATUSES as readonly string[]).includes(f.status)) throw invalid('unknown status'); where.push(`p.status = ${p(f.status)}`); }
  if (f.customerId) where.push(`p.customer_id = ${p(f.customerId)}`);
  if (f.q) where.push(`(p.donor_msisdn LIKE ${p(`%${f.q.replace(/[^\d+]/g, '')}%`)} OR lower(p.holder_name) LIKE ${p(`%${f.q.toLowerCase()}%`)})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(p.created_at::text, p.id) < (${p(cur[0])}::text, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT p.*, p.created_at::text AS cursor_ts, s.identifier AS service_identifier, c.display_name AS customer_name
       FROM port_in_requests p LEFT JOIN services s ON s.id = p.service_id LEFT JOIN customers c ON c.id = p.customer_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at::text DESC, p.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.cursorTs as string, r.id as string]) as Page<Row>;
}

async function live(q: Queryable, id: string, allowed: PortInStatus[]): Promise<Row> {
  const r = (await q.query('SELECT * FROM port_in_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!r) throw notFound('port-in request', id);
  if (!allowed.includes(r.status)) throw rejected(`This port-in request is ${String(r.status).toLowerCase()}${allowed.length === 1 && allowed[0] === 'APPROVED' ? ' (it has to be approved by the donor operator first)' : ''}.`);
  return r;
}

/**
 * The clearinghouse's answer (the MNP callback). Approval records the donor's go-ahead (and the date it releases the number); the switch-over then
 * follows with `completePortIn`. A refusal keeps the temporary number as the customer's own, or leaves a waiting service pending for staff to decide.
 * Repeating an answer that was already recorded changes nothing.
 */
export async function decidePortIn(db: Db, id: string, d: { approved: boolean; reference?: string; reason?: string; effectiveAt?: string; complete?: boolean; actor: string }): Promise<Row & { alreadyDone?: boolean }> {
  return db.tx(async (q) => {
    const cur = (await q.query('SELECT status FROM port_in_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw notFound('port-in request', id);
    if (cur.status !== 'PENDING') {
      const same = d.approved ? ['APPROVED', 'COMPLETED'] : ['REJECTED'];
      if (same.includes(cur.status)) return { ...(await getPortIn(q, id)), alreadyDone: true };
      throw rejected(`This port-in request is ${String(cur.status).toLowerCase()}.`);
    }
    if (!d.approved) { await finishWithoutSwap(q, id, 'REJECTED', d.reason ?? 'rejected by the donor operator', d.actor, d.reference); return getPortIn(q, id); }
    let at: string | null = null;
    if (d.effectiveAt) { const t = new Date(d.effectiveAt); if (Number.isNaN(t.getTime())) throw invalid('the switch-over date is not a date'); at = t.toISOString(); }
    await q.query(`UPDATE port_in_requests SET status='APPROVED', decided_at=now(), clearinghouse_ref=COALESCE($2, clearinghouse_ref), requested_swap_at=$3, updated_at=now() WHERE id=$1`, [id, d.reference ?? null, at]);
    await audit(q, d.actor, 'port_in', id, 'APPROVED', { reference: d.reference ?? null });
    if (d.complete) await completePortInTx(q, id, d.actor);
    return getPortIn(q, id);
  });
}

/** The switch-over: the service takes the ported-in number, the network is told to swap it, and the temporary number goes back to rest. */
export async function completePortIn(db: Db, id: string, actor = 'system'): Promise<Row> {
  return db.tx(async (q) => { await completePortInTx(q, id, actor); return getPortIn(q, id); });
}

export async function completePortInTx(q: Queryable, id: string, actor: string): Promise<void> {
  const r = await live(q, id, ['APPROVED']);
  const s = (await q.query('SELECT * FROM services WHERE id=$1 FOR UPDATE', [r.serviceId])).rows[0];
  if (!s) throw notFound('service', r.serviceId);
  const to = r.donorMsisdn as string;
  const from = s.identifier as string;
  if ((await q.query(`SELECT 1 FROM identifier_registry WHERE type='MOBILE' AND identifier=$1 AND service_id <> $2`, [to, s.id])).rows.length) throw conflict(`${to} is already in service.`);
  const hadTemp = s.numberStatus === 'TEMPORARY' && from !== to;

  // The service's number is now the ported-in one. Everything that hangs off the service id (group, discounts, contract, charges) is untouched.
  await q.query(`DELETE FROM identifier_registry WHERE type='MOBILE' AND identifier=$1 AND service_id=$2`, [from, s.id]);
  await q.query(`INSERT INTO identifier_registry (type, identifier, service_id) VALUES ('MOBILE', $1, $2) ON CONFLICT (type, identifier) DO NOTHING`, [to, s.id]);
  const wasPending = s.status === 'PENDING';
  await q.query(
    `UPDATE services SET identifier=$2, number_status='PORTED_IN', status = CASE WHEN status='PENDING' THEN 'ACTIVE'::service_status ELSE status END,
            activated_at = COALESCE(activated_at, now()), contract_start = COALESCE(contract_start, now()) WHERE id=$1`, [s.id, to]);
  // The number is ours to serve from now on: it joins the inventory as in service (it was never for sale, so it is not tiered).
  await q.query(`INSERT INTO msisdn_inventory (msisdn, state, tier, service_id, batch) VALUES ($1,'ASSIGNED_ACTIVE','STANDARD',$2,'PORTED_IN')
                 ON CONFLICT (msisdn) DO UPDATE SET state='ASSIGNED_ACTIVE', service_id=EXCLUDED.service_id, updated_at=now()`, [to, s.id]);
  await auditIdentifier(q, { type: 'MSISDN', id: to, from: null, to: 'ASSIGNED_ACTIVE', actor, reason: 'ported in', detail: { from: r.donorOperator, service: s.id, replaces: hadTemp ? from : null } });
  if (hadTemp) {
    const num = (await q.query('SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE', [from])).rows[0];
    if (num) {
      assertMsisdnTransition(num.msisdn, num.state, 'QUARANTINE_COOLING');
      const until = addDays(today(), (await getLifecycleSettings(q)).termination.quarantineDays);
      await q.query(`UPDATE msisdn_inventory SET state='QUARANTINE_COOLING', service_id=NULL, quarantine_until=$2, reserved_by=NULL, reserved_until=NULL, updated_at=now() WHERE msisdn=$1`, [from, until]);
      await auditIdentifier(q, { type: 'MSISDN', id: from, from: num.state, to: 'QUARANTINE_COOLING', actor, reason: 'temporary number replaced by the ported-in number', detail: { until } });
    }
  }
  if (wasPending) { // a service that waited for its number starts now: its SIM goes live with it
    const line = r.orderLineId ? (await q.query('SELECT iccid FROM order_lines WHERE id=$1', [r.orderLineId])).rows[0] : null;
    if (line?.iccid) {
      const a = await activateResourcesTx(q, { iccid: line.iccid as string, serviceId: s.id, actor });
      await q.query('UPDATE services SET iccid=$2, imsi=$3 WHERE id=$1', [s.id, line.iccid, a.imsi]);
    }
  }
  await q.query(`UPDATE port_in_requests SET status='COMPLETED', completed_at=now(), updated_at=now() WHERE id=$1`, [id]);
  const sim = (await q.query('SELECT iccid, imsi FROM services WHERE id=$1', [s.id])).rows[0];
  await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, account_id, instruction, payload) VALUES ('NETWORK', $1, $2, $3, $4)`,
    [s.id, s.accountId, hadTemp ? 'MSISDN_SWAP' : 'ACTIVATE_PORTED_IN', JSON.stringify({ portInId: id, from: hadTemp ? from : null, to, iccid: sim?.iccid ?? null, imsi: sim?.imsi ?? null })]);
  await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, account_id, instruction, payload) VALUES ('NOTIFY', $1, $2, 'PORT_IN_COMPLETE', $3)`, [s.id, s.accountId, JSON.stringify({ number: to })]);
  await audit(q, actor, 'port_in', id, 'COMPLETED', { from: hadTemp ? from : null, to });
}

/** A request that ends without the switch-over: refused, cancelled, or no answer in time. */
async function finishWithoutSwap(q: Queryable, id: string, status: 'REJECTED' | 'CANCELLED' | 'EXPIRED', reason: string, actor: string, reference?: string): Promise<void> {
  const r = (await q.query('SELECT * FROM port_in_requests WHERE id=$1', [id])).rows[0]!;
  await q.query(`UPDATE port_in_requests SET status=$2, failure_reason=$3, decided_at=now(), clearinghouse_ref=COALESCE($4, clearinghouse_ref), updated_at=now() WHERE id=$1`, [id, status, reason, reference ?? null]);
  const s = (await q.query('SELECT id, account_id, number_status, identifier FROM services WHERE id=$1', [r.serviceId])).rows[0];
  if (s?.numberStatus === 'TEMPORARY') await q.query(`UPDATE services SET number_status=NULL WHERE id=$1`, [s.id]); // the customer keeps the number they have been using
  if (s) await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, account_id, instruction, payload) VALUES ('NOTIFY', $1, $2, $3, $4)`,
    [s.id, s.accountId, `PORT_IN_${status}`, JSON.stringify({ number: r.donorMsisdn, reason, keepsNumber: s.numberStatus === 'TEMPORARY' ? s.identifier : null })]);
  await audit(q, actor, 'port_in', id, status, { reason });
}

export async function cancelPortIn(db: Db, id: string, reason: string, actor: string): Promise<Row> {
  return db.tx(async (q) => { await live(q, id, LIVE); await finishWithoutSwap(q, id, 'CANCELLED', reason || 'cancelled', actor); return getPortIn(q, id); });
}

/** Requests the donor never answered within `days` end as expired. Safe to run as often as you like (part of the daily job). */
export async function expireStalePortIns(db: Db, days = 14, actor = 'system'): Promise<number> {
  return db.tx(async (q) => {
    const rows = (await q.query(`SELECT id FROM port_in_requests WHERE status='PENDING' AND created_at < now() - ($1::int * interval '1 day') FOR UPDATE SKIP LOCKED`, [days])).rows;
    for (const r of rows) await finishWithoutSwap(q, r.id as string, 'EXPIRED', `no answer from the donor operator within ${days} days`, actor);
    return rows.length;
  });
}
