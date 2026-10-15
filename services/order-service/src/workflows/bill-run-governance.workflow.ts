import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { BillRunActivities, BillRunRequest, BillRunState } from '../activities/bill-run.js';

const a = proxyActivities<BillRunActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5, backoffCoefficient: 2, nonRetryableErrorTypes: ['RuleBroken'] },
});

export const excludeSignal = defineSignal<[{ accountId?: string; customerId?: string; reason: string; by: string }]>('exclude');
export const includeSignal = defineSignal<[{ accountIds: string[]; by: string }]>('include');
export const submitSignal = defineSignal<[{ by: string; note?: string }]>('submit');
export const approveSignal = defineSignal<[{ by: string; note?: string }]>('approve');
export const rejectSignal = defineSignal<[{ by: string; note: string }]>('reject');
export const cancelSignal = defineSignal<[{ by: string; note?: string }]>('cancel');
export const retrySignal = defineSignal<[{ by: string }]>('retryFailed');
export type GovernanceStage = 'MOCKING' | 'REVIEW' | 'PENDING_APPROVAL' | 'PRODUCTION' | 'RETRY_WINDOW' | 'DONE';
export const governanceStatus = defineQuery<{ stage: GovernanceStage; runId: string | null; run: BillRunState | null; problems: string[] }>('governanceStatus');

