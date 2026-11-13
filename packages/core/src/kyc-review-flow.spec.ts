import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { createCustomerWithKyc, decideKycCase, getKycCase, listKycCases, reopenCase, secondReview, submitCustomerKyc, type Evidence, type IdentityInput } from './kyc.js';
import { addKycNote, claimCase, getKycReviewSettings, qaReview, setKycReviewSettings, sweepKycReview } from './kyc-review.js';
import { addCase, addOfficer, caseRow, events } from './kyc-review-helpers.js';
import { placeOrder } from './orders.js';
import { getStoreSettings } from './store-settings.js';
import { freshDb, idPhoto, liveCapture } from './test-helpers.js';

const LEAD = { username: 'lead', canAssign: true, canSenior: true };
const settings = (db: Db) => getStoreSettings(db);

describe('deciding a case', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['d.one', 'd.two']) await addOfficer(db, u);
    await addOfficer(db, 'lead', ['compliance-lead'], { displayName: 'Lena Lead' });
    await setKycReviewSettings(db, 'root', { autoAssign: false });
  });
  afterAll(async () => { await db.close(); });

  it('lets only the assignee decide an assigned case, and names who holds it', async () => {
    const id = await addCase(db);
    await claimCase(db, 'd.one', id);
    await expect(decideKycCase(db, id, 'd.two', { decision: 'APPROVE' }, await settings(db))).rejects.toThrow(/assigned to d\.one\. Only they, or a supervisor/);
    const done = await decideKycCase(db, id, 'd.one', { decision: 'APPROVE', reason: 'Clear photos' }, await settings(db));
    expect(done).toMatchObject({ status: 'APPROVED', decidedBy: 'd.one' });
    const e = (await events(db, id, 'DECIDED'))[0]!;
    expect(e).toMatchObject({ actor: 'd.one' });
    expect(e.detail).toMatchObject({ decision: 'APPROVE', source: 'CRM_CUSTOMER', risk: 'LOW', withinSla: true, overdue: false });
    expect(typeof e.detail.minutes).toBe('number');
    expect((await db.query(`SELECT 1 FROM audit_log WHERE entity='kyc_case' AND entity_id=$1 AND action='APPROVE' AND actor='d.one'`, [id])).rows).toHaveLength(1);
  });

  it('lets an assigner decide for the assignee, recorded as on behalf', async () => {
    const id = await addCase(db);
    await claimCase(db, 'd.one', id);
    const done = await decideKycCase(db, id, 'lead', { decision: 'REJECT', reason: 'Photo is not an ID', reasonCode: 'NOT_AN_ID' }, await settings(db), { canAssign: true });
    expect(done).toMatchObject({ status: 'REJECTED', decidedBy: 'lead' });
    expect((await events(db, id, 'DECIDED'))[0]!.detail).toMatchObject({ onBehalf: true, assignedTo: 'd.one', decision: 'REJECT', reasonCode: 'NOT_AN_ID' });
  });

  it('takes an unassigned case for whoever decides it, and keeps the submitter from approving their own', async () => {
    const id = await addCase(db);
    await decideKycCase(db, id, 'd.two', { decision: 'REJECT', reason: 'Blurred', reasonCode: 'UNREADABLE' }, await settings(db));
    expect(await caseRow(db, id)).toMatchObject({ assignedTo: 'd.two', assignmentSource: 'CLAIMED', status: 'REJECTED' });
    expect((await events(db, id)).map((e) => e.action)).toEqual(['SUBMITTED', 'CLAIMED', 'DECIDED']);
    const own = await addCase(db, { submittedBy: 'd.one' });
    await expect(decideKycCase(db, own, 'd.one', { decision: 'APPROVE' }, await settings(db))).rejects.toThrow(/different person/);
    expect((await caseRow(db, own)).assignedTo).toBeNull();                   // the refusal left nothing behind
  });

  it('records when the assignee first opened the case, once, and what each person may do with it', async () => {
    const id = await addCase(db);
    await claimCase(db, 'd.one', id);
    expect((await caseRow(db, id)).firstOpenedAt).toBeNull();
    const other = await getKycCase(db, id, 'd.two', { username: 'd.two' });
    expect(other).toMatchObject({ canDecide: false, canClaim: false, canRelease: false, canAssign: false, canEscalate: false, canReopen: false, assignedToName: 'd.one', caseNumber: expect.stringMatching(/^KYC-/), risk: 'LOW' });
    expect(other.decideBlockedReason).toMatch(/assigned to d\.one/);
    expect((await events(db, id, 'OPENED'))).toHaveLength(0);
    const mine = await getKycCase(db, id, 'd.one', { username: 'd.one' });
    expect(mine).toMatchObject({ canDecide: true, canRelease: true, canEscalate: true, canAssign: false, decideBlockedReason: null });
    await getKycCase(db, id, 'd.one', { username: 'd.one' });
    expect((await events(db, id, 'OPENED'))).toHaveLength(1);
    expect((await caseRow(db, id)).firstOpenedAt).not.toBeNull();
    const lead = await getKycCase(db, id, 'lead', LEAD);
    expect(lead).toMatchObject({ canDecide: true, canRelease: true, canAssign: true, canEscalate: true });
    expect(lead.events.map((e: any) => e.action)).toEqual(['SUBMITTED', 'CLAIMED', 'OPENED']);
    expect(lead.events[1]).toMatchObject({ actor: 'd.one', actorName: 'd.one' });
    expect(lead.events[0]).toMatchObject({ actor: 'clerk.one' });
    const nobody = await addCase(db);
    expect(await getKycCase(db, nobody, 'd.two', { username: 'd.two' })).toMatchObject({ canClaim: true, canDecide: true });
  });

  it('keeps notes on the timeline', async () => {
    const id = await addCase(db);
    await addKycNote(db, 'd.two', id, 'Called the applicant, will send a clearer photo');
    await expect(addKycNote(db, 'd.two', id, '  ')).rejects.toThrow(/Write the note/);
    const v = await getKycCase(db, id, 'lead', LEAD);
    expect(v.notes).toEqual([expect.objectContaining({ actor: 'd.two', text: 'Called the applicant, will send a clearer photo' })]);
    expect(v.events.map((e: any) => e.action)).toContain('NOTE');
  });

  it('asks for the checklist only when switched on, and then every applicable tick or a note', async () => {
    const id = await addCase(db);
    await claimCase(db, 'd.one', id);
    const ok = { documentLegible: true, photoMatchesId: null, detailsMatchId: true, notExpired: true, ageOk: true, notDuplicate: true };
    await decideKycCase(db, await addCase(db), 'd.one', { decision: 'APPROVE' }, await settings(db));                 // off: no checklist needed
    await setKycReviewSettings(db, 'root', { requireChecklist: true });
    await expect(decideKycCase(db, id, 'd.one', { decision: 'APPROVE' }, await settings(db))).rejects.toThrow(/Tick every check/);
    await expect(decideKycCase(db, id, 'd.one', { decision: 'APPROVE', checklist: { ...ok, notDuplicate: false } }, await settings(db))).rejects.toThrow(/Tick every check/);
    const done = await decideKycCase(db, id, 'd.one', { decision: 'APPROVE', checklist: { ...ok, notDuplicate: false, notes: 'Same family, different person: confirmed by phone' } }, await settings(db));
    expect(done.status).toBe('APPROVED');
    expect((await caseRow(db, id)).checklist).toMatchObject({ notDuplicate: false, notes: expect.stringMatching(/confirmed by phone/) });
    expect((await events(db, id, 'DECIDED'))[0]!.detail.checklist).toMatchObject({ documentLegible: true });
    const second = await addCase(db); await claimCase(db, 'd.one', second);
    expect((await decideKycCase(db, second, 'd.one', { decision: 'APPROVE', checklist: ok }, await settings(db))).status).toBe('APPROVED');
    const third = await addCase(db); await claimCase(db, 'd.one', third);
    expect((await decideKycCase(db, third, 'd.one', { decision: 'REJECT', reason: 'Not an ID' }, await settings(db))).status).toBe('REJECTED');   // rejecting needs no checklist
    await setKycReviewSettings(db, 'root', { requireChecklist: false });
  });
});

