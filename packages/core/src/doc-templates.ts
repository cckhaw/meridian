import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { diffLines, escapeHtml, sanitizeHtml, textLines } from './doc-html.js';
import { logDocument, type DocWho } from './documents.js';

/**
 * Agreement templates and their legal versions. A template (Subscriber Service Agreement, Fair Usage Policy, Device Instalment Terms, Plan Change
 * Agreement) has one working DRAFT and a numbered history of PUBLISHED versions (v1.0, v1.1, v2.0). Only a published version is ever signed, and a
 * signed document keeps the id of the exact version it was made from: later edits never change what a customer agreed to.
 */
export const TEMPLATE_CATEGORIES = ['SUBSCRIBER_AGREEMENT', 'FAIR_USAGE', 'DEVICE_INSTALMENT', 'PLAN_CHANGE', 'OTHER'] as const;
export const TEMPLATE_CONTEXTS = ['ORDER', 'PLAN_CHANGE'] as const;
export type TemplateContext = (typeof TEMPLATE_CONTEXTS)[number];

export interface TokenDef { key: string; label: string; group: string; sample: string }
/** Everything an author can drop into a template. Unknown tokens are refused at save time, so a typo never reaches a customer. */
export const TOKENS: TokenDef[] = [
  { key: 'customer.fullName', label: 'Customer name', group: 'Customer', sample: 'Aisha Rahman' },
  { key: 'customer.nationalId', label: 'ID number (masked)', group: 'Customer', sample: '•••••• 4321' },
  { key: 'customer.address', label: 'Address', group: 'Customer', sample: '12 Jalan Bukit, 50250 Kuala Lumpur' },
  { key: 'customer.email', label: 'Email', group: 'Customer', sample: 'aisha@example.com' },
  { key: 'customer.phone', label: 'Contact number', group: 'Customer', sample: '+60 12 345 6789' },
  { key: 'order.orderNumber', label: 'Order number', group: 'Order', sample: '20261016-00042' },
  { key: 'order.createdDate', label: 'Order date', group: 'Order', sample: '16 Oct 2026' },
  { key: 'order.planName', label: 'Plan or product', group: 'Order', sample: 'Postpaid 89' },
  { key: 'order.monthlyFee', label: 'Monthly fee', group: 'Order', sample: 'RM 89.00' },
  { key: 'order.upfrontAmount', label: 'Paid today', group: 'Order', sample: 'RM 0.00' },
  { key: 'order.contractMonths', label: 'Contract length', group: 'Order', sample: '24 months' },
  { key: 'order.items', label: 'Everything ordered', group: 'Order', sample: 'Postpaid 89; iPhone 18 Pro Max' },
  { key: 'service.msisdn', label: 'Mobile number', group: 'Identifiers', sample: '+60 12 345 6789' },
  { key: 'service.iccid', label: 'SIM (ICCID)', group: 'Identifiers', sample: '8960 1234 5678 9012 345' },
  { key: 'service.imei', label: 'Device IMEI', group: 'Identifiers', sample: '35 123456 789012 3' },
  { key: 'change.fromPlan', label: 'Current plan', group: 'Plan change', sample: 'Postpaid 89' },
  { key: 'change.toPlan', label: 'New plan', group: 'Plan change', sample: 'Postpaid 139' },
  { key: 'change.effectiveDate', label: 'Takes effect', group: 'Plan change', sample: '1 Nov 2026' },
  { key: 'signature.customerImage', label: 'Customer signature (image)', group: 'Signature', sample: '[ signature ]' },
  { key: 'signature.timestamp', label: 'Signed at', group: 'Signature', sample: '16 Oct 2026 15:44 UTC' },
  { key: 'signature.agentName', label: 'Taken by (staff)', group: 'Signature', sample: 'Ahmad, Orchard Flagship' },
  { key: 'company.name', label: 'Company name', group: 'Company', sample: 'Meridian' },
];
const KNOWN = new Set(TOKENS.map((t) => t.key));
export const SIGNATURE_MARK = '\u0001SIGNATURE\u0001';
const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9.]*)\s*\}\}/g;

