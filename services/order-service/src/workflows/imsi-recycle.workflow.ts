import { condition, continueAsNew, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { NrmActivities } from '../activities/nrm.js';

const a = proxyActivities<NrmActivities>({ startToCloseTimeout: '5 minutes', retry: { maximumAttempts: 5, backoffCoefficient: 2 } });

/** Run a sweep now instead of waiting for the next interval (an operator, or the CRM after a bulk termination). */
export const recycleNowSignal = defineSignal('recycleNow');
export const recycleStatus = defineQuery<{ sweeps: number; imsis: number; msisdns: number; expiredHolds: number; lastSweep: string | null }>('recycleStatus');

export interface RecycleWorkflowInput {
  /** Time between sweeps. */
  everyMinutes?: number;
  /** After this many sweeps the workflow starts a fresh run, so its history never grows without bound. */
  sweepsPerRun?: number;
  /** Totals carried across runs. */
  totals?: { sweeps: number; imsis: number; msisdns: number; expiredHolds: number };
}

/**
 * The cooling-off clock for subscriber identities and phone numbers. On every tick it asks the CRM to move what has finished its quarantine back
 * to the pool: each IMSI goes QUARANTINED -> RECYCLED -> POOL_UNASSIGNED (decoupled from any SIM, ready to be written onto a new SIM batch or issued as a
 * fresh eSIM profile), each number QUARANTINE_COOLING -> AVAILABLE in the tier it now belongs to, and checkout holds that ran out are released.
 * Run one instance (workflow id `nrm-recycle`). The CRM call is idempotent, so a retry or an extra signal can never restore anything twice.
 */
export async function imsiRecycleWorkflow(input: RecycleWorkflowInput = {}): Promise<void> {
  const everyMs = (input.everyMinutes ?? 60) * 60_000;
  const perRun = input.sweepsPerRun ?? 500;
  const totals = { sweeps: 0, imsis: 0, msisdns: 0, expiredHolds: 0, ...input.totals };
  let lastSweep: string | null = null;
  let now = false;
  setHandler(recycleNowSignal, () => { now = true; });
  setHandler(recycleStatus, () => ({ ...totals, lastSweep }));

  for (let i = 0; i < perRun; i++) {
    const asOf = new Date().toISOString().slice(0, 10);
    const r = await a.recycleExpired(asOf);
    totals.sweeps++; totals.imsis += r.imsis; totals.msisdns += r.msisdns; totals.expiredHolds += r.expiredHolds;
    lastSweep = new Date().toISOString();
    if (r.imsis || r.msisdns) await a.publishEvent('meridian.nrm.events', 'recycle', { type: 'POOL_RESTORED', imsis: r.imsis, msisdns: r.msisdns, asOf });
    now = false;
    await Promise.race([sleep(everyMs), condition(() => now)]); // durable timer; a signal cuts it short
  }
  await continueAsNew<typeof imsiRecycleWorkflow>({ everyMinutes: input.everyMinutes, sweepsPerRun: input.sweepsPerRun, totals });
}
