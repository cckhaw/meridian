import { audit } from './audit.js';
import { maybeLinkToIncident, resolveIncidentChildren } from './case-incidents.js';
import { pendingRefundCount } from './case-refunds.js';
import { cancelVisitsOfCases } from './workforce.js';
import { getCaseSettings, issueType, PRIORITY_OF, SEVERITIES, slaFor, TIERS, type CaseType, type Severity, type Tier, CASE_TYPES } from './case-taxonomy.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, tsPage, type Page } from './paging.js';
import { customerIdsMatching, likePrefix, parseQuery } from './search.js';

export { CASE_TYPES };

/**
 * The case lifecycle. A case is NEW, is worked (IN_PROGRESS), may wait on the customer, a third party or a technician visit, is RESOLVED, and then closes
 * either by the customer's confirmation (CLOSED_VERIFIED) or by itself after a quiet period (CLOSED_AUTO). A resolved or closed case can be REOPENED within
 * a window. Every move is checked against the table below, recorded in the case's audit trail, and drives the SLA clocks.
 */
export const CASE_STATUSES = ['NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'DISPATCHED', 'RESOLVED', 'CLOSED_AUTO', 'CLOSED_VERIFIED', 'REOPENED'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const ACTIVE_STATUSES: CaseStatus[] = ['NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'DISPATCHED', 'REOPENED'];
export const CLOSED_STATUSES: CaseStatus[] = ['CLOSED_AUTO', 'CLOSED_VERIFIED'];
export const ACTIVE_SQL = `('${ACTIVE_STATUSES.join("','")}')`;

export const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  NEW: ['IN_PROGRESS'],
  IN_PROGRESS: ['PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'RESOLVED'],
  PENDING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED_AUTO'],
  PENDING_THIRD_PARTY: ['IN_PROGRESS', 'RESOLVED'],
  PENDING_DISPATCH: ['DISPATCHED', 'IN_PROGRESS'],
  DISPATCHED: ['PENDING_DISPATCH', 'IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED_VERIFIED', 'CLOSED_AUTO', 'REOPENED'],
  CLOSED_AUTO: ['REOPENED'],
  CLOSED_VERIFIED: ['REOPENED'],
  REOPENED: ['IN_PROGRESS'],
};
export const canCaseTransition = (from: CaseStatus, to: CaseStatus) => CASE_TRANSITIONS[from]?.includes(to) ?? false;

const SYSTEM_ONLY: CaseStatus[] = ['CLOSED_AUTO', 'DISPATCHED'];   // the timer, and the field-service system, make these moves: an agent does not
const MIN = 60_000;

// ───────────────────────── SLA ─────────────────────────
export interface SlaView {
  firstResponse: { dueAt: string | null; at: string | null; state: 'OPEN' | 'MET' | 'BREACHED' | 'MISSED' | 'NONE' };
  resolution: { dueAt: string | null; percent: number; remainingMinutes: number | null; state: 'OK' | 'WARNING' | 'BREACHED' | 'PAUSED' | 'MET' | 'MISSED' | 'NONE' };
}
const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);

/** Where a case stands against its SLA at `now`. Pure: it reads only the case row, so it is the same on screen, in the watchdog and in a report. */
export function slaView(c: Row, now: Date = new Date()): SlaView {
  const t = now.getTime();
  const frDue = ms(c.firstResponseDue), frAt = ms(c.firstResponseAt);
  const firstResponse: SlaView['firstResponse'] = { dueAt: c.firstResponseDue ?? null, at: c.firstResponseAt ?? null,
    state: frDue === null ? 'NONE' : frAt !== null ? (frAt <= frDue ? 'MET' : 'MISSED') : t > frDue ? 'BREACHED' : 'OPEN' };
  const due = ms(c.resolutionDue), total = (c.slaResolutionMinutes ?? 0) * MIN;
  if (due === null || !total) return { firstResponse, resolution: { dueAt: null, percent: 0, remainingMinutes: null, state: 'NONE' } };
  const done = ms(c.resolvedAt);
  if (done !== null && !ACTIVE_STATUSES.includes(c.status) ) return { firstResponse, resolution: { dueAt: c.resolutionDue, percent: Math.min(100, Math.round((1 - (due - done) / total) * 100)), remainingMinutes: null, state: done <= due ? 'MET' : 'MISSED' } };
  const paused = ms(c.slaPausedAt);
  const at = paused ?? t;                                           // while paused the clock stands still
  const remaining = due - at, percent = Math.max(0, Math.min(999, Math.round((1 - remaining / total) * 100)));
  const state = paused !== null ? 'PAUSED' : t > due ? 'BREACHED' : percent >= (c.slaWarnPercent ?? 80) ? 'WARNING' : 'OK';
  return { firstResponse, resolution: { dueAt: c.resolutionDue, percent, remainingMinutes: Math.round(remaining / MIN), state } };
}

