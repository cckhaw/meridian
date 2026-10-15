import { audit } from './audit.js';
import { CommissionCalculator, cleanPolicyDraft, cleanRuleDraft, DEALER_TIERS, type BeneficiaryKind, type ClawbackPolicy, type DraftEntry, type Plan, type PlanRule, type PolicyDraft, type RuleDraft, type Sale, type Seller } from './commission-calculator.js';
import { GL } from './config.js';
import { today } from './dates.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { postJournal } from './ledger.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';

export * from './commission-calculator.js';

// ───────────────────────── channel hierarchy ─────────────────────────
const MAX_DEPTH = 6;
export interface ChannelInput { tier?: string; parentDealerId?: string | null; bankAccountName?: string | null; bankAccountNo?: string | null; bankCode?: string | null; sapVendorNo?: string | null }
const clip = (v: string | null | undefined, max: number) => { const t = v?.trim(); if (t && t.length > max) throw invalid(`too long (max ${max} characters)`); return t || null; };

/** The dealers above this one, nearest first. Stops at a loop, so bad data cannot hang a sale. */
export async function uplinesOf(q: Queryable, dealerId: string): Promise<Array<{ dealerId: string; tier: string }>> {
  const out: Array<{ dealerId: string; tier: string }> = [];
  const seen = new Set([dealerId]);
  let cur = (await q.query('SELECT parent_dealer_id FROM dealers WHERE id=$1', [dealerId])).rows[0]?.parentDealerId as string | null | undefined;
  while (cur && !seen.has(cur) && out.length < MAX_DEPTH) {
    seen.add(cur);
    const d = (await q.query('SELECT id, tier, parent_dealer_id FROM dealers WHERE id=$1', [cur])).rows[0];
    if (!d) break;
    out.push({ dealerId: d.id, tier: d.tier });
    cur = d.parentDealerId;
  }
  return out;
}

/** Whether `parent` can be the parent of a dealer (an existing one, or a new one when `dealerId` is null): it exists, makes no loop, and keeps the channel within its depth. */
export async function assertParentFits(q: Queryable, dealerId: string | null, parent: string): Promise<void> {
  if (dealerId && parent === dealerId) throw invalid('a dealer cannot be its own parent');
  if (!(await q.query('SELECT 1 FROM dealers WHERE id=$1', [parent])).rows.length) throw notFound(`dealer ${parent}`);
  const chain = await uplinesOf(q, parent);
  if (dealerId && chain.some((u) => u.dealerId === dealerId)) throw invalid('that would put the dealer under one of its own sub-dealers');
  if (chain.length + 1 + (dealerId ? await depthBelow(q, dealerId) : 0) > MAX_DEPTH - 1) throw invalid(`the channel can be at most ${MAX_DEPTH} levels deep`);
}

