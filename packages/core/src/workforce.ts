import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { ACTIVE_STATUSES, caseLog, getCase, notifyCustomer, transitionCase, type CaseStatus } from './cases.js';
import { getCaseSettings, issueType } from './case-taxonomy.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { wfmVendor, type WfmAddress, type WfmBooking, type WfmConnector, type WfmSlot } from './wfm/index.js';

/**
 * Field service. A case that needs a technician gets a *visit*: the agent asks the field-service system (WFM) which windows a technician with the right skills can
 * come, holds one while still on the call, and turns the hold into a job; the system then reports progress by callback (see wfm-webhook.ts). Meridian keeps
 * one row per visit, moves the case with it (waiting for dispatch → dispatched → resolved, or back to work, or waiting for the customer), and tells the
 * customer on SMS or WhatsApp at each step.
 */
export interface WfmSettings { vendor: string | null; enabled: boolean; configs: Record<string, Record<string, unknown>>; /** Environment variable holding the secret the field-service system signs its callbacks with. */ webhookSecretEnv: string }
const DEFAULT: WfmSettings = { vendor: null, enabled: false, configs: {}, webhookSecretEnv: 'MERIDIAN_WFM_WEBHOOK_SECRET' };
export const WEBHOOK_PATH = '/api/v1/cases/webhooks/wfm-callback';

