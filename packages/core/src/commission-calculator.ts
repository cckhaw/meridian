import { invalid } from './errors.js';

/**
 * The commission rule engine. Pure: it takes a plan, the facts of a completed sale and how many activations the seller already has this month, and returns the ledger
 * entries to write. Nothing here reads or writes the database, so a plan can be tested, previewed in the portal and replayed without side effects.
 */
export const DEALER_TIERS = ['MASTER_DISTRIBUTOR', 'DEALER', 'SUB_DEALER', 'FRANCHISE'] as const;
export type DealerTier = (typeof DEALER_TIERS)[number];
export type BeneficiaryKind = 'DEALER' | 'STAFF' | 'STORE' | 'HOUSE';
export const CLAWBACK_TRIGGERS = ['TERMINATION', 'PORT_OUT', 'ORDER_CANCELLED'] as const;
export type ClawbackTrigger = (typeof CLAWBACK_TRIGGERS)[number];

/** A volume band, counted in activations per beneficiary per month. `to` null means "and above". */
export interface Slab { from: number; to: number | null; rateBps?: number; fixedMinor?: number; /** Paid once at month close to a beneficiary who reached this band. */ bonusMinor?: number }
export interface PlanRule {
  id: string; name: string; priority: number;
  matchKinds: string[]; matchOfferIds: string[]; minTermMonths: number | null; maxTermMonths: number | null; matchTiers: string[];
  calc: 'PERCENT' | 'FIXED'; rateBps: number; fixedMinor: number;
  /** MARGINAL: each activation earns the rate of the band its position falls in. RETROACTIVE: reaching a band lifts every activation of the month to that band's rate (the difference is paid at month close). */
  slabMode: 'MARGINAL' | 'RETROACTIVE'; slabs: Slab[]; status: 'ACTIVE' | 'INACTIVE';
}
export interface ClawbackTier { withinDays: number; percentBps: number }
export interface ClawbackPolicy { id: string; name: string; minTermMonths: number | null; triggers: string[]; tiers: ClawbackTier[]; includeOverrides: boolean; status: 'ACTIVE' | 'INACTIVE' }
export interface Plan { id: string; name: string; holdDays: number; overrideBps: number[]; rules: PlanRule[]; clawbacks: ClawbackPolicy[] }

export interface SaleLine { lineId: string; offerId: string; offerKind: string; termMonths: number; quantity: number; /** What the sale is worth to the seller (net, plus the first month of any plan). */ basisMinor: number; /** A plan or other service line: counts as an activation. */ createsService: boolean }
export interface Sale { orderId: string; completedOn: string; currency: string; lines: SaleLine[] }
export interface Seller {
  kind: BeneficiaryKind; id: string; tier?: string | null; dealerId?: string | null; dealerAgentId?: string | null; storeId?: string | null;
  /** The sellers above this dealer, nearest first, for override commission. */
  uplines: Array<{ dealerId: string; tier: string }>;
}
export type EntryType = 'EARNING' | 'OVERRIDE';
export interface DraftEntry {
  beneficiaryKind: BeneficiaryKind; beneficiaryId: string; dealerId: string | null; dealerAgentId: string | null; storeId: string | null;
  entryType: EntryType; amountMinor: number; basisMinor: number; rateBps: number | null; units: number;
  planId: string; ruleId: string | null; orderLineId: string; offerId: string; calc: Record<string, unknown>;
}

const specificity = (r: PlanRule) => (r.matchOfferIds.length ? 8 : 0) + (r.matchKinds.length ? 4 : 0) + (r.minTermMonths != null || r.maxTermMonths != null ? 2 : 0) + (r.matchTiers.length ? 1 : 0);

export function commissionRuleMatches(r: PlanRule, l: SaleLine, tier: string | null | undefined): boolean {
  if (r.status !== 'ACTIVE') return false;
  if (r.matchOfferIds.length && !r.matchOfferIds.includes(l.offerId)) return false;
  if (r.matchKinds.length && !r.matchKinds.includes(l.offerKind)) return false;
  if (r.minTermMonths != null && l.termMonths < r.minTermMonths) return false;
  if (r.maxTermMonths != null && l.termMonths > r.maxTermMonths) return false;
  if (r.matchTiers.length && !(tier && r.matchTiers.includes(tier))) return false;
  return true;
}
/** The one rule a sale line is paid by: the most specific, then the lowest priority number, then the name (so the choice never depends on row order). */
export function pickCommissionRule(rules: PlanRule[], l: SaleLine, tier?: string | null): PlanRule | null {
  let best: PlanRule | null = null;
  for (const r of rules) {
    if (!commissionRuleMatches(r, l, tier)) continue;
    if (!best) { best = r; continue; }
    const a = specificity(r), b = specificity(best);
    if (a > b || (a === b && (r.priority < best.priority || (r.priority === best.priority && r.name < best.name)))) best = r;
  }
  return best;
}

