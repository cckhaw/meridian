import { ApplicationFailure } from '@temporalio/activity';
export type BillRunStatus = 'MOCK_RUNNING' | 'MOCK_COMPLETED' | 'PENDING_APPROVAL' | 'APPROVED' | 'PRODUCTION_RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export interface BillRunState { id: string; status: BillRunStatus; mockTotalMinor: number; billedInvoices: number; counts: Record<string, number>; busy?: boolean }
export interface BillRunRequest { cycleDay?: number; daily?: boolean; accountIds?: string[]; asOf?: string; requestedBy: string; note?: string }

/**
 * What the governance workflow needs from the CRM. The CRM owns the state machine and enforces every rule (dual control, a fresh mock, exclusions still
 * holding at production); the workflow supplies the waiting, the deadlines and the signals from people. Every call is safe to repeat. Real implementations
 * call the back-office API:
 *   createRun    -> POST /billing/runs                 workRun   -> POST /billing/runs/:id/work   (up to ~20 s of work, then returns where it is)
 *   exclude      -> POST /billing/exclusions           include   -> POST /billing/runs/:id/include
 *   submit       -> POST /billing/runs/:id/submit      approve   -> POST /billing/runs/:id/approve  { execute: true }
 *   reject       -> POST /billing/runs/:id/reject      cancel    -> POST /billing/runs/:id/cancel
 *   retryFailed  -> POST /billing/runs/:id/retry
 */
export interface BillRunActivities {
  billRunCreate(req: BillRunRequest): Promise<BillRunState>;
  billRunWork(runId: string): Promise<BillRunState>;
  billRunGet(runId: string): Promise<BillRunState>;
  billRunExclude(runId: string, x: { accountId?: string; customerId?: string; reason: string; by: string }): Promise<void>;
  billRunInclude(runId: string, accountIds: string[], by: string): Promise<void>;
  billRunSubmit(runId: string, by: string, note?: string): Promise<BillRunState>;
  billRunApprove(runId: string, by: string, note?: string): Promise<BillRunState>;
  billRunReject(runId: string, by: string, note: string): Promise<BillRunState>;
  billRunCancel(runId: string, by: string, note?: string): Promise<BillRunState>;
  billRunRetryFailed(runId: string, by: string): Promise<BillRunState>;
  billRunPublish(topic: string, key: string, payload: unknown): Promise<void>;
}

/** An in-memory stand-in with the same rules, for the worker's default wiring and for tests. */
export function stubBillRunActivities(o: { mockPolls?: number; failAccounts?: number } = {}): BillRunActivities & { log: string[] } {
  const log: string[] = [];
  let status: BillRunStatus = 'MOCK_RUNNING', polls = 0, failed = o.failAccounts ?? 0, excluded = 0, requestedBy = '', submittedBy = '';
  const state = (): BillRunState => ({ id: 'run-1', status, mockTotalMinor: 100_000 - excluded * 1000, billedInvoices: status === 'COMPLETED' ? 10 - excluded - failed : 0, counts: { MOCKED: 10 - excluded, EXCLUDED: excluded, FAILED: status === 'COMPLETED' ? failed : 0 } });
  const rec = <T,>(k: string, v: T) => { log.push(k); return v; };
  return {
    log,
    async billRunCreate(req) { requestedBy = req.requestedBy; return rec('createRun', state()); },
    async billRunWork() {
      log.push('workRun');
      if (status === 'MOCK_RUNNING' && ++polls >= (o.mockPolls ?? 2)) status = 'MOCK_COMPLETED';
      else if (status === 'PRODUCTION_RUNNING') { status = 'COMPLETED'; }
      return state();
    },
    async billRunGet() { return state(); },
    async billRunExclude(_r, x) { excluded++; log.push(`exclude:${x.accountId ?? x.customerId}`); },
    async billRunInclude(_r, ids) { excluded = Math.max(0, excluded - ids.length); status = 'MOCK_RUNNING'; polls = 0; log.push(`include:${ids.length}`); },
    async billRunSubmit(_r, by) { submittedBy = by; status = 'PENDING_APPROVAL'; return rec('submit', state()); },
    async billRunApprove(_r, by) {
      if (by === requestedBy || by === submittedBy) throw ApplicationFailure.nonRetryable('This run needs a second person', 'RuleBroken');
      status = 'PRODUCTION_RUNNING'; return rec(`approve:${by}`, state());
    },
    async billRunReject() { status = 'MOCK_COMPLETED'; return rec('reject', state()); },
    async billRunCancel() { status = 'CANCELLED'; return rec('cancel', state()); },
    async billRunRetryFailed() { failed = 0; status = 'PRODUCTION_RUNNING'; return rec('retryFailed', state()); },
    async billRunPublish(topic, _k, p) { log.push(`event:${(p as { type: string }).type}`); void topic; },
  };
}
