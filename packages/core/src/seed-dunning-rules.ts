import { currencyInfo } from '@meridian/types';
import type { Queryable } from './db.js';
import { getDunningPayments, setDunningPayments } from './dunning-engine.js';
import { listLateFees, listDunningRules, saveLateFee, saveDunningRule, type DunningRuleInput, type DunningStepAction, type DunningStepExclusions, type DunningStepParams, type DunningStepTrigger } from './dunning-rules.js';
import type { QrScheme } from './emv-qr.js';
import { getRegional } from './settings.js';

/**
 * Out-of-the-box dunning rules for the markets of Southeast Asia: Singapore, Malaysia, Thailand, the Philippines and Indonesia. Each market gets four rules and a
 * late fee:
 *
 *   Consumer standard   the default ladder: friendly reminder with a local QR code at D+1; second notice and late fee at D+7; soft bar (outgoing blocked, incoming and the
 *                       self-service app still work) at D+14; hard bar (everything but emergency calls) at D+21; final demand at D+35; termination, debt written
 *                       off and placed with the agency at D+45
 *   Consumer VIP        long grace, an account task before any bar, soft bar at D+30, hard bar at D+60, and no automatic termination: a person decides
 *   Enterprise          the same high-touch ladder for business customers, ending in a confirmed termination at D+90
 *   High risk           for customers with a bad credit history: everything sooner, ending at D+30
 *
 * The days, amounts, QR scheme and wording are the usual shape of these ladders, not any operator's actual policy and not legal advice: the operator reviews them
 * (Settings → Dunning rules) with its commercial and legal teams before relying on them. Running the seed again adds only what is missing.
 */
export const SEA_MARKETS = ['SG', 'MY', 'TH', 'PH', 'ID'] as const;
export type SeaMarket = (typeof SEA_MARKETS)[number];
interface MarketFacts { name: string; currency: string; qr: QrScheme; bureau: string; fee: { mode: 'FLAT' | 'PERCENT'; major?: number; bps?: number; minMajor?: number; maxMajor?: number } }
export const MARKET_FACTS: Record<SeaMarket, MarketFacts> = {
  SG: { name: 'Singapore', currency: 'SGD', qr: 'PAYNOW', bureau: 'Credit Bureau Singapore', fee: { mode: 'FLAT', major: 5 } },
  MY: { name: 'Malaysia', currency: 'MYR', qr: 'DUITNOW', bureau: 'CTOS and other credit reporting agencies', fee: { mode: 'PERCENT', bps: 150, minMajor: 5, maxMajor: 100 } },
  TH: { name: 'Thailand', currency: 'THB', qr: 'PROMPTPAY', bureau: 'the National Credit Bureau', fee: { mode: 'PERCENT', bps: 150, minMajor: 100, maxMajor: 2000 } },
  PH: { name: 'the Philippines', currency: 'PHP', qr: 'QRPH', bureau: 'the Credit Information Corporation', fee: { mode: 'FLAT', major: 150 } },
  ID: { name: 'Indonesia', currency: 'IDR', qr: 'QRIS', bureau: 'credit information agencies', fee: { mode: 'FLAT', major: 25000 } },
};
const minor = (major: number, currency: string) => Math.round(major * 10 ** (currencyInfo(currency)?.exponent ?? 2));

type StepSpec = { name: string; day: number; action: DunningStepAction; params?: DunningStepParams; ex?: DunningStepExclusions; balance?: number };
const D: DunningStepExclusions = { dispute: true }, DA: DunningStepExclusions = { dispute: true, arrangement: true };
const mkSteps = (specs: StepSpec[]): DunningRuleInput['steps'] => specs.map((s, i) => ({ position: i, name: s.name, enabled: true, trigger: { kind: 'DAYS_PAST_DUE', days: s.day } as DunningStepTrigger, action: s.action, params: s.params ?? {}, exclusions: s.ex ?? {} }));