describe('with real customers: sending back, resubmitting, reopening', () => {
  let db: Db;
  let n = 0;
  const identity = (over: Partial<IdentityInput> = {}): Omit<IdentityInput, 'idNumber'> => ({ idType: 'NATIONAL_ID', idExpiry: '2099-01-01', dateOfBirth: '1990-04-12', ...over });
  const shots = (): Evidence[] => (['ID_FRONT', 'ID_BACK', 'SELFIE'] as const).map((kind) => ({ kind, bytes: idPhoto(), capture: liveCapture() }));
  const crm = { source: 'CRM_ORDER' as const, actor: 'clerk.one', storeId: 'STORE-SG-001' };
  async function applicant() {
    const idDocument = `S${String(5000000 + ++n)}K`;
    const made = await createCustomerWithKyc(db, { segment: 'CONSUMER', displayName: `Casey ${n}`, idDocument, email: 'casey@example.com', phone: '+6591230000', dateOfBirth: '1990-04-12' }, { ...crm, evidence: shots(), identity: identity() } as never);
    return { customerId: made.customer.id as string, caseId: made.kyc.caseId, idDocument };
  }
  const order = (customerId: string) => ({ customerId, channel: 'RETAIL_ASSISTED' as const, attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' as const, confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] });

  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['r.one', 'r.two', 'r.three']) await addOfficer(db, u);
    await addOfficer(db, 'lead', ['compliance-lead']);
  });
  afterAll(async () => { await db.close(); });

  it('gives every submitted customer case an officer, an event trail and a number, and counts the orders waiting on it', async () => {
    const a = await applicant();
    const c = await caseRow(db, a.caseId);
    expect(c).toMatchObject({ assignmentSource: 'AUTO', assignedBy: 'system', risk: 'LOW' });
    expect(c.assignedTo).toMatch(/^r\./);
    expect((await events(db, a.caseId)).map((e) => e.action)).toEqual(['CREATED', 'SUBMITTED', 'ASSIGNED']);
    await placeOrder(db, order(a.customerId));
    await sweepKycReview(db);
    const item = (await listKycCases(db, { status: 'PENDING' })).items.find((i) => i.id === a.caseId)!;
    expect(item).toMatchObject({ waitingOrders: 1, assignedTo: c.assignedTo, caseNumber: c.caseNumber });
    expect(item.priority).toBe(150);                       // LOW 100, an order waits 50
  });

  it('sends a returned case back to the officer who returned it when it is submitted again', async () => {
    const a = await applicant();
    const first = (await caseRow(db, a.caseId)).assignedTo as string;
    await decideKycCase(db, a.caseId, first, { decision: 'RETURN', reason: 'Selfie is dark', reasonCode: 'UNREADABLE' }, await settings(db));
    const returned = await caseRow(db, a.caseId);
    expect(returned).toMatchObject({ status: 'RETURNED', assignedTo: null, previousAssignee: first });
    expect((await events(db, a.caseId, 'RETURNED'))[0]!.detail).toMatchObject({ decision: 'RETURN', reasonCode: 'UNREADABLE' });
    await submitCustomerKyc(db, { customerId: a.customerId, ...crm, evidence: shots(), identity: { ...identity(), idNumber: a.idDocument } });
    const again = await caseRow(db, a.caseId);
    expect(again).toMatchObject({ status: 'PENDING', assignedTo: first, previousAssignee: null });
    expect((await events(db, a.caseId)).map((e) => e.action).slice(-3)).toEqual(['RETURNED', 'SUBMITTED', 'ASSIGNED']);
    // with stickiness off the load decides again
    await setKycReviewSettings(db, 'root', { stickyOnResubmit: false });
    await decideKycCase(db, a.caseId, first, { decision: 'RETURN', reason: 'Still dark', reasonCode: 'UNREADABLE' }, await settings(db));
    await db.query(`UPDATE users SET status='DISABLED' WHERE username=$1`, [first]);
    await submitCustomerKyc(db, { customerId: a.customerId, ...crm, evidence: shots(), identity: { ...identity(), idNumber: a.idDocument } });
    expect((await caseRow(db, a.caseId)).assignedTo).not.toBe(first);                     // a disabled officer is never given a case back
    await db.query(`UPDATE users SET status='ACTIVE' WHERE username=$1`, [first]);
    await setKycReviewSettings(db, 'root', { stickyOnResubmit: true });
  });

  it('reopens a rejected case within the window: it waits again, the customer is in review, it returns to the officer who decided', async () => {
    const a = await applicant();
    const who = (await caseRow(db, a.caseId)).assignedTo as string;
    await decideKycCase(db, a.caseId, who, { decision: 'REJECT', reason: 'Name does not match', reasonCode: 'MISMATCH' }, await settings(db));
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [a.customerId])).rows[0]!.kycStatus).toBe('REJECTED');
    await expect(reopenCase(db, { username: who }, a.caseId, 'I was wrong')).rejects.toThrow(/senior officer or a supervisor/);
    await expect(reopenCase(db, LEAD, a.caseId, ' ')).rejects.toThrow(/Say why/);
    const r = await reopenCase(db, LEAD, a.caseId, 'The applicant sent a deed poll');
    expect(r).toMatchObject({ status: 'PENDING', assignedTo: who });
    expect(await caseRow(db, a.caseId)).toMatchObject({ reopenedCount: 1, decidedBy: null, decidedAt: null, assignmentSource: 'AUTO' });
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [a.customerId])).rows[0]!.kycStatus).toBe('PENDING_REVIEW');
    expect((await events(db, a.caseId, 'REOPENED'))[0]).toMatchObject({ actor: 'lead', target: who, detail: { reason: 'The applicant sent a deed poll', from: 'REJECTED', decidedBy: who } });
    expect((await decideKycCase(db, a.caseId, who, { decision: 'APPROVE', reason: 'Deed poll seen' }, await settings(db))).status).toBe('APPROVED');
  });

  it('does not reopen a rejection reported as fraud, or one past the window', async () => {
    const a = await applicant();
    const who = (await caseRow(db, a.caseId)).assignedTo as string;
    await decideKycCase(db, a.caseId, who, { decision: 'REJECT', reason: 'Forged', reasonCode: 'SUSPECTED_FRAUD' }, await settings(db));
    await expect(reopenCase(db, LEAD, a.caseId, 'try')).rejects.toThrow(/suspected fraud/);
    const b = await applicant();
    const who2 = (await caseRow(db, b.caseId)).assignedTo as string;
    await decideKycCase(db, b.caseId, who2, { decision: 'REJECT', reason: 'Blurred', reasonCode: 'UNREADABLE' }, await settings(db));
    await db.query(`UPDATE kyc_cases SET decided_at = now() - interval '15 days' WHERE id=$1`, [b.caseId]);
    await expect(reopenCase(db, LEAD, b.caseId, 'late')).rejects.toThrow(/14 days/);
    await setKycReviewSettings(db, 'root', { reopenDays: 30 });
    expect((await reopenCase(db, LEAD, b.caseId, 'within a month')).status).toBe('PENDING');
    await setKycReviewSettings(db, 'root', { reopenDays: 14 });
    const pending = await applicant();
    await expect(reopenCase(db, LEAD, pending.caseId, 'x')).rejects.toThrow(/Only a decided case/);
  });

  it('reopens an approved case only while no service has been activated from it', async () => {
    const quiet = await applicant();
    const w1 = (await caseRow(db, quiet.caseId)).assignedTo as string;
    await decideKycCase(db, quiet.caseId, w1, { decision: 'APPROVE', reason: 'ok' }, await settings(db));
    expect((await getKycCase(db, quiet.caseId, 'lead', LEAD)).canReopen).toBe(true);
    expect((await getKycCase(db, quiet.caseId, w1, { username: w1 })).canReopen).toBe(false);
    expect((await reopenCase(db, LEAD, quiet.caseId, 'Second look requested')).status).toBe('PENDING');
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [quiet.customerId])).rows[0]!.kycStatus).toBe('PENDING_REVIEW');

    const live = await applicant();
    await placeOrder(db, order(live.customerId));
    const w2 = (await caseRow(db, live.caseId)).assignedTo as string;
    await decideKycCase(db, live.caseId, w2, { decision: 'APPROVE', reason: 'ok' }, await settings(db));
    expect((await db.query(`SELECT count(*)::int AS n FROM services WHERE customer_id=$1`, [live.customerId])).rows[0]!.n).toBeGreaterThan(0);
    const view = await getKycCase(db, live.caseId, 'lead', LEAD);
    expect(view).toMatchObject({ canReopen: false });
    expect(view.reopenBlockedReason).toMatch(/service was activated/);
    await expect(reopenCase(db, LEAD, live.caseId, 'no')).rejects.toThrow(/service was activated/);
  });
});