export interface BillRunGovernanceInput {
  request: BillRunRequest;
  /** Whether the run needs a second person to approve (the CRM decides and enforces this too). */
  dualControl: boolean;
  /** How long a mock may sit under review, and a submitted run wait for approval, before the run is cancelled. */
  reviewHours?: number;
  approvalHours?: number;
  /** After production, how long the workflow stays for a retry of failed accounts. */
  retryWindowHours?: number;
}
export type GovernanceOutcome = { outcome: 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED'; runId: string | null; billed: number; failed: number };
const HOUR = 3_600_000;
/** The CRM's own message, from inside the failure Temporal wraps it in. */
const why = (e: unknown): string => { const c = (e as { cause?: { message?: string } }).cause; return c?.message ?? (e as Error).message; };

/**
 * The four stages of a bill run as one durable workflow: MOCK, REVIEW (with exclusions and inclusions arriving as signals), APPROVAL, PRODUCTION.
 * The CRM holds the data and the rules; this holds the clock and the people. A mock left unreviewed, or a submitted run left unapproved, times out
 * and is cancelled, so nothing sits half-done for weeks; production is never started without an approval signal; and the approver's own rules
 * (a second person under dual control) are the CRM's, so a refused approval is recorded and the workflow keeps waiting for a valid one.
 */
export async function billRunGovernanceWorkflow(input: BillRunGovernanceInput): Promise<GovernanceOutcome> {
  const reviewMs = (input.reviewHours ?? 72) * HOUR, approvalMs = (input.approvalHours ?? 72) * HOUR, retryMs = (input.retryWindowHours ?? 24) * HOUR;
  let stage: GovernanceStage = 'MOCKING';
  let run: BillRunState | null = null;
  const problems: string[] = [];
  const queue: Array<() => Promise<void>> = [];
  // Signals arrive while the workflow is waiting; a holder object keeps the compiler from assuming they never change.
  const sig: { submitted: { by: string; note?: string } | null; approved: { by: string; note?: string } | null; rejected: { by: string; note: string } | null; cancelled: { by: string; note?: string } | null; retry: boolean } = { submitted: null, approved: null, rejected: null, cancelled: null, retry: false };

  setHandler(excludeSignal, (x) => { queue.push(async () => { if (run) await a.billRunExclude(run.id, x); }); });
  setHandler(includeSignal, (x) => { queue.push(async () => { if (run) await a.billRunInclude(run.id, x.accountIds, x.by); }); });
  setHandler(submitSignal, (x) => { sig.submitted = x; });
  setHandler(approveSignal, (x) => { sig.approved = x; });
  setHandler(rejectSignal, (x) => { sig.rejected = x; });
  setHandler(cancelSignal, (x) => { sig.cancelled = x; });
  setHandler(retrySignal, () => { sig.retry = true; });
  setHandler(governanceStatus, () => ({ stage, runId: run?.id ?? null, run, problems: [...problems] }));

  const done = (outcome: GovernanceOutcome['outcome']): GovernanceOutcome => { stage = 'DONE'; return { outcome, runId: run?.id ?? null, billed: run?.billedInvoices ?? 0, failed: run?.counts.FAILED ?? 0 }; };
  const doCancel = async (): Promise<GovernanceOutcome> => { const c = sig.cancelled ?? { by: 'workflow', note: 'timed out' }; if (run) run = await a.billRunCancel(run.id, c.by, c.note); return done('CANCELLED'); };
  /** Drives the CRM's own slices until the run settles in one of `until`. */
  const drive = async (until: string[]) => {
    for (let guard = 0; guard < 100_000 && run && !until.includes(run.status); guard++) {
      if (sig.cancelled) return;
      run = await a.billRunWork(run.id);
      if (run.busy) await sleep(2000);
      if (run.status === 'FAILED') return;
    }
  };

  run = await a.billRunCreate(input.request);
  await drive(['MOCK_COMPLETED']);
  if (run.status === 'FAILED') return done('FAILED');

  // REVIEW: exclusions and inclusions are applied as they arrive; each one sends the run back for a quick re-price, then it is ready again.
  for (;;) {
    stage = 'REVIEW';
    if (sig.cancelled) return doCancel();
    const arrived = await condition(() => queue.length > 0 || !!sig.submitted || !!sig.approved || !!sig.cancelled, reviewMs);
    if (!arrived) { await a.billRunPublish('meridian.billing.events', run.id, { type: 'REVIEW_EXPIRED' }); sig.cancelled = { by: 'workflow', note: 'No review within the allowed time' }; return doCancel(); }
    if (sig.cancelled) return doCancel();
    while (queue.length) {
      const job = queue.shift()!;
      try { await job(); } catch (e) { problems.push(why(e)); }
    }
    if (run.status !== 'MOCK_COMPLETED') { stage = 'MOCKING'; await drive(['MOCK_COMPLETED']); }
    if (run.status === 'FAILED') return done('FAILED');
    run = await a.billRunGet(run.id);
    if (!sig.submitted && !sig.approved) continue;

    if (input.dualControl && !sig.approved) {
      // PENDING APPROVAL: a second person decides.
      if (!sig.submitted) continue;
      stage = 'PENDING_APPROVAL';
      run = await a.billRunSubmit(run.id, sig.submitted.by, sig.submitted.note);
      await a.billRunPublish('meridian.billing.events', run.id, { type: 'APPROVAL_REQUESTED', by: sig.submitted.by });
      for (;;) {
        const answered = await condition(() => !!sig.approved || !!sig.rejected || !!sig.cancelled, approvalMs);
        if (!answered) { sig.cancelled = { by: 'workflow', note: 'No approval within the allowed time' }; await a.billRunPublish('meridian.billing.events', run.id, { type: 'APPROVAL_EXPIRED' }); return doCancel(); }
        if (sig.cancelled) return doCancel();
        if (sig.rejected) { const r = sig.rejected; sig.rejected = null; sig.submitted = null; run = await a.billRunReject(run.id, r.by, r.note); break; }
        try { run = await a.billRunApprove(run.id, sig.approved!.by, sig.approved!.note); break; }
        catch (e) { problems.push(`${sig.approved!.by}: ${why(e)}`); sig.approved = null; } // refused by the CRM (same person, stale mock): keep waiting for a valid approval
      }
      if (run.status === 'PRODUCTION_RUNNING') break;
      continue; // sent back to review
    }
    if (sig.approved) {
      try { run = await a.billRunApprove(run.id, sig.approved.by, sig.approved.note); break; }
      catch (e) { problems.push(`${sig.approved.by}: ${why(e)}`); sig.approved = null; sig.submitted = null; }
    } else sig.submitted = null; // single-admin: submitting is optional; an approval is what releases it
  }

  // PRODUCTION: the CRM issues the invoices in its own slices.
  stage = 'PRODUCTION';
  await drive(['COMPLETED']);
  if (run.status === 'FAILED') return done('FAILED');
  await a.billRunPublish('meridian.billing.events', run.id, { type: 'COMPLETED', billed: run.billedInvoices, failed: run.counts.FAILED ?? 0 });

  // Failed accounts can be retried on their own for a while, without a sweep of the cycle.
  if ((run.counts.FAILED ?? 0) > 0) {
    stage = 'RETRY_WINDOW';
    while ((run.counts.FAILED ?? 0) > 0) {
      sig.retry = false;
      if (!(await condition(() => sig.retry || !!sig.cancelled, retryMs)) || sig.cancelled) break;
      run = await a.billRunRetryFailed(run.id, 'workflow');
      await drive(['COMPLETED']);
    }
  }
  return done('COMPLETED');
}

