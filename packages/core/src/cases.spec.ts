import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addCaseNote, assignCase, ACTIVE_STATUSES, canCaseTransition, CASE_STATUSES, CASE_TRANSITIONS, caseTimeline, createCase, getCase, listCases, setSeverity, slaView, transitionCase } from './cases.js';
import { createCaseNode, deleteCaseNode, getCaseSettings, issueType, listCaseTaxonomy, listSla, setCaseSettings, setSla, deleteCaseNode as _d, updateCaseNode } from './case-taxonomy.js';
import type { Db } from './db.js';
import { attachInteractions, caseFromInteraction, detachInteraction, listInteractions, logInteraction } from './interactions.js';
import { updateCustomer } from './customers.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
void _d;

const cust = async (o: Parameters<typeof newCustomer>[1] = {}) => (await newCustomer(db, { address: { line1: '1 Road', postcode: '238872' }, ...o })).customer;
const open = async (o: Partial<Parameters<typeof createCase>[1]> = {}) => createCase(db, { customerId: (await cust()).id, issueTypeId: 'broadband.down.los', subject: 'No signal', ...o }, 'agent1');
const mins = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60_000);
const user = async (name: string) => { await db.query(`INSERT INTO users (username, display_name, password_hash, roles) VALUES ($1,$1,'x','{}') ON CONFLICT DO NOTHING`, [name]).catch(() => undefined); };

describe('taxonomy and SLA matrix', () => {
  it('ships a three-level taxonomy and a full SLA matrix', async () => {
    const tree = await listCaseTaxonomy(db);
    const fiber = tree.find((n) => n.id === 'broadband')!;
    expect(fiber.children!.find((n) => n.id === 'broadband.down')!.children!.map((n) => n.name)).toContain('LOS red light on');
    expect(await listSla(db)).toHaveLength(9);
  });
  it('operators add, switch off and (when unused) delete classifications; only an issue type carries behaviour', async () => {
    const cat = await createCaseNode(db, 'root', { name: 'IPTV' });
    const sub = await createCaseNode(db, 'root', { name: 'Picture problems', parentId: cat.id });
    await expect(createCaseNode(db, 'root', { name: 'Pixelation', parentId: sub.id })).rejects.toThrow(/kind of case/);
    const it = await createCaseNode(db, 'root', { name: 'Pixelation', parentId: sub.id, caseType: 'GENERAL', defaultSeverity: 'MAJOR_DEGRADATION', skills: ['SET_TOP_BOX'] });
    await expect(createCaseNode(db, 'root', { name: 'Too deep', parentId: it.id })).rejects.toThrow(/last level/);
    await expect(createCaseNode(db, 'root', { name: 'Bad', parentId: sub.id, caseType: 'GENERAL', defaultSeverity: 'MINOR_INQUIRY', skills: ['lower'] })).rejects.toThrow(/capitals/);
    expect((await issueType(db, it.id)).path).toBe('IPTV › Picture problems › Pixelation');
    await updateCaseNode(db, 'root', it.id, { active: false });
    await expect(issueType(db, it.id)).rejects.toThrow(/switched off/);
    await updateCaseNode(db, 'root', it.id, { active: true });
    const c = await open({ issueTypeId: it.id, subject: 'Pixels' });
    expect(c.categoryPath).toBe('IPTV › Picture problems › Pixelation');
    await expect(deleteCaseNode(db, 'root', cat.id)).rejects.toThrow(/below it/);
    await expect(deleteCaseNode(db, 'root', it.id)).rejects.toThrow(/Cases use/);
    const spare = await createCaseNode(db, 'root', { name: 'Spare', parentId: cat.id });
    expect((await deleteCaseNode(db, 'root', spare.id)).ok).toBe(true);
  });
  it('validates the SLA matrix', async () => {
    await expect(setSla(db, 'root', [{ tier: 'VIP', severity: 'MINOR_INQUIRY', firstResponseMinutes: 600, resolutionMinutes: 60, warnPercent: 80 }])).rejects.toThrow(/first response/);
    await expect(setSla(db, 'root', [{ tier: 'VIP', severity: 'MINOR_INQUIRY', firstResponseMinutes: 10, resolutionMinutes: 60, warnPercent: 100 }])).rejects.toThrow(/1 to 99/);
    await expect(setCaseSettings(db, 'root', { autoCloseHours: 0, reopenDays: 14, customerResponseHours: 72 })).rejects.toThrow(/autoCloseHours/);
    expect((await getCaseSettings(db)).reopenDays).toBe(14);
  });
});

