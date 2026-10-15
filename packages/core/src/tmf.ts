import { getCase, createCase, transitionCase, addCaseNote, type CaseStatus } from './cases.js';
import type { Queryable, Row } from './db.js';
import { invalid } from './errors.js';
import { INTERACTION_CHANNELS, logInteraction, type InteractionChannel } from './interactions.js';

/**
 * TM Forum Open API views of the case data, so a partner, a portal or an assurance tool can use the standard interfaces instead of Meridian's own:
 *   TMF621 Trouble Ticket Management      a customer's case                       /tmf-api/troubleTicket/v4/troubleTicket
 *   TMF656 Service Problem Management     a network incident (master case)        /tmf-api/serviceProblemManagement/v4/serviceProblem
 *   TMF683 Party Interaction Management   an interaction with a customer          /tmf-api/partyInteractionManagement/v4/partyInteraction
 * (Customer interaction history is TMF683; "Service Problem" is TMF656, which is where network faults grouped across customers belong.) These are profiles, not the
 * whole of each specification: the resources, the attributes below, offset/limit paging with X-Total-Count, `fields` selection, and the status vocabularies.
 */
export const TMF_BASE = '/api/tmf-api';
const SEVERITY_NAME: Record<string, string> = { CRITICAL_OUTAGE: 'Critical', MAJOR_DEGRADATION: 'Major', MINOR_INQUIRY: 'Minor' };
const PRIORITY_NUM: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/** Meridian's lifecycle in TMF621's vocabulary. */
export function ticketStatus(s: string): { status: string; reason?: string } {
  switch (s) {
    case 'NEW': return { status: 'submitted' };
    case 'IN_PROGRESS': case 'REOPENED': return { status: 'inProgress' };
    case 'PENDING_CUSTOMER': return { status: 'pending', reason: 'Waiting for the customer' };
    case 'PENDING_THIRD_PARTY': return { status: 'pending', reason: 'Waiting for a third party' };
    case 'PENDING_DISPATCH': return { status: 'pending', reason: 'Waiting for a field visit to be scheduled' };
    case 'DISPATCHED': return { status: 'pending', reason: 'A technician is booked' };
    case 'RESOLVED': return { status: 'resolved' };
    default: return { status: 'closed' };
  }
}
const PROBLEM_STATUS = (s: string) => ({ NEW: 'submitted', IN_PROGRESS: 'inProgress', REOPENED: 'inProgress', RESOLVED: 'resolved', CLOSED_AUTO: 'closed', CLOSED_VERIFIED: 'closed' } as Record<string, string>)[s] ?? 'pending';

const ref = (base: string, path: string, id: string) => `${base}${TMF_BASE}/${path}/${id}`;

export function toTroubleTicket(c: Row, base = ''): Record<string, unknown> {
  const st = ticketStatus(c.status);
  return {
    id: c.id, href: ref(base, 'troubleTicket/v4/troubleTicket', c.id), name: c.subject, description: c.notes?.[0]?.text ?? c.subject, externalId: c.number,
    severity: SEVERITY_NAME[c.severity] ?? c.severity, priority: PRIORITY_NUM[c.priority] ?? 2, ticketType: c.type === 'FIBER_ASSURANCE' ? 'Fault' : c.type === 'BILLING_REFUND' ? 'Billing' : c.type === 'MNP_PORT_OUT' ? 'Porting' : 'Enquiry',
    status: st.status, ...(st.reason ? { statusChangeReason: st.reason } : {}),
    creationDate: c.createdAt, statusChangeDate: c.updatedAt, ...(c.resolvedAt ? { resolutionDate: c.resolvedAt } : {}), expectedResolutionDate: c.resolutionDue, requestedResolutionDate: c.resolutionDue,
    ...(c.resolution ? { resolution: c.resolution } : {}),
    channel: c.channel ? { name: c.channel } : undefined,
    relatedParty: [
      ...(c.customerId ? [{ role: 'customer', id: c.customerId, name: c.customerName, '@referredType': 'Customer' }] : []),
      ...(c.assignee ? [{ role: 'assignee', id: c.assignee, name: c.assignee, '@referredType': 'Individual' }] : []),
    ],
    relatedEntity: [
      ...(c.serviceId ? [{ role: 'affectedService', '@referredType': 'Service', id: c.serviceId }] : []),
      ...(c.masterCaseId ? [{ role: 'serviceProblem', '@referredType': 'ServiceProblem', id: c.masterCaseId, href: ref(base, 'serviceProblemManagement/v4/serviceProblem', c.masterCaseId) }] : []),
    ],
    note: (c.notes ?? []).map((n: { at: string; by: string; text: string }) => ({ date: n.at, author: n.by, text: n.text })),
    '@type': 'TroubleTicket',
  };
}

