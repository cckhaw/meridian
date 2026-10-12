import type { Queryable, Row } from './db.js';
import { audit } from './audit.js';
import { invalid, notFound } from './errors.js';
import type { GroupKind } from './order-pricing.js';

/**
 * The cancellation rule base. Every question of the form "may this part of the order be cancelled / returned / flagged / auto-cancelled, and what
 * does it cost?" is answered by the first enabled rule (lowest priority number) whose scope and conditions match. Rules are data, edited in
 * Settings → Cancellation; the defaults shipped here reproduce the standard policy. Nothing in the order engine hard-codes a number.
 *
 * Physical limits stay in the engine, whatever a rule says: goods that have shipped cannot be cancelled (they can be returned), and an
 * activated service cannot be un-activated by cancelling it.
 */
export type RuleAction = 'CANCEL' | 'RETURN' | 'FLAG_AT_RISK' | 'AUTO_CANCEL';
export type RuleGroup = GroupKind | 'ANY';
export const RULE_ACTIONS: RuleAction[] = ['CANCEL', 'RETURN', 'FLAG_AT_RISK', 'AUTO_CANCEL'];
export const RULE_GROUPS: RuleGroup[] = ['GOODS', 'INSTALL', 'ACTIVATION', 'ANY'];

export type FactId = 'groupStatus' | 'hoursToVisit' | 'hoursOpen' | 'daysOpen' | 'hoursSinceLocked' | 'daysSinceDelivered' | 'returnCondition' | 'initiatedBy'
  | 'channel' | 'segment' | 'market' | 'paymentMethod' | 'paidMinor' | 'hasInstalments' | 'hasContract' | 'offerKinds';
export type Op = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'not_in' | 'contains';
export interface Condition { fact: FactId; op: Op; value: string | number | boolean | string[] }

