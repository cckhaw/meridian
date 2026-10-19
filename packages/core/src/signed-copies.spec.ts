import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureStarterTemplates } from './doc-templates.js';
import type { Db } from './db.js';
import { saveHubEndpoint } from './integration-hub.js';
import { placeOrder } from './orders.js';
import { setOtpHttp } from './otp-gateway.js';
import { setSecurityPolicy, getSecurityPolicy } from './security-policy.js';
import { deliverSignedCopies, NO_GATEWAY, retryFailedSignedCopies, signedCopyStatus } from './signed-copies.js';
import { freshDb, newCustomer, signatureDataUrl } from './test-helpers.js';

let db: Db;
let calls: Array<{ url: string; body: any }> = [];
let status = 200;
beforeAll(async () => { db = await freshDb(); await ensureStarterTemplates(db, { username: 'root' }); });
afterAll(async () => { await db.close(); setOtpHttp(null); });
beforeEach(() => { calls = []; status = 200; setOtpHttp(async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init!.body)) }); return new Response('{}', { status }); }); });

const signedOrder = async (phone: string | null = '+6591230000') => {
  const customer = (await newCustomer(db, { phone: phone ?? undefined })).customer;
  const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: '1 Test Road', lines: [{ offerId: 'plan-sim-5g' }], agreement: { signature: { image: signatureDataUrl(), signerName: 'Sam Lee' }, ip: '203.0.113.5', userAgent: 'vitest' } });
  return { customer, o };
};
const row = async (orderId: string) => (await db.query(`SELECT * FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND payload->>'orderId'=$1`, [orderId])).rows[0]!;

describe('signed agreement delivery through the messaging gateway', () => {
  it('stays queued, untouched, while no gateway is configured, and the status says so', async () => {
    const { o } = await signedOrder();
    const r = await deliverSignedCopies(db);
    expect(r).toMatchObject({ sent: 0, failed: 0, reason: NO_GATEWAY });
    expect(r.waiting).toBeGreaterThan(0);
    expect(await row(o.id)).toMatchObject({ attempts: 0, deliveredAt: null, failedAt: null });
    expect(calls).toHaveLength(0);
    expect(await signedCopyStatus(db)).toMatchObject({ gateway: { configured: false }, blocked: NO_GATEWAY });
  });
  it('waits for the public address when a link cannot be built, then sends one message per copy with a time-limited link', async () => {
    await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'WA', url: 'https://sms.example.com/send', secret: 'tok', config: { deliver: 'WHATSAPP', templateIds: { CONTRACT: 'tpl_contract' } } });
    const { o } = await signedOrder();
    const waiting = await deliverSignedCopies(db);
    expect(waiting.reason).toMatch(/public address/);
    expect(calls).toHaveLength(0);
    expect(await row(o.id)).toMatchObject({ attempts: 0, deliveredAt: null });
    await setSecurityPolicy(db, 'root', { recovery: { ...(await getSecurityPolicy(db)).recovery, publicUrl: 'https://crm.example.com' } });
    const r = await deliverSignedCopies(db);
    expect(r.failed).toBe(0);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);   // the starter templates give two agreements for this plan: one message each
    expect(calls[0]!.body).toMatchObject({ to: '+6591230000', channel: 'WHATSAPP', templateId: 'tpl_contract' });
    expect(calls[0]!.body.text).toMatch(/https:\/\/crm\.example\.com\/api\/documents\/file\/\S+/);
    expect(calls[0]!.body.text).toMatch(/15 minutes/);
    const done = await row(o.id);
    expect(done.deliveredAt).not.toBeNull();
    expect(done.payload).toMatchObject({ deliveredVia: 'WHATSAPP' });
    expect(done.payload.sentDocumentIds).toHaveLength(done.payload.documentIds.length);
    expect((await deliverSignedCopies(db)).sent).toBe(0);   // never twice
  });
  it('retries a refused send with backoff without repeating copies already sent, then gives up with the reason and can be retried by hand', async () => {
    const { o } = await signedOrder();
    status = 502;
    expect(await deliverSignedCopies(db)).toMatchObject({ sent: 0, failed: 1 });
    let r = await row(o.id);
    expect(r).toMatchObject({ attempts: 1, deliveredAt: null, failedAt: null, lastError: expect.stringContaining('502') });
    expect(new Date(r.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect((await deliverSignedCopies(db)).failed).toBe(0);   // not due yet
    for (let i = 0; i < 6; i++) { await db.query('UPDATE lifecycle_outbox SET next_attempt_at = NULL WHERE id=$1', [r.id]); await deliverSignedCopies(db); }
    r = await row(o.id);
    expect(r).toMatchObject({ attempts: 6, deliveredAt: null, lastError: expect.stringContaining('502') });
    expect(r.failedAt).not.toBeNull();
    expect((await signedCopyStatus(db)).recentFailures[0]).toMatchObject({ reason: expect.stringContaining('502') });
    status = 200;
    expect(await retryFailedSignedCopies(db, 'root')).toMatchObject({ requeued: expect.any(Number) });
    expect((await deliverSignedCopies(db)).sent).toBeGreaterThanOrEqual(1);
    expect((await row(o.id)).deliveredAt).not.toBeNull();
  });
  it('marks the row failed at once when the customer has no mobile number', async () => {
    const { o } = await signedOrder(null);
    await deliverSignedCopies(db);
    expect(await row(o.id)).toMatchObject({ failedAt: expect.anything(), lastError: expect.stringMatching(/no mobile number/) });
  });
});
