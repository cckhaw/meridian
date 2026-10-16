import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applicationView, checkout, createApplication, submitKyc, testGatewayOutcome, updateApplication, uploadDocument, type AppAccess } from './store.js';
import { createApiClient } from './apikeys.js';
import { getStoreSettings, setStoreSettings } from './store-settings.js';
import type { Db } from './db.js';
import { sweepDocuments } from './documents.js';
import { blacklistHit } from './fraud.js';
import { createCustomerWithKyc, customerKycView, decideKycCase, getKycCase, getKycDocument, kycQueueCounts, listKycCases, submitCustomerKyc, type IdentityInput, type Evidence } from './kyc.js';
import { getOrder, placeOrder } from './orders.js';
import { hashIdDocument } from './customers.js';
import { freshDb, idPhoto, liveCapture } from './test-helpers.js';

let db: Db;
let n = 0;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const identity = (over: Partial<IdentityInput> = {}): Omit<IdentityInput, 'idNumber'> => ({ idType: 'NATIONAL_ID', idExpiry: '2099-01-01', dateOfBirth: '1990-04-12', ...over });
const shots = (kinds: Evidence['kind'][] = ['ID_FRONT', 'ID_BACK', 'SELFIE']): Evidence[] => kinds.map((kind) => ({ kind, bytes: idPhoto(), capture: liveCapture() }));
const idNo = () => `S${String(2000000 + ++n)}K`;
const crm = (over: Record<string, unknown> = {}) => ({ source: 'CRM_ORDER' as const, actor: 'clerk.one', storeId: 'STORE-SG-001', evidence: shots(), ...over });
async function newCustomer(over: { idDocument?: string; displayName?: string; identity?: Partial<IdentityInput>; evidence?: Evidence[] } = {}) {
  return createCustomerWithKyc(db, { segment: 'CONSUMER', displayName: over.displayName ?? 'Casey Lim', idDocument: over.idDocument ?? idNo(), email: 'casey@example.com', phone: '+6591230000', dateOfBirth: '1990-04-12' },
    { ...crm(over.evidence ? { evidence: over.evidence } : {}), identity: identity(over.identity) } as never);
}
const order = (customerId: string) => ({ customerId, channel: 'RETAIL_ASSISTED' as const, attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' as const, confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] });
const settings = () => getStoreSettings(db);

describe('a customer made in the CRM cannot exist without an identity check', () => {
  it('creates the customer, keeps the photographs in the vault and opens a review task, all together', async () => {
    const made = await newCustomer();
    expect(made.kyc).toMatchObject({ status: 'PENDING', flags: [] });
    const cid = made.customer.id as string;
    expect(made.customer.kycStatus).toBe('PENDING_REVIEW');
    const docs = (await db.query(`SELECT kind, category, customer_id, kyc_case_id, encrypted, status, storage, meta FROM documents WHERE kyc_case_id=$1 ORDER BY category`, [made.kyc.caseId])).rows;
    expect(docs.map((d) => d.category)).toEqual(['NATIONAL_ID_BACK', 'NATIONAL_ID_FRONT', 'SELFIE']);
    for (const d of docs) expect(d).toMatchObject({ kind: 'KYC', customerId: cid, encrypted: true, status: 'PENDING_VERIFICATION' });
    expect(docs[0]!.meta.capture).toMatchObject({ method: 'LIVE_CAMERA', width: 1280, height: 800 });
    expect((await db.query(`SELECT count(*)::int AS n FROM kyc_documents WHERE case_id=$1`, [made.kyc.caseId])).rows[0]!.n).toBe(0);   // nothing goes to the older table
    expect((await db.query(`SELECT count(*)::int AS n FROM document_audit_log WHERE customer_id=$1 AND action='UPLOAD'`, [cid])).rows[0]!.n).toBe(3);

    // the review task is in the queue, with its source and no application
    const item = (await listKycCases(db, { status: 'PENDING' })).items.find((c) => c.id === made.kyc.caseId)!;
    expect(item).toMatchObject({ source: 'CRM_ORDER', applicationId: null, customerId: cid, overdue: false, waitingOrders: 0 });
    expect((await kycQueueCounts(db)).waiting).toBeGreaterThanOrEqual(1);
    const view = await customerKycView(db, cid) as any;
    expect(view).toMatchObject({ status: 'PENDING_REVIEW', case: { status: 'PENDING', source: 'CRM_ORDER' } });
    expect(view.case.documents.map((d: any) => d.kind).sort()).toEqual(['ID_BACK', 'ID_FRONT', 'SELFIE']);
    expect(JSON.stringify(view)).not.toMatch(/data|base64/i);
  });

  it('refuses, and leaves nothing behind, when the photographs or the person do not pass', async () => {
    const before = Number((await db.query(`SELECT count(*) AS n FROM customers`)).rows[0]!.n);
    await expect(newCustomer({ evidence: shots(['ID_FRONT', 'ID_BACK']) })).rejects.toThrow(/selfie/);                                       // a photograph is missing
    await expect(newCustomer({ evidence: shots(['ID_FRONT', 'SELFIE'])})).rejects.toThrow(/back of the ID/);
    await expect(newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: idPhoto({ exif: true }), capture: liveCapture() }, ...shots(['ID_BACK', 'SELFIE'])] })).rejects.toThrow(/gallery/);   // picked from the album
    await expect(newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: idPhoto() }, ...shots(['ID_BACK', 'SELFIE'])] })).rejects.toThrow(/camera/);                                      // no proof it was live
    await expect(newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: Buffer.from('%PDF-1.4 x'), capture: liveCapture() }, ...shots(['ID_BACK', 'SELFIE'])] })).rejects.toThrow(/camera/);
    await expect(newCustomer({ identity: { dateOfBirth: '2015-01-01' } })).rejects.toThrow(/minimum age/);                                   // under age
    await expect(newCustomer({ identity: { idExpiry: '2001-01-01' } })).rejects.toThrow(/expired/);                                          // expired ID
    await expect(newCustomer({ identity: { idType: 'PASSPORT', idExpiry: undefined } })).rejects.toThrow(/expiry date of the passport/);
    expect(Number((await db.query(`SELECT count(*) AS n FROM customers`)).rows[0]!.n)).toBe(before);                                          // not even a half-made customer
  });

  it('asks a company for the registration certificate and the signatory’s ID instead of a selfie', async () => {
    await expect(createCustomerWithKyc(db, { segment: 'ENTERPRISE', displayName: 'Acme Pte Ltd', idDocument: 'UEN-2026-0001' }, { ...crm(), identity: identity() } as never)).rejects.toThrow(/registration certificate/);
    const made = await createCustomerWithKyc(db, { segment: 'ENTERPRISE', displayName: 'Acme Pte Ltd', idDocument: 'UEN-2026-0002' }, { ...crm({ evidence: shots(['COMPANY_REGISTRATION', 'ID_FRONT', 'ID_BACK']) }), identity: identity() } as never);
    expect(made.kyc.status).toBe('PENDING');
  });

  it('can start a check for a customer who exists without one, but only with the ID the record holds', async () => {
    const { createCustomer } = await import('./customers.js');
    const num = idNo();
    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Old Record', idDocument: num, dateOfBirth: '1980-02-02' });
    const call = (idNumber: string) => db.tx((q) => submitCustomerKyc(q, { customerId: customer.id as string, source: 'CRM_CUSTOMER', actor: 'clerk.one', identity: { ...identity({ dateOfBirth: undefined }), idNumber }, evidence: shots() }));
    await expect(call('S0000000Z')).rejects.toThrow(/does not match/);
    const c = await call(num);
    expect(c).toMatchObject({ status: 'PENDING', source: 'CRM_CUSTOMER' });
    expect((await customerKycView(db, customer.id as string) as any).status).toBe('PENDING_REVIEW');
    await expect(call(num)).rejects.toThrow(/already waiting/);
  });
});