export interface FactMeta { id: FactId; label: string; type: 'number' | 'enum' | 'bool' | 'text' | 'list'; unit?: string; values?: Array<[string, string]>; help: string; groups?: GroupKind[] }
const ORDER_CHANNELS: Array<[string, string]> = ['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'].map((c) => [c, c.toLowerCase().replace(/_/g, ' ')]);
export const FACTS: FactMeta[] = [
  { id: 'groupStatus', label: 'Where the part is', type: 'enum', values: [['PENDING', 'not started (not shipped / dispatched / active)'], ['LOCKED', 'shipped or technician dispatched'], ['DONE', 'delivered / installed / active']], help: 'The part’s current stage.' },
  { id: 'hoursToVisit', label: 'Hours until the installation visit', type: 'number', unit: 'hours', groups: ['INSTALL'], help: 'Time left before the booked visit. Empty when no visit is booked, so a rule using it simply does not apply.' },
  { id: 'hoursOpen', label: 'Hours since the order was paid', type: 'number', unit: 'hours', help: 'How long this part has been open.' },
  { id: 'daysOpen', label: 'Days since the order was paid', type: 'number', unit: 'days', help: 'How long this part has been open, in whole days.' },
  { id: 'hoursSinceLocked', label: 'Hours since shipped / dispatched', type: 'number', unit: 'hours', help: 'Empty until the part has shipped or been dispatched.' },
  { id: 'daysSinceDelivered', label: 'Days since delivery', type: 'number', unit: 'days', groups: ['GOODS'], help: 'The cooling-off clock for returns. Empty until delivered.' },
  { id: 'returnCondition', label: 'Condition of returned goods', type: 'enum', values: [['GOOD', 'as new'], ['DAMAGED', 'damaged'], ['INCOMPLETE', 'missing parts']], groups: ['GOODS'], help: 'Entered by the person handling the return.' },
  { id: 'initiatedBy', label: 'Who is cancelling', type: 'enum', values: [['CUSTOMER', 'the customer (self-serve)'], ['STAFF', 'a staff member'], ['SYSTEM', 'the system (automatic)']], help: 'Lets the policy differ between customers and staff.' },
  { id: 'channel', label: 'Sales channel', type: 'enum', values: ORDER_CHANNELS, help: 'Where the order was placed.' },
  { id: 'segment', label: 'Customer segment', type: 'enum', values: [['CONSUMER', 'consumer'], ['FAMILY', 'family'], ['ENTERPRISE', 'enterprise'], ['IOT_ENTERPRISE', 'IoT enterprise']], help: 'Consumer or enterprise customer.' },
  { id: 'market', label: 'Market (country code)', type: 'text', help: 'e.g. SG, MY.' },
  { id: 'paymentMethod', label: 'Payment method', type: 'enum', values: [['CASH', 'cash'], ['CREDIT_CARD', 'card'], ['QR', 'QR'], ['INSTALLMENT', 'instalments']], help: 'How the order was paid.' },
  { id: 'paidMinor', label: 'Amount paid for this part', type: 'number', unit: 'minor units', help: 'In the smallest currency unit (cents).' },
  { id: 'hasInstalments', label: 'Paid by instalments', type: 'bool', help: 'Any item in this part is financed.' },
  { id: 'hasContract', label: 'Comes with a contract', type: 'bool', help: 'Any item in this part has a contract term.' },
  { id: 'offerKinds', label: 'Kind of product', type: 'list', values: [['SIM_ONLY', 'SIM only'], ['SIM_DEVICE', 'SIM + device'], ['WEARABLE', 'wearable'], ['FIBER', 'fibre'], ['IOT_CONNECTIVITY', 'IoT'], ['VAS', 'add-on'], ['NON_TELCO_SUBSCRIPTION', 'subscription'], ['PHYSICAL_GOOD', 'device / goods']], help: 'The kinds of product in this part.' },
];
const FACT = new Map(FACTS.map((f) => [f.id, f]));
export const OPS: Array<[Op, string, FactMeta['type'][]]> = [
  ['eq', 'is', ['number', 'enum', 'bool', 'text']], ['ne', 'is not', ['number', 'enum', 'bool', 'text']],
  ['lt', 'is less than', ['number']], ['lte', 'is at most', ['number']], ['gt', 'is more than', ['number']], ['gte', 'is at least', ['number']],
  ['in', 'is one of', ['enum', 'text']], ['not_in', 'is none of', ['enum', 'text']], ['contains', 'includes', ['list']],
];

export interface Outcome {
  allow: boolean;
  /** Kept from the refund: a fixed amount, a share of what was paid, or both (then clamped to min/max). Minor units of the order currency. */
  feeFixedMinor?: number; feePercentBps?: number; feeMinMinor?: number; feeMaxMinor?: number;
  /** Share of what was paid that is refunded, in basis points (10000 = everything). Use for restocking deductions. */
  refundBps?: number;
  /** Returns: the most a person may deduct for damage, as a share of what was paid (basis points). */
  maxDeductionBps?: number;
  /** Allowed, but only with the override permission (a supervisor). */
  requiresOverride?: boolean;
}
export interface CancellationRule { id: string; name: string; action: RuleAction; group: RuleGroup; priority: number; enabled: boolean; when: Condition[]; outcome: Outcome; message?: string; showInTerms: boolean }

const bps = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 10_000;
const minor = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000_000;

