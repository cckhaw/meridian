import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { assessCase, assignCases, claimCase, escalateCase, getKycReviewSettings, listReviewers, nextCase, planAssignments, releaseCase, setKycReviewSettings, setOfficerStatus, sweepKycReview, takeOver, userCanReview, type PlanOfficer } from './kyc-review.js';
import { wildcardPattern } from './kyc-list.js';
import { addCase, addOfficer, caseRow, events, holders } from './kyc-review-helpers.js';
import { createCustomRole, setRolePermissions, resetRole } from './roles-config.js';
import { ROLES } from './rbac.js';
import { freshDb } from './test-helpers.js';

describe('wildcard search pattern', () => {
  const w = wildcardPattern;
  it('means "contains" when there is no wildcard, ignoring blanks around it', () => {
    expect(w('tan')).toBe('%tan%');
    expect(w('  tan  wei ')).toBe('%tan wei%');
  });
  it('turns * into any run and ? into exactly one, and then matches the whole value', () => {
    expect(w('tan*')).toBe('tan%');
    expect(w('*tan')).toBe('%tan');
    expect(w('*tan*')).toBe('%tan%');
    expect(w('t*n')).toBe('t%n');
    expect(w('t?n')).toBe('t_n');
    expect(w('t???')).toBe('t___');
    expect(w('a**b***c')).toBe('a%b%c');
    expect(w('*')).toBe('%');
    expect(w('?')).toBe('_');
  });
  it('escapes the SQL wildcards and the backslash, so nobody can smuggle them in', () => {
    expect(w('100%')).toBe('%100\\%%');
    expect(w('a_b')).toBe('%a\\_b%');
    expect(w('a\\b')).toBe('%a\\\\b%');
    expect(w('50%*')).toBe('50\\%%');
    expect(w('%_%')).toBe('%\\%\\_\\%%');
  });
  it('keeps unicode as it is and gives nothing for empty input', () => {
    expect(w('Nguyễn*')).toBe('Nguyễn%');
    expect(w('李?')).toBe('李_');
    expect(w('😀*')).toBe('😀%');
    expect(w('')).toBeNull();
    expect(w('   ')).toBeNull();
    expect(w(undefined)).toBeNull();
    expect(w('x'.repeat(300))!.length).toBe(102);   // long input is cut at 100 characters
  });
  it('is safe to hand to ILIKE: a literal % is not a wildcard', async () => {
    const db = await freshDb();
    try {
      const hit = async (value: string, input: string) => (await db.query(`SELECT $1::text ILIKE $2 AS m`, [value, wildcardPattern(input)])).rows[0]!.m as boolean;
      expect(await hit('Tan Wei Ming', 'tan*')).toBe(true);
      expect(await hit('Tan Wei Ming', 'wei')).toBe(true);
      expect(await hit('Tan Wei Ming', 'wei*')).toBe(false);          // with a wildcard the pattern must match from the start to the end
      expect(await hit('Tan Wei Ming', '*MING')).toBe(true);
      expect(await hit('S****567A', '567?')).toBe(false);
      expect(await hit('S****567A', '*567?')).toBe(true);
      expect(await hit('abc', '%')).toBe(false);                      // a literal percent sign
      expect(await hit('50% off', '50%')).toBe(true);
      expect(await hit('a_b', 'a_b')).toBe(true);
      expect(await hit('axb', 'a_b')).toBe(false);
    } finally { await db.close(); }
  });
});

describe('risk and priority', () => {
  const s = { kycSlaHours: 4, minAge: 18 };
  const now = new Date('2026-06-15T12:00:00Z');
  const base = { dateOfBirth: '1990-01-01', idExpiry: '2030-01-01', submittedAt: '2026-06-15T11:00:00Z' };
  it('is LOW with nothing flagged and ranks overdue above everything', () => {
    expect(assessCase({ ...base, flags: [] }, s, now)).toMatchObject({ risk: 'LOW', priority: 100, overdue: false });
    expect(assessCase({ ...base, flags: [], submittedAt: '2026-06-15T07:00:00Z' }, s, now)).toMatchObject({ risk: 'LOW', priority: 1100, overdue: true });
  });
  it('is HIGH for a duplicate identity, a reused picture, fraud, a clear provider mismatch, an expired or soon expiring ID and a just-of-age applicant', () => {
    expect(assessCase({ ...base, flags: ['DUPLICATE_IDENTITY'] }, s, now).risk).toBe('HIGH');
    expect(assessCase({ ...base, flags: ['IMAGE_REUSED'] }, s, now).risk).toBe('HIGH');
    expect(assessCase({ ...base, flags: [], fraudReported: true }, s, now).risk).toBe('HIGH');
    expect(assessCase({ ...base, flags: [], reasonCode: 'SUSPECTED_FRAUD' }, s, now).risk).toBe('HIGH');
    expect(assessCase({ ...base, flags: ['PROVIDER_REVIEW'], checks: { provider: { checks: { nameMatch: false } } } }, s, now).risk).toBe('HIGH');
    expect(assessCase({ ...base, flags: ['PROVIDER_REVIEW'], checks: { provider: { checks: { nameMatch: true, faceMatch: 0.6 } } } }, s, now).risk).toBe('MEDIUM');
    expect(assessCase({ ...base, flags: [], idExpiry: '2026-06-01' }, s, now).risk).toBe('HIGH');
    expect(assessCase({ ...base, flags: [], idExpiry: '2026-07-01' }, s, now).risk).toBe('HIGH');      // within 30 days
    expect(assessCase({ ...base, flags: [], idExpiry: '2026-08-01' }, s, now).risk).toBe('LOW');
    expect(assessCase({ ...base, flags: [], dateOfBirth: '2008-06-10' }, s, now).risk).toBe('HIGH');   // turned 18 five days ago
    expect(assessCase({ ...base, flags: [], dateOfBirth: '2008-06-20' }, s, now).risk).toBe('LOW');    // not 18 yet: the hard rule handles that, not the risk
  });
  it('is MEDIUM for other flags and orders high before medium before low, orders on hold first among equals', () => {
    expect(assessCase({ ...base, flags: ['PROVIDER_UNAVAILABLE'] }, s, now).risk).toBe('MEDIUM');
    expect(assessCase({ ...base, flags: ['NOT_LIVE_CAPTURE'] }, s, now).priority).toBe(200);
    const p = (flags: string[], waitingOrders = 0) => assessCase({ ...base, flags, waitingOrders }, s, now).priority;
    expect(p(['DUPLICATE_IDENTITY'])).toBeGreaterThan(p(['NOT_LIVE_CAPTURE']));
    expect(p(['NOT_LIVE_CAPTURE'])).toBeGreaterThan(p([]));
    expect(p([], 2)).toBeGreaterThan(p([]));
    expect(p([], 2)).toBeLessThan(p(['NOT_LIVE_CAPTURE']));
    expect(assessCase({ ...base, flags: [], escalatedAt: '2026-06-15T11:30:00Z' }, s, now).priority).toBe(600);
  });
});