export const tokensIn = (html: string): string[] => [...new Set([...html.matchAll(TOKEN_RE)].map((m) => m[1]!))];
export function templateProblems(html: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const unknown = tokensIn(html).filter((t) => !KNOWN.has(t));
  if (unknown.length) errors.push(`Unknown ${unknown.length === 1 ? 'token' : 'tokens'}: ${unknown.map((u) => `{{${u}}}`).join(', ')}.`);
  if (!textLines(html).length) errors.push('The template is empty.');
  if (!tokensIn(html).includes('signature.customerImage')) warnings.push('There is no {{signature.customerImage}}: the signature will be added at the end of the document.');
  return { errors, warnings };
}
/** Fills tokens. A value that is missing becomes an empty space, and is reported. The signature token becomes the marker the PDF writer replaces with the picture. */
export function fillTokens(html: string, values: Record<string, string | undefined>): { html: string; missing: string[] } {
  const missing = new Set<string>();
  const out = html.replace(TOKEN_RE, (_m, key: string) => {
    if (key === 'signature.customerImage') return SIGNATURE_MARK;
    const v = values[key];
    if (v === undefined || v === '') { missing.add(key); return '—'; }
    return escapeHtml(v);
  });
  return { html: out, missing: [...missing] };
}
export const sampleValues = (): Record<string, string> => Object.fromEntries(TOKENS.map((t) => [t.key, t.sample]));

const slug = (s: string) => s.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const clean = (s: unknown, max: number, what: string) => { const t = String(s ?? '').trim(); if (t.length > max) throw invalid(`${what} is too long (max ${max} characters).`); return t; };
const versionName = (v: Row) => (v.major === null || v.major === undefined ? 'draft' : `v${v.major}.${v.minor}`);
const vview = (v: Row, withHtml = true) => ({ id: v.id, templateId: v.templateId, version: versionName(v), major: v.major, minor: v.minor, status: v.status, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt, publishedBy: v.publishedBy, publishedAt: v.publishedAt, ...(withHtml ? { html: v.html } : {}) });

export interface TemplateInput { name: string; code?: string; description?: string; category: string; contexts?: string[]; offerKinds?: string[]; html?: string }
function checkMeta(i: { category?: string; contexts?: string[]; offerKinds?: string[] }) {
  if (i.category !== undefined && !(TEMPLATE_CATEGORIES as readonly string[]).includes(i.category)) throw invalid(`The category must be one of ${TEMPLATE_CATEGORIES.join(', ')}.`);
  if (i.contexts !== undefined && (!i.contexts.length || i.contexts.some((c) => !(TEMPLATE_CONTEXTS as readonly string[]).includes(c)))) throw invalid(`Choose where it is signed: ${TEMPLATE_CONTEXTS.join(' and/or ')}.`);
  if (i.offerKinds !== undefined && (i.offerKinds.length > 40 || i.offerKinds.some((k) => !/^[A-Z0-9_]{1,40}$/.test(k)))) throw invalid('Offer types are listed by their codes.');
}