export function validateCancellationRule(r: Partial<CancellationRule>): string[] {
  const e: string[] = [];
  if (!r.id || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(r.id)) e.push('the rule id may contain lowercase letters, digits and dashes');
  if (!r.name?.trim() || r.name.length > 120) e.push('give the rule a short name');
  if (!r.action || !RULE_ACTIONS.includes(r.action)) e.push('choose what the rule decides');
  if (!r.group || !RULE_GROUPS.includes(r.group)) e.push('choose which part of an order the rule applies to');
  if (!Number.isInteger(r.priority) || (r.priority as number) < 0 || (r.priority as number) > 100_000) e.push('priority must be a whole number');
  if (r.message && r.message.length > 300) e.push('the message is limited to 300 characters');
  const w = r.when ?? [];
  if (w.length > 10) e.push('a rule can have up to 10 conditions');
  for (const c of w) {
    const f = FACT.get(c.fact);
    if (!f) { e.push(`unknown condition “${c.fact}”`); continue; }
    const op = OPS.find((o) => o[0] === c.op);
    if (!op || !op[2].includes(f.type)) { e.push(`“${f.label}” cannot be compared with “${c.op}”`); continue; }
    if (f.type === 'number' && (typeof c.value !== 'number' || !Number.isFinite(c.value))) e.push(`“${f.label}” needs a number`);
    if (f.type === 'bool' && typeof c.value !== 'boolean') e.push(`“${f.label}” is yes or no`);
    if ((c.op === 'in' || c.op === 'not_in') && (!Array.isArray(c.value) || !c.value.length)) e.push(`“${f.label}” needs at least one value`);
    if (f.values && f.type !== 'number') for (const v of Array.isArray(c.value) ? c.value : [c.value]) if (!f.values.some(([k]) => k === v)) e.push(`“${v}” is not a valid ${f.label.toLowerCase()}`);
  }
  const o = r.outcome;
  if (!o || typeof o.allow !== 'boolean') e.push('choose whether the rule allows or refuses');
  else {
    for (const k of ['feePercentBps', 'refundBps', 'maxDeductionBps'] as const) if (o[k] !== undefined && !bps(o[k])) e.push(`${k === 'feePercentBps' ? 'the fee percentage' : k === 'refundBps' ? 'the refund percentage' : 'the deduction limit'} must be between 0% and 100%`);
    for (const k of ['feeFixedMinor', 'feeMinMinor', 'feeMaxMinor'] as const) if (o[k] !== undefined && !minor(o[k])) e.push('fees must be zero or a positive amount');
    if (o.feeMinMinor !== undefined && o.feeMaxMinor !== undefined && o.feeMinMinor > o.feeMaxMinor) e.push('the minimum fee cannot be more than the maximum');
    if (!o.allow && (o.feeFixedMinor || o.feePercentBps || o.requiresOverride)) e.push('a rule that refuses cannot also charge a fee or ask for approval');
  }
  return e;
}

// ───────────────────────── defaults ─────────────────────────
const D = (id: string, name: string, action: RuleAction, group: RuleGroup, priority: number, when: Condition[], outcome: Outcome, extra: Partial<CancellationRule> = {}): CancellationRule =>
  ({ id, name, action, group, priority, enabled: true, when, outcome, showInTerms: true, ...extra });
const st = (...v: string[]): Condition => (v.length === 1 ? { fact: 'groupStatus', op: 'eq', value: v[0]! } : { fact: 'groupStatus', op: 'in', value: v });

