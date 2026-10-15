import { currencyInfo } from '@meridian/types';
import { audit } from './audit.js';
import { invoiceBalance, issueInvoice } from './billing.js';
import { arrangementStatus, placeWithAgency } from './collections.js';
import { ACTIVE_STATUSES, createCase } from './cases.js';
import { diffDays, addDays, type DateStr } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid } from './errors.js';
import { buildEmvQr, QR_SCHEMES, QR_SCHEME_LABEL, qrMerchantProblem, type QrMerchant, type QrScheme } from './emv-qr.js';
import { dunningBarRank, dunningContextOf, getLateFee, lateFeeAmount, listDunningRules, pickDunningRule, DUNNING_STEP_ACTIONS, type DunningContext, type DunningRule, type DunningRuleStep, type DunningStepAction } from './dunning-rules.js';
import { renderDunningText, DUNNING_TEMPLATES } from './dunning-templates.js';
import { applyStep, overdueOf } from './lifecycle-service.js';
import { getLifecycleSettings } from './lifecycle-config.js';
import { etcQuoteForService } from './lifecycle.js';
import { queueOutbox, setBarLevel, logLifecycle } from './lifecycle-state.js';
import { getBranding } from './settings.js';

/**
 * The rule-driven dunning engine. For an overdue account it picks the rule that fits the customer, takes a copy of the rule's ladder for the run (so editing a rule
 * never reshuffles accounts already being dunned), and applies what is due: each step once, in order. A step is *held* (and looked at again next time) when a billing
 * dispute is open, the customer is a VIP, a payment arrangement is being kept, or an account manager's task is still open; it is *superseded* when a harsher bar is
 * due at the same time. A partial payment may reset the ladder to a soft bar or pause it. Everything done or held back is logged against the step.
 */
export interface DunningPaymentSettings { baseUrl: string; merchants: Partial<Record<QrScheme, QrMerchant>>; bureau: string }
const DEFAULT_PAYMENTS: DunningPaymentSettings = { baseUrl: '', merchants: {}, bureau: '' };

