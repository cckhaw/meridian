import { createHmac, timingSafeEqual } from 'node:crypto';
import { caseLog, getCase } from './cases.js';
import type { Db, Queryable, Row } from './db.js';
import { DomainError, invalid } from './errors.js';
import { bringCaseTo, notifyVisit } from './workforce.js';
import { advanceOrderTx } from './orders.js';

/**
 * What the field-service system tells us, and what we do about it. The system calls one URL (`/api/v1/cases/webhooks/wfm-callback`) with a JSON body and a signature
 * header, `X-WFM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, made with the shared secret. A request with a bad or stale signature is refused and
 * nothing is stored. A good one is written to the event log once per event id, so a repeated delivery changes nothing, and is then applied to the visit and its case.
 */
export const WFM_EVENT_TYPES = ['JOB_ACCEPTED', 'ASSIGNED', 'EN_ROUTE', 'ON_SITE', 'JOB_COMPLETED', 'CUSTOMER_NOT_AT_HOME', 'RE_SCHEDULING_REQUIRED', 'JOB_CANCELLED'] as const;
export type WfmEventType = (typeof WFM_EVENT_TYPES)[number];
/** How far a visit has got: a callback that is no further than the visit already is (late, or repeated under another id) changes nothing. Ends are 9. */
const RANK: Record<WfmEventType, number> = { JOB_ACCEPTED: 1, ASSIGNED: 1, EN_ROUTE: 2, ON_SITE: 3, JOB_COMPLETED: 9, CUSTOMER_NOT_AT_HOME: 9, RE_SCHEDULING_REQUIRED: 9, JOB_CANCELLED: 9 };
const ENDED = ['COMPLETED', 'NO_ACCESS', 'RESCHEDULE_REQUIRED', 'CANCELLED', 'EXPIRED'];
const TOLERANCE_S = 300;
export const MAX_BODY = 256 * 1024;

