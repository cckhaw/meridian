import { audit } from './audit.js';
import { convertLegacy, type ConversionReport } from './billing-docs/legacy.js';
import { renderInvoicePdf, SCREEN_PROFILE, type PrintProfile } from './billing-docs/pdf.js';
import { defaultTemplate, sampleInvoice, validateTemplate, type InvoiceDoc, type TemplateSchema } from './billing-docs/schema.js';
import { getBranding, getRegional } from './settings.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { decodeCursor, encodeCursor, pageSize, type Page } from './paging.js';

/**
 * Bill templates. A template is a draft that is edited freely and a list of published, numbered versions. Bills are drawn with a published version
 * (the default one unless one is named), so editing a draft never changes a bill that has been sent, and a print job records which version it used.
 */
const SOURCES = { HTML: 'LEGACY_HTML', JSON: 'LEGACY_JSON', XML: 'LEGACY_XML' } as const;

const out = (r: Row) => ({ id: r.id as string, name: r.name as string, description: r.description as string, source: r.source as string, version: r.version as number,
  isDefault: r.isDefault as boolean, updatedBy: r.updatedBy as string, updatedAt: r.updatedAt, createdBy: r.createdBy as string, createdAt: r.createdAt });
const full = (r: Row) => ({ ...out(r), draft: r.draft as TemplateSchema, report: (r.report ?? null) as ConversionReport | null });

function checked(t: TemplateSchema): TemplateSchema {
  const problems = validateTemplate(t);
  if (problems.length) throw invalid(`The template has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.slice(0, 3).map((p) => p.message).join(' ')}`, problems);
  return t;
}
const nameOf = (s: unknown) => { const n = String(s ?? '').trim(); if (!n || n.length > 80) throw invalid('Give the template a name of 1–80 characters.'); return n; };

export async function listTemplates(q: Queryable) {
  return (await q.query(`SELECT * FROM bill_templates ORDER BY is_default DESC, name`)).rows.map(out);
}
export async function getTemplate(q: Queryable, id: string) {
  const r = (await q.query(`SELECT * FROM bill_templates WHERE id=$1`, [id])).rows[0];
  if (!r) throw notFound('Template', id);
  const versions = (await q.query(`SELECT version, note, published_by, published_at FROM bill_template_versions WHERE template_id=$1 ORDER BY version DESC`, [id])).rows;
  return { ...full(r), versions };
}

export async function createTemplate(q: Queryable, actor: string, input: { name: string; description?: string; template?: TemplateSchema; copyFrom?: string }) {
  const name = nameOf(input.name);
  let draft = input.template ?? defaultTemplate();
  if (input.copyFrom) draft = (await getTemplate(q, input.copyFrom)).draft;
  checked(draft);
  const r = (await q.query(`INSERT INTO bill_templates (name, description, draft, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *`, [name, input.description ?? '', JSON.stringify(draft), actor])).rows[0]!;
  await audit(q, actor, 'bill_template', r.id, 'CREATE', { name });
  return full(r);
}