export async function getDunningPayments(q: Queryable): Promise<DunningPaymentSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='dunningPayments'`)).rows[0]?.value as Partial<DunningPaymentSettings> | undefined;
  return { ...DEFAULT_PAYMENTS, ...(v ?? {}), merchants: v?.merchants ?? {} };
}
export async function setDunningPayments(q: Queryable, actor: string, i: Partial<DunningPaymentSettings>): Promise<DunningPaymentSettings> {
  const cur = await getDunningPayments(q);
  const next: DunningPaymentSettings = { baseUrl: (i.baseUrl ?? cur.baseUrl).trim().replace(/\/+$/, ''), merchants: { ...cur.merchants, ...(i.merchants ?? {}) }, bureau: (i.bureau ?? cur.bureau).trim().slice(0, 80) };
  if (next.baseUrl) { let u: URL; try { u = new URL(next.baseUrl); } catch { throw invalid('The pay page address must be a web address.'); } if (u.protocol !== 'https:' && !(u.hostname === 'localhost' && process.env.NODE_ENV !== 'production')) throw invalid('The pay page address must start with https://.'); }
  for (const [k, m] of Object.entries(next.merchants)) {
    if (!(QR_SCHEMES as readonly string[]).includes(k)) throw invalid(`Unknown QR scheme ${k}.`);
    const bad = m ? qrMerchantProblem(k as QrScheme, m) : null;
    if (bad) throw invalid(`${QR_SCHEME_LABEL[k as QrScheme]}: ${bad}`);
  }
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('dunningPayments', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'dunningPayments', 'update', { schemes: Object.keys(next.merchants) });
  return next;
}

export const money = (minor: number, currency: string) => { const e = currencyInfo(currency)?.exponent ?? 2; return `${currency} ${(minor / 10 ** e).toLocaleString('en-US', { minimumFractionDigits: e, maximumFractionDigits: e })}`; };

export interface LadderSnapshot { code: string; name: string; version: number; partial: DunningRule['partial']; steps: DunningRuleStep[] }
export interface RuleStepResult { accountId: string; stepId: string; name: string; action: DunningStepAction; day: number; status: 'APPLIED' | 'SUPERSEDED' | 'HELD' | 'FAILED'; reason?: string; outcome: Record<string, unknown> }

// ───────────────────────── when a step is due, and when it is held ─────────────────────────
export function stepDue(s: DunningRuleStep, days: number, balanceMinor: number): boolean {
  return s.trigger.kind === 'DAYS_PAST_DUE' ? days >= s.trigger.days : balanceMinor >= s.trigger.balanceMinor && days >= s.trigger.minDays;
}
/** The date a days-based step falls due, for a ladder anchored on `anchor`. */
export const stepDate = (s: DunningRuleStep, anchor: DateStr): DateStr | null => (s.trigger.kind === 'DAYS_PAST_DUE' ? addDays(anchor, s.trigger.days) : null);

/** An open billing dispute: a customer case in the billing-dispute category that is still being worked. */
export async function openDispute(q: Queryable, customerId: string): Promise<{ number: string } | null> {
  const r = (await q.query(`SELECT k.number FROM cases k JOIN case_taxonomy t ON t.id = k.issue_type_id WHERE k.customer_id=$1 AND k.status = ANY($2::text[]) AND (t.id LIKE 'billing.dispute.%') ORDER BY k.created_at DESC LIMIT 1`, [customerId, ACTIVE_STATUSES])).rows[0];
  return r ? { number: r.number } : null;
}

async function holdReason(q: Queryable, ctx: DunningContext, run: Row, s: DunningRuleStep, ladder: LadderSnapshot, logs: Map<string, Row>, asOf: DateStr, memo: { dispute?: { number: string } | null; arrangement?: boolean }): Promise<string | null> {
  const ex = s.exclusions;
  if (ex.vip && ctx.vip) return 'VIP protection';
  if (ex.dispute) { memo.dispute ??= await openDispute(q, ctx.customerId); if (memo.dispute) return `Open billing dispute (${memo.dispute.number})`; }
  if (ex.arrangement) { memo.arrangement ??= (await arrangementStatus(q, ctx.accountId, asOf)).kept; if (memo.arrangement) return 'A payment arrangement is being kept'; }
  // An account manager's task comes first: later bars and terminations wait for it, for a while.
  if (dunningBarRank(s.action) > 0 || s.action === 'COLLECTIONS_TRANSFER') {
    for (const t of ladder.steps) {
      if (t.action !== 'CASE_TASK' || !t.params.holdsLaterBars || t.position >= s.position) continue;
      const log = logs.get(t.id);
      const caseId = (log?.outcome as { caseId?: string } | undefined)?.caseId;
      if (log?.status !== 'APPLIED' || !caseId) continue;
      const k = (await q.query('SELECT number, status, created_at FROM cases WHERE id=$1', [caseId])).rows[0];
      if (!k || !ACTIVE_STATUSES.includes(k.status)) continue;
      const waitUntil = new Date(k.createdAt).getTime() + (t.params.waitDays ?? 7) * 86_400_000;
      if (Date.parse(asOf) < waitUntil) return `Waiting for the account manager (${k.number})`;
    }
  }
  return null;
}

// ───────────────────────── looking at an account ─────────────────────────
export interface LadderView {
  rule: { id?: string; code: string; name: string; version: number } | null; anchor: DateStr | null; daysPastDue: number; balanceMinor: number; pausedUntil: string | null; legacy: boolean;
  steps: Array<{ id: string; name: string; action: DunningStepAction; state: 'DONE' | 'SUPERSEDED' | 'DUE' | 'HELD' | 'LATER'; dueOn: string | null; reason?: string }>;
}
/** What the ladder looks like for an account today, without doing anything: which step is next, which are held and why. */
export async function explainLadder(q: Queryable, accountId: string, asOf: DateStr, rules?: DunningRule[]): Promise<LadderView> {
  const od = await overdueOf(q, accountId, asOf);
  const ctx = await dunningContextOf(q, accountId);
  const run = (await q.query(`SELECT * FROM dunning_runs WHERE account_id=$1 AND status='ACTIVE'`, [accountId])).rows[0];
  const snap: LadderSnapshot | null = run?.ladder ?? (() => { const r = pickDunningRule(rules ?? [], ctx); return r ? { code: r.code, name: r.name, version: r.version, partial: r.partial, steps: r.steps.filter((s) => s.enabled) } : null; })();
  if (!snap) return { rule: null, anchor: od.anchor, daysPastDue: od.anchor ? diffDays(asOf, od.anchor) : 0, balanceMinor: od.balanceMinor, pausedUntil: null, legacy: true, steps: [] };
  const days = od.anchor ? diffDays(asOf, od.anchor) : 0;
  const logs = new Map<string, Row>(run ? (await q.query('SELECT * FROM dunning_steps WHERE run_id=$1', [run.id])).rows.map((r) => [r.stepKey as string, r]) : []);
  const memo = {};
  const steps: LadderView['steps'] = [];
  for (const s of snap.steps) {
    const log = logs.get(s.id);
    let state: LadderView['steps'][number]['state'] = 'LATER', reason: string | undefined;
    if (log?.status === 'APPLIED') state = 'DONE';
    else if (log?.status === 'SUPERSEDED') state = 'SUPERSEDED';
    else if (od.anchor && stepDue(s, days, od.balanceMinor)) {
      const why = run ? await holdReason(q, ctx, run, s, snap, logs, asOf, memo) : null;
      state = why ? 'HELD' : 'DUE'; reason = why ?? undefined;
    }
    steps.push({ id: s.id, name: s.name, action: s.action, state, dueOn: od.anchor ? stepDate(s, od.anchor) : null, ...(reason ? { reason } : {}) });
  }
  return { rule: { code: snap.code, name: snap.name, version: snap.version }, anchor: od.anchor, daysPastDue: days, balanceMinor: od.balanceMinor, pausedUntil: run?.pausedUntil ? String(run.pausedUntil).slice(0, 10) : null, legacy: false, steps };
}

// ───────────────────────── applying steps ─────────────────────────
type Od = { invoices: Row[]; anchor: DateStr | null; balanceMinor: number };

async function notice(db: Db, ctx: DunningContext, run: Row, s: DunningRuleStep, ladder: LadderSnapshot, od: Od, asOf: DateStr, extra: { lateFee?: string } = {}): Promise<Record<string, unknown>> {
  const pay = await getDunningPayments(db);
  const brand = (await getBranding(db)).name;
  const days = od.anchor ? diffDays(asOf, od.anchor) : 0;
  const oldest = od.invoices[0];
  const payUrl = pay.baseUrl && oldest ? `${pay.baseUrl}/pay/${oldest.number}` : '';
  let qr: { scheme: QrScheme; label: string; payload: string } | null = null, qrSkipped: string | undefined;
  if (s.params.includeQr) {
    const scheme = s.params.qrScheme;
    const merchant = scheme ? pay.merchants[scheme] : undefined;
    const bad = !scheme ? 'No QR scheme chosen for this step.' : qrMerchantProblem(scheme, merchant);
    if (bad || !scheme || !merchant) qrSkipped = bad ?? 'No QR scheme.';
    else qr = { scheme, label: QR_SCHEME_LABEL[scheme], payload: buildEmvQr({ scheme, merchant, currency: ctx.currency, amountMinor: od.balanceMinor, exponent: currencyInfo(ctx.currency)?.exponent ?? 2, reference: oldest ? String(oldest.number) : `ACC${ctx.accountId.slice(-6)}` }) };
  }
  let etc: string | undefined, terminationDate: string | undefined;
  if (s.params.final) {
    let total = 0;
    for (const sv of (await db.query(`SELECT * FROM services WHERE account_id=$1 AND status <> 'TERMINATED' AND contract_term_months > 0 AND contract_start IS NOT NULL`, [ctx.accountId])).rows) total += (await etcQuoteForService(db, sv, new Date(asOf))).chargeMinor;
    if (total > 0) etc = money(total, ctx.currency);
    const t = ladder.steps.find((x) => x.action === 'TERMINATE' && x.trigger.kind === 'DAYS_PAST_DUE');
    if (t && od.anchor && t.trigger.kind === 'DAYS_PAST_DUE') terminationDate = addDays(od.anchor, t.trigger.days);
  }
  const text = s.params.message?.trim() || DUNNING_TEMPLATES[s.params.template ?? 'FRIENDLY_REMINDER'].text;
  const message = renderDunningText(text, { name: ctx.name, brand, balance: money(od.balanceMinor, ctx.currency), dueDate: od.anchor ?? '', daysPastDue: days, payUrl, qr: qr ? QR_SCHEME_LABEL[qr.scheme] : '', lateFee: extra.lateFee, terminationDate, etc, bureau: pay.bureau });
  await db.tx((q) => queueOutbox(q, { kind: 'NOTIFY', instruction: 'DUNNING_NOTICE', accountId: ctx.accountId, payload: {
    stepId: s.id, stepName: s.name, ruleCode: ladder.code, channels: s.params.channels, message, balanceMinor: od.balanceMinor, currency: ctx.currency, daysPastDue: days, invoices: od.invoices.map((i) => i.number), payUrl: payUrl || null, qr, ...(s.params.final ? { final: true, estimatedEtc: etc ?? null } : {}) } }));
  await db.query('UPDATE accounts SET dunning_stage = GREATEST(dunning_stage, $2) WHERE id=$1', [ctx.accountId, s.params.final ? 4 : 1]);
  return { notified: true, channels: s.params.channels, ...(qr ? { qr: qr.label } : {}), ...(qrSkipped ? { qrSkipped } : {}), balanceMinor: od.balanceMinor };
}

async function lateFee(db: Db, ctx: DunningContext, run: Row, s: DunningRuleStep, od: Od, asOf: DateStr): Promise<{ outcome: Record<string, unknown>; text?: string }> {
  const f = await getLateFee(db, s.params.lateFeeId!);
  if (!f.active) return { outcome: { skipped: `The late fee “${f.name}” is switched off.` } };
  const amount = lateFeeAmount(f, od.balanceMinor);
  if (amount <= 0) return { outcome: { skipped: 'The late fee comes to nothing.' } };
  const inv = await db.tx(async (q) => {
    const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [ctx.accountId])).rows[0]!;
    const row = await issueInvoice(q, acct, { kind: 'ADJUSTMENT', periodStart: asOf, periodEnd: asOf, issueDate: asOf, lines: [{ kind: 'ADJUSTMENT', revenueAccount: f.revenueAccount, stream: 'ONE_TIME', description: `Late payment charge (${f.name})`, amountMinor: amount, taxInclusive: false, taxExempt: !f.taxable }] });
    if (row) { await q.query('UPDATE invoices SET late_fee_run_id=$2 WHERE id=$1', [row.id, run.id]); await queueOutbox(q, { kind: 'NOTIFY', instruction: 'LATE_FEE_APPLIED', accountId: ctx.accountId, payload: { invoice: row.number, amountMinor: Number(row.totalMinor), currency: ctx.currency } }); }
    await audit(q, 'dunning', 'account', ctx.accountId, 'LATE_FEE', { amount, fee: f.code });
    return row;
  });
  return { outcome: { invoice: inv?.number ?? null, amountMinor: inv ? Number(inv.totalMinor) : 0, fee: f.code }, text: money(inv ? Number(inv.totalMinor) : amount, ctx.currency) };
}

async function caseTask(db: Db, ctx: DunningContext, s: DunningRuleStep, od: Od): Promise<Record<string, unknown>> {
  const subject = s.params.subject?.trim() || `${money(od.balanceMinor, ctx.currency)} overdue: contact ${ctx.name} before action is taken`;
  const k = await createCase(db, { customerId: ctx.customerId, issueTypeId: 'billing.collections.followup', subject: subject.slice(0, 200), note: `Overdue invoices: ${od.invoices.map((i) => i.number).join(', ')}. Balance ${money(od.balanceMinor, ctx.currency)}. Step: ${s.name}.` }, 'dunning');
  const team = s.params.team?.trim() || 'Account management';
  await db.query(`UPDATE cases SET team=$2 ${s.params.dueHours ? ', resolution_due = now() + make_interval(hours => $3), sla_resolution_minutes = $3 * 60' : ''} WHERE id=$1`, s.params.dueHours ? [k.id, team, s.params.dueHours] : [k.id, team]);
  return { caseId: k.id, caseNumber: k.number, team };
}

async function applyRuleStep(db: Db, ctx: DunningContext, run: Row, s: DunningRuleStep, ladder: LadderSnapshot, od: Od, asOf: DateStr, actor: string, extra: { lateFeeText?: string }): Promise<Record<string, unknown>> {
  const cfg = await getLifecycleSettings(db);
  switch (s.action) {
    case 'NOTIFY': return notice(db, ctx, run, s, ladder, od, asOf, { lateFee: extra.lateFeeText });
    case 'SOFT_BAR': case 'HARD_BAR': return applyStep(db, ctx.accountId, run.id as number, s.action, od, asOf, actor, cfg);
    case 'TERMINATE': {
      const mode = s.params.debt ?? 'BOTH';
      const out = await applyStep(db, ctx.accountId, run.id as number, 'TERMINATE', od, asOf, actor, { ...cfg, termination: { ...cfg.termination, debtAction: mode === 'COLLECTIONS' ? 'COLLECTIONS' : 'WRITE_OFF' } });
      let placed: Row | null = null;
      if (mode === 'BOTH') placed = await db.tx((q) => placeWithAgency(q, ctx.accountId, { runId: run.id, writtenOff: true, actor }));   // written off in the ledger, still sent to the agency to recover
      return { ...out, ...(placed ? { placementId: placed.id, debt: 'WRITTEN_OFF_AND_PLACED' } : {}) };
    }
    case 'LATE_FEE': { const r = await lateFee(db, ctx, run, s, od, asOf); extra.lateFeeText = r.text; return r.outcome; }
    case 'COLLECTIONS_TRANSFER': { const p = await db.tx((q) => placeWithAgency(q, ctx.accountId, { runId: run.id, writtenOff: false, actor })); return p ? { placementId: p.id, balanceMinor: Number(p.balanceMinor) } : { skipped: 'Nothing left to place.' }; }
    case 'CASE_TASK': return caseTask(db, ctx, s, od);
  }
}

const logStep = (q: Queryable, run: Row, s: DunningRuleStep, status: string, reason: string | null, outcome: unknown, asOf: DateStr) =>
  q.query(`INSERT INTO dunning_steps (run_id, step, step_key, step_name, status, reason, day_offset, applied_on, outcome, executed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (run_id, step_key) DO UPDATE SET status=EXCLUDED.status, reason=EXCLUDED.reason, outcome=EXCLUDED.outcome, applied_on=EXCLUDED.applied_on, executed_at=now()`,
    [run.id, s.action, s.id, s.name, status, reason, s.trigger.kind === 'DAYS_PAST_DUE' ? s.trigger.days : s.trigger.minDays, asOf, JSON.stringify(outcome ?? {})]);

/**
 * Walks an overdue account down its rule's ladder for a date. Returns null when no rule fits (the caller then uses the ladder from Settings → Lifecycle). Safe to repeat.
 */
export async function evaluateByRules(db: Db, accountId: string, asOf: DateStr, o: { rules?: DunningRule[]; actor?: string } = {}): Promise<RuleStepResult[] | null> {
  const actor = o.actor ?? 'dunning';
  const od = await db.tx(async (q) => {
    await q.query(`UPDATE invoices SET status='OVERDUE' WHERE account_id=$1 AND status='ISSUED' AND due_date < $2::date AND total_minor - paid_minor - credited_minor > 0`, [accountId, asOf]);
    return overdueOf(q, accountId, asOf);
  });
  const existing = (await db.query(`SELECT * FROM dunning_runs WHERE account_id=$1 AND status='ACTIVE'`, [accountId])).rows[0];
  if (existing && !existing.ladder) return null;                                  // started under the old ladder: it finishes there
  if (!od.anchor) return [];
  if (!(await db.query(`SELECT 1 FROM services WHERE account_id=$1 AND status <> 'TERMINATED' LIMIT 1`, [accountId])).rows.length) return [];
  const ctx = await dunningContextOf(db, accountId);
  let run = existing as Row | undefined;
  if (!run) {
    const rule = pickDunningRule(o.rules ?? await listDunningRules(db, { activeOnly: true }), ctx);
    if (!rule) return null;
    const snap: LadderSnapshot = { code: rule.code, name: rule.name, version: rule.version, partial: rule.partial, steps: rule.steps.filter((s) => s.enabled) };
    await db.query(`INSERT INTO dunning_runs (account_id, anchor_due, rule_id, rule_code, rule_version, ladder) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id) WHERE status = 'ACTIVE' DO NOTHING`, [accountId, od.anchor, rule.id, rule.code, rule.version, JSON.stringify(snap)]);
    run = (await db.query(`SELECT * FROM dunning_runs WHERE account_id=$1 AND status='ACTIVE'`, [accountId])).rows[0]!;
  }
  const ladder = run.ladder as LadderSnapshot;
  if (run.pausedUntil && String(run.pausedUntil).slice(0, 10) > asOf) return [];   // a partial payment bought time
  const days = diffDays(asOf, od.anchor);
  const logs = new Map<string, Row>((await db.query('SELECT * FROM dunning_steps WHERE run_id=$1', [run.id])).rows.map((r) => [r.stepKey as string, r]));
  const due = ladder.steps.filter((s) => { const l = logs.get(s.id); return !(l && (l.status === 'APPLIED' || l.status === 'SUPERSEDED')) && stepDue(s, days, od.balanceMinor); });
  if (!due.length) return [];
  const memo = {};
  const results: RuleStepResult[] = [];
  const free: DunningRuleStep[] = [];
  for (const s of due) {
    const why = await holdReason(db, ctx, run, s, ladder, logs, asOf, memo);
    if (why) {
      if (logs.get(s.id)?.reason !== why || logs.get(s.id)?.status !== 'HELD') await logStep(db, run, s, 'HELD', why, { held: why }, asOf);
      results.push({ accountId, stepId: s.id, name: s.name, action: s.action, day: days, status: 'HELD', reason: why, outcome: { held: why } });
    } else free.push(s);
  }
  const topBar = Math.max(0, ...free.map((s) => dunningBarRank(s.action)));
  const extra: { lateFeeText?: string } = {};
  for (const s of free) {
    const rank = dunningBarRank(s.action);
    const dayOf = s.trigger.kind === 'DAYS_PAST_DUE' ? s.trigger.days : s.trigger.minDays;
    if (rank > 0 && rank < topBar) {
      await logStep(db, run, s, 'SUPERSEDED', 'A harsher step was due at the same time.', { skipped: 'a harsher step was due at the same time' }, asOf);
      results.push({ accountId, stepId: s.id, name: s.name, action: s.action, day: dayOf, status: 'SUPERSEDED', outcome: { skipped: 'a harsher step was due at the same time' } });
      continue;
    }
    if (rank > 0 || s.action === 'COLLECTIONS_TRANSFER') {                        // a task raised earlier in this very visit may now hold this step
      const why = await holdReason(db, ctx, run, s, ladder, logs, asOf, memo);
      if (why) {
        await logStep(db, run, s, 'HELD', why, { held: why }, asOf);
        results.push({ accountId, stepId: s.id, name: s.name, action: s.action, day: dayOf, status: 'HELD', reason: why, outcome: { held: why } });
        continue;
      }
    }
    try {
      const outcome = await applyRuleStep(db, ctx, run, s, ladder, od, asOf, actor, extra);
      await logStep(db, run, s, 'APPLIED', null, outcome, asOf);
      await db.query('UPDATE dunning_runs SET last_step=$2 WHERE id=$1', [run.id, s.name]);
      logs.set(s.id, { stepKey: s.id, status: 'APPLIED', outcome } as Row);
      results.push({ accountId, stepId: s.id, name: s.name, action: s.action, day: dayOf, status: 'APPLIED', outcome });
      if (s.action === 'TERMINATE') break;
    } catch (e) {
      const msg = (e as Error).message;
      await logStep(db, run, s, 'FAILED', msg.slice(0, 300), { error: msg }, asOf);
      results.push({ accountId, stepId: s.id, name: s.name, action: s.action, day: dayOf, status: 'FAILED', reason: msg, outcome: { error: msg } });
      break;                                                                     // keep the order: later steps wait for this one
    }
  }
  const order = new Map(ladder.steps.map((x, i) => [x.id, i]));
  return results.sort((x, y) => (order.get(x.stepId) ?? 0) - (order.get(y.stepId) ?? 0));
}

// ───────────────────────── a partial payment ─────────────────────────
/**
 * A payment that leaves something overdue. When it covers at least the rule's threshold of what was overdue, the rule's policy applies: put the account back to a
 * soft bar (lifting a hard bar) and give it time, or just give it time. Below the threshold nothing changes and the ladder carries on.
 */
export async function onPartialPayment(q: Queryable, accountId: string, p: { paidMinor: number; overdueBeforeMinor: number; asOf: DateStr; actor?: string }): Promise<{ applied: boolean; action?: string }> {
  const run = (await q.query(`SELECT * FROM dunning_runs WHERE account_id=$1 AND status='ACTIVE' AND ladder IS NOT NULL`, [accountId])).rows[0];
  const policy = (run?.ladder as LadderSnapshot | undefined)?.partial;
  if (!run || !policy || p.overdueBeforeMinor <= 0) return { applied: false };
  const pct = (p.paidMinor / p.overdueBeforeMinor) * 100;
  if (pct < policy.thresholdPercent) return { applied: false };
  const actor = p.actor ?? 'dunning';
  const until = addDays(p.asOf, policy.pauseDays);
  if (policy.action === 'RESET_TO_SOFT_BAR') {
    const hard = (await q.query(`SELECT * FROM services WHERE account_id=$1 AND bar_level='HARD' AND COALESCE(suspension_kind, suspended_reason)='DUNNING' AND status IN ('ACTIVE','SUSPENDED') FOR UPDATE`, [accountId])).rows;
    for (const s of hard) {
      await q.query(`UPDATE services SET status='ACTIVE', suspension_kind='DUNNING', suspended_reason='DUNNING', suspend_until=NULL, version=version+1, updated_at=now() WHERE id=$1`, [s.id]);
      await setBarLevel(q, s, 'SOFT', { kind: 'DUNNING', actor });
      await logLifecycle(q, { serviceId: s.id, accountId, action: 'BAR', from: s.status, to: 'ACTIVE', kind: 'DUNNING', actor, detail: { bar: 'SOFT', reason: 'PARTIAL_PAYMENT', paidPercent: Math.round(pct) } });
    }
    // the steps that were harder than a soft bar will apply again, in order, once the pause ends
    await q.query(`UPDATE dunning_steps SET status='REVERSED', reason='Reset by a partial payment' WHERE run_id=$1 AND status='APPLIED' AND step IN ('HARD_BAR','TERMINATE')`, [run.id]);
    await q.query(`UPDATE accounts SET dunning_stage = LEAST(dunning_stage, 2) WHERE id=$1`, [accountId]);
  }
  await q.query(`UPDATE dunning_runs SET paused_until=$2, resets = resets + 1 WHERE id=$1`, [run.id, until]);
  await queueOutbox(q, { kind: 'NOTIFY', instruction: 'PARTIAL_PAYMENT_RECEIVED', accountId, payload: { paidMinor: p.paidMinor, paidPercent: Math.round(pct), pausedUntil: until, action: policy.action } });
  await audit(q, actor, 'account', accountId, 'DUNNING_PARTIAL_PAYMENT', { paidMinor: p.paidMinor, paidPercent: Math.round(pct), action: policy.action, until });
  return { applied: true, action: policy.action };
}
export { DUNNING_STEP_ACTIONS, invoiceBalance };
