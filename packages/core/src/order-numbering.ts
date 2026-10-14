import { behaviourOf, type OfferNode } from '@meridian/types';
import { monthlyFee } from './catalog.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';
import { getNumberingSettings } from './nrm.js';
import type { VipTier } from './vip-pattern-matcher.js';

export const needsSim = (o: OfferNode) => !!o.fulfilment?.requiresSimActivation && (behaviourOf(o).service ?? 'MOBILE') === 'MOBILE';

export interface LineNumbering {
  /** The number is one of ours (in the number pool); a number the customer brings from another operator is not. */
  inPool: boolean;
  tier: VipTier | null; tierLabel: string | null; oneTimeFeeMinor: number; etcMultiplierBps: number;
}

interface Ask { offerId: string; quantity?: number; msisdn?: string; iccid?: string; simType?: 'PHYSICAL' | 'ESIM'; numberToken?: string }

/**
 * What the SIM and number chosen for each order line mean for the order: the VIP connection fee, the minimum plan and contract a VIP number
 * demands, whether the number can still be had, and whether a SIM has to be named. `fail` records a problem (the quote lists it, the order refuses).
 */
export async function resolveNumbering(
  q: Queryable, lines: Ask[], offers: Map<string, OfferNode>, ctx: { channel: string; contractMonthsOf: (pos: number) => number; fail: (m: string) => void; fmt: (minor: number) => string },
): Promise<Map<number, LineNumbering>> {
  const out = new Map<number, LineNumbering>();
  const cfg = await getNumberingSettings(q);
  for (let pos = 0; pos < lines.length; pos++) {
    const l = lines[pos]!;
    const offer = offers.get(l.offerId)!;
    const qty = l.quantity ?? 1;
    if ((l.iccid || l.simType) && qty !== 1) throw invalid('A SIM is chosen for one line at a time: order one plan per line.');
    if (needsSim(offer) && qty === 1 && cfg.requireSim && ctx.channel !== 'SELF_SERVE' && !l.iccid && !l.simType) {
      ctx.fail(`Choose the SIM for ${offer.name}: scan a SIM card, take the next free one, or sell an eSIM.`);
    }
    if (!l.msisdn) continue;
    const row = (await q.query(
      `SELECT m.state, m.tier, m.reserved_by, m.reserved_until, r.label, r.one_time_fee_minor, r.min_monthly_plan_minor, r.min_contract_months, r.etc_multiplier_bps, r.enabled,
              (SELECT l2.token FROM number_reservation_locks l2 WHERE l2.resource_type='MSISDN' AND l2.resource_id = m.msisdn AND l2.state='ACTIVE') AS token
         FROM msisdn_inventory m JOIN msisdn_vip_tier_rules r ON r.tier = m.tier WHERE m.msisdn=$1`, [l.msisdn])).rows[0];
    if (!row) { out.set(pos, { inPool: false, tier: null, tierLabel: null, oneTimeFeeMinor: 0, etcMultiplierBps: 10000 }); continue; } // a number brought from another operator
    const lapsed = row.state === 'RESERVED_CHECKOUT' && row.reservedUntil && new Date(row.reservedUntil) < new Date();
    const mine = row.state === 'RESERVED_CHECKOUT' && !!l.numberToken && row.token === l.numberToken;
    if (!(row.state === 'AVAILABLE' || lapsed || mine)) {
      ctx.fail(row.state === 'RESERVED_CHECKOUT' ? `${l.msisdn} is being bought by someone else right now. Choose another number.` : `${l.msisdn} is ${String(row.state).toLowerCase().replace(/_/g, ' ')} and cannot be sold. Choose another number.`);
    }
    const fee = row.enabled ? Number(row.oneTimeFeeMinor) : 0;
    const info: LineNumbering = { inPool: true, tier: row.tier, tierLabel: row.label, oneTimeFeeMinor: fee, etcMultiplierBps: row.enabled ? row.etcMultiplierBps : 10000 };
    out.set(pos, info);
    if (!row.enabled) continue;
    const mf = monthlyFee(offer);
    const monthly = mf ? mf.amount.amountMinor / (mf.periodMonths ?? 1) : 0;
    if (Number(row.minMonthlyPlanMinor) > 0 && monthly < Number(row.minMonthlyPlanMinor)) {
      ctx.fail(`${l.msisdn} is a ${row.label} number: it needs a plan of at least ${ctx.fmt(Number(row.minMonthlyPlanMinor))} a month, and ${offer.name} is ${ctx.fmt(Math.round(monthly))}.`);
    }
    if (row.minContractMonths > 0 && ctx.contractMonthsOf(pos) < row.minContractMonths) {
      ctx.fail(`${l.msisdn} is a ${row.label} number: it needs a contract of at least ${row.minContractMonths} months, and ${offer.name} has ${ctx.contractMonthsOf(pos) || 'none'}.`);
    }
  }
  return out;
}