export async function getWfmSettings(q: Queryable): Promise<WfmSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='wfm'`)).rows[0]?.value ?? {};
  return { ...DEFAULT, ...v, configs: v.configs ?? {} };
}
export async function setWfmSettings(q: Queryable, actor: string, i: { vendor: string | null; enabled: boolean; config?: unknown; webhookSecretEnv?: string }): Promise<WfmSettings> {
  const cur = await getWfmSettings(q);
  if (i.enabled && !i.vendor) throw invalid('Choose the field-service system first.');
  const env = (i.webhookSecretEnv ?? cur.webhookSecretEnv).trim();
  if (!/^MERIDIAN_WFM_[A-Z0-9_]{1,40}$/.test(env)) throw invalid('The webhook secret variable must be named MERIDIAN_WFM_ followed by capitals, digits or underscores.');
  const next: WfmSettings = { vendor: i.vendor, enabled: i.enabled, configs: { ...cur.configs }, webhookSecretEnv: env };
  if (i.vendor) { const v = wfmVendor(i.vendor); next.configs[i.vendor] = v.validate(i.config ?? cur.configs[i.vendor] ?? v.defaults()); }
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('wfm', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'wfm', 'update', { vendor: next.vendor, enabled: next.enabled });
  return next;
}
/** The connector for the chosen system, or null when field service is off. */
export async function activeWfm(q: Queryable, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<WfmConnector | null> {
  const s = await getWfmSettings(q);
  if (!s.enabled || !s.vendor) return null;
  const v = wfmVendor(s.vendor);
  return v.create(v.validate(s.configs[s.vendor] ?? v.defaults()), env, fetchImpl);
}
async function needConnector(q: Queryable, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<WfmConnector> {
  const c = await activeWfm(q, env, fetchImpl);
  if (!c) throw conflict('The field-service system is not connected. An administrator switches it on in Settings → Cases.');
  const problem = c.problem();
  if (problem) throw conflict(`The field-service system cannot be used yet: ${problem}`);
  return c;
}

export async function wfmOverview(q: Queryable, env: NodeJS.ProcessEnv = process.env) {
  const s = await getWfmSettings(q);
  const { WFM_VENDORS } = await import('./wfm/index.js');
  const vendors = Object.values(WFM_VENDORS).map((v) => ({ id: v.id, label: v.label, summary: v.summary, notes: v.notes ?? [], real: v.real, fields: v.fields, defaults: v.defaults(), config: s.configs[v.id] ?? v.defaults() }));
  let problem: string | null = null;
  if (s.vendor) { try { const v = wfmVendor(s.vendor); problem = v.create(v.validate(s.configs[s.vendor] ?? v.defaults()), env).problem(); } catch (e) { problem = (e as Error).message; } }
  const secret = !!(env[s.webhookSecretEnv] ?? '').trim();
  return { vendor: s.vendor, enabled: s.enabled, webhookSecretEnv: s.webhookSecretEnv, webhookSecretSet: secret, callbackPath: WEBHOOK_PATH, vendors, problem };
}
export async function testWfm(q: Queryable, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch) {
  const c = await activeWfm(q, env, fetchImpl);
  if (!c) return { ok: false, detail: 'Field service is switched off.' };
  const p = c.problem(); if (p) return { ok: false, detail: p };
  return c.test ? c.test() : { ok: true, detail: 'No connection test for this system.' };
}

// ───────────────────────── the plan for a case ─────────────────────────
export const ACTIVE_VISIT = ['RESERVED', 'REQUESTED', 'SCHEDULED', 'ASSIGNED', 'EN_ROUTE', 'ON_SITE'];
const ACTIVE_VISIT_SQL = `('${ACTIVE_VISIT.join("','")}')`;

async function plan(q: Queryable, caseId: string) {
  const c = (await q.query('SELECT * FROM cases WHERE id=$1', [caseId])).rows[0];
  if (!c) throw notFound('case', caseId);
  if (c.isMaster || !c.customerId) throw invalid('A network incident has no address to visit: book visits on the customers’ own cases.');
  const cust = (await q.query('SELECT display_name, phone, address FROM customers WHERE id=$1', [c.customerId])).rows[0]!;
  const it = c.issueTypeId ? await issueType(q, c.issueTypeId).catch(() => null) : null;
  const addr = (cust.address ?? {}) as WfmAddress;
  return { c, cust, skills: it?.skills ?? [], equipment: it?.equipment ?? [], needsDispatch: !!it?.needsDispatch, address: addr, issueName: it?.name ?? c.subject };
}
const priorityOf = (sev: string): WfmBooking['priority'] => (sev === 'CRITICAL_OUTAGE' ? 'URGENT' : sev === 'MAJOR_DEGRADATION' ? 'HIGH' : 'NORMAL');

/** The channel to reach the customer on: WhatsApp when they have used it recently, otherwise SMS. */
async function channelOf(q: Queryable, customerId: string): Promise<'WHATSAPP' | 'SMS'> {
  const r = (await q.query(`SELECT 1 FROM customer_interactions WHERE customer_id=$1 AND channel='WHATSAPP' AND occurred_at > now() - interval '90 days' LIMIT 1`, [customerId])).rows[0];
  return r ? 'WHATSAPP' : 'SMS';
}
export async function notifyVisit(q: Queryable, c: Row, instruction: string, message: string, extra: Record<string, unknown> = {}) {
  if (!c.customerId) return;
  await notifyCustomer(q, c, instruction, message, { channel: await channelOf(q, c.customerId), ...extra });
}
const when = (a: Row) => `${new Date(a.slotStart).toISOString().slice(0, 16).replace('T', ' ')}–${new Date(a.slotEnd).toISOString().slice(11, 16)} UTC`;

// ───────────────────────── slots ─────────────────────────
export async function findSlots(q: Queryable, caseId: string, o: { from?: string; to?: string; durationMinutes?: number } = {}, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<{ slots: WfmSlot[]; skills: string[]; equipment: string[] }> {
  const conn = await needConnector(q, env, fetchImpl);
  const p = await plan(q, caseId);
  if (!ACTIVE_STATUSES.includes(p.c.status)) throw rejected('This case is not open.');
  const from = o.from ? new Date(o.from) : new Date(Date.now() + 3_600_000), to = o.to ? new Date(o.to) : new Date(from.getTime() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw invalid('Give a start and an end for the search, the end after the start.');
  if (to.getTime() - from.getTime() > 60 * 86_400_000) throw invalid('Search at most 60 days at a time.');
  const dur = o.durationMinutes ?? 120;
  if (!Number.isInteger(dur) || dur < 15 || dur > 600) throw invalid('A visit lasts 15 to 600 minutes.');
  const booked = Object.fromEntries((await q.query(`SELECT slot_start::text AS s, count(*) AS n FROM workforce_appointments WHERE status IN ${ACTIVE_VISIT_SQL} AND slot_start >= $1 AND slot_start <= $2 GROUP BY slot_start`, [from.toISOString(), to.toISOString()])).rows
    .map((r) => [new Date(r.s).toISOString(), Number(r.n)]));
  const r = await conn.availability({ postalNode: p.c.postalNode, address: p.address, skills: p.skills, equipment: p.equipment, from: from.toISOString(), to: to.toISOString(), durationMinutes: dur, booked });
  if (!r.ok) throw rejected(`The field-service system could not give times: ${r.detail}`);
  return { slots: r.slots, skills: p.skills, equipment: p.equipment };
}

// ───────────────────────── booking ─────────────────────────
export async function holdSlot(q: Queryable, caseId: string, i: { slot: { id: string; start: string; end: string }; notes?: string; replacing?: string }, actor: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Row> {
  const conn = await needConnector(q, env, fetchImpl);
  const p = await plan(q, caseId);
  if (!ACTIVE_STATUSES.includes(p.c.status)) throw rejected('This case is not open.');
  const s = Date.parse(i.slot.start), e = Date.parse(i.slot.end);
  if (!i.slot.id || Number.isNaN(s) || Number.isNaN(e) || e <= s) throw invalid('That is not a valid time slot.');
  if (s < Date.now()) throw invalid('That slot is in the past.');
  const existing = (await q.query(`SELECT id FROM workforce_appointments WHERE case_id=$1 AND status IN ${ACTIVE_VISIT_SQL} AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000')`, [caseId, i.replacing ?? null])).rows[0];
  if (existing) throw conflict('This case already has a visit. Cancel it or reschedule it first.');
  const notes = (i.notes ?? '').slice(0, 1000);
  const id = randomUUID();
  const booking: WfmBooking = { caseId, caseNumber: p.c.number, idempotencyKey: `appt-${id}`, slot: { id: i.slot.id, start: new Date(s).toISOString(), end: new Date(e).toISOString() }, skills: p.skills, equipment: p.equipment,
    address: p.address, customer: { name: p.cust.displayName, phone: p.cust.phone ?? null }, problem: `${p.issueName}: ${p.c.subject}`, notes, priority: priorityOf(p.c.severity) };
  const r = await conn.reserve(booking);
  if (!r.ok) throw rejected(`The slot could not be held: ${r.detail}${r.retryable ? ' Try again in a moment.' : ''}`);
  await q.query(`INSERT INTO workforce_appointments (id, case_id, customer_id, vendor, status, slot_start, slot_end, skills, equipment, address, reservation_ref, notes, hold_expires_at, created_by)
    VALUES ($1,$2,$3,$4,'RESERVED',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, caseId, p.c.customerId, conn.vendor, booking.slot.start, booking.slot.end, p.skills, p.equipment, JSON.stringify(p.address), r.reservationRef, notes, r.expiresAt, actor]);
  await caseLog(q, caseId, actor, 'APPOINTMENT_HELD', { detail: { appointmentId: id, slot: booking.slot.start, expiresAt: r.expiresAt } });
  return getAppointment(q, id);
}

export const getAppointment = async (q: Queryable, id: string): Promise<Row> => {
  const a = (await q.query('SELECT * FROM workforce_appointments WHERE id=$1', [id])).rows[0];
  if (!a) throw notFound('appointment', id);
  return a;
};
export const listAppointments = async (q: Queryable, caseId: string): Promise<Row[]> => (await q.query('SELECT * FROM workforce_appointments WHERE case_id=$1 ORDER BY created_at DESC', [caseId])).rows;

/** Turns a held slot into a job in the field-service system, and moves the case to match. */
export async function confirmAppointment(q: Queryable, appointmentId: string, actor: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Row> {
  const conn = await needConnector(q, env, fetchImpl);
  const a = await getAppointment(q, appointmentId);
  if (a.status !== 'RESERVED') throw conflict(`This visit is already ${String(a.status).replace(/_/g, ' ').toLowerCase()}.`);
  if (a.holdExpiresAt && new Date(a.holdExpiresAt).getTime() < Date.now()) {
    await q.query(`UPDATE workforce_appointments SET status='EXPIRED', updated_at=now() WHERE id=$1 AND status='RESERVED'`, [appointmentId]);
    throw rejected('The hold on this slot ran out. Search for times again.');
  }
  const p = await plan(q, a.caseId);
  const booking: WfmBooking & { reservationRef: string } = { caseId: a.caseId, caseNumber: p.c.number, idempotencyKey: `appt-${a.id}`, slot: { id: '', start: new Date(a.slotStart).toISOString(), end: new Date(a.slotEnd).toISOString() },
    skills: a.skills, equipment: a.equipment, address: a.address, customer: { name: p.cust.displayName, phone: p.cust.phone ?? null }, problem: `${p.issueName}: ${p.c.subject}`, notes: a.notes, priority: priorityOf(p.c.severity), reservationRef: a.reservationRef };
  const r = await conn.confirm(booking);
  if (!r.ok) {
    if (r.retryable) throw rejected(`The field-service system could not be reached: ${r.detail} The slot is still held: try again.`);
    await q.query(`UPDATE workforce_appointments SET status='CANCELLED', outcome_note=$2, updated_at=now() WHERE id=$1`, [appointmentId, r.detail.slice(0, 300)]);
    await conn.cancel({ reservationRef: a.reservationRef, reason: 'Booking refused' }).catch(() => undefined);
    throw rejected(`The field-service system refused the booking: ${r.detail}`);
  }
  const settings = await getCaseSettings(q);
  const status = r.status === 'SCHEDULED' ? 'SCHEDULED' : 'REQUESTED';
  await q.query(
    `UPDATE workforce_appointments SET status=$2, external_ref=$3, technician_ref=$4, technician_name=$5, technician_phone=$6, hold_expires_at=NULL, last_event_rank=$7, updated_at=now() WHERE id=$1`,
    [appointmentId, status, r.jobRef, r.technician?.ref ?? null, r.technician?.name ?? null, r.technician?.phone ?? null, r.status === 'SCHEDULED' ? 1 : 0]);
  await q.query(`UPDATE cases SET dispatch_due_at = $2::timestamptz + make_interval(mins => $3), dispatch_notified_at = NULL, updated_at = now() WHERE id=$1`, [a.caseId, a.slotEnd, settings.dispatchGraceMinutes]);
  await caseLog(q, a.caseId, actor, 'APPOINTMENT_BOOKED', { detail: { appointmentId, jobRef: r.jobRef, status, slot: new Date(a.slotStart).toISOString() } });
  // The case waits for dispatch, and becomes dispatched when the field-service system has a technician on the job.
  const c = await getCase(q, a.caseId);
  if (c.status === 'IN_PROGRESS' || c.status === 'REOPENED' || c.status === 'NEW' || c.status.startsWith('PENDING_')) {
    if (c.status === 'NEW' || c.status === 'REOPENED') await transitionCase(q, a.caseId, 'IN_PROGRESS', { actor });
    if ((await getCase(q, a.caseId)).status !== 'PENDING_DISPATCH') await transitionCase(q, a.caseId, 'PENDING_DISPATCH', { actor, note: `Visit booked for ${when(a)}.` });
  }
  const fresh = await getAppointment(q, appointmentId);
  if (status === 'SCHEDULED') await bringCaseTo(q, a.caseId, 'DISPATCHED', `wfm:${conn.vendor}`, `Technician${fresh.technicianName ? ` ${fresh.technicianName}` : ''} booked for ${when(a)}.`);
  await notifyVisit(q, await getCase(q, a.caseId), 'CASE_VISIT_BOOKED', `Your technician visit for case ${p.c.number} is booked for ${when(a)}. We will tell you when the technician is on the way.`, { appointmentId, window: { start: a.slotStart, end: a.slotEnd } });
  return fresh;
}

/** Holds a slot and confirms it in one go (what the agent's screen does). */
export async function bookVisit(q: Queryable, caseId: string, i: { slot: { id: string; start: string; end: string }; notes?: string; replacing?: string }, actor: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Row> {
  const held = await holdSlot(q, caseId, i, actor, env, fetchImpl);
  return confirmAppointment(q, held.id, actor, env, fetchImpl);
}

export async function cancelAppointment(q: Queryable, appointmentId: string, reason: string, actor: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, o: { keepCase?: boolean; silent?: boolean } = {}): Promise<Row> {
  const a = await getAppointment(q, appointmentId);
  if (!ACTIVE_VISIT.includes(a.status)) throw conflict(`This visit is already ${String(a.status).replace(/_/g, ' ').toLowerCase()}.`);
  if (a.status === 'ON_SITE' || a.status === 'EN_ROUTE') throw rejected('The technician is already on the way or on site. Ask the field-service system to cancel the job.');
  const why = (reason ?? '').trim() || 'Cancelled';
  await q.query(`UPDATE workforce_appointments SET status='CANCELLED', outcome_note=$2, hold_expires_at=NULL, updated_at=now() WHERE id=$1`, [appointmentId, why.slice(0, 300)]);
  const conn = await activeWfm(q, env, fetchImpl).catch(() => null);
  let delivered = false;
  if (conn && (a.externalRef || a.reservationRef)) { const r = await conn.cancel({ jobRef: a.externalRef, reservationRef: a.reservationRef, reason: why }).catch(() => ({ ok: false as const })); delivered = r.ok; }
  if (!delivered && (a.externalRef || a.reservationRef)) await queueWfmCancel(q, a, why);   // the adapter retries until the system has it
  await caseLog(q, a.caseId, actor, 'APPOINTMENT_CANCELLED', { detail: { appointmentId, reason: why, delivered } });
  const c = await getCase(q, a.caseId);
  if (!o.keepCase && (c.status === 'DISPATCHED' || c.status === 'PENDING_DISPATCH')) await transitionCase(q, a.caseId, 'IN_PROGRESS', { actor, note: `Visit cancelled: ${why}` });
  if (!o.silent && a.status !== 'RESERVED') await notifyVisit(q, c, 'CASE_VISIT_CANCELLED', `Your technician visit for case ${c.number} (${when(a)}) has been cancelled. We will be in touch to arrange another.`, { appointmentId });
  return getAppointment(q, appointmentId);
}

/** Tells the field-service system to release a job, through the outbox so it is retried until delivered. */
export const queueWfmCancel = (q: Queryable, a: Row, reason: string) =>
  q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) VALUES ('EVENT', 'WFM_CANCEL', $1)`, [JSON.stringify({ appointmentId: a.id, caseId: a.caseId, vendor: a.vendor, jobRef: a.externalRef, reservationRef: a.reservationRef, reason })]);