export function toServiceProblem(c: Row, base = ''): Record<string, unknown> {
  return {
    id: c.id, href: ref(base, 'serviceProblemManagement/v4/serviceProblem', c.id), name: c.subject, description: c.subject, externalId: c.number, category: 'Network', originatingSystem: 'Meridian',
    priority: PRIORITY_NUM[c.priority] ?? 2, impactImportanceFactor: SEVERITY_NAME[c.severity] ?? c.severity, status: PROBLEM_STATUS(c.status), ...(c.resolution ? { statusChangeReason: c.resolution } : {}),
    firstAlert: c.createdAt, ...(c.resolvedAt ? { resolutionDate: c.resolvedAt } : {}), expectedResolutionDate: c.resolutionDue,
    affectedNumberOfServices: c.childCount ?? undefined, place: c.postalNode ? [{ role: 'affectedArea', '@referredType': 'GeographicAddress', id: c.postalNode, name: c.postalNode }] : [],
    trackingRecord: [], '@type': 'ServiceProblem',
  };
}

export function toPartyInteraction(i: Row, base = ''): Record<string, unknown> {
  return {
    id: i.id, href: ref(base, 'partyInteractionManagement/v4/partyInteraction', i.id), description: i.summary || i.subject, reason: i.subject, direction: String(i.direction).toLowerCase(), status: 'closed',
    channel: { name: i.channel }, interactionDate: { startDateTime: i.occurredAt, ...(i.durationSec ? { endDateTime: new Date(new Date(i.occurredAt).getTime() + i.durationSec * 1000).toISOString() } : {}) },
    relatedParty: [{ role: 'customer', id: i.customerId, '@referredType': 'Customer' }, ...(i.agent ? [{ role: 'agent', id: i.agent, name: i.agent, '@referredType': 'Individual' }] : [])],
    ...(i.caseId ? { relatedEntity: [{ role: 'troubleTicket', '@referredType': 'TroubleTicket', id: i.caseId }] } : {}), externalId: i.sessionRef ?? undefined, '@type': 'PartyInteraction',
  };
}

/** Keeps only the attributes asked for in `fields=` (id and href always stay). */
export function selectFields<T extends Record<string, unknown>>(o: T, fields: string | undefined): Partial<T> {
  if (!fields) return o;
  const want = new Set(['id', 'href', '@type', ...fields.split(',').map((f) => f.trim().split('.')[0]!).filter(Boolean)]);
  return Object.fromEntries(Object.entries(o).filter(([k]) => want.has(k))) as Partial<T>;
}

const TICKET_TYPE_TO_ISSUE: Record<string, string> = { Fault: 'broadband.other.any', Billing: 'billing.other.any', Enquiry: 'general.enquiry.any', Porting: 'porting.out.request' };
const SEVERITY_FROM_NAME: Record<string, string> = { critical: 'CRITICAL_OUTAGE', major: 'MAJOR_DEGRADATION', minor: 'MINOR_INQUIRY' };

const OFFSET_MAX = 10_000;
/** A page of cases by offset and limit, with a total (counted up to 100,001: "more than 100,000" is as precise as a caller can use). */
export async function tmfListCases(q: Queryable, f: { offset: number; limit: number; kind: 'ticket' | 'problem'; status?: string; customerId?: string | null; assignee?: string }): Promise<{ items: Row[]; total: number }> {
  if (!Number.isInteger(f.offset) || f.offset < 0 || f.offset > OFFSET_MAX) throw invalid(`offset is 0 to ${OFFSET_MAX}. Narrow the search to go further.`);
  if (!Number.isInteger(f.limit) || f.limit < 1) throw invalid('limit must be a positive whole number.');
  const limit = Math.min(f.limit, 100);
  const args: unknown[] = [], p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where: string[] = [f.kind === 'problem' ? 'k.is_master' : 'NOT k.is_master'];
  if (f.customerId) where.push(`k.customer_id = ${p(f.customerId)}`);
  if (f.assignee) where.push(`k.assignee = ${p(f.assignee)}`);
  const st = f.status ? ({ submitted: ["'NEW'"], inProgress: ["'IN_PROGRESS'", "'REOPENED'"], pending: ["'PENDING_CUSTOMER'", "'PENDING_THIRD_PARTY'", "'PENDING_DISPATCH'", "'DISPATCHED'"], resolved: ["'RESOLVED'"], closed: ["'CLOSED_AUTO'", "'CLOSED_VERIFIED'"] } as Record<string, string[]>)[f.status] : undefined;
  if (f.status && !st) throw invalid('status is submitted, inProgress, pending, resolved or closed.');
  if (st) where.push(`k.status IN (${st.join(',')})`);
  const w = where.join(' AND ');
  const total = Number((await q.query(`SELECT count(*) AS n FROM (SELECT 1 FROM cases k WHERE ${w} LIMIT 100001) x`, args)).rows[0]!.n);
  const items = (await q.query(`SELECT k.*, c.display_name AS customer_name FROM cases k LEFT JOIN customers c ON c.id = k.customer_id WHERE ${w} ORDER BY k.created_at DESC, k.id DESC OFFSET ${p(f.offset)} LIMIT ${p(limit)}`, args)).rows;
  return { items, total };
}

