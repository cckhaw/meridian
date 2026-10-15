import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMasterIncident } from './case-incidents.js';
import { fireDueCaseTimers, sweepCaseSla } from './case-sla.js';
import { setCaseSettings } from './case-taxonomy.js';
import { createCase, getCase, transitionCase } from './cases.js';
import type { Db } from './db.js';
import { logInteraction } from './interactions.js';
import { cancelAppointment, confirmAppointment, findSlots, getWfmSettings, holdSlot, listAppointments, rescheduleAppointment, setWfmSettings, bookVisit, testWfm } from './workforce.js';
import { parseWfmEvent, processWfmEvent, verifyWfmSignature, wfmSignature, listWebhookEvents } from './wfm-webhook.js';
import { createWfmRestConnector, wfmVendor } from './wfm/index.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

let n = 0;
const use = (mode = 'OK', capacity = 2) => setWfmSettings(db, 'root', { vendor: 'simulator', enabled: true, config: { mode, capacity } });
const fault = async (o: { postalNode?: string; issueTypeId?: string } = {}) => {
  const k = (await newCustomer(db, { address: { line1: '1 Road', postcode: o.postalNode ?? `P${++n}` }, phone: '+6591112222' } as never)).customer;
  const c = await createCase(db, { customerId: k.id, issueTypeId: o.issueTypeId ?? 'broadband.down.los', subject: 'No signal' }, 'agent1');
  await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent1' });
  return { k, c };
};
const outbox = async (caseId: string) => (await db.query(`SELECT instruction, payload FROM lifecycle_outbox WHERE payload->>'caseId'=$1 ORDER BY id`, [caseId])).rows as Array<{ instruction: string; payload: Record<string, any> }>;
const status = async (id: string) => (await getCase(db, id)).status as string;
const event = (jobRef: string, type: string, extra: Record<string, unknown> = {}) => { const e = { eventId: `e-${++n}`, jobRef, type, occurredAt: new Date().toISOString(), ...extra }; return { ev: parseWfmEvent(JSON.stringify(e)), raw: e }; };
const send = (jobRef: string, type: string, extra: Record<string, unknown> = {}) => { const { ev, raw } = event(jobRef, type, extra); return processWfmEvent(db, ev, raw); };
const firstSlot = async (caseId: string) => (await findSlots(db, caseId)).slots[0]!;

