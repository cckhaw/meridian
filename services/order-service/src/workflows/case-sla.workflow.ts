import { condition, continueAsNew, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { CaseSlaActivities } from '../activities/case-sla.js';

const a = proxyActivities<CaseSlaActivities>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 5, backoffCoefficient: 2 } });

/** The CRM tells the watchdog the case changed (resumed from a pause, re-prioritised, reopened): its deadlines may have moved, so look again now. */
export const caseChangedSignal = defineSignal('caseChanged');
export const caseSlaStatus = defineQuery<{ fired: string[]; nextAt: string | null; closed: boolean; ticks: number }>('caseSlaStatus');

export interface CaseSlaInput { caseId: string; /** What earlier runs of this workflow already fired (carried over when the history is rolled). */ fired?: string[] }
export type CaseSlaOutcome = 'CLOSED';

const SECOND = 1000, MINUTE = 60 * SECOND, DAY = 86_400_000;
/** Longest sleep: even a case with nothing due is looked at again this often, in case its deadlines moved without a signal. */
const MAX_SLEEP = 7 * DAY;
const TICKS_PER_RUN = 200;

/**
 * One case's SLA watchdog. It asks the CRM to do whatever is due (supervisor warning at the warning percentage, breach and escalation, the automatic closing of a
 * resolved case, the closing of a case whose customer never answered), then sleeps on a durable timer until the next deadline, or until the CRM signals that
 * the case changed. It ends when the case is closed. Timers survive restarts and deploys, which is the point of running it here rather than in a cron job.
 */
export async function caseSlaWorkflow({ caseId, fired: carried = [] }: CaseSlaInput): Promise<CaseSlaOutcome> {
  const fired = [...carried];
  let nextAt: string | null = null, closed = false, ticks = 0, changed = false;
  setHandler(caseChangedSignal, () => { changed = true; });
  setHandler(caseSlaStatus, () => ({ fired: [...fired], nextAt, closed, ticks }));

  for (;;) {
    changed = false;
    const t = await a.caseSlaTick(caseId, new Date(Date.now()).toISOString());
    ticks += 1;
    for (const f of t.fired) { fired.push(f); await a.casePublish('meridian.cases.events', caseId, { type: f }); }
    nextAt = t.nextAt; closed = t.closed;
    if (t.closed) { await a.casePublish('meridian.cases.events', caseId, { type: 'WATCH_ENDED' }); return 'CLOSED'; }
    let wait = t.nextAt ? Date.parse(t.nextAt) - Date.now() : MAX_SLEEP;
    if (wait <= 0) wait = t.fired.length ? SECOND : MINUTE;     // due but not done (the CRM lost a race): do not spin
    if (!changed) await condition(() => changed, Math.min(wait, MAX_SLEEP));
    if (ticks >= TICKS_PER_RUN) await continueAsNew<typeof caseSlaWorkflow>({ caseId, fired });
  }
}
