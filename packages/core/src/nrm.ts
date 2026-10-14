import { audit } from './audit.js';
import type { Db, Queryable, Row } from './db.js';
import { addDays, fmt, today, type DateStr } from './dates.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { getLifecycleSettings } from './lifecycle-config.js';
import { patternProblem, VipPatternMatcher, VIP_TIERS, type TierPattern, type TierRule, type VipTier } from './vip-pattern-matcher.js';

// ───────────────────────── settings ─────────────────────────
export interface NumberingSettings {
  /** An order for a plan that needs a SIM must say which SIM (or an eSIM). Off: the SIM step is offered but may be skipped. */
  requireSim: boolean;
  /** How long a number or SIM is held for a customer who is checking out. */
  reservationMinutes: number;
  /** How long an IMSI rests after a subscriber leaves before it can be used again. */
  imsiQuarantineDays: number;
  /** How long an auction winner has to complete the order. */
  auctionSettlementHours: number;
}
export const DEFAULT_NUMBERING: NumberingSettings = { requireSim: false, reservationMinutes: 15, imsiQuarantineDays: 90, auctionSettlementHours: 48 };

export async function getNumberingSettings(q: Queryable): Promise<NumberingSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='numbering'`)).rows[0]?.value as Partial<NumberingSettings> | undefined;
  return { ...DEFAULT_NUMBERING, ...v };
}
export async function setNumberingSettings(q: Queryable, actor: string, s: NumberingSettings): Promise<NumberingSettings> {
  const int = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
  if (!int(s.reservationMinutes, 1, 24 * 60)) throw invalid('A number is held for 1 to 1440 minutes.');
  if (!int(s.imsiQuarantineDays, 0, 730)) throw invalid('An IMSI rests 0 to 730 days.');
  if (!int(s.auctionSettlementHours, 1, 24 * 30)) throw invalid('An auction winner has 1 to 720 hours.');
  const v: NumberingSettings = { requireSim: !!s.requireSim, reservationMinutes: s.reservationMinutes, imsiQuarantineDays: s.imsiQuarantineDays, auctionSettlementHours: s.auctionSettlementHours };
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('numbering', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(v), actor]);
  await audit(q, actor, 'settings', 'numbering', 'update', { ...v });
  return v;
}

// ───────────────────────── audit trail ─────────────────────────
export type ResourceType = 'MSISDN' | 'ICCID' | 'IMSI';
export async function auditIdentifier(q: Queryable, e: { type: ResourceType; id: string; from?: string | null; to: string; actor: string; reason?: string; detail?: unknown }): Promise<void> {
  await q.query(`INSERT INTO identifier_lifecycle_audit (resource_type, resource_id, from_state, to_state, actor, reason, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.type, e.id, e.from ?? null, e.to, e.actor, e.reason ?? null, JSON.stringify(e.detail ?? {})]);
}
export async function identifierHistory(q: Queryable, type: ResourceType, id: string, limit = 100): Promise<Row[]> {
  return (await q.query(`SELECT id::text, at, from_state, to_state, actor, reason, detail FROM identifier_lifecycle_audit WHERE resource_type=$1 AND resource_id=$2 ORDER BY id DESC LIMIT $3`, [type, id, Math.min(limit, 500)])).rows;
}