describe('four eyes on a high risk case', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['m.one', 'm.two', 'm.three']) await addOfficer(db, u);
    await setKycReviewSettings(db, 'root', { autoAssign: false, fourEyesHighRisk: true });
  });
  afterAll(async () => { await db.close(); });

  it('keeps the first decision as a recommendation and routes the case to a different officer, who confirms it', async () => {
    const id = await addCase(db, { flags: ['DUPLICATE_IDENTITY'] });
    await claimCase(db, 'm.one', id);
    expect((await caseRow(db, id)).risk).toBe('HIGH');
    const r = await decideKycCase(db, id, 'm.one', { decision: 'APPROVE', reason: 'Same person, new ID' }, await settings(db));
    expect(r).toMatchObject({ status: 'PENDING', awaitingSecondReview: true });
    const c = await caseRow(db, id);
    expect(c.status).toBe('PENDING');
    expect(c.assignedTo).toMatch(/^m\.(two|three)$/);
    expect(c.secondReview).toMatchObject({ status: 'AWAITING', recommended: 'APPROVE', by: 'm.one', note: 'Same person, new ID' });
    expect((await events(db, id, 'RECOMMENDED'))[0]).toMatchObject({ actor: 'm.one', target: c.assignedTo });
    expect((await events(db, id, 'DECIDED'))).toHaveLength(0);
    expect((await db.query(`SELECT n.title FROM user_notifications n JOIN users u ON u.id=n.user_id WHERE u.username=$1`, [c.assignedTo])).rows.map((x) => x.title)).toContain('Second review requested');
    // the first officer cannot be the second, even by deciding normally
    await expect(decideKycCase(db, id, 'm.one', { decision: 'APPROVE' }, await settings(db))).rejects.toThrow(/different officer must confirm/);
    await expect(secondReview(db, { username: 'm.one' }, id, { decision: 'CONFIRM' }, await settings(db))).rejects.toThrow(/different officer|assigned to/);
    const second = c.assignedTo as string;
    const done = await secondReview(db, { username: second }, id, { decision: 'CONFIRM', note: 'Agree' }, await settings(db));
    expect(done).toMatchObject({ status: 'APPROVED', decidedBy: second });
    expect((await events(db, id, 'SECOND_REVIEW_DECIDED'))[0]!.detail).toMatchObject({ decision: 'CONFIRM', recommended: 'APPROVE', applied: 'APPROVE', recommendedBy: 'm.one' });
    expect((await events(db, id, 'DECIDED'))[0]!.detail).toMatchObject({ secondReview: true, recommendedBy: 'm.one' });
    expect((await caseRow(db, id)).secondReview).toMatchObject({ status: 'DONE', secondDecision: 'CONFIRM' });
    await expect(secondReview(db, { username: second }, id, { decision: 'CONFIRM' }, await settings(db))).rejects.toThrow(/not waiting for a second review/);
  });

  it('lets the second officer override, with a note, and only their decision is applied', async () => {
    const id = await addCase(db, { flags: ['IMAGE_REUSED'] });
    await claimCase(db, 'm.one', id);
    await decideKycCase(db, id, 'm.one', { decision: 'APPROVE' }, await settings(db));
    const second = (await caseRow(db, id)).assignedTo as string;
    await expect(secondReview(db, { username: second }, id, { decision: 'OVERRIDE' }, await settings(db))).rejects.toThrow(/what you decide instead/);
    await expect(secondReview(db, { username: second }, id, { decision: 'OVERRIDE', decisionBody: { decision: 'REJECT', reason: 'Picture is on another case' } }, await settings(db))).rejects.toThrow(/Explain why you override/);
    const done = await secondReview(db, { username: second }, id, { decision: 'OVERRIDE', decisionBody: { decision: 'REJECT', reason: 'Picture is on another case', reasonCode: 'SUSPECTED_FRAUD' }, note: 'Seen on KYC-000001' }, await settings(db));
    expect(done).toMatchObject({ status: 'REJECTED', decidedBy: second });
    expect((await events(db, id, 'SECOND_REVIEW_DECIDED'))[0]!.detail).toMatchObject({ decision: 'OVERRIDE', recommended: 'APPROVE', applied: 'REJECT' });
  });

  it('applies to approvals and rejections of HIGH risk cases only; sending back and low risk cases are decided at once', async () => {
    const low = await addCase(db); await claimCase(db, 'm.one', low);
    expect((await decideKycCase(db, low, 'm.one', { decision: 'APPROVE' }, await settings(db))).status).toBe('APPROVED');
    const high = await addCase(db, { flags: ['DUPLICATE_IDENTITY'] }); await claimCase(db, 'm.one', high);
    expect((await decideKycCase(db, high, 'm.one', { decision: 'RETURN', reason: 'Need a clearer photo' }, await settings(db))).status).toBe('RETURNED');
    const reject = await addCase(db, { flags: ['DUPLICATE_IDENTITY'] }); await claimCase(db, 'm.two', reject);
    expect((await decideKycCase(db, reject, 'm.two', { decision: 'REJECT', reason: 'Not an ID' }, await settings(db)))).toMatchObject({ status: 'PENDING', awaitingSecondReview: true });
  });

  it('puts the case back in the pool when nobody else can take it, where only someone else may claim it', async () => {
    const fresh = await freshDb();
    try {
      await addOfficer(fresh, 'only.one'); await addOfficer(fresh, 'only.two');
      await setKycReviewSettings(fresh, 'root', { autoAssign: false, fourEyesHighRisk: true });
      await fresh.query(`UPDATE users SET status='DISABLED' WHERE username='only.two'`);
      const id = await addCase(fresh, { flags: ['DUPLICATE_IDENTITY'] });
      await claimCase(fresh, 'only.one', id);
      const r = await decideKycCase(fresh, id, 'only.one', { decision: 'REJECT', reason: 'Forged' }, await settings(fresh));
      expect(r).toMatchObject({ awaitingSecondReview: true, secondReviewer: null });
      expect((await caseRow(fresh, id)).assignedTo).toBeNull();
      await expect(claimCase(fresh, 'only.one', id)).rejects.toThrow(/first recommendation/);
      await fresh.query(`UPDATE users SET status='ACTIVE' WHERE username='only.two'`);
      expect((await claimCase(fresh, 'only.two', id)).assignedTo).toBe('only.two');
    } finally { await fresh.close(); }
  });
});