/** The standard policy. Order matters: the first matching rule wins. */
export const DEFAULT_RULES: CancellationRule[] = [
  D('goods-before-shipping', 'Goods: free until shipped', 'CANCEL', 'GOODS', 10, [st('PENDING')], { allow: true }),
  D('goods-shipped', 'Goods: no cancellation once shipped', 'CANCEL', 'GOODS', 20, [st('LOCKED', 'DONE')], { allow: false }, { message: 'The goods have shipped (past the point of no return). Once delivered they can be returned within the cooling-off period.' }),
  D('install-late', 'Installation: call-out fee when cancelled close to the visit', 'CANCEL', 'INSTALL', 30, [st('PENDING'), { fact: 'hoursToVisit', op: 'lt', value: 24 }], { allow: true, feeFixedMinor: 5000 }),
  D('install-free', 'Installation: free until the visit is close', 'CANCEL', 'INSTALL', 40, [st('PENDING')], { allow: true }),
  D('install-dispatched', 'Installation: no cancellation once dispatched', 'CANCEL', 'INSTALL', 50, [st('LOCKED')], { allow: false }, { message: 'The technician has been dispatched (past the point of no return).' }),
  D('install-done', 'Installation: none after it is done', 'CANCEL', 'INSTALL', 60, [st('DONE')], { allow: false }, { message: 'The installation is complete: terminate the service instead.', showInTerms: false }),
  D('activation-before-live', 'Services: free until switched on', 'CANCEL', 'ACTIVATION', 70, [st('PENDING')], { allow: true }),
  D('activation-live', 'Services: none once switched on', 'CANCEL', 'ACTIVATION', 80, [st('DONE')], { allow: false }, { message: 'The service is already active: terminate it under its contract terms instead.' }),
  D('goods-return-window', 'Goods: return within 14 days of delivery', 'RETURN', 'GOODS', 10, [st('DONE'), { fact: 'daysSinceDelivered', op: 'lte', value: 14 }], { allow: true }),
  D('goods-return-closed', 'Goods: return period over', 'RETURN', 'GOODS', 20, [st('DONE')], { allow: false }, { message: 'The return period has ended.', showInTerms: false }),
  D('goods-not-delivered', 'Goods: nothing to return before delivery', 'RETURN', 'GOODS', 30, [st('PENDING', 'LOCKED')], { allow: false }, { message: 'The goods have not been delivered yet: wait for delivery, then return them.', showInTerms: false }),
  D('install-at-risk', 'Installation: flag as at risk after 14 days', 'FLAG_AT_RISK', 'INSTALL', 10, [st('PENDING', 'LOCKED'), { fact: 'daysOpen', op: 'gte', value: 14 }], { allow: true }),
  D('install-auto-cancel', 'Installation: cancel and refund after 21 days', 'AUTO_CANCEL', 'INSTALL', 10, [st('PENDING'), { fact: 'daysOpen', op: 'gte', value: 21 }], { allow: true }, { message: 'If the installation is not completed within 21 days it is cancelled and refunded automatically.' }),
];

// ───────────────────────── storage ─────────────────────────
const toRule = (r: Row): CancellationRule => ({
  id: r.id, name: r.name, action: r.action, group: r.groupKind, priority: r.priority, enabled: r.enabled,
  when: r.data.when ?? [], outcome: r.data.outcome ?? { allow: false }, message: r.data.message || undefined, showInTerms: r.data.showInTerms !== false,
});
const dataOf = (r: CancellationRule) => ({ when: r.when, outcome: r.outcome, message: r.message || undefined, showInTerms: r.showInTerms });

export interface CancellationSettings { defaultAllow: boolean }

/** First use installs the standard policy (once). After that the table is the policy, and an empty table means "refuse". */
async function ensureSeeded(q: Queryable): Promise<void> {
  if ((await q.query(`SELECT 1 FROM settings WHERE key='cancellation'`)).rows.length) return;
  for (const r of DEFAULT_RULES) await q.query(`INSERT INTO cancellation_rules (id, name, action, group_kind, priority, enabled, data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [r.id, r.name, r.action, r.group, r.priority, r.enabled, JSON.stringify(dataOf(r))]);
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('cancellation', $1, 'system') ON CONFLICT DO NOTHING`, [JSON.stringify({ defaultAllow: false } satisfies CancellationSettings)]);
}

export async function getCancellationSettings(q: Queryable): Promise<CancellationSettings> {
  await ensureSeeded(q);
  return { defaultAllow: false, ...((await q.query(`SELECT value FROM settings WHERE key='cancellation'`)).rows[0]?.value ?? {}) };
}

export async function listRules(q: Queryable): Promise<CancellationRule[]> {
  await ensureSeeded(q);
  return (await q.query('SELECT * FROM cancellation_rules ORDER BY action, priority, id')).rows.map(toRule);
}

