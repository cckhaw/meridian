import type { Queryable, Row } from './db.js';
import { rejected } from './errors.js';

export type ServiceStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'PORTING_OUT' | 'TERMINATED';
/** Why a service is restricted. VOLUNTARY is the customer's choice; the others are imposed. */
export type RestrictionKind = 'VOLUNTARY' | 'CREDIT' | 'DUNNING' | 'FRAUD' | 'ADMIN';
export type BarLevel = 'NONE' | 'THROTTLE' | 'SOFT' | 'HARD';

/**
 * The state machine. A transition not listed here is refused, whoever asks.
 *   PENDING     -> ACTIVE (activation), TERMINATED (cancelled before it started)
 *   ACTIVE      -> SUSPENDED (hard bar / voluntary), PORTING_OUT, TERMINATED   (a soft bar or throttle keeps it ACTIVE: incoming still works)
 *   SUSPENDED   -> ACTIVE (resume), TERMINATED
 *   PORTING_OUT -> TERMINATED (port completed), ACTIVE (port cancelled)
 *   TERMINATED  -> nothing
 */
export const TRANSITIONS: Record<ServiceStatus, ServiceStatus[]> = {
  PENDING: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'PORTING_OUT', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  PORTING_OUT: ['TERMINATED', 'ACTIVE'],
  TERMINATED: [],
};

export function assertTransition(from: string, to: ServiceStatus, what = 'change'): void {
  if ((TRANSITIONS[from as ServiceStatus] ?? []).includes(to)) return;
  const verb = to === 'SUSPENDED' ? 'suspended' : to === 'ACTIVE' ? 'resumed' : to === 'TERMINATED' ? 'terminated' : `moved to ${to}`;
  const sources = (Object.keys(TRANSITIONS) as ServiceStatus[]).filter((f) => TRANSITIONS[f].includes(to));
  throw rejected(`Only ${sources.join(' or ')} services can be ${verb} (this one is ${from}; ${what}).`);
}

export const restrictionOf = (s: Row): RestrictionKind | null => ((s.suspensionKind ?? s.suspendedReason) as RestrictionKind | null) ?? null;

export async function logLifecycle(q: Queryable, e: { serviceId: string; accountId?: string | null; action: string; from?: string | null; to?: string | null; kind?: string | null; actor: string; detail?: unknown }): Promise<void> {
  await q.query(
    `INSERT INTO service_lifecycle_events (service_id, account_id, action, from_status, to_status, kind, actor, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.serviceId, e.accountId ?? null, e.action, e.from ?? null, e.to ?? null, e.kind ?? null, e.actor, JSON.stringify(e.detail ?? {})]);
}

export type OutboxKind = 'NETWORK' | 'NOTIFY' | 'COLLECTIONS' | 'GL';
/** Queues something for another system (policy control, HLR/HSS, SMS/email, collections, the ledger), in the same transaction as the change. */
export async function queueOutbox(q: Queryable, m: { kind: OutboxKind; instruction: string; serviceId?: string | null; accountId?: string | null; payload?: unknown }): Promise<void> {
  await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, account_id, instruction, payload) VALUES ($1,$2,$3,$4,$5)`,
    [m.kind, m.serviceId ?? null, m.accountId ?? null, m.instruction, JSON.stringify(m.payload ?? {})]);
}

const BAR_INSTRUCTION: Record<BarLevel, string> = { NONE: 'RESTORE', THROTTLE: 'THROTTLE_DATA', SOFT: 'BAR_OUTGOING', HARD: 'BAR_ALL' };

/** Sets what the network may do for a service and tells the policy system (PCRF/PCF) at once. A hard bar always lets emergency calls through. */
export async function setBarLevel(q: Queryable, s: Row, level: BarLevel, why: { kind: RestrictionKind | null; actor: string; retainIdentity?: boolean }): Promise<void> {
  await q.query('UPDATE services SET bar_level=$2 WHERE id=$1', [s.id, level]);
  await queueOutbox(q, {
    kind: 'NETWORK', instruction: BAR_INSTRUCTION[level], serviceId: s.id as string, accountId: s.accountId as string,
    payload: { identifier: s.identifier, iccid: s.iccid ?? null, bar: level, reason: why.kind, emergencyCalls: 'ALLOWED', ...(level === 'SOFT' ? { incoming: 'ALLOWED' } : {}), ...(why.retainIdentity ? { retainMsisdn: true, retainSim: true } : {}) },
  });
}