// ───────────────────────── state machines ─────────────────────────
export const ICCID_STATES = ['WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER', 'RESERVED', 'ACTIVE', 'DAMAGED_SCRAPPED', 'DECOMMISSIONED'] as const;
export type IccidState = (typeof ICCID_STATES)[number];
/** A physical SIM that is DECOMMISSIONED is gone for good. An eSIM's ICCID is a reusable profile template: when its subscriber leaves it goes back to inventory. */
export const ICCID_TRANSITIONS: Record<IccidState, IccidState[]> = {
  WAREHOUSE_INVENTORY: ['DISTRIBUTED_DEALER', 'RESERVED', 'DAMAGED_SCRAPPED'],
  DISTRIBUTED_DEALER: ['WAREHOUSE_INVENTORY', 'RESERVED', 'DAMAGED_SCRAPPED'],
  RESERVED: ['ACTIVE', 'WAREHOUSE_INVENTORY', 'DISTRIBUTED_DEALER', 'DAMAGED_SCRAPPED'],
  ACTIVE: ['DAMAGED_SCRAPPED', 'DECOMMISSIONED', 'WAREHOUSE_INVENTORY'],
  DAMAGED_SCRAPPED: ['DECOMMISSIONED'],
  DECOMMISSIONED: [],
};
export const IMSI_STATES = ['POOL_UNASSIGNED', 'BOUND_TO_SIM', 'ACTIVE', 'QUARANTINED', 'RECYCLED'] as const;
export type ImsiState = (typeof IMSI_STATES)[number];
export const IMSI_TRANSITIONS: Record<ImsiState, ImsiState[]> = {
  POOL_UNASSIGNED: ['BOUND_TO_SIM'],
  BOUND_TO_SIM: ['ACTIVE', 'POOL_UNASSIGNED'],
  ACTIVE: ['QUARANTINED'],
  QUARANTINED: ['RECYCLED'],
  RECYCLED: ['POOL_UNASSIGNED'],
};
export const MSISDN_STATES = ['AVAILABLE', 'RESERVED_CHECKOUT', 'ASSIGNED_ACTIVE', 'QUARANTINE_COOLING', 'BLOCKED_VIP', 'AUCTION_HOLD', 'PORTED_OUT'] as const;
export type MsisdnState = (typeof MSISDN_STATES)[number];
export const MSISDN_TRANSITIONS: Record<MsisdnState, MsisdnState[]> = {
  AVAILABLE: ['RESERVED_CHECKOUT', 'BLOCKED_VIP', 'AUCTION_HOLD', 'ASSIGNED_ACTIVE'],
  RESERVED_CHECKOUT: ['ASSIGNED_ACTIVE', 'AVAILABLE', 'AUCTION_HOLD'],
  ASSIGNED_ACTIVE: ['QUARANTINE_COOLING', 'PORTED_OUT'],
  QUARANTINE_COOLING: ['AVAILABLE'],
  BLOCKED_VIP: ['AVAILABLE', 'AUCTION_HOLD'],
  AUCTION_HOLD: ['AVAILABLE', 'RESERVED_CHECKOUT', 'BLOCKED_VIP'],
  PORTED_OUT: ['AVAILABLE'],
};
function guard<S extends string>(table: Record<S, S[]>, kind: string, id: string, from: S, to: S) {
  if (!(table[from] ?? []).includes(to)) throw rejected(`${kind} ${id} is ${from}; it cannot go to ${to}. Allowed: ${(table[from] ?? []).join(', ') || 'nothing (final)'}.`);
}
export const assertIccidTransition = (id: string, from: IccidState, to: IccidState) => guard(ICCID_TRANSITIONS, 'SIM', id, from, to);
export const assertImsiTransition = (id: string, from: ImsiState, to: ImsiState) => guard(IMSI_TRANSITIONS, 'IMSI', id, from, to);
export const assertMsisdnTransition = (id: string, from: MsisdnState, to: MsisdnState) => guard(MSISDN_TRANSITIONS, 'Number', id, from, to);

// ───────────────────────── tier rules ─────────────────────────
const ruleOf = (r: Row): TierRule => ({
  tier: r.tier, label: r.label, sortOrder: r.sortOrder, patterns: r.patterns ?? [], oneTimeFeeMinor: Number(r.oneTimeFeeMinor), minMonthlyPlanMinor: Number(r.minMonthlyPlanMinor),
  minContractMonths: r.minContractMonths, etcMultiplierBps: r.etcMultiplierBps, enabled: r.enabled,
});
export async function listTierRules(q: Queryable): Promise<TierRule[]> {
  return (await q.query('SELECT * FROM msisdn_vip_tier_rules ORDER BY sort_order')).rows.map(ruleOf);
}
export const tierRuleMap = async (q: Queryable) => new Map((await listTierRules(q)).map((r) => [r.tier, r]));
export const getMatcher = async (q: Queryable) => new VipPatternMatcher(await listTierRules(q));