export async function saveRule(q: Queryable, actor: string, input: CancellationRule, create: boolean): Promise<CancellationRule> {
  await ensureSeeded(q);
  const errs = validateCancellationRule(input);
  if (errs.length) throw invalid(errs.join(' '), errs);
  if (create) {
    if ((await q.query('SELECT 1 FROM cancellation_rules WHERE id=$1', [input.id])).rows.length) throw invalid(`a rule called ${input.id} already exists`);
    await q.query('INSERT INTO cancellation_rules (id, name, action, group_kind, priority, enabled, data) VALUES ($1,$2,$3,$4,$5,$6,$7)', [input.id, input.name, input.action, input.group, input.priority, input.enabled, JSON.stringify(dataOf(input))]);
  } else {
    const n = await q.query('UPDATE cancellation_rules SET name=$2, action=$3, group_kind=$4, priority=$5, enabled=$6, data=$7, updated_at=now() WHERE id=$1', [input.id, input.name, input.action, input.group, input.priority, input.enabled, JSON.stringify(dataOf(input))]);
    if (!n.rowCount) throw notFound('cancellation rule', input.id);
  }
  await audit(q, actor, 'settings', input.id, create ? 'CANCELLATION_RULE_CREATED' : 'CANCELLATION_RULE_UPDATED', { action: input.action, group: input.group, allow: input.outcome.allow });
  return toRule((await q.query('SELECT * FROM cancellation_rules WHERE id=$1', [input.id])).rows[0]!);
}

export async function deleteRule(q: Queryable, actor: string, id: string) {
  await ensureSeeded(q);
  if (!(await q.query('DELETE FROM cancellation_rules WHERE id=$1', [id])).rowCount) throw notFound('cancellation rule', id);
  await audit(q, actor, 'settings', id, 'CANCELLATION_RULE_DELETED');
}

/** Swaps a rule's priority with its neighbour in the same decision list, so the order people see is the order rules are tried. */
export async function moveRule(q: Queryable, actor: string, id: string, dir: 'up' | 'down') {
  const rules = (await listRules(q));
  const me = rules.find((r) => r.id === id);
  if (!me) throw notFound('cancellation rule', id);
  const list = rules.filter((r) => r.action === me.action);
  const i = list.findIndex((r) => r.id === id), j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return;
  // Renumber the whole list so ties never leave an ambiguous order, then swap the pair.
  const order = list.map((r) => r.id);
  [order[i], order[j]] = [order[j]!, order[i]!];
  for (const [k, rid] of order.entries()) await q.query('UPDATE cancellation_rules SET priority=$2 WHERE id=$1', [rid, (k + 1) * 10]);
  await audit(q, actor, 'settings', id, 'CANCELLATION_RULE_MOVED', { dir });
}

export async function setCancellationSettings(q: Queryable, actor: string, s: CancellationSettings) {
  await ensureSeeded(q);
  await q.query(`UPDATE settings SET value=$1, updated_by=$2, updated_at=now() WHERE key='cancellation'`, [JSON.stringify({ defaultAllow: !!s.defaultAllow }), actor]);
  await audit(q, actor, 'settings', 'cancellation', 'CANCELLATION_DEFAULT_CHANGED', { defaultAllow: !!s.defaultAllow });
}

export async function resetRules(q: Queryable, actor: string) {
  await q.query('DELETE FROM cancellation_rules');
  await q.query(`DELETE FROM settings WHERE key='cancellation'`);
  await ensureSeeded(q);
  await audit(q, actor, 'settings', 'cancellation', 'CANCELLATION_RULES_RESET');
}

