import { formatMoney } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { invalid, rejected } from './errors.js';
import { sanitizeHtml, textLines } from './doc-html.js';
import { renderAgreementPdf, sealOf, verifySealedPdf, type SignatureStamp } from './doc-pdf.js';
import { activeTemplatesFor, fillTokens, sampleValues, type TemplateContext } from './doc-templates.js';
import { documentLink, getDocumentSettings, logDocument, openDocument, putDocument, type DocWho } from './documents.js';
import { raiseEvent } from './events.js';
import { getBranding, getRegional } from './settings.js';

/**
 * Agreements at the point of sale and at a plan change. Which agreements apply depends on the offer types in the basket; the customer (or the agent at
 * the counter) is shown the text with their own details filled in, signs on screen, and the signed PDF is made, sealed, stored and bound to the order
 * with the exact version that was signed. Delivery to the customer is queued for when the order is paid.
 */
export interface SignatureInput { /** A PNG or JPEG as a data URL, from the signature pad. */ image: string; signerName?: string; geo?: { lat: number; lon: number; accuracy?: number } | null }
export interface SigningContext { who: DocWho; method: 'SELF_SERVE' | 'ASSISTED' | 'PLAN_CHANGE'; agentName?: string | null }
export const MAX_SIGNATURE_BYTES = 400_000;
export const AGREEMENT_CHANNELS = ['SELF_SERVE', 'RETAIL_ASSISTED', 'TELESALES', 'DEALER', 'CALL_CENTER'];   // counter quick sales and API orders have no signature pad

export function decodeSignature(dataUrl: string): { bytes: Buffer; contentType: 'image/png' | 'image/jpeg' } {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw invalid('The signature must be a PNG or JPEG picture.');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length < 80 || bytes.length > MAX_SIGNATURE_BYTES) throw invalid(`The signature picture is empty or larger than ${Math.round(MAX_SIGNATURE_BYTES / 1000)} KB.`);
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if ((m[1] === 'png' && !png) || (m[1] === 'jpeg' && !jpg)) throw invalid('The signature is not a valid picture.');
  return { bytes, contentType: m[1] === 'png' ? 'image/png' : 'image/jpeg' };
}