describe('planning the distribution', () => {
  const officers = (...loads: number[]): PlanOfficer[] => loads.map((open, i) => ({ username: `o${i + 1}`, open, capacityLeft: null }));
  const cases = (n: number, exclude: string[] = []) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, exclude: new Set(exclude) }));
  const count = (picks: Array<{ to: string }>) => picks.reduce<Record<string, number>>((m, p) => ((m[p.to] = (m[p.to] ?? 0) + 1), m), {});

  it('equalises: 3 officers, 300 cases, each gets 100', () => {
    expect(count(planAssignments(cases(300), officers(0, 0, 0), { strategy: 'EQUAL' }).picks)).toEqual({ o1: 100, o2: 100, o3: 100 });
  });
  it('evens out an existing imbalance before anyone gets more than another', () => {
    expect(count(planAssignments(cases(10), officers(8, 0, 2), { strategy: 'EQUAL' }).picks)).toEqual({ o2: 6, o3: 4 });
  });
  it('breaks ties at random without favouring anyone: the first case of 3,000 trials goes to each of 3 officers about a third of the time', () => {
    const wins: Record<string, number> = { o1: 0, o2: 0, o3: 0 };
    for (let i = 0; i < 3000; i++) wins[planAssignments(cases(1), officers(0, 0, 0), { strategy: 'EQUAL' }).picks[0]!.to]!++;
    for (const u of Object.keys(wins)) { expect(wins[u]).toBeGreaterThan(850); expect(wins[u]).toBeLessThan(1150); }
  });
  it('never gives a case to someone it excludes, and leaves it unassigned when nobody can take it', () => {
    const r = planAssignments(cases(6, ['o1']), officers(0, 0, 0), { strategy: 'EQUAL' });
    expect(count(r.picks)).toEqual({ o2: 3, o3: 3 });
    const none = planAssignments(cases(2, ['o1', 'o2', 'o3']), officers(0, 0, 0), { strategy: 'EQUAL' });
    expect(none.picks).toEqual([]);
    expect(none.unassigned).toEqual(['c0', 'c1']);
  });
  it('stops at an officer’s capacity', () => {
    const r = planAssignments(cases(10), [{ username: 'a', open: 0, capacityLeft: 2 }, { username: 'b', open: 0, capacityLeft: 3 }], { strategy: 'EQUAL' });
    expect(count(r.picks)).toEqual({ a: 2, b: 3 });
    expect(r.unassigned).toHaveLength(5);
  });
  it('prefers the officer who had the case before when they are allowed', () => {
    const r = planAssignments([{ id: 'x', exclude: new Set(), prefer: 'o3' }, { id: 'y', exclude: new Set(['o3']), prefer: 'o3' }], officers(0, 0, 5), { strategy: 'EQUAL' });
    expect(r.picks[0]!.to).toBe('o3');
    expect(r.picks[1]!.to).not.toBe('o3');
  });
  it('rotates in username order for round robin, continuing after the last officer who was given one', () => {
    const r = planAssignments(cases(5), officers(0, 0, 0), { strategy: 'ROUND_ROBIN', last: 'o2' });
    expect(r.picks.map((p) => p.to)).toEqual(['o3', 'o1', 'o2', 'o3', 'o1']);
    const skip = planAssignments(cases(3, ['o2']), officers(0, 0, 0), { strategy: 'ROUND_ROBIN' });
    expect(skip.picks.map((p) => p.to)).toEqual(['o1', 'o3', 'o1']);
  });
});

