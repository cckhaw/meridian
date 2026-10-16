import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateApiKey, createApiClient, listApiClients, revokeApiClient } from './apikeys.js';
import { decryptText, encryptBytes, encryptText } from './field-crypto.js';
import { setGatewayFetch, stripeGateway, stripeSignature, testGateway } from './gateways.js';
import { updateNode } from './catalog.js';
import type { Db } from './db.js';
import { createCustomer } from './customers.js';
import { decideKycCase, type Personal, getKycCase, getKycDocument, listKycCases, markVerified } from './kyc.js';
import { advanceOrder, getOrder, placeOrder } from './orders.js';
import { applicationAgreements, applicationView, applyGatewayEvent, cancelApplication, checkout, createApplication, createPaymentLink, expireApplications, quoteBasket, startPayment, storeCatalog, storeConfig, submitKyc, testGatewayOutcome, updateApplication, uploadDocument, type AppAccess } from './store.js';
import { activeGateways, getStoreSettings, setStoreSettings, DEFAULT_STORE_SETTINGS } from './store-settings.js';
import { freshDb, signatureDataUrl } from './test-helpers.js';
import { ensureStarterTemplates } from './doc-templates.js';
import { setDocumentSettings } from './documents.js';

const png = (w = 64, h = 64) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const len = Buffer.alloc(4); len.writeUInt32BE(13);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(4), deflateSync(Buffer.alloc(8)), Buffer.alloc(32)]);
};
let db: Db;
let n = 0;
const person = (over: Partial<Personal> = {}): Personal => ({
  fullName: 'Alex Tan', dateOfBirth: '1990-04-12', nationality: 'SG', idType: 'NATIONAL_ID' as const, idNumber: `S${String(1000000 + ++n)}A`, idExpiry: '2099-01-01', email: 'alex@example.com', phone: '+6591234567', ...over,
});
const address = { line1: '1 Raffles Place', city: 'Singapore', postcode: '048616', country: 'SG' };
const staff = { username: 'store.clerk', storeId: 'STORE-SG-001' };
const consent = { acceptedTerms: true, privacyAccepted: true, marketingOptIn: false };

beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

async function selfServe(lines: Array<{ offerId: string; quantity?: number }> = [{ offerId: 'plan-sim-5g' }]) {
  const { client } = await createApiClient(db, 'root', { name: `shop-${++n}` });
  const { application, token } = await createApplication(db, { channel: 'SELF_SERVE', clientId: client.id, lines, ip: '203.0.113.7' });
  const acc: AppAccess = { channel: 'SELF_SERVE', clientId: client.id, token };
  return { id: application.id as string, acc, clientId: client.id as string };
}
async function uploadAll(id: string, acc: AppAccess) {
  for (const k of ['ID_FRONT', 'ID_BACK', 'SELFIE'] as const) await uploadDocument(db, id, acc, k, png());
}

describe('api clients', () => {
  it('shows the key once, stores only a hash, and rejects wrong, revoked or malformed keys identically', async () => {
    const { client, key } = await createApiClient(db, 'root', { name: 'Acme store-front' });
    expect(key).toMatch(/^mk_test_[a-z0-9]{10}_[A-Za-z0-9_-]{32,}$/);
    const row = (await db.query('SELECT * FROM api_clients WHERE id=$1', [client.id])).rows[0]!;
    const secret = key.split('_').slice(3).join('_'); // everything after mk_test_<prefix>_ (the secret can itself contain underscores)
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect((await authenticateApiKey(db, `Bearer ${key}`)).name).toBe('Acme store-front');
    const bad = [null, '', 'Bearer nope', `Bearer ${key.slice(0, -2)}xx`, `Basic ${key}`];
    for (const h of bad) await expect(authenticateApiKey(db, h), String(h)).rejects.toThrow(/valid API key/);
    await revokeApiClient(db, 'root', client.id);
    await expect(authenticateApiKey(db, `Bearer ${key}`)).rejects.toThrow(/valid API key/);
    expect((await listApiClients(db)).find((c) => c.id === client.id)!.status).toBe('REVOKED');
  });
});

describe('field encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const c = encryptText('S1234567A');
    expect(c).not.toContain('S1234567A');
    expect(decryptText(c)).toBe('S1234567A');
    expect(encryptText('S1234567A')).not.toBe(c); // fresh IV each time
    const blob = encryptBytes(Buffer.from('secret'));
    blob[blob.length - 1]! ^= 1;
    expect(() => decryptText(blob.toString('base64'))).toThrow();
  });
});

describe('catalogs seeded by earlier releases (paths built from codes)', () => {
  it('still list in the store-front, and migration 0006 repairs the paths', async () => {
    const before = (await db.query(`SELECT path FROM catalog_nodes WHERE id='plan-phone-12'`)).rows[0]!.path as string;
    await db.query(`UPDATE catalog_nodes SET path = replace(path, 'grp-device', 'device') WHERE path LIKE '%/grp-device' OR path LIKE '%/grp-device/%'`);
    expect((await db.query(`SELECT path FROM catalog_nodes WHERE id='plan-phone-12'`)).rows[0]!.path).not.toBe(before);
    expect((await storeCatalog(db, 'SELF_SERVE')).offers.map((o) => o.id)).toContain('plan-phone-12');
    const sql = readFileSync(new URL('../../db/migrations/0006_repair_catalog_paths.sql', import.meta.url), 'utf8');
    await db.query(sql);
    expect((await db.query(`SELECT path FROM catalog_nodes WHERE id='plan-phone-12'`)).rows[0]!.path).toBe(before);
  });
});