/**
 * Called when an account's overdue balance is cleared (a payment, a credit note): lifts every dunning restriction, closes the dunning run, and tells
 * the network. Voluntary and fraud suspensions are not touched.
 */
export async function restoreAfterPayment(q: Queryable, accountId: string, actor = 'billing'): Promise<number> {
  const rows = (await q.query(
    `SELECT * FROM services WHERE account_id=$1 AND COALESCE(suspension_kind, suspended_reason) = 'DUNNING' AND status IN ('ACTIVE','SUSPENDED') FOR UPDATE`, [accountId])).rows;
  for (const s of rows) {
    await q.query(`UPDATE services SET status='ACTIVE', suspended_reason=NULL, suspension_kind=NULL, suspended_at=NULL, suspend_until=NULL, version=version+1, updated_at=now() WHERE id=$1`, [s.id]);
    await setBarLevel(q, s, 'NONE', { kind: null, actor });
    await logLifecycle(q, { serviceId: s.id, accountId, action: 'RESTORED_AFTER_PAYMENT', from: s.status, to: 'ACTIVE', kind: 'DUNNING', actor });
  }
  const run = await q.query(`UPDATE dunning_runs SET status='PAID', ended_at=now() WHERE account_id=$1 AND status='ACTIVE'`, [accountId]);
  await q.query(`UPDATE accounts SET dunning_stage=0 WHERE id=$1 AND dunning_stage>0`, [accountId]);
  if (rows.length || run.rowCount) await queueOutbox(q, { kind: 'NOTIFY', instruction: 'PAYMENT_THANKS', accountId, payload: { restored: rows.length } });
  return rows.length;
}

/**
 * Days of a period a service spent in a voluntary suspension, per service. The day service comes back counts as active, the first day of the
 * suspension does not. Used to prorate the recurring charge and to charge the maintenance fee for the days suspended.
 */
export async function voluntarySuspendedDays(q: Queryable, scope: { accountId?: string; serviceId?: string }, from: string, toInclusive: string): Promise<Map<string, number>> {
  const rows = (await q.query(
    `SELECT service_id,
            sum(GREATEST(0, LEAST(COALESCE(ended_on, ($3::date + 1)), $3::date + 1) - GREATEST(started_on, $2::date)))::int AS days
       FROM service_suspensions
      WHERE ($1::uuid IS NULL OR account_id = $1::uuid) AND ($4::uuid IS NULL OR service_id = $4::uuid)
        AND started_on <= $3::date AND COALESCE(ended_on, $3::date + 1) > $2::date
      GROUP BY service_id`, [scope.accountId ?? null, from, toInclusive, scope.serviceId ?? null])).rows;
  const out = new Map<string, number>();
  for (const r of rows) if (Number(r.days) > 0) out.set(r.serviceId as string, Number(r.days));
  return out;
}

/** A new bill resets the unbilled usage, so restrictions that came from the credit limit lift with it. */
export async function liftCreditRestrictions(q: Queryable, accountId: string, actor = 'billing'): Promise<number> {
  await q.query(`UPDATE accounts SET credit_state='OK' WHERE id=$1 AND credit_state <> 'OK'`, [accountId]);
  const rows = (await q.query(`SELECT * FROM services WHERE account_id=$1 AND COALESCE(suspension_kind, suspended_reason) = 'CREDIT' AND status IN ('ACTIVE','SUSPENDED') FOR UPDATE`, [accountId])).rows;
  for (const s of rows) {
    await q.query(`UPDATE services SET status='ACTIVE', suspended_reason=NULL, suspension_kind=NULL, suspended_at=NULL, version=version+1, updated_at=now() WHERE id=$1`, [s.id]);
    await setBarLevel(q, s, 'NONE', { kind: null, actor });
    await logLifecycle(q, { serviceId: s.id, accountId, action: 'CREDIT_RESTRICTION_LIFTED', from: s.status, to: 'ACTIVE', kind: 'CREDIT', actor });
  }
  return rows.length;
}