export async function createAgreementTemplate(q: Queryable, who: DocWho, i: TemplateInput): Promise<Row> {
  const name = clean(i.name, 80, 'The name'); if (!name) throw invalid('Give the template a name.');
  checkMeta(i);
  const code = (i.code ? slug(i.code) : slug(name)) || 'TEMPLATE';
  if ((await q.query('SELECT 1 FROM document_templates WHERE code=$1', [code])).rows.length) throw conflict(`There is already a template with the code ${code}.`);
  const html = sanitizeHtml(i.html ?? '<h1>Agreement</h1><p>Write the terms here.</p><p>{{signature.customerImage}}</p>');
  const p = templateProblems(html); if (p.errors.length) throw invalid(p.errors.join(' '));
  const t = (await q.query(`INSERT INTO document_templates (code, name, description, category, contexts, offer_kinds, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [code, name, clean(i.description, 300, 'The description'), i.category, i.contexts ?? ['ORDER'], i.offerKinds ?? [], who.username])).rows[0]!;
  await q.query(`INSERT INTO template_versions (template_id, html, created_by) VALUES ($1,$2,$3)`, [t.id, html, who.username]);
  await logDocument(q, who, 'TEMPLATE_CREATE', { templateId: t.id, detail: { code, name } });
  return getAgreementTemplate(q, t.id);
}

export async function updateAgreementTemplate(q: Queryable, who: DocWho, id: string, i: { name?: string; description?: string; category?: string; contexts?: string[]; offerKinds?: string[]; status?: 'ACTIVE' | 'INACTIVE' }): Promise<Row> {
  const t = (await q.query('SELECT * FROM document_templates WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!t) throw notFound('template', id);
  checkMeta(i);
  if (i.name !== undefined && !clean(i.name, 80, 'The name')) throw invalid('Give the template a name.');
  await q.query(`UPDATE document_templates SET name=COALESCE($2,name), description=COALESCE($3,description), category=COALESCE($4,category), contexts=COALESCE($5,contexts), offer_kinds=COALESCE($6,offer_kinds), status=COALESCE($7,status), updated_at=now() WHERE id=$1`,
    [id, i.name === undefined ? null : clean(i.name, 80, 'The name'), i.description === undefined ? null : clean(i.description, 300, 'The description'), i.category ?? null, i.contexts ?? null, i.offerKinds ?? null, i.status ?? null]);
  await logDocument(q, who, 'TEMPLATE_EDIT', { templateId: id, detail: { fields: Object.keys(i) } });
  return getAgreementTemplate(q, id);
}

/** Saves the working draft (creating it from the live version when there is none yet). */
export async function saveAgreementDraft(q: Queryable, who: DocWho, templateId: string, i: { html: string; note?: string }): Promise<Row> {
  const t = (await q.query('SELECT * FROM document_templates WHERE id=$1 FOR UPDATE', [templateId])).rows[0];
  if (!t) throw notFound('template', templateId);
  const html = sanitizeHtml(i.html);
  const p = templateProblems(html); if (p.errors.length) throw invalid(p.errors.join(' '));
  const note = clean(i.note, 300, 'The note');
  const draft = (await q.query(`SELECT id FROM template_versions WHERE template_id=$1 AND status='DRAFT'`, [templateId])).rows[0];
  if (draft) await q.query(`UPDATE template_versions SET html=$2, note=$3, created_by=$4, created_at=now() WHERE id=$1`, [draft.id, html, note, who.username]);
  else await q.query(`INSERT INTO template_versions (template_id, html, note, created_by) VALUES ($1,$2,$3,$4)`, [templateId, html, note, who.username]);
  await q.query('UPDATE document_templates SET updated_at=now() WHERE id=$1', [templateId]);
  await logDocument(q, who, 'TEMPLATE_DRAFT', { templateId, detail: { characters: html.length } });
  return getAgreementTemplate(q, templateId);
}
export async function discardAgreementDraft(q: Queryable, who: DocWho, templateId: string): Promise<Row> {
  const r = await q.query(`DELETE FROM template_versions WHERE template_id=$1 AND status='DRAFT' AND EXISTS (SELECT 1 FROM template_versions p WHERE p.template_id=$1 AND p.status<>'DRAFT')`, [templateId]);
  if (!r.rowCount) throw rejected('There is no draft to discard, or this template has never been published.');
  await logDocument(q, who, 'TEMPLATE_DISCARD', { templateId });
  return getAgreementTemplate(q, templateId);
}

/**
 * Publishes the draft as the next version: a minor change (v1.0 → v1.1: wording, typos) or a major one (→ v2.0: the customer agrees to something new).
 * From then on every new order or plan change signs this version; the one before it is retired but stays on every document already signed with it.
 */
export async function publishAgreementTemplate(q: Queryable, who: DocWho, templateId: string, o: { bump?: 'minor' | 'major'; note?: string } = {}): Promise<Row> {
  const t = (await q.query('SELECT * FROM document_templates WHERE id=$1 FOR UPDATE', [templateId])).rows[0];
  if (!t) throw notFound('template', templateId);
  const draft = (await q.query(`SELECT * FROM template_versions WHERE template_id=$1 AND status='DRAFT'`, [templateId])).rows[0];
  if (!draft) throw rejected('There is nothing to publish: edit the template first.');
  const p = templateProblems(draft.html); if (p.errors.length) throw invalid(p.errors.join(' '));
  const last = (await q.query(`SELECT major, minor FROM template_versions WHERE template_id=$1 AND major IS NOT NULL ORDER BY major DESC, minor DESC LIMIT 1`, [templateId])).rows[0];
  const bump = last ? (o.bump ?? 'minor') : 'major';
  if (last && t.activeVersionId) {
    const cur = (await q.query('SELECT html FROM template_versions WHERE id=$1', [t.activeVersionId])).rows[0];
    if (cur && sanitizeHtml(cur.html) === draft.html) throw rejected('The draft is the same as the live version: nothing changed.');
  }
  const major = last ? (bump === 'major' ? last.major + 1 : last.major) : 1, minor = last ? (bump === 'major' ? 0 : last.minor + 1) : 0;
  if (t.activeVersionId) await q.query(`UPDATE template_versions SET status='RETIRED' WHERE id=$1`, [t.activeVersionId]);
  await q.query(`UPDATE template_versions SET status='PUBLISHED', major=$2, minor=$3, note=COALESCE(NULLIF($4,''), note), published_by=$5, published_at=now() WHERE id=$1`, [draft.id, major, minor, o.note?.trim().slice(0, 300) ?? '', who.username]);
  await q.query(`UPDATE document_templates SET active_version_id=$2, updated_at=now() WHERE id=$1`, [templateId, draft.id]);
  await logDocument(q, who, 'TEMPLATE_PUBLISH', { templateId, detail: { version: `v${major}.${minor}`, bump } });
  return getAgreementTemplate(q, templateId);
}

export async function listAgreementTemplates(q: Queryable): Promise<Row[]> {
  const rows = (await q.query(
    `SELECT t.*, v.major AS active_major, v.minor AS active_minor, v.published_at AS active_published_at,
            EXISTS (SELECT 1 FROM template_versions d WHERE d.template_id=t.id AND d.status='DRAFT') AS has_draft,
            (SELECT count(*)::int FROM template_versions x WHERE x.template_id=t.id AND x.status<>'DRAFT') AS versions
       FROM document_templates t LEFT JOIN template_versions v ON v.id = t.active_version_id ORDER BY t.sort_order, t.name`)).rows;
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, category: r.category, contexts: r.contexts, offerKinds: r.offerKinds, status: r.status, activeVersion: r.activeMajor === null ? null : `v${r.activeMajor}.${r.activeMinor}`, activePublishedAt: r.activePublishedAt, hasDraft: r.hasDraft, versions: r.versions, updatedAt: r.updatedAt }));
}
export async function getAgreementTemplate(q: Queryable, id: string): Promise<Row> {
  const t = (await q.query('SELECT * FROM document_templates WHERE id=$1', [id])).rows[0];
  if (!t) throw notFound('template', id);
  const versions = (await q.query(`SELECT * FROM template_versions WHERE template_id=$1 ORDER BY (status='DRAFT') DESC, major DESC NULLS FIRST, minor DESC NULLS FIRST, created_at DESC`, [id])).rows;
  const active = versions.find((v) => v.id === t.activeVersionId);
  const draft = versions.find((v) => v.status === 'DRAFT');
  const used = (await q.query(`SELECT template_version_id, count(*)::int AS n FROM documents WHERE template_version_id = ANY($1::uuid[]) GROUP BY 1`, [versions.map((v) => v.id)])).rows;
  return { id: t.id, code: t.code, name: t.name, description: t.description, category: t.category, contexts: t.contexts, offerKinds: t.offerKinds, status: t.status, createdBy: t.createdBy, createdAt: t.createdAt, updatedAt: t.updatedAt,
    activeVersion: active ? versionName(active) : null, active: active ? vview(active) : null, draft: draft ? vview(draft) : null,
    versions: versions.map((v) => ({ ...vview(v, false), signedDocuments: used.find((u) => u.templateVersionId === v.id)?.n ?? 0 })) };
}
export async function getVersion(q: Queryable, versionId: string): Promise<Row> {
  const v = (await q.query('SELECT v.*, t.name AS template_name, t.code FROM template_versions v JOIN document_templates t ON t.id=v.template_id WHERE v.id=$1', [versionId])).rows[0];
  if (!v) throw notFound('template version', versionId);
  return { ...vview(v), templateName: v.templateName, code: v.code };
}
/** What changed between two versions (either may be the draft). */
export async function compareVersions(q: Queryable, aId: string, bId: string) {
  const [a, b] = await Promise.all([getVersion(q, aId), getVersion(q, bId)]);
  if (a.templateId !== b.templateId) throw invalid('Compare two versions of the same template.');
  const lines = diffLines(textLines(a.html), textLines(b.html));
  return { from: a.version, to: b.version, lines, added: lines.filter((l) => l.op === 'add').length, removed: lines.filter((l) => l.op === 'del').length };
}

/** The published versions to sign for a context and the offer types in the basket (no offer types listed on a template = every offer). */
export async function activeTemplatesFor(q: Queryable, o: { context: TemplateContext; offerKinds: string[] }): Promise<Array<{ templateId: string; versionId: string; code: string; name: string; category: string; version: string; html: string }>> {
  const rows = (await q.query(
    `SELECT t.id AS template_id, t.code, t.name, t.category, t.offer_kinds, v.id AS version_id, v.major, v.minor, v.html
       FROM document_templates t JOIN template_versions v ON v.id = t.active_version_id
      WHERE t.status='ACTIVE' AND $1 = ANY(t.contexts) ORDER BY t.sort_order, t.name`, [o.context])).rows;
  return rows.filter((r) => !r.offerKinds.length || r.offerKinds.some((k: string) => o.offerKinds.includes(k)))
    .map((r) => ({ templateId: r.templateId, versionId: r.versionId, code: r.code, name: r.name, category: r.category, version: `v${r.major}.${r.minor}`, html: r.html }));
}

// ───────────────────────── starter templates ─────────────────────────
const SIG = '<h2>Signature</h2><p>Signed by {{customer.fullName}} ({{customer.nationalId}}) on {{signature.timestamp}}.</p><p>{{signature.customerImage}}</p><p>Taken by: {{signature.agentName}}</p>';
export const STARTER_TEMPLATES: Array<TemplateInput & { html: string }> = [
  { name: 'Subscriber Service Agreement', code: 'SUBSCRIBER_AGREEMENT', category: 'SUBSCRIBER_AGREEMENT', contexts: ['ORDER'], description: 'The main contract for a new service.',
    html: `<h1>{{company.name}} Subscriber Service Agreement</h1><p>Order <strong>{{order.orderNumber}}</strong>, {{order.createdDate}}</p><h2>1. Parties</h2><p>This agreement is between {{company.name}} and <strong>{{customer.fullName}}</strong>, ID {{customer.nationalId}}, of {{customer.address}} (the Subscriber).</p><h2>2. The service</h2><p>The Subscriber takes <strong>{{order.planName}}</strong> at <strong>{{order.monthlyFee}}</strong> a month, with {{order.upfrontAmount}} paid today. Minimum term: {{order.contractMonths}}.</p><p>Mobile number: {{service.msisdn}}. SIM: {{service.iccid}}.</p><h2>3. Payment</h2><p>Bills are issued monthly and are due by the date shown on each bill. Late payment can lead to a late fee, suspension and, after a period set out on the bill, termination.</p><h2>4. Ending the agreement</h2><ul><li>Ending the service during the minimum term can cost an early termination charge, as shown to the Subscriber when ordering.</li><li>After the minimum term the Subscriber may end the service at any time.</li></ul><h2>5. Personal data</h2><p>{{company.name}} keeps the Subscriber's identity documents and this agreement safely, uses them only to provide and bill the service and meet the law, and removes them when the retention period ends.</p>${SIG}` },
  { name: 'Fair Usage Policy', code: 'FAIR_USAGE', category: 'FAIR_USAGE', contexts: ['ORDER'], description: 'How "unlimited" and shared allowances are managed.',
    html: `<h1>Fair Usage Policy</h1><p>Applies to {{order.planName}} (order {{order.orderNumber}}).</p><ul><li>Allowances described as unlimited are for personal use. Heavy use that affects other customers may be slowed down after notice.</li><li>Resale, use in automated systems or SIM boxes is not allowed.</li><li>Shared allowances are shared by every line on the plan.</li></ul><p>I have read and accept this policy.</p><p>{{signature.customerImage}}</p><p>{{customer.fullName}}, {{signature.timestamp}}</p>` },
  { name: 'Device Instalment Terms', code: 'DEVICE_INSTALMENT', category: 'DEVICE_INSTALMENT', contexts: ['ORDER'], offerKinds: ['SIM_DEVICE', 'PHYSICAL_GOOD'], description: 'For devices paid by instalments or on a contract.',
    html: `<h1>Device Instalment Terms</h1><p>Order {{order.orderNumber}}: {{order.items}}. Device IMEI: {{service.imei}}.</p><ul><li>The device is paid in equal monthly instalments added to the monthly bill for {{order.contractMonths}}.</li><li>Leaving early means the remaining subsidy and instalments become payable, as shown when ordering.</li><li>The device stays the Subscriber's responsibility from delivery; report loss or theft at once.</li></ul>${SIG}` },
  { name: 'Plan Change Agreement', code: 'PLAN_CHANGE', category: 'PLAN_CHANGE', contexts: ['PLAN_CHANGE'], description: 'Signed when a service moves to another plan.',
    html: `<h1>Plan Change Agreement</h1><p>Number {{service.msisdn}}, {{customer.fullName}} ({{customer.nationalId}}).</p><p>The plan changes from <strong>{{change.fromPlan}}</strong> to <strong>{{change.toPlan}}</strong>, taking effect on {{change.effectiveDate}}. The new monthly fee is {{order.monthlyFee}}.</p><p>If the service is on a contract, the contract terms continue to apply.</p>${SIG}` },
];
/** Adds the starter set (published as v1.0) for any whose code is not there yet. */
export async function ensureStarterTemplates(q: Queryable, who: DocWho): Promise<number> {
  let n = 0;
  for (const s of STARTER_TEMPLATES) {
    if ((await q.query('SELECT 1 FROM document_templates WHERE code=$1', [s.code])).rows.length) continue;
    const t = await createAgreementTemplate(q, who, s);
    await publishAgreementTemplate(q, who, t.id as string, { note: 'Starter text' });
    n++;
  }
  return n;
}