describe('who may review', () => {
  let db: Db;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it('lists active holders of kyc:review (roles, overrides and created roles applied), the super user last and never automatic', async () => {
    await addOfficer(db, 'rev.alice', ['compliance'], { displayName: 'Alice Tan' });
    await addOfficer(db, 'rev.bob', ['fraud'], { displayName: 'Bob Lim' });
    await addOfficer(db, 'rev.carol', ['call-center']);                      // does not hold the permission
    await addOfficer(db, 'rev.dave', ['compliance'], { status: 'DISABLED' }); // disabled
    await addOfficer(db, 'rev.root', [], { superuser: true, displayName: 'Root' });
    const list = await listReviewers(db);
    expect(list.map((r) => r.username).sort()).toEqual(['rev.alice', 'rev.bob', 'rev.root']);
    expect(list.find((r) => r.username === 'rev.root')).toMatchObject({ eligible: false, notEligibleReason: expect.stringMatching(/Super user/), roles: ['Super user'] });
    expect(list.find((r) => r.username === 'rev.alice')).toMatchObject({ displayName: 'Alice Tan', roles: ['KYC Compliance Officer'], eligible: true, open: 0, overdue: 0, away: false, capacityLeft: null });
    expect((await listReviewers(db, { q: 'ali*' })).map((r) => r.username)).toEqual(['rev.alice']);
    expect((await listReviewers(db, { q: 'LIM' })).map((r) => r.username)).toEqual(['rev.bob']);
    expect(await userCanReview(db, 'rev.alice')).toBe(true);
    expect(await userCanReview(db, 'rev.carol')).toBe(false);
    expect(await userCanReview(db, 'rev.dave')).toBe(false);
    expect(await userCanReview(db, 'rev.root')).toBe(true);
  });

  it('follows a role change: removing the permission from a role, or a created role that holds it', async () => {
    await addOfficer(db, 'rev.erin', ['compliance']);
    const perms = ROLES.compliance.permissions.filter((p) => p !== 'kyc:review');
    await setRolePermissions(db, 'root', 'compliance', { permissions: perms }, true);
    expect(await userCanReview(db, 'rev.erin')).toBe(false);
    expect((await listReviewers(db)).map((r) => r.username)).not.toContain('rev.erin');
    await resetRole(db, 'root', 'compliance', true);
    expect(await userCanReview(db, 'rev.erin')).toBe(true);
    const role = await createCustomRole(db, 'root', { name: 'Desk reviewer', permissions: ['kyc:review', 'customer:read'] }, true);
    await addOfficer(db, 'rev.fay', [role.id]);
    expect(await userCanReview(db, 'rev.fay')).toBe(true);
  });
});