/** The four rules of a market, ready to save. `feeId` is the market's late fee. */
export function marketRules(mk: SeaMarket, feeId: string): Array<{ code: string; input: DunningRuleInput }> {
  const f = MARKET_FACTS[mk];
  const qr = { includeQr: true, qrScheme: f.qr };
  const rule = (code: string, name: string, description: string, priority: number, cond: Partial<DunningRuleInput>, partial: DunningRuleInput['partial'], steps: StepSpec[]) =>
    ({ code: `${code}-${mk.toLowerCase()}`, input: { code: `${code}-${mk.toLowerCase()}`, name: `${name} (${f.name})`, description, active: true, priority, market: mk, customerKind: 'ANY', segments: [], vip: 'ANY', creditRisk: 'ANY', partial, ...cond, steps: mkSteps(steps) } as DunningRuleInput });
  return [
    rule('consumer-standard', 'Consumer standard', 'The default for every customer no other rule fits. Reminder with a QR code, late fee, soft bar, hard bar, final demand, termination.', 10, {}, { thresholdPercent: 80, action: 'RESET_TO_SOFT_BAR', pauseDays: 7 }, [
      { name: 'Friendly reminder with QR payment', day: 1, action: 'NOTIFY', params: { channels: ['SMS', 'WHATSAPP'], template: 'FRIENDLY_REMINDER', ...qr } },
      { name: 'First notice, grace period over', day: 7, action: 'NOTIFY', params: { channels: ['SMS', 'EMAIL'], template: 'FIRST_NOTICE', ...qr }, ex: D },
      { name: 'Late payment charge', day: 7, action: 'LATE_FEE', params: { lateFeeId: feeId }, ex: DA },
      { name: 'Soft bar: block outgoing', day: 14, action: 'SOFT_BAR', ex: DA },
      { name: 'Hard bar: full service block', day: 21, action: 'HARD_BAR', ex: DA },
      { name: 'Final demand before termination', day: 35, action: 'NOTIFY', params: { channels: ['EMAIL', 'SMS'], template: 'FINAL_DEMAND', final: true, ...qr }, ex: D },
      { name: 'Terminate, write off and place with the agency', day: 45, action: 'TERMINATE', params: { debt: 'BOTH' }, ex: DA },
    ]),
    rule('consumer-vip', 'Consumer VIP', 'Longer grace, a task for customer care before any bar, and no automatic termination: a person decides.', 200, { customerKind: 'INDIVIDUAL', vip: 'YES' }, { thresholdPercent: 50, action: 'PAUSE', pauseDays: 7 }, [
      { name: 'Friendly reminder with QR payment', day: 3, action: 'NOTIFY', params: { channels: ['WHATSAPP', 'SMS'], template: 'FRIENDLY_REMINDER', ...qr } },
      { name: 'Second notice', day: 10, action: 'NOTIFY', params: { channels: ['SMS', 'EMAIL'], template: 'SECOND_NOTICE', ...qr }, ex: D },
      { name: 'VIP follow-up by customer care', day: 14, action: 'CASE_TASK', params: { team: 'Customer care (VIP)', dueHours: 48, holdsLaterBars: true, waitDays: 10 } },
      { name: 'Soft bar: block outgoing', day: 30, action: 'SOFT_BAR', ex: DA },
      { name: 'Hard bar: full service block', day: 60, action: 'HARD_BAR', ex: DA },
      { name: 'Final demand', day: 75, action: 'NOTIFY', params: { channels: ['EMAIL', 'SMS'], template: 'FINAL_DEMAND', final: true, ...qr }, ex: D },
      { name: 'Decide whether to terminate', day: 90, action: 'CASE_TASK', params: { team: 'Collections manager', dueHours: 72, subject: 'VIP account overdue: decide whether to terminate', waitDays: 7 } },
    ]),
    rule('enterprise', 'Enterprise and business', 'High-touch: an account manager is asked to act before any bar, soft bar at D+30, hard bar at D+60, termination at D+90 after the account manager confirms.', 200, { customerKind: 'BUSINESS' }, { thresholdPercent: 50, action: 'PAUSE', pauseDays: 7 }, [
      { name: 'Reminder to the finance contact', day: 1, action: 'NOTIFY', params: { channels: ['EMAIL', 'SMS'], template: 'FRIENDLY_REMINDER', ...qr } },
      { name: 'Second notice', day: 7, action: 'NOTIFY', params: { channels: ['EMAIL'], template: 'SECOND_NOTICE', ...qr }, ex: D },
      { name: 'Account manager follow-up', day: 14, action: 'CASE_TASK', params: { team: 'Account management', dueHours: 72, holdsLaterBars: true, waitDays: 14 } },
      { name: 'Late payment charge', day: 15, action: 'LATE_FEE', params: { lateFeeId: feeId }, ex: DA },
      { name: 'Soft bar: block outgoing', day: 30, action: 'SOFT_BAR', ex: DA },
      { name: 'Hard bar: full service block', day: 60, action: 'HARD_BAR', ex: DA },
      { name: 'Final demand', day: 75, action: 'NOTIFY', params: { channels: ['EMAIL'], template: 'FINAL_DEMAND', final: true, ...qr }, ex: D },
      { name: 'Confirm termination with the customer', day: 80, action: 'CASE_TASK', params: { team: 'Account management', dueHours: 120, subject: 'Overdue business account: confirm termination with the customer', holdsLaterBars: true, waitDays: 10 } },
      { name: 'Terminate, write off and place with the agency', day: 90, action: 'TERMINATE', params: { debt: 'BOTH' }, ex: DA },
    ]),
    rule('high-risk', 'High risk (bad credit history)', 'For customers with a poor payment history: reminders, charges and bars come sooner, and the ladder ends at D+30.', 300, { customerKind: 'INDIVIDUAL', creditRisk: 'HIGH' }, { thresholdPercent: 100, action: 'PAUSE', pauseDays: 3 }, [
      { name: 'Reminder with QR payment', day: 1, action: 'NOTIFY', params: { channels: ['SMS', 'WHATSAPP'], template: 'FRIENDLY_REMINDER', ...qr } },
      { name: 'Late payment charge', day: 3, action: 'LATE_FEE', params: { lateFeeId: feeId }, ex: DA },
      { name: 'Soft bar: block outgoing', day: 5, action: 'SOFT_BAR', ex: DA },
      { name: 'Hard bar: full service block', day: 10, action: 'HARD_BAR', ex: DA },
      { name: 'Final demand before termination', day: 21, action: 'NOTIFY', params: { channels: ['SMS', 'EMAIL'], template: 'FINAL_DEMAND', final: true, ...qr }, ex: D },
      { name: 'Terminate, write off and place with the agency', day: 30, action: 'TERMINATE', params: { debt: 'BOTH' }, ex: DA },
    ]),
  ];
}

