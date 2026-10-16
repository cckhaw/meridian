import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { setAuthHttp } from './auth-providers.js';
import { createApiClient } from './apikeys.js';
import { saveHubEndpoint } from './integration-hub.js';
import { createCustomerWithKyc, customerKycView, getKycCase, listKycCases } from './kyc.js';
import { kycMethods, mydigitalidBegin, mydigitalidComplete, mydigitalidSession, mydigitalidTest } from './mydigitalid.js';
import { getOrder, placeOrder } from './orders.js';
import { applicationView, createApplication, submitKyc, updateApplication, type AppAccess } from './store.js';
import { freshDb, idPhoto, liveCapture } from './test-helpers.js';

let db: Db;
let n = 0;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); setAuthHttp(null); });

const ISSUER = 'https://mydigital.example.gov/oidc';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims: Record<string, unknown>) => { const data = `${b64u({ alg: 'RS256', kid: 'k1' })}.${b64u(claims)}`; return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`; };
const now = () => Math.floor(Date.now() / 1000);

let asserted: Record<string, unknown> = {};
let up = true;
function mockProvider() {
  setAuthHttp(async (url, init) => {
    const u = String(url);
    if (!up) throw new Error('offline');
    if (u.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
    if (u.endsWith('/keys')) return Response.json({ keys: [jwk] });
    if (u.endsWith('/token')) {
      const f = new URLSearchParams(String(init!.body));
      expect(f.get('code_verifier')).toBeTruthy(); expect(f.get('client_secret')).toBe('mdid-secret'); expect(f.get('client_id')).toBe('meridian-kyc');
      return Response.json({ id_token: sign({ iss: ISSUER, aud: 'meridian-kyc', sub: 'user-77', exp: now() + 300, iat: now(), ...asserted, nonce: nextNonce }) });
    }
    return new Response('?', { status: 404 });
  });
}
let nextNonce = '';

/** The person approves in their app: the provider sends the browser back with the state we gave it and a code. */
async function approve(begin: { url: string }, claims: Record<string, unknown>) {
  const q = new URL(begin.url).searchParams;
  expect(q.get('code_challenge_method')).toBe('S256');
  nextNonce = q.get('nonce')!; asserted = claims;
  return { state: q.get('state')!, redirect: q.get('redirect_uri')! };
}
const idNo = () => `S${String(4000000 + ++n)}M`;
const person = (idNumber: string) => ({ name: 'Sam Ong', id_number: idNumber, birthdate: '1991-05-05' });

describe('MyDigital ID', () => {
  beforeAll(async () => {
    mockProvider();
    await saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_MYDIGITALID', name: 'MyDigital ID', url: ISSUER, secret: 'mdid-secret',
      config: { clientId: 'meridian-kyc', redirectUriStore: 'https://shop.example.com/apply/mydigitalid', redirectUriCrm: 'https://crm.example.com/api/kyc/mydigitalid/callback' } });
  });

  it('is offered as a second way next to the photographs, and can be tested', async () => {
    expect(await kycMethods(db)).toMatchObject({ photos: true, mydigitalid: { store: true, crm: true } });
    expect(await mydigitalidTest(db)).toMatchObject({ ok: true });
    up = false; expect((await mydigitalidTest(db)).ok).toBe(false); up = true;
  });

  async function shopper(idNumber = idNo()) {
    const { client } = await createApiClient(db, 'root', { name: `mdid-shop-${++n}` });
    const { application, token } = await createApplication(db, { channel: 'SELF_SERVE', clientId: client.id, lines: [{ offerId: 'plan-sim-5g' }], ip: '203.0.113.9' });
    const acc: AppAccess = { channel: 'SELF_SERVE', clientId: client.id, token };
    await updateApplication(db, application.id as string, acc, { personal: { fullName: 'Sam Ong', dateOfBirth: '1991-05-05', nationality: 'SG', idType: 'NATIONAL_ID', idNumber, idExpiry: '2099-01-01', email: 'sam@example.com', phone: '+6591234555' }, consent: { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false } });
    return { id: application.id as string, acc, idNumber };
  }

  it('store-front: a confirmed identity approves the application without any photographs', async () => {
    const { id, acc, idNumber } = await shopper();
    const b = await mydigitalidBegin(db, { context: 'STORE', applicationId: id });
    expect(new URL(b.url).origin + new URL(b.url).pathname).toBe(`${ISSUER}/authorize`);
    const { state, redirect } = await approve(b, person(idNumber.toLowerCase()));
    expect(redirect).toBe('https://shop.example.com/apply/mydigitalid');
    expect((await mydigitalidSession(db, b.sessionId, { applicationId: id })).status).toBe('PENDING');
    const r = await mydigitalidComplete(db, { state, code: 'abc' });
    expect(r).toMatchObject({ status: 'DONE', applicationId: id });
    // confirmed, but the shopper still has the rest of the sign-up to do: nothing is decided until they submit
    expect(await applicationView(db, id, acc)).toMatchObject({ status: 'DRAFT', identity: { mydigitalid: true } });
    await updateApplication(db, id, acc, { personal: { fullName: 'Someone Else', dateOfBirth: '1991-05-05', nationality: 'SG', idType: 'NATIONAL_ID', idNumber, idExpiry: '2099-01-01', email: 'sam@example.com', phone: '+6591234555' } });
    expect(await applicationView(db, id, acc)).toMatchObject({ identity: { mydigitalid: false } });                  // changed details no longer count
    await updateApplication(db, id, acc, { personal: { fullName: 'Sam Ong', dateOfBirth: '1991-05-05', nationality: 'SG', idType: 'NATIONAL_ID', idNumber, idExpiry: '2099-01-01', email: 'sam@example.com', phone: '+6591234555' } });
    await submitKyc(db, id, acc);
    const view = await applicationView(db, id, acc) as any;
    expect(view.status).toBe('KYC_APPROVED');
    expect(view.kyc).toMatchObject({ status: 'APPROVED', method: 'MYDIGITAL_ID' });
    const c = (await db.query(`SELECT method, decided_by, checks FROM kyc_cases WHERE application_id=$1`, [id])).rows[0]!;
    expect(c).toMatchObject({ method: 'MYDIGITAL_ID', decidedBy: 'mydigital-id' });
    expect(c.checks.mydigitalid).toMatchObject({ matched: { idNumber: true, name: true, dateOfBirth: true } });
    expect(JSON.stringify(c.checks)).not.toContain(idNumber);
    expect((await db.query(`SELECT count(*)::int AS n FROM documents WHERE application_id=$1`, [id])).rows[0]!.n).toBe(0);
    await expect(mydigitalidComplete(db, { state, code: 'abc' })).rejects.toThrow(/already used|expired/);       // one use only
    expect((await mydigitalidSession(db, b.sessionId, { applicationId: id })).status).toBe('DONE');
    await expect(mydigitalidSession(db, b.sessionId, { applicationId: (await shopper()).id })).rejects.toThrow(/not found/);   // not someone else's
  });

  it('does not approve, and says what to do, when the details differ or the person says no', async () => {
    const { id, idNumber } = await shopper();
    const wrongId = await approve(await mydigitalidBegin(db, { context: 'STORE', applicationId: id }), person(idNo()));
    const r1 = await mydigitalidComplete(db, { state: wrongId.state, code: 'abc' });
    expect(r1).toMatchObject({ status: 'FAILED' });
    expect(r1.message).toMatch(/do not match.*ID number.*photographs/);
    const wrongDob = await approve(await mydigitalidBegin(db, { context: 'STORE', applicationId: id }), { ...person(idNumber), birthdate: '1980-01-01' });
    expect((await mydigitalidComplete(db, { state: wrongDob.state, code: 'abc' })).message).toMatch(/date of birth/);
    const b = await mydigitalidBegin(db, { context: 'STORE', applicationId: id });
    const denied = await mydigitalidComplete(db, { state: new URL(b.url).searchParams.get('state')!, error: 'access_denied' });
    expect(denied).toMatchObject({ status: 'FAILED' });
    expect(denied.message).toMatch(/did not approve/);
    expect((await db.query(`SELECT status, method FROM kyc_cases WHERE application_id=$1`, [id])).rows[0]).toMatchObject({ status: 'PENDING', method: 'DOCUMENT_REMOTE' });        // nothing was decided
    // and the photographs route is still open to the same application
    expect((await db.query(`SELECT status FROM applications WHERE id=$1`, [id])).rows[0]!.status).toBe('DRAFT');
  });

  it('is clear when the provider is down, and refuses a forged answer', async () => {
    const { id, idNumber } = await shopper();
    const b = await mydigitalidBegin(db, { context: 'STORE', applicationId: id });
    up = false;
    const r = await mydigitalidComplete(db, { state: new URL(b.url).searchParams.get('state')!, code: 'abc' });
    up = true;
    expect(r).toMatchObject({ status: 'FAILED' }); expect(r.message).toMatch(/photographs/);
    const b2 = await mydigitalidBegin(db, { context: 'STORE', applicationId: id });
    const q = new URL(b2.url).searchParams; nextNonce = 'someone-elses-nonce'; asserted = person(idNumber);
    expect((await mydigitalidComplete(db, { state: q.get('state')!, code: 'abc' })).status).toBe('FAILED');
    await expect(mydigitalidComplete(db, { state: 'made-up-state-value', code: 'x' })).rejects.toThrow(/expired|already used/);
  });

  it('CRM, new customer: the customer is created only when the identity is confirmed, then verified', async () => {
    const idNumber = idNo();
    const draft = { customer: { segment: 'CONSUMER', displayName: 'Sam Ong', idDocument: idNumber, email: 'sam@example.com', phone: '+6591230001', dateOfBirth: '1991-05-05' } as never, identity: { idType: 'NATIONAL_ID' as const, idNumber, idExpiry: '2099-01-01' }, source: 'CRM_ORDER' as const };
    const before = Number((await db.query(`SELECT count(*) AS n FROM customers`)).rows[0]!.n);
    const b = await mydigitalidBegin(db, { context: 'CRM_NEW', draft, actor: 'clerk.one' });
    expect(Number((await db.query(`SELECT count(*) AS n FROM customers`)).rows[0]!.n)).toBe(before);          // nothing yet
    expect(JSON.stringify((await db.query(`SELECT draft FROM kyc_provider_sessions WHERE id=$1`, [b.sessionId])).rows[0])).not.toContain(idNumber);   // the form waits encrypted
    const { state, redirect } = await approve(b, person(idNumber));
    expect(redirect).toBe('https://crm.example.com/api/kyc/mydigitalid/callback');
    await expect(mydigitalidSession(db, b.sessionId, { actor: 'someone.else' })).rejects.toThrow(/not found/);
    const r = await mydigitalidComplete(db, { state, code: 'abc' });
    expect(r).toMatchObject({ status: 'DONE', context: 'CRM_NEW', caseStatus: 'APPROVED' });
    const poll = await mydigitalidSession(db, b.sessionId, { actor: 'clerk.one' });
    expect(poll).toMatchObject({ status: 'DONE', customerId: r.customerId });
    expect((await db.query(`SELECT kyc_status FROM customers WHERE id=$1`, [r.customerId])).rows[0]!.kycStatus).toBe('VERIFIED');
    expect((await db.query(`SELECT draft FROM kyc_provider_sessions WHERE id=$1`, [b.sessionId])).rows[0]!.draft).toEqual({});   // the typed details are not kept
    const o = await placeOrder(db, { customerId: r.customerId!, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH', confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] });
    expect((await getOrder(db, o.id as string)).kycHold).toBe(false);
    const view = await customerKycView(db, r.customerId!) as any;
    expect(view.case).toMatchObject({ status: 'APPROVED', method: 'MYDIGITAL_ID' });
    expect(view.case.documents).toEqual([]);
  });

  it('CRM, existing customer: confirms them and releases the order that was waiting', async () => {
    const idNumber = idNo();
    const made = await createCustomerWithKyc(db, { segment: 'CONSUMER', displayName: 'Sam Ong', idDocument: idNumber, email: 'sam@example.com', phone: '+6591230002', dateOfBirth: '1991-05-05' },
      { source: 'CRM_ORDER', actor: 'clerk.one', storeId: 'STORE-SG-001', evidence: (['ID_FRONT', 'ID_BACK', 'SELFIE'] as const).map((kind) => ({ kind, bytes: idPhoto(), capture: liveCapture() })), identity: { idType: 'NATIONAL_ID', idExpiry: '2099-01-01', dateOfBirth: '1991-05-05' } } as never);
    const cid = made.customer.id as string;
    expect(made.kyc.status).toBe('PENDING');
    const o = await placeOrder(db, { customerId: cid, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH', confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] });
    expect((await getOrder(db, o.id as string)).kycHold).toBe(true);
    // a pending photograph review is in the way: the case must be decided or sent back first
    const b = await mydigitalidBegin(db, { context: 'CRM_EXISTING', customerId: cid, actor: 'clerk.one', draft: { identity: { idType: 'NATIONAL_ID', idNumber } } });
    const r = await mydigitalidComplete(db, { state: (await approve(b, person(idNumber))).state, code: 'abc' });
    expect(r.status).toBe('FAILED');
    expect(r.message).toMatch(/already waiting/);
  });

  it('with automatic approval off, the confirmation goes to a reviewer, who sees what MyDigital ID said', async () => {
    const e = (await db.query(`SELECT id FROM integration_endpoints WHERE kind='KYC_MYDIGITALID'`)).rows[0]!.id;
    await saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'KYC_MYDIGITALID', name: 'MyDigital ID', url: ISSUER, config: { clientId: 'meridian-kyc', autoApprove: false, redirectUriStore: 'https://shop.example.com/apply/mydigitalid' } }, e);
    const { id, acc, idNumber } = await shopper();
    const r = await mydigitalidComplete(db, { state: (await approve(await mydigitalidBegin(db, { context: 'STORE', applicationId: id }), person(idNumber))).state, code: 'abc' });
    expect(r.status).toBe('DONE');
    await submitKyc(db, id, acc);
    const item = (await listKycCases(db, { status: 'PENDING' })).items.find((c) => c.applicationId === id)!;
    expect(item.method).toBe('MYDIGITAL_ID');
    expect(((await getKycCase(db, item.id as string, 'compliance.one')) as any).checks.mydigitalid).toMatchObject({ provider: 'MYDIGITAL_ID' });
    await expect(mydigitalidBegin(db, { context: 'CRM_EXISTING', customerId: id, draft: { identity: { idType: 'NATIONAL_ID', idNumber } } })).rejects.toThrow(/not set up for this channel/);   // the CRM address was removed
    expect(await kycMethods(db)).toMatchObject({ mydigitalid: { store: true, crm: false } });
  });
});
