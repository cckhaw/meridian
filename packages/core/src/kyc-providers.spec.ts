import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { saveHubEndpoint } from './integration-hub.js';
import { createCustomerWithKyc, decideKycCase, getKycCase, type Evidence, type IdentityInput } from './kyc.js';
import { DEFAULT_MAP, judge, sameName, setKycProviderHttp } from './kyc-providers.js';
import { getOrder, placeOrder } from './orders.js';
import { getStoreSettings } from './store-settings.js';
import { freshDb, idPhoto, liveCapture } from './test-helpers.js';

let db: Db;
let n = 0;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
afterEach(() => setKycProviderHttp(null));

const claimed = { fullName: 'Casey Lim', dateOfBirth: '1990-04-12', idNumber: 'S2000001K', idExpiry: '2099-01-01' };
const st = { map: DEFAULT_MAP, passValues: ['PASS'], failValues: ['FAIL'], faceMatchMin: 0.8, faceFailBelow: 0.3 };
const clean = { verdict: 'PASS', extracted: { fullName: 'LIM CASEY', dateOfBirth: '1990-04-12', idNumber: 's2000001k', expiry: '2099-01-01' }, faceMatch: { score: 0.93 }, liveness: { result: 'PASS' }, id: 'abc' };

describe('reading the ID check service’s answer', () => {
  it('passes a clean answer and compares what was read with what was typed', () => {
    expect(judge(clean, claimed, st)).toMatchObject({ status: 'PASS', reasons: [], reference: 'abc', checks: { document: 'PASS', nameMatch: true, dobMatch: true, idNumberMatch: true, faceMatch: 0.93, liveness: 'PASS' } });
    expect(sameName('Ahmad bin Ali', 'ALI AHMAD')).toBe(true);
    expect(sameName('Casey Lim', 'Someone Else')).toBe(false);
  });
  it('sends a doubtful answer to a person, with the reasons', () => {
    expect(judge({ ...clean, extracted: { ...clean.extracted, fullName: 'JANE TAN' } }, claimed, st)).toMatchObject({ status: 'REVIEW', checks: { nameMatch: false } });
    expect(judge({ ...clean, extracted: { ...clean.extracted, dateOfBirth: '12/04/1991' } }, claimed, st).reasons.join(' ')).toMatch(/date of birth/);
    expect(judge({ ...clean, faceMatch: { score: 62 } }, claimed, st)).toMatchObject({ status: 'REVIEW', checks: { faceMatch: 0.62 } });   // a score out of 100 is a percentage
    expect(judge({ ...clean, liveness: { result: 'FAIL' } }, claimed, st).status).toBe('REVIEW');
    expect(judge({ ...clean, verdict: 'REFER' }, claimed, st).status).toBe('REVIEW');
    expect(judge({ unrelated: true }, claimed, st).status).toBe('REVIEW');                                       // nothing could be read: not a pass
  });
  it('fails only when the service says no or the face is clearly someone else', () => {
    expect(judge({ ...clean, verdict: 'FAIL', reasons: ['altered'] }, claimed, st)).toMatchObject({ status: 'FAIL', reasons: expect.arrayContaining([expect.stringMatching(/altered/)]) });
    expect(judge({ ...clean, faceMatch: { score: 0.1 } }, claimed, st).status).toBe('FAIL');
  });
  it('carries on when the service checks the document only', () => {
    expect(judge({ verdict: 'PASS' }, claimed, st)).toMatchObject({ status: 'PASS', checks: { faceMatch: null, liveness: null, nameMatch: null } });
    expect(judge({ result: { ok: true } }, claimed, { ...st, map: { ...DEFAULT_MAP, verdict: 'result.ok' }, passValues: ['TRUE'] }).status).toBe('PASS');   // booleans and custom paths
  });
});

const identity = (): Omit<IdentityInput, 'idNumber'> => ({ idType: 'NATIONAL_ID', idExpiry: '2099-01-01', dateOfBirth: '1990-04-12' });
const shots = (): Evidence[] => (['ID_FRONT', 'ID_BACK', 'SELFIE'] as const).map((kind) => ({ kind, bytes: idPhoto(), capture: liveCapture() }));
const idNo = (tail = '') => `S${String(3000000 + ++n)}${tail || 'K'}`;
const newCustomer = (idDocument = idNo()) => createCustomerWithKyc(db, { segment: 'CONSUMER', displayName: 'Casey Lim', idDocument, email: 'casey@example.com', phone: '+6591230000', dateOfBirth: '1990-04-12' },
  { source: 'CRM_ORDER', actor: 'clerk.one', storeId: 'STORE-SG-001', evidence: shots(), identity: identity() } as never);