describe('opening a case', () => {
  it('takes severity from the issue type, tier from the customer, and due times from the SLA matrix', async () => {
    const c = await open();
    expect(c).toMatchObject({ status: 'NEW', severity: 'CRITICAL_OUTAGE', priority: 'URGENT', tier: 'STANDARD', type: 'FIBER_ASSURANCE', postalNode: '238872' });
    expect(mins(c.firstResponseDue, c.createdAt)).toBe(60);
    expect(mins(c.resolutionDue, c.createdAt)).toBe(720);
    expect(c.sla.resolution.state).toBe('OK');
    const vip = await cust(); await updateCustomer(db, vip.id, { vip: true });
    const v = await createCase(db, { customerId: vip.id, issueTypeId: 'broadband.down.los', subject: 'VIP down' }, 'a');
    expect([v.tier, mins(v.firstResponseDue, v.createdAt), mins(v.resolutionDue, v.createdAt)]).toEqual(['VIP', 15, 240]);
    const ent = await cust({ segment: 'ENTERPRISE', displayName: 'Acme Pte Ltd' });
    expect((await createCase(db, { customerId: ent.id, issueTypeId: 'broadband.down.los', subject: 'x' }, 'a')).tier).toBe('ENTERPRISE');
  });
  it('still takes the old type and priority', async () => {
    const c = await createCase(db, { customerId: (await cust()).id, type: 'BILLING_REFUND', subject: 'Double charge', priority: 'HIGH' }, 'seed');
    expect([c.issueTypeId, c.severity, c.categoryPath]).toEqual(['billing.other.any', 'MAJOR_DEGRADATION', 'Billing › Other › Other billing question']);
    await expect(createCase(db, { customerId: (await cust()).id, type: 'GENERAL', issueTypeId: 'broadband.down.los', subject: 'x' })).rejects.toThrow(/FIBER_ASSURANCE/);
    await expect(createCase(db, { customerId: (await cust()).id, subject: ' ' })).rejects.toThrow(/subject/);
  });
});

