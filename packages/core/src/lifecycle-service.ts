import { audit } from './audit.js';
import { invoiceBalance, runBillCycle } from './billing.js';
import { GL } from './config.js';
import type { Db, Queryable, Row } from './db.js';
import { diffDays, toDate, today, type DateStr } from './dates.js';
import { invalid, notFound, rejected } from './errors.js';
import { getLifecycleSettings, type DunningAction, type LifecycleSettings } from './lifecycle-config.js';
import { autoResumeDue, completePortOut, etcQuoteForService, resumeService, suspendService, suspendVoluntary, terminateService, type LifecycleChannel, type TerminationOptions, type VoluntaryRequest } from './lifecycle.js';
import { liftCreditRestrictions, logLifecycle, queueOutbox, restrictionOf, setBarLevel } from './lifecycle-state.js';
import { postJournal } from './ledger.js';

// ───────────────────────── B. credit limit and threshold breach ─────────────────────────
export interface CreditEvaluation {
  accountId: string; limitMinor: number | null; unbilledUsageMinor: number; percent: number | null;
  state: 'OK' | 'WARNED' | 'BLOCKED'; before: 'OK' | 'WARNED' | 'BLOCKED';
  actions: { warned: boolean; barred: number; lifted: number };
}

/**
 * Compares unbilled usage (from the charging system, in real time or from the daily rating) with the account's credit limit.
 * At the warning threshold (80%) the customer is told; at the block threshold (100%) every unrestricted service gets a soft bar (outgoing
 * calls/SMS and data blocked, incoming allowed) or a data throttle, sent at once to the policy system. The restriction lifts when usage falls
 * back under the threshold, the limit is raised, or the next bill resets the usage. Calling it again with the same usage does nothing.
 */
