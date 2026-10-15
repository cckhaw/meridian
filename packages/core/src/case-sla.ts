import { ACTIVE_SQL, ACTIVE_STATUSES, caseLog, getCase, notifySupervisors, transitionCase, type CaseStatus } from './cases.js';
import { getCaseSettings, PRIORITY_OF, type CaseSettings } from './case-taxonomy.js';
import type { Queryable, Row } from './db.js';
import { notFound } from './errors.js';
import { maybeAutoDispatch, releaseExpiredHolds } from './workforce.js';

/**
 * The SLA watchdog. For one case it works out what is due (a first-response breach, the warning point, the breach, a second escalation, an automatic closing)
 * and does each once. Every step is idempotent and marks the case when done, so the Temporal workflow (one durable timer per case), the batch sweep (a scheduler
 * calling one endpoint) and a retry after a failure can all run it without doubling a notice.
 *
 *   warning   when the resolution clock passes the warning percentage: supervisors are told
 *   breach    when it passes the due time: supervisors are told, the case is escalated one level and re-prioritised (at least High)
 *   escalate  when it is half as late again: second level, Urgent
 *   closing   a resolved case closes itself at its closing time; a case waiting on a customer who never answers closes after the response window
 */
const MIN = 60_000;
const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
const LEVEL_PRIORITY = ['', 'HIGH', 'URGENT'];

export interface CaseTimers {
  /** The earliest moment something becomes due, or null when nothing ever will. */
  nextAt: string | null;
  /** What is due, in time order. */
  upcoming: Array<{ kind: 'FIRST_RESPONSE_BREACH' | 'SLA_WARNING' | 'SLA_BREACH' | 'SLA_ESCALATION' | 'AUTO_CLOSE' | 'CUSTOMER_WAIT_CLOSE' | 'DISPATCH_OVERDUE'; at: string }>;
  /** What the case is mainly waiting on, for a screen or a workflow to say. */
  waiting: 'DISPATCH' | 'CUSTOMER' | 'RESOLUTION' | null;
  closed: boolean;
}

/** When each thing becomes due for this case row. Pure. */
export function caseTimers(c: Row, s: Pick<CaseSettings, 'customerResponseHours'>): CaseTimers {
  if (!ACTIVE_STATUSES.includes(c.status) && c.status !== 'RESOLVED') return { nextAt: null, upcoming: [], closed: true, waiting: null };
  const out: CaseTimers['upcoming'] = [];
  const add = (kind: CaseTimers['upcoming'][number]['kind'], t: number | null) => { if (t !== null && Number.isFinite(t)) out.push({ kind, at: new Date(t).toISOString() }); };
  if (c.status === 'RESOLVED') { add('AUTO_CLOSE', ms(c.autoCloseAt)); }
  else {
    const due = ms(c.resolutionDue), total = (c.slaResolutionMinutes ?? 0) * MIN, paused = ms(c.slaPausedAt);
    if (paused !== null) add('CUSTOMER_WAIT_CLOSE', paused + s.customerResponseHours * 3_600_000);
    else if (due !== null && total > 0) {
      if (!c.firstResponseAt && !c.firstResponseBreachedAt) add('FIRST_RESPONSE_BREACH', ms(c.firstResponseDue));
      if (!c.slaWarnedAt) add('SLA_WARNING', due - ((100 - (c.slaWarnPercent ?? 80)) / 100) * total);
      if (!c.slaBreachedAt) add('SLA_BREACH', due);
      if ((c.escalationLevel ?? 0) < 2) add('SLA_ESCALATION', due + 0.5 * total);
    }
  }
  if ((c.status === 'PENDING_DISPATCH' || c.status === 'DISPATCHED') && c.dispatchDueAt && !c.dispatchNotifiedAt) add('DISPATCH_OVERDUE', ms(c.dispatchDueAt));
  out.sort((a, b) => a.at.localeCompare(b.at));
  return { nextAt: out[0]?.at ?? null, upcoming: out, closed: false, waiting: c.status === 'PENDING_DISPATCH' || c.status === 'DISPATCHED' ? 'DISPATCH' : c.status === 'PENDING_CUSTOMER' ? 'CUSTOMER' : c.status === 'RESOLVED' ? null : 'RESOLUTION' };
}

