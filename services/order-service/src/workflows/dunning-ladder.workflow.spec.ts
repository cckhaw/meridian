import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DunningLadderActivities, LadderStepView } from '../activities/dunning-ladder.js';
import { dunningLadderWorkflow, ladderStatus, partialPaymentSignal, paymentReceivedSignal } from './dunning-ladder.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysSince = (start: number, asOf: string) => Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${iso(start)}T00:00:00Z`)) / DAY);

/** A small in-memory CRM: a ladder of steps at D+n from the day the workflow starts, applied when the workflow asks. */
function crm(spec: Array<[string, string, number]>, o: { onRun?: (asOf: string, state: Map<string, string>) => void | Promise<void>; overdue?: () => boolean; pausedUntil?: () => string | null } = {}) {
  let start = 0;   // the day the workflow first looks (the test server's clock jumps ahead between tests)
  const state = new Map<string, string>(spec.map(([id]) => [id, 'LATER']));
  const calls: string[] = [];
  const view = (asOf: string): LadderStepView[] => spec.map(([id, action, d]) => ({ id, name: id, action, state: (state.get(id) === 'APPLIED' ? 'DONE' : daysSince(start, asOf) >= d ? 'DUE' : 'LATER') as LadderStepView['state'], dueOn: iso(start + d * DAY) }));
  const acts: DunningLadderActivities & { confirmRestored(id: string): Promise<void>; publishEvent(t: string, k: string, p: unknown): Promise<void> } = {
    async getLadder(_id, asOf) { calls.push('getLadder'); if (!start) start = Date.parse(`${asOf}T00:00:00Z`); return { ruleCode: 'r', overdue: o.overdue ? o.overdue() : true, daysPastDue: daysSince(start, asOf), pausedUntil: o.pausedUntil?.() ?? null, steps: view(asOf) }; },
    async runLadder(_id, asOf) {
      calls.push('runLadder');
      const due = spec.filter(([id, , d]) => state.get(id) !== 'APPLIED' && daysSince(start, asOf) >= d);
      for (const [id] of due) state.set(id, 'APPLIED');
      await o.onRun?.(asOf, state);
      return { applied: due.map(([id, action]) => ({ stepId: id, name: id, action, status: 'APPLIED' as const })) };
    },
    async confirmRestored() { calls.push('confirmRestored'); },
    async publishEvent() {},
  };
  return { acts, calls, state };
}

async function run(acts: unknown, body: (h: import('@temporalio/client').WorkflowHandle<typeof dunningLadderWorkflow>) => Promise<void> = async () => {}) {
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'ladder-test', workflowsPath: new URL('./index.ts', import.meta.url).pathname, activities: acts as never });
  return worker.runUntil(async () => {
    const h = await env.client.workflow.start(dunningLadderWorkflow, { taskQueue: 'ladder-test', workflowId: `l-${Math.random()}`, args: [{ accountId: 'acct-1' }] });
    await body(h);
    return h.result();
  });
}

describe('dunningLadderWorkflow', () => {
  it('sleeps to each step’s day, has the CRM apply it, and ends in termination', async () => {
    const c = crm([['remind', 'NOTIFY', 1], ['soft', 'SOFT_BAR', 14], ['hard', 'HARD_BAR', 21], ['end', 'TERMINATE', 45]]);
    expect(await run(c.acts)).toBe('TERMINATED');
    expect([...c.state.values()]).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
    expect(c.calls.filter((x) => x === 'runLadder')).toHaveLength(4);
  });

  it('a payment signal stops the ladder and confirms the restoration', async () => {
    let handle!: import('@temporalio/client').WorkflowHandle<typeof dunningLadderWorkflow>;
    const c = crm([['remind', 'NOTIFY', 1], ['soft', 'SOFT_BAR', 14], ['end', 'TERMINATE', 45]], {
      onRun: async (_asOf, state) => { if (state.get('remind') === 'APPLIED') await handle.signal(paymentReceivedSignal, { invoiceId: 'inv-1' }); },
    });
    expect(await run(c.acts, async (h) => { handle = h; })).toBe('PAID');
    expect(c.state.get('end')).toBe('LATER');
    expect(c.calls).toContain('confirmRestored');
  });

  it('ends as paid when the CRM says nothing is overdue (paid at a store)', async () => {
    let n = 0;
    const c = crm([['remind', 'NOTIFY', 1], ['soft', 'SOFT_BAR', 14], ['end', 'TERMINATE', 45]], { overdue: () => ++n < 3 });
    const out = await run(c.acts);
    expect(out).toBe('PAID');
    expect(c.state.get('end')).toBe('LATER');
  });

  it('a partial payment makes it read the ladder again, and it follows a pause', async () => {
    let handle!: import('@temporalio/client').WorkflowHandle<typeof dunningLadderWorkflow>;
    let pause: string | null = null;
    const c = crm([['soft', 'SOFT_BAR', 2], ['hard', 'HARD_BAR', 3]], { pausedUntil: () => pause });
    const outcome = await run(c.acts, async (h) => {
      handle = h;
      pause = iso(await env.currentTimeMs() + 5 * DAY);
      await handle.signal(partialPaymentSignal, { amountMinor: 900, pausedUntil: pause });
      const s = await handle.query(ladderStatus);
      expect(s.paid).toBe(false);
    });
    expect(outcome).toBe('COMPLETED');
    expect(c.calls.filter((x) => x === 'getLadder').length).toBeGreaterThan(1);
  });

  it('completes when no step is left', async () => {
    const c = crm([['only', 'NOTIFY', 1]]);
    expect(await run(c.acts)).toBe('COMPLETED');
  });
});
