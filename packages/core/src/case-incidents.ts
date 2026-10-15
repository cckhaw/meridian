import { ACTIVE_SQL, caseLog, getCase } from './cases.js';
import { getCaseSettings, issueType, slaFor, SEVERITIES, type Severity } from './case-taxonomy.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, tsPage, type Page } from './paging.js';

/**
 * Network incidents. When a node of the network fails, dozens of customers call about it. A *master incident case* stands for the fault itself (it belongs to
 * a postal node, not to a customer); each customer's own case is linked to it as a child. Working the master is working all of them, and resolving the master
 * resolves every open child and tells each customer. Linking and resolving are single set-based statements, so an incident with thousands of cases is as
 * quick as one with three.
 *
 * Cases can be grouped by hand, suggested (a number of network cases from one node in a short window), grouped by themselves when the operator switches that on, and
 * a case opened at a node that already has an open master is attached to it as it is created.
 */
const NETWORK_TYPES = ['FIBER_ASSURANCE', 'GENERAL'];
export const normaliseNode = (n: unknown) => String(n ?? '').trim().toUpperCase();

export async function openMasterAt(q: Queryable, node: string): Promise<Row | null> {
  return (await q.query(`SELECT * FROM cases WHERE is_master AND postal_node=$1 AND status IN ${ACTIVE_SQL} ORDER BY created_at LIMIT 1`, [node])).rows[0] ?? null;
}

export async function createMasterIncident(q: Queryable, i: { postalNode: string; issueTypeId: string; subject?: string; severity?: Severity; note?: string; caseIds?: string[]; adoptOpen?: boolean }, actor: string): Promise<{ incident: Row; linked: number }> {
  const node = normaliseNode(i.postalNode);
  if (!node || node.length > 20) throw invalid('Give the postal node (postcode or node code) the fault is at.');
  const it = await issueType(q, i.issueTypeId);
  if (!NETWORK_TYPES.includes(it.caseType!)) throw invalid('A network incident is a fibre or service fault, not a billing or porting matter.');
  const severity = i.severity ?? 'CRITICAL_OUTAGE';
  if (!SEVERITIES.includes(severity)) throw invalid(`severity must be one of ${SEVERITIES.join(', ')}`);
  const existing = await openMasterAt(q, node);
  if (existing) throw conflict(`There is already an open incident at ${node}: ${existing.number}. Attach cases to it instead.`);
  const sla = await slaFor(q, 'VIP', severity);                  // a network fault is tracked on the tightest clock
  const seq = (await q.query(`SELECT nextval('incident_seq') AS n`)).rows[0]!.n;
  const subject = (i.subject ?? '').trim() || `Network incident at ${node}`;
  const c = (await q.query(
    `INSERT INTO cases (number, customer_id, type, priority, subject, notes, issue_type_id, category_path, severity, tier, postal_node, is_master,
        sla_first_response_minutes, sla_resolution_minutes, sla_warn_percent, first_response_due, resolution_due)
     VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,'VIP',$9,true,$10,$11,$12, now() + make_interval(mins => $10), now() + make_interval(mins => $11)) RETURNING *`,
    [`INC-${String(seq).padStart(6, '0')}`, it.caseType, severity === 'CRITICAL_OUTAGE' ? 'URGENT' : severity === 'MAJOR_DEGRADATION' ? 'HIGH' : 'NORMAL', subject,
      JSON.stringify(i.note ? [{ at: new Date().toISOString(), by: actor, text: i.note }] : []), it.id, it.path, severity, node, sla.firstResponseMinutes, sla.resolutionMinutes, sla.warnPercent])).rows[0]!;
  await caseLog(q, c.id, actor, 'CREATED', { detail: { incident: true, node, issueType: it.id } });
  let linked = 0;
  if (i.caseIds?.length) linked = (await linkCases(q, c.id, { caseIds: i.caseIds }, actor)).linked;
  else if (i.adoptOpen !== false) linked = (await linkCases(q, c.id, { adoptNode: true }, actor)).linked;
  return { incident: await getCase(q, c.id), linked };
}

/**
 * Attaches cases to a master incident: the cases listed, or every open network case at the incident's node that is not on one yet. Cases that cannot be attached
 * (closed, already linked, at another node, themselves masters) are counted and left alone. Each customer is told.
 */