const supervisorsMessage = (c: Row, what: string) => `${what}: case ${c.number} (${String(c.severity).replace(/_/g, ' ').toLowerCase()}, ${String(c.tier).toLowerCase()})${c.assignee ? `, assigned to ${c.assignee}` : ', unassigned'}.`;

/**
 * Does everything that is due on a case at `now`, once. Returns what it did (empty when nothing was due) and the case's timers afterwards, so a caller
 * can sleep until the next one.
 */
export async function fireDueCaseTimers(q: Queryable, caseId: string, now: Date = new Date()): Promise<{ fired: string[]; timers: CaseTimers }> {
  const settings = await getCaseSettings(q);
  const fired: string[] = [];
  for (let guard = 0; guard < 6; guard++) {           // a closing can unlock nothing more, but a long-overdue case fires several steps in order
    const c = (await q.query('SELECT * FROM cases WHERE id=$1', [caseId])).rows[0];
    if (!c) throw notFound('case', caseId);
    const t = caseTimers(c, settings);
    const due = t.upcoming.find((u) => new Date(u.at).getTime() <= now.getTime());
    if (!due) return { fired, timers: t };
    const mark = async (sql: string, args: unknown[] = []) => (await q.query(`UPDATE cases SET ${sql}, updated_at = now() WHERE id=$1 AND status = $${args.length + 2}`, [caseId, ...args, c.status])).rowCount;
    if (due.kind === 'FIRST_RESPONSE_BREACH') {
      if (await mark('first_response_breached_at = now()')) { await caseLog(q, caseId, 'system', 'SLA_FIRST_RESPONSE_BREACH', { detail: { due: c.firstResponseDue } }); await notifySupervisors(q, c, 'CASE_FIRST_RESPONSE_BREACH', supervisorsMessage(c, 'No first response yet, and it is overdue')); fired.push(due.kind); }
    } else if (due.kind === 'SLA_WARNING') {
      if (await mark('sla_warned_at = now()')) { await caseLog(q, caseId, 'system', 'SLA_WARNING', { detail: { dueAt: c.resolutionDue, warnPercent: c.slaWarnPercent } }); await notifySupervisors(q, c, 'CASE_SLA_WARNING', supervisorsMessage(c, `${c.slaWarnPercent}% of the resolution time has passed`)); fired.push(due.kind); }
    } else if (due.kind === 'SLA_BREACH' || due.kind === 'SLA_ESCALATION') {
      const level = due.kind === 'SLA_BREACH' ? Math.max(1, c.escalationLevel) : 2;
      const set = due.kind === 'SLA_BREACH' ? `sla_breached_at = now(), escalation_level = $2, priority = $3` : `escalation_level = $2, priority = $3`;
      if (await mark(set, [level, LEVEL_PRIORITY[level]!])) {
        await caseLog(q, caseId, 'system', due.kind, { detail: { level, priority: LEVEL_PRIORITY[level] } });
        await notifySupervisors(q, c, due.kind === 'SLA_BREACH' ? 'CASE_SLA_BREACH' : 'CASE_SLA_ESCALATED', supervisorsMessage(c, due.kind === 'SLA_BREACH' ? 'The SLA has been breached' : 'Still unresolved, escalated again'), { level });
        fired.push(due.kind);
        if (due.kind === 'SLA_BREACH') await maybeAutoDispatch(q, c);
      }
    } else if (due.kind === 'DISPATCH_OVERDUE') {
      if (await mark('dispatch_notified_at = now()')) {
        const unconfirmed = c.status === 'PENDING_DISPATCH';
        await caseLog(q, caseId, 'system', 'DISPATCH_OVERDUE', { detail: { dueAt: c.dispatchDueAt, unconfirmed } });
        await notifySupervisors(q, c, 'CASE_DISPATCH_OVERDUE', supervisorsMessage(c, unconfirmed ? 'Waiting for a technician to be confirmed, and it is taking too long' : 'The technician has not reported the visit done'));
        fired.push(due.kind);
      }
    } else if (due.kind === 'AUTO_CLOSE') {
      await transitionCase(q, caseId, 'CLOSED_AUTO', { system: true, note: 'Closed automatically: no reply from the customer after the case was resolved.' });
      fired.push(due.kind);
    } else if (due.kind === 'CUSTOMER_WAIT_CLOSE') {
      await transitionCase(q, caseId, 'CLOSED_AUTO', { system: true, note: `Closed automatically: no reply from the customer in ${settings.customerResponseHours} hours.` });
      fired.push(due.kind);
    }
    if (!fired.length || (fired[fired.length - 1] !== due.kind)) return { fired, timers: caseTimers((await q.query('SELECT * FROM cases WHERE id=$1', [caseId])).rows[0]!, settings) };   // lost a race: someone changed the case; the caller will look again
  }
  return { fired, timers: caseTimers((await q.query('SELECT * FROM cases WHERE id=$1', [caseId])).rows[0]!, settings) };
}