describe('lifecycle state machine', () => {
  it('allows exactly the moves in the table', () => {
    for (const from of CASE_STATUSES) for (const to of CASE_STATUSES) expect(canCaseTransition(from, to)).toBe(CASE_TRANSITIONS[from].includes(to));
    expect(canCaseTransition('NEW', 'RESOLVED')).toBe(false);
    expect(canCaseTransition('RESOLVED', 'DISPATCHED')).toBe(false);
    expect(ACTIVE_STATUSES).not.toContain('RESOLVED');
  });
  it('walks a case through work, waiting, resolution, verification and reopening, auditing each step', async () => {
    const c = await open();
    await expect(transitionCase(db, c.id, 'RESOLVED', { actor: 'agent1', resolution: 'fixed' })).rejects.toThrow(/cannot go to/);
    const w = await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent1' });
    expect(w.assignee).toBe('agent1');
    await expect(transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent1' })).rejects.toThrow(/already/);
    await transitionCase(db, c.id, 'PENDING_DISPATCH', { actor: 'agent1' });
    await expect(transitionCase(db, c.id, 'DISPATCHED', { actor: 'agent1' })).rejects.toThrow(/field-service system/);
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent1' });
    await transitionCase(db, c.id, 'PENDING_THIRD_PARTY', { actor: 'agent1', note: 'waiting on the wholesale carrier' });
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent1' });
    await expect(transitionCase(db, c.id, 'RESOLVED', { actor: 'agent1' })).rejects.toThrow(/how the case was resolved/);
    const r = await transitionCase(db, c.id, 'RESOLVED', { actor: 'agent1', resolution: 'Replaced the drop cable' });
    expect(r).toMatchObject({ status: 'RESOLVED', resolution: 'Replaced the drop cable' });
    expect(r.resolvedAt).toBeTruthy(); expect(mins(r.autoCloseAt, r.resolvedAt)).toBe(72 * 60);
    expect(r.sla.resolution.state).toBe('MET');
    await expect(transitionCase(db, c.id, 'CLOSED_AUTO', { actor: 'agent1' })).rejects.toThrow(/closes itself/);
    await expect(transitionCase(db, c.id, 'REOPENED', { actor: 'agent1' })).rejects.toThrow(/why/);
    const ro = await transitionCase(db, c.id, 'REOPENED', { actor: 'cust', reason: 'Still down' });
    expect([ro.status, ro.reopenCount, ro.resolvedAt, ro.autoCloseAt]).toEqual(['REOPENED', 1, null, null]);
    expect(mins(ro.resolutionDue, new Date().toISOString())).toBeGreaterThan(700);
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'agent2' });
    await transitionCase(db, c.id, 'RESOLVED', { actor: 'agent2', resolution: 'Fixed for good' });
    const closed = await transitionCase(db, c.id, 'CLOSED_VERIFIED', { actor: 'cust' });
    expect(closed.closedAt).toBeTruthy();
    const log = (await db.query(`SELECT action, from_status, to_status FROM case_audit_log WHERE case_id=$1 ORDER BY id`, [c.id])).rows.filter((x) => x.action === 'STATUS').map((x) => `${x.fromStatus}>${x.toStatus}`);
    expect(log).toEqual(['NEW>IN_PROGRESS', 'IN_PROGRESS>PENDING_DISPATCH', 'PENDING_DISPATCH>IN_PROGRESS', 'IN_PROGRESS>PENDING_THIRD_PARTY', 'PENDING_THIRD_PARTY>IN_PROGRESS', 'IN_PROGRESS>RESOLVED', 'RESOLVED>REOPENED', 'REOPENED>IN_PROGRESS', 'IN_PROGRESS>RESOLVED', 'RESOLVED>CLOSED_VERIFIED']);
    const tl = await caseTimeline(db, c.id);
    expect(tl[0]!.title).toMatch(/resolved → closed verified/);
    expect(tl.some((t) => t.kind === 'note' && /wholesale/.test(t.title))).toBe(true);
  });
  it('only the timer closes a case by itself, a closed case reopens only within the window, and the customer is told', async () => {
    const c = await open();
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' }); await transitionCase(db, c.id, 'RESOLVED', { actor: 'a', resolution: 'Done' });
    expect((await transitionCase(db, c.id, 'CLOSED_AUTO', { system: true })).status).toBe('CLOSED_AUTO');
    await db.query(`UPDATE cases SET closed_at = now() - interval '15 days' WHERE id=$1`, [c.id]);
    await expect(transitionCase(db, c.id, 'REOPENED', { actor: 'cust', reason: 'again' })).rejects.toThrow(/14 days/);
    await db.query(`UPDATE cases SET closed_at = now() - interval '3 days' WHERE id=$1`, [c.id]);
    expect((await transitionCase(db, c.id, 'REOPENED', { actor: 'cust', reason: 'again' })).status).toBe('REOPENED');
    const out = (await db.query(`SELECT instruction FROM lifecycle_outbox WHERE payload->>'caseId'=$1 ORDER BY id`, [c.id])).rows.map((r) => r.instruction);
    expect(out).toEqual(['CASE_RESOLVED', 'CASE_REOPENED']);
  });
  it('waiting for the customer pauses the SLA and gives the time back; the first ask is the first response', async () => {
    const c = await open();
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' });
    const p = await transitionCase(db, c.id, 'PENDING_CUSTOMER', { actor: 'a', note: 'Please send a photo of the red light' });
    expect(p.slaPausedAt).toBeTruthy(); expect(p.firstResponseAt).toBeTruthy(); expect(p.sla.resolution.state).toBe('PAUSED');
    await db.query(`UPDATE cases SET sla_paused_at = now() - interval '3 hours' WHERE id=$1`, [c.id]);
    const before = (await getCase(db, c.id)).resolutionDue;
    const back = await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' });
    expect(back.slaPausedAt).toBeNull();
    expect(Math.round(mins(back.resolutionDue, before) / 60)).toBe(3);
  });
  it('a status change loses to a concurrent one instead of overwriting it', async () => {
    const c = await open();
    await db.query(`UPDATE cases SET status='IN_PROGRESS' WHERE id=$1`, [c.id]);
    await expect(transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'x' })).rejects.toThrow(/already/);
  });
});

