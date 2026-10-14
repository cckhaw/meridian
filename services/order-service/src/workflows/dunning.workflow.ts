import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { DunningActivities, DunningAction, DunningStepInput } from '../activities/dunning.js';

const a = proxyActivities<DunningActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, backoffCoefficient: 2 },
});

const DAY_MS = 86_400_000;

/** The payment webhook (or the CRM, when an invoice is settled) tells the ladder the customer has paid. */
export const paymentReceivedSignal = defineSignal<[{ invoiceId?: string; amountMinor?: number }]>('paymentReceived');
export const dunningStatus = defineQuery<{ stage: DunningAction | 'WAITING'; applied: DunningAction[]; paid: boolean; nextStep: DunningStepInput | null }>('dunningStatus');

export interface DunningWorkflowInput {
  accountId: string;
  /** The due date (D) of the oldest unpaid invoice, YYYY-MM-DD. */
  dueDate: string;
  /** The ladder (Settings → Lifecycle): each step on its day after D. Sorted by day. */
  steps: DunningStepInput[];
}
export type DunningOutcome = 'PAID' | 'TERMINATED' | 'COMPLETED';

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * One dunning ladder for one account. It sleeps (a durable timer) until each step's day, applies the step, and escalates; a payment signal wakes
 * it at once, ends the ladder and confirms the restoration. Before every step it asks the CRM whether anything is still overdue, so a payment made
 * another way (cash at a store) also stops the escalation. Timers survive deploys and restarts: that is the point of running it here.
 */
export async function dunningWorkflow({ accountId, dueDate, steps }: DunningWorkflowInput): Promise<DunningOutcome> {
  const ladder = [...steps].sort((x, y) => x.day - y.day);
  const applied: DunningAction[] = [];
  let paid = false;
  let stage: DunningAction | 'WAITING' = 'WAITING';
  setHandler(paymentReceivedSignal, () => { paid = true; });
  setHandler(dunningStatus, () => ({ stage, applied: [...applied], paid, nextStep: ladder.find((s) => !applied.includes(s.action)) ?? null }));

  const due = Date.parse(`${dueDate}T00:00:00Z`);
  for (const step of ladder) {
    const at = due + step.day * DAY_MS;
    const wait = at - Date.now();
    // Sleep until the step is due, or until the customer pays, whichever is first.
    if (wait > 0) await condition(() => paid, wait);
    if (paid) break;
    if (!(await a.isStillOverdue(accountId))) { paid = true; break; }
    await a.applyDunningStep(accountId, step.action, isoDay(Math.max(at, Date.now())));
    applied.push(step.action);
    stage = step.action;
    await a.publishEvent('meridian.dunning.events', accountId, { type: step.action, day: step.day });
    if (step.action === 'TERMINATE') return 'TERMINATED';
  }
  if (paid) {
    await a.confirmRestored(accountId);
    await a.publishEvent('meridian.dunning.events', accountId, { type: 'PAID' });
    return 'PAID';
  }
  return 'COMPLETED';
}