describe('the order waits for the identity, then follows the decision', () => {
  it('takes the order, keeps the service off, and switches it on when a different person approves', async () => {
    const { customer, kyc } = await newCustomer();
    const cid = customer.id as string;
    const o = await placeOrder(db, order(cid));
    expect(o.state).toBe('FULFILMENT');
    const held = await getOrder(db, o.id as string);
    expect(held).toMatchObject({ kycHold: true, serviceCount: 0 });
    expect(held.pendingTasks).toContain('KYC');
    expect((await db.query(`SELECT count(*)::int AS n FROM services WHERE customer_id=$1`, [cid])).rows[0]!.n).toBe(0);
    expect((await listKycCases(db, { status: 'PENDING' })).items.find((c) => c.id === kyc.caseId)).toMatchObject({ waitingOrders: 1 });
    expect(((await getKycCase(db, kyc.caseId, 'compliance.one')).waitingOrders as any[]).map((w) => w.id)).toEqual([o.id]);

    await expect(decideKycCase(db, kyc.caseId, 'clerk.one', { decision: 'APPROVE' }, await settings())).rejects.toThrow(/different person/);   // four eyes
    await decideKycCase(db, kyc.caseId, 'compliance.one', { decision: 'APPROVE' }, await settings());
    const done = await getOrder(db, o.id as string);
    expect(done).toMatchObject({ state: 'COMPLETED', kycHold: false, serviceCount: 1 });
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [cid])).rows[0]!.kycStatus).toBe('VERIFIED');
    expect((await db.query(`SELECT status, verified_by FROM documents WHERE kyc_case_id=$1 AND status <> 'SUPERSEDED'`, [kyc.caseId])).rows.every((d) => d.status === 'VERIFIED_MANUAL' && d.verifiedBy === 'compliance.one')).toBe(true);
    expect(done.history.some((h: any) => /Identity verified/.test(h.reason ?? ''))).toBe(true);
  });

  it('cancels and refunds the order, marks the customer rejected, and can report the ID to the fraud register', async () => {
    const num = idNo();
    const { customer, kyc } = await newCustomer({ idDocument: num, displayName: 'Dodgy Dan' });
    const cid = customer.id as string;
    const o = await placeOrder(db, order(cid));
    expect((await getOrder(db, o.id as string)).kycHold).toBe(true);
    await expect(decideKycCase(db, kyc.caseId, 'compliance.one', { decision: 'REJECT' }, await settings())).rejects.toThrow(/reason/);
    await expect(decideKycCase(db, kyc.caseId, 'compliance.one', { decision: 'REJECT', reason: 'photo of a screen', reportFraud: true }, await settings())).rejects.toThrow(/not allowed/);
    await decideKycCase(db, kyc.caseId, 'compliance.one', { decision: 'REJECT', reason: 'Not an ID: a picture of a screen', reasonCode: 'SUSPECTED_FRAUD', reportFraud: true }, await settings(), { canReportFraud: true });
    expect((await getOrder(db, o.id as string)).state).toBe('CANCELLED');
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [cid])).rows[0]!.kycStatus).toBe('REJECTED');
    expect((await db.query(`SELECT status FROM documents WHERE kyc_case_id=$1 AND status <> 'SUPERSEDED'`, [kyc.caseId])).rows.every((d) => d.status === 'REJECTED')).toBe(true);
    expect(await blacklistHit(db, { idHash: hashIdDocument(num) })).toBe('ID_DOCUMENT');
    await expect(placeOrder(db, order(cid))).rejects.toThrow(/not approved/);                                                                       // no further sales
    await expect(db.tx((q) => submitCustomerKyc(q, { customerId: cid, source: 'CRM_CUSTOMER', actor: 'clerk.one', identity: { ...identity(), idNumber: num }, evidence: shots() }))).rejects.toThrow(/suspected fraud/);
  });

  it('can be sent back for new photographs while the order keeps waiting, and the second submission is reviewed again', async () => {
    const num = idNo();
    const { customer, kyc } = await newCustomer({ idDocument: num });
    const cid = customer.id as string;
    const o = await placeOrder(db, order(cid));
    await decideKycCase(db, kyc.caseId, 'compliance.one', { decision: 'RETURN', reason: 'Back of the ID is blurred', reasonCode: 'UNREADABLE' }, await settings());
    const v = await customerKycView(db, cid) as any;
    expect(v).toMatchObject({ status: 'NOT_VERIFIED', case: { status: 'RETURNED', reason: 'Back of the ID is blurred', canResubmit: true } });
    expect((await getOrder(db, o.id as string)).kycHold).toBe(true);
    const again = await db.tx((q) => submitCustomerKyc(q, { customerId: cid, source: 'CRM_ORDER', actor: 'clerk.one', identity: { ...identity(), idNumber: num }, evidence: shots(['ID_BACK']) }));
    expect(again).toMatchObject({ id: kyc.caseId, status: 'PENDING' });                                                                              // same case, replaced photograph
    const live = (await db.query(`SELECT category, status FROM documents WHERE kyc_case_id=$1 ORDER BY category, created_at`, [kyc.caseId])).rows;
    expect(live.filter((d) => d.status === 'SUPERSEDED')).toHaveLength(1);
    await decideKycCase(db, kyc.caseId, 'compliance.two', { decision: 'APPROVE' }, await settings());
    expect((await getOrder(db, o.id as string)).state).toBe('COMPLETED');
  });

  it('flags a picture already used by another case, and shows the reviewer which photographs were live', async () => {
    const shared = idPhoto({ seed: 'borrowed-id' });
    const a = await newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: shared, capture: liveCapture() }, ...shots(['ID_BACK', 'SELFIE'])] });
    expect(a.kyc.flags).toEqual([]);
    const b = await newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: shared, capture: liveCapture() }, ...shots(['ID_BACK', 'SELFIE'])] });
    expect(b.kyc.flags).toContain('IMAGE_REUSED');
    const detail = await getKycCase(db, b.kyc.caseId, 'compliance.one') as any;
    expect(detail.documents).toHaveLength(3);
    expect(detail.documents.every((d: any) => d.live && d.width === 1280)).toBe(true);
    const file = await getKycDocument(db, detail.documents[0].id, { username: 'compliance.one', ip: '10.0.0.9' });
    expect(file.contentType).toBe('image/jpeg');
    expect(file.bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('with the gate before the order, nothing is sold until the check is approved', async () => {
    const s = await settings();
    await setStoreSettings(db, 'root', { ...s, kycGate: 'BEFORE_ORDER' });
    try {
      const { customer, kyc } = await newCustomer();
      await expect(placeOrder(db, order(customer.id as string))).rejects.toThrow(/Identity verification/);
      await decideKycCase(db, kyc.caseId, 'compliance.one', { decision: 'APPROVE' }, await settings());
      expect((await placeOrder(db, order(customer.id as string))).state).toBe('COMPLETED');
    } finally { await setStoreSettings(db, 'root', s); }
  });

  it('auto mode approves a clean case without a person, and still refers a doubtful one', async () => {
    const s = await settings();
    await setStoreSettings(db, 'root', { ...s, kycMode: 'auto' });
    try {
      const clean = await newCustomer();
      expect(clean.kyc.status).toBe('APPROVED');
      expect(clean.customer.kycStatus).toBe('VERIFIED');
      const shared = idPhoto({ seed: 'auto-reused' });
      await newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: shared, capture: liveCapture() }, ...shots(['ID_BACK', 'SELFIE'])] });
      const doubtful = await newCustomer({ evidence: [{ kind: 'ID_FRONT', bytes: shared, capture: liveCapture() }, ...shots(['ID_BACK', 'SELFIE'])] });
      expect(doubtful.kyc.status).toBe('PENDING');
    } finally { await setStoreSettings(db, 'root', s); }
  });
});

