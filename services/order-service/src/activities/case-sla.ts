/** What a tick of the SLA watchdog reports: what it fired, when the next thing is due, and whether the case has reached its end. */
export interface CaseSlaTick { fired: string[]; nextAt: string | null; closed: boolean }

/**
 * What the case SLA workflow needs from the CRM. The CRM decides what is due (warning, breach, escalation, automatic closing) and does it once; the workflow
 * supplies the durable wait until the next deadline. A tick is idempotent, so Temporal can retry it freely. Real implementations call:
 *   caseSlaTick -> POST /cases/:id/sla-tick  { now }     (applies everything due at `now`, answers what comes next)
 * `now` is the workflow's own clock, so the same case replays to the same answers.
 */
export interface CaseSlaActivities {
  caseSlaTick(caseId: string, nowIso: string): Promise<CaseSlaTick>;
  casePublish(topic: string, key: string, payload: unknown): Promise<void>;
}

export const stubCaseSlaActivities: CaseSlaActivities = {
  async caseSlaTick(caseId, nowIso) { console.log(`[case-sla ${caseId}] tick at ${nowIso}`); return { fired: [], nextAt: null, closed: true }; },
  async casePublish(topic, key) { console.log(`[kafka] ${topic} ${key}`); },
};
