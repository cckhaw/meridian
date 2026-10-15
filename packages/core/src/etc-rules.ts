import type { EtcQuote } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { compileFormula, ETC_VARIABLES, evaluateFormula } from './etc-formula.js';
import { monthsElapsed } from './etc.js';

/**
 * Early termination charge rules (Settings → Early termination). A rule says for which scenario and which kind of contract it applies and gives the formula that
 * works out the charge. Where no rule is switched on, the contract terms on each offer decide, as before. Where rules are on and none fits, the offer's terms
 * decide the charge, and unpaid device instalments are collected in full.
 */
export const ETC_SCENARIOS = [
  { id: 'CUSTOMER_REQUEST', label: 'Customer ends the contract early' },
  { id: 'PORT_OUT', label: 'Customer moves the number to another operator' },
  { id: 'NON_PAYMENT', label: 'Terminated by us for non-payment' },
  { id: 'PLAN_DOWNGRADE', label: 'Customer moves to a cheaper plan during the contract' },
  { id: 'OWNERSHIP_TRANSFER', label: 'Contract is transferred to a new owner' },
  { id: 'RELOCATION', label: 'Customer moves to where we have no service' },
  { id: 'HARDSHIP', label: 'Death, serious illness or hardship' },
  { id: 'OPERATOR_FAULT', label: 'Persistent fault on our side' },
  { id: 'FORCE_MAJEURE', label: 'Force majeure or regulatory change' },
] as const;
export type EtcScenario = (typeof ETC_SCENARIOS)[number]['id'];
export const isScenario = (s: string): s is EtcScenario => ETC_SCENARIOS.some((x) => x.id === s);

export interface EtcRule {
  id: string; code: string; name: string; description: string; enabled: boolean; priority: number;
  scenarios: string[]; segments: string[]; device: 'ANY' | 'WITH_DEVICE' | 'NO_DEVICE'; vip: 'ANY' | 'YES' | 'NO';
  minTerm: number | null; maxTerm: number | null; minElapsed: number | null; maxElapsed: number | null;
  formula: string; minChargeMinor: number; maxChargeMinor: number | null; waiveLastMonths: number; deviceBalancePercent: number; applyVipMultiplier: boolean;
  version: number; updatedAt: string;
}
export type EtcRuleInput = Omit<EtcRule, 'id' | 'version' | 'updatedAt'>;
const ruleOf = (r: Row): EtcRule => ({
  id: r.id, code: r.code, name: r.name, description: r.description, enabled: r.enabled, priority: r.priority, scenarios: r.scenarios, segments: r.segments, device: r.device, vip: r.vip,
  minTerm: r.minTerm, maxTerm: r.maxTerm, minElapsed: r.minElapsed, maxElapsed: r.maxElapsed, formula: r.formula, minChargeMinor: Number(r.minChargeMinor), maxChargeMinor: r.maxChargeMinor === null ? null : Number(r.maxChargeMinor),
  waiveLastMonths: r.waiveLastMonths, deviceBalancePercent: r.deviceBalancePercent, applyVipMultiplier: r.applyVipMultiplier, version: r.version, updatedAt: String(r.updatedAt),
});