describe('automatic assignment', () => {
  let db: Db;
  const staff = ['auto.a', 'auto.b', 'auto.c'];
  beforeAll(async () => { db = await freshDb(); for (const u of staff) await addOfficer(db, u); });
  afterAll(async () => { await db.close(); });

  it('gives each new case to the officer with the fewest open cases: 300 cases queued one by one land 100 each, with a SUBMITTED and ASSIGNED event and an audit row', async () => {
    let first = '';
    for (let i = 0; i < 300; i++) { const id = await addCase(db); if (!first) first = id; }
    expect(await holders(db)).toEqual({ 'auto.a': 100, 'auto.b': 100, 'auto.c': 100 });
    const c = await caseRow(db, first);
    expect(c).toMatchObject({ assignedBy: 'system', assignmentSource: 'AUTO', risk: 'LOW', priority: 100 });
    expect(c.caseNumber).toMatch(/^KYC-\d{6}$/);
    expect((await events(db, first)).map((e) => e.action)).toEqual(['SUBMITTED', 'ASSIGNED']);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE entity='kyc_case' AND entity_id=$1 AND action='ASSIGNED' AND actor='system'`, [first])).rows).toHaveLength(1);
  });

  it('numbers cases in order and never repeats a number', async () => {
    const nums = (await db.query(`SELECT case_number FROM kyc_cases ORDER BY created_at, case_number`)).rows.map((r) => r.caseNumber as string);
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums[0]).toBe('KYC-000001');
  });

  it('two cases queued at the same moment are not both given to the officer who looked least loaded', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'race.a'); await addOfficer(fresh, 'race.b');
      const ids = await Promise.all(Array.from({ length: 20 }, () => addCase(fresh)));
      expect(ids).toHaveLength(20);
      expect(await holders(fresh)).toEqual({ 'race.a': 10, 'race.b': 10 });
      expect((await fresh.query(`SELECT count(*)::int AS n FROM kyc_cases WHERE assigned_to IS NOT NULL`)).rows[0]!.n).toBe(20);
    } finally { await fresh.close(); }
  });

  it('spreads a backlog evenly in one sweep too, most urgent first', async () => {
    const fresh = await freshDb();
    try {
      for (const u of staff) await addOfficer(fresh, u);
      await setKycReviewSettings(fresh, 'root', { autoAssign: false });
      const ids: string[] = [];
      for (let i = 0; i < 300; i++) ids.push(await addCase(fresh, { flags: i % 100 === 0 ? ['DUPLICATE_IDENTITY'] : [] }));
      expect(await holders(fresh)).toEqual({});
      await setKycReviewSettings(fresh, 'root', { autoAssign: true });
      const r = await sweepKycReview(fresh);
      expect(r.assigned).toBe(300);
      expect(await holders(fresh)).toEqual({ 'auto.a': 100, 'auto.b': 100, 'auto.c': 100 });
      expect((await sweepKycReview(fresh)).assigned).toBe(0);    // idempotent
    } finally { await fresh.close(); }
  });

  it('leaves out an away officer, a disabled one, one without the permission, the super user and one at the limit', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'ok.one'); await addOfficer(fresh, 'ok.away'); await addOfficer(fresh, 'ok.off', ['compliance'], { status: 'DISABLED' });
      await addOfficer(fresh, 'ok.sales', ['telesales']); await addOfficer(fresh, 'ok.root', [], { superuser: true });
      await setOfficerStatus(fresh, { username: 'ok.away' }, 'ok.away', { away: true });
      for (let i = 0; i < 6; i++) await addCase(fresh);
      expect(await holders(fresh)).toEqual({ 'ok.one': 6 });
      // a limit of 8 open cases: the officer takes two more and the rest wait in the pool
      await setKycReviewSettings(fresh, 'root', { maxOpenPerOfficer: 8 });
      for (let i = 0; i < 4; i++) await addCase(fresh);
      expect(await holders(fresh)).toEqual({ 'ok.one': 8 });
      expect((await fresh.query(`SELECT count(*)::int AS n FROM kyc_cases WHERE assigned_to IS NULL`)).rows[0]!.n).toBe(2);
      expect((await listReviewers(fresh)).find((r) => r.username === 'ok.one')).toMatchObject({ open: 8, capacityLeft: 0, eligible: false });
      // the away officer is back: the sweep gives them the waiting cases
      await setOfficerStatus(fresh, { username: 'ok.away' }, 'ok.away', { away: false });
      expect((await sweepKycReview(fresh)).assigned).toBe(2);
      expect(await holders(fresh)).toEqual({ 'ok.one': 8, 'ok.away': 2 });
    } finally { await fresh.close(); }
  });

  it('never gives a case to the person who submitted or attested it; with nobody else eligible it waits and a later sweep assigns it', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'solo.a');
      const mine = await addCase(fresh, { submittedBy: 'solo.a' });
      const attested = await addCase(fresh, { submittedBy: 'clerk', attestedBy: 'solo.a' });
      expect((await caseRow(fresh, mine)).assignedTo).toBeNull();
      expect((await caseRow(fresh, attested)).assignedTo).toBeNull();
      expect((await sweepKycReview(fresh)).assigned).toBe(0);
      await addOfficer(fresh, 'solo.b');
      expect((await sweepKycReview(fresh)).assigned).toBe(2);
      expect((await caseRow(fresh, mine)).assignedTo).toBe('solo.b');
      expect((await caseRow(fresh, attested)).assignedTo).toBe('solo.b');
      // among several officers the submitter is skipped even though they are the least loaded
      const many = await freshDb();
      try {
        await addOfficer(many, 'm.a'); await addOfficer(many, 'm.b');
        for (let i = 0; i < 10; i++) await addCase(many, { submittedBy: 'm.a' });
        expect(await holders(many)).toEqual({ 'm.b': 10 });
      } finally { await many.close(); }
    } finally { await fresh.close(); }
  });

  it('does nothing when automatic assignment is off, and round robin keeps a fixed rotation', async () => {
    const fresh = await freshDb();
    try {
      for (const u of staff) await addOfficer(fresh, u);
      await setKycReviewSettings(fresh, 'root', { autoAssign: false });
      await addCase(fresh);
      expect(await holders(fresh)).toEqual({});
      await setKycReviewSettings(fresh, 'root', { autoAssign: true, strategy: 'ROUND_ROBIN' });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await addCase(fresh));
      const order = (await Promise.all(ids.map((id) => caseRow(fresh, id)))).map((c) => c.assignedTo);
      expect(order.slice(0, 3).sort()).toEqual(staff);
      expect(order.slice(3)).toEqual(order.slice(0, 3));
      await setKycReviewSettings(fresh, 'root', { strategy: 'OFF' });
      const off = await addCase(fresh);
      expect((await caseRow(fresh, off)).assignedTo).toBeNull();
    } finally { await fresh.close(); }
  });

  it('validates the settings', async () => {
    await expect(setKycReviewSettings(db, 'root', { maxOpenPerOfficer: -1 })).rejects.toThrow(/0 \(no limit\) to 1000/);
    await expect(setKycReviewSettings(db, 'root', { qaSamplePercent: 101 })).rejects.toThrow(/0 to 100/);
    await expect(setKycReviewSettings(db, 'root', { qaSamplePercent: -5 })).rejects.toThrow(/0 to 100/);
    await expect(setKycReviewSettings(db, 'root', { strategy: 'RANDOM' as never })).rejects.toThrow(/EQUAL/);
    await expect(setKycReviewSettings(db, 'root', { escalateOverdueHours: 1.5 })).rejects.toThrow(/Overdue escalation/);
    await expect(setKycReviewSettings(db, 'root', { autoAssign: 'yes' as never })).rejects.toThrow(/wrong type/);
    await expect(setKycReviewSettings(db, 'root', { nonsense: 1 } as never)).rejects.toThrow(/unknown setting/);
    expect(await getKycReviewSettings(db)).toMatchObject({ autoAssign: true, strategy: 'EQUAL', maxOpenPerOfficer: 0, stickyOnResubmit: true, redistributeAway: true, escalateOverdueHours: 12, fourEyesHighRisk: false, qaSamplePercent: 0, reopenDays: 14 });
  });
});

describe('batch assignment', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['b.one', 'b.two', 'b.three']) await addOfficer(db, u);
    await addOfficer(db, 'b.lead', ['compliance-lead']);
    await addOfficer(db, 'b.sales', ['telesales']);
    await setKycReviewSettings(db, 'root', { autoAssign: false });
  });
  afterAll(async () => { await db.close(); });

  it('assigns, reassigns (with a reason) and unassigns, skipping what cannot move and saying why', async () => {
    const waiting = await Promise.all([1, 2, 3, 4].map(() => addCase(db)));
    const done = await addCase(db);
    await db.query(`UPDATE kyc_cases SET status='APPROVED', decided_by='b.one', decided_at=now() WHERE id=$1`, [done]);
    const own = await addCase(db, { submittedBy: 'b.two' });
    const r = await assignCases(db, 'b.lead', { caseIds: [...waiting, done, own, '00000000-0000-4000-8000-000000000000'], mode: 'ASSIGN', officer: 'b.two' });
    expect(r).toMatchObject({ requested: 7, assigned: 4, perOfficer: { 'b.two': 4 } });
    const why = (id: string) => r.skipped.find((s) => s.caseId === id)?.reason;
    expect(why(done)).toBe('Already approved.');
    expect(why(own)).toMatch(/submitted this case/);
    expect(why('00000000-0000-4000-8000-000000000000')).toBe('No such case.');
    expect(r.skipped.find((s) => s.caseId === done)?.caseNumber).toMatch(/^KYC-/);
    expect(await holders(db)).toEqual({ 'b.two': 4 });
    expect((await events(db, waiting[0]!, 'ASSIGNED'))[0]).toMatchObject({ actor: 'b.lead', target: 'b.two', detail: { to: 'b.two', source: 'MANUAL' } });

    // moving cases an officer holds needs a reason
    await expect(assignCases(db, 'b.lead', { caseIds: waiting, mode: 'ASSIGN', officer: 'b.three' })).rejects.toThrow(/reason/);
    const re = await assignCases(db, 'b.lead', { caseIds: waiting.slice(0, 2), mode: 'ASSIGN', officer: 'b.three', reason: 'Balancing the desk' });
    expect(re.assigned).toBe(2);
    expect(await holders(db)).toEqual({ 'b.two': 2, 'b.three': 2 });
    const e = (await events(db, waiting[0]!, 'REASSIGNED'))[0]!;
    expect(e.detail).toMatchObject({ from: 'b.two', to: 'b.three', reason: 'Balancing the desk' });
    // assigning to the officer who already has them is a skip, not a failure
    const same = await assignCases(db, 'b.lead', { caseIds: waiting.slice(0, 2), mode: 'ASSIGN', officer: 'b.three', reason: 'again' });
    expect(same).toMatchObject({ assigned: 0 });
    expect(same.skipped[0]!.reason).toMatch(/Already assigned to b\.three/);

    const un = await assignCases(db, 'b.lead', { caseIds: waiting, mode: 'UNASSIGN', reason: 'Back to the pool' });
    expect(un.assigned).toBe(4);
    expect(await holders(db)).toEqual({});
    expect((await events(db, waiting[0]!, 'UNASSIGNED'))[0]!.detail).toMatchObject({ reason: 'Back to the pool' });
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity='kyc_case' AND action IN ('ASSIGNED','REASSIGNED','UNASSIGNED') AND actor='b.lead'`)).rows[0]!.n).toBeGreaterThanOrEqual(10);
  });

  it('refuses targets that cannot review, and an away target unless the assigner confirms', async () => {
    const id = await addCase(db);
    await expect(assignCases(db, 'b.lead', { caseIds: [id], mode: 'ASSIGN', officer: 'b.sales' })).rejects.toThrow(/may review KYC/);
    await expect(assignCases(db, 'b.lead', { caseIds: [id], mode: 'ASSIGN', officer: 'nobody' })).rejects.toThrow(/may review KYC/);
    await expect(assignCases(db, 'b.lead', { caseIds: [id], mode: 'ASSIGN' })).rejects.toThrow(/Choose the officer/);
    await expect(assignCases(db, 'b.lead', { caseIds: [], mode: 'ASSIGN', officer: 'b.one' })).rejects.toThrow(/Choose the cases/);
    await setOfficerStatus(db, { username: 'b.one' }, 'b.one', { away: true, awayUntil: new Date(Date.now() + 86_400_000).toISOString() });
    await expect(assignCases(db, 'b.lead', { caseIds: [id], mode: 'ASSIGN', officer: 'b.one' })).rejects.toThrow(/is away until .*Confirm/);
    expect((await assignCases(db, 'b.lead', { caseIds: [id], mode: 'ASSIGN', officer: 'b.one', force: true })).assigned).toBe(1);
    await setOfficerStatus(db, { username: 'b.one' }, 'b.one', { away: false });
    await assignCases(db, 'b.lead', { caseIds: [id], mode: 'UNASSIGN', reason: 'tidy' });
  });

  it('spreads 2,000 cases over chosen officers equally, considering their current load, in one call', async () => {
    const fresh = await freshDb();
    try {
      for (const u of ['d.a', 'd.b', 'd.c']) await addOfficer(fresh, u);
      await addOfficer(fresh, 'd.lead', ['compliance-lead']);
      await setKycReviewSettings(fresh, 'root', { autoAssign: false });
      const pre = await Promise.all(Array.from({ length: 10 }, () => addCase(fresh)));
      await assignCases(fresh, 'd.lead', { caseIds: pre, mode: 'ASSIGN', officer: 'd.a' });       // d.a already holds 10
      await fresh.query(`INSERT INTO kyc_cases (id, customer_id, method, source, full_name, date_of_birth, id_type, id_number_enc, id_number_hash, id_number_masked, submitted_at, submitted_by, status)
        SELECT gen_random_uuid(), NULL, 'DOCUMENT_STORE', 'CRM_CUSTOMER', 'Bulk ' || g, '1990-01-01', 'NATIONAL_ID', 'enc', 'hash' || g, 'S****000', now(), 'clerk', 'PENDING' FROM generate_series(1, 2000) g`);
      const t0 = Date.now();
      const r = await assignCases(fresh, 'd.lead', { filter: { assignee: 'unassigned' }, mode: 'DISTRIBUTE', officers: ['d.a', 'd.b', 'd.c'] });
      expect(r.requested).toBe(2000);
      expect(r.assigned).toBe(2000);
      expect(Date.now() - t0).toBeLessThan(20_000);
      // 10 + 2000 = 2010 over three officers: 670 each
      expect(await holders(fresh)).toEqual({ 'd.a': 670, 'd.b': 670, 'd.c': 670 });
      expect(Object.values(r.perOfficer).reduce((a, b) => a + b, 0)).toBe(2000);
      await expect(assignCases(fresh, 'd.lead', { filter: { assignee: 'any', status: 'PENDING' }, mode: 'DISTRIBUTE', officers: ['d.a'], reason: 'x' })).rejects.toThrow(/at most 2000/);
    } finally { await fresh.close(); }
  });

  it('notifies each new assignee once per batch, and a failing notification never fails the batch', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'n.a'); await addOfficer(fresh, 'n.b'); await addOfficer(fresh, 'n.lead', ['compliance-lead']);
      await setKycReviewSettings(fresh, 'root', { autoAssign: false });
      const ids = await Promise.all(Array.from({ length: 12 }, () => addCase(fresh)));
      await assignCases(fresh, 'n.lead', { caseIds: ids, mode: 'DISTRIBUTE', officers: ['n.a', 'n.b'] });
      const rows = (await fresh.query(`SELECT u.username, n.title, n.body FROM user_notifications n JOIN users u ON u.id = n.user_id ORDER BY u.username`)).rows;
      expect(rows.map((r) => r.username)).toEqual(['n.a', 'n.b']);
      expect(rows[0]!.body).toBe('6 KYC reviews were assigned to you.');
      await fresh.query(`DROP TABLE user_notifications CASCADE`);                 // the alert table is gone: the batch still goes through
      const more = await Promise.all(Array.from({ length: 2 }, () => addCase(fresh)));
      const r = await assignCases(fresh, 'n.lead', { caseIds: more, mode: 'DISTRIBUTE', officers: ['n.a', 'n.b'] });
      expect(r.assigned).toBe(2);
    } finally { await fresh.close(); }
  });
});

