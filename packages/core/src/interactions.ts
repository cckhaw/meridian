import { audit } from './audit.js';
import { bindInteractions, caseLog, createCase, getCase, type NewCase } from './cases.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, tsPage, type Page } from './paging.js';

/**
 * The interaction registry: every touchpoint with a customer, on any channel, is logged here whether or not it becomes a case. An interaction can be attached to a
 * case afterwards (one case holds many interactions), or a case can be opened straight from one. The first outbound interaction on a case is its first response.
 */
export const INTERACTION_CHANNELS = ['CALL_CENTER', 'RETAIL_POS', 'WHATSAPP', 'WEB_SELF_SERVE', 'MOBILE_APP', 'EMAIL', 'IN_STORE'] as const;
export type InteractionChannel = (typeof INTERACTION_CHANNELS)[number];
export const DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;

export interface NewInteraction {
  customerId: string; channel: InteractionChannel; direction: (typeof DIRECTIONS)[number]; subject: string; summary?: string; serviceId?: string; caseId?: string;
  agent?: string; sessionRef?: string; durationSec?: number; occurredAt?: string; metadata?: Record<string, unknown>;
}

export async function logInteraction(q: Queryable, i: NewInteraction, actor: string): Promise<Row> {
  if (!INTERACTION_CHANNELS.includes(i.channel)) throw invalid(`channel must be one of ${INTERACTION_CHANNELS.join(', ')}`);
  if (!DIRECTIONS.includes(i.direction)) throw invalid('direction must be INBOUND or OUTBOUND');
  const subject = (i.subject ?? '').trim();
  if (!subject || subject.length > 200) throw invalid('Give the interaction a subject of 1–200 characters.');
  if ((i.summary ?? '').length > 8000) throw invalid('The summary is at most 8,000 characters.');
  if (i.durationSec !== undefined && (!Number.isInteger(i.durationSec) || i.durationSec < 0 || i.durationSec > 86_400)) throw invalid('The duration is whole seconds, up to a day.');
  if (i.occurredAt && Number.isNaN(Date.parse(i.occurredAt))) throw invalid('occurredAt is not a date and time.');
  if (i.occurredAt && Date.parse(i.occurredAt) > Date.now() + 5 * 60_000) throw invalid('An interaction cannot be in the future.');
  if (!(await q.query('SELECT 1 FROM customers WHERE id=$1', [i.customerId])).rows.length) throw notFound('customer', i.customerId);
  if (i.sessionRef) {
    const dup = (await q.query('SELECT * FROM customer_interactions WHERE channel=$1 AND session_ref=$2', [i.channel, i.sessionRef])).rows[0];
    if (dup) return dup;                                  // the telephony or chat system sent it again
  }
  const r = (await q.query(
    `INSERT INTO customer_interactions (customer_id, service_id, channel, direction, subject, summary, agent, session_ref, duration_sec, occurred_at, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()),$11,$12) RETURNING *`,
    [i.customerId, i.serviceId ?? null, i.channel, i.direction, subject, i.summary ?? '', i.agent ?? null, i.sessionRef ?? null, i.durationSec ?? null, i.occurredAt ?? null, JSON.stringify(i.metadata ?? {}), actor])).rows[0]!;
  if (i.caseId) await bindInteractions(q, i.caseId, [r.id], actor);
  return (await q.query('SELECT * FROM customer_interactions WHERE id=$1', [r.id])).rows[0]!;
}

export async function attachInteractions(q: Queryable, caseId: string, interactionIds: string[], actor: string) {
  if (!interactionIds?.length) throw invalid('Choose the interactions to attach.');
  await bindInteractions(q, caseId, interactionIds, actor);
  return getCase(q, caseId);
}

export async function detachInteraction(q: Queryable, interactionId: string, actor: string) {
  const i = (await q.query('SELECT id, case_id FROM customer_interactions WHERE id=$1', [interactionId])).rows[0];
  if (!i) throw notFound('interaction', interactionId);
  if (!i.caseId) throw conflict('This interaction is not attached to a case.');
  await q.query('UPDATE customer_interactions SET case_id=NULL WHERE id=$1', [interactionId]);
  await caseLog(q, i.caseId, actor, 'INTERACTION_DETACHED', { detail: { interactionId } });
  await audit(q, actor, 'interaction', interactionId, 'DETACH', { caseId: i.caseId });
  return { ok: true };
}

/** Opens a case from an interaction in progress: the case gets the interaction's customer, service and channel, and the interaction is attached to it. */
export async function caseFromInteraction(q: Queryable, interactionId: string, c: Omit<NewCase, 'customerId' | 'interactionIds'>, actor: string): Promise<Row> {
  const i = (await q.query('SELECT * FROM customer_interactions WHERE id=$1', [interactionId])).rows[0];
  if (!i) throw notFound('interaction', interactionId);
  if (i.caseId) throw conflict('This interaction is already on a case. Attach more interactions to that case instead.');
  return createCase(q, { ...c, subject: c.subject?.trim() || i.subject, customerId: i.customerId, serviceId: c.serviceId ?? i.serviceId ?? undefined, channel: c.channel ?? i.channel, interactionIds: [interactionId] }, actor);
}

export async function listInteractions(q: Queryable, f: { customerId?: string; caseId?: string; channel?: string; unattached?: boolean; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  if (!f.customerId && !f.caseId) throw invalid('Say whose interactions, or which case.');
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.customerId) where.push(`i.customer_id = ${p(f.customerId)}`);
  if (f.caseId) where.push(`i.case_id = ${p(f.caseId)}`);
  if (f.channel) where.push(`i.channel = ${p(f.channel)}`);
  if (f.unattached) where.push('i.case_id IS NULL');
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(i.occurred_at, i.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT i.*, i.occurred_at::text AS cursor_ts, k.number AS case_number FROM customer_interactions i LEFT JOIN cases k ON k.id = i.case_id
     WHERE ${where.join(' AND ')} ORDER BY i.occurred_at DESC, i.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
}