/** TMF621 create: a customer, a name, an optional description, severity and ticket type. */
export async function tmfCreateTicket(q: Queryable, body: Record<string, any>, actor: string, scopeCustomerId?: string | null) {
  const customer = (Array.isArray(body.relatedParty) ? body.relatedParty : []).find((p: any) => String(p?.role).toLowerCase() === 'customer');
  const customerId = scopeCustomerId ?? customer?.id;
  if (!customerId) throw invalid('relatedParty needs a customer.');
  if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('name is required.');
  const severity = body.severity ? SEVERITY_FROM_NAME[String(body.severity).toLowerCase()] : undefined;
  if (body.severity && !severity) throw invalid('severity is Critical, Major or Minor.');
  const issueTypeId = typeof body['@issueType'] === 'string' ? body['@issueType'] : TICKET_TYPE_TO_ISSUE[String(body.ticketType ?? 'Enquiry')];
  if (!issueTypeId) throw invalid('ticketType is Fault, Billing, Porting or Enquiry.');
  const affected = (Array.isArray(body.relatedEntity) ? body.relatedEntity : []).find((e: any) => String(e?.role).toLowerCase() === 'affectedservice');
  return createCase(q, { customerId, subject: body.name, issueTypeId, severity: severity as never, note: typeof body.description === 'string' ? body.description : undefined, serviceId: affected?.id, channel: 'WEB_SELF_SERVE' }, actor);
}

/** TMF621 patch: a status, a note, or both. */
export async function tmfPatchTicket(q: Queryable, id: string, body: Record<string, any>, actor: string): Promise<Row> {
  const MAP: Record<string, CaseStatus> = { inProgress: 'IN_PROGRESS', pending: 'PENDING_CUSTOMER', resolved: 'RESOLVED', closed: 'CLOSED_VERIFIED' };
  if (body.status !== undefined) {
    const to = MAP[String(body.status)];
    if (!to) throw invalid(`status can be set to ${Object.keys(MAP).join(', ')}.`);
    const why = typeof body.statusChangeReason === 'string' ? body.statusChangeReason : typeof body.resolution === 'string' ? body.resolution : undefined;
    const cur = await getCase(q, id);
    if (cur.status === 'NEW' && to !== 'IN_PROGRESS') await transitionCase(q, id, 'IN_PROGRESS', { actor });
    await transitionCase(q, id, to, { actor, note: why, resolution: why, reason: why });
  }
  for (const n of Array.isArray(body.note) ? body.note : []) if (typeof n?.text === 'string' && n.text.trim()) await addCaseNote(q, id, n.text, actor);
  return getCase(q, id);
}

export async function tmfCreateInteraction(q: Queryable, body: Record<string, any>, actor: string, scopeCustomerId?: string | null) {
  const customer = (Array.isArray(body.relatedParty) ? body.relatedParty : []).find((p: any) => String(p?.role).toLowerCase() === 'customer');
  const customerId = scopeCustomerId ?? customer?.id;
  if (!customerId) throw invalid('relatedParty needs a customer.');
  const channel = String(body.channel?.name ?? '').toUpperCase() as InteractionChannel;
  if (!INTERACTION_CHANNELS.includes(channel)) throw invalid(`channel.name is one of ${INTERACTION_CHANNELS.join(', ')}.`);
  const direction = String(body.direction ?? 'inbound').toUpperCase();
  if (direction !== 'INBOUND' && direction !== 'OUTBOUND') throw invalid('direction is inbound or outbound.');
  const trouble = (Array.isArray(body.relatedEntity) ? body.relatedEntity : []).find((e: any) => e?.['@referredType'] === 'TroubleTicket');
  return logInteraction(q, { customerId, channel, direction: direction as 'INBOUND' | 'OUTBOUND', subject: String(body.reason ?? body.description ?? 'Interaction').slice(0, 200), summary: typeof body.description === 'string' ? body.description : '', caseId: trouble?.id,
    sessionRef: typeof body.externalId === 'string' ? body.externalId : undefined, occurredAt: body.interactionDate?.startDateTime, agent: actor }, actor);
}
