import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseTimers, fireDueCaseTimers, slaBoard, sweepCaseSla } from './case-sla.js';
import { correlateCases, createMasterIncident, linkCases, listIncidentChildren, suggestIncidents, unlinkCase } from './case-incidents.js';
import { cancelRefund, decideRefund, DEFAULT_REFUND_TIERS, getRefundTiers, listRefundsToDecide, requestRefund, setRefundTiers, tierFor } from './case-refunds.js';
import { createCase, getCase, transitionCase } from './cases.js';
import { setCaseSettings } from './case-taxonomy.js';
import type { Db } from './db.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

let seq = 0;
const cust = async (postcode = '100001') => (await newCustomer(db, { address: { line1: '1 Road', postcode } })).customer;
const open = async (o: Partial<Parameters<typeof createCase>[1]> = {}) => createCase(db, { customerId: o.customerId ?? (await cust()).id, issueTypeId: 'broadband.slow.speed', subject: 'case', ...o }, 'agent1');
/** Moves a case's clocks back so that `minutes` have passed since it opened. */
const age = (id: string, minutes: number) => db.query(
  `UPDATE cases SET created_at = created_at - make_interval(mins => $2), first_response_due = first_response_due - make_interval(mins => $2), resolution_due = resolution_due - make_interval(mins => $2) WHERE id=$1`, [id, minutes]);
const outbox = async (caseId: string) => (await db.query(`SELECT instruction FROM lifecycle_outbox WHERE payload->>'caseId'=$1 ORDER BY id`, [caseId])).rows.map((r) => r.instruction as string);
const log = async (caseId: string) => (await db.query(`SELECT action FROM case_audit_log WHERE case_id=$1 ORDER BY id`, [caseId])).rows.map((r) => r.action as string);