export async function updateTierRule(q: Queryable, actor: string, tier: string, p: Partial<Pick<TierRule, 'label' | 'patterns' | 'oneTimeFeeMinor' | 'minMonthlyPlanMinor' | 'minContractMonths' | 'etcMultiplierBps' | 'enabled'>>): Promise<TierRule> {
  if (!(VIP_TIERS as readonly string[]).includes(tier)) throw invalid(`unknown tier ${tier}`);
  const cur = (await q.query('SELECT * FROM msisdn_vip_tier_rules WHERE tier=$1', [tier])).rows[0];
  if (!cur) throw notFound('tier rule', tier);
  const next = { ...ruleOf(cur), ...p };
  const bad = (n: number, lo: number, hi: number) => !Number.isInteger(n) || n < lo || n > hi;
  if (bad(next.oneTimeFeeMinor, 0, 1e9) || bad(next.minMonthlyPlanMinor, 0, 1e9)) throw invalid('Fees are whole amounts, zero or more.');
  if (bad(next.minContractMonths, 0, 60)) throw invalid('A contract lock is 0 to 60 months.');
  if (bad(next.etcMultiplierBps, 10000, 100000)) throw invalid('The early-termination multiplier is 1x to 10x (10000 to 100000).');
  if (!next.label?.trim() || next.label.length > 40) throw invalid('Give the tier a name of up to 40 characters.');
  if (tier === 'STANDARD' && (next.oneTimeFeeMinor || next.minMonthlyPlanMinor || next.minContractMonths || next.etcMultiplierBps !== 10000 || next.patterns.length)) throw invalid('Standard numbers carry no fee, minimum plan, contract lock or patterns.');
  if (next.patterns.length > 20) throw invalid('A tier can have up to 20 patterns.');
  for (const pt of next.patterns) { const m = patternProblem(pt as TierPattern); if (m) throw invalid(m); }
  await q.query(
    `UPDATE msisdn_vip_tier_rules SET label=$2, patterns=$3, one_time_fee_minor=$4, min_monthly_plan_minor=$5, min_contract_months=$6, etc_multiplier_bps=$7, enabled=$8, updated_by=$9, updated_at=now() WHERE tier=$1`,
    [tier, next.label.trim(), JSON.stringify(next.patterns), next.oneTimeFeeMinor, next.minMonthlyPlanMinor, next.minContractMonths, next.etcMultiplierBps, next.enabled, actor]);
  await audit(q, actor, 'numbering', tier, 'TIER_RULE_UPDATED', { ...p });
  return ruleOf((await q.query('SELECT * FROM msisdn_vip_tier_rules WHERE tier=$1', [tier])).rows[0]!);
}

/** Puts the numbers in the pool in their tier again after the patterns changed. Reserved, assigned and held numbers keep theirs only if `all`. */
export async function reclassifyNumbers(db: Db, actor: string, o: { all?: boolean } = {}): Promise<{ changed: number }> {
  const matcher = await getMatcher(db);
  let changed = 0, after = '';
  for (;;) {
    const rows = (await db.query(`SELECT msisdn, tier, pattern_code FROM msisdn_inventory WHERE msisdn > $1 AND tier <> 'AUCTION' ${o.all ? '' : `AND state = 'AVAILABLE'`} ORDER BY msisdn LIMIT 2000`, [after])).rows;
    if (!rows.length) break;
    await db.tx(async (q) => {
      for (const r of rows) {
        const c = matcher.classify(r.msisdn as string);
        if (c.tier !== r.tier || c.patternCode !== r.patternCode) { await q.query('UPDATE msisdn_inventory SET tier=$2, pattern_code=$3, updated_at=now() WHERE msisdn=$1', [r.msisdn, c.tier, c.patternCode]); changed++; }
      }
    });
    after = rows[rows.length - 1]!.msisdn as string;
  }
  await audit(db, actor, 'numbering', 'tiers', 'RECLASSIFIED', { changed });
  return { changed };
}

