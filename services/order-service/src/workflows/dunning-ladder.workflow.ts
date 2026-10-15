import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { DunningLadderActivities, LadderStepView } from '../activities/dunning-ladder.js';
import type { DunningActivities } from '../activities/dunning.js';

const a = proxyActivities<DunningLadderActivities & Pick<DunningActivities, 'confirmRestored' | 'publishEvent'>>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, backoffCoefficient: 2 },
});

const DAY_MS = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const at = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Instant payment (a bank webhook, a QR scan, cash at a store): the ladder stops and the customer is told service is back. */
export const paymentReceivedSignal = defineSignal<[{ invoiceId?: string; amountMinor?: number }]>('paymentReceived');
/** A payment that left something overdue: the CRM has already applied the rule's partial-payment policy (reset to a soft bar, or a pause); the ladder re-reads it. */
export const partialPaymentSignal = defineSignal<[{ amountMinor?: number; pausedUntil?: string }]>('partialPayment');
export const ladderStatus = defineQuery<{ stage: string; applied: string[]; paid: boolean; pausedUntil: string | null; next: { name: string; dueOn: string | null } | null }>('ladderStatus');

export interface DunningLadderInput {
  accountId: string;
  /** How often to look again at a step that is held (by a dispute, an arrangement, an account manager task). Default 1 day. */
  recheckHours?: number;
}
export type DunningLadderOutcome = 'PAID' | 'TERMINATED' | 'COMPLETED';

/**
 * One account's rule-driven dunning ladder. Unlike `dunningWorkflow`, which carries a fixed list of steps, this workflow asks the CRM what the ladder
 * is today (the steps of the rule frozen on the account's run, which are due, which are held and why), sleeps on a durable timer until the next step is
 * due, has the CRM apply what is due, and looks again. So it follows a partial payment's reset, a pause, a broken arrangement or a closed dispute without
 * knowing about any of them. A payment signal wakes it at once and ends it.
 */
export async function dunningLadderWorkflow({ accountId, recheckHours = 24 }: DunningLadderInput): Promise<DunningLadderOutcome> {
  let paid = false, nudged = false, pausedUntil: string | null = null, stage = 'WAITING';
  let next: { name: string; dueOn: string | null } | null = null;
  const applied: string[] = [];
  setHandler(paymentReceivedSignal, () => { paid = true; });
  setHandler(partialPaymentSignal, () => { nudged = true; });
  setHandler(ladderStatus, () => ({ stage, applied: [...applied], paid, pausedUntil, next }));

  for (;;) {
    const now = Date.now();
    const view = await a.getLadder(accountId, day(now));
    pausedUntil = view.pausedUntil;
    if (paid || !view.overdue) { paid = true; break; }
    const pending = view.steps.filter((s) => s.state === 'DUE' || s.state === 'HELD' || s.state === 'LATER');
    if (!pending.length) return 'COMPLETED';
    next = { name: pending[0]!.name, dueOn: pending[0]!.dueOn };

    // When to look next: a pause ends, or a step's day arrives. A held step, or a balance trigger, has no date to wait for, so those are looked at again every recheck interval.
    const hour = 3_600_000;
    const soon = (s: LadderStepView) => (s.state === 'DUE' ? now : s.state === 'LATER' && s.dueOn ? Math.max(at(s.dueOn), now) : now + recheckHours * hour);
    let wake = Math.min(...pending.map(soon));
    if (pausedUntil && at(pausedUntil) > now) wake = Math.max(wake, Math.min(at(pausedUntil), now + 60 * DAY_MS));
    nudged = false;
    if (wake > now) await condition(() => paid || nudged, wake - now);
    if (paid) break;
    if (nudged) continue;                                     // a partial payment changed things: read the ladder again before acting

    const ran = await a.runLadder(accountId, day(Math.max(wake, Date.now())));
    for (const r of ran.applied) {
      if (r.status !== 'APPLIED') continue;
      applied.push(r.action); stage = r.action;
      await a.publishEvent('meridian.dunning.events', accountId, { type: r.action, step: r.name });
      if (r.action === 'TERMINATE') return 'TERMINATED';
    }
    // Nothing was applied (a step failed or is held): do not spin, look again after the recheck interval or when something changes.
    if (!ran.applied.some((r) => r.status === 'APPLIED')) await condition(() => paid || nudged, recheckHours * 3_600_000);
  }
  await a.confirmRestored(accountId);
  await a.publishEvent('meridian.dunning.events', accountId, { type: 'PAID' });
  return 'PAID';
}