describe('SLA clocks', () => {
  const base = { createdAt: '2026-10-01T00:00:00Z', slaResolutionMinutes: 100, slaWarnPercent: 80, resolutionDue: '2026-10-01T01:40:00Z', firstResponseDue: '2026-10-01T00:30:00Z', status: 'IN_PROGRESS' };
  const at = (min: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + min * 60_000);
  it('is ok, then warns at the set percentage, then breaches', () => {
    expect(slaView(base, at(50)).resolution).toMatchObject({ state: 'OK', percent: 50, remainingMinutes: 50 });
    expect(slaView(base, at(80)).resolution).toMatchObject({ state: 'WARNING', percent: 80 });
    expect(slaView(base, at(101)).resolution.state).toBe('BREACHED');
    expect(slaView(base, at(10)).firstResponse.state).toBe('OPEN');
    expect(slaView(base, at(31)).firstResponse.state).toBe('BREACHED');
  });
  it('stands still while paused, and records met or missed once resolved', () => {
    expect(slaView({ ...base, slaPausedAt: '2026-10-01T01:30:00Z' }, at(500)).resolution).toMatchObject({ state: 'PAUSED', percent: 90 });
    expect(slaView({ ...base, status: 'RESOLVED', resolvedAt: '2026-10-01T01:00:00Z', firstResponseAt: '2026-10-01T00:10:00Z' }, at(500))).toMatchObject({ resolution: { state: 'MET' }, firstResponse: { state: 'MET' } });
    expect(slaView({ ...base, status: 'CLOSED_AUTO', resolvedAt: '2026-10-01T02:00:00Z' }, at(500)).resolution.state).toBe('MISSED');
  });
  it('a new severity re-prices the SLA from the opening time', async () => {
    const c = await open({ issueTypeId: 'broadband.slow.speed' });
    expect(c.severity).toBe('MINOR_INQUIRY');
    const s = await setSeverity(db, c.id, 'CRITICAL_OUTAGE', 'agent1', 'it is a whole street');
    expect([s.priority, mins(s.resolutionDue, s.createdAt), mins(s.firstResponseDue, s.createdAt)]).toEqual(['URGENT', 720, 60]);
    await setSla(db, 'root', [{ tier: 'STANDARD', severity: 'CRITICAL_OUTAGE', firstResponseMinutes: 45, resolutionMinutes: 600, warnPercent: 70 }]);
    expect((await open()).slaWarnPercent).toBe(70);
    await setSla(db, 'root', [{ tier: 'STANDARD', severity: 'CRITICAL_OUTAGE', firstResponseMinutes: 60, resolutionMinutes: 720, warnPercent: 80 }]);
  });
});

describe('assignment, notes and the list', () => {
  it('assigns to real users, keeps closed cases fixed, and filters the list', async () => {
    await user('tech.lee');
    const c = await open({ subject: 'Assign me' });
    await expect(assignCase(db, c.id, { assignee: 'nobody.here' }, 'a')).rejects.toThrow(/no user/);
    expect((await assignCase(db, c.id, { assignee: 'tech.lee', team: 'Fiber assurance' }, 'a')).team).toBe('Fiber assurance');
    expect((await listCases(db, { assignee: 'tech.lee' })).items.map((x) => x.id)).toContain(c.id);
    expect((await listCases(db, { unassigned: true, q: c.number })).items).toHaveLength(0);
    expect((await listCases(db, { severity: 'CRITICAL_OUTAGE', status: 'ACTIVE' })).items.every((x) => x.severity === 'CRITICAL_OUTAGE')).toBe(true);
    await addCaseNote(db, c.id, 'called the customer', 'a');
    await expect(addCaseNote(db, c.id, '  ', 'a')).rejects.toThrow(/empty/);
    await db.query(`UPDATE cases SET created_at = now() - interval '2 days', resolution_due = now() - interval '1 hour' WHERE id=$1`, [c.id]);
    expect((await listCases(db, { breached: true })).items.map((x) => x.id)).toContain(c.id);
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' }); await transitionCase(db, c.id, 'RESOLVED', { actor: 'a', resolution: 'fixed ok' }); await transitionCase(db, c.id, 'CLOSED_VERIFIED', { actor: 'a' });
    await expect(assignCase(db, c.id, { assignee: null }, 'a')).rejects.toThrow(/closed/);
  });
});