export async function linkCases(q: Queryable, masterId: string, what: { caseIds?: string[]; adoptNode?: boolean }, actor: string): Promise<{ linked: number; skipped: number }> {
  const m = (await q.query('SELECT * FROM cases WHERE id=$1', [masterId])).rows[0];
  if (!m) throw notFound('case', masterId);
  if (!m.isMaster) throw invalid('Only a network incident can have cases attached.');
  if (!['NEW', 'IN_PROGRESS', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'DISPATCHED', 'REOPENED', 'PENDING_CUSTOMER'].includes(m.status)) throw rejected('This incident is resolved. Reopen it, or open a new one.');
  if (!what.adoptNode && !what.caseIds?.length) throw invalid('Choose the cases to attach.');
  if (what.caseIds && what.caseIds.length > 5000) throw invalid('Attach at most 5,000 cases at once.');
  const ids = what.adoptNode ? null : what.caseIds!;
  const rows = (await q.query(
    `UPDATE cases SET master_case_id = $1, updated_at = now()
       WHERE is_master = false AND master_case_id IS NULL AND status IN ${ACTIVE_SQL} AND postal_node = $2 AND type IN ('FIBER_ASSURANCE','GENERAL') AND customer_id IS NOT NULL
         AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
       RETURNING id, number, customer_id, service_id`, [masterId, m.postalNode, ids])).rows;
  if (rows.length) await announceLinked(q, rows.map((r) => r.id), m, actor);
  return { linked: rows.length, skipped: ids ? new Set(ids).size - rows.length : 0 };
}