// ───────────────────────── releasing resources when a service ends ─────────────────────────
/**
 * A subscriber has gone. The SIM, the identity and the number are released on different terms:
 *   physical SIM -> DECOMMISSIONED (the plastic is scrapped); eSIM -> back to inventory (the profile template is reusable);
 *   IMSI         -> decoupled from the SIM and QUARANTINED for the cooling-off period;
 *   number       -> QUARANTINE_COOLING for the quarantine period (or PORTED_OUT: it belongs to another operator now).
 */
export async function releaseResourcesOnTermination(q: Queryable, s: Row, o: { ported?: boolean; date: DateStr; actor: string; reason: string }): Promise<void> {
  const cfg = await getNumberingSettings(q);
  const life = await getLifecycleSettings(q);
  const sid = s.id as string;
  const sim = (await q.query('SELECT * FROM iccid_inventory WHERE service_id=$1 OR (iccid=$2 AND $2 IS NOT NULL) FOR UPDATE', [sid, s.iccid ?? null])).rows[0];
  if (sim) {
    const to: IccidState = sim.kind === 'ESIM' ? 'WAREHOUSE_INVENTORY' : 'DECOMMISSIONED';
    assertIccidTransition(sim.iccid, sim.state, to);
    await q.query(`UPDATE iccid_inventory SET state=$2, service_id=NULL, order_id=NULL, imsi=${sim.kind === 'ESIM' ? 'NULL' : 'imsi'}, location_id=${sim.kind === 'ESIM' ? `COALESCE(location_id, 'WH-MAIN')` : 'location_id'}, updated_at=now() WHERE iccid=$1`, [sim.iccid, to]);
    await auditIdentifier(q, { type: 'ICCID', id: sim.iccid, from: sim.state, to, actor: o.actor, reason: o.reason, detail: { service: sid, kind: sim.kind } });
  }
  const imsi = (await q.query('SELECT * FROM imsi_inventory WHERE service_id=$1 OR (iccid=$2 AND $2 IS NOT NULL) FOR UPDATE', [sid, s.iccid ?? null])).rows[0];
  if (imsi) {
    assertImsiTransition(imsi.imsi, imsi.state, 'QUARANTINED');
    await q.query(`UPDATE imsi_inventory SET state='QUARANTINED', iccid=NULL, service_id=NULL, previous_msisdn=$2, quarantine_until=$3, updated_at=now() WHERE imsi=$1`, [imsi.imsi, s.identifier, addDays(o.date, cfg.imsiQuarantineDays)]);
    await auditIdentifier(q, { type: 'IMSI', id: imsi.imsi, from: imsi.state, to: 'QUARANTINED', actor: o.actor, reason: o.reason, detail: { decoupledFrom: sim?.iccid ?? s.iccid ?? null, until: addDays(o.date, cfg.imsiQuarantineDays) } });
  }
  const num = (await q.query('SELECT * FROM msisdn_inventory WHERE msisdn=$1 FOR UPDATE', [s.identifier])).rows[0];
  if (num) {
    const to: MsisdnState = o.ported ? 'PORTED_OUT' : 'QUARANTINE_COOLING';
    assertMsisdnTransition(num.msisdn, num.state, to);
    const until = o.ported ? null : addDays(o.date, life.termination.quarantineDays);
    await q.query(`UPDATE msisdn_inventory SET state=$2, service_id=NULL, quarantine_until=$3, reserved_by=NULL, reserved_until=NULL, updated_at=now() WHERE msisdn=$1`, [num.msisdn, to, until]);
    await auditIdentifier(q, { type: 'MSISDN', id: num.msisdn, from: num.state, to, actor: o.actor, reason: o.reason, detail: { until } });
  }
}