describe('claim, release, next and take over', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['k.one', 'k.two']) await addOfficer(db, u);
    await addOfficer(db, 'k.lead', ['compliance-lead']);
    await setKycReviewSettings(db, 'root', { autoAssign: false });
  });
  afterAll(async () => { await db.close(); });

  it('lets a reviewer claim an unassigned case, once, never their own submission', async () => {
    const id = await addCase(db), mine = await addCase(db, { submittedBy: 'k.one' });
    expect((await claimCase(db, 'k.one', id)).assignedTo).toBe('k.one');
    expect((await events(db, id, 'CLAIMED'))[0]).toMatchObject({ actor: 'k.one', target: 'k.one' });
    expect((await caseRow(db, id))).toMatchObject({ assignmentSource: 'CLAIMED', assignedBy: 'k.one' });
    await expect(claimCase(db, 'k.two', id)).rejects.toThrow(/already assigned to k\.one/);
    await expect(claimCase(db, 'k.one', mine)).rejects.toThrow(/submitted this case/);
  });

  it('releases to the pool with a reason: the assignee, or an assigner for anyone; not another officer', async () => {
    const id = await addCase(db);
    await claimCase(db, 'k.one', id);
    await expect(releaseCase(db, { username: 'k.one' }, id, ' ')).rejects.toThrow(/Say why/);
    await expect(releaseCase(db, { username: 'k.two' }, id, 'not mine')).rejects.toThrow(/assigned to k\.one/);
    await releaseCase(db, { username: 'k.one' }, id, 'Going to lunch and this one is long');
    const c = await caseRow(db, id);
    expect(c).toMatchObject({ assignedTo: null, avoidAssignee: 'k.one' });
    expect((await events(db, id, 'RELEASED'))[0]!.detail).toMatchObject({ from: 'k.one', reason: 'Going to lunch and this one is long' });
    await claimCase(db, 'k.two', id);
    await releaseCase(db, { username: 'k.lead', canAssign: true }, id, 'Redistributing');
    expect((await caseRow(db, id)).assignedTo).toBeNull();
  });

  it('hands out the best unassigned case with next: highest priority, oldest first, never one they submitted', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'x.one'); await addOfficer(fresh, 'x.two');
      await setKycReviewSettings(fresh, 'root', { autoAssign: false });
      const old = await addCase(fresh, { submittedHoursAgo: 1 }), older = await addCase(fresh, { submittedHoursAgo: 2 });
      const risky = await addCase(fresh, { flags: ['DUPLICATE_IDENTITY'] });
      const overdue = await addCase(fresh, { submittedHoursAgo: 30 });
      const theirs = await addCase(fresh, { flags: ['DUPLICATE_IDENTITY', 'IMAGE_REUSED'], submittedBy: 'x.one', submittedHoursAgo: 40 });
      expect((await nextCase(fresh, 'x.one')).caseId).toBe(overdue);              // overdue first (their own submission is skipped)
      expect((await nextCase(fresh, 'x.one')).caseId).toBe(risky);                // then higher risk
      expect((await nextCase(fresh, 'x.one')).caseId).toBe(older);                // then the oldest
      expect((await nextCase(fresh, 'x.two')).caseId).toBe(theirs);               // another officer may take the one x.one submitted
      expect((await nextCase(fresh, 'x.two')).caseId).toBe(old);
      expect((await nextCase(fresh, 'x.two')).caseId).toBeNull();                 // pool empty
      expect(await holders(fresh)).toEqual({ 'x.one': 3, 'x.two': 2 });
      await setKycReviewSettings(fresh, 'root', { maxOpenPerOfficer: 3 });
      await addCase(fresh);
      await expect(nextCase(fresh, 'x.one')).rejects.toThrow(/limit is 3/);
    } finally { await fresh.close(); }
  });

  it('lets an assigner take over a case someone else holds, with a reason', async () => {
    const id = await addCase(db);
    await claimCase(db, 'k.one', id);
    await expect(takeOver(db, { username: 'k.two' }, id, 'mine now')).rejects.toThrow(/permission to assign/);
    await expect(takeOver(db, { username: 'k.lead', canAssign: true }, id, '')).rejects.toThrow(/Say why/);
    await takeOver(db, { username: 'k.lead', canAssign: true }, id, 'Customer is waiting on the line');
    expect((await caseRow(db, id)).assignedTo).toBe('k.lead');
    expect((await events(db, id, 'REASSIGNED'))[0]!.detail).toMatchObject({ from: 'k.one', to: 'k.lead', reason: 'Customer is waiting on the line' });
  });
});