// ───────────────────────── creating a case ─────────────────────────
const LEGACY_SEVERITY: Record<string, Severity> = { URGENT: 'CRITICAL_OUTAGE', HIGH: 'MAJOR_DEGRADATION', NORMAL: 'MINOR_INQUIRY', LOW: 'MINOR_INQUIRY' };
const GENERAL_ISSUE: Record<CaseType, string> = { FIBER_ASSURANCE: 'broadband.other.any', BILLING_REFUND: 'billing.other.any', MNP_PORT_OUT: 'porting.out.request', GENERAL: 'general.enquiry.any' };

/** VIP customers get the VIP row of the SLA matrix; customers of a business segment the Enterprise row; the rest Standard. */
export async function tierOf(q: Queryable, customerId: string): Promise<Tier> {
  const r = (await q.query(`SELECT c.vip, COALESCE(s.individual, true) AS individual FROM customers c LEFT JOIN customer_segments s ON s.id = c.segment WHERE c.id=$1`, [customerId])).rows[0];
  if (!r) throw notFound('customer', customerId);
  return r.vip ? 'VIP' : r.individual ? 'STANDARD' : 'ENTERPRISE';
}

export interface NewCase {
  customerId: string; serviceId?: string; issueTypeId?: string;
  /** The kind of case, when no issue type is chosen. */
  type?: CaseType; subject: string; severity?: Severity;
  /** Old four-level priority, accepted and turned into a severity. */
  priority?: string; note?: string; channel?: string; postalNode?: string; interactionIds?: string[]; tier?: Tier;
}

export async function createCase(q: Queryable, i: NewCase, actor = 'system') {
  if (!i.subject?.trim()) throw invalid('subject is required');
  if (i.subject.length > 200) throw invalid('The subject is at most 200 characters.');
  const cust = (await q.query(`SELECT address FROM customers WHERE id=$1`, [i.customerId])).rows[0];
  if (!cust) throw notFound('customer', i.customerId);
  if (i.type && !CASE_TYPES.includes(i.type)) throw invalid(`type must be one of ${CASE_TYPES.join(', ')}`);
  const it = await issueType(q, i.issueTypeId ?? GENERAL_ISSUE[i.type ?? 'GENERAL']);
  if (i.type && i.issueTypeId && it.caseType !== i.type) throw invalid(`“${it.name}” is a ${it.caseType} issue, not ${i.type}.`);
  const severity = i.severity ?? (i.priority ? LEGACY_SEVERITY[i.priority] : undefined) ?? it.defaultSeverity!;
  if (!SEVERITIES.includes(severity)) throw invalid(`severity must be one of ${SEVERITIES.join(', ')}`);
  const tier = i.tier ?? (await tierOf(q, i.customerId));
  if (!TIERS.includes(tier)) throw invalid(`tier must be one of ${TIERS.join(', ')}`);
  if (i.serviceId && !(await q.query('SELECT 1 FROM services WHERE id=$1', [i.serviceId])).rows.length) throw notFound('service', i.serviceId);
  const sla = await slaFor(q, tier, severity);
  const seq = (await q.query(`SELECT nextval('case_seq') AS n`)).rows[0]!.n;
  const node = (i.postalNode ?? (cust.address as { postcode?: string } | null)?.postcode ?? '').toString().trim().toUpperCase() || null;
  const notes = i.note ? [{ at: new Date().toISOString(), by: actor, text: i.note }] : [];
  const c = (await q.query(
    `INSERT INTO cases (number, customer_id, service_id, type, priority, subject, notes, issue_type_id, category_path, severity, tier, channel, postal_node,
        sla_first_response_minutes, sla_resolution_minutes, sla_warn_percent, first_response_due, resolution_due)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now() + make_interval(mins => $14), now() + make_interval(mins => $15)) RETURNING *`,
    [`CS-${String(seq).padStart(6, '0')}`, i.customerId, i.serviceId ?? null, it.caseType, PRIORITY_OF[severity], i.subject.trim(), JSON.stringify(notes), it.id, it.path, severity, tier,
      i.channel ?? null, node, sla.firstResponseMinutes, sla.resolutionMinutes, sla.warnPercent])).rows[0]!;
  await caseLog(q, c.id, actor, 'CREATED', { detail: { issueType: it.id, severity, tier, firstResponseDue: c.firstResponseDue, resolutionDue: c.resolutionDue } });
  await audit(q, actor, 'case', c.id, 'CREATED', { type: it.caseType, severity, tier });
  if (i.interactionIds?.length) await bindInteractions(q, c.id, i.interactionIds, actor);
  await maybeLinkToIncident(q, c);
  return getCase(q, c.id);
}