describe('the store-front does the same', () => {
  async function shopper() {
    const { client } = await createApiClient(db, 'root', { name: `kyc-shop-${++n}` });
    const { application, token } = await createApplication(db, { channel: 'SELF_SERVE', clientId: client.id, lines: [{ offerId: 'plan-sim-5g' }], ip: '203.0.113.9' });
    const acc: AppAccess = { channel: 'SELF_SERVE', clientId: client.id, token };
    const personal = { fullName: 'Sam Ong', dateOfBirth: '1991-05-05', nationality: 'SG', idType: 'NATIONAL_ID' as const, idNumber: idNo(), idExpiry: '2099-01-01', email: 'sam@example.com', phone: '+6591234555' };
    await updateApplication(db, application.id as string, acc, { personal, consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false } });
    return { id: application.id as string, acc };
  }
  const photos = async (id: string, acc: AppAccess) => { for (const k of ['ID_FRONT', 'ID_BACK', 'SELFIE'] as const) await uploadDocument(db, id, acc, k, idPhoto(), liveCapture()); };

  it('keeps the photographs in the vault, queues a review task, and lets a clean applicant finish the order while it waits', async () => {
    const { id, acc } = await shopper();
    await photos(id, acc);
    expect((await db.query(`SELECT count(*)::int AS n FROM documents WHERE application_id=$1 AND kyc_case_id IS NOT NULL AND storage <> 'KYC_LEGACY'`, [id])).rows[0]!.n).toBe(3);
    expect((await db.query(`SELECT count(*)::int AS n FROM kyc_documents WHERE application_id=$1`, [id])).rows[0]!.n).toBe(0);
    await submitKyc(db, id, acc);
    const view = await applicationView(db, id, acc) as any;
    expect(view).toMatchObject({ status: 'KYC_REVIEW', documents: ['ID_BACK', 'ID_FRONT', 'SELFIE'], kyc: { needsReview: true, canOrderWhileWaiting: true } });
    const c = (await listKycCases(db, { status: 'PENDING' })).items.find((x) => x.applicationId === id)!;
    expect(c).toMatchObject({ source: 'STOREFRONT' });

    // the review takes days; unclaimed-upload clean-up must not remove evidence that is still being reviewed
    await db.query(`UPDATE documents SET created_at = now() - interval '30 days' WHERE application_id=$1`, [id]);
    await sweepDocuments(db);
    expect((await db.query(`SELECT count(*)::int AS n FROM documents WHERE application_id=$1 AND purged_at IS NULL`, [id])).rows[0]!.n).toBe(3);

    const out = await checkout(db, id, acc);                                                                                                         // no waiting for a person
    const custId = out.application.customerId as string;
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [custId])).rows[0]!.kycStatus).toBe('PENDING_REVIEW');
    expect((await db.query(`SELECT count(*)::int AS n FROM documents WHERE kyc_case_id=$1 AND customer_id=$2`, [c.id, custId])).rows[0]!.n).toBe(3);   // now the customer's
    await testGatewayOutcome(db, id, acc, 'succeed');
    const paid = await getOrder(db, out.order.id as string);
    expect(paid).toMatchObject({ state: 'FULFILMENT', kycHold: true, serviceCount: 0 });

    await decideKycCase(db, c.id, 'compliance.one', { decision: 'APPROVE' }, await settings());
    expect(await getOrder(db, out.order.id as string)).toMatchObject({ state: 'COMPLETED', serviceCount: 1 });
    expect((await applicationView(db, id, acc) as any).status).toBe('ORDERED');                                                                      // a decision never rewinds an order
  });

  it('rejects and refunds when the review fails; a case with a flag still has to be decided before checkout', async () => {
    const a = await shopper();
    await photos(a.id, a.acc); await submitKyc(db, a.id, a.acc);
    const out = await checkout(db, a.id, a.acc);
    await testGatewayOutcome(db, a.id, a.acc, 'succeed');
    const c = (await listKycCases(db, { status: 'PENDING' })).items.find((x) => x.applicationId === a.id)!;
    await expect(decideKycCase(db, c.id, 'compliance.one', { decision: 'RETURN', reason: 'blurred' }, await settings())).rejects.toThrow(/already been placed/);
    await decideKycCase(db, c.id, 'compliance.one', { decision: 'REJECT', reason: 'Selfie does not match the ID', reasonCode: 'MISMATCH' }, await settings());
    expect(await getOrder(db, out.order.id as string)).toMatchObject({ state: 'CANCELLED' });
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [out.application.customerId])).rows[0]!.kycStatus).toBe('REJECTED');

    const b = await shopper();
    const shared = idPhoto({ seed: 'store-reuse' });
    const first = await shopper();
    await uploadDocument(db, first.id, first.acc, 'ID_FRONT', shared, liveCapture());
    await uploadDocument(db, first.id, first.acc, 'ID_BACK', idPhoto(), liveCapture()); await uploadDocument(db, first.id, first.acc, 'SELFIE', idPhoto(), liveCapture());
    await uploadDocument(db, b.id, b.acc, 'ID_FRONT', shared, liveCapture());
    await uploadDocument(db, b.id, b.acc, 'ID_BACK', idPhoto(), liveCapture()); await uploadDocument(db, b.id, b.acc, 'SELFIE', idPhoto(), liveCapture());
    await submitKyc(db, b.id, b.acc);
    expect((await applicationView(db, b.id, b.acc) as any).kyc.canOrderWhileWaiting).toBe(false);                                                    // flagged: a person decides first
    await expect(checkout(db, b.id, b.acc)).rejects.toThrow(/still being reviewed/);
  });
});