describe('connectors', () => {
  it('validates field-service settings and keeps each system’s settings apart', async () => {
    await expect(setWfmSettings(db, 'root', { vendor: null, enabled: true })).rejects.toThrow(/Choose/);
    await expect(setWfmSettings(db, 'root', { vendor: 'rest', enabled: true, config: { baseUrl: 'http://wfm.example.com', auth: 'NONE' } })).rejects.toThrow(/https/);
    await expect(setWfmSettings(db, 'root', { vendor: 'rest', enabled: true, config: { baseUrl: 'https://wfm.example.com', auth: 'BEARER', tokenEnv: 'SECRET' } })).rejects.toThrow(/MERIDIAN_WFM_/);
    await expect(setWfmSettings(db, 'root', { vendor: 'simulator', enabled: true, config: { mode: 'BAD' } })).rejects.toThrow(/simulator/);
    await expect(setWfmSettings(db, 'root', { vendor: 'simulator', enabled: true, webhookSecretEnv: 'OTHER' })).rejects.toThrow(/MERIDIAN_WFM_/);
    const s = await setWfmSettings(db, 'root', { vendor: 'rest', enabled: false, config: { baseUrl: 'https://wfm.example.com/api/', auth: 'BEARER', tokenEnv: 'MERIDIAN_WFM_TOKEN' } });
    expect(s.configs.rest!.baseUrl).toBe('https://wfm.example.com/api');
    await use();
    expect((await getWfmSettings(db)).configs.rest).toBeTruthy();
    expect((await testWfm(db)).ok).toBe(true);
  });

  it('the simulator offers weekday slots, never full ones, and the REST connector speaks the contract and refuses nonsense', async () => {
    const sim = wfmVendor('simulator').create({ mode: 'OK', capacity: 1 });
    const q = { postalNode: 'X', address: {}, skills: [], equipment: [], from: '2026-10-12T00:00:00Z', to: '2026-10-18T23:00:00Z', durationMinutes: 120, booked: {} };
    const a = await sim.availability(q);
    if (!a.ok) throw new Error('no slots');
    expect(a.slots.length).toBe(10);                                          // Mon–Fri, two a day, no weekend
    expect(a.slots.every((s) => ![0, 6].includes(new Date(s.start).getUTCDay()))).toBe(true);
    const b = await sim.availability({ ...q, booked: { [a.slots[0]!.start]: 1 } });
    expect(b.ok && b.slots.length).toBe(9);
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls.push({ url, body, auth: (init.headers as Record<string, string>).authorization ?? null });
      if (url.endsWith('/availability')) return new Response(JSON.stringify({ slots: [{ id: 's1', start: '2026-10-13T09:00:00Z', end: '2026-10-13T12:00:00Z', capacityLeft: 2 }, { id: 's2', start: 'bad', end: 'bad' }, { id: 's3', start: '2026-10-13T13:00:00Z', end: '2026-10-13T17:00:00Z', capacityLeft: 0 }] }));
      if (url.endsWith('/reservations')) return new Response(JSON.stringify({ reservationRef: 'R-1', expiresAt: '2030-01-01T00:00:00Z' }));
      if (url.endsWith('/jobs')) return new Response(JSON.stringify({ jobRef: 'J-1', status: 'REQUESTED' }));
      return new Response('slot taken', { status: 409 });
    }) as unknown as typeof fetch;
    const rest = createWfmRestConnector({ baseUrl: 'https://wfm.example.com', auth: 'BEARER', tokenEnv: 'MERIDIAN_WFM_TOKEN', timeoutMs: 5000 }, { MERIDIAN_WFM_TOKEN: 'tok' }, fetchImpl);
    expect(rest.problem()).toBeNull();
    expect(createWfmRestConnector({ baseUrl: 'https://wfm.example.com', auth: 'BEARER', tokenEnv: 'MERIDIAN_WFM_TOKEN', timeoutMs: 5000 }, {}, fetchImpl).problem()).toMatch(/not set/);
    const av = await rest.availability(q);
    expect(av.ok && av.slots.map((s) => s.id)).toEqual(['s1']);              // the bad slot and the full one are dropped
    expect(calls[0]!.auth).toBe('Bearer tok'); expect(calls[0]!.body.booked).toBeUndefined();
    const booking = { caseId: 'c', caseNumber: 'CS-1', idempotencyKey: 'k', slot: { id: 's1', start: 'a', end: 'b' }, skills: [], equipment: [], address: {}, customer: { name: 'x', phone: null }, problem: 'p', notes: '', priority: 'NORMAL' as const };
    expect(await rest.reserve(booking)).toMatchObject({ ok: true, reservationRef: 'R-1' });
    expect(await rest.confirm({ ...booking, reservationRef: 'R-1' })).toMatchObject({ ok: true, jobRef: 'J-1', status: 'REQUESTED' });
    expect(await rest.cancel({ jobRef: 'J-1', reason: 'x' })).toMatchObject({ ok: false, retryable: false });
  });
});

