import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';

/**
 * The numeric limits of a dunning rule: ONE definition. `dunningRuleProblems` enforces them, the API sends them to the Dunning rules screen with the rules, and
 * the screen's inputs (max, maxLength, the step counter and its hints) read them from there, so the screen and the server always show and check the same numbers.
 * The browser never imports this file.
 *
 * Two of them are the operator's to set (Settings → Dunning rules → Limits, stored with the other dunning settings under the `dunningLimits` key): how many
 * steps a ladder may have and the highest priority a rule may carry. The rest are fixed because they follow from what the engine and the templates can do.
 */
export const DUNNING_LIMIT_DEFAULTS = { maxSteps: 30, maxPriority: 1000 } as const;
/** What the operator may set the two configurable limits to. */
export const DUNNING_LIMIT_BOUNDS = { maxSteps: { min: 1, max: 100 }, maxPriority: { min: 1, max: 100_000 } } as const;
/** Fixed limits (not configurable). */
export const DUNNING_LIMITS = {
  priorityMin: 0,
  nameMax: 80, descriptionMax: 400, stepNameMax: 80, messageMax: 1000, teamMax: 60,
  /** Days past due, and the "at least N days" of a balance trigger. */
  dayMax: 365,
  /** A case task is due in this many hours at most (60 days). */
  dueHoursMax: 24 * 60,
  /** Days a case task may hold later bars. */
  waitDaysMax: 90,
  partialThresholdMin: 1, partialThresholdMax: 100,
  pauseDaysMin: 1, pauseDaysMax: 60,
} as const;

export interface DunningLimitSettings { maxSteps: number; maxPriority: number }
/** Everything the screen needs: the fixed limits, the two set by the operator, and the range the operator may choose from. */
export type DunningLimitsView = typeof DUNNING_LIMITS & DunningLimitSettings & { bounds: typeof DUNNING_LIMIT_BOUNDS; defaults: typeof DUNNING_LIMIT_DEFAULTS };

const KEY = 'dunningLimits';
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export async function getDunningLimitSettings(q: Queryable): Promise<DunningLimitSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key=$1`, [KEY])).rows[0]?.value as Partial<DunningLimitSettings> | undefined;
  const { maxSteps: s, maxPriority: p } = DUNNING_LIMIT_BOUNDS;
  // A stored value outside the allowed range (edited by hand, or the range changed) falls back to the default rather than switching the check off.
  return { maxSteps: whole(v?.maxSteps, s.min, s.max) ? v!.maxSteps! : DUNNING_LIMIT_DEFAULTS.maxSteps, maxPriority: whole(v?.maxPriority, p.min, p.max) ? v!.maxPriority! : DUNNING_LIMIT_DEFAULTS.maxPriority };
}
export async function getDunningLimits(q: Queryable): Promise<DunningLimitsView> {
  return { ...DUNNING_LIMITS, ...(await getDunningLimitSettings(q)), bounds: DUNNING_LIMIT_BOUNDS, defaults: DUNNING_LIMIT_DEFAULTS };
}

/** Rules that are over the limits now. They keep loading and can be viewed; saving one asks for a fix. */
export async function dunningRulesOverLimits(q: Queryable, lim?: DunningLimitSettings): Promise<Array<{ id: string; name: string; priority: number; steps: number; reasons: string[] }>> {
  const l = lim ?? (await getDunningLimitSettings(q));
  const rows = (await q.query(`SELECT r.id, r.name, r.priority, (SELECT count(*) FROM dunning_rule_steps s WHERE s.rule_id = r.id)::int AS steps FROM dunning_rules r ORDER BY r.name`)).rows;
  return rows.filter((r) => r.priority > l.maxPriority || r.steps > l.maxSteps).map((r) => ({
    id: r.id as string, name: r.name as string, priority: r.priority as number, steps: r.steps as number,
    reasons: [...(r.priority > l.maxPriority ? [`priority ${r.priority} is above ${l.maxPriority}`] : []), ...(r.steps > l.maxSteps ? [`${r.steps} steps is more than ${l.maxSteps}`] : [])],
  }));
}

export async function setDunningLimits(q: Queryable, actor: string, i: Partial<DunningLimitSettings>) {
  const cur = await getDunningLimitSettings(q), b = DUNNING_LIMIT_BOUNDS;
  const next: DunningLimitSettings = { maxSteps: i.maxSteps ?? cur.maxSteps, maxPriority: i.maxPriority ?? cur.maxPriority };
  const bad: string[] = [];
  if (!whole(next.maxSteps, b.maxSteps.min, b.maxSteps.max)) bad.push(`The most steps in a ladder is a whole number from ${b.maxSteps.min} to ${b.maxSteps.max}.`);
  if (!whole(next.maxPriority, b.maxPriority.min, b.maxPriority.max)) bad.push(`The highest priority is a whole number from ${b.maxPriority.min} to ${b.maxPriority.max.toLocaleString('en-US')}.`);
  if (bad.length) throw invalid(bad.join(' '), bad);
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [KEY, JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', KEY, 'update', { ...next });
  // Lowering a limit never touches existing rules. The ones now over it are reported so the operator can fix them before they next save them.
  return { ...(await getDunningLimits(q)), rulesOverLimit: await dunningRulesOverLimits(q, next) };
}