describe('sweeping: away officers, overdue cases', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['s.one', 's.two', 's.three']) await addOfficer(db, u);
    await addOfficer(db, 's.senior', ['compliance-lead'], { displayName: 'Senior' });
  });
  afterAll(async () => { await db.close(); });

  it('hands an away officer’s open cases to the others when they go away, and when they are disabled', async () => {
    const ids = await Promise.all(Array.from({ length: 8 }, () => addCase(db)));
    expect(ids).toHaveLength(8);
    const before = await holders(db);
    expect(Object.values(before).reduce((a, b) => a + b, 0)).toBe(8);
    const had = before['s.one'] ?? 0;
    await setOfficerStatus(db, { username: 's.one' }, 's.one', { away: true, note: 'Annual leave' });
    const after = await holders(db);
    expect(after['s.one']).toBeUndefined();
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(8);
    const moved = (await db.query(`SELECT count(*)::int AS n FROM kyc_case_events WHERE action='REASSIGNED' AND detail->>'from'='s.one' AND actor='system'`)).rows[0]!.n;
    expect(moved).toBe(had);
    expect((await db.query(`SELECT n.body FROM user_notifications n JOIN users u ON u.id=n.user_id WHERE u.username='s.one'`)).rows[0]?.body ?? '').toMatch(/handed back because you are away/);
    await setOfficerStatus(db, { username: 's.one' }, 's.one', { away: false });
    // an officer who is disabled loses their cases at the next sweep
    await db.query(`UPDATE users SET status='DISABLED' WHERE username='s.two'`);
    const r = await sweepKycReview(db);
    expect(r.redistributed).toBeGreaterThan(0);
    expect((await holders(db))['s.two']).toBeUndefined();
    await db.query(`UPDATE users SET status='ACTIVE' WHERE username='s.two'`);
  });

  it('keeps an away officer’s cases when redistribution is off', async () => {
    await setKycReviewSettings(db, 'root', { redistributeAway: false });
    const held = (await holders(db))['s.three'] ?? 0;
    await setOfficerStatus(db, { username: 's.three' }, 's.three', { away: true });
    expect((await holders(db))['s.three'] ?? 0).toBe(held);
    await setOfficerStatus(db, { username: 's.three' }, 's.three', { away: false });
    await setKycReviewSettings(db, 'root', { redistributeAway: true });
  });

  it('does not take back a case a supervisor deliberately gave an away officer (after confirming), but does take back what they held when they left', async () => {
    const [mine, forced] = [await addCase(db), await addCase(db)];
    await db.query(`UPDATE kyc_cases SET assigned_to=NULL, assigned_at=NULL, assignment_source=NULL WHERE id = ANY($1::uuid[])`, [[mine, forced]]);
    await assignCases(db, 's.senior', { caseIds: [mine!], mode: 'ASSIGN', officer: 's.three' });
    await setOfficerStatus(db, { username: 's.three' }, 's.three', { away: true });
    expect((await db.query(`SELECT assigned_to FROM kyc_cases WHERE id=$1`, [mine])).rows[0]!.assignedTo).not.toBe('s.three');   // held when they left: handed on at once
    await expect(assignCases(db, 's.senior', { caseIds: [forced!], mode: 'ASSIGN', officer: 's.three' })).rejects.toThrow(/Confirm to assign anyway/);
    await assignCases(db, 's.senior', { caseIds: [forced!], mode: 'ASSIGN', officer: 's.three', force: true });
    await sweepKycReview(db);
    expect((await db.query(`SELECT assigned_to FROM kyc_cases WHERE id=$1`, [forced])).rows[0]!.assignedTo).toBe('s.three');   // the sweep leaves a deliberate assignment alone
    await setOfficerStatus(db, { username: 's.three' }, 's.three', { away: false });
  });

  it('lets only the officer, or an assigner, change availability; the return time must be ahead', async () => {
    await expect(setOfficerStatus(db, { username: 's.two' }, 's.one', { away: true })).rejects.toThrow(/your own availability/);
    await expect(setOfficerStatus(db, { username: 's.one' }, 's.one', { away: true, awayUntil: '2020-01-01T00:00:00Z' })).rejects.toThrow(/future/);
    await expect(setOfficerStatus(db, { username: 's.senior', canAssign: true }, 'ghost', { away: true })).rejects.toThrow(/not found/);
    expect((await setOfficerStatus(db, { username: 's.senior', canAssign: true }, 's.one', { away: true, awayUntil: new Date(Date.now() + 3600_000).toISOString(), note: 'Sick' }))).toMatchObject({ away: true, note: 'Sick' });
    await db.query(`UPDATE kyc_officer_status SET away_until = now() - interval '1 minute' WHERE username='s.one'`);
    expect((await listReviewers(db)).find((r) => r.username === 's.one')).toMatchObject({ away: false });      // the leave ended by itself
  });

  it('marks cases past the review target, and escalates the assigned ones that stay open beyond the escalation delay to a senior officer', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'e.one'); await addOfficer(fresh, 'e.senior', ['compliance-lead']);
      await setKycReviewSettings(fresh, 'root', { escalateOverdueHours: 12, autoAssign: false });
      const young = await addCase(fresh, { submittedBy: 'clerk', submittedHoursAgo: 1 });
      const late = await addCase(fresh, { submittedHoursAgo: 6 });                    // target 4 h: overdue, escalation due at 16 h
      const stuck = await addCase(fresh, { submittedHoursAgo: 20 });
      await assignCases(fresh, 'e.senior', { caseIds: [young, late, stuck], mode: 'ASSIGN', officer: 'e.one' });
      const r1 = await sweepKycReview(fresh);
      expect(r1).toMatchObject({ breached: 2, escalated: 1 });
      expect((await events(fresh, late, 'SLA_BREACHED'))).toHaveLength(1);
      expect((await events(fresh, young, 'SLA_BREACHED'))).toHaveLength(0);
      const c = await caseRow(fresh, stuck);
      expect(c).toMatchObject({ escalatedBy: 'system', assignedTo: 'e.senior', assignmentSource: 'ESCALATED' });
      expect(c.priority).toBeGreaterThanOrEqual(1000 + 500);
      expect((await events(fresh, stuck, 'ESCALATED'))[0]).toMatchObject({ actor: 'system', target: 'e.senior' });
      expect((await caseRow(fresh, late)).escalatedAt).toBeNull();
      expect(await sweepKycReview(fresh)).toMatchObject({ breached: 0, escalated: 0 });   // idempotent
      await setKycReviewSettings(fresh, 'root', { escalateOverdueHours: 0 });
      const never = await addCase(fresh, { submittedHoursAgo: 100 });
      await sweepKycReview(fresh);
      expect((await caseRow(fresh, never)).escalatedAt).toBeNull();
    } finally { await fresh.close(); }
  });

  it('lets an officer escalate by hand, to a senior or a named reviewer, with a note', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'h.one'); await addOfficer(fresh, 'h.two'); await addOfficer(fresh, 'h.senior', ['compliance-lead']);
      await setKycReviewSettings(fresh, 'root', { autoAssign: false });
      const id = await addCase(fresh);
      await claimCase(fresh, 'h.one', id);
      await expect(escalateCase(fresh, { username: 'h.one' }, id, { note: ' ' })).rejects.toThrow(/Say why/);
      await expect(escalateCase(fresh, { username: 'h.two' }, id, { note: 'I want it' })).rejects.toThrow(/assigned to h\.one/);
      const r = await escalateCase(fresh, { username: 'h.one' }, id, { note: 'Looks like a forged ID' });
      expect(r.escalatedTo).toBe('h.senior');
      expect(await caseRow(fresh, id)).toMatchObject({ assignedTo: 'h.senior', escalatedBy: 'h.one', escalationNote: 'Looks like a forged ID' });
      const named = await addCase(fresh);
      expect((await escalateCase(fresh, { username: 'h.one' }, named, { note: 'second opinion', to: 'h.two' })).escalatedTo).toBe('h.two');
      await expect(escalateCase(fresh, { username: 'h.one' }, await addCase(fresh), { note: 'x', to: 'nobody' })).rejects.toThrow(/may review/);
      // nobody senior and nobody named: it is flagged and stays where it is
      const alone = await freshDb();
      try {
        await addOfficer(alone, 'a.one'); await setKycReviewSettings(alone, 'root', { autoAssign: false });
        const c = await addCase(alone); await claimCase(alone, 'a.one', c);
        expect((await escalateCase(alone, { username: 'a.one' }, c, { note: 'need help' })).escalatedTo).toBeNull();
        expect(await caseRow(alone, c)).toMatchObject({ assignedTo: 'a.one', escalatedBy: 'a.one' });
      } finally { await alone.close(); }
    } finally { await fresh.close(); }
  });
});