// ───────────────────────── evaluation ─────────────────────────
export type Facts = Partial<Record<FactId, string | number | boolean | string[] | null>>;
const matches = (c: Condition, facts: Facts): boolean => {
  const v = facts[c.fact];
  if (v === undefined || v === null) return false; // a fact that does not exist for this situation never matches
  const x = c.value;
  switch (c.op) {
    case 'eq': return v === x;
    case 'ne': return v !== x;
    case 'lt': return typeof v === 'number' && v < (x as number);
    case 'lte': return typeof v === 'number' && v <= (x as number);
    case 'gt': return typeof v === 'number' && v > (x as number);
    case 'gte': return typeof v === 'number' && v >= (x as number);
    case 'in': return Array.isArray(x) && x.includes(v as string);
    case 'not_in': return Array.isArray(x) && !x.includes(v as string);
    case 'contains': return Array.isArray(v) && v.includes(x as string);
  }
};
export const ruleMatches = (r: CancellationRule, group: GroupKind, facts: Facts) => r.enabled && (r.group === 'ANY' || r.group === group) && r.when.every((c) => matches(c, facts));

export interface CancellationDecision {
  allow: boolean; rule: { id: string; name: string } | null; message: string;
  /** Kept from the refund, in minor units, for the amount paid. */
  retainedMinor: number; refundBps: number; maxDeductionBps: number;
  /** Would be allowed with the override permission. */
  needsOverride: boolean;
  /** The matched rule itself, so callers can read its conditions (for example the return deadline). */
  matched: CancellationRule | null;
}

export function retained(o: Outcome, paid: number): number {
  let fee = (o.feeFixedMinor ?? 0) + Math.round((paid * (o.feePercentBps ?? 0)) / 10_000);
  if (o.feeMinMinor !== undefined) fee = Math.max(fee, o.feeMinMinor);
  if (o.feeMaxMinor !== undefined) fee = Math.min(fee, o.feeMaxMinor);
  const restock = paid - Math.floor((paid * (o.refundBps ?? 10_000)) / 10_000);
  return Math.min(paid, Math.max(0, fee) + restock);
}

/** The decision for one part: the first enabled matching rule, or the fallback when none matches. */
export function decide(rules: CancellationRule[], settings: CancellationSettings, o: { action: RuleAction; group: GroupKind; facts: Facts; paidMinor: number; canOverride?: boolean }): CancellationDecision {
  const hit = rules.filter((r) => r.action === o.action).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).find((r) => ruleMatches(r, o.group, o.facts));
  if (!hit) {
    return { allow: settings.defaultAllow, rule: null, message: settings.defaultAllow ? '' : 'No cancellation rule allows this.', retainedMinor: 0, refundBps: 10_000, maxDeductionBps: 10_000, needsOverride: false, matched: null };
  }
  const needs = hit.outcome.allow && !!hit.outcome.requiresOverride && !o.canOverride;
  return {
    allow: hit.outcome.allow && !needs, rule: { id: hit.id, name: hit.name },
    message: needs ? 'This needs a supervisor’s approval.' : hit.message ?? describeRule(hit), retainedMinor: hit.outcome.allow ? retained(hit.outcome, o.paidMinor) : 0,
    refundBps: hit.outcome.refundBps ?? 10_000, maxDeductionBps: hit.outcome.maxDeductionBps ?? 10_000, needsOverride: needs, matched: hit,
  };
}

/** For "return within N days": the N the matched rule allows, so screens can show the deadline. */
export function deadlineDays(rule: CancellationRule | null, fact: FactId): number | null {
  const c = rule?.when.find((x) => x.fact === fact && (x.op === 'lte' || x.op === 'lt'));
  return c && typeof c.value === 'number' ? c.value : null;
}

// ───────────────────────── plain-language descriptions ─────────────────────────
const STAGE: Record<GroupKind, Record<string, string>> = {
  GOODS: { PENDING: 'Before the goods ship', LOCKED: 'Once the goods have shipped', DONE: 'Once the goods are delivered' },
  INSTALL: { PENDING: 'Before the technician is dispatched', LOCKED: 'Once the technician is dispatched', DONE: 'Once installed' },
  ACTIVATION: { PENDING: 'Before the service is switched on', LOCKED: 'While the service is being activated', DONE: 'Once the service is switched on' },
};
const money = (n: number, cur: string) => { const f = new Intl.NumberFormat('en', { style: 'currency', currency: cur }); return f.format(n / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2)).replace(/\u00a0/g, ' '); };
const pct = (b: number) => `${b / 100}%`;

