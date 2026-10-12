import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubActivities, type OrderActivities } from '../activities/index.js';
import { retailDeviceFlow } from '../graph/default-definitions.js';
import { cancelRequested, orderStatus, orderWorkflow } from './order.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

async function run(acts: Partial<OrderActivities>, body: (h: import('@temporalio/client').WorkflowHandle<typeof orderWorkflow>) => Promise<void>) {
  const calls: string[] = [];
  const activities = new Proxy({ ...stubActivities, ...acts } as Record<string, unknown>, {
    get: (t, k: string) => (typeof t[k] === 'function' ? (...a: unknown[]) => { calls.push(k); return (t[k] as (...x: unknown[]) => unknown)(...a); } : undefined),
  });
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'test',
    workflowsPath: new URL('./index.ts', import.meta.url).pathname,
    activities: activities as never,
  });
  return worker.runUntil(async () => {
    const h = await env.client.workflow.start(orderWorkflow, {
      taskQueue: 'test', workflowId: `o-${Math.random()}`,
      args: [{ orderId: 'o1', definition: retailDeviceFlow, facts: { paymentMethod: 'CREDIT_CARD' } }],
    });
    await body(h);
    return { result: await h.result(), calls };
  });
}

describe('orderWorkflow', () => {
  it('completes the retail flow', async () => {
    const { result, calls } = await run({}, async () => {});
    expect(result).toBe('COMPLETED');
    expect(calls).toContain('activateService');
  });

  it('fails without capturing payment when credit check declines', async () => {
    const { result, calls } = await run({ creditCheck: async () => ({ approved: false }) }, async () => {});
    expect(result).toBe('FAILED');
    expect(calls).not.toContain('capturePayment');
  });

  it('refunds and releases stock when cancelled before PNR', async () => {
    let reserving = false;
    const { result, calls } = await run(
      { reserveInventory: async () => { reserving = true; await new Promise((r) => setTimeout(r, 400)); } },
      async (h) => {
        while (!reserving) await new Promise((r) => setTimeout(r, 20)); // payment already captured by now
        await h.signal(cancelRequested, { reason: 'changed mind' });
      },
    );
    expect(result).toBe('CANCELLED');
    expect(calls).toEqual(expect.arrayContaining(['refundPayment', 'releaseInventory']));
  });

  it('rejects cancel after PNR', async () => {
    let status: unknown;
    // Signal exactly when activation has started (PNR reached) rather than after a fixed delay, which raced on a loaded machine.
    let activating!: () => void;
    const started = new Promise<void>((r) => { activating = r; });
    const { result } = await run(
      { activateService: async () => { activating(); await new Promise((r) => setTimeout(r, 1000)); } },
      async (h) => {
        await started;
        await h.signal(cancelRequested, { reason: 'late' });
        status = await h.query(orderStatus);
      },
    );
    expect(result).toBe('COMPLETED');
    expect(status).toMatchObject({ pnrReached: true, cancelRejected: expect.stringMatching(/point of no return/) });
  });
});