export const caseLog = (q: Queryable, caseId: string, actor: string, action: string, o: { from?: string; to?: string; detail?: Record<string, unknown> } = {}) =>
  q.query(`INSERT INTO case_audit_log (case_id, actor, action, from_status, to_status, detail) VALUES ($1,$2,$3,$4,$5,$6)`, [caseId, actor, action, o.from ?? null, o.to ?? null, JSON.stringify(o.detail ?? {})]);

/** A message for the supervisors (team leads), delivered by the notification adapter. Names the case's team so it can be routed. */
export const notifySupervisors = (q: Queryable, c: Row, instruction: string, message: string, extra: Record<string, unknown> = {}) =>
  q.query(`INSERT INTO lifecycle_outbox (kind, service_id, instruction, payload) VALUES ('NOTIFY', $1, $2, $3)`,
    [c.serviceId ?? null, instruction, JSON.stringify({ to: 'SUPERVISORS', team: c.team ?? null, caseId: c.id, caseNumber: c.number, message, ...extra })]);

/** A message for the customer, delivered by the notification adapter (SMS, WhatsApp, e-mail). */
export const notifyCustomer = async (q: Queryable, c: Row, instruction: string, message: string, extra: Record<string, unknown> = {}) => {
  if (!c.customerId) return;                    // a network incident has no customer to tell
  await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, instruction, payload) VALUES ('NOTIFY', $1, $2, $3)`,
    [c.serviceId ?? null, instruction, JSON.stringify({ customerId: c.customerId, caseId: c.id, caseNumber: c.number, message, ...extra })]);
};

// ───────────────────────── moving a case through its lifecycle ─────────────────────────
export interface TransitionOptions { actor?: string; note?: string; resolution?: string; reason?: string; /** Moves made by a timer or by the field-service system. */ system?: boolean; /** Tell the customer about the move (the default); a caller that sends its own message turns this off. */ notify?: boolean }

const MESSAGES: Partial<Record<CaseStatus, (c: Row) => string>> = {
  PENDING_CUSTOMER: (c) => `We need a reply from you on case ${c.number}. Please get in touch.`,
  REOPENED: (c) => `Case ${c.number} has been reopened and is being looked at again.`,
};

export async function transitionCase(q: Queryable, id: string, to: CaseStatus, o: TransitionOptions = {}): Promise<Row> {
  const actor = o.actor ?? 'system';
  if (!CASE_STATUSES.includes(to)) throw invalid(`status must be one of ${CASE_STATUSES.join(', ')}`);
  const c = (await q.query('SELECT * FROM cases WHERE id=$1', [id])).rows[0];
  if (!c) throw notFound('case', id);
  const from = c.status as CaseStatus;
  if (from === to) throw conflict(`The case is already ${to.replace(/_/g, ' ').toLowerCase()}.`);
  if (!canCaseTransition(from, to)) throw rejected(`A case that is ${from.replace(/_/g, ' ').toLowerCase()} cannot go to ${to.replace(/_/g, ' ').toLowerCase()}. It can go to: ${CASE_TRANSITIONS[from].map((s) => s.replace(/_/g, ' ').toLowerCase()).join(', ') || 'nowhere'}.`);
  if (SYSTEM_ONLY.includes(to) && !o.system) throw rejected(to === 'DISPATCHED' ? 'A case becomes dispatched when the field-service system confirms the visit, not by hand.' : 'A case closes itself after a quiet period; to close it now, confirm it with the customer (closed, verified).');
  const settings = await getCaseSettings(q);
  const now = new Date();
  const set: string[] = [], args: unknown[] = [id, from, to];
  const add = (sql: string, v?: unknown) => { if (v !== undefined) { args.push(v); set.push(sql.replace('?', `$${args.length}`)); } else set.push(sql); };

  // Leaving a pause gives the customer's waiting time back to the SLA.
  if (c.slaPausedAt) {
    add(`resolution_due = resolution_due + (now() - sla_paused_at)`); add(`sla_paused_at = NULL`);
  }
  if (to === 'PENDING_CUSTOMER') { add(`sla_paused_at = now()`); if (!c.firstResponseAt) add(`first_response_at = now()`); }
  if (to === 'IN_PROGRESS' && !c.assignee && !o.system && actor) add(`assignee = ?`, actor);
  if (to === 'RESOLVED') {
    const resolution = (o.resolution ?? o.note ?? '').trim();
    if (resolution.length < 3) throw invalid('Say how the case was resolved.');
    if (await pendingRefundCount(q, id)) throw rejected('A refund on this case is waiting for approval. Wait for the decision, or withdraw the request, before resolving it.');
    add(`resolution = ?`, resolution); add(`resolved_at = now()`); add(`auto_close_at = now() + make_interval(hours => ${settings.autoCloseHours})`);
    if (!c.firstResponseAt) add(`first_response_at = now()`);
  } else if (to !== 'CLOSED_AUTO' && to !== 'CLOSED_VERIFIED') add(`auto_close_at = NULL`);
  if (CLOSED_STATUSES.includes(to)) { add(`closed_at = now()`); add(`auto_close_at = NULL`); }
  if (to === 'REOPENED') {
    const why = (o.reason ?? o.note ?? '').trim();
    if (why.length < 3) throw invalid('Say why the case is being reopened.');
    if (CLOSED_STATUSES.includes(from) && c.closedAt && now.getTime() - new Date(c.closedAt).getTime() > settings.reopenDays * 86_400_000)
      throw rejected(`This case closed more than ${settings.reopenDays} days ago. Open a new case and refer to ${c.number}.`);
    add(`reopen_count = reopen_count + 1`); add(`resolved_at = NULL`); add(`closed_at = NULL`);
    add(`resolution_due = now() + make_interval(mins => sla_resolution_minutes)`); add(`sla_warned_at = NULL`); add(`sla_breached_at = NULL`);
  }
  // A case waiting on a technician has a time by which the visit should have been settled; leaving the dispatch states clears it.
  if (to === 'PENDING_DISPATCH') { if (from !== 'DISPATCHED') add(`dispatch_due_at = COALESCE(dispatch_due_at, now() + make_interval(hours => ${settings.dispatchUnconfirmedHours}))`); }
  else if (to !== 'DISPATCHED') { add(`dispatch_due_at = NULL`); add(`dispatch_notified_at = NULL`); }
  add(`status = $3`); add(`updated_at = now()`);
  if (to === 'RESOLVED' || to === 'CLOSED_AUTO' || to === 'CLOSED_VERIFIED') { /* kept as is: the SLA outcome is read from resolved_at */ }
  const r = await q.query(`UPDATE cases SET ${set.join(', ')} WHERE id=$1 AND status=$2`, args);
  if (!r.rowCount) throw conflict('Someone else just changed this case. Reload it and try again.');
  const text = (o.note ?? o.reason ?? '').trim();
  if (text && to !== 'RESOLVED') await q.query(`UPDATE cases SET notes = notes || $2::jsonb WHERE id=$1`, [id, JSON.stringify([{ at: now.toISOString(), by: actor, text }])]);
  await caseLog(q, id, actor, 'STATUS', { from, to, detail: { ...(o.resolution ? { resolution: o.resolution } : {}), ...(text ? { note: text } : {}), ...(o.system ? { system: true } : {}) } });
  await audit(q, actor, 'case', id, 'STATUS', { from, to });
  if (to === 'RESOLVED' && c.isMaster) {
    const kids = await resolveIncidentChildren(q, c, (o.resolution ?? o.note ?? '').trim(), settings.autoCloseHours);
    if (kids.length) {
      await caseLog(q, id, actor, 'INCIDENT_CASES_RESOLVED', { detail: { count: kids.length } });
      await cancelVisitsOfCases(q, kids.map((k) => k.id), `Resolved with network incident ${c.number}`);   // no technician needs to go for a fault that is fixed
    }
  }
  if (o.notify === false) { /* the caller tells the customer itself */ }
  else if (to === 'RESOLVED') await notifyCustomer(q, c, 'CASE_RESOLVED', `Case ${c.number} has been resolved: ${(o.resolution ?? o.note ?? '').trim()}. If it is not fixed, tell us within ${settings.reopenDays} days and we will look again.`);
  else if (MESSAGES[to]) await notifyCustomer(q, c, `CASE_${to}`, MESSAGES[to]!(c));
  return getCase(q, id);
}

export async function assignCase(q: Queryable, id: string, a: { assignee: string | null; team?: string | null }, actor: string): Promise<Row> {
  const c = await getCase(q, id);
  if (CLOSED_STATUSES.includes(c.status)) throw rejected('A closed case cannot be reassigned. Reopen it first.');
  if (a.assignee && a.assignee !== actor && !(await q.query('SELECT 1 FROM users WHERE username=$1', [a.assignee])).rows.length) throw invalid(`There is no user ${a.assignee}.`);
  await q.query(`UPDATE cases SET assignee=$2, team=COALESCE($3, team), updated_at=now() WHERE id=$1`, [id, a.assignee, a.team ?? null]);
  await caseLog(q, id, actor, 'ASSIGNED', { detail: { from: c.assignee, to: a.assignee, team: a.team ?? c.team } });
  return getCase(q, id);
}

/** A new severity re-prices the SLA from the case's opening time (a case found to be an outage is late by the outage's clock, not given a fresh start). */
export async function setSeverity(q: Queryable, id: string, severity: Severity, actor: string, why = ''): Promise<Row> {
  if (!SEVERITIES.includes(severity)) throw invalid(`severity must be one of ${SEVERITIES.join(', ')}`);
  const c = await getCase(q, id);
  if (!ACTIVE_STATUSES.includes(c.status)) throw rejected('Only an open case can change severity.');
  if (c.severity === severity) return c;
  const sla = await slaFor(q, c.tier, severity);
  await q.query(
    `UPDATE cases SET severity=$2, priority=$3, sla_first_response_minutes=$4, sla_resolution_minutes=$5, sla_warn_percent=$6,
       first_response_due = created_at + make_interval(mins => $4), resolution_due = created_at + make_interval(mins => $5) + (resolution_due - (created_at + make_interval(mins => sla_resolution_minutes))),
       sla_warned_at = NULL, sla_breached_at = NULL, updated_at = now() WHERE id=$1`,
    [id, severity, PRIORITY_OF[severity], sla.firstResponseMinutes, sla.resolutionMinutes, sla.warnPercent]);
  await caseLog(q, id, actor, 'SEVERITY', { detail: { from: c.severity, to: severity, ...(why ? { why } : {}) } });
  return getCase(q, id);
}

export async function addCaseNote(q: Queryable, id: string, text: string, actor: string): Promise<Row> {
  const t = (text ?? '').trim();
  if (!t) throw invalid('The note is empty.');
  if (t.length > 4000) throw invalid('A note is at most 4,000 characters.');
  const r = await q.query(`UPDATE cases SET notes = notes || $2::jsonb, updated_at = now() WHERE id=$1`, [id, JSON.stringify([{ at: new Date().toISOString(), by: actor, text: t }])]);
  if (!r.rowCount) throw notFound('case', id);
  await caseLog(q, id, actor, 'NOTE');
  return getCase(q, id);
}

/** Old callers: a status, priority or note in one call. A status change goes through the lifecycle rules like any other. */
export async function updateCase(q: Queryable, id: string, p: { status?: string; priority?: string; severity?: Severity; note?: string; resolution?: string; reason?: string }, actor = 'system') {
  if (p.status) return transitionCase(q, id, p.status as CaseStatus, { actor, note: p.note, resolution: p.resolution, reason: p.reason });
  const sev = p.severity ?? (p.priority ? LEGACY_SEVERITY[p.priority] : undefined);
  if (p.priority && !sev) throw invalid('priority must be LOW, NORMAL, HIGH or URGENT');
  if (sev) await setSeverity(q, id, sev, actor);
  if (p.note) return addCaseNote(q, id, p.note, actor);
  return getCase(q, id);
}

/** A person or system closes the loop on the cases of a service (a completed port-out): through the same rules, as the system. */
export async function resolveCasesOfService(q: Queryable, serviceId: string, type: CaseType, to: 'RESOLVED' | 'CLOSED_AUTO', note: string): Promise<number> {
  const open = (await q.query(`SELECT id, status FROM cases WHERE service_id=$1 AND type=$2 AND status IN ${ACTIVE_SQL}`, [serviceId, type])).rows;
  for (const c of open) {
    if (c.status === 'NEW' || c.status === 'REOPENED') await transitionCase(q, c.id, 'IN_PROGRESS', { system: true });
    const cur = (await q.query('SELECT status FROM cases WHERE id=$1', [c.id])).rows[0]!.status as CaseStatus;
    if (cur === 'PENDING_DISPATCH' || cur === 'DISPATCHED') await transitionCase(q, c.id, 'IN_PROGRESS', { system: true });
    await transitionCase(q, c.id, 'RESOLVED', { system: true, resolution: note });
    if (to === 'CLOSED_AUTO') await transitionCase(q, c.id, 'CLOSED_AUTO', { system: true });
  }
  return open.length;
}

// ───────────────────────── reading ─────────────────────────
const withSla = (c: Row) => ({ ...c, sla: slaView(c) });

export async function listCases(q: Queryable, f: { customerId?: string; status?: string; type?: string; severity?: string; assignee?: string; unassigned?: boolean; issueTypeId?: string; breached?: boolean; masters?: boolean; masterCaseId?: string; postalNode?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.customerId) where.push(`k.customer_id = ${p(f.customerId)}`);
  if (f.status === 'ACTIVE') where.push(`k.status IN ${ACTIVE_SQL}`); else if (f.status === 'CLOSED') where.push(`k.status IN ('CLOSED_AUTO','CLOSED_VERIFIED')`); else if (f.status) where.push(`k.status = ${p(f.status)}`);
  if (f.type) where.push(`k.type = ${p(f.type)}`);
  if (f.severity) where.push(`k.severity = ${p(f.severity)}`);
  if (f.assignee) where.push(`k.assignee = ${p(f.assignee)}`); else if (f.unassigned) where.push(`k.assignee IS NULL`);
  if (f.issueTypeId) where.push(`k.issue_type_id = ${p(f.issueTypeId)}`);
  if (f.masters) where.push('k.is_master');
  if (f.masterCaseId) where.push(`k.master_case_id = ${p(f.masterCaseId)}`);
  if (f.postalNode) where.push(`k.postal_node = ${p(f.postalNode.trim().toUpperCase())}`);
  if (f.breached) where.push(`k.status IN ${ACTIVE_SQL} AND k.sla_paused_at IS NULL AND k.resolution_due < now()`);
  // Search: a case number prefix, otherwise whoever the customer is.
  const text = (f.q ?? '').trim();
  if (/^[a-z]{1,6}-\d/i.test(text) || /^case/i.test(text)) where.push(`k.number LIKE ${p(likePrefix(text.toUpperCase()))}`);
  else { const ids = customerIdsMatching(await parseQuery(q, text), p); if (ids) where.push(`k.customer_id IN (${ids})`); }
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(k.created_at, k.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT k.*, k.created_at::text AS cursor_ts, c.display_name AS customer_name FROM cases k LEFT JOIN customers c ON c.id = k.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY k.created_at DESC, k.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  const page = tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
  return { ...page, items: page.items.map(withSla) };
}

export const getCase = async (q: Queryable, id: string): Promise<Row> => {
  const c = (await q.query('SELECT k.*, c.display_name AS customer_name FROM cases k LEFT JOIN customers c ON c.id = k.customer_id WHERE k.id=$1', [id])).rows[0];
  if (!c) throw notFound('case', id);
  if (c.isMaster) {
    const n = (await q.query(`SELECT count(*) AS total, count(*) FILTER (WHERE status IN ${ACTIVE_SQL}) AS open FROM cases WHERE master_case_id=$1`, [id])).rows[0]!;
    return { ...withSla(c), childCount: Number(n.total), childOpenCount: Number(n.open) };
  }
  return withSla(c);
};

/** Everything that happened on a case, newest first: status changes, assignments, notes and the customer's interactions on it. */
export async function caseTimeline(q: Queryable, id: string): Promise<Array<{ at: string; kind: string; actor: string | null; title: string; detail: Record<string, unknown> }>> {
  const c = await getCase(q, id);
  const audit = (await q.query(`SELECT at, actor, action, from_status, to_status, detail FROM case_audit_log WHERE case_id=$1 AND action <> 'NOTE' ORDER BY id`, [id])).rows;
  const inter = (await q.query(`SELECT id, occurred_at, channel, direction, subject, summary, agent, created_by FROM customer_interactions WHERE case_id=$1`, [id])).rows;
  const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();
  const out = [
    ...audit.map((a) => ({ at: a.at as string, kind: a.action === 'STATUS' ? 'status' : a.action === 'INTERACTION' ? 'attached' : a.action === 'INTERACTION_DETACHED' ? 'detached' : String(a.action).toLowerCase(), actor: a.actor as string,
      title: a.action === 'STATUS' ? `${label(a.fromStatus)} → ${label(a.toStatus)}` : a.action === 'CREATED' ? 'Case opened' : a.action === 'ASSIGNED' ? `Assigned to ${a.detail.to ?? 'nobody'}` : a.action === 'SEVERITY' ? `Severity ${label(a.detail.from)} → ${label(a.detail.to)}` : a.action === 'INTERACTION' ? `${a.detail.attached} interaction${a.detail.attached === 1 ? '' : 's'} attached` : a.action === 'INTERACTION_DETACHED' ? 'Interaction detached' : label(a.action), detail: a.detail as Record<string, unknown> })),
    ...inter.map((i) => ({ at: i.occurredAt as string, kind: 'interaction', actor: (i.agent ?? i.createdBy) as string, title: `${i.direction === 'INBOUND' ? 'Inbound' : 'Outbound'} ${label(i.channel)}: ${i.subject}`, detail: { id: i.id, summary: i.summary, channel: i.channel, direction: i.direction } })),
    ...(c.notes as Array<{ at: string; by: string; text: string }>).map((n) => ({ at: n.at, kind: 'note', actor: n.by, title: n.text, detail: {} })),
  ];
  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

// ───────────────────────── interactions attached to cases ─────────────────────────
/** Attaches interactions to a case; each must be the same customer's, and not already on another case. */
export async function bindInteractions(q: Queryable, caseId: string, interactionIds: string[], actor: string): Promise<number> {
  const c = (await q.query('SELECT id, customer_id, first_response_at FROM cases WHERE id=$1', [caseId])).rows[0];
  if (!c) throw notFound('case', caseId);
  if (interactionIds.length > 200) throw invalid('Attach at most 200 interactions at once.');
  const rows = (await q.query('SELECT id, customer_id, case_id, direction, occurred_at FROM customer_interactions WHERE id = ANY($1::uuid[])', [interactionIds])).rows;
  if (rows.length !== new Set(interactionIds).size) throw notFound('interaction');
  for (const r of rows) {
    if (r.customerId !== c.customerId) throw invalid('An interaction can only be attached to a case of the same customer.');
    if (r.caseId && r.caseId !== caseId) throw conflict('An interaction is already attached to another case.');
  }
  const fresh = rows.filter((r) => !r.caseId);
  if (!fresh.length) return 0;
  await q.query('UPDATE customer_interactions SET case_id=$1 WHERE id = ANY($2::uuid[])', [caseId, fresh.map((r) => r.id)]);
  const firstOut = fresh.filter((r) => r.direction === 'OUTBOUND').map((r) => new Date(r.occurredAt).getTime()).sort((a, b) => a - b)[0];
  if (!c.firstResponseAt && firstOut !== undefined) await q.query('UPDATE cases SET first_response_at = GREATEST($2::timestamptz, created_at), updated_at = now() WHERE id=$1 AND first_response_at IS NULL', [caseId, new Date(firstOut).toISOString()]);
  await caseLog(q, caseId, actor, 'INTERACTION', { detail: { attached: fresh.length } });
  return fresh.length;
}
export type { Db };