describe('booking a visit', () => {
  it('finds slots by the issue’s skills, holds one, confirms it, and moves the case with it', async () => {
    await use('OK', 2);
    const { c } = await fault();
    const r = await findSlots(db, c.id);
    expect([r.skills, r.equipment]).toEqual([['FIBER_SPLICING'], ['ONT_UNIT']]);
    expect(r.slots.length).toBeGreaterThan(5);
    const held = await holdSlot(db, c.id, { slot: r.slots[0]! }, 'agent1');
    expect([held.status, held.skills]).toEqual(['RESERVED', ['FIBER_SPLICING']]);
    await expect(holdSlot(db, c.id, { slot: r.slots[1]! }, 'agent1')).rejects.toThrow(/already has a visit/);
    const done = await confirmAppointment(db, held.id, 'agent1');
    expect([done.status, done.technicianName, !!done.externalRef]).toEqual(['SCHEDULED', 'Sim Technician', true]);
    const k = await getCase(db, c.id);
    expect(k.status).toBe('DISPATCHED');
    expect(new Date(k.dispatchDueAt).getTime()).toBe(new Date(done.slotEnd).getTime() + 60 * 60_000);
    const msgs = await outbox(c.id);
    expect(msgs.map((m) => m.instruction)).toContain('CASE_VISIT_BOOKED');
    expect(msgs.find((m) => m.instruction === 'CASE_VISIT_BOOKED')!.payload.channel).toBe('SMS');
    await expect(confirmAppointment(db, held.id, 'agent1')).rejects.toThrow(/already scheduled/);
  });

  it('writes to the customer on WhatsApp when they use it', async () => {
    await use();
    const { k, c } = await fault();
    await logInteraction(db, { customerId: k.id, channel: 'WHATSAPP', direction: 'INBOUND', subject: 'hi' }, 'a');
    await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    expect((await outbox(c.id)).find((m) => m.instruction === 'CASE_VISIT_BOOKED')!.payload.channel).toBe('WHATSAPP');
  });

  it('a full slot is no longer offered, and a hold nobody confirms is released', async () => {
    await use('OK', 1);
    const a = await fault(), b = await fault();
    const slot = await firstSlot(a.c.id);
    await bookVisit(db, a.c.id, { slot }, 'agent1');
    expect((await findSlots(db, b.c.id)).slots.map((s) => s.start)).not.toContain(slot.start);
    const held = await holdSlot(db, b.c.id, { slot: await firstSlot(b.c.id) }, 'agent1');
    await db.query(`UPDATE workforce_appointments SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [held.id]);
    await expect(confirmAppointment(db, held.id, 'agent1')).rejects.toThrow(/ran out/);
    expect((await listAppointments(db, b.c.id))[0]!.status).toBe('EXPIRED');
    const c2 = await holdSlot(db, b.c.id, { slot: await firstSlot(b.c.id) }, 'agent1');
    await db.query(`UPDATE workforce_appointments SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [c2.id]);
    expect((await sweepCaseSla(db)).holdsReleased).toBeGreaterThanOrEqual(1);
    await use('OK', 2);
  });

  it('refuses when the system is off or refuses, and asynchronous confirmation waits for the callback', async () => {
    await setWfmSettings(db, 'root', { vendor: 'simulator', enabled: false });
    const { c } = await fault();
    await expect(findSlots(db, c.id)).rejects.toThrow(/not connected/);
    await use('FAIL');
    await expect(findSlots(db, c.id)).rejects.toThrow(/could not give times/);
    await use('ASYNC');
    const v = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    expect(v.status).toBe('REQUESTED');
    expect(await status(c.id)).toBe('PENDING_DISPATCH');
    const assigned = await send(v.externalRef, 'ASSIGNED', { technician: { name: 'Tan', phone: '+6598765432' } });
    expect(assigned.status).toBe('APPLIED');
    expect(await status(c.id)).toBe('DISPATCHED');
    expect((await listAppointments(db, c.id))[0]).toMatchObject({ status: 'ASSIGNED', technicianName: 'Tan' });
    await use('OK');
  });

  it('cancelling releases the visit and puts the case back to work; rescheduling keeps the old booking if the new one fails', async () => {
    await use('OK');
    const { c } = await fault();
    const v = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    expect((await cancelAppointment(db, v.id, 'Customer asked', 'agent1')).status).toBe('CANCELLED');
    expect(await status(c.id)).toBe('IN_PROGRESS');
    expect((await outbox(c.id)).map((m) => m.instruction)).toContain('CASE_VISIT_CANCELLED');
    await expect(cancelAppointment(db, v.id, 'again', 'agent1')).rejects.toThrow(/already cancelled/);
    const v2 = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    const slots = (await findSlots(db, c.id, { from: new Date(Date.now() + 7 * 86_400_000).toISOString() })).slots;
    const moved = await rescheduleAppointment(db, v2.id, { slot: slots[0]! }, 'agent1');
    expect([moved.status, (await listAppointments(db, c.id)).find((a) => a.id === v2.id)!.status]).toEqual(['SCHEDULED', 'CANCELLED']);
    await use('FAIL');
    await expect(rescheduleAppointment(db, moved.id, { slot: slots[1]! }, 'agent1')).rejects.toThrow();
    expect((await listAppointments(db, c.id)).find((a) => a.id === moved.id)!.status).toBe('SCHEDULED');
    await use('OK');
  });
});

