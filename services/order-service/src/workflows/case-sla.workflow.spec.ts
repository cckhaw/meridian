import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaseSlaActivities, CaseSlaTick } from '../activities/case-sla.js';
import { caseChangedSignal, caseSlaStatus, caseSlaWorkflow, dispatchUpdatedSignal } from './case-sla.workflow.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const HOUR = 3_600_000;

/**
 * A small model of the CRM's watchdog: a case that opens at the workflow's start, warns at 80% of `resolveH`, breaches at 100%, escalates at 150%, and, when
 * `resolveAtH` is set, is resolved then and closes itself `closeH` hours later. Each step fires once.
 */
function crm(o: { resolveH: number; resolveAtH?: number; closeH?: number }) {
  let start: number | null = null; const fired = new Set<string>(); const ticks: string[] = []; let closedAt: number | null = null; const due = { resolveH: o.resolveH };
  const acts: CaseSlaActivities = {
    async caseSlaTick(_id, nowIso): Promise<CaseSlaTick> {
      const now = Date.parse(nowIso); start ??= now;
      const h = (now - start) / HOUR; const out: string[] = [];
      const step = (k: string, atH: number) => { if (h >= atH && !fired.has(k)) { fired.add(k); out.push(k); } };
      const resolved = o.resolveAtH !== undefined && h >= o.resolveAtH;
      if (!resolved) { step('SLA_WARNING', due.resolveH * 0.8); step('SLA_BREACH', due.resolveH); step('SLA_ESCALATION', due.resolveH * 1.5); }
      if (resolved && h >= o.resolveAtH! + (o.closeH ?? 72)) { closedAt = now; out.push('AUTO_CLOSE'); }
      ticks.push(`${h.toFixed(1)}:${out.join('+')}`);
      if (closedAt !== null) return { fired: out, nextAt: null, closed: true };
      const next: number[] = resolved ? [o.resolveAtH! + (o.closeH ?? 72)] : [['SLA_WARNING', 0.8], ['SLA_BREACH', 1], ['SLA_ESCALATION', 1.5]].filter(([k]) => !fired.has(k as string)).map(([, f]) => due.resolveH * (f as number));
      if (resolved === false && o.resolveAtH !== undefined) next.push(o.resolveAtH);
      return { fired: out, nextAt: next.length ? new Date(start + Math.min(...next) * HOUR).toISOString() : null, closed: false };
    },
    async casePublish() { /* events are not what is under test */ },
  };
  return { acts, ticks, fired, setDue: (h: number) => { due.resolveH = h; } };
}

async function run(acts: CaseSlaActivities, body: (h: import('@temporalio/client').WorkflowHandle<typeof caseSlaWorkflow>) => Promise<void> = async () => {}) {
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'case-sla-test', workflowsPath: new URL('./index.ts', import.meta.url).pathname, activities: acts as never });
  return worker.runUntil(async () => {
    const h = await env.client.workflow.start(caseSlaWorkflow, { taskQueue: 'case-sla-test', workflowId: `c-${Math.random()}`, args: [{ caseId: 'case-1' }] });
    await body(h);
    return { result: await h.result(), h };
  });
}

describe('caseSlaWorkflow', () => {
  it('sleeps to each deadline in turn, fires it once, and ends when the case closes itself', async () => {
    const m = crm({ resolveH: 10, resolveAtH: 20, closeH: 72 });
    const { result } = await run(m.acts);
    expect(result).toBe('CLOSED');
    expect([...m.fired]).toEqual(['SLA_WARNING', 'SLA_BREACH', 'SLA_ESCALATION']);
    // warning at 8h, breach at 10h, escalation at 15h, resolved at 20h, closed at 92h: one tick per deadline and no busy polling
    expect(m.ticks).toEqual(['0.0:', '8.0:SLA_WARNING', '10.0:SLA_BREACH', '15.0:SLA_ESCALATION', '20.0:', '92.0:AUTO_CLOSE']);
  });

  it('wakes at once when the CRM says the case changed, and follows the new deadline', async () => {
    const m = crm({ resolveH: 100, resolveAtH: 8, closeH: 1 });   // nothing is due for 80 hours, until the deadline is brought forward
    const { result } = await run(m.acts, async (handle) => {
      await env.sleep(HOUR);                           // an hour in: the case is made more severe and its deadline moves to 4 hours
      m.setDue(4);
      await handle.signal(caseChangedSignal);
    });
    expect(result).toBe('CLOSED');
    expect([...m.fired]).toEqual(['SLA_WARNING', 'SLA_BREACH', 'SLA_ESCALATION']);
    // the warning came at 3.2 hours (the new deadline), not at 80
    expect(m.ticks.find((t) => t.includes('SLA_WARNING'))!.startsWith('3.2')).toBe(true);
  }, 60_000);
});

describe('caseSlaWorkflow: waiting for the field-service system', () => {
  /** A case waiting on a technician: nothing is due for a week, until the field-service system calls back and the case is resolved. */
  function visit() {
    let start: number | null = null, resolved = false; const ticks: string[] = [];
    const acts: CaseSlaActivities = {
      async caseSlaTick(_id, nowIso): Promise<CaseSlaTick> {
        const now = Date.parse(nowIso); start ??= now; ticks.push(`${((now - start) / HOUR).toFixed(1)}:${resolved ? 'resolved' : 'waiting'}`);
        if (resolved) return { fired: ['AUTO_CLOSE'], nextAt: null, closed: true, waiting: null };
        return { fired: [], nextAt: new Date(start + 168 * HOUR).toISOString(), closed: false, waiting: 'DISPATCH' };
      },
      async casePublish() { /* not under test */ },
    };
    return { acts, ticks, resolve: () => { resolved = true; } };
  }
  it('sits on a durable timer while waiting, wakes the moment the callback signal arrives, and says what it is waiting on', async () => {
    const m = visit();
    let waitingSeen: unknown;
    const { result } = await run(m.acts, async (h) => {
      await env.sleep(2 * HOUR);
      waitingSeen = (await h.query(caseSlaStatus)).waiting;
      m.resolve();
      await h.signal(dispatchUpdatedSignal, { event: 'JOB_COMPLETED' });
    });
    expect(result).toBe('CLOSED');
    expect(waitingSeen).toBe('DISPATCH');
    expect(m.ticks).toEqual(['0.0:waiting', '2.0:resolved']);   // one tick to start, one on the callback: no polling in between, and not a week later
  }, 60_000);
});