async function announceLinked(q: Queryable, ids: string[], m: Row, actor: string) {
  await q.query(`INSERT INTO case_audit_log (case_id, actor, action, detail) SELECT id, $2, 'INCIDENT_LINKED', jsonb_build_object('master', $3::text, 'masterId', $4::text) FROM cases WHERE id = ANY($1::uuid[])`, [ids, actor, m.number, m.id]);
  await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, instruction, payload)
    SELECT 'NOTIFY', service_id, 'CASE_INCIDENT_LINKED', jsonb_build_object('customerId', customer_id, 'caseId', id, 'caseNumber', number, 'incident', $2::text,
      'message', 'We know about a network fault in your area (' || $2::text || ') and our engineers are working on it. Your case ' || number || ' will be updated when it is fixed.') FROM cases WHERE id = ANY($1::uuid[])`, [ids, m.number]);
  await caseLog(q, m.id, actor, 'INCIDENT_CASES_LINKED', { detail: { count: ids.length } });
}

export async function unlinkCase(q: Queryable, caseId: string, actor: string): Promise<Row> {
  const c = (await q.query('SELECT id, master_case_id FROM cases WHERE id=$1', [caseId])).rows[0];
  if (!c) throw notFound('case', caseId);
  if (!c.masterCaseId) throw conflict('This case is not part of an incident.');
  await q.query('UPDATE cases SET master_case_id = NULL, updated_at = now() WHERE id=$1', [caseId]);
  await caseLog(q, caseId, actor, 'INCIDENT_UNLINKED', { detail: { master: c.masterCaseId } });
  return getCase(q, caseId);
}

/** A new case at a node that has an open master incident joins it, when the operator allows that. */
export async function maybeLinkToIncident(q: Queryable, c: Row): Promise<boolean> {
  if (!c.postalNode || c.isMaster || !NETWORK_TYPES.includes(c.type) || c.type === 'GENERAL') return false;
  if (!(await getCaseSettings(q)).incidentAutoLink) return false;
  const m = await openMasterAt(q, c.postalNode);
  if (!m) return false;
  const r = await q.query(`UPDATE cases SET master_case_id=$2, updated_at=now() WHERE id=$1 AND master_case_id IS NULL`, [c.id, m.id]);
  if (r.rowCount) await announceLinked(q, [c.id], m, 'system');
  return !!r.rowCount;
}

export interface IncidentSuggestion { postalNode: string; cases: number; oldestAt: string; issueTypeId: string; caseIds: string[] }
/** Nodes where several network cases opened close together and are not on an incident. */
export async function suggestIncidents(q: Queryable, o: { threshold?: number; windowMinutes?: number } = {}): Promise<IncidentSuggestion[]> {
  const s = await getCaseSettings(q);
  const threshold = o.threshold ?? s.incidentThreshold, window = o.windowMinutes ?? s.incidentWindowMinutes;
  const rows = (await q.query(
    `SELECT postal_node, count(*) AS n, min(created_at) AS oldest,
            mode() WITHIN GROUP (ORDER BY issue_type_id) AS issue_type_id, (array_agg(id ORDER BY created_at))[1:50] AS ids
       FROM cases WHERE status IN ${ACTIVE_SQL} AND is_master = false AND master_case_id IS NULL AND type = 'FIBER_ASSURANCE' AND postal_node IS NOT NULL AND created_at >= now() - make_interval(mins => $2)
         AND postal_node NOT IN (SELECT postal_node FROM cases WHERE is_master AND postal_node IS NOT NULL AND status IN ${ACTIVE_SQL})
       GROUP BY postal_node HAVING count(*) >= $1 ORDER BY count(*) DESC LIMIT 50`, [threshold, window])).rows;
  return rows.map((r) => ({ postalNode: r.postalNode, cases: Number(r.n), oldestAt: r.oldest, issueTypeId: r.issueTypeId, caseIds: r.ids }));
}

/** Creates an incident for every suggested node. Does nothing unless the operator has switched automatic grouping on. */
export async function correlateCases(q: Queryable, actor = 'system'): Promise<{ created: Array<{ number: string; postalNode: string; linked: number }> }> {
  const s = await getCaseSettings(q);
  if (!s.incidentAutoCreate) return { created: [] };
  const created: Array<{ number: string; postalNode: string; linked: number }> = [];
  for (const g of await suggestIncidents(q)) {
    try {
      const r = await createMasterIncident(q, { postalNode: g.postalNode, issueTypeId: g.issueTypeId, subject: `Network incident at ${g.postalNode}: ${g.cases} customers affected`, note: 'Grouped automatically from customer cases.' }, actor);
      created.push({ number: r.incident.number, postalNode: g.postalNode, linked: r.linked });
    } catch { /* an issue type switched off, or someone opened the incident first: the next run looks again */ }
  }
  return { created };
}

/** The open child cases of a master are resolved with it, in one statement. Returns their ids and what each was. */
export async function resolveIncidentChildren(q: Queryable, master: Row, resolution: string, autoCloseHours: number): Promise<Array<{ id: string; fromStatus: string }>> {
  const text = `Resolved with network incident ${master.number}: ${resolution}`;
  const rows = (await q.query(
    `WITH old AS (SELECT id, status FROM cases WHERE master_case_id = $1 AND status IN ${ACTIVE_SQL} FOR UPDATE)
     UPDATE cases k SET status='RESOLVED', resolution=$2, resolved_at=now(), auto_close_at = now() + make_interval(hours => $3),
        resolution_due = CASE WHEN k.sla_paused_at IS NOT NULL THEN k.resolution_due + (now() - k.sla_paused_at) ELSE k.resolution_due END, sla_paused_at = NULL,
        first_response_at = COALESCE(k.first_response_at, now()), updated_at = now()
       FROM old WHERE k.id = old.id RETURNING k.id, old.status AS from_status, k.number, k.service_id, k.customer_id`, [master.id, text, autoCloseHours])).rows;
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await q.query(`INSERT INTO case_audit_log (case_id, actor, action, from_status, to_status, detail)
      SELECT k.id, 'system', 'STATUS', o.status, 'RESOLVED', jsonb_build_object('system', true, 'resolution', $3::text, 'incident', $2::text)
        FROM cases k JOIN unnest($1::uuid[], $4::text[]) AS o(id, status) ON o.id = k.id`, [ids, master.number, text, rows.map((r) => r.fromStatus)]);
    await q.query(`INSERT INTO lifecycle_outbox (kind, service_id, instruction, payload) SELECT 'NOTIFY', service_id, 'CASE_RESOLVED',
      jsonb_build_object('customerId', customer_id, 'caseId', id, 'caseNumber', number, 'incident', $2::text, 'message', 'The network fault that affected you (' || $2::text || ') is fixed, and your case ' || number || ' is resolved. If you still have a problem, tell us and we will look again.')
      FROM cases WHERE id = ANY($1::uuid[])`, [ids, master.number]);
  }
  return rows.map((r) => ({ id: r.id, fromStatus: r.fromStatus }));
}

export async function listIncidentChildren(q: Queryable, masterId: string, f: { limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where = [`k.master_case_id = ${p(masterId)}`];
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(k.created_at, k.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT k.id, k.number, k.subject, k.status, k.severity, k.assignee, k.created_at, k.created_at::text AS cursor_ts, c.display_name AS customer_name
       FROM cases k LEFT JOIN customers c ON c.id = k.customer_id WHERE ${where.join(' AND ')} ORDER BY k.created_at DESC, k.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
}