/** A new window for a visit: the new one is held and booked first, so a failure leaves the old booking in place. */
export async function rescheduleAppointment(q: Queryable, appointmentId: string, i: { slot: { id: string; start: string; end: string }; notes?: string }, actor: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<Row> {
  const old = await getAppointment(q, appointmentId);
  if (!ACTIVE_VISIT.includes(old.status) && old.status !== 'RESCHEDULE_REQUIRED' && old.status !== 'NO_ACCESS') throw conflict(`This visit is already ${String(old.status).replace(/_/g, ' ').toLowerCase()}.`);
  const fresh = await bookVisit(q, old.caseId, { ...i, replacing: ACTIVE_VISIT.includes(old.status) ? appointmentId : undefined }, actor, env, fetchImpl);
  if (ACTIVE_VISIT.includes(old.status)) await cancelAppointment(q, appointmentId, 'Rescheduled', actor, env, fetchImpl, { keepCase: true, silent: true });
  return fresh;
}

/** Releases holds nobody confirmed. */
export async function releaseExpiredHolds(q: Queryable, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, now = new Date()): Promise<number> {
  const rows = (await q.query(`UPDATE workforce_appointments SET status='EXPIRED', updated_at=now() WHERE status='RESERVED' AND hold_expires_at < $1 RETURNING *`, [now.toISOString()])).rows;
  if (!rows.length) return 0;
  const conn = await activeWfm(q, env, fetchImpl).catch(() => null);
  for (const a of rows) { if (a.reservationRef) { const r = conn ? await conn.cancel({ reservationRef: a.reservationRef, reason: 'Hold expired' }).catch(() => ({ ok: false as const })) : { ok: false as const }; if (!r.ok) await queueWfmCancel(q, a, 'Hold expired'); } }
  return rows.length;
}

/**
 * Moves a case towards a status through the lifecycle, as the field-service system: the steps in between are taken too (a case still waiting for dispatch is
 * dispatched before it is resolved). Returns false when the case is somewhere the move does not apply (an agent already resolved it).
 */
export async function bringCaseTo(q: Queryable, caseId: string, target: CaseStatus, actor: string, note?: string, o: { resolution?: string; silent?: boolean } = {}): Promise<boolean> {
  const PATHS: Partial<Record<CaseStatus, Partial<Record<CaseStatus, CaseStatus[]>>>> = {
    DISPATCHED: { PENDING_DISPATCH: ['DISPATCHED'] },
    RESOLVED: { DISPATCHED: ['RESOLVED'], PENDING_DISPATCH: ['DISPATCHED', 'RESOLVED'] },
    PENDING_CUSTOMER: { DISPATCHED: ['IN_PROGRESS', 'PENDING_CUSTOMER'], PENDING_DISPATCH: ['IN_PROGRESS', 'PENDING_CUSTOMER'] },
    PENDING_DISPATCH: { DISPATCHED: ['PENDING_DISPATCH'] },
    IN_PROGRESS: { DISPATCHED: ['IN_PROGRESS'], PENDING_DISPATCH: ['IN_PROGRESS'] },
  };
  const cur = (await getCase(q, caseId)).status as CaseStatus;
  if (cur === target) return true;
  const steps = PATHS[target]?.[cur];
  if (!steps) return false;
  for (const s of steps) await transitionCase(q, caseId, s, { system: true, actor, note: s === target ? note : undefined, resolution: s === 'RESOLVED' ? o.resolution ?? note : undefined, notify: s === target ? !o.silent : false });
  return true;
}

/** When a fault case that normally needs a technician breaches its SLA, ask for the earliest slot. Never throws: a field-service outage must not stop the watchdog. */
export async function maybeAutoDispatch(q: Queryable, c: Row, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    if (!(await getCaseSettings(q)).autoDispatch || c.isMaster || !c.issueTypeId || !(await activeWfm(q, env, fetchImpl))) return false;
    const it = await issueType(q, c.issueTypeId).catch(() => null);
    if (!it?.needsDispatch) return false;
    if ((await q.query(`SELECT 1 FROM workforce_appointments WHERE case_id=$1 AND status IN ${ACTIVE_VISIT_SQL}`, [c.id])).rows.length) return false;
    const { slots } = await findSlots(q, c.id, {}, env, fetchImpl);
    const first = slots[0];
    if (!first) { await caseLog(q, c.id, 'system', 'AUTO_DISPATCH_FAILED', { detail: { reason: 'No slots are available in the next 14 days.' } }); return false; }
    await bookVisit(q, c.id, { slot: first, notes: 'Booked automatically after the SLA was breached.' }, 'system', env, fetchImpl);
    return true;
  } catch (e) { await caseLog(q, c.id, 'system', 'AUTO_DISPATCH_FAILED', { detail: { reason: (e as Error).message } }).catch(() => undefined); return false; }
}