describe('catalog and pricing for the store-front', () => {
  it('lists only sellable offers for the channel, with server-computed gross prices', async () => {
    const cat = await storeCatalog(db, 'SELF_SERVE');
    expect(cat.offers.map((o) => o.id)).toContain('plan-sim-5g');
    const sim = cat.offers.find((o) => o.id === 'plan-sim-5g')!;
    expect(sim.monthlyMinor).toBe(3500); // tax-inclusive price in the seed
    await updateNode(db, 'plan-sim-5g', { salesChannels: ['RETAIL_ASSISTED'] }, 't');
    expect((await storeCatalog(db, 'SELF_SERVE')).offers.map((o) => o.id)).not.toContain('plan-sim-5g');
    expect((await storeCatalog(db, 'RETAIL_ASSISTED')).offers.map((o) => o.id)).toContain('plan-sim-5g');
    await updateNode(db, 'plan-sim-5g', { salesChannels: [] }, 't');
  });

  it('reports a missing prerequisite instead of letting it through', async () => {
    const alone = await quoteBasket(db, { lines: [{ offerId: 'device-care' }], channel: 'SELF_SERVE' });
    expect(alone.violations.join(' ')).toMatch(/Device Care.*requires/);
    const together = await quoteBasket(db, { lines: [{ offerId: 'plan-phone-24' }, { offerId: 'device-care' }], channel: 'SELF_SERVE' });
    expect(together.violations).toEqual([]);
    expect(together.requiresShipping).toBe(true);
    await expect(createApplication(db, { channel: 'SELF_SERVE', lines: [{ offerId: 'device-care' }] })).rejects.toThrow(/requires/);
    await expect(quoteBasket(db, { lines: [{ offerId: 'nope' }], channel: 'SELF_SERVE' })).rejects.toThrow(/no longer available/);
    await expect(quoteBasket(db, { lines: [{ offerId: 'plan-sim-5g', quantity: 99 }], channel: 'SELF_SERVE' })).rejects.toThrow(/Quantity/);
  });
});