describe('SLA watchdog', () => {
  it('works out what is due, and when', () => {
    const base = { status: 'IN_PROGRESS', createdAt: '2026-10-01T00:00:00Z', slaResolutionMinutes: 100, slaWarnPercent: 80, resolutionDue: '2026-10-01T01:40:00Z', firstResponseDue: '2026-10-01T00:30:00Z', escalationLevel: 0 };
    const t = caseTimers(base, { customerResponseHours: 72 });
    expect(t.upcoming.map((u) => [u.kind, u.at])).toEqual([['FIRST_RESPONSE_BREACH', '2026-10-01T00:30:00.000Z'], ['SLA_WARNING', '2026-10-01T01:20:00.000Z'], ['SLA_BREACH', '2026-10-01T01:40:00.000Z'], ['SLA_ESCALATION', '2026-10-01T02:30:00.000Z']]);
    expect(caseTimers({ ...base, firstResponseAt: '2026-10-01T00:05:00Z', slaWarnedAt: 'x' }, { customerResponseHours: 72 }).upcoming.map((u) => u.kind)).toEqual(['SLA_BREACH', 'SLA_ESCALATION']);
    expect(caseTimers({ ...base, slaPausedAt: '2026-10-01T01:00:00Z' }, { customerResponseHours: 72 }).upcoming.map((u) => [u.kind, u.at])).toEqual([['CUSTOMER_WAIT_CLOSE', '2026-10-04T01:00:00.000Z']]);
    expect(caseTimers({ ...base, status: 'RESOLVED', autoCloseAt: '2026-10-04T00:00:00Z' }, { customerResponseHours: 72 }).upcoming.map((u) => u.kind)).toEqual(['AUTO_CLOSE']);
    expect(caseTimers({ ...base, status: 'CLOSED_AUTO' }, { customerResponseHours: 72 })).toMatchObject({ closed: true, nextAt: null });
  });

  it('warns supervisors at the set percentage, breaches, and escalates, each exactly once', async () => {
    const c = await open();                                  // standard minor inquiry: 480 min first response, 7200 min resolution
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);
    await age(c.id, 481);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['FIRST_RESPONSE_BREACH']);
    await age(c.id, 5760 - 481 + 1);                           // 80% of 7200 = 5760 minutes
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['SLA_WARNING']);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);   // idempotent
    await age(c.id, 7200 - 5760);
    const b = await fireDueCaseTimers(db, c.id);
    expect(b.fired).toEqual(['SLA_BREACH']);
    let k = await getCase(db, c.id);
    expect([k.escalationLevel, k.priority, k.sla.resolution.state]).toEqual([1, 'HIGH', 'BREACHED']);
    await age(c.id, 3600);                                     // half as late again
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['SLA_ESCALATION']);
    k = await getCase(db, c.id);
    expect([k.escalationLevel, k.priority]).toEqual([2, 'URGENT']);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);
    expect(await outbox(c.id)).toEqual(['CASE_FIRST_RESPONSE_BREACH', 'CASE_SLA_WARNING', 'CASE_SLA_BREACH', 'CASE_SLA_ESCALATED']);
    expect((await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='CASE_SLA_BREACH' AND payload->>'caseId'=$1`, [c.id])).rows[0]!.payload).toMatchObject({ to: 'SUPERVISORS' });
    expect(await log(c.id)).toEqual(expect.arrayContaining(['SLA_WARNING', 'SLA_BREACH', 'SLA_ESCALATION']));
  });

  it('a long-overdue case catches up in order in one call', async () => {
    const c = await open();
    await age(c.id, 20000);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['FIRST_RESPONSE_BREACH', 'SLA_WARNING', 'SLA_BREACH', 'SLA_ESCALATION']);
  });

  it('a paused case does not breach, and closes itself when the customer never answers', async () => {
    const c = await open();
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' });
    await transitionCase(db, c.id, 'PENDING_CUSTOMER', { actor: 'a', note: 'photo please' });
    await age(c.id, 20000);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);
    await db.query(`UPDATE cases SET sla_paused_at = now() - interval '73 hours' WHERE id=$1`, [c.id]);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['CUSTOMER_WAIT_CLOSE']);
    expect((await getCase(db, c.id)).status).toBe('CLOSED_AUTO');
  });

  it('a resolved case closes itself at its closing time, not before', async () => {
    const c = await open();
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' }); await transitionCase(db, c.id, 'RESOLVED', { actor: 'a', resolution: 'fixed it' });
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual([]);
    await db.query(`UPDATE cases SET auto_close_at = now() - interval '1 minute' WHERE id=$1`, [c.id]);
    expect((await fireDueCaseTimers(db, c.id)).fired).toEqual(['AUTO_CLOSE']);
    expect((await getCase(db, c.id)).status).toBe('CLOSED_AUTO');
    expect((await fireDueCaseTimers(db, c.id)).timers.closed).toBe(true);
  });

  it('the sweep finds only cases with something due, and the board lists breaches', async () => {
    const quiet = await open(), late = await open({ issueTypeId: 'broadband.down.los' });
    await age(late.id, 800);                                    // critical outage: 720 minute resolution
    const r = await sweepCaseSla(db);
    expect(r.errors).toEqual([]);
    expect(r.fired.SLA_BREACH).toBeGreaterThanOrEqual(1);
    expect((await getCase(db, quiet.id)).slaBreachedAt).toBeNull();
    expect((await getCase(db, late.id)).slaBreachedAt).toBeTruthy();
    expect((await slaBoard(db)).breached.map((x) => x.id)).toContain(late.id);
    expect((await sweepCaseSla(db)).checked).toBeLessThanOrEqual(r.checked);
  });
});

describe('master network incidents', () => {
  const node = () => `N${++seq}`.padStart(6, '0');
  const at = async (n: string, o: Partial<Parameters<typeof createCase>[1]> = {}) => open({ issueTypeId: 'broadband.down.los', postalNode: n, ...o });

  it('groups the cases of a node under a master that belongs to the network, and tells each customer', async () => {
    const n = node();
    const a = await at(n), b = await at(n), other = await at(node());
    const r = await createMasterIncident(db, { postalNode: n, issueTypeId: 'broadband.down.cut' }, 'lead1');
    expect(r.linked).toBe(2);
    expect(r.incident).toMatchObject({ isMaster: true, customerId: null, tier: 'VIP', severity: 'CRITICAL_OUTAGE', childCount: 2 });
    expect(r.incident.number).toMatch(/^INC-/);
    expect((await getCase(db, a.id)).masterCaseId).toBe(r.incident.id);
    expect((await getCase(db, other.id)).masterCaseId).toBeNull();
    expect(await outbox(a.id)).toContain('CASE_INCIDENT_LINKED');
    expect(await log(a.id)).toContain('INCIDENT_LINKED');
    await expect(createMasterIncident(db, { postalNode: n, issueTypeId: 'broadband.down.cut' }, 'lead1')).rejects.toThrow(/already an open incident/);
    await expect(createMasterIncident(db, { postalNode: node(), issueTypeId: 'billing.dispute.dup' }, 'lead1')).rejects.toThrow(/fibre or service fault/);
    expect((await listIncidentChildren(db, r.incident.id)).items.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    // a case opened later at the node joins by itself
    const late = await at(n);
    expect((await getCase(db, late.id)).masterCaseId).toBe(r.incident.id);
    // and can be taken out again
    expect((await unlinkCase(db, late.id, 'lead1')).masterCaseId).toBeNull();
    await expect(unlinkCase(db, late.id, 'lead1')).rejects.toThrow(/not part of/);
  });

  it('resolving the master resolves every open child, whatever it was waiting on, and closed ones are left alone', async () => {
    const n = node();
    const a = await at(n), b = await at(n), c = await at(n), done = await at(n);
    await transitionCase(db, b.id, 'IN_PROGRESS', { actor: 'x' }); await transitionCase(db, b.id, 'PENDING_CUSTOMER', { actor: 'x', note: 'hello' });
    await transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'x' }); await transitionCase(db, c.id, 'PENDING_DISPATCH', { actor: 'x' });
    await transitionCase(db, done.id, 'IN_PROGRESS', { actor: 'x' }); await transitionCase(db, done.id, 'RESOLVED', { actor: 'x', resolution: 'own fix' });
    const m = (await createMasterIncident(db, { postalNode: n, issueTypeId: 'broadband.down.cut' }, 'lead1')).incident;
    expect(m.childCount).toBe(3);                               // the resolved case is not adopted
    await transitionCase(db, m.id, 'IN_PROGRESS', { actor: 'lead1' });
    const res = await transitionCase(db, m.id, 'RESOLVED', { actor: 'lead1', resolution: 'Replaced the cut cable' });
    expect(res.status).toBe('RESOLVED');
    for (const k of [a, b, c]) {
      const x = await getCase(db, k.id);
      expect([x.status, x.slaPausedAt, x.resolution]).toEqual(['RESOLVED', null, `Resolved with network incident ${m.number}: Replaced the cut cable`]);
      expect(await outbox(k.id)).toContain('CASE_RESOLVED');
    }
    expect((await getCase(db, done.id)).resolution).toBe('own fix');
    const trail = (await db.query(`SELECT from_status FROM case_audit_log WHERE case_id=$1 AND to_status='RESOLVED'`, [c.id])).rows[0]!;
    expect(trail.fromStatus).toBe('PENDING_DISPATCH');
    await expect(linkCases(db, m.id, { adoptNode: true }, 'lead1')).rejects.toThrow(/resolved/);
  });

  it('attaching skips cases that cannot be attached, and suggests and groups busy nodes by itself when allowed', async () => {
    const n = node();
    const a = await at(n);
    const m = (await createMasterIncident(db, { postalNode: node(), issueTypeId: 'broadband.down.cut', adoptOpen: false }, 'l')).incident;
    const r = await linkCases(db, m.id, { caseIds: [a.id] }, 'l');       // a is at another node
    expect(r).toEqual({ linked: 0, skipped: 1 });
    await expect(linkCases(db, a.id, { adoptNode: true }, 'l')).rejects.toThrow(/network incident/);

    const busy = node();
    for (let i = 0; i < 5; i++) await at(busy);
    const s = await suggestIncidents(db);
    const mine = s.find((x) => x.postalNode === busy)!;
    expect([mine.cases, mine.issueTypeId]).toEqual([5, 'broadband.down.los']);
    expect(s.find((x) => x.postalNode === n)).toBeUndefined();            // one case is not an incident
    expect((await correlateCases(db)).created).toEqual([]);                // off by default
    await setCaseSettings(db, 'root', { incidentAutoCreate: true });
    const made = (await correlateCases(db)).created.find((x) => x.postalNode === busy)!;
    expect(made.linked).toBe(5);
    expect((await suggestIncidents(db)).find((x) => x.postalNode === busy)).toBeUndefined();
    await setCaseSettings(db, 'root', { incidentAutoCreate: false, incidentAutoLink: false });
    const nolink = await at(busy);
    expect((await getCase(db, nolink.id)).masterCaseId).toBeNull();
    await setCaseSettings(db, 'root', { incidentAutoLink: true });
    await expect(setCaseSettings(db, 'root', { incidentThreshold: 1 })).rejects.toThrow(/at least 2/);
  });

  it('handles a large incident in set-based statements', async () => {
    const n = node();
    for (let i = 0; i < 60; i++) await at(n);
    const r = await createMasterIncident(db, { postalNode: n, issueTypeId: 'broadband.down.cut' }, 'l');
    expect(r.linked).toBe(60);
    const t0 = Date.now();
    await transitionCase(db, r.incident.id, 'IN_PROGRESS', { actor: 'l' });
    await transitionCase(db, r.incident.id, 'RESOLVED', { actor: 'l', resolution: 'fixed' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(Number((await db.query(`SELECT count(*) AS n FROM cases WHERE master_case_id=$1 AND status='RESOLVED'`, [r.incident.id])).rows[0]!.n)).toBe(60);
  });
});

describe('refund approvals', () => {
  const agent = { username: 'agent.a', roles: ['call-center'] }, lead = { username: 'lead.l', roles: ['team-lead'] }, fin = { username: 'fin.f', roles: ['finance'] }, nobody = { username: 'x.x', roles: ['retail-store'] };
  async function dispute() {
    const k = await cust();
    const account = (await db.query(`SELECT id, shard_id FROM accounts WHERE customer_id=$1`, [k.id])).rows[0]!;
    const num = `RF-${++seq}-${Math.random().toString(36).slice(2, 6)}`;
    const inv = (await db.query(`INSERT INTO invoices (shard_id, number, account_id, customer_id, kind, period_start, period_end, issue_date, due_date, status, currency, net_minor, tax_minor, total_minor)
      VALUES ($1,$2,$3,$4,'CYCLE','2026-09-01','2026-09-30','2026-10-01','2026-10-15','ISSUED','SGD',27500,2475,29975) RETURNING id`, [account.shardId, num, account.id, k.id])).rows[0]!;
    const c = await createCase(db, { customerId: k.id, type: 'BILLING_REFUND', subject: 'Overcharged', note: 'x' }, 'agent.a');
    return { k, c, invoiceId: inv.id as string };
  }
  const credited = async (invoiceId: string) => Number((await db.query('SELECT credited_minor FROM invoices WHERE id=$1', [invoiceId])).rows[0]!.creditedMinor);

  it('has the default tiers, and validates changes to them', async () => {
    const t = await getRefundTiers(db);
    expect(t).toEqual(DEFAULT_REFUND_TIERS);
    expect([tierFor(t, 2000), tierFor(t, 2001), tierFor(t, 10000), tierFor(t, 10001)]).toEqual([0, 1, 1, 2]);
    await expect(setRefundTiers(db, 'root', [{ label: 'A', maxMinor: 100, roleIds: ['x'] }])).rejects.toThrow(/no limit/);
    await expect(setRefundTiers(db, 'root', [{ label: 'A', maxMinor: 500, roleIds: ['x'] }, { label: 'B', maxMinor: 100, roleIds: ['y'] }, { label: 'C', maxMinor: null, roleIds: ['z'] }])).rejects.toThrow(/larger/);
    await expect(setRefundTiers(db, 'root', [{ label: 'A', maxMinor: null, roleIds: [] }])).rejects.toThrow(/role/);
  });

  it('applies a refund within the asker’s limit at once', async () => {
    const { c, invoiceId } = await dispute();
    const r = await requestRefund(db, c.id, { invoiceId, amountMinor: 1500, reason: 'Duplicate charge' }, agent);
    expect([r.status, r.decidedBy, r.tierLabel]).toEqual(['EXECUTED', 'agent.a', 'Agent']);
    expect(await credited(invoiceId)).toBe(1500);
  });

  it('holds a larger one for a higher tier that is not the asker, and pays it once', async () => {
    const { c, invoiceId } = await dispute();
    const r = await requestRefund(db, c.id, { invoiceId, amountMinor: 8000, reason: 'Service was down for a week' }, agent);
    expect([r.status, r.tierLabel]).toEqual(['PENDING', 'Team lead']);
    expect(await credited(invoiceId)).toBe(0);
    expect((await listRefundsToDecide(db, lead)).map((x) => x.id)).toContain(r.id);
    expect((await listRefundsToDecide(db, agent)).map((x) => x.id)).not.toContain(r.id);
    expect(await listRefundsToDecide(db, nobody)).toEqual([]);
    await expect(decideRefund(db, r.id, { decision: 'APPROVE' }, agent)).rejects.toThrow(/Team lead or above/);
    await expect(transitionCase(db, c.id, 'IN_PROGRESS', { actor: 'a' }).then(() => transitionCase(db, c.id, 'RESOLVED', { actor: 'a', resolution: 'all done' }))).rejects.toThrow(/waiting for approval/);
    const ok = await decideRefund(db, r.id, { decision: 'APPROVE', note: 'Agreed' }, lead);
    expect([ok.status, ok.decidedBy]).toEqual(['EXECUTED', 'lead.l']);
    expect(await credited(invoiceId)).toBe(8000);
    await expect(decideRefund(db, r.id, { decision: 'APPROVE' }, fin)).rejects.toThrow(/already executed/);
    expect(await credited(invoiceId)).toBe(8000);
    expect((await transitionCase(db, c.id, 'RESOLVED', { actor: 'a', resolution: 'all done' })).status).toBe('RESOLVED');
  });

  it('needs a finance manager above the team lead’s limit, never the asker, and a reason to reject', async () => {
    const { c, invoiceId } = await dispute();
    const r = await requestRefund(db, c.id, { invoiceId, amountMinor: 20000, reason: 'Wrongly billed for a cancelled plan' }, lead);
    expect(r.tierLabel).toBe('Finance manager');
    await expect(decideRefund(db, r.id, { decision: 'APPROVE' }, lead)).rejects.toThrow(/Finance manager or above/);
    const r2 = await requestRefund(db, c.id, { invoiceId, amountMinor: 3000, reason: 'Goodwill' }, agent);
    expect(r2.requiredTier).toBe(1);
    await expect(decideRefund(db, r2.id, { decision: 'REJECT' }, lead)).rejects.toThrow(/why/);
    expect((await decideRefund(db, r2.id, { decision: 'REJECT', note: 'Not a billing fault' }, lead)).status).toBe('REJECTED');
    const r3 = await requestRefund(db, c.id, { invoiceId, amountMinor: 5000, reason: 'Goodwill again' }, fin.roles.includes('finance') ? { ...agent, username: 'asker.z' } : agent);
    await expect(decideRefund(db, r3.id, { decision: 'APPROVE' }, { username: 'asker.z', roles: ['team-lead'] })).rejects.toThrow(/other than the person who asked/);
    expect((await decideRefund(db, r3.id, { decision: 'APPROVE' }, fin)).status).toBe('EXECUTED');
    expect(await credited(invoiceId)).toBe(5000);
    const r4 = await requestRefund(db, c.id, { invoiceId, amountMinor: 4000, reason: 'Sorry' }, agent);
    expect((await cancelRefund(db, r4.id, agent)).status).toBe('CANCELLED');
    await expect(cancelRefund(db, r4.id, agent)).rejects.toThrow(/already been decided/);
    expect((await db.query(`SELECT action FROM case_audit_log WHERE case_id=$1 AND action LIKE 'REFUND%' ORDER BY id`, [c.id])).rows.map((x) => x.action)).toEqual(['REFUND_REQUESTED', 'REFUND_REQUESTED', 'REFUND_REJECTED', 'REFUND_REQUESTED', 'REFUND_EXECUTED', 'REFUND_REQUESTED', 'REFUND_CANCELLED']);
  });

  it('refuses what cannot be refunded', async () => {
    const { c, invoiceId } = await dispute();
    const other = await dispute();
    await expect(requestRefund(db, c.id, { invoiceId, amountMinor: 0, reason: 'x y z' }, agent)).rejects.toThrow(/positive/);
    await expect(requestRefund(db, c.id, { invoiceId, amountMinor: 100, reason: '' }, agent)).rejects.toThrow(/why/);
    await expect(requestRefund(db, c.id, { invoiceId: other.invoiceId, amountMinor: 100, reason: 'wrong one' }, agent)).rejects.toThrow(/another customer/);
    await expect(requestRefund(db, c.id, { invoiceId, amountMinor: 99999, reason: 'too much' }, agent)).rejects.toThrow(/left to credit/);
    const general = await open();
    await expect(requestRefund(db, general.id, { invoiceId, amountMinor: 100, reason: 'not a dispute' }, agent)).rejects.toThrow(/billing-dispute/);
    const held = await requestRefund(db, c.id, { invoiceId, amountMinor: 29000, reason: 'nearly all' }, agent);
    await expect(requestRefund(db, c.id, { invoiceId, amountMinor: 2000, reason: 'and some more' }, agent)).rejects.toThrow(/already waiting/);
    void held;
  });
});