describe('quality sampling', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
    for (const u of ['q.one', 'q.two']) await addOfficer(db, u);
    await setKycReviewSettings(db, 'root', { autoAssign: false });
  });
  afterAll(async () => { await db.close(); });

  it('samples nothing at 0 percent, and every approval at 100 percent, for a different officer', async () => {
    const none = await addCase(db); await claimCase(db, 'q.one', none);
    await decideKycCase(db, none, 'q.one', { decision: 'APPROVE' }, await settings(db));
    expect((await caseRow(db, none)).qaAssignedTo).toBeNull();
    await setKycReviewSettings(db, 'root', { qaSamplePercent: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const id = await addCase(db); await claimCase(db, 'q.one', id); await decideKycCase(db, id, 'q.one', { decision: 'APPROVE' }, await settings(db)); ids.push(id); }
    for (const id of ids) expect((await caseRow(db, id)).qaAssignedTo).toBe('q.two');
    const rejected = await addCase(db); await claimCase(db, 'q.one', rejected);
    await decideKycCase(db, rejected, 'q.one', { decision: 'REJECT', reason: 'no' }, await settings(db));
    expect((await caseRow(db, rejected)).qaAssignedTo).toBeNull();                         // only approvals are sampled
    expect((await events(db, ids[0]!, 'QA_SAMPLED'))[0]).toMatchObject({ actor: 'system', target: 'q.two', detail: { decider: 'q.one' } });
  });

  it('lists my quality checks, and records agree or disagree (a disagreement needs a note); only the officer asked may answer', async () => {
    const mine = await listKycCases(db, { qa: true, me: 'q.two' });
    expect(mine.items).toHaveLength(5);
    expect(mine.items[0]).toMatchObject({ status: 'APPROVED', qaAssignedTo: 'q.two', qaResult: null, decidedBy: 'q.one' });
    expect((await listKycCases(db, { qa: true, me: 'q.one' })).items).toHaveLength(0);
    const id = mine.items[0]!.id as string;
    await expect(qaReview(db, 'q.one', id, { result: 'AGREE' })).rejects.toThrow(/not waiting for your quality check/);
    await expect(qaReview(db, 'q.two', id, { result: 'DISAGREE' })).rejects.toThrow(/Say what you disagree with/);
    await qaReview(db, 'q.two', id, { result: 'DISAGREE', note: 'The ID had expired' });
    await expect(qaReview(db, 'q.two', id, { result: 'AGREE' })).rejects.toThrow(/already done/);
    expect(await caseRow(db, id)).toMatchObject({ qaResult: 'DISAGREE', qaBy: 'q.two', qaNote: 'The ID had expired' });
    expect((await events(db, id, 'QA_DONE'))[0]).toMatchObject({ actor: 'q.two', target: 'q.one', detail: { result: 'DISAGREE' } });
    expect((await listKycCases(db, { qa: true, me: 'q.two' })).items).toHaveLength(4);
    await qaReview(db, 'q.two', mine.items[1]!.id as string, { result: 'AGREE' });
    expect(await getKycReviewSettings(db)).toMatchObject({ qaSamplePercent: 100 });
  });

  it('skips sampling when nobody else could check', async () => {
    const solo = await freshDb();
    try {
      await addOfficer(solo, 'z.one');
      await setKycReviewSettings(solo, 'root', { autoAssign: false, qaSamplePercent: 100 });
      const id = await addCase(solo); await claimCase(solo, 'z.one', id);
      await decideKycCase(solo, id, 'z.one', { decision: 'APPROVE' }, await settings(solo));
      expect((await caseRow(solo, id)).qaAssignedTo).toBeNull();
    } finally { await solo.close(); }
  });
});
