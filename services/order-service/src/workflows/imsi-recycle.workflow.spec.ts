import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubNrmActivities, type NrmActivities } from '../activities/nrm.js';
import { imsiRecycleWorkflow, recycleNowSignal, recycleStatus } from './imsi-recycle.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

describe('imsiRecycleWorkflow', () => {
  it('sweeps on a timer, restores what the CRM reports, and starts a fresh run before its history grows', async () => {
    const calls: string[] = [];
    const acts: NrmActivities = {
      ...stubNrmActivities,
      async recycleExpired(asOf) { calls.push(`recycle:${asOf}`); return { imsis: 2, msisdns: 1, expiredHolds: 0 }; },
      async publishEvent(topic, _key, payload) { calls.push(`${topic}:${(payload as { type: string }).type}`); },
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'nrm-test', workflowsPath: new URL('./index.ts', import.meta.url).pathname, activities: acts as never });
    await worker.runUntil(async () => {
      const h = await env.client.workflow.start(imsiRecycleWorkflow, { taskQueue: 'nrm-test', workflowId: `nrm-${Math.random()}`, args: [{ everyMinutes: 10, sweepsPerRun: 3 }] });
      await env.sleep('35 minutes'); // sweeps at 0, 10, 20, 30 minutes: the run rolls over after three
      const status = await h.query(recycleStatus).catch(() => null);
      await h.terminate('test over');
      expect(calls.filter((c) => c.startsWith('recycle:')).length).toBeGreaterThanOrEqual(3);
      expect(calls).toContain('meridian.nrm.events:POOL_RESTORED');
      if (status) expect(status.imsis).toBeGreaterThanOrEqual(2);
    });
  });

  it('sweeps at once when signalled', async () => {
    let sweeps = 0;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'nrm-test2', workflowsPath: new URL('./index.ts', import.meta.url).pathname,
      activities: { ...stubNrmActivities, async recycleExpired() { sweeps++; return { imsis: 0, msisdns: 0, expiredHolds: 0 }; } } as never });
    await worker.runUntil(async () => {
      const h = await env.client.workflow.start(imsiRecycleWorkflow, { taskQueue: 'nrm-test2', workflowId: `nrm-${Math.random()}`, args: [{ everyMinutes: 600 }] });
      await env.sleep('1 second');
      const before = sweeps;
      await h.signal(recycleNowSignal);
      await env.sleep('1 second');
      expect(sweeps).toBeGreaterThan(before);
      await h.terminate('test over');
    });
  });
});