export async function saveDraft(q: Queryable, actor: string, id: string, patch: { name?: string; description?: string; template?: TemplateSchema }) {
  const cur = await getTemplate(q, id);
  if (patch.template) checked(patch.template);
  const r = (await q.query(`UPDATE bill_templates SET name=$2, description=$3, draft=$4, updated_by=$5, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, patch.name === undefined ? cur.name : nameOf(patch.name), patch.description ?? cur.description, JSON.stringify(patch.template ?? cur.draft), actor])).rows[0]!;
  await audit(q, actor, 'bill_template', id, 'EDIT', {});
  return full(r);
}

/** Publishes the draft as the next version. The first published template becomes the default. */
export async function publishTemplate(q: Queryable, actor: string, id: string, note = '') {
  const cur = await getTemplate(q, id);
  checked(cur.draft);
  const version = cur.version + 1;
  await q.query(`INSERT INTO bill_template_versions (template_id, version, schema, note, published_by) VALUES ($1,$2,$3,$4,$5)`, [id, version, JSON.stringify(cur.draft), note.slice(0, 300), actor]);
  const anyDefault = Number((await q.query(`SELECT count(*) AS n FROM bill_templates WHERE is_default`)).rows[0]!.n) > 0;
  await q.query(`UPDATE bill_templates SET version=$2, is_default = is_default OR $3, updated_by=$4, updated_at=now() WHERE id=$1`, [id, version, !anyDefault, actor]);
  await audit(q, actor, 'bill_template', id, 'PUBLISH', { version });
  return getTemplate(q, id);
}

export async function setDefaultTemplate(q: Queryable, actor: string, id: string) {
  const cur = await getTemplate(q, id);
  if (cur.version < 1) throw conflict('Publish the template before making it the default.');
  await q.query(`UPDATE bill_templates SET is_default=false WHERE is_default AND id<>$1`, [id]);
  await q.query(`UPDATE bill_templates SET is_default=true WHERE id=$1`, [id]);
  await audit(q, actor, 'bill_template', id, 'SET_DEFAULT', {});
  return getTemplate(q, id);
}

export async function deleteTemplate(q: Queryable, actor: string, id: string) {
  const cur = await getTemplate(q, id);
  if (cur.isDefault) throw conflict('This is the default template. Make another one the default first.');
  if (Number((await q.query(`SELECT count(*) AS n FROM print_jobs WHERE template_id=$1`, [id])).rows[0]!.n) > 0) throw conflict('Print jobs used this template, so it is kept for the record.');
  await q.query(`DELETE FROM bill_templates WHERE id=$1`, [id]);
  await audit(q, actor, 'bill_template', id, 'DELETE', { name: cur.name });
  return { ok: true };
}

/** A published version's layout: the one named, else the latest of the template, else the default template's latest. */
export async function publishedSchema(q: Queryable, templateId?: string | null, version?: number | null): Promise<{ templateId: string; version: number; name: string; schema: TemplateSchema }> {
  const t = (await q.query(templateId ? `SELECT id, name, version FROM bill_templates WHERE id=$1` : `SELECT id, name, version FROM bill_templates WHERE is_default`, templateId ? [templateId] : [])).rows[0];
  if (!t) {
    if (templateId) throw notFound('Template', templateId);
    return { templateId: '', version: 0, name: 'Built-in layout', schema: defaultTemplate() };   // nothing designed yet: the layout that comes with the system
  }
  const v = version ?? (t.version as number);
  if (v < 1) throw conflict(`Template “${t.name}” has not been published yet.`);
  const row = (await q.query(`SELECT schema FROM bill_template_versions WHERE template_id=$1 AND version=$2`, [t.id, v])).rows[0];
  if (!row) throw notFound('Template version', `${t.name} v${v}`);
  return { templateId: t.id as string, version: v, name: t.name as string, schema: row.schema as TemplateSchema };
}

// ───────────────────────── legacy conversion ─────────────────────────
export function convertTemplate(input: { format: 'HTML' | 'JSON' | 'XML'; content: string; tokenMap?: Record<string, string> }) {
  if (!['HTML', 'JSON', 'XML'].includes(input.format)) throw invalid('The format must be HTML, JSON or XML.');
  if (!input.content?.trim()) throw invalid('Paste or upload the legacy template.');
  if (input.content.length > 2_000_000) throw invalid('The legacy template is larger than 2 MB.');
  try { return convertLegacy(input); } catch (e) { throw invalid(`The ${input.format} could not be read: ${(e as Error).message}`); }
}
/** Converts and keeps the result as a new draft, with the conversion report beside it. */
export async function importLegacy(q: Queryable, actor: string, input: { name: string; format: 'HTML' | 'JSON' | 'XML'; content: string; tokenMap?: Record<string, string> }) {
  const { template, report } = convertTemplate(input);
  const r = (await q.query(`INSERT INTO bill_templates (name, source, draft, report, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [nameOf(input.name), SOURCES[input.format], JSON.stringify(template), JSON.stringify(report), actor])).rows[0]!;
  await audit(q, actor, 'bill_template', r.id, 'IMPORT_LEGACY', { format: input.format, blocks: report.blocks, unsupported: report.unsupported.length });
  return { ...full(r), problems: validateTemplate(template) };
}

// ───────────────────────── the data on a bill ─────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]), JPG = Buffer.from([0xff, 0xd8]);
/** The logo as a data URI the PDF can embed; WebP is not embeddable, so the bill goes without it. */
async function logoUri(q: Queryable): Promise<string | null> {
  const r = (await q.query(`SELECT bytes FROM assets WHERE name='logo'`)).rows[0];
  if (!r) return null;
  const b = Buffer.from(r.bytes);
  const type = b.subarray(0, 4).equals(PNG) ? 'png' : b.subarray(0, 2).equals(JPG) ? 'jpeg' : null;
  return type ? `data:image/${type};base64,${b.toString('base64')}` : null;
}
export interface DocContext { regional: Awaited<ReturnType<typeof getRegional>>; company: InvoiceDoc['company']; payBase: string }
export async function docContext(q: Queryable, o: { payBase?: string } = {}): Promise<DocContext> {
  const [regional, brand, logo] = await Promise.all([getRegional(q), getBranding(q), logoUri(q)]);
  return { regional, company: { name: brand.name, logo, lines: [] }, payBase: o.payBase ?? '' };
}

/** Invoices as bill documents, for rendering. Loaded in one pass for a whole list of invoices. */
export async function loadInvoiceDocs(q: Queryable, ids: string[], ctx: DocContext): Promise<Map<string, InvoiceDoc>> {
  if (!ids.length) return new Map();
  const inv = (await q.query(
    `SELECT i.*, c.display_name AS customer_name, c.email, c.phone, c.address, c.id AS cust_id
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ANY($1::uuid[])`, [ids])).rows;
  const lines = (await q.query(
    `SELECT l.invoice_id, l.kind, l.stream, l.description, l.service_id, l.net_minor, l.tax_minor, s.identifier
       FROM invoice_lines l LEFT JOIN services s ON s.id = l.service_id WHERE l.invoice_id = ANY($1::uuid[]) ORDER BY l.invoice_id, l.id`, [ids])).rows;
  const taxName = (await q.query(`SELECT value FROM settings WHERE key='regional'`)).rows[0]?.value?.taxName ?? ctx.regional.taxName ?? 'Tax';
  const by = new Map<string, Row[]>();
  for (const l of lines) (by.get(l.invoiceId) ?? by.set(l.invoiceId, []).get(l.invoiceId)!).push(l);
  const docs = new Map<string, InvoiceDoc>();
  for (const i of inv) {
    const a = (i.address ?? {}) as { line1?: string; line2?: string; postcode?: string; city?: string; state?: string; country?: string };
    const addr = [a.line1, a.line2].filter(Boolean) as string[];
    docs.set(i.id, {
      company: ctx.company,
      customer: { id: i.custId, name: i.customerName, email: i.email ?? '', phone: i.phone ?? '', lines: addr, postcode: a.postcode ?? '', city: a.city ?? '', country: a.country ?? '', addressMissing: !addr.length },
      account: { id: i.accountId, name: `Account …${String(i.accountId).slice(-6)}`, currency: i.currency },
      invoice: { id: i.id, number: i.number, kind: i.kind, status: i.status, issueDate: i.issueDate, dueDate: i.dueDate, periodStart: i.periodStart, periodEnd: i.periodEnd, currency: i.currency,
        netMinor: Number(i.netMinor), taxMinor: Number(i.taxMinor), totalMinor: Number(i.totalMinor), paidMinor: Number(i.paidMinor), creditedMinor: Number(i.creditedMinor),
        balanceMinor: Number(i.totalMinor) - Number(i.paidMinor) - Number(i.creditedMinor), taxName },
      lines: (by.get(i.id) ?? []).map((l) => ({ kind: l.kind, stream: l.stream ?? (l.kind === 'ETC' ? 'ETC' : l.kind === 'INSTALLMENT' ? 'DEVICE_INSTALMENT' : 'SUBSCRIPTION'), description: l.description,
        serviceId: l.serviceId ?? null, identifier: l.identifier ?? '', netMinor: Number(l.netMinor), taxMinor: Number(l.taxMinor) })),
      payment: { url: ctx.payBase ? `${ctx.payBase}/${i.number}` : '', reference: i.number },
      regional: ctx.regional,
    });
  }
  return docs;
}

/** One issued invoice as a PDF, with the default (or named) template. */
export async function invoicePdf(q: Queryable, invoiceId: string, o: { templateId?: string; version?: number; profile?: PrintProfile; payBase?: string } = {}) {
  const ctx = await docContext(q, o);
  const doc = (await loadInvoiceDocs(q, [invoiceId], ctx)).get(invoiceId);
  if (!doc) throw notFound('Invoice', invoiceId);
  const t = await publishedSchema(q, o.templateId, o.version);
  const r = await renderInvoicePdf(t.schema, doc, o.profile ?? SCREEN_PROFILE);
  return { ...r, number: doc.invoice.number, template: { id: t.templateId, name: t.name, version: t.version } };
}

/** A look at a template (the draft, or a published version) with made-up data, or with a real invoice's data. */
export async function previewTemplatePdf(q: Queryable, o: { template: TemplateSchema; invoiceId?: string; profile?: PrintProfile }) {
  checked(o.template);
  const ctx = await docContext(q);
  const doc = o.invoiceId ? (await loadInvoiceDocs(q, [o.invoiceId], ctx)).get(o.invoiceId) : { ...sampleInvoice(ctx.regional, ctx.company.name), company: { ...ctx.company, lines: ['1 Raffles Quay', 'Singapore 048583'] } };
  if (!doc) throw notFound('Invoice', o.invoiceId);
  return renderInvoicePdf(o.template, doc, o.profile ?? SCREEN_PROFILE);
}

export async function listTemplateSamples(q: Queryable, cursor?: string, limit?: number): Promise<Page<Row>> {
  const n = pageSize(limit, 20, 50), c = decodeCursor(cursor, 2);
  const rows = (await q.query(`SELECT id, number, issue_date, total_minor, created_at FROM invoices WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid)) ORDER BY created_at DESC, id DESC LIMIT $3`, [c?.[0] ?? null, c?.[1] ?? null, n + 1])).rows;
  const more = rows.length > n; const items = rows.slice(0, n);
  return { items, nextCursor: more ? encodeCursor([new Date(items[n - 1]!.createdAt).toISOString(), items[n - 1]!.id]) : null };
}
