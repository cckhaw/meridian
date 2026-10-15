/** What a rule-driven ladder needs from the CRM. The ladder itself (steps, exclusions, holds, late fees, bars) lives in the CRM; the workflow only keeps the time. */
export type LadderStepState = 'DONE' | 'SUPERSEDED' | 'DUE' | 'HELD' | 'LATER';
export interface LadderStepView { id: string; name: string; action: string; state: LadderStepState; /** YYYY-MM-DD the step falls due, or null for a balance trigger. */ dueOn: string | null; reason?: string }
export interface LadderView { ruleCode: string | null; overdue: boolean; daysPastDue: number; pausedUntil: string | null; steps: LadderStepView[] }
export interface LadderRunResult { applied: Array<{ stepId: string; name: string; action: string; status: 'APPLIED' | 'SUPERSEDED' | 'HELD' | 'FAILED' }> }

/**
 * Real implementations call the back-office API; each call is idempotent (the CRM logs every step once per run), so Temporal can retry freely:
 *   getLadder -> GET  /accounts/:id/collections            (`ladder`: the rule, days past due, the balance overdue (overdue = balanceMinor > 0), paused-until, and every step with its state and date)
 *   runLadder -> POST /accounts/:id/collections/run { asOf } (applies whatever is due, in order; holds, exclusions and partial payments are decided there)
 */
export interface DunningLadderActivities {
  getLadder(accountId: string, asOf: string): Promise<LadderView>;
  runLadder(accountId: string, asOf: string): Promise<LadderRunResult>;
}
export const stubDunningLadderActivities: DunningLadderActivities = {
  async getLadder() { return { ruleCode: null, overdue: false, daysPastDue: 0, pausedUntil: null, steps: [] }; },
  async runLadder(accountId, asOf) { console.log(`[dunning ladder ${accountId}] run (${asOf})`); return { applied: [] }; },
};