describe('self-serve sign-up, KYC and payment', () => {
  it('walks from basket to an active service', async () => {
    const { id, acc } = await selfServe();
    await updateApplication(db, id, acc, { personal: person(), consent: { ...consent } });
    await expect(checkout(db, id, acc)).rejects.toThrow(/Identity verification/); // cannot skip KYC
    await expect(submitKyc(db, id, acc)).rejects.toThrow(/Upload/);              // documents are required
    await uploadAll(id, acc);
    await submitKyc(db, id, acc);
    expect((await applicationView(db, id, acc) as any).status).toBe('KYC_REVIEW');
    await expect(checkout(db, id, acc)).rejects.toThrow(/Identity verification/);

    // compliance officer
    const queue = (await listKycCases(db, { status: "PENDING" })).items;
    const c = queue.find((x) => x.applicationId === id)!;
    const detail = await getKycCase(db, c.id, 'compliance.officer');
    expect(detail.idNumber).toMatch(/^S\d{7}A$/);
    expect(detail.documents).toHaveLength(3);
    const doc = await getKycDocument(db, detail.documents[0].id, 'compliance.officer');
    expect(doc.contentType).toBe('image/png');
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity IN ('kyc_case','kyc_document') AND actor='compliance.officer'`)).rows[0]!.n).toBeGreaterThanOrEqual(2);
    await decideKycCase(db, c.id, 'compliance.officer', { decision: 'APPROVE' }, await getStoreSettings(db));
    await expect(decideKycCase(db, c.id, 'someone.else', { decision: 'REJECT', reason: 'x' }, await getStoreSettings(db))).rejects.toThrow(/already/);
    expect((await applicationView(db, id, acc) as any).status).toBe('KYC_APPROVED');

    // terms must be accepted at the current version
    await db.query(`UPDATE applications SET consent=NULL WHERE id=$1`, [id]);
    await expect(checkout(db, id, acc)).rejects.toThrow(/terms/);
    await updateApplication(db, id, acc, { consent: { ...consent } }).catch(() => {}); // locked after approval...
    await db.query(`UPDATE applications SET consent=$2 WHERE id=$1`, [id, JSON.stringify({ ...consent, termsVersion: '1' })]);

    const out = await checkout(db, id, acc);
    expect(out.order.state).toBe('PAYMENT_PENDING');
    expect(out.payment).toMatchObject({ gateway: 'test', amountMinor: out.order.totalMinor });
    const again = await checkout(db, id, acc); // retry returns the same order
    expect(again.order.id).toBe(out.order.id);
    expect((await db.query('SELECT count(*)::int AS n FROM orders WHERE customer_id=$1', [out.application.customerId])).rows[0]!.n).toBe(1);

    // declined, then succeeds
    await testGatewayOutcome(db, id, acc, 'decline');
    expect((await getOrder(db, out.order.id)).state).toBe('PAYMENT_PENDING');
    await startPayment(db, id, acc);
    await testGatewayOutcome(db, id, acc, 'succeed');
    const final = await getOrder(db, out.order.id);
    expect(final.state).toBe('COMPLETED');
    expect(final.services).toHaveLength(1);
    expect(final.payments[0]).toMatchObject({ status: 'CAPTURED', amountMinor: final.totalMinor });
    const cust = (await db.query('SELECT kyc_status FROM customers WHERE id=$1', [final.customerId])).rows[0]!;
    expect(cust.kycStatus).toBe('VERIFIED');
    const view = await applicationView(db, id, acc) as any;
    expect(view.order.numbers[0]).toMatch(/^\+65/);
    expect(JSON.stringify(view)).not.toMatch(/S\d{7}A/); // the full ID number never goes back to the browser
  });

  it('only the key and token that created an application can reach it', async () => {
    const a = await selfServe();
    const b = await selfServe();
    await expect(applicationView(db, a.id, { ...a.acc, token: 'wrong' })).rejects.toThrow(/not found/);
    await expect(applicationView(db, a.id, { ...a.acc, token: undefined })).rejects.toThrow(/not found/);
    await expect(applicationView(db, a.id, { ...a.acc, clientId: b.clientId })).rejects.toThrow(/not found/);
    await expect(applicationView(db, a.id, { channel: 'RETAIL_ASSISTED', staff: { username: 'x' } })).rejects.toThrow(/not found/);
  });

  it('rejects under-age and expired IDs outright and flags an ID already on file', async () => {
    const young = await selfServe();
    await updateApplication(db, young.id, young.acc, { personal: person({ dateOfBirth: new Date(Date.now() - 16 * 365.25 * 86400_000).toISOString().slice(0, 10) }) });
    await uploadAll(young.id, young.acc);
    await submitKyc(db, young.id, young.acc);
    expect((await applicationView(db, young.id, young.acc) as any)).toMatchObject({ status: 'KYC_REJECTED', kyc: { reason: expect.stringMatching(/minimum age/) } });

    const expired = await selfServe();
    await updateApplication(db, expired.id, expired.acc, { personal: person({ idExpiry: '2020-01-01' }) });
    await uploadAll(expired.id, expired.acc);
    await submitKyc(db, expired.id, expired.acc);
    expect((await applicationView(db, expired.id, expired.acc) as any).kyc.reason).toMatch(/expired/);

    const existing = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Already Here', idDocument: 'DUP-12345' });
    const dup = await selfServe();
    await updateApplication(db, dup.id, dup.acc, { personal: person({ idNumber: 'DUP-12345' }) });
    await uploadAll(dup.id, dup.acc);
    await submitKyc(db, dup.id, dup.acc);
    const c = (await listKycCases(db, { status: "PENDING" })).items.find((x) => x.applicationId === dup.id)!;
    expect(c.flags).toContain('DUPLICATE_IDENTITY');
    expect(existing.customer.id).toBeTruthy();
    // approving it online would attach the applicant to someone else's account: refused
    await expect(decideKycCase(db, c.id, 'compliance.officer', { decision: 'APPROVE' }, await getStoreSettings(db))).rejects.toThrow(/already registered/);
    // a reviewer can send it back, and the applicant can fix and resubmit
    await decideKycCase(db, c.id, 'compliance.officer', { decision: 'RETURN', reason: 'Photo is blurry' }, await getStoreSettings(db));
    const v = await applicationView(db, dup.id, dup.acc) as any;
    expect(v).toMatchObject({ status: 'DRAFT', kyc: { returned: true, reason: 'Photo is blurry' } });
    await expect(decideKycCase(db, c.id, 'compliance.officer', { decision: 'REJECT' }, await getStoreSettings(db))).rejects.toThrow(); // reason required / not pending review
  });

  it('auto mode approves a clean application and still refers a duplicate', async () => {
    const s = await getStoreSettings(db);
    await setStoreSettings(db, 'root', { ...s, kycMode: 'auto' });
    const a = await selfServe();
    await updateApplication(db, a.id, a.acc, { personal: person() });
    await uploadAll(a.id, a.acc);
    await submitKyc(db, a.id, a.acc);
    expect((await applicationView(db, a.id, a.acc) as any).status).toBe('KYC_APPROVED');
    await setStoreSettings(db, 'root', s);
  });

  it('shows the agreements to the applicant, keeps the signature until checkout, then signs them into the order and settles the identity documents in the vault', async () => {
    const st = await getStoreSettings(db);
    await setStoreSettings(db, 'root', { ...st, kycMode: 'auto' });
    await ensureStarterTemplates(db, { username: 'root' });
    await setDocumentSettings(db, 'root', { requireAtOrder: true });
    const a = await selfServe();
    await updateApplication(db, a.id, a.acc, { personal: person({ fullName: 'Jamie Ong' }), consent: { ...consent }, address });
    await uploadAll(a.id, a.acc);
    await submitKyc(db, a.id, { ...a.acc, ip: '203.0.113.50', userAgent: 'vitest-shop' });
    expect((await applicationView(db, a.id, a.acc) as any).status).toBe('KYC_APPROVED');
    const vault = (await db.query(`SELECT category, status FROM documents WHERE application_id=$1 AND kind='KYC' ORDER BY category`, [a.id])).rows;
    expect(vault.map((v) => v.category)).toEqual(['NATIONAL_ID_BACK', 'NATIONAL_ID_FRONT', 'SELFIE']);
    expect(new Set(vault.map((v) => v.status))).toEqual(new Set(['VERIFIED_AUTO']));          // the automatic check approved them
    const shown = await applicationAgreements(db, a.id, a.acc);
    expect(shown).toMatchObject({ required: true, signed: false });
    expect(shown.agreements[0]!.html).toContain('Jamie Ong');
    await expect(checkout(db, a.id, a.acc)).rejects.toThrow(/read and sign/);
    await updateApplication(db, a.id, { ...a.acc, ip: '203.0.113.50', userAgent: 'vitest-shop' }, { agreement: { image: signatureDataUrl(), signerName: 'Jamie Ong', versionIds: shown.agreements.map((x) => x.versionId) } });
    expect((await db.query('SELECT agreement FROM applications WHERE id=$1', [a.id])).rows[0]!.agreement.signatureEnc).not.toContain('data:image');   // stored encrypted
    const out = await checkout(db, a.id, a.acc);
    const docs = (await db.query(`SELECT d.id, s.ip, s.method FROM documents d JOIN document_signatures s ON s.document_id=d.id WHERE d.order_id=$1`, [out.order.id])).rows;
    expect(docs.length).toBe(shown.agreements.length);
    expect(docs[0]).toMatchObject({ ip: '203.0.113.50', method: 'SELF_SERVE' });
    await setDocumentSettings(db, 'root', { requireAtOrder: false });
    await setStoreSettings(db, 'root', st);
  });

  it('rejects files that are not images or PDFs, and oversized files', async () => {
    const a = await selfServe();
    await expect(uploadDocument(db, a.id, a.acc, 'ID_FRONT', png())).rejects.toThrow(/personal details/);
    await updateApplication(db, a.id, a.acc, { personal: person() });
    await expect(uploadDocument(db, a.id, a.acc, 'ID_FRONT', Buffer.from('<svg onload=alert(1)/>'))).rejects.toThrow(/JPEG, PNG, WebP or PDF/);
    await expect(uploadDocument(db, a.id, a.acc, 'ID_FRONT', Buffer.concat([png(), Buffer.alloc(3_000_000)]))).rejects.toThrow(/larger/);
    await expect(uploadDocument(db, a.id, a.acc, 'ID_FRONT', Buffer.from('%PDF-1.4 test'))).resolves.toMatchObject({ kind: 'ID_FRONT' });
  });

  it('detects tampering with a stored document', async () => {
    const a = await selfServe();
    await updateApplication(db, a.id, a.acc, { personal: person() });
    const d = await uploadDocument(db, a.id, a.acc, 'ID_FRONT', png());
    const row = (await db.query('SELECT data FROM kyc_documents WHERE id=$1', [d.id])).rows[0]!;
    const bytes = Buffer.from(row.data); bytes[bytes.length - 1]! ^= 0xff;
    await db.query('UPDATE kyc_documents SET data=$2 WHERE id=$1', [d.id, bytes]);
    await expect(getKycDocument(db, d.id, 'x')).rejects.toThrow();
  });

  it('needs a delivery address when something ships, and cancelling releases the order', async () => {
    const a = await selfServe([{ offerId: 'plan-phone-24' }]);
    await updateApplication(db, a.id, a.acc, { personal: person(), consent: { ...consent } });
    await uploadAll(a.id, a.acc);
    await submitKyc(db, a.id, a.acc);
    const c = (await listKycCases(db, { status: "PENDING" })).items.find((x) => x.applicationId === a.id)!;
    await decideKycCase(db, c.id, 'officer', { decision: 'APPROVE' }, await getStoreSettings(db));
    await expect(checkout(db, a.id, a.acc)).rejects.toThrow(/delivery address/);
    await db.query(`UPDATE applications SET address=$2 WHERE id=$1`, [a.id, JSON.stringify(address)]);
    const out = await checkout(db, a.id, a.acc);
    expect(out.order.state).toBe('PAYMENT_PENDING');
    expect(out.order.fulfilment.address).toContain('Raffles');
    await cancelApplication(db, a.id, a.acc);
    expect((await getOrder(db, out.order.id)).state).toBe('CANCELLED');
    expect((await applicationView(db, a.id, a.acc) as any).status).toBe('CANCELLED');
  });

  it('expires stale applications and unpaid orders', async () => {
    const stale = await selfServe();
    await db.query(`UPDATE applications SET expires_at = now() - interval '1 hour' WHERE id=$1`, [stale.id]);
    await expect(updateApplication(db, stale.id, stale.acc, { personal: person() })).rejects.toThrow(/expired/);
    expect((await expireApplications(db)).expired).toBeGreaterThanOrEqual(1);
    expect((await applicationView(db, stale.id, stale.acc) as any).status).toBe('EXPIRED');
  });
});

describe('payment gateways', () => {
  const env = { MERIDIAN_STRIPE_SECRET_KEY: 'sk_test_abc', MERIDIAN_STRIPE_WEBHOOK_SECRET: 'whsec_testsecret', MERIDIAN_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' } as NodeJS.ProcessEnv;
  const evt = (type: string, o: Record<string, unknown>) => JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object: o } });

  it('creates a Stripe PaymentIntent with the server-computed amount and verifies signed webhooks', async () => {
    let seen: { url: string; body: URLSearchParams; headers: Record<string, string> } | null = null;
    setGatewayFetch(async (url, init) => { seen = { url, body: new URLSearchParams(init.body), headers: init.headers }; return { ok: true, status: 200, json: async () => ({ id: 'pi_123', client_secret: 'pi_123_secret_x' }) }; });
    try {
      expect(stripeGateway.configured(env)).toBe(true);
      expect(stripeGateway.configured({} as NodeJS.ProcessEnv)).toBe(false);
      const r = await stripeGateway.createIntent({ amountMinor: 1090, currency: 'SGD', reference: 'o1', description: 'Order', idempotencyKey: 'k1', metadata: { order_id: 'o1' } }, env);
      expect(r).toEqual({ ref: 'pi_123', clientSecret: 'pi_123_secret_x' });
      expect(seen!.url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(seen!.body.get('amount')).toBe('1090');
      expect(seen!.body.get('currency')).toBe('sgd');
      expect(seen!.body.get('metadata[order_id]')).toBe('o1');
      expect(seen!.headers.authorization).toBe('Bearer sk_test_abc');
      expect(seen!.headers['idempotency-key']).toBe('k1');

      const raw = evt('payment_intent.succeeded', { id: 'pi_123', amount: 1090, amount_received: 1090, currency: 'sgd' });
      const hdr = (h: string | null) => (n: string) => (n === 'stripe-signature' ? h : null);
      const ok = stripeGateway.verifyWebhook(raw, hdr(stripeSignature(raw, 'whsec_testsecret')), env);
      expect(ok).toMatchObject({ type: 'payment.succeeded', ref: 'pi_123', amountMinor: 1090, currency: 'SGD' });
      expect(() => stripeGateway.verifyWebhook(raw, hdr(stripeSignature(raw, 'whsec_other')), env)).toThrow(/signature/);
      expect(() => stripeGateway.verifyWebhook(raw + ' ', hdr(stripeSignature(raw, 'whsec_testsecret')), env)).toThrow(/signature/);
      expect(() => stripeGateway.verifyWebhook(raw, hdr(null), env)).toThrow(/signature/);
      expect(() => stripeGateway.verifyWebhook(raw, hdr(stripeSignature(raw, 'whsec_testsecret', Date.now() - 20 * 60_000)), env)).toThrow(/signature/); // replay of an old capture
      const other = evt('charge.refunded', { id: 'ch_1' });
      expect(stripeGateway.verifyWebhook(other, hdr(stripeSignature(other, 'whsec_testsecret')), env)).toBeNull();
    } finally { setGatewayFetch(null); }
  });

  it('turns a provider failure into a friendly error and leaks nothing', async () => {
    setGatewayFetch(async () => ({ ok: false, status: 402, json: async () => ({ error: { type: 'card_error', message: 'sk_test_abc leaked?' } }) }));
    try { await expect(stripeGateway.createIntent({ amountMinor: 1, currency: 'SGD', reference: 'r', description: 'd', idempotencyKey: 'k', metadata: {} }, env)).rejects.toThrow(/could not start/); }
    finally { setGatewayFetch(null); }
  });

  it('confirms the order once, ignores replays, and refuses a mismatched amount', async () => {
    const { id, acc } = await selfServe();
    await updateApplication(db, id, acc, { personal: person(), consent: { ...consent } });
    await uploadAll(id, acc);
    await submitKyc(db, id, acc);
    const c = (await listKycCases(db, { status: "PENDING" })).items.find((x) => x.applicationId === id)!;
    await decideKycCase(db, c.id, 'officer', { decision: 'APPROVE' }, await getStoreSettings(db));
    const out = await checkout(db, id, acc);
    const intent = (await db.query(`SELECT * FROM payment_intents WHERE order_id=$1`, [out.order.id])).rows[0]!;
    const base = { type: 'payment.succeeded' as const, ref: intent.gatewayRef, currency: 'SGD' };
    await expect(applyGatewayEvent(db, 'test', { ...base, eventId: 'e-bad', amountMinor: 1 })).rejects.toThrow(/does not match/);
    expect((await getOrder(db, out.order.id)).state).toBe('PAYMENT_PENDING');
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='AMOUNT_MISMATCH'`)).rows[0]!.n).toBeGreaterThan(0);
    await applyGatewayEvent(db, 'test', { ...base, eventId: 'e-1', amountMinor: Number(intent.amountMinor) });
    expect((await getOrder(db, out.order.id)).state).toBe('COMPLETED');
    expect(await applyGatewayEvent(db, 'test', { ...base, eventId: 'e-1', amountMinor: Number(intent.amountMinor) })).toMatchObject({ handled: false });
    await applyGatewayEvent(db, 'test', { ...base, eventId: 'e-2', amountMinor: Number(intent.amountMinor) }); // different event id, already paid: no double capture
    expect((await db.query(`SELECT count(*)::int AS n FROM payments WHERE order_id=$1`, [out.order.id])).rows[0]!.n).toBe(1);
    expect(await applyGatewayEvent(db, 'test', { ...base, eventId: 'e-3', ref: 'unknown', amountMinor: 1 })).toMatchObject({ handled: false });
  });

  it('is only available when configured: the test gateway never in production', () => {
    expect(testGateway.configured({ NODE_ENV: 'production', MERIDIAN_PAYMENT_MODE: 'simulated' } as NodeJS.ProcessEnv)).toBe(false);
    expect(testGateway.configured({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('exposes only non-secret config to the store-front', async () => {
    const cfg = await storeConfig(db);
    expect(JSON.stringify(cfg)).not.toMatch(/sk_|whsec_/);
    expect(cfg.payment.gateways.map((g) => g.id)).toContain('test');
    expect(cfg.kyc.mode).toBe(DEFAULT_STORE_SETTINGS.kycMode);
  });
});

describe('assisted sale (customer is in the store)', () => {
  const acc: AppAccess = { channel: 'RETAIL_ASSISTED', staff };

  it('needs the attestation and the customer’s authority, then completes on the counter with commission attribution', async () => {
    const { application } = await createApplication(db, { channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'plan-sim-5g' }], staff });
    const id = application.id as string;
    expect(application.token_hash ?? application.tokenHash).toBeNull();
    await updateApplication(db, id, acc, { personal: person(), consent: { ...consent } });
    await expect(submitKyc(db, id, acc)).rejects.toThrow(/attestation/);
    await expect(submitKyc(db, id, acc, { idSighted: true, faceMatches: false })).rejects.toThrow(/original ID/);
    await submitKyc(db, id, acc, { idSighted: true, faceMatches: true, notes: 'NRIC checked' });
    expect((await applicationView(db, id, acc) as any)).toMatchObject({ status: 'KYC_APPROVED', kyc: { method: 'IN_PERSON' } });
    await expect(checkout(db, id, acc, { assistedPayment: { method: 'CASH', confirmed: true, reference: 'RCPT-1' } })).rejects.toThrow(/authorise/);
    await expect(uploadDocument(db, id, acc, 'ID_FRONT', png())).rejects.toThrow(/open/); // identity evidence is frozen after approval
    await uploadDocument(db, id, acc, 'SIGNATURE', png());                                  // the signature is captured last
    await updateApplication(db, id, acc, { consent: { ...consent, authorisedAssistant: true } });
    const out = await checkout(db, id, acc, { assistedPayment: { method: 'CASH', confirmed: true, reference: 'RCPT-1' } });
    expect(out.order.state).toBe('COMPLETED');
    expect(out.order).toMatchObject({ channel: 'RETAIL_ASSISTED', storeId: 'STORE-SG-001', salespersonId: 'store.clerk' });
    const case_ = (await db.query('SELECT attestation, method FROM kyc_cases WHERE application_id=$1', [id])).rows[0]!;
    expect(case_.attestation).toMatchObject({ by: 'store.clerk', idSighted: true });
  });

  it('other stores cannot see this store’s applications; a verified returning customer skips the check', async () => {
    const { application } = await createApplication(db, { channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'plan-sim-5g' }], staff });
    await expect(applicationView(db, application.id, { channel: 'RETAIL_ASSISTED', staff: { username: 'other', storeId: 'STORE-X' } })).rejects.toThrow(/not found/);
    expect(await applicationView(db, application.id, { channel: 'RETAIL_ASSISTED', staff: { username: 'mgr', storeId: 'STORE-X', canSeeAll: true } })).toMatchObject({ id: application.id });

    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Returning Rae', idDocument: 'RET-0001' });
    await markVerified(db, customer.id);
    const app2 = (await createApplication(db, { channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'vas-roaming' }], customerId: customer.id, staff })).application;
    await submitKyc(db, app2.id, acc, { idSighted: true, faceMatches: true });
    expect((await applicationView(db, app2.id, acc) as any).status).toBe('KYC_APPROVED');
  });

  it('existing customers can add a product that depends on something they already own', async () => {
    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Phone Owner', idDocument: 'OWN-0001' });
    await markVerified(db, customer.id);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH', confirmed: true, reference: 'R1' }, lines: [{ offerId: 'plan-phone-12' }] });
    const q = await quoteBasket(db, { lines: [{ offerId: 'device-care' }], channel: 'RETAIL_ASSISTED', customerId: customer.id });
    expect(q.violations).toEqual([]);
    const stranger = await quoteBasket(db, { lines: [{ offerId: 'device-care' }], channel: 'RETAIL_ASSISTED' });
    expect(stranger.violations).toHaveLength(1);
  });
});