/** Cancels the booked visits of a set of cases at once (their cases were resolved by a network incident): in the database now, at the field-service system through the outbox. */
export async function cancelVisitsOfCases(q: Queryable, caseIds: string[], reason: string): Promise<number> {
  if (!caseIds.length) return 0;
  const rows = (await q.query(`UPDATE workforce_appointments SET status='CANCELLED', outcome_note=$2, hold_expires_at=NULL, updated_at=now() WHERE case_id = ANY($1::uuid[]) AND status IN ('RESERVED','REQUESTED','SCHEDULED','ASSIGNED') RETURNING id, case_id, vendor, external_ref, reservation_ref`, [caseIds, reason])).rows;
  if (rows.length) {
    await q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) SELECT 'EVENT', 'WFM_CANCEL', jsonb_build_object('appointmentId', a.id, 'caseId', a.case_id, 'vendor', a.vendor, 'jobRef', a.external_ref, 'reservationRef', a.reservation_ref, 'reason', $2::text)
      FROM workforce_appointments a WHERE a.id = ANY($1::uuid[]) AND (a.external_ref IS NOT NULL OR a.reservation_ref IS NOT NULL)`, [rows.map((r) => r.id), reason]);
    await q.query(`INSERT INTO case_audit_log (case_id, actor, action, detail) SELECT case_id, 'system', 'APPOINTMENT_CANCELLED', jsonb_build_object('reason', $2::text, 'appointmentId', id) FROM workforce_appointments WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id), reason]);
  }
  return rows.length;
}