export const slabAt = (slabs: Slab[], position: number): Slab | null => slabs.find((s) => position >= s.from && (s.to == null || position <= s.to)) ?? null;
const unitBasis = (basis: number, qty: number, i: number) => { const each = Math.floor(basis / qty); return i === qty - 1 ? basis - each * (qty - 1) : each; };

export interface CommissionSegment { units: number; slab: string | null; rateBps?: number; fixedMinor?: number; amountMinor: number }

export class CommissionCalculator {
  /**
   * The ledger entries a completed sale earns under `plan`. `countBefore(rule)` is how many activations the seller already has this month under that rule
   * (the position in the slabs). Lines no rule covers earn nothing.
   */
  static calculate(plan: Plan, sale: Sale, seller: Seller, countBefore: (ruleId: string) => number): DraftEntry[] {
    const out: DraftEntry[] = [];
    const running = new Map<string, number>();
    for (const line of sale.lines) {
      if (line.quantity < 1 || line.basisMinor < 0) continue;
      const rule = pickCommissionRule(plan.rules, line, seller.tier);
      if (!rule) continue;
      const base = running.get(rule.id) ?? countBefore(rule.id);
      const segments: CommissionSegment[] = [];
      let amount = 0;
      for (let i = 0; i < line.quantity; i++) {
        const position = base + (line.createsService ? i + 1 : 0);
        const slab = line.createsService ? slabAt(rule.slabs, position) : null;
        const ub = unitBasis(line.basisMinor, line.quantity, i);
        let a: number, rateBps: number | undefined, fixedMinor: number | undefined;
        if (rule.calc === 'PERCENT') { rateBps = slab?.rateBps ?? rule.rateBps; a = Math.round((ub * rateBps) / 10_000); } else { fixedMinor = slab?.fixedMinor ?? rule.fixedMinor; a = fixedMinor; }
        amount += a;
        const label = slab ? `${slab.from}-${slab.to ?? 'and above'}` : null;
        const last = segments[segments.length - 1];
        if (last && last.slab === label && last.rateBps === rateBps && last.fixedMinor === fixedMinor) { last.units++; last.amountMinor += a; } else segments.push({ units: 1, slab: label, rateBps, fixedMinor, amountMinor: a });
      }
      if (line.createsService) running.set(rule.id, base + line.quantity);
      const effective = rule.calc === 'PERCENT' && line.basisMinor > 0 ? Math.round((amount * 10_000) / line.basisMinor) : null;
      out.push({
        beneficiaryKind: seller.kind, beneficiaryId: seller.id, dealerId: seller.dealerId ?? null, dealerAgentId: seller.dealerAgentId ?? null, storeId: seller.storeId ?? null,
        entryType: 'EARNING', amountMinor: amount, basisMinor: line.basisMinor, rateBps: effective, units: line.createsService ? line.quantity : 0,
        planId: plan.id, ruleId: rule.id, orderLineId: line.lineId, offerId: line.offerId,
        calc: { rule: rule.name, calc: rule.calc, slabMode: rule.slabMode, termMonths: line.termMonths, kind: line.offerKind, positionFrom: line.createsService ? base + 1 : null, segments },
      });
      // Override commission: what each level of upline earns on the same sale.
      seller.uplines.slice(0, plan.overrideBps.length).forEach((up, i) => {
        const bps = plan.overrideBps[i] ?? 0;
        const amt = Math.round((line.basisMinor * bps) / 10_000);
        if (bps > 0 && amt > 0) out.push({
          beneficiaryKind: 'DEALER', beneficiaryId: up.dealerId, dealerId: up.dealerId, dealerAgentId: null, storeId: null,
          entryType: 'OVERRIDE', amountMinor: amt, basisMinor: line.basisMinor, rateBps: bps, units: 0, planId: plan.id, ruleId: null, orderLineId: line.lineId, offerId: line.offerId,
          calc: { override: i + 1, from: seller.id, tier: up.tier },
        });
      });
    }
    return out;
  }