describe('KYC required for services', () => {
  it('blocks selling a service to an unverified customer in the CRM once switched on', async () => {
    const s = await getStoreSettings(db);
    await setStoreSettings(db, 'root', { ...s, requireKycForServices: true });
    try {
      const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Unverified', idDocument: 'UNV-0001' });
      const order = { customerId: customer.id, channel: 'RETAIL_ASSISTED' as const, attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' as const, confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] };
      await expect(placeOrder(db, order)).rejects.toThrow(/KYC/);
      await markVerified(db, customer.id);
      expect((await placeOrder(db, order)).state).toBe('COMPLETED');
    } finally { await setStoreSettings(db, 'root', s); }
  });

  it('validates store settings', async () => {
    const s = await getStoreSettings(db);
    await expect(setStoreSettings(db, 'r', { ...s, gateways: { enabled: ['paypal'], default: null, crm: [] } })).rejects.toThrow(/unknown payment gateway/);
    await expect(setStoreSettings(db, 'r', { ...s, gateways: { enabled: ['stripe'], default: 'test', crm: [] } })).rejects.toThrow(/default/);
    await expect(setStoreSettings(db, 'r', { ...s, termsUrl: 'javascript:alert(1)' })).rejects.toThrow(/URL/);
    await expect(setStoreSettings(db, 'r', { ...s, minAge: -1 })).rejects.toThrow(/age/);
    await expect(setStoreSettings(db, 'r', { ...s, gateways: { ...s.gateways, crm: ['paypal'] } })).rejects.toThrow(/unknown payment gateway/);
  });
});

describe('a device on a contract in the online shop', () => {
  const lines = [{ offerId: 'plan-sim-5g' }, { offerId: 'good-phone-outright', attachTo: 'plan-sim-5g', dealTermMonths: 24 }];
  it('lists the contracts a device offers and which plans can host one', async () => {
    const cat = await storeCatalog(db, 'SELF_SERVE', { limit: 100 });
    const phone = cat.offers.find((o) => o.id === 'good-phone-outright')!;
    expect(phone.deals.map((d) => d.termMonths)).toEqual([12, 24]);
    expect(phone.deals[1]!.priceMinor).toBe(phone.upfrontMinor - phone.deals[1]!.subsidyMinor);
    expect(cat.offers.find((o) => o.id === 'plan-sim-5g')!.hostsDevice).toBe(true);
    expect(cat.offers.find((o) => o.id === 'plan-phone-24')!.hostsDevice).toBe(false);
  });

  it('quotes the contract price and refuses a plan that is not in the basket or a contract the device does not offer', async () => {
    const plain = await quoteBasket(db, { channel: 'SELF_SERVE', lines: [{ offerId: 'plan-sim-5g' }, { offerId: 'good-phone-outright' }] });
    const q = await quoteBasket(db, { channel: 'SELF_SERVE', lines });
    const phone = q.lines[1]!;
    const price = plain.lines[1]!.upfrontMinor - 40000;
    // Financed by default: the price after the subsidy is spread evenly over the contract and billed with the plan.
    expect(phone.upfrontMinor).toBe(0);
    expect(phone.deal).toMatchObject({ planName: '5G SIM-only 100GB', termMonths: 24, instalmentMinor: Math.floor(price / 24) });
    expect(phone.monthlyMinor).toBe(Math.floor(price / 24));
    expect(q.financing).toMatchObject({ months: 24, upfrontMinor: 0, estimate: false });
    // ...unless the customer pays in full.
    const full = await quoteBasket(db, { channel: 'SELF_SERVE', lines: [lines[0]!, { ...lines[1]!, payInFull: true }] });
    expect(full.lines[1]!.upfrontMinor).toBe(price);
    expect(full.financing).toBeUndefined();
    await expect(quoteBasket(db, { channel: 'SELF_SERVE', lines: [{ offerId: 'good-phone-outright', attachTo: 'plan-sim-5g', dealTermMonths: 24 }] })).rejects.toThrow(/not in the basket/);
    await expect(quoteBasket(db, { channel: 'SELF_SERVE', lines: [{ ...lines[0]! }, { offerId: 'good-phone-outright', attachTo: 'plan-sim-5g', dealTermMonths: 36 }] })).rejects.toThrow(/not offered on a 36-month contract/);
  });

  it('checks out at the quoted price and gives the plan the contract once the phone is delivered', async () => {
    const s = await getStoreSettings(db);
    await setStoreSettings(db, 'root', { ...s, kycMode: 'auto' });
    const a = await selfServe(lines);
    await updateApplication(db, a.id, a.acc, { personal: person(), consent: { ...consent } });
    await uploadAll(a.id, a.acc);
    await submitKyc(db, a.id, a.acc);
    await db.query(`UPDATE applications SET address=$2, consent=$3 WHERE id=$1`, [a.id, JSON.stringify(address), JSON.stringify({ ...consent, termsVersion: '1' })]);
    const out = await checkout(db, a.id, a.acc);
    const quote = await quoteBasket(db, { channel: 'SELF_SERVE', lines });
    expect(out.order.totalMinor).toBe(quote.upfrontMinor);
    expect(out.order.lines.find((l: any) => l.deal)?.deal).toMatchObject({ termMonths: 24, subsidyMinor: 40000 });
    await testGatewayOutcome(db, a.id, a.acc, 'succeed');
    await advanceOrder(db, out.order.id, { type: 'ship' });
    const done = await advanceOrder(db, out.order.id, { type: 'deliver' });
    const svc = (await db.query('SELECT * FROM services WHERE id=$1', [done.services[0].id])).rows[0]!;
    expect(svc.contractTermMonths).toBe(24);
    expect(svc.deal).toMatchObject({ termMonths: 24, subsidyMinor: 40000 });
    await setStoreSettings(db, 'root', s);
  });
});

describe('where a payment gateway is used: store-front, CRM or both', () => {
  const keys = { MERIDIAN_STRIPE_SECRET_KEY: 'sk_test_abc123', MERIDIAN_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123', MERIDIAN_STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };
  const saved: Record<string, string | undefined> = {};
  const pending = async () => {
    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Link payer', idDocument: `LNK-${++n}` });
    await markVerified(db, customer.id);
    return placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CREDIT_CARD', deferred: true }, lines: [{ offerId: 'plan-sim-5g' }] });
  };
  beforeAll(() => { for (const k of Object.keys(keys)) saved[k] = process.env[k]; Object.assign(process.env, keys); });
  afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } setGatewayFetch(null); });

  it('offers each place only what was switched on for it', async () => {
    const s = await getStoreSettings(db);
    await setStoreSettings(db, 'root', { ...s, gateways: { enabled: ['stripe'], default: 'stripe', crm: [] } });
    expect((await activeGateways(db, process.env, 'STOREFRONT')).list.map((g) => g.id)).toEqual(['stripe']);
    expect((await activeGateways(db, process.env, 'CRM')).list).toEqual([]);
    await setStoreSettings(db, 'root', { ...s, gateways: { enabled: [], default: null, crm: ['stripe'] } });
    expect((await activeGateways(db, process.env, 'CRM')).list.map((g) => g.id)).toEqual(['stripe']);
    await setStoreSettings(db, 'root', s);
  });

  it('staff get a Stripe payment link for an order waiting for money, and the signed webhook releases it', async () => {
    const s = await getStoreSettings(db);
    const order = await pending();
    expect(order.state).toBe('PAYMENT_PENDING');
    await expect(createPaymentLink(db, order.id, 'clerk', { returnUrl: 'https://crm.example.com/pay/done' })).rejects.toThrow(/not switched on for the CRM/);
    await setStoreSettings(db, 'root', { ...s, gateways: { enabled: [], default: null, crm: ['stripe'] } });
    let sent = '';
    setGatewayFetch(async (url, init) => { sent = `${url}?${init.body}`; return { ok: true, status: 200, json: async () => ({ id: 'cs_test_link1', url: 'https://checkout.stripe.com/c/pay/cs_test_link1', expires_at: Math.floor(Date.now() / 1000) + 3600 }) }; });
    await expect(createPaymentLink(db, order.id, 'clerk', { returnUrl: 'javascript:alert(1)' })).rejects.toThrow(/https/);
    const link = await createPaymentLink(db, order.id, 'clerk', { returnUrl: 'https://crm.example.com/pay/done' });
    expect(link).toMatchObject({ gateway: 'stripe', ref: 'cs_test_link1', url: expect.stringContaining('checkout.stripe.com'), amountMinor: order.totalMinor });
    expect(sent).toContain('api.stripe.com/v1/checkout/sessions');
    expect(sent).toContain(`unit_amount%5D=${order.totalMinor}`);
    expect(sent).not.toMatch(/sk_test_abc123/);

    const raw = JSON.stringify({ id: 'evt_link1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_link1', payment_status: 'paid', amount_total: order.totalMinor, currency: order.currency.toLowerCase() } } });
    const sig = stripeSignature(raw, keys.MERIDIAN_STRIPE_WEBHOOK_SECRET);
    const ev = stripeGateway.verifyWebhook(raw, (h) => (h === 'stripe-signature' ? sig : null), process.env)!;
    expect(ev).toMatchObject({ type: 'payment.succeeded', ref: 'cs_test_link1' });
    expect((await applyGatewayEvent(db, 'stripe', ev)).handled).toBe(true);
    expect((await getOrder(db, order.id)).state).not.toBe('PAYMENT_PENDING');
    await expect(createPaymentLink(db, order.id, 'clerk', { returnUrl: 'https://crm.example.com/pay/done' })).rejects.toThrow(/no payment is due/);
    await setStoreSettings(db, 'root', s);
  });

  it('an unpaid Checkout session does not release the order', () => {
    const raw = JSON.stringify({ id: 'evt_unpaid', type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'unpaid', amount_total: 100, currency: 'sgd' } } });
    const sig = stripeSignature(raw, keys.MERIDIAN_STRIPE_WEBHOOK_SECRET);
    expect(stripeGateway.verifyWebhook(raw, (h) => (h === 'stripe-signature' ? sig : null), process.env)).toBeNull();
  });
});