describe('callback signature', () => {
  const secret = 's3cret', raw = JSON.stringify({ eventId: 'x', type: 'EN_ROUTE', jobRef: 'J' });
  it('accepts a good signature and refuses everything else without saying why', () => {
    expect(() => verifyWfmSignature(raw, wfmSignature(raw, secret), secret)).not.toThrow();
    for (const [h, s] of [[wfmSignature(raw, 'wrong'), secret], [wfmSignature(raw + ' ', secret), secret], [wfmSignature(raw, secret, Date.now() - 10 * 60_000), secret], [null, secret], ['v1=abc', secret], [wfmSignature(raw, secret), '']] as const)
      expect(() => verifyWfmSignature(raw, h, s)).toThrow(/invalid signature/);
  });
  it('validates the body', () => {
    expect(() => parseWfmEvent('nope')).toThrow(/JSON/);
    expect(() => parseWfmEvent('[]')).toThrow(/object/);
    expect(() => parseWfmEvent(JSON.stringify({ type: 'EN_ROUTE', jobRef: 'J' }))).toThrow(/eventId/);
    expect(() => parseWfmEvent(JSON.stringify({ eventId: 'e', type: 'EN_ROUTE' }))).toThrow(/jobRef/);
    expect(() => parseWfmEvent(JSON.stringify({ eventId: 'e', type: 'TELEPORTED', jobRef: 'J' }))).toThrow(/Unknown event type/);
    expect(parseWfmEvent(JSON.stringify({ eventId: 'e', type: 'en_route', jobId: 'J', technician: { id: 't1', name: 'Tan' }, eta: '2026-10-13T09:30:00Z' }))).toMatchObject({ type: 'EN_ROUTE', jobRef: 'J', technician: { ref: 't1', name: 'Tan' }, eta: '2026-10-13T09:30:00.000Z' });
  });
});