/** Cases with something due right now, oldest deadline first. One indexed scan: this is what a scheduler runs every minute or so. */
export async function sweepCaseSla(q: Queryable, now: Date = new Date(), limit = 500): Promise<{ checked: number; fired: Record<string, number>; errors: Array<{ caseId: string; error: string }>; holdsReleased: number }> {
  const s = await getCaseSettings(q);
  const rows = (await q.query(
    `SELECT id FROM cases WHERE
       (status IN ${ACTIVE_SQL} AND sla_paused_at IS NULL AND sla_resolution_minutes IS NOT NULL AND (
          (sla_breached_at IS NULL AND resolution_due <= $1)
          OR (sla_warned_at IS NULL AND resolution_due - make_interval(secs => (100 - sla_warn_percent) * sla_resolution_minutes * 0.6) <= $1)
          OR (escalation_level < 2 AND resolution_due + make_interval(secs => sla_resolution_minutes * 30) <= $1)
          OR (first_response_at IS NULL AND first_response_breached_at IS NULL AND first_response_due <= $1)))
       OR (status IN ('PENDING_DISPATCH','DISPATCHED') AND dispatch_due_at <= $1 AND dispatch_notified_at IS NULL)
       OR (status = 'RESOLVED' AND auto_close_at <= $1)
       OR (status = 'PENDING_CUSTOMER' AND sla_paused_at + make_interval(hours => $2) <= $1)
     ORDER BY resolution_due LIMIT $3`, [now.toISOString(), s.customerResponseHours, limit])).rows;
  const fired: Record<string, number> = {}; const errors: Array<{ caseId: string; error: string }> = [];
  for (const r of rows) {
    try { for (const f of (await fireDueCaseTimers(q, r.id, now)).fired) fired[f] = (fired[f] ?? 0) + 1; }
    catch (e) { errors.push({ caseId: r.id, error: (e as Error).message }); }
  }
  const holdsReleased = await releaseExpiredHolds(q, undefined, undefined, now).catch(() => 0);
  return { checked: rows.length, fired, errors, holdsReleased };
}

/** Cases that have breached their SLA or are close to it, for a supervisor's board. */
export async function slaBoard(q: Queryable): Promise<{ breached: Row[]; warning: Row[]; counts: Record<string, number> }> {
  const rows = (await q.query(
    `SELECT k.id, k.number, k.subject, k.severity, k.tier, k.assignee, k.status, k.escalation_level, k.resolution_due, k.sla_warned_at, k.sla_breached_at, k.is_master
       FROM cases k WHERE k.status IN ${ACTIVE_SQL} AND (k.sla_breached_at IS NOT NULL OR k.sla_warned_at IS NOT NULL) ORDER BY k.resolution_due LIMIT 200`)).rows;
  const breached = rows.filter((r) => r.slaBreachedAt), warning = rows.filter((r) => !r.slaBreachedAt);
  const counts = Object.fromEntries((await q.query(`SELECT severity, count(*) AS n FROM cases WHERE status IN ${ACTIVE_SQL} AND sla_breached_at IS NOT NULL GROUP BY severity`)).rows.map((r) => [r.severity, Number(r.n)]));
  return { breached, warning, counts };
}
export { PRIORITY_OF, getCase };
export type { CaseStatus };