/** Installs a market's late fee and rules. Rules that already exist (by code) are left alone, so this can be run again and never undoes an edit. */
export async function seedDunningRules(q: Queryable, o: { market?: string; actor?: string } = {}): Promise<{ market: SeaMarket; created: string[]; skipped: string[] }> {
  const actor = o.actor ?? 'seed';
  const country = (o.market ?? (await getRegional(q)).country ?? 'SG').toUpperCase();
  const market = ((SEA_MARKETS as readonly string[]).includes(country) ? country : 'SG') as SeaMarket;
  const f = MARKET_FACTS[market];
  const code = `late-fee-${market.toLowerCase()}`;
  let fee = (await listLateFees(q)).find((x) => x.code === code);
  if (!fee) {
    fee = await saveLateFee(q, actor, { code, name: `Late payment charge (${f.name})`, mode: f.fee.mode, flatMinor: f.fee.major ? minor(f.fee.major, f.currency) : 0, percentBps: f.fee.bps ?? 0,
      minMinor: f.fee.minMajor ? minor(f.fee.minMajor, f.currency) : 0, maxMinor: f.fee.maxMajor ? minor(f.fee.maxMajor, f.currency) : null, taxable: false });
  }
  const have = new Set((await listDunningRules(q)).map((r) => r.code));
  const created: string[] = [], skipped: string[] = [];
  for (const r of marketRules(market, fee.id)) {
    if (have.has(r.code)) { skipped.push(r.code); continue; }
    await saveDunningRule(q, actor, r.input);
    created.push(r.code);
  }
  const pay = await getDunningPayments(q);
  if (!pay.bureau) await setDunningPayments(q, actor, { bureau: f.bureau });
  return { market, created, skipped };
}