export const listEtcRules = async (q: Queryable): Promise<EtcRule[]> => (await q.query('SELECT * FROM etc_rules ORDER BY priority DESC, name')).rows.map(ruleOf);
export const etcEngineActive = async (q: Queryable): Promise<boolean> => (await q.query('SELECT 1 FROM etc_rules WHERE enabled LIMIT 1')).rows.length > 0;

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
export function etcRuleProblems(r: Partial<EtcRuleInput>): string[] {
  const p: string[] = [];
  if (!r.name?.trim() || r.name.length > 80) p.push('Give the rule a name of up to 80 characters.');
  if (!Number.isInteger(r.priority) || (r.priority as number) < 0 || (r.priority as number) > 10000) p.push('Priority is a whole number from 0 to 10,000.');
  for (const s of r.scenarios ?? []) if (!isScenario(s)) p.push(`Unknown scenario ${s}.`);
  for (const [a, b, l] of [[r.minTerm, r.maxTerm, 'contract length'], [r.minElapsed, r.maxElapsed, 'months served']] as const) {
    for (const v of [a, b]) if (v !== null && v !== undefined && (!Number.isInteger(v) || v < 0 || v > 120)) p.push(`The ${l} limits are whole months from 0 to 120.`);
    if (a !== null && a !== undefined && b !== null && b !== undefined && a > b) p.push(`The ${l} range runs backwards.`);
  }
  try { compileFormula(r.formula ?? ''); } catch (e) { p.push(`Formula: ${(e as Error).message}`); }
  if (!Number.isInteger(r.minChargeMinor) || (r.minChargeMinor as number) < 0) p.push('The least charge is zero or more.');
  if (r.maxChargeMinor !== null && r.maxChargeMinor !== undefined && (!Number.isInteger(r.maxChargeMinor) || r.maxChargeMinor < (r.minChargeMinor ?? 0))) p.push('The most charge cannot be less than the least.');
  if (!Number.isInteger(r.waiveLastMonths) || (r.waiveLastMonths as number) < 0 || (r.waiveLastMonths as number) > 60) p.push('Waive in the last months: 0 to 60.');
  if (!Number.isInteger(r.deviceBalancePercent) || (r.deviceBalancePercent as number) < 0 || (r.deviceBalancePercent as number) > 100) p.push('The share of device instalments collected is 0 to 100%.');
  if (!['ANY', 'WITH_DEVICE', 'NO_DEVICE'].includes(r.device ?? '')) p.push('Device is any, with a device, or without.');
  if (!['ANY', 'YES', 'NO'].includes(r.vip ?? '')) p.push('VIP is any, yes or no.');
  return p;
}
export async function saveEtcRule(q: Queryable, actor: string, input: EtcRuleInput, id?: string): Promise<EtcRule> {
  const r: EtcRuleInput = { ...input, name: input.name?.trim(), scenarios: [...new Set(input.scenarios ?? [])], segments: [...new Set(input.segments ?? [])], description: input.description ?? '' };
  const problems = etcRuleProblems(r);
  if (problems.length) throw invalid(problems.slice(0, 5).join(' '), problems);
  const args = [r.name, r.description, r.enabled, r.priority, r.scenarios, r.segments, r.device, r.vip, r.minTerm, r.maxTerm, r.minElapsed, r.maxElapsed, r.formula.trim(), r.minChargeMinor, r.maxChargeMinor, r.waiveLastMonths, r.deviceBalancePercent, r.applyVipMultiplier];
  if (id) {
    const row = (await q.query(`UPDATE etc_rules SET name=$2, description=$3, enabled=$4, priority=$5, scenarios=$6, segments=$7, device=$8, vip=$9, min_term=$10, max_term=$11, min_elapsed=$12, max_elapsed=$13, formula=$14, min_charge_minor=$15, max_charge_minor=$16, waive_last_months=$17, device_balance_percent=$18, apply_vip_multiplier=$19, version=version+1, updated_by=$20, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...args, actor])).rows[0];
    if (!row) throw notFound('rule', id);
    await audit(q, actor, 'etc_rule', id, 'UPDATE', { name: r.name, formula: r.formula });
    return ruleOf(row);
  }
  let code = slug(input.code || r.name);
  if ((await q.query('SELECT 1 FROM etc_rules WHERE code=$1', [code])).rows.length) code += `-${Math.random().toString(36).slice(2, 5)}`;
  const row = (await q.query(`INSERT INTO etc_rules (code, name, description, enabled, priority, scenarios, segments, device, vip, min_term, max_term, min_elapsed, max_elapsed, formula, min_charge_minor, max_charge_minor, waive_last_months, device_balance_percent, apply_vip_multiplier, updated_by) VALUES ($20,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`, [...args, actor, code])).rows[0]!;
  await audit(q, actor, 'etc_rule', row.id, 'CREATE', { name: r.name, formula: r.formula });
  return ruleOf(row);
}
export async function deleteEtcRule(q: Queryable, actor: string, id: string) {
  const r = await q.query('DELETE FROM etc_rules WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('rule', id);
  await audit(q, actor, 'etc_rule', id, 'DELETE');
  return { ok: true };
}

/** The standard set: the usual situations with sensible formulas, to start from. Existing rules (by code) are left alone. */
export const STANDARD_ETC_RULES: Array<Omit<EtcRuleInput, 'enabled'> & { code: string }> = [
  { code: 'customer-early-with-device', name: 'Customer leaves early (device on contract)', description: 'The subsidy not yet earned back, plus a quarter of the plan fees still to run.', priority: 100, scenarios: ['CUSTOMER_REQUEST', 'PORT_OUT'], segments: [], device: 'WITH_DEVICE', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: 'subsidy * remaining / term + monthlyFee * remaining * 0.25', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 1, deviceBalancePercent: 100, applyVipMultiplier: true },
  { code: 'customer-early-plan-only', name: 'Customer leaves early (plan only)', description: 'Half of the plan fees still to run.', priority: 90, scenarios: ['CUSTOMER_REQUEST', 'PORT_OUT'], segments: [], device: 'NO_DEVICE', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: 'monthlyFee * remaining * 0.5', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 1, deviceBalancePercent: 100, applyVipMultiplier: true },
  { code: 'non-payment', name: 'Terminated for non-payment', description: 'The unearned subsidy and all the unpaid device instalments; the plan fees are not charged on top.', priority: 100, scenarios: ['NON_PAYMENT'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: 'subsidy * remaining / term', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 100, applyVipMultiplier: false },
  { code: 'downgrade-in-contract', name: 'Cheaper plan during the contract', description: 'A fee for the difference in plan price over the months still to run, a third of it.', priority: 100, scenarios: ['PLAN_DOWNGRADE'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: 'max(0, monthlyFee - newMonthlyFee) * remaining / 3', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 1, deviceBalancePercent: 0, applyVipMultiplier: false },
  { code: 'ownership-transfer', name: 'Contract transferred to a new owner', description: 'No charge: the contract continues.', priority: 100, scenarios: ['OWNERSHIP_TRANSFER'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: '0', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 0, applyVipMultiplier: false },
  { code: 'relocation', name: 'Customer moves where we have no service', description: 'The unearned subsidy only.', priority: 100, scenarios: ['RELOCATION'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: 'subsidy * remaining / term', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 100, applyVipMultiplier: false },
  { code: 'hardship', name: 'Death, serious illness or hardship', description: 'No early termination charge; the device is still paid for.', priority: 100, scenarios: ['HARDSHIP'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: '0', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 100, applyVipMultiplier: false },
  { code: 'operator-fault', name: 'Persistent fault on our side', description: 'No charge, and the device balance is waived.', priority: 100, scenarios: ['OPERATOR_FAULT', 'FORCE_MAJEURE'], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null,
    formula: '0', minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 0, applyVipMultiplier: false },
];
export async function seedStandardEtcRules(q: Queryable, actor: string): Promise<{ created: string[]; skipped: string[] }> {
  const have = new Set((await q.query('SELECT code FROM etc_rules')).rows.map((r) => r.code as string));
  const out = { created: [] as string[], skipped: [] as string[] };
  for (const r of STANDARD_ETC_RULES) {
    if (have.has(r.code)) { out.skipped.push(r.code); continue; }
    await saveEtcRule(q, actor, { ...r, enabled: true });
    out.created.push(r.code);
  }
  return out;
}

// ───────────────────────── working out a charge ─────────────────────────
export interface EtcFigures { term: number; elapsed: number; remaining: number; monthlyFee: number; subsidy: number; retailPrice: number; deviceBalance: number; deviceInstalment: number; newMonthlyFee: number; vipMultiplier: number }
export interface EtcContext { scenario: EtcScenario; segment?: string | null; vip?: boolean; hasDevice: boolean }

const matches = (r: EtcRule, c: EtcContext, f: EtcFigures) =>
  r.enabled && (!r.scenarios.length || r.scenarios.includes(c.scenario)) && (!r.segments.length || (!!c.segment && r.segments.includes(c.segment)))
  && (r.device === 'ANY' || (r.device === 'WITH_DEVICE') === c.hasDevice) && (r.vip === 'ANY' || (r.vip === 'YES') === !!c.vip)
  && (r.minTerm === null || f.term >= r.minTerm) && (r.maxTerm === null || f.term <= r.maxTerm) && (r.minElapsed === null || f.elapsed >= r.minElapsed) && (r.maxElapsed === null || f.elapsed <= r.maxElapsed);
const specificity = (r: EtcRule) => r.scenarios.length + r.segments.length + (r.device !== 'ANY' ? 1 : 0) + (r.vip !== 'ANY' ? 1 : 0) + [r.minTerm, r.maxTerm, r.minElapsed, r.maxElapsed].filter((x) => x !== null).length;
export function pickEtcRule(rules: EtcRule[], c: EtcContext, f: EtcFigures): EtcRule | null {
  return rules.filter((r) => matches(r, c, f)).sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a) || a.name.localeCompare(b.name))[0] ?? null;
}
export const figureVars = (f: EtcFigures): Record<string, number> => ({ ...f });

/** Works the charge out for one rule and these figures. */
export function applyEtcRule(r: EtcRule, f: EtcFigures, c: EtcContext, base: { offerId: string; currency: string }): EtcQuote {
  const q: EtcQuote = { offerId: base.offerId, currency: base.currency, monthsElapsed: f.elapsed, monthsRemaining: f.remaining, chargeMinor: 0, waived: false, scenario: c.scenario, rule: { id: r.id, code: r.code, name: r.name, formula: r.formula } };
  const balance = Math.round((f.deviceBalance * r.deviceBalancePercent) / 100);
  if (balance > 0) q.deviceBalanceMinor = balance;
  if (f.remaining <= 0 || (r.waiveLastMonths > 0 && f.remaining <= r.waiveLastMonths)) { q.waived = f.remaining > 0; return q; }
  let charge = Math.round(evaluateFormula(r.formula, figureVars(f)));
  charge = Math.max(charge, r.minChargeMinor, 0);
  if (r.maxChargeMinor !== null) charge = Math.min(charge, r.maxChargeMinor);
  if (r.applyVipMultiplier && f.vipMultiplier !== 1 && charge > 0) { charge = Math.round(charge * f.vipMultiplier); q.vipMultiplierBps = Math.round(f.vipMultiplier * 10000); }
  q.chargeMinor = charge; q.waived = charge === 0;
  return q;
}

/** The figures a formula sees for a running service. */
export async function figuresForService(q: Queryable, s: Row, when: Date, o: { newMonthlyFee?: number } = {}): Promise<{ figures: EtcFigures; ctx: Omit<EtcContext, 'scenario'>; currency: string }> {
  const deal = s.deal as { termMonths: number; subsidyMinor: number; retailMinor?: number; currency: string } | null;
  const term = Number(deal?.termMonths ?? s.contractTermMonths ?? 0);
  const elapsed = s.contractStart ? monthsElapsed(new Date(s.contractStart), when, term) : 0;
  const offer = (await q.query('SELECT data FROM catalog_nodes WHERE id=$1', [s.offerId])).rows[0];
  const fee = (offer?.data?.prices as Array<{ type: string; amount: { amountMinor: number; currency: string }; periodMonths?: number }> | undefined)?.find((p) => p.type === 'RECURRING');
  const charges = (await q.query(`SELECT COALESCE(sum(amount_minor * remaining_cycles),0) AS balance, COALESCE(sum(amount_minor) FILTER (WHERE kind='INSTALLMENT'),0) AS instalment FROM service_charges WHERE service_id=$1 AND kind='INSTALLMENT' AND remaining_cycles > 0`, [s.id])).rows[0]!;
  const cust = (await q.query('SELECT segment, vip FROM customers WHERE id=$1', [s.customerId])).rows[0];
  const balance = Number(charges.balance);
  return {
    figures: { term, elapsed, remaining: Math.max(term - elapsed, 0), monthlyFee: fee ? Math.round(fee.amount.amountMinor / (fee.periodMonths ?? 1)) : 0, subsidy: Number(deal?.subsidyMinor ?? 0), retailPrice: Number(deal?.retailMinor ?? 0),
      deviceBalance: balance, deviceInstalment: Number(charges.instalment), newMonthlyFee: o.newMonthlyFee ?? 0, vipMultiplier: s.vipEtcBps && s.vipEtcBps !== 10000 ? s.vipEtcBps / 10000 : 1 },
    ctx: { segment: cust?.segment ?? null, vip: !!cust?.vip, hasDevice: !!deal || balance > 0 },
    currency: deal?.currency ?? fee?.amount.currency ?? 'USD',
  };
}

/** A service's charge by the rules in force. Null when rules are off or none fits (the caller then uses the offer's own terms). */
export async function etcByRules(q: Queryable, s: Row, when: Date, scenario: EtcScenario, o: { newMonthlyFee?: number } = {}): Promise<EtcQuote | null> {
  const rules = (await listEtcRules(q)).filter((r) => r.enabled);
  if (!rules.length) return null;
  const { figures, ctx, currency } = await figuresForService(q, s, when, o);
  const rule = pickEtcRule(rules, { ...ctx, scenario }, figures);
  return rule ? applyEtcRule(rule, figures, { ...ctx, scenario }, { offerId: s.offerId, currency }) : null;
}

/** Try figures against the rules without a real service: what the Settings page's "Try it" shows. */
export async function previewEtc(q: Queryable, i: { scenario: EtcScenario; segment?: string; vip?: boolean; hasDevice?: boolean; figures: Partial<EtcFigures>; ruleId?: string; formula?: string }) {
  const f: EtcFigures = { term: 24, elapsed: 8, remaining: 0, monthlyFee: 0, subsidy: 0, retailPrice: 0, deviceBalance: 0, deviceInstalment: 0, newMonthlyFee: 0, vipMultiplier: 1, ...i.figures };
  f.remaining = i.figures.remaining ?? Math.max(f.term - f.elapsed, 0);
  const ctx: EtcContext = { scenario: i.scenario, segment: i.segment ?? null, vip: !!i.vip, hasDevice: i.hasDevice ?? (f.subsidy > 0 || f.deviceBalance > 0) };
  const rules = await listEtcRules(q);
  let rule = i.ruleId ? rules.find((r) => r.id === i.ruleId) ?? null : pickEtcRule(rules, ctx, f);
  if (!rule && i.formula) rule = { id: 'draft', code: 'draft', name: 'Draft', description: '', enabled: true, priority: 0, scenarios: [], segments: [], device: 'ANY', vip: 'ANY', minTerm: null, maxTerm: null, minElapsed: null, maxElapsed: null, formula: i.formula, minChargeMinor: 0, maxChargeMinor: null, waiveLastMonths: 0, deviceBalancePercent: 100, applyVipMultiplier: true, version: 1, updatedAt: '' };
  if (i.formula && rule) rule = { ...rule, formula: i.formula };
  if (!rule) return { matched: false, figures: f };
  try { return { matched: true, figures: f, quote: applyEtcRule(rule, f, ctx, { offerId: 'preview', currency: 'USD' }) }; }
  catch (e) { return { matched: true, figures: f, error: (e as Error).message }; }
}
export { ETC_VARIABLES, conflict };