  /** The band a month's total activations reached, which a RETROACTIVE rule pays every activation at. */
  static finalSlab(rule: PlanRule, totalUnits: number): Slab | null { return totalUnits > 0 ? slabAt(rule.slabs, totalUnits) : null; }

  /** What a RETROACTIVE rule should have paid for the month, given its earnings so far (`basis` and `units` per earning), so the month-close accelerator can pay the difference. */
  static retroactiveTarget(rule: PlanRule, earnings: Array<{ basisMinor: number; units: number }>): { totalUnits: number; slab: Slab | null; targetMinor: number } {
    const totalUnits = earnings.reduce((s, e) => s + e.units, 0);
    const slab = CommissionCalculator.finalSlab(rule, totalUnits);
    if (!slab || rule.slabMode !== 'RETROACTIVE') return { totalUnits, slab, targetMinor: 0 };
    let target = 0;
    for (const e of earnings) {
      if (e.units <= 0) continue;
      target += rule.calc === 'PERCENT' ? Math.round((e.basisMinor * (slab.rateBps ?? rule.rateBps)) / 10_000) : e.units * (slab.fixedMinor ?? rule.fixedMinor);
    }
    return { totalUnits, slab, targetMinor: target };
  }

  /** The one-off bonus a month's volume earns (the band reached, not the sum of bands). */
  static bonusFor(rule: PlanRule, totalUnits: number): number { return CommissionCalculator.finalSlab(rule, totalUnits)?.bonusMinor ?? 0; }
}

// ───────────────────────── claw-backs ─────────────────────────
/** The policy that governs a clawback: active, covers the trigger, fits the contract length; the one with the longest minimum term wins. */
export function pickPolicy(policies: ClawbackPolicy[], trigger: string, termMonths: number): ClawbackPolicy | null {
  let best: ClawbackPolicy | null = null;
  for (const p of policies) {
    if (p.status !== 'ACTIVE' || !p.triggers.includes(trigger) || (p.minTermMonths != null && termMonths < p.minTermMonths)) continue;
    if (!best || (p.minTermMonths ?? -1) > (best.minTermMonths ?? -1)) best = p;
  }
  return best;
}
/** Share of the commission taken back (basis points) when the service ends `days` after it began: the first window it falls inside, or nothing once past the last one. */
export function clawbackBps(policy: ClawbackPolicy, days: number): number {
  const tiers = [...policy.tiers].sort((a, b) => a.withinDays - b.withinDays);
  return tiers.find((t) => days <= t.withinDays)?.percentBps ?? 0;
}