export async function evaluateCreditLimit(db: Db, accountId: string, input: { unbilledUsageMinor: number; actor?: string }): Promise<CreditEvaluation> {
  if (!Number.isInteger(input.unbilledUsageMinor) || input.unbilledUsageMinor < 0) throw invalid('unbilledUsageMinor is a whole amount, zero or more');
  const actor = input.actor ?? 'ocs';
  return db.tx(async (q) => {
    const cfg = await getLifecycleSettings(q);
    const a = (await q.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!a) throw notFound('account', accountId);
    const limit = a.creditLimitMinor === null || a.creditLimitMinor === undefined ? cfg.credit.defaultLimitMinor : Number(a.creditLimitMinor);
    const before = a.creditState as CreditEvaluation['before'];
    const usage = input.unbilledUsageMinor;
    if (!limit || limit <= 0) return { accountId, limitMinor: null, unbilledUsageMinor: usage, percent: null, state: 'OK', before, actions: { warned: false, barred: 0, lifted: 0 } } as CreditEvaluation;
    const percent = (usage * 100) / limit;
    const state: CreditEvaluation['state'] = percent >= cfg.credit.blockPercent ? 'BLOCKED' : percent >= cfg.credit.warnPercent ? 'WARNED' : 'OK';
    const out: CreditEvaluation = { accountId, limitMinor: limit, unbilledUsageMinor: usage, percent: Math.round(percent * 10) / 10, state, before, actions: { warned: false, barred: 0, lifted: 0 } };
    if (state === before) return out;
    if (state === 'WARNED' && before === 'OK') {
      out.actions.warned = true;
      await queueOutbox(q, { kind: 'NOTIFY', instruction: 'CREDIT_WARNING', accountId, payload: { percent: out.percent, limitMinor: limit, usageMinor: usage } });
    }
    if (state === 'BLOCKED') {
      const level = cfg.credit.blockAction === 'THROTTLE' ? 'THROTTLE' : 'SOFT';
      const rows = (await q.query(`SELECT * FROM services WHERE account_id=$1 AND status='ACTIVE' AND bar_level='NONE' AND suspension_kind IS NULL FOR UPDATE`, [accountId])).rows;
      for (const s of rows) {
        await q.query(`UPDATE services SET suspension_kind='CREDIT', suspended_reason='CREDIT', suspended_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [s.id]);
        await setBarLevel(q, s, level, { kind: 'CREDIT', actor });
        await logLifecycle(q, { serviceId: s.id, accountId, action: 'BAR', from: 'ACTIVE', to: 'ACTIVE', kind: 'CREDIT', actor, detail: { bar: level, percent: out.percent, limitMinor: limit } });
      }
      out.actions.barred = rows.length;
      await queueOutbox(q, { kind: 'NOTIFY', instruction: 'CREDIT_LIMIT_REACHED', accountId, payload: { percent: out.percent, bar: level } });
    }
    if (before === 'BLOCKED' && state !== 'BLOCKED') out.actions.lifted = await liftCreditRestrictions(q, accountId, actor);
    await q.query('UPDATE accounts SET credit_state=$2 WHERE id=$1', [accountId, state]);
    await audit(q, actor, 'account', accountId, `CREDIT_${state}`, { percent: out.percent, limit, usage });
    return out;
  });
}

// ───────────────────────── C. dunning ─────────────────────────
export interface DunningStepResult { accountId: string; step: DunningAction; day: number; outcome: Record<string, unknown> }
export interface DunningResult {
  asOf: DateStr; markedOverdue: number; evaluated: number; applied: DunningStepResult[];
  /** Accounts whose services were hard-barred / terminated in this run. */
  suspendedAccounts: number; terminatedAccounts: number; flaggedForReview: number;
}

const BAR_RANK: Partial<Record<DunningAction, number>> = { SOFT_BAR: 1, HARD_BAR: 2, TERMINATE: 3 };

/** The unpaid, past-due invoices of an account as of a date, and when the oldest was due (D). */
async function overdueOf(q: Queryable, accountId: string, asOf: DateStr): Promise<{ invoices: Row[]; anchor: DateStr | null; balanceMinor: number }> {
  const invoices = (await q.query(
    `SELECT * FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE') AND due_date < $2::date AND total_minor - paid_minor - credited_minor > 0 ORDER BY due_date`, [accountId, asOf])).rows;
  const anchor = invoices[0] ? String(invoices[0].dueDate).slice(0, 10) : null;
  return { invoices, anchor, balanceMinor: invoices.reduce((s, i) => s + invoiceBalance(i), 0) };
}

/**
 * Walks an account along the dunning ladder for a date: D+1 reminder, D+7 soft bar, D+14 hard bar, D+30 final notice, D+45 termination (the
 * days and steps are configurable in Settings → Lifecycle). D is the due date of the oldest unpaid invoice. Each step is applied once; if the
 * job missed days, the steps in between are caught up (only the harshest due bar is applied, and an earlier notice is skipped when a later one is
 * due). Paying everything overdue lifts the bars and ends the ladder (see `restoreAfterPayment`). Safe to call repeatedly.
 */
export async function evaluateDunningLadder(db: Db, accountId: string, asOf: DateStr = today(), o: { only?: DunningAction; actor?: string } = {}): Promise<DunningStepResult[]> {
  const actor = o.actor ?? 'dunning';
  const cfg = await getLifecycleSettings(db);
  const od = await db.tx(async (q) => {
    await q.query(`UPDATE invoices SET status='OVERDUE' WHERE account_id=$1 AND status='ISSUED' AND due_date < $2::date AND total_minor - paid_minor - credited_minor > 0`, [accountId, asOf]);
    return overdueOf(q, accountId, asOf);
  });
  if (!od.anchor) return [];
  // Nothing left to bar or terminate (the ladder already ended, or the services were closed another way): the debt is for collections now.
  if (!(await db.query(`SELECT 1 FROM services WHERE account_id=$1 AND status <> 'TERMINATED' LIMIT 1`, [accountId])).rows.length) return [];
  const days = diffDays(asOf, od.anchor);
  const run = await db.tx(async (q) => {
    await q.query(`INSERT INTO dunning_runs (account_id, anchor_due) VALUES ($1,$2) ON CONFLICT (account_id) WHERE status = 'ACTIVE' DO NOTHING`, [accountId, od.anchor]);
    return (await q.query(`SELECT * FROM dunning_runs WHERE account_id=$1 AND status='ACTIVE'`, [accountId])).rows[0]!;
  });
  const done = new Set((await db.query('SELECT step FROM dunning_steps WHERE run_id=$1', [run.id])).rows.map((r) => r.step as string));
  let due = cfg.dunning.filter((s) => s.day <= days && !done.has(s.action) && (!o.only || s.action === o.only));
  if (!due.length) return [];
  const topBar = Math.max(0, ...due.map((s) => BAR_RANK[s.action] ?? 0));
  const lastNotice = (a: DunningAction) => due.filter((s) => s.action === a).at(-1);
  const results: DunningStepResult[] = [];
  for (const step of due) {
    const rank = BAR_RANK[step.action] ?? 0;
    const superseded = (rank > 0 && rank < topBar) || ((step.action === 'REMIND' || step.action === 'FINAL_NOTICE') && lastNotice(step.action) !== step && topBar > 0 && false);
    const outcome = superseded ? { skipped: 'a harsher step was due at the same time' } : await applyStep(db, accountId, run.id as number, step.action, od, asOf, actor, cfg);
    await db.query(`INSERT INTO dunning_steps (run_id, step, day_offset, applied_on, outcome) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (run_id, step) DO NOTHING`, [run.id, step.action, step.day, asOf, JSON.stringify(outcome)]);
    await db.query('UPDATE dunning_runs SET last_step=$2 WHERE id=$1', [run.id, step.action]);
    results.push({ accountId, step: step.action, day: step.day, outcome });
    if (step.action === 'TERMINATE' && !superseded) break;
  }
  due = [];
  return results;
}

async function applyStep(db: Db, accountId: string, runId: number, action: DunningAction, od: { invoices: Row[]; balanceMinor: number }, asOf: DateStr, actor: string, cfg: LifecycleSettings): Promise<Record<string, unknown>> {
  const invoices = od.invoices.map((i) => i.number as string);
  switch (action) {
    case 'REMIND':
      return db.tx(async (q) => {
        await queueOutbox(q, { kind: 'NOTIFY', instruction: 'PAYMENT_REMINDER', accountId, payload: { invoices, balanceMinor: od.balanceMinor, channels: ['SMS', 'EMAIL'] } });
        await q.query('UPDATE accounts SET dunning_stage = GREATEST(dunning_stage, 1) WHERE id=$1', [accountId]);
        await audit(q, actor, 'account', accountId, 'DUNNING_REMIND', { balanceMinor: od.balanceMinor });
        return { notified: true, balanceMinor: od.balanceMinor };
      });
    case 'SOFT_BAR':
      return db.tx(async (q) => {
        // Outgoing calls and data blocked, incoming calls/SMS allowed. The service stays ACTIVE.
        const rows = (await q.query(`SELECT * FROM services WHERE account_id=$1 AND status='ACTIVE' AND bar_level IN ('NONE','THROTTLE') FOR UPDATE`, [accountId])).rows;
        for (const s of rows) {
          await q.query(`UPDATE services SET suspension_kind='DUNNING', suspended_reason='DUNNING', suspended_at=COALESCE(suspended_at, now()), version=version+1, updated_at=now() WHERE id=$1`, [s.id]);
          await setBarLevel(q, s, 'SOFT', { kind: 'DUNNING', actor });
          await logLifecycle(q, { serviceId: s.id, accountId, action: 'BAR', from: 'ACTIVE', to: 'ACTIVE', kind: 'DUNNING', actor, detail: { bar: 'SOFT', runId } });
        }
        await q.query('UPDATE accounts SET dunning_stage = GREATEST(dunning_stage, 2) WHERE id=$1', [accountId]);
        await queueOutbox(q, { kind: 'NOTIFY', instruction: 'SERVICE_SOFT_BARRED', accountId, payload: { balanceMinor: od.balanceMinor } });
        return { barred: rows.length, level: 'SOFT' };
      });
    case 'HARD_BAR':
      return db.tx(async (q) => {
        // Everything blocked except emergency calls. A customer's voluntary suspension gives way to the bar.
        const rows = (await q.query(`SELECT * FROM services WHERE account_id=$1 AND status IN ('ACTIVE','SUSPENDED') AND COALESCE(suspension_kind,'DUNNING') IN ('DUNNING','CREDIT','VOLUNTARY') AND bar_level <> 'HARD' OR (account_id=$1 AND status='SUSPENDED' AND suspension_kind='VOLUNTARY') FOR UPDATE`, [accountId])).rows;
        for (const s of rows) {
          if (s.suspensionKind === 'VOLUNTARY') await q.query(`UPDATE service_suspensions SET ended_on=$2, end_reason='CONVERTED_TO_DUNNING' WHERE service_id=$1 AND ended_on IS NULL`, [s.id, asOf]);
          await q.query(`UPDATE services SET status='SUSPENDED', suspension_kind='DUNNING', suspended_reason='DUNNING', suspended_at=COALESCE(suspended_at, now()), suspend_until=NULL, version=version+1, updated_at=now() WHERE id=$1`, [s.id]);
          await setBarLevel(q, s, 'HARD', { kind: 'DUNNING', actor });
          await logLifecycle(q, { serviceId: s.id, accountId, action: 'SUSPEND', from: s.status, to: 'SUSPENDED', kind: 'DUNNING', actor, detail: { bar: 'HARD', runId, emergencyCalls: 'ALLOWED' } });
        }
        await q.query('UPDATE accounts SET dunning_stage = GREATEST(dunning_stage, 3) WHERE id=$1', [accountId]);
        await queueOutbox(q, { kind: 'NOTIFY', instruction: 'SERVICE_HARD_BARRED', accountId, payload: { balanceMinor: od.balanceMinor } });
        return { suspended: rows.length, level: 'HARD' };
      });
    case 'FINAL_NOTICE':
      return db.tx(async (q) => {
        // What termination will cost: the overdue balance plus any early-termination charge on the contracts still running.
        let etc = 0;
        for (const s of (await q.query(`SELECT * FROM services WHERE account_id=$1 AND status <> 'TERMINATED' AND contract_term_months > 0 AND contract_start IS NOT NULL`, [accountId])).rows) etc += (await etcQuoteForService(q, s, new Date(asOf))).chargeMinor;
        const terminateOn = cfg.dunning.find((s) => s.action === 'TERMINATE');
        await q.query('UPDATE accounts SET dunning_stage = GREATEST(dunning_stage, 4) WHERE id=$1', [accountId]);
        await queueOutbox(q, { kind: 'NOTIFY', instruction: 'FINAL_NOTICE', accountId, payload: { invoices, balanceMinor: od.balanceMinor, estimatedEtcMinor: etc, terminationInDays: terminateOn ? Math.max(0, terminateOn.day - diffDays(asOf, String(od.invoices[0]!.dueDate).slice(0, 10))) : null } });
        await audit(q, actor, 'account', accountId, 'DUNNING_FINAL_NOTICE', { balanceMinor: od.balanceMinor, estimatedEtcMinor: etc });
        return { notified: true, balanceMinor: od.balanceMinor, estimatedEtcMinor: etc };
      });
    case 'TERMINATE': {
      const live = (await db.query(`SELECT id FROM services WHERE account_id=$1 AND status <> 'TERMINATED' ORDER BY identifier`, [accountId])).rows;
      let etcMinor = 0, terminated = 0;
      for (const s of live) { const r = await terminateService(db, s.id as string, { reason: 'DUNNING', date: toDate(asOf) }, actor); etcMinor += r.etcMinor; terminated++; }
      const debt = await db.tx((q) => handOverDebt(q, accountId, cfg, actor, asOf));
      await db.query(`UPDATE dunning_runs SET status='TERMINATED', ended_at=now() WHERE id=$1`, [runId]);
      await db.query('UPDATE accounts SET dunning_stage = 5 WHERE id=$1', [accountId]);
      return { terminated, etcMinor, ...debt };
    }
  }
}

/** After a forced termination the debt (overdue invoices and the closing invoices) goes to collections or is written off to the ledger. */
async function handOverDebt(q: Queryable, accountId: string, cfg: LifecycleSettings, actor: string, asOf: DateStr): Promise<Record<string, unknown>> {
  const open = (await q.query(`SELECT * FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE') AND total_minor - paid_minor - credited_minor > 0 FOR UPDATE`, [accountId])).rows;
  const total = open.reduce((s, i) => s + invoiceBalance(i), 0);
  if (!open.length) return { debt: 'NONE', balanceMinor: 0 };
  const acct = (await q.query('SELECT currency FROM accounts WHERE id=$1', [accountId])).rows[0]!;
  if (cfg.termination.debtAction === 'WRITE_OFF') {
    for (const i of open) {
      const bal = invoiceBalance(i);
      await postJournal(q, { date: asOf, sourceType: 'WRITE_OFF', sourceId: i.id as string, currency: acct.currency, lines: [
        { account: GL.BAD_DEBT, debit: bal, description: `Written off ${i.number} (terminated for non-payment)` },
        { account: GL.AR, credit: bal, description: `Written off ${i.number}` },
      ] });
      await q.query(`UPDATE invoices SET status='WRITTEN_OFF' WHERE id=$1`, [i.id]);
    }
    await queueOutbox(q, { kind: 'GL', instruction: 'WRITE_OFF', accountId, payload: { balanceMinor: total, invoices: open.map((i) => i.number) } });
    await audit(q, actor, 'account', accountId, 'DEBT_WRITTEN_OFF', { balanceMinor: total });
    return { debt: 'WRITTEN_OFF', balanceMinor: total };
  }
  await q.query(`UPDATE invoices SET collections_at = now() WHERE id = ANY($1::uuid[])`, [open.map((i) => i.id)]);
  await queueOutbox(q, { kind: 'COLLECTIONS', instruction: 'HAND_OVER', accountId, payload: { balanceMinor: total, invoices: open.map((i) => i.number) } });
  await audit(q, actor, 'account', accountId, 'DEBT_TO_COLLECTIONS', { balanceMinor: total });
  return { debt: 'COLLECTIONS', balanceMinor: total };
}

/** Daily dunning: marks invoices overdue, then walks every account with something overdue along its ladder. */
export async function runDunning(db: Db, asOf: DateStr = today()): Promise<DunningResult> {
  const out: DunningResult = { asOf, markedOverdue: 0, evaluated: 0, applied: [], suspendedAccounts: 0, terminatedAccounts: 0, flaggedForReview: 0 };
  const marked = await db.query(`UPDATE invoices SET status='OVERDUE' WHERE status='ISSUED' AND due_date < $1::date AND total_minor - paid_minor - credited_minor > 0`, [asOf]);
  out.markedOverdue = marked.rowCount;
  const accounts = (await db.query(`SELECT DISTINCT account_id FROM invoices WHERE status='OVERDUE' AND due_date < $1::date AND total_minor - paid_minor - credited_minor > 0 ORDER BY account_id LIMIT 5000`, [asOf])).rows;
  for (const a of accounts) {
    out.evaluated++;
    try {
      const steps = await evaluateDunningLadder(db, a.accountId as string, asOf);
      out.applied.push(...steps);
      if (steps.some((s) => s.step === 'HARD_BAR' || s.step === 'TERMINATE') && !steps.some((s) => s.outcome.skipped)) out.suspendedAccounts++;
      if (steps.some((s) => s.step === 'TERMINATE')) { out.terminatedAccounts++; out.flaggedForReview++; }
    } catch (e) {
      out.applied.push({ accountId: a.accountId as string, step: 'REMIND', day: -1, outcome: { error: (e as Error).message } });
    }
  }
  return out;
}

// ───────────────────────── the service ─────────────────────────
export type SuspendRequest =
  | ({ kind: 'VOLUNTARY' } & VoluntaryRequest)
  | { kind?: 'ADMIN' | 'FRAUD' | 'CREDIT' | 'DUNNING'; reason?: string };

/**
 * One place for everything that changes the state of a service. The rules live in the functions it calls; this class is the seam the API,
 * the jobs and the Temporal activities share.
 */
export class LifecycleService {
  constructor(private readonly db: Db) {}

  /** A customer's own request (VOLUNTARY, capped, number and SIM kept) or an operator's restriction (fraud, administrative). */
  suspendService(serviceId: string, req: SuspendRequest, actor: string, channel: LifecycleChannel = 'STAFF') {
    if (req.kind === 'VOLUNTARY') return suspendVoluntary(this.db, serviceId, { months: req.months, until: req.until, channel: req.channel ?? channel }, actor);
    return suspendService(this.db, serviceId, req.reason ?? req.kind ?? 'ADMIN', actor, { kind: req.kind ?? 'ADMIN' });
  }

  /** Lifts a suspension. Who may depends on why it was imposed (see `resumeService`). */
  resumeService(serviceId: string, actor: string, channel: LifecycleChannel = 'STAFF') {
    return resumeService(this.db, serviceId, actor, { channel });
  }

  /** The dunning ladder for one account, or for every account with an overdue balance. */
  async evaluateDunningLadder(accountId?: string, asOf: DateStr = today()): Promise<DunningResult | DunningStepResult[]> {
    return accountId ? evaluateDunningLadder(this.db, accountId, asOf) : runDunning(this.db, asOf);
  }

  /** Ends a service, with the closing invoice, ETC (with retention/VIP adjustments), number quarantine and de-provisioning. */
  terminateService(serviceId: string, o: TerminationOptions, actor: string) {
    return terminateService(this.db, serviceId, o, actor);
  }

  evaluateCreditLimit(accountId: string, unbilledUsageMinor: number, actor = 'ocs') {
    return evaluateCreditLimit(this.db, accountId, { unbilledUsageMinor, actor });
  }

  /**
   * The national clearinghouse confirmed a port-out. Finds the service by its number or id, ends it and sends the closing invoice.
   * Calling it again for a number already ported is a no-op, so the clearinghouse can retry.
   */
  async confirmPortOut(ref: { serviceId?: string; identifier?: string; reference?: string; unbilledUsageMinor?: number }, actor = 'clearinghouse') {
    let id = ref.serviceId;
    if (!id) {
      if (!ref.identifier) throw invalid('Give the service id or the number that ported out.');
      const r = (await this.db.query(`SELECT id FROM services WHERE identifier=$1 AND type='MOBILE' ORDER BY (status='TERMINATED'), updated_at DESC LIMIT 1`, [ref.identifier])).rows[0];
      if (!r) throw notFound('service', ref.identifier);
      id = r.id as string;
    }
    return completePortOut(this.db, id, actor, { reference: ref.reference, unbilledUsageMinor: ref.unbilledUsageMinor });
  }

  /** What the daily job does: resume suspensions that have ended, then dunning. (The bill run is separate.) */
  async runDailyJobs(asOf: DateStr = today()) {
    const resumed = await autoResumeDue(this.db, asOf);
    const dunning = await runDunning(this.db, asOf);
    const released = await releaseQuarantinedNumbers(this.db, asOf);
    return { asOf, resumed, dunning, releasedNumbers: released };
  }

  async history(serviceId: string, limit = 100) {
    return (await this.db.query(`SELECT id::text, at, action, from_status, to_status, kind, actor, detail FROM service_lifecycle_events WHERE service_id=$1 ORDER BY id DESC LIMIT $2`, [serviceId, Math.min(limit, 500)])).rows;
  }
}

/** Numbers whose rest has ended become available again: their entry leaves the quarantine and the registry. */
export async function releaseQuarantinedNumbers(db: Db, asOf: DateStr = today()): Promise<number> {
  return db.tx(async (q) => {
    const rows = (await q.query(`DELETE FROM msisdn_quarantine WHERE release_on <= $1::date RETURNING identifier`, [asOf])).rows;
    if (rows.length) await q.query(`DELETE FROM identifier_registry WHERE type='MOBILE' AND identifier = ANY($1::text[])`, [rows.map((r) => r.identifier)]);
    return rows.length;
  });
}