describe('interactions', () => {
  it('logs touchpoints on any channel, ignores a resent session, and validates', async () => {
    const k = await cust();
    const i = await logInteraction(db, { customerId: k.id, channel: 'CALL_CENTER', direction: 'INBOUND', subject: 'Internet is down', sessionRef: 'call-991', durationSec: 240 }, 'agent1');
    expect((await logInteraction(db, { customerId: k.id, channel: 'CALL_CENTER', direction: 'INBOUND', subject: 'Internet is down', sessionRef: 'call-991' }, 'agent1')).id).toBe(i.id);
    for (const channel of ['RETAIL_POS', 'WHATSAPP', 'WEB_SELF_SERVE', 'MOBILE_APP', 'EMAIL', 'IN_STORE'] as const) await logInteraction(db, { customerId: k.id, channel, direction: 'INBOUND', subject: `via ${channel}` }, 'a');
    await expect(logInteraction(db, { customerId: k.id, channel: 'FAX' as never, direction: 'INBOUND', subject: 'x' }, 'a')).rejects.toThrow(/channel/);
    await expect(logInteraction(db, { customerId: k.id, channel: 'EMAIL', direction: 'INBOUND', subject: 'x', occurredAt: '2999-01-01T00:00:00Z' }, 'a')).rejects.toThrow(/future/);
    const page = await listInteractions(db, { customerId: k.id, limit: 3 });
    expect(page.items).toHaveLength(3); expect(page.nextCursor).toBeTruthy();
    expect((await listInteractions(db, { customerId: k.id, limit: 10, cursor: page.nextCursor! })).items.length).toBe(4);
    await expect(listInteractions(db, {})).rejects.toThrow(/whose/);
  });
  it('opens a case from an interaction, attaches more, and the first outbound one is the first response', async () => {
    const k = await cust();
    const call = await logInteraction(db, { customerId: k.id, channel: 'CALL_CENTER', direction: 'INBOUND', subject: 'No signal' }, 'agent1');
    const c = await caseFromInteraction(db, call.id, { issueTypeId: 'broadband.down.los', subject: '' }, 'agent1');
    expect([c.subject, c.channel]).toEqual(['No signal', 'CALL_CENTER']);
    expect(c.firstResponseAt).toBeNull();
    await expect(caseFromInteraction(db, call.id, { issueTypeId: 'broadband.down.los', subject: 'again' }, 'a')).rejects.toThrow(/already on a case/);
    const wa = await logInteraction(db, { customerId: k.id, channel: 'WHATSAPP', direction: 'OUTBOUND', subject: 'We are on it', caseId: c.id }, 'agent1');
    expect((await getCase(db, c.id)).firstResponseAt).toBeTruthy();
    const other = await cust();
    const stray = await logInteraction(db, { customerId: other.id, channel: 'EMAIL', direction: 'INBOUND', subject: 'someone else' }, 'a');
    await expect(attachInteractions(db, c.id, [stray.id], 'a')).rejects.toThrow(/same customer/);
    const later = await logInteraction(db, { customerId: k.id, channel: 'EMAIL', direction: 'INBOUND', subject: 'photo attached' }, 'a');
    await attachInteractions(db, c.id, [later.id], 'a');
    const c2 = await open(); void c2;
    const second = await createCase(db, { customerId: k.id, issueTypeId: 'broadband.slow.speed', subject: 'second' }, 'a');
    await expect(attachInteractions(db, second.id, [later.id], 'a')).rejects.toThrow(/another case/);
    expect((await listInteractions(db, { caseId: c.id })).items.map((x) => x.id).sort()).toEqual([call.id, wa.id, later.id].sort());
    await detachInteraction(db, later.id, 'a');
    expect((await listInteractions(db, { caseId: c.id })).items).toHaveLength(2);
    expect((await caseTimeline(db, c.id)).filter((t) => t.kind === 'interaction')).toHaveLength(2);
  });
});