/** Where a dealer sits in the channel and how it is paid. A dealer cannot sit under itself or one of its own sub-dealers, and the chain has a depth limit. */
export async function setDealerChannel(q: Queryable, actor: string, dealerId: string, i: ChannelInput): Promise<Row> {
  const cur = (await q.query('SELECT * FROM dealers WHERE id=$1', [dealerId])).rows[0];
  if (!cur) throw notFound(`dealer ${dealerId}`);
  const tier = i.tier ?? cur.tier;
  if (!(DEALER_TIERS as readonly string[]).includes(tier)) throw invalid(`the tier is one of ${DEALER_TIERS.join(', ')}`);
  const parent = i.parentDealerId === undefined ? cur.parentDealerId : i.parentDealerId || null;
  if (parent) await assertParentFits(q, dealerId, parent);
  const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
  const r = await q.query(
    `UPDATE dealers SET tier=$2, parent_dealer_id=$3, bank_account_name=$4, bank_account_no=$5, bank_code=$6, sap_vendor_no=$7, updated_at=now() WHERE id=$1 RETURNING *`,
    [dealerId, tier, parent, clip(pick(i.bankAccountName, cur.bankAccountName), 120), clip(pick(i.bankAccountNo, cur.bankAccountNo), 60), clip(pick(i.bankCode, cur.bankCode), 30), clip(pick(i.sapVendorNo, cur.sapVendorNo), 30)]);
  await audit(q, actor, 'dealer', dealerId, 'channel_update', { tier, parent, bankChanged: i.bankAccountNo !== undefined || i.bankCode !== undefined });
  return r.rows[0]!;
}
async function depthBelow(q: Queryable, dealerId: string): Promise<number> {
  let depth = 0, level = [dealerId];
  while (level.length && depth < MAX_DEPTH) {
    const kids = (await q.query('SELECT id FROM dealers WHERE parent_dealer_id = ANY($1::text[])', [level])).rows.map((r) => r.id as string);
    if (!kids.length) break;
    depth++; level = kids;
  }
  return depth;
}
/** The whole dealer channel as a flat list with depth, for drawing a tree. */
export async function dealerTree(q: Queryable): Promise<Row[]> {
  const rows = (await q.query(`SELECT id, name, status, tier, parent_dealer_id, (bank_account_no IS NOT NULL) AS has_bank, sap_vendor_no FROM dealers ORDER BY id LIMIT 5000`)).rows;
  const kids = new Map<string | null, Row[]>();
  for (const r of rows) (kids.get(r.parentDealerId ?? null) ?? kids.set(r.parentDealerId ?? null, []).get(r.parentDealerId ?? null)!).push(r);
  const out: Row[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => { for (const r of kids.get(parent) ?? []) { if (seen.has(r.id)) continue; seen.add(r.id); out.push({ ...r, depth }); walk(r.id, depth + 1); } };
  walk(null, 0);
  for (const r of rows) if (!seen.has(r.id)) out.push({ ...r, depth: 0 });
  return out;
}

// ───────────────────────── plans ─────────────────────────
export interface PlanInput { name: string; status?: 'ACTIVE' | 'INACTIVE'; holdDays?: number; overrideBps?: number[]; note?: string | null }
function cleanPlan(i: PlanInput) {
  const name = i.name?.trim();
  if (!name || name.length > 120) throw invalid('a plan needs a name (up to 120 characters)');
  const hold = i.holdDays ?? 0;
  if (!Number.isInteger(hold) || hold < 0 || hold > 365) throw invalid('the hold is 0 to 365 days');
  const ov = i.overrideBps ?? [];
  if (!Array.isArray(ov) || ov.length > 5 || ov.some((b) => !Number.isInteger(b) || b < 0 || b > 5000)) throw invalid('override commission is up to five levels, each 0% to 50%');
  return { name, status: i.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', holdDays: hold, overrideBps: ov, note: clip(i.note, 500) };
}
export async function createPlan(q: Queryable, actor: string, i: PlanInput): Promise<Row> {
  const p = cleanPlan(i);
  const r = (await q.query(`INSERT INTO commission_plans (name, status, hold_days, override_bps, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [p.name, p.status, p.holdDays, JSON.stringify(p.overrideBps), p.note, actor])).rows[0]!;
  await audit(q, actor, 'commission_plan', r.id, 'create', { name: p.name });
  return r;
}
export async function updatePlan(q: Queryable, actor: string, id: string, i: PlanInput): Promise<Row> {
  await getPlanRow(q, id);
  const p = cleanPlan(i);
  const r = (await q.query(`UPDATE commission_plans SET name=$2, status=$3, hold_days=$4, override_bps=$5, note=$6, updated_at=now() WHERE id=$1 RETURNING *`, [id, p.name, p.status, p.holdDays, JSON.stringify(p.overrideBps), p.note])).rows[0]!;
  await audit(q, actor, 'commission_plan', id, 'update', { ...p });
  return r;
}
export async function deletePlan(q: Queryable, actor: string, id: string): Promise<void> {
  await getPlanRow(q, id);
  if ((await q.query('SELECT 1 FROM agent_ledger_entries WHERE plan_id=$1 LIMIT 1', [id])).rows.length) throw conflict('This plan has earned commission, so it cannot be removed. Switch it off instead.');
  await q.query('DELETE FROM commission_plans WHERE id=$1', [id]);
  await audit(q, actor, 'commission_plan', id, 'delete');
}
const getPlanRow = async (q: Queryable, id: string): Promise<Row> => { const r = (await q.query('SELECT * FROM commission_plans WHERE id=$1', [id])).rows[0]; if (!r) throw notFound('commission plan', id); return r; };

const toRule = (r: Row): PlanRule => ({ id: r.id, name: r.name, priority: r.priority, matchKinds: r.matchKinds, matchOfferIds: r.matchOfferIds, minTermMonths: r.minTermMonths, maxTermMonths: r.maxTermMonths, matchTiers: r.matchTiers, calc: r.calc, rateBps: r.rateBps, fixedMinor: Number(r.fixedMinor), slabMode: r.slabMode, slabs: r.slabs, status: r.status });
const toPolicy = (r: Row): ClawbackPolicy => ({ id: r.id, name: r.name, minTermMonths: r.minTermMonths, triggers: r.triggers, tiers: r.tiers, includeOverrides: r.includeOverrides, status: r.status });

export async function loadPlan(q: Queryable, id: string): Promise<Plan & { status: string; validFrom: string | null; validTo: string | null }> {
  const p = await getPlanRow(q, id);
  const rules = (await q.query('SELECT * FROM commission_rules WHERE plan_id=$1 ORDER BY priority, name', [id])).rows.map(toRule);
  const clawbacks = (await q.query('SELECT * FROM clawback_policies WHERE plan_id=$1 ORDER BY name', [id])).rows.map(toPolicy);
  return { id, name: p.name, holdDays: p.holdDays, overrideBps: p.overrideBps, rules, clawbacks, status: p.status, validFrom: p.validFrom, validTo: p.validTo };
}
export async function listPlans(q: Queryable): Promise<Row[]> {
  const plans = (await q.query(`SELECT p.*, (SELECT count(*) FROM agent_ledger_entries e WHERE e.plan_id = p.id) AS entries FROM commission_plans p ORDER BY p.name`)).rows;
  const out: Row[] = [];
  for (const p of plans) {
    out.push({ ...p,
      rules: (await q.query('SELECT * FROM commission_rules WHERE plan_id=$1 ORDER BY priority, name', [p.id])).rows,
      clawbacks: (await q.query('SELECT * FROM clawback_policies WHERE plan_id=$1 ORDER BY name', [p.id])).rows,
      assignments: (await q.query('SELECT * FROM commission_assignments WHERE plan_id=$1 ORDER BY kind, actor_id', [p.id])).rows });
  }
  return out;
}

export async function saveCommissionRule(q: Queryable, actor: string, planId: string, ruleId: string | null, i: RuleDraft): Promise<Row> {
  await getPlanRow(q, planId);
  const r = cleanRuleDraft(i);
  const vals = [r.name, r.priority, JSON.stringify(r.matchKinds), JSON.stringify(r.matchOfferIds), r.minTermMonths, r.maxTermMonths, JSON.stringify(r.matchTiers), r.calc, r.rateBps, r.fixedMinor, r.slabMode, JSON.stringify(r.slabs), r.status];
  let row: Row;
  if (ruleId) {
    row = (await q.query(`UPDATE commission_rules SET name=$3, priority=$4, match_kinds=$5, match_offer_ids=$6, min_term_months=$7, max_term_months=$8, match_tiers=$9, calc=$10, rate_bps=$11, fixed_minor=$12, slab_mode=$13, slabs=$14, status=$15, updated_at=now() WHERE id=$1 AND plan_id=$2 RETURNING *`, [ruleId, planId, ...vals])).rows[0]!;
    if (!row) throw notFound('commission rule', ruleId);
  } else {
    row = (await q.query(`INSERT INTO commission_rules (plan_id, name, priority, match_kinds, match_offer_ids, min_term_months, max_term_months, match_tiers, calc, rate_bps, fixed_minor, slab_mode, slabs, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [planId, ...vals])).rows[0]!;
  }
  await audit(q, actor, 'commission_plan', planId, ruleId ? 'rule_update' : 'rule_create', { rule: r.name });
  return row;
}
export async function deleteCommissionRule(q: Queryable, actor: string, planId: string, ruleId: string): Promise<void> {
  const r = await q.query('DELETE FROM commission_rules WHERE id=$1 AND plan_id=$2 RETURNING name', [ruleId, planId]);
  if (!r.rows.length) throw notFound('commission rule', ruleId);
  await audit(q, actor, 'commission_plan', planId, 'rule_delete', { rule: r.rows[0]!.name });
}
export async function saveClawbackPolicy(q: Queryable, actor: string, planId: string, policyId: string | null, i: PolicyDraft): Promise<Row> {
  await getPlanRow(q, planId);
  const p = cleanPolicyDraft(i);
  const vals = [p.name, p.minTermMonths, JSON.stringify(p.triggers), JSON.stringify(p.tiers), p.includeOverrides, p.status];
  let row: Row;
  if (policyId) {
    row = (await q.query(`UPDATE clawback_policies SET name=$3, min_term_months=$4, triggers=$5, tiers=$6, include_overrides=$7, status=$8, updated_at=now() WHERE id=$1 AND plan_id=$2 RETURNING *`, [policyId, planId, ...vals])).rows[0]!;
    if (!row) throw notFound('claw-back policy', policyId);
  } else row = (await q.query(`INSERT INTO clawback_policies (plan_id, name, min_term_months, triggers, tiers, include_overrides, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [planId, ...vals])).rows[0]!;
  await audit(q, actor, 'commission_plan', planId, policyId ? 'policy_update' : 'policy_create', { policy: p.name });
  return row;
}
export async function deleteClawbackPolicy(q: Queryable, actor: string, planId: string, policyId: string): Promise<void> {
  const r = await q.query('DELETE FROM clawback_policies WHERE id=$1 AND plan_id=$2 RETURNING name', [policyId, planId]);
  if (!r.rows.length) throw notFound('claw-back policy', policyId);
  await audit(q, actor, 'commission_plan', planId, 'policy_delete', { policy: r.rows[0]!.name });
}

export const ASSIGNMENT_KINDS = ['DEALER', 'STAFF', 'STORE', 'CHANNEL'] as const;
export async function assignPlan(q: Queryable, actor: string, planId: string, kind: string, actorId: string): Promise<Row> {
  await getPlanRow(q, planId);
  if (!(ASSIGNMENT_KINDS as readonly string[]).includes(kind)) throw invalid(`assign to one of ${ASSIGNMENT_KINDS.join(', ')}`);
  const id = actorId?.trim();
  if (!id || id.length > 80) throw invalid('say who the plan is for');
  if (kind === 'DEALER' && !(await q.query('SELECT 1 FROM dealers WHERE id=$1', [id])).rows.length) throw notFound(`dealer ${id}`);
  if (kind === 'STORE' && !(await q.query('SELECT 1 FROM stores WHERE id=$1', [id])).rows.length) throw notFound(`store ${id}`);
  const r = (await q.query(`INSERT INTO commission_assignments (plan_id, kind, actor_id, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (kind, actor_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, created_by=EXCLUDED.created_by, created_at=now() RETURNING *`, [planId, kind, id, actor])).rows[0]!;
  await audit(q, actor, 'commission_plan', planId, 'assign', { kind, actorId: id });
  return r;
}
export async function unassignPlan(q: Queryable, actor: string, assignmentId: string): Promise<void> {
  const r = await q.query('DELETE FROM commission_assignments WHERE id=$1 RETURNING plan_id, kind, actor_id', [assignmentId]);
  if (!r.rows.length) throw notFound('assignment', assignmentId);
  await audit(q, actor, 'commission_plan', r.rows[0]!.planId, 'unassign', { kind: r.rows[0]!.kind, actorId: r.rows[0]!.actorId });
}

// ───────────────────────── who earns, by which plan ─────────────────────────
export interface SaleParties { channel: string; dealerId?: string | null; dealerAgentId?: string | null; salespersonId?: string | null; storeId?: string | null; commissionEligible?: boolean }

/** Resolves the seller and the plan. An attributed sale (dealer or salesperson) earns by the nearest plan: the dealer or an ancestor, the salesperson, the store, then the channel.
 *  A sale with nobody attributed earns only through a plan assigned to its store, or to the self-serve channel (house commission). */
export async function resolveSeller(q: Queryable, p: SaleParties): Promise<{ seller: Seller; planId: string } | null> {
  const find = async (kind: string, id: string) => (await q.query('SELECT plan_id FROM commission_assignments a JOIN commission_plans c ON c.id=a.plan_id WHERE a.kind=$1 AND a.actor_id=$2 AND c.status=\'ACTIVE\'', [kind, id])).rows[0]?.planId as string | undefined;
  let seller: Seller;
  let planId: string | undefined;
  if (p.dealerId) {
    const d = (await q.query('SELECT id, tier FROM dealers WHERE id=$1', [p.dealerId])).rows[0];
    const uplines = await uplinesOf(q, p.dealerId);
    seller = { kind: 'DEALER', id: p.dealerId, tier: d?.tier ?? null, dealerId: p.dealerId, dealerAgentId: p.dealerAgentId ?? null, storeId: p.storeId ?? null, uplines };
    planId = await find('DEALER', p.dealerId);
    for (const u of uplines) { if (planId) break; planId = await find('DEALER', u.dealerId); }
  } else if (p.salespersonId && p.commissionEligible !== false) {
    seller = { kind: 'STAFF', id: p.salespersonId, storeId: p.storeId ?? null, uplines: [] };
    planId = await find('STAFF', p.salespersonId);
  } else if (p.storeId) {
    seller = { kind: 'STORE', id: p.storeId, storeId: p.storeId, uplines: [] };
    planId = await find('STORE', p.storeId);
    if (!planId) return null;
  } else if (p.channel === 'SELF_SERVE') {
    seller = { kind: 'HOUSE', id: 'SELF_SERVE', uplines: [] };
    planId = await find('CHANNEL', 'SELF_SERVE');
    if (!planId) return null;
  } else return null;
  if (!planId && seller.kind !== 'HOUSE') { if (seller.storeId && seller.kind === 'STAFF') planId = await find('STORE', seller.storeId); }
  planId ??= await find('CHANNEL', p.channel);
  return planId ? { seller, planId } : null;
}

// ───────────────────────── the ledger ─────────────────────────
const isPayable = (k: string) => k === 'DEALER' || k === 'STAFF';
const period = (date: string) => date.slice(0, 7);

/** Posts one ledger entry to the GL: expense against payable when it earns, the reverse when it is taken back. Store and house commission is tracked, not booked. */
export async function postEntryGl(q: Queryable, e: { id: number; beneficiaryKind: string; beneficiaryId: string; amountMinor: number; currency: string; earnedOn: string; entryType: string }): Promise<void> {
  if (!isPayable(e.beneficiaryKind) || e.amountMinor === 0) return;
  const amt = Math.abs(e.amountMinor);
  const earn = e.amountMinor > 0;
  await postJournal(q, {
    date: e.earnedOn, sourceType: 'COMMISSION', sourceId: `${e.beneficiaryId}:${e.id}`, currency: e.currency, eventType: earn ? 'COMMISSION_ACCRUED' : 'COMMISSION_REVERSED', eventId: `commission-${e.id}`,
    lines: [
      { account: GL.COMMISSION_EXPENSE, [earn ? 'debit' : 'credit']: amt, description: `${earn ? 'Commission' : 'Commission reversed'} ${e.beneficiaryId} ${e.entryType.toLowerCase()}` },
      { account: GL.COMMISSION_PAYABLE, [earn ? 'credit' : 'debit']: amt, description: `${earn ? 'Commission payable' : 'Commission payable reversed'} ${e.beneficiaryId}` },
    ],
  });
}

async function lock(q: Queryable, key: string) { await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]); }

async function insertEntry(q: Queryable, d: DraftEntry & { period: string; earnedOn: string; orderId: string | null; currency: string; status: string; reversesId?: number | null; note?: string | null }): Promise<number | null> {
  const r = await q.query(
    `INSERT INTO agent_ledger_entries (beneficiary_kind, beneficiary_id, dealer_id, dealer_agent_id, store_id, entry_type, status, amount_minor, basis_minor, rate_bps, units, currency, plan_id, rule_id, order_id, order_line_id, offer_id, period, earned_on, approved_at, reverses_id, note, calc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, CASE WHEN $7 = 'APPROVED' THEN now() END, $20,$21,$22)
     ON CONFLICT DO NOTHING RETURNING id`,
    [d.beneficiaryKind, d.beneficiaryId, d.dealerId, d.dealerAgentId, d.storeId, d.entryType, d.status, d.amountMinor, d.basisMinor, d.rateBps, d.units, d.currency, d.planId, d.ruleId, d.orderId, d.orderLineId, d.offerId, d.period, d.earnedOn, d.reversesId ?? null, d.note ?? null, JSON.stringify(d.calc)]);
  return r.rows[0]?.id ?? null;
}

/** What the sale earned, worked out from the orders table's facts; the order engine calls this when an order completes. Safe to repeat: a line earns once. */
export async function recordOrderCommission(q: Queryable, parties: SaleParties, sale: Sale): Promise<{ entries: number; planId: string | null }> {
  const resolved = await resolveSeller(q, parties);
  if (!resolved || !sale.lines.length) return { entries: 0, planId: null };
  const plan = await loadPlan(q, resolved.planId);
  const on = sale.completedOn;
  const per = period(on);
  await lock(q, `commission:${resolved.seller.kind}:${resolved.seller.id}:${per}`);
  const counts = new Map<string, number>();
  for (const r of plan.rules) {
    const c = (await q.query(`SELECT COALESCE(sum(units - clawed_units),0) AS n FROM agent_ledger_entries WHERE entry_type='EARNING' AND rule_id=$1 AND beneficiary_kind=$2 AND beneficiary_id=$3 AND period=$4 AND status <> 'CLAWED_BACK'`, [r.id, resolved.seller.kind, resolved.seller.id, per])).rows[0]!;
    counts.set(r.id, Number(c.n));
  }
  const drafts = CommissionCalculator.calculate(plan, sale, resolved.seller, (id) => counts.get(id) ?? 0);
  let n = 0;
  for (const d of drafts) {
    if (d.amountMinor <= 0 && d.entryType === 'OVERRIDE') continue;
    const status = plan.holdDays > 0 ? 'PENDING' : 'APPROVED';
    const id = await insertEntry(q, { ...d, period: per, earnedOn: on, orderId: sale.orderId, currency: sale.currency, status });
    if (id == null) continue;
    n++;
    await postEntryGl(q, { id, beneficiaryKind: d.beneficiaryKind, beneficiaryId: d.beneficiaryId, amountMinor: d.amountMinor, currency: sale.currency, earnedOn: on, entryType: d.entryType });
  }
  return { entries: n, planId: plan.id };
}

/** A what-if: what an order like this would earn for a seller today, without writing anything. */
export async function previewCommission(q: Queryable, f: { dealerId?: string; channel?: string; salespersonId?: string; storeId?: string; offerKind: string; offerId?: string; termMonths: number; quantity: number; basisMinor: number; countBefore?: number }) {
  const resolved = await resolveSeller(q, { channel: f.channel ?? (f.dealerId ? 'DEALER' : 'RETAIL_ASSISTED'), dealerId: f.dealerId, salespersonId: f.salespersonId, storeId: f.storeId });
  if (!resolved) return { plan: null, entries: [] as DraftEntry[] };
  const plan = await loadPlan(q, resolved.planId);
  const sale: Sale = { orderId: 'preview', completedOn: today(), currency: 'XXX', lines: [{ lineId: 'preview', offerId: f.offerId ?? 'preview', offerKind: f.offerKind, termMonths: f.termMonths, quantity: Math.max(1, f.quantity), basisMinor: f.basisMinor, createsService: true }] };
  const entries = CommissionCalculator.calculate(plan, sale, resolved.seller, () => f.countBefore ?? 0);
  return { plan: { id: plan.id, name: plan.name }, entries };
}

// ───────────────────────── reading the ledger ─────────────────────────
export interface EntryFilter { beneficiaryKind?: string; beneficiaryId?: string; dealerId?: string; storeId?: string; period?: string; status?: string; entryType?: string; orderId?: string; limit?: number; cursor?: string }
export async function listEntries(q: Queryable, f: EntryFilter = {}): Promise<Page<Row> & { totals: Row }> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.beneficiaryKind) where.push(`e.beneficiary_kind = ${p(f.beneficiaryKind)}`);
  if (f.beneficiaryId) where.push(`e.beneficiary_id = ${p(f.beneficiaryId)}`);
  if (f.dealerId) where.push(`(e.dealer_id = ${p(f.dealerId)} OR e.beneficiary_id = ${p(f.dealerId)})`);
  if (f.storeId) where.push(`e.store_id = ${p(f.storeId)}`);
  if (f.period) where.push(`e.period = ${p(f.period)}`);
  if (f.status) where.push(`e.status = ${p(f.status)}`);
  if (f.entryType) where.push(`e.entry_type = ${p(f.entryType)}`);
  if (f.orderId) where.push(`e.order_id = ${p(f.orderId)}::uuid`);
  const base = where.length ? where.join(' AND ') : 'true';
  const totals = (await q.query(`SELECT COALESCE(sum(amount_minor) FILTER (WHERE status='PENDING'),0) AS pending, COALESCE(sum(amount_minor) FILTER (WHERE status='APPROVED'),0) AS approved, COALESCE(sum(amount_minor) FILTER (WHERE status='PAID'),0) AS paid, COALESCE(sum(amount_minor) FILTER (WHERE entry_type='CLAWBACK'),0) AS clawed FROM agent_ledger_entries e WHERE ${base}`, params)).rows[0]!;
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`e.id < ${p(cur[0])}::bigint`);
  const rows = (await q.query(`SELECT e.*, o.number AS order_number FROM agent_ledger_entries e LEFT JOIN orders o ON o.id = e.order_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return { ...toPage(rows, limit, (r) => [r.id as number]), totals };
}

/** Earnings by beneficiary for one month: the figures behind a statement before it is issued. */
export async function periodSummary(q: Queryable, per: string, scope: { dealerId?: string; storeId?: string } = {}): Promise<Row[]> {
  const params: unknown[] = [per];
  let extra = '';
  if (scope.dealerId) extra += ` AND (dealer_id = $${params.push(scope.dealerId)} OR beneficiary_id = $${params.length})`;
  if (scope.storeId) extra += ` AND store_id = $${params.push(scope.storeId)}`;
  return (await q.query(
    `SELECT beneficiary_kind, beneficiary_id, count(DISTINCT order_id) AS orders, COALESCE(sum(units) FILTER (WHERE entry_type='EARNING' AND status <> 'CLAWED_BACK'),0) AS activations,
            COALESCE(sum(amount_minor) FILTER (WHERE entry_type IN ('EARNING','OVERRIDE','ACCELERATOR','BONUS','ADJUSTMENT') AND status <> 'CLAWED_BACK'),0) AS earned_minor,
            COALESCE(sum(amount_minor) FILTER (WHERE entry_type='CLAWBACK' AND status <> 'CLAWED_BACK'),0) AS clawback_minor,
            COALESCE(sum(amount_minor) FILTER (WHERE status <> 'CLAWED_BACK'),0) AS net_minor, max(currency) AS currency
       FROM agent_ledger_entries WHERE period = $1 ${extra} GROUP BY 1, 2 ORDER BY net_minor DESC LIMIT 500`, params)).rows;
}

/** Commission by store and seller (the figures the dealer and store portals show). */
export async function commissionReport(q: Queryable, f: { storeId?: string; dealerId?: string } = {}) {
  const params: unknown[] = []; const where: string[] = [`status <> 'CLAWED_BACK'`];
  if (f.storeId) where.push(`store_id = $${params.push(f.storeId)}`);
  if (f.dealerId) where.push(`(dealer_id = $${params.push(f.dealerId)} OR beneficiary_id = $${params.length})`);
  return (await q.query(
    `SELECT COALESCE(store_id,'-') AS store_id, beneficiary_id AS agent, count(DISTINCT order_id) AS orders, COALESCE(sum(basis_minor) FILTER (WHERE entry_type='EARNING'),0) AS basis_minor, sum(amount_minor) AS commission_minor, max(currency) AS currency
       FROM agent_ledger_entries WHERE ${where.join(' AND ')} GROUP BY 1, 2 ORDER BY commission_minor DESC LIMIT 200`, params)).rows;
}

// ───────────────────────── settings ─────────────────────────
export interface CommissionSettings { /** The daily job closes last month on the 1st: true-ups, bonuses and statements. */ autoClose: boolean }
export async function getCommissionSettings(q: Queryable): Promise<CommissionSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='commission'`)).rows[0]?.value as Partial<CommissionSettings> | undefined;
  return { autoClose: v?.autoClose === true };
}
export async function setCommissionSettings(q: Queryable, actor: string, s: Partial<CommissionSettings>): Promise<CommissionSettings> {
  const v = { ...(await getCommissionSettings(q)), ...(s.autoClose === undefined ? {} : { autoClose: !!s.autoClose }) };
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('commission', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(v), actor]);
  await audit(q, actor, 'settings', 'commission', 'update', { ...v });
  return v;
}
export type { BeneficiaryKind };