function conditionText(c: Condition, group: RuleGroup): string | null {
  const f = FACT.get(c.fact)!;
  const num = (c.value as number);
  const lab = (v: string) => f.values?.find(([k]) => k === v)?.[1] ?? v;
  switch (c.fact) {
    case 'groupStatus': return null; // handled as the opening phrase
    case 'hoursToVisit': return c.op === 'lt' || c.op === 'lte' ? `less than ${num} hours before the visit` : c.op === 'gt' || c.op === 'gte' ? `more than ${num} hours before the visit` : `${num} hours before the visit`;
    case 'daysSinceDelivered': return c.op === 'lte' || c.op === 'lt' ? `within ${num} days of delivery` : `more than ${num} days after delivery`;
    case 'daysOpen': return c.op === 'gte' || c.op === 'gt' ? `after ${num} days` : `within ${num} days`;
    case 'hoursOpen': return c.op === 'gte' || c.op === 'gt' ? `after ${num} hours` : `within ${num} hours`;
    case 'hoursSinceLocked': return c.op === 'gte' || c.op === 'gt' ? `more than ${num} hours after it was sent` : `within ${num} hours of being sent`;
    default: {
      const opText = OPS.find((o) => o[0] === c.op)?.[1] ?? c.op;
      const vals = Array.isArray(c.value) ? c.value.map(lab).join(' or ') : typeof c.value === 'boolean' ? (c.value ? 'yes' : 'no') : f.type === 'enum' ? lab(String(c.value)) : String(c.value);
      return `${f.label.toLowerCase()} ${opText} ${vals}`;
    }
  }
  void group;
}

/** A sentence anyone can read: what the rule does and when. Used on the settings screen, in the order wizard's terms, and as the default customer message. */
export function describeRule(r: CancellationRule, currency = 'SGD'): string {
  const status = r.when.find((c) => c.fact === 'groupStatus');
  const kind = r.group === 'ANY' ? 'GOODS' : r.group;
  const stage = status && (status.op === 'eq' || status.op === 'in') ? [...(Array.isArray(status.value) ? status.value : [status.value])].map((v) => STAGE[kind][String(v)] ?? String(v)).map((t, i) => (i ? t.charAt(0).toLowerCase() + t.slice(1) : t)).join(' or ') : '';
  const rest = r.when.map((c) => conditionText(c, r.group)).filter((x): x is string => !!x);
  const subject = [stage, ...rest].filter(Boolean).join(', ') || 'In every case';
  const o = r.outcome;
  let what: string;
  if (r.action === 'FLAG_AT_RISK') what = 'the order is flagged as at risk for follow-up';
  else if (r.action === 'AUTO_CANCEL') what = `it is cancelled automatically${o.refundBps !== undefined && o.refundBps < 10_000 ? ` with ${pct(o.refundBps)} refunded` : ' with a full refund'}`;
  else if (!o.allow) what = r.action === 'RETURN' ? 'it cannot be returned' : 'it cannot be cancelled';
  else {
    const bits: string[] = [];
    const fee = retained({ ...o, refundBps: 10_000 }, 0);
    if ((o.feeFixedMinor ?? 0) > 0 || (o.feePercentBps ?? 0) > 0) bits.push(`${[o.feeFixedMinor ? money(o.feeFixedMinor, currency) : '', o.feePercentBps ? `${pct(o.feePercentBps)} of what was paid` : ''].filter(Boolean).join(' plus ')} is kept`);
    void fee;
    if (o.refundBps !== undefined && o.refundBps < 10_000) bits.push(`${pct(o.refundBps)} is refunded`);
    what = `${r.action === 'RETURN' ? 'it can be returned' : 'it can be cancelled'}${bits.length ? `; ${bits.join(', ')}` : ' for a full refund'}${o.requiresOverride ? ' (needs supervisor approval)' : ''}`;
  }
  return `${subject}: ${what}.`.replace(/^([a-z])/, (m) => m.toUpperCase());
}