// ───────────────────────── validation ─────────────────────────
const int = (v: unknown, what: string, min = 0, max = 100_000_000): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw invalid(`${what} must be a whole number from ${min} to ${max}`);
  return v;
};
const strings = (v: unknown, what: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 80)) throw invalid(`${what} is a list of names`);
  return [...new Set((v as string[]).map((x) => x.trim()))];
};
export function cleanSlabs(raw: unknown): Slab[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw invalid('slabs is a list');
  if (raw.length > 12) throw invalid('at most 12 volume bands');
  const slabs = raw.map((s: Slab, i): Slab => {
    const from = int(s.from, `band ${i + 1} from`, 1, 1_000_000);
    const to = s.to == null ? null : int(s.to, `band ${i + 1} to`, from, 1_000_000);
    const out: Slab = { from, to };
    if (s.rateBps != null) out.rateBps = int(s.rateBps, `band ${i + 1} rate`, 0, 10_000);
    if (s.fixedMinor != null) out.fixedMinor = int(s.fixedMinor, `band ${i + 1} amount`);
    if (s.bonusMinor != null) out.bonusMinor = int(s.bonusMinor, `band ${i + 1} bonus`);
    return out;
  }).sort((a, b) => a.from - b.from);
  slabs.forEach((s, i) => {
    const next = slabs[i + 1];
    if (s.to == null && next) throw invalid('only the last band can be open-ended ("and above")');
    if (next && s.to != null && next.from <= s.to) throw invalid(`bands ${i + 1} and ${i + 2} overlap`);
  });
  return slabs;
}
export interface RuleDraft { name: string; priority?: number; matchKinds?: string[]; matchOfferIds?: string[]; minTermMonths?: number | null; maxTermMonths?: number | null; matchTiers?: string[]; calc?: 'PERCENT' | 'FIXED'; rateBps?: number; fixedMinor?: number; slabMode?: 'MARGINAL' | 'RETROACTIVE'; slabs?: Slab[]; status?: 'ACTIVE' | 'INACTIVE' }
export function cleanRuleDraft(i: RuleDraft): Omit<PlanRule, 'id'> {
  const name = i.name?.trim();
  if (!name || name.length > 120) throw invalid('a rule needs a name (up to 120 characters)');
  const calc = i.calc ?? 'PERCENT';
  if (calc !== 'PERCENT' && calc !== 'FIXED') throw invalid('a rule pays a percentage of the sale or a fixed amount per activation');
  const slabMode = i.slabMode ?? 'MARGINAL';
  if (slabMode !== 'MARGINAL' && slabMode !== 'RETROACTIVE') throw invalid('volume bands are marginal or retroactive');
  const min = i.minTermMonths == null ? null : int(i.minTermMonths, 'minimum contract months', 0, 120);
  const max = i.maxTermMonths == null ? null : int(i.maxTermMonths, 'maximum contract months', 0, 120);
  if (min != null && max != null && max < min) throw invalid('the maximum contract length is below the minimum');
  const tiers = strings(i.matchTiers, 'seller tiers');
  for (const t of tiers) if (!(DEALER_TIERS as readonly string[]).includes(t)) throw invalid(`unknown seller tier ${t}`);
  const out = {
    name, priority: i.priority == null ? 100 : int(i.priority, 'priority', 0, 100_000), matchKinds: strings(i.matchKinds, 'offer kinds'), matchOfferIds: strings(i.matchOfferIds, 'offers'),
    minTermMonths: min, maxTermMonths: max, matchTiers: tiers, calc, rateBps: int(i.rateBps ?? 0, 'rate', 0, 10_000), fixedMinor: int(i.fixedMinor ?? 0, 'amount'),
    slabMode, slabs: cleanSlabs(i.slabs), status: i.status === 'INACTIVE' ? 'INACTIVE' as const : 'ACTIVE' as const,
  };
  if (calc === 'PERCENT' && out.rateBps === 0 && !out.slabs.some((s) => (s.rateBps ?? 0) > 0)) throw invalid('a percentage rule needs a rate, or a rate in at least one volume band');
  if (calc === 'FIXED' && out.fixedMinor === 0 && !out.slabs.some((s) => (s.fixedMinor ?? 0) > 0)) throw invalid('a fixed rule needs an amount, or an amount in at least one volume band');
  return out;
}
export interface PolicyDraft { name: string; minTermMonths?: number | null; triggers?: string[]; tiers?: ClawbackTier[]; includeOverrides?: boolean; status?: 'ACTIVE' | 'INACTIVE' }
export function cleanPolicyDraft(i: PolicyDraft): Omit<ClawbackPolicy, 'id'> {
  const name = i.name?.trim();
  if (!name || name.length > 120) throw invalid('a claw-back policy needs a name (up to 120 characters)');
  const triggers = strings(i.triggers ?? [...CLAWBACK_TRIGGERS], 'triggers');
  if (!triggers.length) throw invalid('choose at least one event that triggers a claw-back');
  for (const t of triggers) if (!(CLAWBACK_TRIGGERS as readonly string[]).includes(t)) throw invalid(`unknown claw-back trigger ${t}`);
  if (!Array.isArray(i.tiers) || !i.tiers.length || i.tiers.length > 8) throw invalid('give one to eight claw-back windows, for example 90 days at 100%');
  const tiers = i.tiers.map((t, n) => ({ withinDays: int(t.withinDays, `window ${n + 1} days`, 1, 3650), percentBps: int(t.percentBps, `window ${n + 1} percentage`, 1, 10_000) })).sort((a, b) => a.withinDays - b.withinDays);
  for (let n = 1; n < tiers.length; n++) if (tiers[n]!.withinDays === tiers[n - 1]!.withinDays) throw invalid('two claw-back windows end on the same day');
  return { name, minTermMonths: i.minTermMonths == null ? null : int(i.minTermMonths, 'minimum contract months', 0, 120), triggers, tiers, includeOverrides: i.includeOverrides !== false, status: i.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE' };
}
