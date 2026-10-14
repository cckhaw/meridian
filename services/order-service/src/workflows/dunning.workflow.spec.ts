import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubDunningActivities, type DunningActivities, type DunningStepInput } from '../activities/dunning.js';
import { dunningWorkflow, paymentReceivedSignal } from './dunning.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const LADDER: DunningStepInput[] = [
  { action: 'REMIND', day: 1 }, { action: 'SOFT_BAR', day: 7 }, { action: 'HARD_BAR', day: 14 }, { action: 'FINAL_NOTICE', day: 30 }, { action: 'TERMINATE', day: 45 },
];
const today = () => new Date(env ? Date.now() : Date.now()).toISOString().slice(0, 10);

async function run(acts: Partial<DunningActivities>, body: (h: import('@temporalio/client').WorkflowHandle<typeof dunningWorkflow>) => Promise<void>, steps = LADDER) {
  const calls: string[] = [];
  const activities = new Proxy({ ...stubDunningActivities, ...acts } as Record<string, unknown>, {
    get: (t, k: string) => (typeof t[k] === 'function' ? (...a: unknown[]) => { calls.push(k === 'applyDunningStep' ? `step:${a[1]}` : k); return (t[k] as (...x: unknown[]) => unknown)(...a); } : undefined),
  });
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'dunning-test', workflowsPath: new URL('./index.ts', import.meta.url).pathname, activities: activities as never });
  return worker.runUntil(async () => {
    // D is today, so the first step (D+1) is one day away and the ladder spans 45 days of (skipped) time.
    const h = await env.client.workflow.start(dunningWorkflow, { taskQueue: 'dunning-test', workflowId: `d-${Math.random()}`, args: [{ accountId: 'acct-1', dueDate: today(), steps }] });
    await body(h);
    return { result: await h.result(), calls };
  });
}

describe('dunningWorkflow', () => {
  it('escalates through the ladder on its timers and ends in termination', async () => {
    const { result, calls } = await run({}, async () => {});
    expect(result).toBe('TERMINATED');
    expect(calls.filter((c) => c.startsWith('step:'))).toEqual(['step:REMIND', 'step:SOFT_BAR', 'step:HARD_BAR', 'step:FINAL_NOTICE', 'step:TERMINATE']);
  });

  it('stops escalating the moment a payment signal arrives, and confirms the restoration', async () => {
    let handle: import('@temporalio/client').WorkflowHandle<typeof dunningWorkflow>;
    const { result, calls } = await run(
      // The customer pays right after the soft bar is applied (the signal arrives while the workflow waits for D+14).
      { applyDunningStep: async (_id, action) => { if (action === 'SOFT_BAR') await handle.signal(paymentReceivedSignal, { invoiceId: 'inv-1' }); return { applied: action }; } },
      async (h) => { handle = h; },
    );
    expect(result).toBe('PAID');
    expect(calls.filter((c) => c.startsWith('step:'))).toEqual(['step:REMIND', 'step:SOFT_BAR']);
    expect(calls).toContain('confirmRestored');
  });

  it('also stops when the CRM says nothing is overdue any more (paid at a store)', async () => {
    let asked = 0;
    const { result, calls } = await run({ isStillOverdue: async () => ++asked < 3 }, async () => {});
    expect(result).toBe('PAID');
    expect(calls.filter((c) => c.startsWith('step:'))).toEqual(['step:REMIND', 'step:SOFT_BAR']); // the third check found it paid
  });

  it('runs whatever ladder it is given', async () => {
    const { result, calls } = await run({}, async () => {}, [{ action: 'REMIND', day: 2 }, { action: 'HARD_BAR', day: 3 }]);
    expect(result).toBe('COMPLETED');
    expect(calls.filter((c) => c.startsWith('step:'))).toEqual(['step:REMIND', 'step:HARD_BAR']);
  });
});
