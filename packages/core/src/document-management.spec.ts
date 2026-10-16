import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerAgreements, decodeSignature, orderValues, signAgreements, verifyContract, agreementsFor } from './agreements.js';
import type { Db } from './db.js';
import { compareVersions, createAgreementTemplate, ensureStarterTemplates, getAgreementTemplate, listAgreementTemplates, publishAgreementTemplate, saveAgreementDraft, templateProblems, activeTemplatesFor } from './doc-templates.js';
import { decideDocument, documentLink, documentLog, fileByLink, listVaultDocuments, openDocument, setDocumentSettings, sweepDocuments, uploadKyc } from './documents.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const who = { username: 'agent1', ip: '203.0.113.9', userAgent: 'vitest' };

/** A small valid PNG: white with a black diagonal (stands in for a signature). */
function png(w = 240, h = 80): Buffer {
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; const x = Math.floor((y / h) * w); for (let k = 0; k < 6 && x + k < w; k++) { const o = y * (w * 3 + 1) + 1 + (x + k) * 3; raw[o] = raw[o + 1] = raw[o + 2] = 0; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = () => `data:image/png;base64,${png().toString('base64')}`;

describe('agreement templates and their versions', () => {
  it('number versions, refuse unknown tokens and unchanged drafts, and keep history', async () => {
    const t = await createAgreementTemplate(db, who, { name: 'Test Agreement', category: 'SUBSCRIBER_AGREEMENT', html: '<h1>Hello {{customer.fullName}}</h1><p>{{signature.customerImage}}</p>' });
    expect(t.draft?.status).toBe('DRAFT');
    await expect(saveAgreementDraft(db, who, t.id, { html: '<p>{{customer.favouriteColour}}</p>' })).rejects.toThrow(/Unknown token/);
    expect(templateProblems('<p>no signature</p>').warnings[0]).toMatch(/signature/);
    let r = await publishAgreementTemplate(db, who, t.id);
    expect(r.activeVersion).toBe('v1.0');
    await expect(publishAgreementTemplate(db, who, t.id)).rejects.toThrow(/nothing to publish/);
    await saveAgreementDraft(db, who, t.id, { html: '<h1>Hello {{customer.fullName}}</h1><p>New clause.</p><p>{{signature.customerImage}}</p>' });
    r = await publishAgreementTemplate(db, who, t.id, { bump: 'minor' });
    expect(r.activeVersion).toBe('v1.1');
    await saveAgreementDraft(db, who, t.id, { html: '<h1>Hello</h1><p>Rewritten.</p><p>{{signature.customerImage}}</p>' });
    r = await publishAgreementTemplate(db, who, t.id, { bump: 'major' });
    expect(r.activeVersion).toBe('v2.0');
    expect(r.versions.map((v: any) => `${v.version}:${v.status}`)).toEqual(['v2.0:PUBLISHED', 'v1.1:RETIRED', 'v1.0:RETIRED']);
    const cmp = await compareVersions(db, r.versions[2].id, r.versions[1].id);
    expect(cmp).toMatchObject({ from: 'v1.0', to: 'v1.1', added: 1 });
    expect((await listAgreementTemplates(db)).find((x) => x.id === t.id)?.activeVersion).toBe('v2.0');
  });
  it('adds the starter set once and picks templates by context and offer type', async () => {
    expect(await ensureStarterTemplates(db, who)).toBe(4);
    expect(await ensureStarterTemplates(db, who)).toBe(0);
    const order = (await activeTemplatesFor(db, { context: 'ORDER', offerKinds: ['SIM_ONLY'] })).map((t) => t.code);
    expect(order).toEqual(expect.arrayContaining(['SUBSCRIBER_AGREEMENT', 'FAIR_USAGE']));
    expect(order).not.toContain('DEVICE_INSTALMENT');
    expect((await activeTemplatesFor(db, { context: 'ORDER', offerKinds: ['SIM_DEVICE'] })).map((t) => t.code)).toContain('DEVICE_INSTALMENT');
    expect((await activeTemplatesFor(db, { context: 'PLAN_CHANGE', offerKinds: [] })).map((t) => t.code)).toEqual(['PLAN_CHANGE']);
  });
});

describe('the identity vault', () => {
  it('stores identity documents encrypted, logs every view, and hands out 15-minute links', async () => {
    const { customer } = await newCustomer(db);
    const d = await uploadKyc(db, { customerId: customer.id, category: 'PASSPORT', bytes: png() }, who);
    expect(d.status).toBe('PENDING_VERIFICATION');
    const raw = (await db.query('SELECT data, encrypted FROM documents WHERE id=$1', [d.id])).rows[0]!;
    expect(raw.encrypted).toBe(true);
    expect(Buffer.from(raw.data).subarray(28).equals(png())).toBe(false);          // not the plain bytes
    const f = await openDocument(db, d.id, { username: 'compliance1', ip: '198.51.100.7' }, 'VIEW');
    expect(f.bytes.equals(png())).toBe(true);
    const link = await documentLink(db, d.id, who, { download: true });
    expect(link.ttlSeconds).toBe(900);
    const viaLink = await fileByLink(db, link.url.split('/').pop()!, { username: 'link', ip: '192.0.2.1' });
    expect(viaLink.download).toBe(true);
    await expect(fileByLink(db, 'garbage', who)).rejects.toThrow(/expired or is not valid/);
    const log = await documentLog(db, { documentId: d.id });
    expect(log.map((l) => l.action).reverse()).toEqual(['UPLOAD', 'VIEW', 'LINK_ISSUED', 'DOWNLOAD']);
    expect(log.find((l) => l.action === 'VIEW')).toMatchObject({ actor: 'compliance1', ip: '198.51.100.7' });
    await expect(db.query(`UPDATE document_audit_log SET actor='x'`)).rejects.toThrow(/cannot be changed/);
    await expect(db.query(`DELETE FROM document_audit_log`)).rejects.toThrow(/cannot be changed/);
    await db.query(`UPDATE documents SET data = $2 WHERE id=$1`, [d.id, Buffer.concat([Buffer.from(raw.data).subarray(0, 40), Buffer.from('tampered')])]);
    await expect(openDocument(db, d.id, who, 'VIEW')).rejects.toThrow();            // a changed file never opens
  });
  it('verifies and rejects, refuses expired or reasonless decisions, and filters the list', async () => {
    const { customer } = await newCustomer(db);
    const a = await uploadKyc(db, { customerId: customer.id, category: 'NATIONAL_ID_FRONT', bytes: png() }, who);
    const b = await uploadKyc(db, { customerId: customer.id, category: 'UTILITY_BILL', bytes: png(), expiresAt: '2020-01-01' }, who);
    await expect(uploadKyc(db, { customerId: customer.id, category: 'SELFIE_X', bytes: png() }, who)).rejects.toThrow(/category/);
    await expect(uploadKyc(db, { customerId: customer.id, category: 'PASSPORT', bytes: Buffer.from('not an image') }, who)).rejects.toThrow(/JPEG, PNG/);
    expect((await decideDocument(db, a.id, { username: 'c1' }, { decision: 'VERIFY' })).status).toBe('VERIFIED_MANUAL');
    expect((await decideDocument(db, a.id, { username: 'system' }, { decision: 'VERIFY', auto: true })).status).toBe('VERIFIED_AUTO');
    await expect(decideDocument(db, b.id, { username: 'c1' }, { decision: 'VERIFY' })).rejects.toThrow(/expired/);
    await expect(decideDocument(db, b.id, { username: 'c1' }, { decision: 'REJECT' })).rejects.toThrow(/reason/);
    expect((await decideDocument(db, b.id, { username: 'c1' }, { decision: 'REJECT', reason: 'blurred' })).status).toBe('REJECTED');
    const list = await listVaultDocuments(db, { customerId: customer.id, status: 'REJECTED' });
    expect(list.items.map((x) => x.id)).toEqual([b.id]);
    expect(list.items[0]).not.toHaveProperty('data');
  });
  it('removes unclaimed uploads, expires old documents and purges after the retention period, but never while a service is live', async () => {
    await setDocumentSettings(db, 'root', { tempUploadHours: 48, kycRetentionYears: 7 });
    const { customer } = await newCustomer(db);
    const keep = await uploadKyc(db, { customerId: customer.id, category: 'PASSPORT', bytes: png() }, who);
    await decideDocument(db, keep.id, { username: 'c1' }, { decision: 'VERIFY' });
    await db.query(`UPDATE documents SET expires_at = now() - interval '1 day' WHERE id=$1`, [keep.id]);
    const orphan = (await db.query(`INSERT INTO documents (kind, category, name, content_type, size_bytes, sha256, storage, data, encrypted, status, created_by, created_at) VALUES ('KYC','PASSPORT','tmp','image/png',1,'x','DB','\\x00',true,'PENDING_VERIFICATION','x', now() - interval '50 hours') RETURNING id`)).rows[0]!;
    const r1 = await sweepDocuments(db);
    expect(r1).toMatchObject({ expired: 1, unclaimedPurged: 1 });
    expect((await db.query('SELECT status FROM documents WHERE id=$1', [orphan.id])).rows[0]!.status).toBe('PURGED_RETENTION');
    expect((await db.query('SELECT status FROM documents WHERE id=$1', [keep.id])).rows[0]!.status).toBe('EXPIRED');
    // a customer whose only service ended 8 years ago: documents are due; one with a live service: never
    const mk = async () => { const k = (await newCustomer(db)).customer; await placeOrder(db, { customerId: k.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] }); return k; };
    const gone = await mk(), live = await mk();
    const goneDoc = await uploadKyc(db, { customerId: gone.id, category: 'PASSPORT', bytes: png() }, who);
    const liveDoc = await uploadKyc(db, { customerId: live.id, category: 'PASSPORT', bytes: png() }, who);
    await db.query(`UPDATE services SET status='TERMINATED', terminated_at = now() - interval '8 years' WHERE customer_id=$1`, [gone.id]);
    const r2 = await sweepDocuments(db);
    expect(r2.retentionSet).toBeGreaterThanOrEqual(1);
    expect(r2.retentionPurged).toBeGreaterThanOrEqual(1);
    expect((await db.query('SELECT status, purged_at, data FROM documents WHERE id=$1', [goneDoc.id])).rows[0]).toMatchObject({ status: 'PURGED_RETENTION', data: null });
    await expect(openDocument(db, goneDoc.id, who, 'VIEW')).rejects.toThrow(/removed under the retention policy/);
    expect((await db.query('SELECT status FROM documents WHERE id=$1', [liveDoc.id])).rows[0]!.status).toBe('PENDING_VERIFICATION');
    // ended only 1 year ago: the clock is set, nothing is purged yet
    await db.query(`UPDATE services SET status='TERMINATED', terminated_at = now() - interval '1 year' WHERE customer_id=$1`, [live.id]);
    await sweepDocuments(db);
    const after = (await db.query('SELECT status, retention_until FROM documents WHERE id=$1', [liveDoc.id])).rows[0]!;
    expect(after.status).toBe('PENDING_VERIFICATION');
    expect(new Date(after.retentionUntil).getUTCFullYear()).toBe(new Date().getUTCFullYear() + 6);
  });
});

describe('signing agreements', () => {
  it('makes a sealed PDF per agreement with the signature stamped on it, bound to the exact version, and detects tampering', async () => {
    await ensureStarterTemplates(db, who).catch(() => 0);
    const { customer } = await newCustomer(db);
    const values = await orderValues(db, customer.id, { number: 'T-1', dueNowMinor: 0, items: [{ name: 'Postpaid 89', kind: 'SIM_ONLY', monthlyMinor: 8900, contractMonths: 24, msisdn: '+60123456789', isPlan: true }] });
    const kinds = ['SIM_ONLY'];
    const pre = await agreementsFor(db, { context: 'ORDER', offerKinds: kinds, values });
    expect(pre.agreements.length).toBeGreaterThanOrEqual(2);
    expect(pre.agreements[0]!.html).toContain('Postpaid 89');
    const signed = await signAgreements(db, { context: 'ORDER', offerKinds: kinds, customerId: customer.id, orderId: null, values, reference: 'T-1', signature: { image: dataUrl(), signerName: 'Test Signer', geo: { lat: 3.139, lon: 101.6869, accuracy: 20 } }, versionIds: pre.agreements.map((a) => a.versionId), ctx: { who, method: 'ASSISTED', agentName: 'Agent One' } });
    expect(signed.length).toBe(pre.agreements.length);
    const f = await openDocument(db, signed[0]!.documentId, who, 'DOWNLOAD');
    expect(f.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(f.bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getKeywords()).toContain('meridian-seal:sha256:');
    const v = await verifyContract(db, signed[0]!.documentId, who);
    expect(v).toMatchObject({ fileIntact: true, sealMatches: true, intact: true });
    const sig = (await db.query('SELECT * FROM document_signatures WHERE document_id=$1', [signed[0]!.documentId])).rows[0]!;
    expect(sig).toMatchObject({ signerName: 'Test Signer', ip: '203.0.113.9', agent: 'Agent One', method: 'ASSISTED' });
    expect(sig.geo.lat).toBeCloseTo(3.139);
    expect((await db.query('SELECT template_version_id FROM documents WHERE id=$1', [signed[0]!.documentId])).rows[0]!.templateVersionId).toBe(pre.agreements[0]!.versionId);
    expect((await customerAgreements(db, customer.id, who)).length).toBe(signed.length);
    // changing one stored byte is caught
    await db.query(`UPDATE documents SET data = set_byte(data, 200, get_byte(data, 200) # 255) WHERE id=$1`, [signed[0]!.documentId]);
    await expect(verifyContract(db, signed[0]!.documentId, who)).rejects.toThrow(/integrity/);
  });
  it('refuses a stale version, a missing signature when required, and a bad picture', async () => {
    const { customer } = await newCustomer(db);
    const values = await orderValues(db, customer.id, { dueNowMinor: 0, items: [{ name: 'X', monthlyMinor: 100, contractMonths: 0, isPlan: true }] });
    const base = { context: 'ORDER' as const, offerKinds: ['SIM_ONLY'], customerId: customer.id, values, reference: 'T-2', ctx: { who, method: 'SELF_SERVE' as const } };
    await setDocumentSettings(db, 'root', { requireAtOrder: true });
    await expect(signAgreements(db, { ...base, signature: null })).rejects.toThrow(/sign/);
    await expect(signAgreements(db, { ...base, signature: { image: dataUrl() }, versionIds: ['00000000-0000-0000-0000-000000000000'] })).rejects.toThrow(/updated while it was on screen/);
    expect(() => decodeSignature('data:image/gif;base64,AAAA')).toThrow(/PNG or JPEG/);
    expect(() => decodeSignature(`data:image/png;base64,${Buffer.alloc(500, 1).toString('base64')}`)).toThrow(/not a valid picture/);
    await setDocumentSettings(db, 'root', { requireAtOrder: false });
    await expect(signAgreements(db, { ...base, signature: null })).resolves.toEqual([]);
  });
});