/**
 * The cooling-off periods that have ended: IMSIs go QUARANTINED -> RECYCLED -> POOL_UNASSIGNED (free to be written onto new SIM batches or issued as
 * fresh eSIM profiles), numbers go QUARANTINE_COOLING -> AVAILABLE in the tier they now belong to. Safe to run as often as you like.
 */
export async function recycleExpired(db: Db, asOf: DateStr = today(), actor = 'nrm'): Promise<{ imsis: number; msisdns: number }> {
  const matcher = await getMatcher(db);
  const out = { imsis: 0, msisdns: 0 };
  for (;;) {
    const n = await db.tx(async (q) => {
      const rows = (await q.query(`SELECT imsi FROM imsi_inventory WHERE state='QUARANTINED' AND quarantine_until <= $1::date ORDER BY quarantine_until, imsi LIMIT 500 FOR UPDATE SKIP LOCKED`, [asOf])).rows;
      for (const r of rows) {
        await q.query(`UPDATE imsi_inventory SET state='RECYCLED', updated_at=now() WHERE imsi=$1`, [r.imsi]);
        await auditIdentifier(q, { type: 'IMSI', id: r.imsi, from: 'QUARANTINED', to: 'RECYCLED', actor, reason: 'quarantine ended' });
        await q.query(`UPDATE imsi_inventory SET state='POOL_UNASSIGNED', iccid=NULL, service_id=NULL, quarantine_until=NULL, updated_at=now() WHERE imsi=$1`, [r.imsi]);
        await auditIdentifier(q, { type: 'IMSI', id: r.imsi, from: 'RECYCLED', to: 'POOL_UNASSIGNED', actor, reason: 'returned to the pool' });
      }
      return rows.length;
    });
    out.imsis += n;
    if (n < 500) break;
  }
  for (;;) {
    const n = await db.tx(async (q) => {
      const rows = (await q.query(`SELECT msisdn FROM msisdn_inventory WHERE state='QUARANTINE_COOLING' AND quarantine_until <= $1::date ORDER BY quarantine_until, msisdn LIMIT 500 FOR UPDATE SKIP LOCKED`, [asOf])).rows;
      for (const r of rows) {
        const c = matcher.classify(r.msisdn as string);
        await q.query(`UPDATE msisdn_inventory SET state='AVAILABLE', tier=$2, pattern_code=$3, quarantine_until=NULL, previous_state=NULL, updated_at=now() WHERE msisdn=$1`, [r.msisdn, c.tier, c.patternCode]);
        await q.query(`DELETE FROM identifier_registry WHERE type='MOBILE' AND identifier=$1`, [r.msisdn]);
        await auditIdentifier(q, { type: 'MSISDN', id: r.msisdn, from: 'QUARANTINE_COOLING', to: 'AVAILABLE', actor, reason: 'quarantine ended', detail: { tier: c.tier } });
      }
      return rows.length;
    });
    out.msisdns += n;
    if (n < 500) break;
  }
  if (out.imsis || out.msisdns) await audit(db, actor, 'numbering', 'recycle', 'RECYCLED', { ...out, asOf });
  return out;
}

// ───────────────────────── reads ─────────────────────────
export async function nrmSummary(q: Queryable) {
  const [m, i, s, t] = await Promise.all([
    q.query(`SELECT state, tier, count(*)::int AS n FROM msisdn_inventory GROUP BY state, tier ORDER BY state, tier`),
    q.query(`SELECT state, count(*)::int AS n FROM imsi_inventory GROUP BY state ORDER BY state`),
    q.query(`SELECT kind, state, count(*)::int AS n FROM iccid_inventory GROUP BY kind, state ORDER BY kind, state`),
    q.query(`SELECT tier, count(*)::int AS available FROM msisdn_inventory WHERE state='AVAILABLE' GROUP BY tier`),
  ]);
  return { msisdn: m.rows, imsi: i.rows, iccid: s.rows, availableByTier: Object.fromEntries(t.rows.map((r) => [r.tier, r.available])) };
}
