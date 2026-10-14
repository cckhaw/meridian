import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubPortInActivities, type PortInActivities } from '../activities/port-in.js';
import { portDecisionSignal, portInStatus, portInWorkflow } from './port-in.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const details = { portInId: 'p1', serviceId: 's1', donorOperator: 'OtherTel', donorRoutingCode: 'OT-01', donorMsisdn: '+60128001234', temporaryMsisdn: '+60125550001' };
const run = async (queue: string, acts: PortInActivities, go: (h: Awaited<ReturnType<typeof env.client.workflow.start>>) => Promise<void>, input: object = details) => {
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: queue, workflowsPath: new URL('./index.ts', import.meta.url).pathname, activities: acts as never });
  return worker.runUntil(async () => {
    const h = await env.client.workflow.start(portInWorkflow, { taskQueue: queue, workflowId: `${queue}-${Math.random()}`, args: [input as never] });
    await go(h);
    return h.result();
  });
};

describe('portInWorkflow', () => {
  it('waits for the donor, then swaps the temporary number on the network before the CRM takes the new one', async () => {
    const calls: string[] = [];
    const acts: PortInActivities = {
      ...stubPortInActivities,
      async submitToClearinghouse() { calls.push('submit'); return { reference: 'NCH-1' }; },
      async recordDecision(_id, d) { calls.push(`decision:${d.approved}:${d.reference}`); },
      async swapMsisdnOnNetwork(d) { calls.push(`hlr:${d.from}->${d.to}`); },
      async completePortIn() { calls.push('complete'); },
      async publishEvent(_t, _k, p) { calls.push(`event:${(p as { type: string }).type}`); },
    };
    const result = await run('pin-a', acts, async (h) => {
      await env.sleep('2 days'); // still waiting: the service is on its temporary number
      expect((await h.query(portInStatus)).state).toBe('SUBMITTED');
      await h.signal(portDecisionSignal, { approved: true });
      await h.signal(portDecisionSignal, { approved: false, reason: 'a late, repeated callback is ignored' });
    });
    expect(result).toBe('COMPLETED');
    expect(calls).toEqual(['submit', 'decision:true:NCH-1', 'hlr:+60125550001->+60128001234', 'complete', 'event:PORT_IN_COMPLETED']);
  });

  it('waits for the agreed switch-over date', async () => {
    const at: number[] = [];
    await run('pin-b', { ...stubPortInActivities, async swapMsisdnOnNetwork() { at.push(Date.now()); } }, async (h) => {
      await h.signal(portDecisionSignal, { approved: true, effectiveAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    });
    expect(at).toHaveLength(1); // time skipping: the wait was a durable timer, not a busy loop
  });

  it('records a refusal and leaves the line as it is', async () => {
    const calls: string[] = [];
    const result = await run('pin-c', { ...stubPortInActivities, async recordDecision(_i, d) { calls.push(`decision:${d.approved}`); }, async swapMsisdnOnNetwork() { calls.push('hlr'); }, async completePortIn() { calls.push('complete'); } },
      async (h) => { await h.signal(portDecisionSignal, { approved: false, reason: 'ID did not match' }); });
    expect(result).toBe('REJECTED');
    expect(calls).toEqual(['decision:false']);
  });

  it('expires when the donor never answers', async () => {
    const calls: string[] = [];
    const result = await run('pin-d', { ...stubPortInActivities, async expirePortIn(_i, r) { calls.push(`expire:${r}`); } }, async () => { await env.sleep('15 days'); }, { ...details, expiryDays: 14 });
    expect(result).toBe('EXPIRED');
    expect(calls[0]).toMatch(/no answer from OtherTel/);
  });

  it('asks for attention, without completing, when the network swap keeps failing', async () => {
    const calls: string[] = [];
    const result = await run('pin-e', { ...stubPortInActivities, async swapMsisdnOnNetwork() { throw new Error('HLR unreachable'); }, async completePortIn() { calls.push('complete'); }, async publishEvent(_t, _k, p) { calls.push((p as { type: string }).type); } },
      async (h) => { await h.signal(portDecisionSignal, { approved: true }); });
    expect(result).toBe('NEEDS_ATTENTION');
    expect(calls).toEqual(['PORT_IN_NEEDS_ATTENTION']);
  });
});