// ───────────────────────── token values ─────────────────────────
export interface OrderFacts { number?: string | null; createdAt?: Date; dueNowMinor: number; items: Array<{ name: string; kind?: string; monthlyMinor: number; contractMonths: number; msisdn?: string | null; iccid?: string | null; imei?: string | null; isPlan?: boolean }> }
const longDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
async function customerValues(q: Queryable, customerId: string): Promise<Record<string, string>> {
  const c = (await q.query('SELECT display_name, email, phone, address FROM customers WHERE id=$1', [customerId])).rows[0];
  const k = (await q.query(`SELECT id_number_masked FROM kyc_cases WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [customerId])).rows[0];
  const a = (c?.address ?? {}) as Record<string, string>;
  return { 'customer.fullName': c?.displayName ?? '', 'customer.nationalId': k?.idNumberMasked ?? '', 'customer.email': c?.email ?? '', 'customer.phone': c?.phone ?? '',
    'customer.address': [a.line1, a.line2, [a.postcode, a.city].filter(Boolean).join(' '), a.state, a.country].filter(Boolean).join(', ') };
}
export async function orderValues(q: Queryable, customerId: string, f: OrderFacts): Promise<Record<string, string>> {
  const [reg, brand, cust] = await Promise.all([getRegional(q), getBranding(q), customerValues(q, customerId)]);
  const plan = f.items.find((i) => i.isPlan) ?? f.items[0], tel = f.items.find((i) => i.msisdn) ?? plan;
  const money = (n: number) => formatMoney(n, reg);
  const months = Math.max(0, ...f.items.map((i) => i.contractMonths));
  return { ...cust, 'company.name': brand.name, 'order.orderNumber': f.number ?? 'assigned when the order is placed', 'order.createdDate': longDate(f.createdAt ?? new Date()),
    'order.planName': plan?.name ?? '', 'order.monthlyFee': money(f.items.reduce((t, i) => t + i.monthlyMinor, 0)), 'order.upfrontAmount': money(f.dueNowMinor),
    'order.contractMonths': months ? `${months} months` : 'no minimum term', 'order.items': f.items.map((i) => i.name).join('; '),
    'service.msisdn': tel?.msisdn ?? 'assigned on activation', 'service.iccid': f.items.find((i) => i.iccid)?.iccid ?? 'assigned on activation', 'service.imei': f.items.find((i) => i.imei)?.imei ?? 'recorded at hand-over' };
}
export async function planChangeValues(q: Queryable, customerId: string, f: { from: string; to: string; effectiveDate: string; monthlyMinor: number; msisdn?: string | null }): Promise<Record<string, string>> {
  const [reg, brand, cust] = await Promise.all([getRegional(q), getBranding(q), customerValues(q, customerId)]);
  return { ...cust, 'company.name': brand.name, 'change.fromPlan': f.from, 'change.toPlan': f.to, 'change.effectiveDate': f.effectiveDate, 'order.monthlyFee': formatMoney(f.monthlyMinor, reg), 'order.planName': f.to, 'service.msisdn': f.msisdn ?? '' };
}

// ───────────────────────── what applies, and the text to show ─────────────────────────
export interface AgreementOffer { templateId: string; versionId: string; code: string; name: string; category: string; version: string }
/** The agreements a basket (or plan change) needs, whether signing is mandatory, and the live text per agreement with this customer's details filled in. */
export async function agreementsFor(q: Queryable, o: { context: TemplateContext; offerKinds: string[]; channel?: string; values?: Record<string, string> }) {
  const [templates, s] = await Promise.all([activeTemplatesFor(q, { context: o.context, offerKinds: o.offerKinds }), getDocumentSettings(q)]);
  const must = (o.context === 'ORDER' ? s.requireAtOrder : s.requireAtPlanChange) && templates.length > 0 && (o.context !== 'ORDER' || !o.channel || AGREEMENT_CHANNELS.includes(o.channel));
  const values = { ...sampleValues(), ...(o.values ?? {}) };
  return { required: must, agreements: templates.map((t) => ({ templateId: t.templateId, versionId: t.versionId, code: t.code, name: t.name, category: t.category, version: t.version, html: fillTokens(sanitizeHtml(t.html), { ...values, 'signature.timestamp': '(when you sign)', 'signature.agentName': values['signature.agentName'] ?? '' }).html.replace(/\u0001SIGNATURE\u0001/g, '<strong>[ your signature ]</strong>') })) };
}

// ───────────────────────── signing ─────────────────────────
export interface SignedAgreement { documentId: string; templateCode: string; name: string; version: string; sha256: string; pages: number }
/**
 * Makes the signed PDFs for every agreement that applies and binds them. `versionIds`, when the screen sends them, must be the versions that are
 * live now: if someone published a new version while the customer was reading, they are asked to read it again instead of signing stale words.
 */
export async function signAgreements(q: Queryable, o: {
  context: TemplateContext; offerKinds: string[]; customerId: string; orderId?: string | null; serviceId?: string | null; values: Record<string, string>; reference: string;
  signature: SignatureInput | null | undefined; versionIds?: string[]; ctx: SigningContext; channel?: string;
}): Promise<SignedAgreement[]> {
  const [templates, s] = await Promise.all([activeTemplatesFor(q, { context: o.context, offerKinds: o.offerKinds }), getDocumentSettings(q)]);
  if (!templates.length) return [];
  const mandatory = (o.context === 'ORDER' ? s.requireAtOrder : s.requireAtPlanChange) && (o.context !== 'ORDER' || !o.channel || AGREEMENT_CHANNELS.includes(o.channel));
  if (!o.signature) { if (mandatory) throw invalid('The customer must read and sign the agreement before this can go ahead.'); return []; }
  if (o.versionIds?.length) {
    const live = new Set(templates.map((t) => t.versionId));
    if (o.versionIds.some((v) => !live.has(v)) || templates.some((t) => !o.versionIds!.includes(t.versionId))) throw rejected('The agreement was updated while it was on screen. Read the new text and sign again.');
  }
  const img = decodeSignature(o.signature.image);
  const brand = await getBranding(q), signedAt = new Date();
  const signerName = (o.signature.signerName?.trim() || o.values['customer.fullName'] || 'Customer').slice(0, 120);
  const geo = o.signature.geo && Number.isFinite(o.signature.geo.lat) && Number.isFinite(o.signature.geo.lon) && Math.abs(o.signature.geo.lat) <= 90 && Math.abs(o.signature.geo.lon) <= 180 ? { lat: o.signature.geo.lat, lon: o.signature.geo.lon, ...(o.signature.geo.accuracy ? { accuracy: o.signature.geo.accuracy } : {}) } : null;
  const stamp: SignatureStamp = { image: img.bytes, imageType: img.contentType, signerName, signedAt, ip: o.ctx.who.ip ?? null, geo, agent: o.ctx.agentName ?? null, method: o.ctx.method };
  const sigDoc = await putDocument(q, { kind: 'SIGNATURE', category: 'CUSTOMER_SIGNATURE', name: `Signature ${o.reference}`, contentType: img.contentType, bytes: img.bytes, customerId: o.customerId, orderId: o.orderId, serviceId: o.serviceId, encrypt: true }, o.ctx.who.username);
  const out: SignedAgreement[] = [];
  for (const t of templates) {
    const filled = fillTokens(sanitizeHtml(t.html), { ...o.values, 'signature.timestamp': `${signedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, 'signature.agentName': o.ctx.agentName ?? 'online, no staff member' });
    const seal = sealOf(textLines(filled.html), stamp, { templateVersionId: t.versionId, orderId: o.orderId ?? null, customerId: o.customerId });
    const { pdf, pages } = await renderAgreementPdf({ title: t.name, brand: brand.name, reference: o.reference, html: filled.html, signature: stamp, version: t.version }, seal);
    const bytes = Buffer.from(pdf);
    const doc = await putDocument(q, { kind: 'CONTRACT', category: t.category, name: `${t.name} ${t.version} · ${o.reference}`, contentType: 'application/pdf', bytes, customerId: o.customerId, orderId: o.orderId, serviceId: o.serviceId, templateVersionId: t.versionId, meta: { templateCode: t.code, version: t.version, seal, pages, missingTokens: filled.missing, reference: o.reference, context: o.context } }, o.ctx.who.username);
    await q.query(`INSERT INTO document_signatures (document_id, signature_document_id, customer_id, order_id, service_id, template_version_id, signer_name, signed_at, ip, user_agent, geo, agent, method, content_seal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [doc.id, sigDoc.id, o.customerId, o.orderId ?? null, o.serviceId ?? null, t.versionId, signerName, signedAt.toISOString(), o.ctx.who.ip ?? null, o.ctx.who.userAgent?.slice(0, 300) ?? null, geo ? JSON.stringify(geo) : null, o.ctx.agentName ?? null, o.ctx.method, seal]);
    await logDocument(q, o.ctx.who, 'GENERATE', { documentId: doc.id, customerId: o.customerId, detail: { template: t.code, version: t.version, orderId: o.orderId ?? null, sha256: doc.sha256, seal } });
    await raiseEvent(q, 'CONTRACT_GENERATED', { resourceId: doc.id, payload: { documentId: doc.id, customerId: o.customerId, orderId: o.orderId ?? null, serviceId: o.serviceId ?? null, template: t.code, version: t.version, sha256: doc.sha256 } }, { onlyIfWanted: true });
    out.push({ documentId: doc.id, templateCode: t.code, name: t.name, version: t.version, sha256: doc.sha256, pages });
  }
  if (o.orderId) await q.query(`UPDATE orders SET fulfilment = fulfilment || $2::jsonb WHERE id=$1`, [o.orderId, JSON.stringify({ agreements: out.map((a) => ({ documentId: a.documentId, code: a.templateCode, version: a.version })) })]);
  await audit(q, o.ctx.who.username, 'document', out[0]!.documentId, 'AGREEMENTS_SIGNED', { count: out.length, customerId: o.customerId, orderId: o.orderId ?? null });
  return out;
}

/** Checks a signed contract: the stored file is untouched, and the seal inside it is the one recorded when it was signed. */
export async function verifyContract(q: Queryable, documentId: string, who: DocWho) {
  const sig = (await q.query('SELECT content_seal FROM document_signatures WHERE document_id=$1', [documentId])).rows[0];
  if (!sig) throw rejected('That is not a signed contract.');
  const f = await openDocument(q, documentId, who, 'VIEW');
  const r = await verifySealedPdf(new Uint8Array(f.bytes), { storedSha256: f.row.sha256, seal: sig.contentSeal });
  await logDocument(q, who, 'VERIFY_SEAL', { documentId, customerId: f.row.customerId, detail: { ...r } });
  return { documentId, ...r, seal: sig.contentSeal, intact: r.fileIntact && r.sealMatches };
}

// ───────────────────────── delivery and the customer's own copy ─────────────────────────
/** Queues the signed copies of an order for the customer (WhatsApp or SMS/email through the same outbox as every other notice). The link is made when it is sent, so it is always fresh. */
export async function queueContractDelivery(q: Queryable, orderId: string): Promise<number> {
  const s = await getDocumentSettings(q);
  if (!s.deliverContracts) return 0;
  const docs = (await q.query(`SELECT id, name, customer_id FROM documents WHERE order_id=$1 AND kind='CONTRACT' AND purged_at IS NULL AND NOT (meta ? 'deliveredAt')`, [orderId])).rows;
  if (!docs.length) return 0;
  const order = (await q.query('SELECT number, customer_id FROM orders WHERE id=$1', [orderId])).rows[0];
  await q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) VALUES ('NOTIFY', 'CONTRACT_SIGNED', $1)`,
    [JSON.stringify({ customerId: order?.customerId ?? docs[0]!.customerId, orderId, orderNumber: order?.number ?? null, documentIds: docs.map((d) => d.id), documents: docs.map((d) => d.name), message: `Your signed agreement for order ${order?.number ?? ''} is ready. Open the secure link to read or save it.`, linkTtlMinutes: 15 })]);
  await q.query(`UPDATE documents SET meta = meta || jsonb_build_object('deliveredAt', now()::text) WHERE id = ANY($1::uuid[])`, [docs.map((d) => d.id)]);
  for (const d of docs) await logDocument(q, { username: 'system' }, 'DELIVER', { documentId: d.id, customerId: d.customerId, detail: { orderId } });
  return docs.length;
}

/** A customer's signed agreements, each with a 15-minute link (self-care portal, mobile app, `GET /api/v1/customers/{id}/documents`). Identity documents are never listed here. */
export async function customerAgreements(q: Queryable, customerId: string, who: DocWho, o: { baseUrl?: string } = {}): Promise<Row[]> {
  const rows = (await q.query(`SELECT id, name, category, created_at, order_id, service_id, sha256, size_bytes, meta, purged_at FROM documents WHERE customer_id=$1 AND kind='CONTRACT' AND purged_at IS NULL ORDER BY created_at DESC LIMIT 100`, [customerId])).rows;
  const out: Row[] = [];
  for (const r of rows) {
    const link = await documentLink(q, r.id, who, { baseUrl: o.baseUrl, download: false });
    out.push({ id: r.id, name: r.name, category: r.category, signedAt: r.createdAt, orderId: r.orderId, serviceId: r.serviceId, version: r.meta?.version ?? null, sizeBytes: r.sizeBytes, url: link.url, expiresAt: link.expiresAt });
  }
  return out;
}