/** What the customer is told per part of the order: the enabled rules that apply, in the order they are tried. */
export async function termsFor(q: Queryable, kinds: GroupKind[], currency: string): Promise<Array<{ group: GroupKind; title: string; text: string }>> {
  const rules = (await listRules(q)).filter((r) => r.enabled && r.showInTerms);
  const TITLE: Record<GroupKind, string> = { GOODS: 'Device and goods', INSTALL: 'Installation', ACTIVATION: 'Mobile and other services' };
  const ACTION_ORDER: RuleAction[] = ['CANCEL', 'RETURN', 'AUTO_CANCEL'];
  return kinds.map((g) => {
    const mine = rules.filter((r) => (r.group === g || r.group === 'ANY') && ACTION_ORDER.includes(r.action)).sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.priority - b.priority);
    return { group: g, title: TITLE[g], text: mine.map((r) => r.message ?? describeRule(r, currency)).join(' ') || 'This part cannot be cancelled once the order is placed.' };
  });
}

/** The age (in days) at which an open part is cancelled automatically, if an enabled rule says so; used to tell customers how long an installation can take. */
export async function autoCancelDays(q: Queryable, group: GroupKind): Promise<number | null> {
  const r = (await listRules(q)).find((x) => x.enabled && x.action === 'AUTO_CANCEL' && (x.group === group || x.group === 'ANY'));
  const c = r?.when.find((x) => x.fact === 'daysOpen' && (x.op === 'gte' || x.op === 'gt'));
  return c && typeof c.value === 'number' ? c.value : null;
}

/** For the settings simulator: every rule that is tried for this situation, in order, with whether it matched and which condition stopped it. */
export function explain(rules: CancellationRule[], o: { action: RuleAction; group: GroupKind; facts: Facts }) {
  return rules.filter((r) => r.action === o.action).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map((r) => {
    const inScope = r.group === 'ANY' || r.group === o.group;
    const failed = !r.enabled ? null : !inScope ? null : r.when.find((c) => !matches(c, o.facts)) ?? null;
    return { id: r.id, name: r.name, matched: ruleMatches(r, o.group, o.facts), reason: !r.enabled ? 'switched off' : !inScope ? 'applies to a different part' : failed ? `condition not met: ${conditionText(failed, r.group) ?? 'the part is not at the right stage'}` : null };
  });
}

export async function simulate(q: Queryable, o: { action: RuleAction; group: GroupKind; facts: Facts; paidMinor: number; canOverride?: boolean; currency?: string }) {
  const rules = await listRules(q);
  const settings = await getCancellationSettings(q);
  const facts: Facts = { ...o.facts, paidMinor: o.paidMinor };
  const decision = decide(rules, settings, { action: o.action, group: o.group, facts, paidMinor: o.paidMinor, canOverride: o.canOverride });
  return { decision: { ...decision, matched: undefined, summary: decision.matched ? describeRule(decision.matched, o.currency) : decision.message, refundMinor: decision.allow ? Math.max(0, o.paidMinor - decision.retainedMinor) : 0 }, trace: explain(rules, { action: o.action, group: o.group, facts }) };
}

/** For the rule editor: what is wrong with a draft (if anything), and how it reads in plain words, without saving it. */
export function previewRule(r: CancellationRule, currency: string): { errors: string[]; sentence: string } {
  const errors = validateCancellationRule(r);
  let sentence = '';
  try { sentence = describeRule(r, currency); } catch { sentence = ''; }
  return { errors, sentence };
}
