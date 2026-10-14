import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';

export const DUNNING_ACTIONS = ['REMIND', 'SOFT_BAR', 'HARD_BAR', 'FINAL_NOTICE', 'TERMINATE'] as const;
export type DunningAction = (typeof DUNNING_ACTIONS)[number];
export interface DunningStep { action: DunningAction; /** Days after the due date (D) on which the step applies. */ day: number }

export interface LifecycleSettings {
  voluntary: {
    /** The longest a customer can ask to be suspended, in months. */
    maxMonths: number;
    /** Whether customers can suspend and resume themselves in the portal (staff can always). */
    selfServe: boolean;
  };
  credit: {
    /** Credit limit for accounts that have none of their own, in minor units. 0 = no limit is enforced. */
    defaultLimitMinor: number;
    warnPercent: number;
    blockPercent: number;
    /** What happens at the block threshold: slow data down, or bar outgoing calls/SMS and data (soft bar). */
    blockAction: 'THROTTLE' | 'SOFT_BAR';
  };
  /** The dunning ladder. Each step applies on its day after the due date, once, in order. */
  dunning: DunningStep[];
  termination: {
    /** How long a released number rests before it can be recycled. */
    quarantineDays: number;
    /** What happens to the debt left when a service is terminated for non-payment. */
    debtAction: 'COLLECTIONS' | 'WRITE_OFF';
    /** Customer segments that are never charged an early-termination charge (VIP and similar). */
    waiveEtcSegments: string[];
  };
}

export const DEFAULT_LIFECYCLE: LifecycleSettings = {
  voluntary: { maxMonths: 6, selfServe: true },
  credit: { defaultLimitMinor: 0, warnPercent: 80, blockPercent: 100, blockAction: 'SOFT_BAR' },
  dunning: [
    { action: 'REMIND', day: 1 }, { action: 'SOFT_BAR', day: 7 }, { action: 'HARD_BAR', day: 14 }, { action: 'FINAL_NOTICE', day: 30 }, { action: 'TERMINATE', day: 45 },
  ],
  termination: { quarantineDays: 90, debtAction: 'COLLECTIONS', waiveEtcSegments: [] },
};

export async function getLifecycleSettings(q: Queryable): Promise<LifecycleSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='lifecycle'`)).rows[0]?.value as Partial<LifecycleSettings> | undefined;
  return {
    voluntary: { ...DEFAULT_LIFECYCLE.voluntary, ...v?.voluntary },
    credit: { ...DEFAULT_LIFECYCLE.credit, ...v?.credit },
    dunning: Array.isArray(v?.dunning) && v!.dunning.length ? v!.dunning : DEFAULT_LIFECYCLE.dunning,
    termination: { ...DEFAULT_LIFECYCLE.termination, ...v?.termination },
  };
}

/** Checks a ladder is one that makes sense: steps run in order, each at most once, and a bar never comes after the termination. */
export function dunningProblems(steps: DunningStep[]): string[] {
  const p: string[] = [];
  if (!steps.length) return ['The ladder needs at least one step.'];
  const seen = new Set<string>();
  let last = 0;
  for (const s of steps) {
    if (!(DUNNING_ACTIONS as readonly string[]).includes(s.action)) { p.push(`Unknown step ${s.action}.`); continue; }
    if (!Number.isInteger(s.day) || s.day < 0 || s.day > 365) p.push(`${s.action}: the day is a whole number from 0 to 365.`);
    if (seen.has(s.action)) p.push(`${s.action} appears twice.`);
    seen.add(s.action);
    if (s.day <= last && last !== 0) p.push(`${s.action} (day ${s.day}) must come after the step before it (day ${last}).`);
    last = s.day;
  }
  // Bars only get harder: SOFT_BAR before HARD_BAR before TERMINATE; notices can sit anywhere before the termination.
  const rank = (a: DunningAction) => (a === 'SOFT_BAR' ? 1 : a === 'HARD_BAR' ? 2 : a === 'TERMINATE' ? 3 : 0);
  let top = 0;
  for (const s of steps) { const r = rank(s.action); if (r && r < top) p.push(`${s.action} cannot come after a harder step.`); if (r) top = r; }
  const t = steps.find((s) => s.action === 'TERMINATE');
  if (t && steps.some((s) => s.day > t.day)) p.push('Nothing can come after the termination step.');
  return p;
}

export async function setLifecycleSettings(q: Queryable, actor: string, input: LifecycleSettings): Promise<LifecycleSettings> {
  const s: LifecycleSettings = {
    voluntary: { maxMonths: Math.trunc(input.voluntary.maxMonths), selfServe: !!input.voluntary.selfServe },
    credit: { ...input.credit },
    dunning: [...input.dunning].sort((a, b) => a.day - b.day),
    termination: { ...input.termination, waiveEtcSegments: [...new Set((input.termination.waiveEtcSegments ?? []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 50) },
  };
  const bad: string[] = [];
  if (!(s.voluntary.maxMonths >= 1 && s.voluntary.maxMonths <= 24)) bad.push('A voluntary suspension can last 1 to 24 months at most.');
  const c = s.credit;
  if (!Number.isInteger(c.defaultLimitMinor) || c.defaultLimitMinor < 0) bad.push('The default credit limit is a whole amount, zero or more (zero means none is enforced).');
  if (!(c.warnPercent >= 1 && c.warnPercent < c.blockPercent && c.blockPercent <= 200)) bad.push('The warning threshold must be below the block threshold (for example 80% and 100%).');
  if (!['THROTTLE', 'SOFT_BAR'].includes(c.blockAction)) bad.push('Choose what happens at the block threshold: throttle data, or soft bar.');
  bad.push(...dunningProblems(s.dunning));
  const t = s.termination;
  if (!(Number.isInteger(t.quarantineDays) && t.quarantineDays >= 0 && t.quarantineDays <= 730)) bad.push('Quarantine is 0 to 730 days.');
  if (!['COLLECTIONS', 'WRITE_OFF'].includes(t.debtAction)) bad.push('Choose what happens to the debt: collections, or write-off.');
  if (bad.length) throw invalid(bad.join(' '));
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('lifecycle', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(s), actor]);
  await audit(q, actor, 'settings', 'lifecycle', 'update', { ...s });
  return s;
}