describe('field callbacks', () => {
  it('follows a visit from assignment to completion: the case is dispatched, then resolved, and the customer hears each step once', async () => {
    await use('OK');
    const { c } = await fault();
    const v = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    const en = event(v.externalRef, 'EN_ROUTE', { technician: { name: 'Lee' }, eta: new Date(Date.now() + 1800_000).toISOString() });
    expect((await processWfmEvent(db, en.ev, en.raw)).status).toBe('APPLIED');
    expect((await processWfmEvent(db, en.ev, en.raw)).status).toBe('DUPLICATE');             // the same delivery again changes nothing
    expect((await send(v.externalRef, 'ASSIGNED')).status).toBe('IGNORED');                  // earlier than where the visit is
    expect((await send(v.externalRef, 'ON_SITE')).status).toBe('APPLIED');
    const done = await send(v.externalRef, 'JOB_COMPLETED', { notes: 'Replaced the ONT and re-spliced the drop' });
    expect(done).toMatchObject({ status: 'APPLIED', caseId: c.id });
    const k = await getCase(db, c.id);
    expect([k.status, k.resolution, k.dispatchDueAt]).toEqual(['RESOLVED', 'Field visit completed: Replaced the ONT and re-spliced the drop', null]);
    expect((await listAppointments(db, c.id))[0]).toMatchObject({ status: 'COMPLETED', outcomeNote: 'Replaced the ONT and re-spliced the drop' });
    expect((await send(v.externalRef, 'EN_ROUTE')).status).toBe('IGNORED');                  // a late callback after the end
    const m = (await outbox(c.id)).map((x) => x.instruction);
    expect(m.filter((x) => x === 'CASE_VISIT_EN_ROUTE')).toHaveLength(1);
    expect(m).toEqual(expect.arrayContaining(['CASE_VISIT_BOOKED', 'CASE_VISIT_ON_SITE', 'CASE_RESOLVED']));
    expect(m.filter((x) => x === 'CASE_RESOLVED')).toHaveLength(1);                           // one resolved message, not two
    const log = await listWebhookEvents(db, { caseId: c.id });
    expect(log.map((l) => l.status)).toEqual(expect.arrayContaining(['APPLIED', 'IGNORED']));
  });

  it('the customer not being at home sends the case to waiting for the customer; the case’s SLA clock pauses', async () => {
    await use('OK');
    const { c } = await fault();
    const v = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    expect((await send(v.externalRef, 'CUSTOMER_NOT_AT_HOME', { notes: 'Nobody answered' })).status).toBe('APPLIED');
    const k = await getCase(db, c.id);
    expect([k.status, !!k.slaPausedAt]).toEqual(['PENDING_CUSTOMER', true]);
    expect((await listAppointments(db, c.id))[0]!.status).toBe('NO_ACCESS');
    expect((await outbox(c.id)).map((x) => x.instruction)).toContain('CASE_VISIT_NO_ACCESS');
    // the agent can book again once the customer is reached
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent1' });
    expect((await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1')).status).toBe('SCHEDULED');
  });

  it('a rescheduling request puts the case back to waiting for dispatch; a cancelled job puts it back to work', async () => {
    await use('OK');
    const a = await fault(), b = await fault();
    const va = await bookVisit(db, a.c.id, { slot: await firstSlot(a.c.id) }, 'agent1');
    const vb = await bookVisit(db, b.c.id, { slot: await firstSlot(b.c.id) }, 'agent1');
    const r = await send(va.externalRef, 'RE_SCHEDULING_REQUIRED', { reason: 'Technician sick', newWindow: { start: '2026-10-20T09:00:00Z', end: '2026-10-20T12:00:00Z' } });
    expect(r.status).toBe('APPLIED');
    const k = await getCase(db, a.c.id);
    expect([k.status, !!k.dispatchDueAt, k.dispatchNotifiedAt]).toEqual(['PENDING_DISPATCH', true, null]);
    expect((await listAppointments(db, a.c.id))[0]!.status).toBe('RESCHEDULE_REQUIRED');
    expect((await send(vb.externalRef, 'JOB_CANCELLED', { reason: 'Duplicate job' })).status).toBe('APPLIED');
    expect(await status(b.c.id)).toBe('IN_PROGRESS');
    // the agent can book a new visit
    expect((await bookVisit(db, a.c.id, { slot: await firstSlot(a.c.id) }, 'agent1')).status).toBe('SCHEDULED');
  });

  it('an unknown job is reported so the system retries, and a case an agent already resolved is left alone', async () => {
    await use('OK');
    expect((await send('NO-SUCH-JOB', 'EN_ROUTE')).status).toBe('UNKNOWN_JOB');
    const { c } = await fault();
    const v = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    await transitionCase(db, c.id, 'RESOLVED', { actor: 'agent1', resolution: 'Fixed remotely' });
    const r = await send(v.externalRef, 'JOB_COMPLETED', { notes: 'nothing to do' });
    expect(r.status).toBe('APPLIED');
    expect([await status(c.id), (await getCase(db, c.id)).resolution]).toEqual(['RESOLVED', 'Fixed remotely']);
    expect((await listAppointments(db, c.id))[0]!.status).toBe('COMPLETED');
  });
});

describe('dispatch timers, escalation and incidents', () => {
  it('tells supervisors when the technician has not reported, or when confirmation is slow', async () => {
    await use('OK');
    const { c } = await fault();
    const v = await bookVisit(db, c.id, { slot: await firstSlot(c.id) }, 'agent1');
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);
    await db.query(`UPDATE cases SET dispatch_due_at = now() - interval '1 minute' WHERE id=$1`, [c.id]);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['DISPATCH_OVERDUE']);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);
    expect((await outbox(c.id)).map((m) => m.instruction)).toContain('CASE_DISPATCH_OVERDUE');
    expect((await fireDueCaseTimers(db, c.id)).timers.waiting).toBe('DISPATCH');
    void v;
    const w = await fault();
    await transitionCase(db, w.c.id, 'PENDING_DISPATCH', { actor: 'agent1' });
    expect(Number((await getCase(db, w.c.id)).dispatchDueAt ? 1 : 0)).toBe(1);
  });

  it('books the earliest slot by itself when a fault case that needs a technician breaches its SLA, if switched on', async () => {
    await use('OK');
    const { c } = await fault();
    const other = await fault({ issueTypeId: 'broadband.slow.speed' });          // does not normally need a technician
    await db.query(`UPDATE cases SET created_at = created_at - interval '2 days', resolution_due = now() - interval '1 minute', first_response_due = now() - interval '1 day' WHERE id = ANY($1::uuid[])`, [[c.id, other.c.id]]);
    await fireDueCaseTimers(db, c.id);
    expect((await listAppointments(db, c.id))).toHaveLength(0);                   // off by default
    const { c: c2 } = await fault();
    await db.query(`UPDATE cases SET created_at = created_at - interval '2 days', resolution_due = now() - interval '1 minute', first_response_due = now() - interval '1 day' WHERE id=$1`, [c2.id]);
    await setCaseSettings(db, 'root', { autoDispatch: true });
    expect((await fireDueCaseTimers(db, c2.id)).fired).toContain('SLA_BREACH');
    expect((await listAppointments(db, c2.id))[0]).toMatchObject({ status: 'SCHEDULED', createdBy: 'system' });
    await fireDueCaseTimers(db, other.c.id);
    expect(await listAppointments(db, other.c.id)).toHaveLength(0);
    await setCaseSettings(db, 'root', { autoDispatch: false });
  });

  it('resolving a network incident cancels the booked visits of the cases it resolves', async () => {
    await use('OK');
    const node = `NODE${++n}`;
    const a = await fault({ postalNode: node }), b = await fault({ postalNode: node });
    const va = await bookVisit(db, a.c.id, { slot: await firstSlot(a.c.id) }, 'agent1');
    const inc = (await createMasterIncident(db, { postalNode: node, issueTypeId: 'broadband.down.cut' }, 'lead')).incident;
    await transitionCase(db, inc.id, 'IN_PROGRESS', { actor: 'lead' });
    await transitionCase(db, inc.id, 'RESOLVED', { actor: 'lead', resolution: 'Cable replaced' });
    expect([await status(a.c.id), await status(b.c.id)]).toEqual(['RESOLVED', 'RESOLVED']);
    expect((await listAppointments(db, a.c.id))[0]).toMatchObject({ status: 'CANCELLED', outcomeNote: `Resolved with network incident ${inc.number}` });
    const cancel = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='WFM_CANCEL' AND payload->>'caseId'=$1`, [a.c.id])).rows;
    expect(cancel).toHaveLength(1);
    expect(cancel[0]!.payload).toMatchObject({ jobRef: va.externalRef });
    // the field-service system's late callback for that job is ignored
    expect((await send(va.externalRef, 'EN_ROUTE')).status).toBe('IGNORED');
  });
});
