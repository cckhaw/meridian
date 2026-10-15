import { enqueueOcs } from './ocs.js';
import { randomUUID } from 'node:crypto';
import type { EtcQuote } from '@meridian/types';
import { audit } from './audit.js';
import { etcQuoteForOffer } from './catalog.js';
import { quoteEtc } from './etc.js';
import { issueInvoice, invoiceBalance, settle, type DraftLine } from './billing.js';
import { postJournal } from './ledger.js';
import { clawBackService } from './commission-processor.js';
import { endInstruction } from './service-kinds.js';
import { monthlyFee } from './catalog.js';
import { getRegional, marketFor } from './settings.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { GL } from './config.js';
import { today } from './dates.js';
import { createAccount } from './customers.js';
import { releaseFromGroup } from './groups.js';
import { getLifecycleSettings } from './lifecycle-config.js';
import { releaseResourcesOnTermination } from './nrm.js';
import { assertTransition, logLifecycle, queueOutbox, restrictionOf, setBarLevel, voluntarySuspendedDays, type RestrictionKind } from './lifecycle-state.js';
import { addMonths, addDays, diffDays, fmt } from './dates.js';

async function lockService(q: Queryable, id: string): Promise<Row> {
  const s = (await q.query('SELECT * FROM services WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!s) throw notFound('service', id);
  return s;
}
const overdueFor = async (q: Queryable, accountId: string) =>
  (await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS d FROM invoices WHERE account_id=$1 AND status='OVERDUE'`, [accountId])).rows[0]!.d as number;

export type LifecycleChannel = 'STAFF' | 'SELF_SERVE';

/**
 * Suspends a service on the operator's side (fraud, an administrator, a hard bar). The service stays on the books with its number and SIM;
 * the network is told to bar everything but emergency calls. A customer's own request goes through `suspendVoluntary`, which has a time cap.
 */
export async function suspendService(db: Db, id: string, reason = 'ADMIN', actor = 'system', o: { kind?: RestrictionKind } = {}) {
  const kind: RestrictionKind = o.kind ?? (reason === 'FRAUD' ? 'FRAUD' : reason === 'DUNNING' ? 'DUNNING' : reason === 'CREDIT' ? 'CREDIT' : reason === 'CUSTOMER_REQUEST' || reason === 'VOLUNTARY' ? 'VOLUNTARY' : 'ADMIN');
  if (kind === 'VOLUNTARY') return suspendVoluntary(db, id, {}, actor);
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    assertTransition(s.status, 'SUSPENDED', kind);
    await q.query(`UPDATE services SET status='SUSPENDED', suspended_reason=$2, suspension_kind=$2, suspended_at=now(), suspend_until=NULL, version=version+1, updated_at=now() WHERE id=$1`, [id, kind]);
    await setBarLevel(q, s, 'HARD', { kind, actor });
    await logLifecycle(q, { serviceId: id, accountId: s.accountId, action: 'SUSPEND', from: s.status, to: 'SUSPENDED', kind, actor, detail: { reason } });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

export interface VoluntaryRequest {
  /** How long, in months. Default: the longest allowed. */
  months?: number;
  /** Or the day service comes back (automatically). */
  until?: string;
  channel?: LifecycleChannel;
}

/**
 * A customer-requested suspension (travelling abroad, say). Rules: the service must be ACTIVE and unrestricted, the account must owe nothing
 * overdue, and the time is capped (Settings → Lifecycle, 6 months by default). The number and SIM stay; recurring charges are paused or reduced
 * to the offer's maintenance fee, and prorated when service comes back (on the bill after).
 */
export async function suspendVoluntary(db: Db, id: string, r: VoluntaryRequest = {}, actor = 'system') {
  return db.tx(async (q) => {
    const cfg = await getLifecycleSettings(q);
    const channel = r.channel ?? 'STAFF';
    if (channel === 'SELF_SERVE' && !cfg.voluntary.selfServe) throw rejected('Suspending your own service online is switched off. Please contact us.');
    const s = await lockService(q, id);
    assertTransition(s.status, 'SUSPENDED', 'voluntary suspension');
    const why = restrictionOf(s);
    if (why) throw rejected(`This service is restricted (${why.toLowerCase()}), so a suspension cannot be requested for it.`);
    if (s.type !== 'MOBILE' && s.type !== 'IOT') throw rejected('Only mobile and IoT services can be suspended on request.');
    if ((await overdueFor(q, s.accountId)) > 0) throw rejected('A suspension cannot be requested while the account has an overdue balance. Settle it first.');
    const start = today();
    const cap = addMonths(start, cfg.voluntary.maxMonths);
    let end = r.until ?? (r.months ? addMonths(start, r.months) : cap);
    if (r.until && !/^\d{4}-\d{2}-\d{2}$/.test(r.until)) throw invalid('until is a date such as 2026-12-31');
    if (r.months !== undefined && (!Number.isInteger(r.months) || r.months < 1)) throw invalid('months is a whole number, at least 1');
    if (end <= start) throw invalid('The suspension has to end after today.');
    if (end > cap) throw rejected(`A suspension can last at most ${cfg.voluntary.maxMonths} months (until ${cap}). You asked for until ${end}.`);
    end = end > cap ? cap : end;
    await q.query(`INSERT INTO service_suspensions (service_id, account_id, started_on, ends_on, requested_by, channel) VALUES ($1,$2,$3,$4,$5,$6)`, [id, s.accountId, start, end, actor, channel]);
    await q.query(`UPDATE services SET status='SUSPENDED', suspended_reason='VOLUNTARY', suspension_kind='VOLUNTARY', suspended_at=now(), suspend_until=$2, version=version+1, updated_at=now() WHERE id=$1`, [id, end]);
    await setBarLevel(q, s, 'HARD', { kind: 'VOLUNTARY', actor, retainIdentity: true });
    await logLifecycle(q, { serviceId: id, accountId: s.accountId, action: 'SUSPEND', from: s.status, to: 'SUSPENDED', kind: 'VOLUNTARY', actor, detail: { until: end, channel, maxMonths: cfg.voluntary.maxMonths } });
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'SUSPENSION_CONFIRMED', serviceId: id, accountId: s.accountId, payload: { until: end } });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

/**
 * Brings a service back. What is allowed depends on why it was restricted: the customer can lift their own suspension; a dunning bar lifts
 * when the overdue balance is paid (see payInvoice); a credit-limit, fraud or administrative restriction can only be lifted by staff.
 * Service returns instantly; the recurring charge is prorated on the next bill.
 */
export async function resumeService(db: Db, id: string, actor = 'system', o: { channel?: LifecycleChannel; auto?: boolean } = {}) {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status !== 'SUSPENDED') throw rejected(`only SUSPENDED services can be resumed (this one is ${s.status})`);
    const kind = restrictionOf(s);
    const self = o.channel === 'SELF_SERVE';
    if (kind === 'DUNNING' && (await overdueFor(q, s.accountId)) > 0) throw rejected('service is suspended for non-payment; settle the overdue balance first');
    if (kind === 'CREDIT' && self) throw rejected('This service is restricted because the credit limit was reached. Pay your bill, or contact us.');
    if ((kind === 'FRAUD' || kind === 'ADMIN') && self) throw rejected('This suspension can only be lifted by our staff. Please contact us.');
    if (kind === 'VOLUNTARY' || !kind) {
      await q.query(`UPDATE service_suspensions SET ended_on=$2, end_reason=$3 WHERE service_id=$1 AND ended_on IS NULL`, [id, today(), o.auto ? 'AUTO_RESUMED' : 'RESUMED']);
    }
    await q.query(`UPDATE services SET status='ACTIVE', suspended_reason=NULL, suspension_kind=NULL, suspended_at=NULL, suspend_until=NULL, version=version+1, updated_at=now() WHERE id=$1`, [id]);
    await setBarLevel(q, s, 'NONE', { kind: null, actor });
    await logLifecycle(q, { serviceId: id, accountId: s.accountId, action: o.auto ? 'AUTO_RESUME' : 'RESUME', from: 'SUSPENDED', to: 'ACTIVE', kind, actor, detail: { channel: o.channel ?? 'STAFF' } });
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'SERVICE_RESTORED', serviceId: id, accountId: s.accountId, payload: { was: kind } });
    return (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
  });
}

/** Resumes every voluntary suspension whose end date has come. Run daily (and safe to run again). */
export async function autoResumeDue(db: Db, asOf: string = today()): Promise<{ resumed: number; failed: string[] }> {
  const due = (await db.query(`SELECT id FROM services WHERE status='SUSPENDED' AND suspension_kind='VOLUNTARY' AND suspend_until IS NOT NULL AND suspend_until <= $1::date ORDER BY suspend_until LIMIT 1000`, [asOf])).rows;
  const out = { resumed: 0, failed: [] as string[] };
  for (const r of due) {
    try { await resumeService(db, r.id as string, 'system', { auto: true }); out.resumed++; } catch (e) { out.failed.push(`${r.id}: ${(e as Error).message}`); }
  }
  return out;
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
    await enqueueOcs(q, 'CHANGE_IDENTITY', id, { identity: { from: { identifier: null, iccid: (s.iccid as string | null) ?? null }, to: { identifier: null, iccid } } });
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
    await enqueueOcs(q, 'CHANGE_IDENTITY', id, { identity: { from: { identifier: s.identifier as string, iccid: null }, to: { identifier: next, iccid: null } } });
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
    await releaseFromGroup(q, actor, id); // the new owner's account is a different account, so the service leaves its group
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

/** The early-termination charge for a running service. A device bought on a contract with the plan carries its own terms; otherwise the plan's own contract applies. */
export async function etcQuoteForService(q: Queryable, s: Row, when: Date): Promise<EtcQuote> {
  const d = s.deal as { termMonths: number; subsidyMinor: number; waiveInLastMonths?: number; currency: string } | null;
  // A VIP number comes with a stiffer charge for leaving early: the multiplier set for its tier when it was sold.
  const vip = (quote: EtcQuote): EtcQuote => (s.vipEtcBps && s.vipEtcBps !== 10000 && quote.chargeMinor > 0 ? { ...quote, chargeMinor: Math.round((quote.chargeMinor * s.vipEtcBps) / 10000), vipMultiplierBps: s.vipEtcBps } : quote);
  if (!d) return vip(await etcQuoteForOffer(q, s.offerId, new Date(s.contractStart), when));
  const money = { amountMinor: d.subsidyMinor, currency: d.currency };
  return vip(quoteEtc({ offerId: s.offerId, contractStart: new Date(s.contractStart), terminationDate: when,
    contract: { termMonths: d.termMonths as 12 | 24 | 36, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: d.waiveInLastMonths ?? 1 }, subsidy: { subsidyAmount: money, deviceRetailPrice: money } } }));
}

export interface TerminationOptions {
  reason?: string;
  date?: Date;
  /** Retention and VIP cases: waive the early-termination charge, or charge only a percentage of it. Needs a reason; audited. */
  etcAdjust?: { waive?: boolean; percent?: number; reason: string };
  /** Usage not billed yet (from the charging system), added to the closing invoice. */
  unbilledUsageMinor?: number;
  /** Give the account's deposit back (after what is owed on the closing invoice) when this was its last service. */
  refundDeposit?: boolean;
  /** The number now belongs to another operator: it is not recycled. */
  ported?: boolean;
}
export interface TerminationResult {
  service: Row; etcMinor: number; waived: boolean; invoice: Row | null;
  /** The ETC before any waiver or adjustment, and how it was made up. */
  etc: { quotedMinor: number; recurringMinor: number | null; clawbackMinor: number | null; adjustedBy: string | null };
  unbilledRecurringMinor: number; unbilledUsageMinor: number; depositAppliedMinor: number; depositRefundedMinor: number;
}

/**
 * Terminates a service and closes it out:
 *   - the closing invoice: recurring charges since the last bill (prorated to today), usage not billed yet, and the early-termination charge
 *     when a fixed-term contract is still running. ETC = remaining months x monthly fee (+ the device subsidy not earned back, for plans that
 *     claw it back), with the waiver window, retention/VIP waivers and percentage adjustments applied;
 *   - the number rests in quarantine (Settings → Lifecycle, 90 days by default) unless it was ported to another operator;
 *   - the SIM is released and the HLR/HSS is told to de-provision it;
 *   - the account's deposit is applied and refunded when this was its last service.
 */
export async function terminateService(db: Db, id: string, o: TerminationOptions = {}, actor = 'system'): Promise<TerminationResult> {
  return db.tx(async (q) => {
    const s = await lockService(q, id);
    if (s.status === 'TERMINATED') throw rejected('service is already terminated');
    assertTransition(s.status, 'TERMINATED', o.reason ?? 'termination');
    const cfg = await getLifecycleSettings(q);
    const when = o.date ?? new Date();
    const dayOfEnd = fmt(when);
    await releaseFromGroup(q, actor, id); // a principal with supplementary services must be handed over first
    await q.query(`UPDATE service_suspensions SET ended_on=$2, end_reason='TERMINATED' WHERE service_id=$1 AND ended_on IS NULL`, [id, dayOfEnd]);

    const { quoted, etc, waived, recurringPart, clawbackPart, adjustedBy, lines, unbilledRecurring, usage } = await closingStatement(q, s, o, cfg, actor, when);

    await releaseResourcesOnTermination(q, s, { ported: o.ported, date: dayOfEnd, actor, reason: o.reason ?? 'terminated' }); // the SIM, IMSI and number go back to their pools on their own terms
    await q.query(`UPDATE services SET status='TERMINATED', terminated_at=$2, terminated_reason=$3, suspended_reason=NULL, suspension_kind=NULL, suspend_until=NULL, bar_level='HARD', iccid=NULL, version=version+1, updated_at=now() WHERE id=$1`, [id, when.toISOString(), o.reason ?? 'unspecified']);
    await q.query('UPDATE service_charges SET remaining_cycles = 0 WHERE service_id=$1', [id]); // outstanding instalments fall due in the ETC
    await clawBackService(q, s, o.ported ? 'PORT_OUT' : 'TERMINATION', dayOfEnd, actor); // a customer leaving early takes the seller's commission back, by the plan's policy
    let invoice: Row | null = null;
    const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0]!;
    if (lines.length) {
      const d = today();
      invoice = await issueInvoice(q, acct, { kind: 'FINAL', periodStart: d, periodEnd: d, issueDate: d, lines });
    }

    // Release the number and the SIM
    if (s.type === 'MOBILE') {
      const hold = o.ported ? '9999-12-31' : addDays(dayOfEnd, cfg.termination.quarantineDays);
      await q.query(`INSERT INTO msisdn_quarantine (identifier, service_id, reason, since, release_on) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (identifier) DO UPDATE SET service_id=EXCLUDED.service_id, reason=EXCLUDED.reason, since=EXCLUDED.since, release_on=EXCLUDED.release_on`,
        [s.identifier, id, o.ported ? 'PORTED_OUT' : (o.reason ?? 'TERMINATED'), dayOfEnd, hold]);
    }
    await enqueueOcs(q, 'TERMINATE', id, { termination: { reason: o.reason ?? 'TERMINATED', ported: !!o.ported } });
    const own = await endInstruction(q, s.serviceKind ?? s.type); // the service type names its own systems and instruction
    await queueOutbox(q, { kind: 'NETWORK', instruction: own?.instruction ?? 'DEPROVISION', serviceId: id, accountId: s.accountId, payload: { identifier: s.identifier, iccid: s.iccid ?? null, systems: own?.systems ?? ['HLR', 'HSS', 'PCRF'], ported: !!o.ported, ...(own && s.serviceKind ? { serviceKind: s.serviceKind, reason: o.reason ?? 'terminated' } : {}) } });

    // The deposit
    let applied = 0, refunded = 0;
    if (o.refundDeposit && Number(acct.depositMinor) > 0) {
      const others = (await q.query(`SELECT 1 FROM services WHERE account_id=$1 AND id<>$2 AND status <> 'TERMINATED' LIMIT 1`, [s.accountId, id])).rows.length;
      if (!others) {
        const deposit = Number(acct.depositMinor);
        const owed = invoice ? invoiceBalance(invoice) : 0;
        applied = Math.min(deposit, Math.max(owed, 0)); refunded = deposit - applied;
        const jl = [
          ...(applied ? [{ account: GL.DEPOSITS, debit: applied, description: 'Deposit applied to the closing invoice' }, { account: GL.AR, credit: applied, description: 'Deposit applied to the closing invoice' }] : []),
          ...(refunded ? [{ account: GL.DEPOSITS, debit: refunded, description: 'Deposit refunded' }, { account: GL.CASH, credit: refunded, description: 'Deposit refunded' }] : []),
        ];
        if (refunded) await q.query(`INSERT INTO payments (shard_id, account_id, method, status, amount_minor, currency, reference, idempotency_key) VALUES ($1,$2,'CASH','REFUNDED',$3,$4,'deposit refund',$5)`, [acct.shardId, s.accountId, -refunded, acct.currency, `deposit-refund-${randomUUID()}`]);
        if (jl.length) await postJournal(q, { date: today(), sourceType: 'DEPOSIT', sourceId: String(s.accountId), currency: acct.currency, lines: jl });
        if (applied && invoice) { await q.query('UPDATE invoices SET paid_minor = paid_minor + $2 WHERE id=$1', [invoice.id, applied]); await settle(q, invoice.id as string); invoice = (await q.query('SELECT * FROM invoices WHERE id=$1', [invoice.id])).rows[0]!; }
        await q.query('UPDATE accounts SET deposit_minor = 0 WHERE id=$1', [s.accountId]);
      }
    }

    await logLifecycle(q, { serviceId: id, accountId: s.accountId, action: 'TERMINATE', from: s.status, to: 'TERMINATED', kind: s.suspensionKind ?? null, actor, detail: { reason: o.reason ?? 'unspecified', etcMinor: etc, quotedEtcMinor: quoted, adjustedBy, unbilledRecurringMinor: unbilledRecurring, unbilledUsageMinor: usage, depositApplied: applied, depositRefunded: refunded, releasedIccid: s.iccid ?? null, ported: !!o.ported } });
    await audit(q, actor, 'service', id, 'TERMINATE', { reason: o.reason ?? 'unspecified', etcMinor: etc, waived });
    await queueOutbox(q, { kind: 'NOTIFY', instruction: 'TERMINATION_CONFIRMED', serviceId: id, accountId: s.accountId, payload: { etcMinor: etc, invoice: invoice?.number ?? null } });
    return {
      service: (await q.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!, etcMinor: etc, waived, invoice,
      etc: { quotedMinor: quoted, recurringMinor: recurringPart, clawbackMinor: clawbackPart, adjustedBy },
      unbilledRecurringMinor: unbilledRecurring, unbilledUsageMinor: usage, depositAppliedMinor: applied, depositRefundedMinor: refunded,
    };
  });
}

/** Everything that is owed when a service ends: the early-termination charge (with any waiver or adjustment), what has not been billed yet, and usage not yet billed. It reads and writes nothing, so a preview and the real termination are the same calculation. */
export async function closingStatement(q: Queryable, s: Row, o: TerminationOptions, cfg: Awaited<ReturnType<typeof getLifecycleSettings>>, actor: string, when: Date) {
  const id = s.id as string;
  const dayOfEnd = fmt(when);
  // Early termination charge
  let quoted = 0, waived = false, recurringPart: number | null = null, clawbackPart: number | null = null, adjustedBy: string | null = null;
  if (s.contractTermMonths > 0 && s.contractStart) {
    const quote = await etcQuoteForService(q, s, when);
    quoted = quote.chargeMinor; waived = quote.waived; recurringPart = quote.recurringMinor ?? null; clawbackPart = quote.clawbackMinor ?? null;
  }
  let etc = quoted;
  if (etc > 0) {
    const seg = (await q.query('SELECT segment FROM customers WHERE id=$1', [s.customerId])).rows[0]?.segment as string | undefined;
    if (o.etcAdjust) {
      if (!o.etcAdjust.reason?.trim()) throw invalid('A reason is needed to waive or reduce the early termination charge.');
      const pct = o.etcAdjust.waive ? 0 : o.etcAdjust.percent;
      if (pct === undefined || !Number.isFinite(pct) || pct < 0 || pct > 100) throw invalid('The percentage of the charge to collect is 0 to 100.');
      etc = Math.round((etc * pct) / 100); adjustedBy = `${actor}: ${o.etcAdjust.reason.trim()}`;
    } else if (seg && cfg.termination.waiveEtcSegments.includes(seg)) {
      etc = 0; adjustedBy = `segment ${seg} is exempt from early termination charges`;
    }
    if (etc === 0) waived = true;
  }

  // Closing invoice: what has not been billed yet, then the ETC
  const lines: DraftLine[] = [];
  let unbilledRecurring = 0;
  if (s.activatedAt) {
    const lastEnd = (await q.query(`SELECT max(period_end)::text AS d FROM invoices WHERE account_id=$1 AND kind='CYCLE'`, [s.accountId])).rows[0]?.d as string | null;
    const activated = fmt(new Date(s.activatedAt));
    const from = lastEnd && addDays(lastEnd, 1) > activated ? addDays(lastEnd, 1) : activated;
    if (dayOfEnd >= from) {
      const offerRow = (await q.query('SELECT name, data FROM catalog_nodes WHERE id=$1', [s.offerId])).rows[0];
      const fee = offerRow ? monthlyFee({ id: s.offerId, name: offerRow.name, ...offerRow.data } as never) : null;
      if (fee) {
        const days = diffDays(dayOfEnd, from) + 1;
        const off = (await voluntarySuspendedDays(q, { serviceId: id }, from, dayOfEnd)).get(id) ?? 0;
        const monthly = fee.amount.amountMinor / (fee.periodMonths ?? 1);
        unbilledRecurring = Math.min(Math.round(monthly), Math.round((monthly * Math.max(0, days - off)) / 30));
        if (unbilledRecurring > 0) lines.push({ serviceId: id, kind: 'RECURRING', stream: offerRow?.data?.partnerCode ? 'THIRD_PARTY' : 'SUBSCRIPTION', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: fee.taxInclusive, description: `${offerRow!.name} ${s.identifier} until termination (${from} to ${dayOfEnd})`, amountMinor: unbilledRecurring });
      }
    }
  }
  const usage = o.unbilledUsageMinor ?? 0;
  if (usage < 0 || !Number.isInteger(usage)) throw invalid('unbilledUsageMinor is a whole amount, zero or more');
  if (usage > 0) lines.push({ serviceId: id, kind: 'ADJUSTMENT', stream: 'USAGE', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: false, description: `Usage not yet billed ${s.identifier}`, amountMinor: usage });
  if (etc > 0) lines.push({ serviceId: id, kind: 'ETC', stream: 'ETC', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: false, description: `Early termination charge ${s.identifier} (${s.contractTermMonths}-month contract)`, amountMinor: etc });
  return { quoted, etc, waived, recurringPart, clawbackPart, adjustedBy, lines, unbilledRecurring, usage };
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

/**
 * The national clearinghouse confirmed the number has moved. The service ends at once on this network: final bill (recurring until today,
 * usage not billed yet, early termination charge), deposit refund if this was the account's last service, and the SIM and network resources
 * released. The number is not recycled: it now belongs to the other operator. Safe to call again for the same confirmation.
 */
export async function completePortOut(db: Db, id: string, actor = 'system', o: { reference?: string; unbilledUsageMinor?: number; etcAdjust?: TerminationOptions['etcAdjust'] } = {}) {
  const s = (await db.query('SELECT * FROM services WHERE id=$1', [id])).rows[0];
  if (!s) throw notFound('service', id);
  if (s.status === 'TERMINATED' && s.terminatedReason === 'PORTED_OUT') return { alreadyDone: true, service: s };
  if (s.status !== 'PORTING_OUT') throw rejected(`service is ${s.status}, not PORTING_OUT`);
  const r = await terminateService(db, id, { reason: 'PORTED_OUT', ported: true, refundDeposit: true, unbilledUsageMinor: o.unbilledUsageMinor, etcAdjust: o.etcAdjust }, actor);
  await db.query(`UPDATE cases SET status='RESOLVED', notes = notes || $2::jsonb, updated_at=now() WHERE service_id=$1 AND type='MNP_PORT_OUT' AND status IN ('OPEN','IN_PROGRESS')`,
    [id, JSON.stringify([{ at: new Date().toISOString(), by: actor, text: `Port-out confirmed${o.reference ? ` (clearinghouse ref ${o.reference})` : ''}. Service terminated, closing invoice ${r.invoice?.number ?? 'none (nothing owed)'}.` }])]);
  return { alreadyDone: false, ...r };
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

export async function listServices(q: Queryable, f: { customerId?: string; accountId?: string; status?: string; q?: string; limit?: number; cursor?: string; /** only live services that are not in a group yet (what a group can still take) */ groupable?: boolean }): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.customerId) where.push(`s.customer_id = ${p(f.customerId)}`);
  if (f.accountId) where.push(`s.account_id = ${p(f.accountId)}`);
  if (f.status) where.push(`s.status = ${p(f.status)}`);
  if (f.groupable) where.push(`s.status IN ('PENDING','ACTIVE','SUSPENDED')`, `m.service_id IS NULL`);
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
    `SELECT s.*, c.name AS offer_name, m.group_id, m.role AS group_role FROM services s LEFT JOIN catalog_nodes c ON c.id = s.offer_id LEFT JOIN service_group_members m ON m.service_id = s.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.identifier, s.id LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.identifier as string, r.id as string]);
}

export { invoiceBalance };

/** Ends the services that have reached their end date (a pass that was valid for a number of days). Each is terminated as for any customer-requested end: no early-termination charge applies to a service that ran its course. */
export async function expireServices(db: Db, asOf: Date = new Date()): Promise<{ expired: number }> {
  const due = (await db.query(`SELECT id FROM services WHERE expires_at IS NOT NULL AND expires_at <= $1 AND status = 'ACTIVE' ORDER BY expires_at LIMIT 5000`, [asOf.toISOString()])).rows;
  let expired = 0;
  for (const s of due) {
    try { await terminateService(db, s.id, { reason: 'EXPIRED', date: asOf }, 'expiry-job'); expired++; } catch { /* a service already ended by someone else in the meantime */ }
  }
  return { expired };
}