const order = (customerId: string) => ({ customerId, channel: 'RETAIL_ASSISTED' as const, attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' as const, confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] });

describe('a connected service decides, a person handles the rest', () => {
  let seen: any[] = [];
  const ok = (b: any) => ({ ...clean, extracted: { ...clean.extracted, idNumber: b.claimed.idNumber } });
  const service = (answer: (body: any) => unknown | Promise<unknown>) => setKycProviderHttp(async (url, init) => { const body = JSON.parse(init.body); seen.push({ url, headers: init.headers, body }); return { ok: true, status: 200, json: async () => answer(body) }; });

  beforeAll(async () => {
    await saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_OCR', name: 'IDCheck', url: 'https://ocr.example.com/v1/check', secret: 'k-123', config: { mode: 'REST', authKind: 'BEARER' } });
  });

  it('sends the photographs and what was typed, signed in with the secret', async () => {
    seen = []; service(ok);
    await newCustomer('S2000001K');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://ocr.example.com/v1/check');
    expect(seen[0].headers.authorization).toBe('Bearer k-123');
    expect(Object.keys(seen[0].body.images).sort()).toEqual(['ID_BACK', 'ID_FRONT', 'SELFIE']);
    expect(seen[0].body.claimed).toMatchObject({ fullName: 'Casey Lim', dateOfBirth: '1990-04-12', idNumber: 'S2000001K' });
  });

  it('pass and clean: the customer is verified, no review task, and the waiting order is released', async () => {
    service(ok);
    const made = await newCustomer();
    expect(made.kyc.status).toBe('APPROVED');
    expect(made.customer.kycStatus).toBe('VERIFIED');
    const view = await getKycCase(db, made.kyc.caseId, 'compliance.one') as any;
    expect(view.decidedBy).toBe('id-check-service');
    expect(view.checks.provider).toMatchObject({ status: 'PASS', mode: 'REST' });
    const o = await placeOrder(db, order(made.customer.id as string));
    expect((await getOrder(db, o.id as string)).kycHold).toBe(false);
  });

  it('doubtful: a review task opens with the verdict in front of the reviewer, and the order waits', async () => {
    service((b) => ({ ...ok(b), faceMatch: { score: 0.55 } }));
    const made = await newCustomer();
    expect(made.kyc).toMatchObject({ status: 'PENDING', flags: ['PROVIDER_REVIEW'] });
    const o = await placeOrder(db, order(made.customer.id as string));
    expect((await getOrder(db, o.id as string)).kycHold).toBe(true);
    const view = await getKycCase(db, made.kyc.caseId, 'compliance.one') as any;
    expect(view.checks.provider).toMatchObject({ status: 'REVIEW', checks: { faceMatch: 0.55 } });
    await decideKycCase(db, made.kyc.caseId, 'compliance.one', { decision: 'APPROVE' }, await getStoreSettings(db));
    expect((await getOrder(db, o.id as string)).kycHold).toBe(false);
  });

  it('fail: the customer is rejected and the order is cancelled and refunded', async () => {
    service((b) => ({ ...ok(b), verdict: 'FAIL', reasons: ['The document looks altered.'] }));
    const made = await newCustomer();
    expect(made.kyc.status).toBe('REJECTED');
    expect(made.customer.kycStatus).toBe('REJECTED');
    await expect(placeOrder(db, order(made.customer.id as string))).rejects.toThrow(/not approved/);
    const view = await getKycCase(db, made.kyc.caseId, 'compliance.one') as any;
    expect(view).toMatchObject({ decidedBy: 'id-check-service', reasonCode: 'PROVIDER' });
    expect(view.decisionReason).toMatch(/altered/);
  });

  it('unreachable: drops to manual review, rejects no one, and does not stop the order wait', async () => {
    setKycProviderHttp(async () => { throw new Error('ECONNREFUSED'); });
    const a = await newCustomer();
    expect(a.kyc).toMatchObject({ status: 'PENDING', flags: ['PROVIDER_UNAVAILABLE'] });
    setKycProviderHttp(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const b = await newCustomer();
    expect(b.kyc).toMatchObject({ status: 'PENDING', flags: ['PROVIDER_UNAVAILABLE'] });
    setKycProviderHttp(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    expect((await newCustomer()).kyc.status).toBe('PENDING');
    expect(((await getKycCase(db, a.kyc.caseId, 'compliance.one')) as any).checks.provider.reasons[0]).toMatch(/could not be used/);
  });

  it('with automatic approval off, even a clean pass goes to a person', async () => {
    await saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_OCR', name: 'IDCheck', url: 'https://ocr.example.com/v1/check', config: { mode: 'REST', authKind: 'BEARER', autoApprove: false } },
      (await db.query(`SELECT id FROM integration_endpoints WHERE kind='KYC_OCR'`)).rows[0]!.id);
    service(ok);
    expect((await newCustomer()).kyc.status).toBe('PENDING');
  });

  it('the built-in simulator answers by the ID number’s ending', async () => {
    await saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_OCR', name: 'IDCheck', config: { mode: 'SIMULATOR' } }, (await db.query(`SELECT id FROM integration_endpoints WHERE kind='KYC_OCR'`)).rows[0]!.id);
    expect((await newCustomer(idNo('A'))).kyc.status).toBe('APPROVED');
    expect((await newCustomer(idNo('0000'))).kyc.status).toBe('PENDING');
    expect((await newCustomer(idNo('9999'))).kyc.status).toBe('REJECTED');
    expect((await newCustomer(idNo('5555'))).kyc.flags).toEqual(['PROVIDER_UNAVAILABLE']);
  });

  it('refuses settings that cannot work', async () => {
    await expect(saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_OCR', name: 'Bad', config: { mode: 'REST' } })).rejects.toThrow(/address/);
    await expect(saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_OCR', name: 'Bad', url: 'https://x.example.com', config: { faceMatchMin: 0.5, faceFailBelow: 0.7 } })).rejects.toThrow(/cannot be higher/);
  });
});
