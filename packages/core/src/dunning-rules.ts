import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { DUNNING_LIMITS, getDunningLimitSettings } from './dunning-limits.js';
import { QR_SCHEMES, type QrScheme } from './emv-qr.js';

/**
 * Dunning rules. A rule is a strategy for one kind of customer (a business, a VIP, a customer with a bad credit history, everyone else): who it applies to, a ladder
 * of steps, and what a partial payment does. A step says WHEN (days past due, or the overdue balance reaching an amount), WHAT (tell the customer, bar outgoing,
 * bar everything, charge a late fee, hand the debt to an agency, ask an account manager to act, terminate), and WHEN NOT (an open billing dispute, a VIP, a payment
 * arrangement being kept). The engine (dunning-engine.ts) walks each overdue account down the ladder of the best-fitting rule. Where no rule exists, the single
 * ladder in Settings → Lifecycle is used, as before.
 */
export const DUNNING_STEP_ACTIONS = ['NOTIFY', 'SOFT_BAR', 'HARD_BAR', 'LATE_FEE', 'TERMINATE', 'COLLECTIONS_TRANSFER', 'CASE_TASK'] as const;
export type DunningStepAction = (typeof DUNNING_STEP_ACTIONS)[number];
export const DUNNING_STEP_ACTION_LABEL: Record<DunningStepAction, string> = {
  NOTIFY: 'Notify the customer', SOFT_BAR: 'Soft bar (block outgoing)', HARD_BAR: 'Hard bar (block everything but emergency calls)', LATE_FEE: 'Late fee surcharge',
  TERMINATE: 'Terminate the contract', COLLECTIONS_TRANSFER: 'Transfer to debt collection', CASE_TASK: 'Task for an account manager',
};
export const DUNNING_CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL', 'PUSH'] as const;
export type DunningChannel = (typeof DUNNING_CHANNELS)[number];
export const DUNNING_TEMPLATE_KEYS = ['FRIENDLY_REMINDER', 'FIRST_NOTICE', 'SECOND_NOTICE', 'SOFT_BAR_NOTICE', 'HARD_BAR_NOTICE', 'FINAL_DEMAND', 'ACCOUNT_MANAGER_NOTICE'] as const;
export type DunningTemplateKey = (typeof DUNNING_TEMPLATE_KEYS)[number];

export interface DunningStepParams {
  /** NOTIFY */
  channels?: DunningChannel[]; template?: DunningTemplateKey; message?: string; includeQr?: boolean; qrScheme?: QrScheme;
  /** NOTIFY: this is the last warning before termination, so it carries what termination will cost. */
  final?: boolean;
  /** LATE_FEE */
  lateFeeId?: string;
  /** CASE_TASK */
  team?: string; dueHours?: number; holdsLaterBars?: boolean; waitDays?: number; subject?: string;
  /** TERMINATE */
  debt?: 'WRITE_OFF' | 'COLLECTIONS' | 'BOTH';
}
export interface DunningStepExclusions { dispute?: boolean; vip?: boolean; arrangement?: boolean }
export type DunningStepTrigger = { kind: 'DAYS_PAST_DUE'; days: number } | { kind: 'BALANCE'; balanceMinor: number; minDays: number };
export interface DunningRuleStep { id: string; position: number; name: string; enabled: boolean; trigger: DunningStepTrigger; action: DunningStepAction; params: DunningStepParams; exclusions: DunningStepExclusions }
export interface DunningPartialPolicy { thresholdPercent: number; action: 'RESET_TO_SOFT_BAR' | 'PAUSE'; pauseDays: number }
export interface DunningRule {
  id: string; code: string; name: string; description: string; active: boolean; priority: number; market: string | null; customerKind: 'ANY' | 'INDIVIDUAL' | 'BUSINESS'; segments: string[];
  vip: 'ANY' | 'YES' | 'NO'; creditRisk: 'ANY' | 'HIGH' | 'NORMAL'; partial: DunningPartialPolicy | null; version: number; steps: DunningRuleStep[]; updatedAt: string;
}
export type DunningRuleInput = Omit<DunningRule, 'id' | 'version' | 'updatedAt' | 'steps'> & { steps: Array<Omit<DunningRuleStep, 'id'> & { id?: string }> };

export interface LateFeeConfig { id: string; code: string; name: string; mode: 'FLAT' | 'PERCENT'; flatMinor: number; percentBps: number; minMinor: number; maxMinor: number | null; taxable: boolean; revenueAccount: string; active: boolean }

