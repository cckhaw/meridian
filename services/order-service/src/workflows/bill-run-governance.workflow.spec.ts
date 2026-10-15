import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubBillRunActivities } from '../activities/bill-run.js';
import { approveSignal, billRunGovernanceWorkflow, cancelSignal, excludeSignal, governanceStatus, includeSignal, rejectSignal, retrySignal, submitSignal } from './bill-run-governance.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

type H = WorkflowHandle<typeof billRunGovernanceWorkflow>;
const request = { cycleDay: 15, asOf: '2031-06-15', requestedBy: 'ops' };

async function run(opts: { dualControl: boolean; stub?: Parameters<typeof stubBillRunActivities>[0]; reviewHours?: number; approvalHours?: number }, body: (h: H, wait: (stage: string) => Promise<void>) => Promise<void>) {
  const acts = stubBillRunActivities(opts.stub);
  const queue = `bill-run-${Math.random()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: queue, workflowsPath: new URL('./index.ts', import.meta.url).pathname, activities: acts as never });
  return worker.runUntil(async () => {
    const h = await env.client.workflow.start(billRunGovernanceWorkflow, { taskQueue: queue, workflowId: `br-${Math.random()}`, args: [{ request, dualControl: opts.dualControl, reviewHours: opts.reviewHours, approvalHours: opts.approvalHours }] });
    const waitStage = async (stage: string) => { for (let i = 0; i < 200; i++) { if ((await h.query(governanceStatus)).stage === stage) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`never reached ${stage}`); };
    await body(h, waitStage);
    return { result: await h.result(), log: acts.log, status: await h.query(governanceStatus) };
  });
}

describe('billRunGovernanceWorkflow', () => {
  it('mocks, waits for review, and bills only after an approval signal (single admin)', async () => {
    const { result, log } = await run({ dualControl: false }, async (h, at) => {
      await at('REVIEW');
      await h.signal(approveSignal, { by: 'fin', note: 'ok' });
    });
    expect(result).toMatchObject({ outcome: 'COMPLETED', billed: 10 });
    expect(log.indexOf('createRun')).toBeLessThan(log.indexOf('approve:fin'));
    expect(log.filter((l) => l === 'workRun').length).toBeGreaterThanOrEqual(3); // mock slices, then production
    expect(log).toContain('event:COMPLETED');
  });

  it('applies exclusions that arrive during review, re-prices, and bills the remainder', async () => {
    const { result, log, status } = await run({ dualControl: false }, async (h, at) => {
      await at('REVIEW');
      await h.signal(excludeSignal, { accountId: 'acct-1', reason: 'Legal dispute', by: 'ops' });
      await h.signal(excludeSignal, { customerId: 'ent-1', reason: 'Fraud case', by: 'ops' });
      await h.signal(includeSignal, { accountIds: ['acct-1'], by: 'ops' });
      await new Promise((r) => setTimeout(r, 150));
      await h.signal(approveSignal, { by: 'fin' });
    });
    expect(log.filter((l) => l.startsWith('exclude:'))).toEqual(['exclude:acct-1', 'exclude:ent-1']);
    expect(log).toContain('include:1');
    expect(result.outcome).toBe('COMPLETED');
    expect(status.stage).toBe('DONE');
  });

  it('with dual control: submit, a second person approves; the requester cannot approve their own run and the workflow keeps waiting', async () => {
    const { result, log, status } = await run({ dualControl: true }, async (h, at) => {
      await at('REVIEW');
      await h.signal(submitSignal, { by: 'ops', note: 'ready' });
      await at('PENDING_APPROVAL');
      await h.signal(approveSignal, { by: 'ops' }); // the requester: refused by the CRM
      await new Promise((r) => setTimeout(r, 200));
      expect((await h.query(governanceStatus)).problems.join()).toMatch(/second person/);
      expect((await h.query(governanceStatus)).stage).toBe('PENDING_APPROVAL');
      await h.signal(approveSignal, { by: 'fin' });
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(log).toContain('approve:fin');
    expect(status.problems).toHaveLength(1);
  });

  it('a rejection sends the run back to review, and it can be resubmitted', async () => {
    const { result, log } = await run({ dualControl: true }, async (h, at) => {
      await at('REVIEW');
      await h.signal(submitSignal, { by: 'ops' });
      await at('PENDING_APPROVAL');
      await h.signal(rejectSignal, { by: 'fin', note: 'Look at the spike' });
      await at('REVIEW');
      await h.signal(submitSignal, { by: 'ops' });
      await at('PENDING_APPROVAL');
      await h.signal(approveSignal, { by: 'fin' });
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(log.filter((l) => l === 'submit')).toHaveLength(2);
    expect(log).toContain('reject');
  });

  it('cancels the run when nobody reviews it in time, and when nobody approves it in time', async () => {
    const a = await run({ dualControl: false, reviewHours: 24 }, async () => {});
    expect(a.result).toMatchObject({ outcome: 'CANCELLED' });
    expect(a.log).toContain('cancel');
    expect(a.log).toContain('event:REVIEW_EXPIRED');
    const b = await run({ dualControl: true, approvalHours: 12 }, async (h, at) => { await at('REVIEW'); await h.signal(submitSignal, { by: 'ops' }); });
    expect(b.result.outcome).toBe('CANCELLED');
    expect(b.log).toContain('event:APPROVAL_EXPIRED');
  });

  it('a person can cancel during review', async () => {
    const { result } = await run({ dualControl: false }, async (h, at) => { await at('REVIEW'); await h.signal(cancelSignal, { by: 'ops', note: 'wrong date' }); });
    expect(result.outcome).toBe('CANCELLED');
  });

  it('after production it stays for a retry of failed accounts, and finishes when none are left', async () => {
    const { result, log } = await run({ dualControl: false, stub: { failAccounts: 2 } }, async (h, at) => {
      await at('REVIEW');
      await h.signal(approveSignal, { by: 'fin' });
      await at('RETRY_WINDOW');
      await h.signal(retrySignal, { by: 'ops' });
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(log).toContain('retryFailed');
  });
});