export const wfmSignature = (raw: string, secret: string, at = Date.now()) => { const t = Math.floor(at / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`; };

/** Checks the signature header against the raw body. Throws UNAUTHENTICATED on anything wrong: no detail is given about which part. */
export function verifyWfmSignature(raw: string, header: string | null | undefined, secret: string, now = Date.now()): void {
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const bad = () => new DomainError('UNAUTHENTICATED', 'invalid signature');
  if (!secret || !t || !parts.v1 || !/^[0-9a-f]{64}$/i.test(parts.v1) || Math.abs(now / 1000 - t) > TOLERANCE_S) throw bad();
  const want = createHmac('sha256', secret).update(`${t}.${raw}`).digest();
  const got = Buffer.from(parts.v1, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad();
}

export interface WfmEvent { eventId: string; type: WfmEventType; jobRef: string; occurredAt: string | null; technician: { ref?: string; name?: string; phone?: string } | null; notes: string | null; reason: string | null; newWindow: { start: string; end: string } | null; eta: string | null }

export function parseWfmEvent(raw: string): WfmEvent {
  if (raw.length > MAX_BODY) throw invalid('The callback is too large.');
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { throw invalid('The callback is not JSON.'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw invalid('The callback must be a JSON object.');
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const eventId = str(j.eventId, 200), jobRef = str(j.jobRef ?? j.jobId, 200), type = String(j.type ?? '').toUpperCase();
  if (!eventId) throw invalid('The callback needs an eventId.');
  if (!jobRef) throw invalid('The callback needs the jobRef.');
  if (!(WFM_EVENT_TYPES as readonly string[]).includes(type)) throw invalid(`Unknown event type. Known: ${WFM_EVENT_TYPES.join(', ')}.`);
  const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const t = j.technician && typeof j.technician === 'object' ? (j.technician as Record<string, unknown>) : null;
  const w = j.newWindow && typeof j.newWindow === 'object' ? (j.newWindow as Record<string, unknown>) : null;
  const nw = w && date(w.start) && date(w.end) ? { start: date(w.start)!, end: date(w.end)! } : null;
  return { eventId, type: type as WfmEventType, jobRef, occurredAt: date(j.occurredAt), technician: t ? { ref: str(t.ref ?? t.id, 100) ?? undefined, name: str(t.name, 100) ?? undefined, phone: str(t.phone, 40) ?? undefined } : null,
    notes: str(j.notes, 2000), reason: str(j.reason, 500), newWindow: nw, eta: date(j.eta) };
}

export type WfmOutcome = { status: 'APPLIED' | 'IGNORED' | 'DUPLICATE' | 'UNKNOWN_JOB' | 'FAILED'; detail: string; caseId?: string };
const SOURCE = 'wfm';
const clock = (v: string) => new Date(v).toISOString().slice(11, 16);

/** Applies one verified event. Idempotent by event id; a failure is recorded and the event can be delivered again. */
export async function processWfmEvent(db: Db, ev: WfmEvent, payload: unknown): Promise<WfmOutcome> {
  const claimed = (await db.query(
    `INSERT INTO webhook_event_log (source, event_id, event_type, external_ref, payload) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (source, event_id) DO UPDATE SET status = 'RECEIVED', received_at = now() WHERE webhook_event_log.status IN ('FAILED','UNKNOWN_JOB') RETURNING id`,
    [SOURCE, ev.eventId, ev.type, ev.jobRef, JSON.stringify(payload)])).rows[0];
  if (!claimed) return { status: 'DUPLICATE', detail: 'This event was already handled.' };
  const finish = (o: WfmOutcome) => db.query(`UPDATE webhook_event_log SET status=$2, detail=$3, case_id=$4, processed_at=now() WHERE id=$1`, [claimed.id, o.status, o.detail.slice(0, 500), o.caseId ?? null]).then(() => o);
  try {
    const out = await db.tx((q) => apply(q, ev));
    return await finish(out);
  } catch (e) {
    return finish({ status: 'FAILED', detail: (e as Error).message });
  }
}

async function apply(q: Queryable, ev: WfmEvent): Promise<WfmOutcome> {
  const a = (await q.query(`SELECT * FROM workforce_appointments WHERE external_ref=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [ev.jobRef])).rows[0] as Row | undefined;
  if (!a) return { status: 'UNKNOWN_JOB', detail: `No visit has job number ${ev.jobRef}.` };
  const caseId = a.caseId as string;
  const rank = RANK[ev.type];
  if (ENDED.includes(a.status)) return { status: 'IGNORED', detail: `The visit already ended (${String(a.status).toLowerCase().replace(/_/g, ' ')}).`, caseId };
  if (rank < 9 && rank <= a.lastEventRank) return { status: 'IGNORED', detail: 'The visit is already further along than this event says.', caseId };
  if (ev.occurredAt && a.lastEventAt && Date.parse(ev.occurredAt) < new Date(a.lastEventAt).getTime() && rank <= a.lastEventRank) return { status: 'IGNORED', detail: 'An older event than one already applied.', caseId };
  const by = `wfm:${a.vendor}`;
  const c = await getCase(q, caseId);
  const setAppt = (status: string, extra: Record<string, unknown> = {}) => {
    const cols = ['status = $2', 'last_event_rank = GREATEST(last_event_rank, $3)', `last_event_at = COALESCE($4::timestamptz, now())`, 'updated_at = now()'];
    const args: unknown[] = [a.id, status, rank === 9 ? 9 : rank, ev.occurredAt];
    for (const [k, v] of Object.entries(extra)) { args.push(v); cols.push(`${k} = $${args.length}`); }
    return q.query(`UPDATE workforce_appointments SET ${cols.join(', ')} WHERE id = $1`, args);
  };
  const tech = ev.technician;
  const techCols = tech ? { technician_ref: tech.ref ?? a.technicianRef, technician_name: tech.name ?? a.technicianName, technician_phone: tech.phone ?? a.technicianPhone } : {};
  const who = tech?.name ?? a.technicianName ?? 'Your technician';
  const win = `${clock(a.slotStart)}–${clock(a.slotEnd)} UTC`;
  let detail = '';
  switch (ev.type) {
    case 'JOB_ACCEPTED': case 'ASSIGNED': {
      await setAppt('ASSIGNED', techCols);
      const moved = await bringCaseTo(q, caseId, 'DISPATCHED', by, `Technician${tech?.name ? ` ${tech.name}` : ''} assigned.`);
      detail = moved ? 'Technician assigned; the case is dispatched.' : 'Technician assigned.';
      await notifyVisit(q, c, 'CASE_VISIT_ASSIGNED', `${who} has been assigned to your visit for case ${c.number} (${win}).`, { appointmentId: a.id });
      break;
    }
    case 'EN_ROUTE': {
      await setAppt('EN_ROUTE', techCols);
      await bringCaseTo(q, caseId, 'DISPATCHED', by, 'Technician on the way.', { silent: true });
      await notifyVisit(q, c, 'CASE_VISIT_EN_ROUTE', `${who} is on the way for case ${c.number}${ev.eta ? `, arriving about ${clock(ev.eta)} UTC` : ''}.`, { appointmentId: a.id, eta: ev.eta });
      detail = 'Technician on the way.';
      break;
    }
    case 'ON_SITE': {
      await setAppt('ON_SITE', techCols);
      await bringCaseTo(q, caseId, 'DISPATCHED', by, 'Technician on site.', { silent: true });
      await notifyVisit(q, c, 'CASE_VISIT_ON_SITE', `${who} has arrived for case ${c.number}.`, { appointmentId: a.id });
      detail = 'Technician on site.';
      break;
    }
    case 'JOB_COMPLETED': {
      await setAppt('COMPLETED', { ...techCols, outcome_note: ev.notes });
      const moved = await bringCaseTo(q, caseId, 'RESOLVED', by, undefined, { resolution: `Field visit completed${ev.notes ? `: ${ev.notes}` : '.'}` });
      detail = moved ? 'Visit completed; the case is resolved.' : 'Visit completed; the case was no longer waiting on it.';
      break;
    }
    case 'CUSTOMER_NOT_AT_HOME': {
      await setAppt('NO_ACCESS', { ...techCols, outcome_note: ev.notes ?? 'The customer was not at home.' });
      const moved = await bringCaseTo(q, caseId, 'PENDING_CUSTOMER', by, 'The technician could not get in: the customer was not at home. A new time is needed.', { silent: true });
      await notifyVisit(q, c, 'CASE_VISIT_NO_ACCESS', `Our technician called for case ${c.number} but could not get in. Please contact us to arrange another time.`, { appointmentId: a.id });
      detail = moved ? 'Customer not at home; the case now waits for the customer.' : 'Customer not at home.';
      break;
    }
    case 'RE_SCHEDULING_REQUIRED': {
      await setAppt('RESCHEDULE_REQUIRED', { ...techCols, outcome_note: ev.reason ?? ev.notes ?? 'The field-service system asks for another time.' });
      const moved = await bringCaseTo(q, caseId, 'PENDING_DISPATCH', by, `The visit needs another time${ev.reason ? `: ${ev.reason}` : ''}.`, { silent: true });
      await q.query(`UPDATE cases SET dispatch_due_at = now() + interval '4 hours', dispatch_notified_at = NULL WHERE id=$1 AND status='PENDING_DISPATCH'`, [caseId]);
      await notifyVisit(q, c, 'CASE_VISIT_RESCHEDULE', `Your technician visit for case ${c.number} needs another time${ev.newWindow ? `; the new suggestion is ${clock(ev.newWindow.start)}–${clock(ev.newWindow.end)} UTC on ${ev.newWindow.start.slice(0, 10)}` : ''}. We will be in touch to confirm.`, { appointmentId: a.id, newWindow: ev.newWindow });
      detail = moved ? 'Rescheduling required; the case waits for dispatch again.' : 'Rescheduling required.';
      break;
    }
    case 'JOB_CANCELLED': {
      await setAppt('CANCELLED', { outcome_note: ev.reason ?? ev.notes ?? 'Cancelled by the field-service system.' });
      const moved = await bringCaseTo(q, caseId, 'IN_PROGRESS', by, `The field-service system cancelled the visit${ev.reason ? `: ${ev.reason}` : ''}.`, { silent: true });
      detail = moved ? 'Job cancelled; the case is back with the agent.' : 'Job cancelled.';
      break;
    }
  }
  if (c.orderId) await followOrder(q, c.orderId, ev, by);
  await caseLog(q, caseId, by, 'WFM_EVENT', { detail: { type: ev.type, eventId: ev.eventId, jobRef: ev.jobRef, appointmentId: a.id } });
  return { status: 'APPLIED', detail, caseId };
}

/** An installation case's visit drives its order: once the technician is on the way the installation can no longer be cancelled, and a finished visit finishes the installation. */
async function followOrder(q: Queryable, orderId: string, ev: WfmEvent, by: string) {
  const move = async (type: 'dispatch_technician' | 'complete_installation') => { try { await advanceOrderTx(q, orderId, { type }, by); } catch { /* already past this step, or the order has ended */ } };
  if (ev.type === 'EN_ROUTE' || ev.type === 'ON_SITE') await move('dispatch_technician');
  if (ev.type === 'JOB_COMPLETED') { await move('dispatch_technician'); await move('complete_installation'); }
}

export async function listWebhookEvents(q: Queryable, f: { caseId?: string; limit?: number } = {}): Promise<Row[]> {
  return (await q.query(`SELECT id, source, event_id, event_type, external_ref, case_id, status, detail, received_at, processed_at FROM webhook_event_log ${f.caseId ? 'WHERE case_id = $2' : ''} ORDER BY id DESC LIMIT $1`, f.caseId ? [Math.min(f.limit ?? 50, 200), f.caseId] : [Math.min(f.limit ?? 50, 200)])).rows;
}