const BAR_RANK: Partial<Record<DunningStepAction, number>> = { SOFT_BAR: 1, HARD_BAR: 2, TERMINATE: 3 };
export const dunningBarRank = (a: DunningStepAction) => BAR_RANK[a] ?? 0;

// ───────────────────────── reading ─────────────────────────
function stepOf(r: Row): DunningRuleStep {
  return { id: r.id, position: r.position, name: r.name, enabled: r.enabled, action: r.action, params: r.params ?? {}, exclusions: r.exclusions ?? {},
    trigger: r.triggerKind === 'BALANCE' ? { kind: 'BALANCE', balanceMinor: Number(r.balanceMinor), minDays: r.days ?? 0 } : { kind: 'DAYS_PAST_DUE', days: r.days ?? 0 } };
}
function ruleOf(r: Row, steps: Row[]): DunningRule {
  return { id: r.id, code: r.code, name: r.name, description: r.description, active: r.active, priority: r.priority, market: r.market ? String(r.market).trim() : null, customerKind: r.customerKind, segments: r.segments ?? [],
    vip: r.vip, creditRisk: r.creditRisk, partial: r.partial && Object.keys(r.partial).length ? r.partial : null, version: r.version, updatedAt: r.updatedAt, steps: steps.filter((s) => s.ruleId === r.id).sort((a, b) => a.position - b.position).map(stepOf) };
}
export async function listDunningRules(q: Queryable, o: { activeOnly?: boolean } = {}): Promise<DunningRule[]> {
  const rules = (await q.query(`SELECT * FROM dunning_rules ${o.activeOnly ? 'WHERE active' : ''} ORDER BY priority DESC, name`)).rows;
  const steps = rules.length ? (await q.query('SELECT * FROM dunning_rule_steps WHERE rule_id = ANY($1::uuid[]) ORDER BY position', [rules.map((r) => r.id)])).rows : [];
  return rules.map((r) => ruleOf(r, steps));
}
export async function getDunningRule(q: Queryable, id: string): Promise<DunningRule> {
  const r = (await q.query('SELECT * FROM dunning_rules WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('Dunning rule', id);
  return ruleOf(r, (await q.query('SELECT * FROM dunning_rule_steps WHERE rule_id=$1 ORDER BY position', [id])).rows);
}

// ───────────────────────── late fees ─────────────────────────
const feeOf = (r: Row): LateFeeConfig => ({ id: r.id, code: r.code, name: r.name, mode: r.mode, flatMinor: Number(r.flatMinor), percentBps: r.percentBps, minMinor: Number(r.minMinor), maxMinor: r.maxMinor === null ? null : Number(r.maxMinor), taxable: r.taxable, revenueAccount: r.revenueAccount, active: r.active });
export const listLateFees = async (q: Queryable): Promise<LateFeeConfig[]> => (await q.query('SELECT * FROM late_fee_configs ORDER BY name')).rows.map(feeOf);
export async function getLateFee(q: Queryable, id: string): Promise<LateFeeConfig> {
  const r = (await q.query('SELECT * FROM late_fee_configs WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('Late fee', id);
  return feeOf(r);
}
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export async function saveLateFee(q: Queryable, actor: string, i: Partial<LateFeeConfig> & { name: string; mode: 'FLAT' | 'PERCENT' }): Promise<LateFeeConfig> {
  const name = (i.name ?? '').trim();
  if (!name || name.length > 80) throw invalid('Give the late fee a name of 1–80 characters.');
  if (i.mode !== 'FLAT' && i.mode !== 'PERCENT') throw invalid('A late fee is a flat amount or a percentage of the overdue balance.');
  const flat = i.flatMinor ?? 0, bps = i.percentBps ?? 0, min = i.minMinor ?? 0, max = i.maxMinor ?? null;
  if (![flat, min].every((n) => Number.isInteger(n) && n >= 0)) throw invalid('Amounts are whole numbers of minor units, zero or more.');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw invalid('The percentage is from 0 to 100.');
  if (i.mode === 'FLAT' && flat <= 0) throw invalid('A flat late fee needs an amount.');
  if (i.mode === 'PERCENT' && bps <= 0) throw invalid('A percentage late fee needs a percentage.');
  if (max !== null && (!Number.isInteger(max) || max < min)) throw invalid('The most cannot be less than the least.');
  const account = i.revenueAccount ?? '4300';
  if (!/^\d{4}$/.test(account)) throw invalid('The revenue account is a 4-digit ledger code.');
  if (i.id) {
    const r = await q.query(`UPDATE late_fee_configs SET name=$2, mode=$3, flat_minor=$4, percent_bps=$5, min_minor=$6, max_minor=$7, taxable=$8, revenue_account=$9, active=$10, updated_by=$11, updated_at=now() WHERE id=$1`,
      [i.id, name, i.mode, flat, bps, min, max, !!i.taxable, account, i.active ?? true, actor]);
    if (!r.rowCount) throw notFound('Late fee', i.id);
    await audit(q, actor, 'late_fee', i.id, 'UPDATE', { name });
    return getLateFee(q, i.id);
  }
  let code = i.code ? slug(i.code) : slug(name);
  if (!code) throw invalid('The name needs letters or digits.');
  if ((await q.query('SELECT 1 FROM late_fee_configs WHERE code=$1', [code])).rows.length) code += `-${Math.random().toString(36).slice(2, 5)}`;
  const r = (await q.query(`INSERT INTO late_fee_configs (code, name, mode, flat_minor, percent_bps, min_minor, max_minor, taxable, revenue_account, active, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [code, name, i.mode, flat, bps, min, max, !!i.taxable, account, i.active ?? true, actor])).rows[0]!;
  await audit(q, actor, 'late_fee', r.id, 'CREATE', { name });
  return getLateFee(q, r.id);
}
export async function deleteLateFee(q: Queryable, actor: string, id: string) {
  await getLateFee(q, id);
  const used = (await q.query(`SELECT r.name FROM dunning_rule_steps s JOIN dunning_rules r ON r.id = s.rule_id WHERE s.params->>'lateFeeId' = $1 LIMIT 1`, [id])).rows[0];
  if (used) throw conflict(`The rule “${used.name}” uses this late fee. Change the rule first, or switch the fee off.`);
  await q.query('DELETE FROM late_fee_configs WHERE id=$1', [id]);
  await audit(q, actor, 'late_fee', id, 'DELETE', {});
  return { ok: true };
}
/** The late fee for an overdue balance: a flat amount, or the percentage, kept between the least and the most. */
export function lateFeeAmount(f: Pick<LateFeeConfig, 'mode' | 'flatMinor' | 'percentBps' | 'minMinor' | 'maxMinor'>, overdueMinor: number): number {
  const raw = f.mode === 'FLAT' ? f.flatMinor : Math.round((overdueMinor * f.percentBps) / 10_000);
  return Math.max(Math.min(raw, f.maxMinor ?? Infinity), f.mode === 'PERCENT' ? f.minMinor : 0);
}

// ───────────────────────── validating and saving a rule ─────────────────────────
export async function dunningRuleProblems(q: Queryable, r: Pick<DunningRuleInput, 'name' | 'market' | 'segments' | 'partial' | 'steps' | 'priority' | 'customerKind' | 'vip' | 'creditRisk'> & { code?: string; description?: string }): Promise<string[]> {
  const p: string[] = [];
  // Limits: the fixed ones and the two the operator sets (dunning-limits.ts). A rule saved earlier may be over a limit lowered since; it loads and shows as before, and saving it asks for the fix.
  const L = DUNNING_LIMITS, { maxSteps, maxPriority } = await getDunningLimitSettings(q);
  if (!r.name?.trim() || r.name.length > L.nameMax) p.push(`Give the rule a name of 1–${L.nameMax} characters.`);
  if ((r.description ?? '').length > L.descriptionMax) p.push(`The description is at most ${L.descriptionMax} characters.`);
  if (!Number.isInteger(r.priority) || r.priority < L.priorityMin || r.priority > maxPriority) p.push(`Priority is a whole number from ${L.priorityMin} to ${maxPriority}${Number.isInteger(r.priority) && r.priority > maxPriority ? ` (this rule has ${r.priority}; the highest allowed is set in Settings → Dunning rules → Limits)` : ''}.`);
  if (r.market !== null && !/^[A-Z]{2}$/.test(r.market)) p.push('The market is a 2-letter country code, or left empty for every market.');
  if (!['ANY', 'INDIVIDUAL', 'BUSINESS'].includes(r.customerKind)) p.push('Customer kind is any, individual or business.');
  if (!['ANY', 'YES', 'NO'].includes(r.vip)) p.push('VIP is any, yes or no.');
  if (!['ANY', 'HIGH', 'NORMAL'].includes(r.creditRisk)) p.push('Credit risk is any, high or normal.');
  if (r.segments.length) {
    const known = new Set((await q.query('SELECT id FROM customer_segments')).rows.map((s) => s.id as string));
    for (const s of r.segments) if (!known.has(s)) p.push(`There is no customer segment “${s}”.`);
  }
  if (r.partial) {
    const x = r.partial;
    if (!(x.thresholdPercent >= L.partialThresholdMin && x.thresholdPercent <= L.partialThresholdMax)) p.push(`The partial-payment threshold is a percentage from ${L.partialThresholdMin} to ${L.partialThresholdMax}.`);
    if (!['RESET_TO_SOFT_BAR', 'PAUSE'].includes(x.action)) p.push('A partial payment resets to a soft bar, or pauses the ladder.');
    if (!Number.isInteger(x.pauseDays) || x.pauseDays < L.pauseDaysMin || x.pauseDays > L.pauseDaysMax) p.push(`The pause is ${L.pauseDaysMin} to ${L.pauseDaysMax} days.`);
  }
  const steps = r.steps;
  if (!steps.length) p.push('The ladder needs at least one step.');
  if (steps.length > maxSteps) p.push(`A ladder has at most ${maxSteps} steps; this one has ${steps.length}. Remove ${steps.length - maxSteps}, or raise the limit in Settings → Dunning rules → Limits.`);
  const fees = new Map((await listLateFees(q)).map((f) => [f.id, f]));
  const ids = new Set<string>();
  let lastDays = -1, topBar = 0;
  const live = steps.filter((s) => s.enabled);
  steps.forEach((s, i) => {
    const at = `Step ${i + 1} (${s.name?.trim() || s.action})`;
    if (!s.name?.trim() || s.name.length > L.stepNameMax) p.push(`${at}: give it a name of up to ${L.stepNameMax} characters.`);
    if (!(DUNNING_STEP_ACTIONS as readonly string[]).includes(s.action)) { p.push(`${at}: unknown action ${s.action}.`); return; }
    if (s.id) { if (ids.has(s.id)) p.push(`${at}: appears twice.`); ids.add(s.id); }
    const t = s.trigger;
    if (t.kind === 'DAYS_PAST_DUE') { if (!Number.isInteger(t.days) || t.days < 0 || t.days > L.dayMax) p.push(`${at}: the day is a whole number from 0 to ${L.dayMax}.`); }
    else if (t.kind === 'BALANCE') {
      if (!Number.isInteger(t.balanceMinor) || t.balanceMinor <= 0) p.push(`${at}: the balance threshold is a positive amount.`);
      if (!Number.isInteger(t.minDays) || t.minDays < 0 || t.minDays > L.dayMax) p.push(`${at}: the minimum days past due is 0 to ${L.dayMax}.`);
    } else p.push(`${at}: the trigger is days past due, or an overdue balance.`);
    if (s.action === 'NOTIFY') {
      if (!s.params.channels?.length || s.params.channels.some((c) => !(DUNNING_CHANNELS as readonly string[]).includes(c))) p.push(`${at}: choose at least one channel (${DUNNING_CHANNELS.join(', ')}).`);
      if (s.params.template && !(DUNNING_TEMPLATE_KEYS as readonly string[]).includes(s.params.template)) p.push(`${at}: unknown message template.`);
      if (!s.params.template && !(s.params.message ?? '').trim()) p.push(`${at}: choose a message template or write the message.`);
      if ((s.params.message ?? '').length > L.messageMax) p.push(`${at}: the message is at most ${L.messageMax.toLocaleString('en-US')} characters.`);
      if (s.params.qrScheme && !(QR_SCHEMES as readonly string[]).includes(s.params.qrScheme)) p.push(`${at}: unknown QR scheme.`);
    }
    if (s.action === 'LATE_FEE') { const f = s.params.lateFeeId ? fees.get(s.params.lateFeeId) : null; if (!f) p.push(`${at}: choose a late fee.`); else if (!f.active) p.push(`${at}: the late fee “${f.name}” is switched off.`); }
    if (s.action === 'CASE_TASK') {
      if ((s.params.team ?? '').length > L.teamMax) p.push(`${at}: the team name is at most ${L.teamMax} characters.`);
      if (s.params.dueHours !== undefined && (!Number.isInteger(s.params.dueHours) || s.params.dueHours < 1 || s.params.dueHours > L.dueHoursMax)) p.push(`${at}: the task is due in 1 to ${L.dueHoursMax.toLocaleString('en-US')} hours.`);
      if (s.params.waitDays !== undefined && (!Number.isInteger(s.params.waitDays) || s.params.waitDays < 1 || s.params.waitDays > L.waitDaysMax)) p.push(`${at}: wait 1 to ${L.waitDaysMax} days for the task.`);
    }
    if (s.action === 'TERMINATE' && s.params.debt && !['WRITE_OFF', 'COLLECTIONS', 'BOTH'].includes(s.params.debt)) p.push(`${at}: the debt is written off, placed with collections, or both.`);
  });
  // Order: days never go backwards (balance steps are free of it), a bar never follows a harder one, nothing follows the termination.
  for (const s of live) {
    if (s.trigger.kind === 'DAYS_PAST_DUE') { if (s.trigger.days < lastDays) p.push(`“${s.name}” (day ${s.trigger.days}) comes after a step on day ${lastDays}: put the steps in the order they happen.`); lastDays = Math.max(lastDays, s.trigger.days); }
    const rank = dunningBarRank(s.action);
    if (rank && rank < topBar) p.push(`“${s.name}” cannot come after a harder step.`);
    if (rank) topBar = Math.max(topBar, rank);
  }
  const term = live.findIndex((s) => s.action === 'TERMINATE');
  if (term >= 0 && term !== live.length - 1) p.push('Nothing can come after the termination step.');
  if (live.filter((s) => s.action === 'TERMINATE').length > 1) p.push('A ladder terminates once.');
  return p;
}

export async function saveDunningRule(q: Queryable, actor: string, input: DunningRuleInput, id?: string): Promise<DunningRule> {
  const rule: DunningRuleInput = { ...input, name: input.name?.trim(), market: input.market ? String(input.market).toUpperCase() : null, segments: [...new Set(input.segments ?? [])], partial: input.partial ?? null };
  const problems = await dunningRuleProblems(q, rule);
  if (problems.length) throw invalid(problems.slice(0, 6).join(' '), problems);
  let ruleId = id;
  if (ruleId) {
    const cur = await getDunningRule(q, ruleId);
    await q.query(`UPDATE dunning_rules SET name=$2, description=$3, active=$4, priority=$5, market=$6, customer_kind=$7, segments=$8, vip=$9, credit_risk=$10, partial=$11, version=version+1, updated_by=$12, updated_at=now() WHERE id=$1`,
      [ruleId, rule.name, rule.description ?? '', rule.active, rule.priority, rule.market, rule.customerKind, rule.segments, rule.vip, rule.creditRisk, JSON.stringify(rule.partial ?? {}), actor]);
    const keep = new Set(rule.steps.map((s) => s.id).filter(Boolean) as string[]);
    for (const s of cur.steps) if (!keep.has(s.id)) await q.query('DELETE FROM dunning_rule_steps WHERE id=$1', [s.id]);
    await q.query('UPDATE dunning_rule_steps SET position = -position - 1000 WHERE rule_id=$1', [ruleId]);   // out of the way of the unique (rule, position) while steps are reordered
  } else {
    let code = slug(input.code ?? rule.name);
    if (!code) throw invalid('The name needs letters or digits.');
    if ((await q.query('SELECT 1 FROM dunning_rules WHERE code=$1', [code])).rows.length) code += `-${Math.random().toString(36).slice(2, 5)}`;
    ruleId = (await q.query(`INSERT INTO dunning_rules (code, name, description, active, priority, market, customer_kind, segments, vip, credit_risk, partial, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
      [code, rule.name, rule.description ?? '', rule.active, rule.priority, rule.market, rule.customerKind, rule.segments, rule.vip, rule.creditRisk, JSON.stringify(rule.partial ?? {}), actor])).rows[0]!.id as string;
  }
  for (const [i, s] of rule.steps.entries()) {
    const days = s.trigger.kind === 'DAYS_PAST_DUE' ? s.trigger.days : s.trigger.minDays, bal = s.trigger.kind === 'BALANCE' ? s.trigger.balanceMinor : null;
    const args = [ruleId, i, s.name.trim(), s.enabled, s.trigger.kind, days, bal, s.action, JSON.stringify(s.params ?? {}), JSON.stringify(s.exclusions ?? {})];
    if (s.id && (await q.query('SELECT 1 FROM dunning_rule_steps WHERE id=$1 AND rule_id=$2', [s.id, ruleId])).rows.length)
      await q.query(`UPDATE dunning_rule_steps SET position=$2, name=$3, enabled=$4, trigger_kind=$5, days=$6, balance_minor=$7, action=$8, params=$9, exclusions=$10 WHERE id=$11 AND rule_id=$1`, [...args, s.id]);
    else await q.query(`INSERT INTO dunning_rule_steps (rule_id, position, name, enabled, trigger_kind, days, balance_minor, action, params, exclusions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, args);
  }
  await audit(q, actor, 'dunning_rule', ruleId, id ? 'UPDATE' : 'CREATE', { name: rule.name, steps: rule.steps.length });
  return getDunningRule(q, ruleId);
}

/**
 * Switch a rule on or off. Deliberately does not re-check the rule against the limits: a rule that is over a limit lowered since must still be possible to
 * switch off. (Its version goes up like any other change.)
 */
export async function setDunningRuleActive(q: Queryable, actor: string, id: string, active: boolean): Promise<DunningRule> {
  const r = await getDunningRule(q, id);
  await q.query('UPDATE dunning_rules SET active=$2, version=version+1, updated_by=$3, updated_at=now() WHERE id=$1', [id, active, actor]);
  await audit(q, actor, 'dunning_rule', id, 'UPDATE', { name: r.name, active });
  return getDunningRule(q, id);
}

export async function deleteDunningRule(q: Queryable, actor: string, id: string) {
  const r = await getDunningRule(q, id);
  if ((await q.query(`SELECT 1 FROM dunning_runs WHERE rule_id=$1 AND status='ACTIVE' LIMIT 1`, [id])).rows.length) throw conflict('Accounts are being dunned under this rule right now. Switch it off instead: they finish the ladder they started.');
  await q.query('DELETE FROM dunning_rules WHERE id=$1', [id]);
  await audit(q, actor, 'dunning_rule', id, 'DELETE', { name: r.name });
  return { ok: true };
}

// ───────────────────────── which rule fits an account ─────────────────────────
export interface DunningContext { accountId: string; customerId: string; name: string; segment: string; customerKind: 'INDIVIDUAL' | 'BUSINESS'; vip: boolean; highRisk: boolean; market: string; currency: string }

export async function dunningContextOf(q: Queryable, accountId: string): Promise<DunningContext> {
  const r = (await q.query(
    `SELECT a.id AS account_id, a.currency, c.id AS customer_id, c.display_name, c.segment, c.vip, c.credit_risk, c.market_code, COALESCE(s.individual, true) AS individual
       FROM accounts a JOIN customers c ON c.id = a.customer_id LEFT JOIN customer_segments s ON s.id = c.segment WHERE a.id=$1`, [accountId])).rows[0];
  if (!r) throw notFound('account', accountId);
  return { accountId, customerId: r.customerId, name: r.displayName, segment: r.segment, customerKind: r.individual ? 'INDIVIDUAL' : 'BUSINESS', vip: !!r.vip, highRisk: r.creditRisk === 'HIGH', market: String(r.marketCode ?? '').trim(), currency: String(r.currency).trim() };
}

const specificity = (r: DunningRule) => (r.market ? 1 : 0) + (r.customerKind !== 'ANY' ? 1 : 0) + (r.segments.length ? 1 : 0) + (r.vip !== 'ANY' ? 1 : 0) + (r.creditRisk !== 'ANY' ? 1 : 0);
export function dunningRuleMatches(r: DunningRule, c: DunningContext): boolean {
  return r.active && (!r.market || r.market === c.market) && (r.customerKind === 'ANY' || r.customerKind === c.customerKind) && (!r.segments.length || r.segments.includes(c.segment))
    && (r.vip === 'ANY' || (r.vip === 'YES') === c.vip) && (r.creditRisk === 'ANY' || (r.creditRisk === 'HIGH') === c.highRisk);
}
/** The rule that fits: the highest priority, then the most specific. Null when no rule fits (the Settings → Lifecycle ladder applies). */
export function pickDunningRule(rules: DunningRule[], c: DunningContext): DunningRule | null {
  return rules.filter((r) => dunningRuleMatches(r, c)).sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a) || a.name.localeCompare(b.name))[0] ?? null;
}
export async function hasActiveRules(q: Queryable): Promise<boolean> { return (await q.query('SELECT 1 FROM dunning_rules WHERE active LIMIT 1')).rows.length > 0; }
