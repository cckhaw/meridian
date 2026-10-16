import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { LINK_TTL_SECONDS, presignGet, s3Config, s3Delete, s3Get, s3Put, signLink, verifyLink } from './doc-store.js';
import { decryptBytes, encryptBytes, sha256Hex } from './field-crypto.js';
import { inspectDocument } from './kyc.js';
import { decodeCursor, pageSize, sqlBuilder, tsPage, type Page } from './paging.js';

/**
 * The document vault: identity documents (encrypted), signed agreements and signature images, one list for all of them, with who may see what, what
 * has been verified, how long each is kept, and a line in an append-only log for every view, download, edit and purge (PDPA / GDPR).
 */
export const KYC_CATEGORIES = ['NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'PASSPORT', 'UTILITY_BILL', 'CORPORATE_REGISTRATION_SSM', 'PROOF_OF_ADDRESS'] as const;
export const KYC_EXTRA_CATEGORIES = ['SELFIE', 'CUSTOMER_SIGNATURE'] as const;   // evidence the store-front also collects
export type KycCategory = (typeof KYC_CATEGORIES)[number];
export const DOC_STATUSES = ['PENDING_VERIFICATION', 'VERIFIED_AUTO', 'VERIFIED_MANUAL', 'REJECTED', 'EXPIRED', 'PURGED_RETENTION', 'ACTIVE', 'SUPERSEDED'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export const MAX_VAULT_BYTES = 3_000_000;   // as base64 in a JSON request this stays under the 4.5 MB platform limit

export interface DocWho { username: string; ip?: string | null; userAgent?: string | null }

export interface DocumentSettings {
  /** Identity uploads that never reached a customer are purged after this many hours. */
  tempUploadHours: number;
  /** Identity documents are kept this many years after the customer's last service ended. */
  kycRetentionYears: number;
  /** Signed agreements are kept this many years after the service ended (or after signing, if there is none). */
  contractRetentionYears: number;
  /** A new order for an offer with a published agreement cannot be placed until the customer has signed it. */
  requireAtOrder: boolean;
  /** The same for moving a service to another plan. */
  requireAtPlanChange: boolean;
  /** Send the signed copy to the customer when the order is paid. */
  deliverContracts: boolean;
}
export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = { tempUploadHours: 48, kycRetentionYears: 7, contractRetentionYears: 7, requireAtOrder: false, requireAtPlanChange: false, deliverContracts: true };

export async function getDocumentSettings(q: Queryable): Promise<DocumentSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='documents'`)).rows[0]?.value ?? {};
  return { ...DEFAULT_DOCUMENT_SETTINGS, ...v };
}
export async function setDocumentSettings(q: Queryable, actor: string, i: Partial<DocumentSettings>): Promise<DocumentSettings> {
  const cur = await getDocumentSettings(q);
  const n = { ...cur, ...i };
  const int = (v: number, lo: number, hi: number, what: string) => { if (!Number.isInteger(v) || v < lo || v > hi) throw invalid(`${what} must be a whole number from ${lo} to ${hi}.`); };
  int(n.tempUploadHours, 1, 24 * 30, 'Hours before an unclaimed upload is removed'); int(n.kycRetentionYears, 0, 50, 'Years identity documents are kept'); int(n.contractRetentionYears, 0, 50, 'Years agreements are kept');
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('documents', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(n), actor]);
  await audit(q, actor, 'settings', 'documents', 'update', { ...n });
  return n;
}

// ───────────────────────── the access log ─────────────────────────
export async function logDocument(q: Queryable, who: DocWho, action: string, o: { documentId?: string | null; templateId?: string | null; customerId?: string | null; detail?: Record<string, unknown> } = {}) {
  await q.query(`INSERT INTO document_audit_log (document_id, template_id, customer_id, action, actor, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [o.documentId ?? null, o.templateId ?? null, o.customerId ?? null, action, who.username, who.ip?.slice(0, 64) ?? null, who.userAgent?.slice(0, 300) ?? null, JSON.stringify(o.detail ?? {})]);
}
export async function documentLog(q: Queryable, f: { documentId?: string; customerId?: string; actor?: string; limit?: number } = {}): Promise<Row[]> {
  const b = sqlBuilder(), where: string[] = [];
  if (f.documentId) where.push(`document_id = ${b.p(f.documentId)}`);
  if (f.customerId) where.push(`customer_id = ${b.p(f.customerId)}`);
  if (f.actor) where.push(`actor = ${b.p(f.actor)}`);
  return (await q.query(`SELECT id, document_id, template_id, customer_id, action, actor, ip, user_agent, detail, at FROM document_audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${Math.min(f.limit ?? 100, 500)}`, b.params)).rows;
}

// ───────────────────────── storing and reading bytes ─────────────────────────
export interface NewDocument {
  kind: 'KYC' | 'CONTRACT' | 'SIGNATURE'; category: string; name: string; contentType: string; bytes: Buffer;
  customerId?: string | null; applicationId?: string | null; orderId?: string | null; serviceId?: string | null; kycCaseId?: string | null;
  encrypt?: boolean; status?: DocStatus; expiresAt?: string | null; retentionUntil?: string | null; templateVersionId?: string | null; meta?: Record<string, unknown>;
}
export async function putDocument(q: Queryable, i: NewDocument, actor: string, fetchImpl?: typeof fetch): Promise<Row> {
  const id = randomUUID(), s3 = s3Config();
  const stored = i.encrypt ? encryptBytes(i.bytes) : i.bytes;
  let storage: 'DB' | 'S3' = 'DB', key: string | null = null, data: Buffer | null = stored;
  if (s3) { key = `${i.kind.toLowerCase()}/${i.customerId ?? 'none'}/${id}`; await s3Put(s3, key, stored, i.encrypt ? 'application/octet-stream' : i.contentType, fetchImpl); storage = 'S3'; data = null; }
  const r = (await q.query(
    `INSERT INTO documents (id, kind, category, customer_id, application_id, order_id, service_id, name, content_type, size_bytes, sha256, storage, storage_key, data, encrypted, status, expires_at, retention_until, template_version_id, meta, created_by, kyc_case_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [id, i.kind, i.category, i.customerId ?? null, i.applicationId ?? null, i.orderId ?? null, i.serviceId ?? null, i.name.slice(0, 200), i.contentType, i.bytes.length, sha256Hex(i.bytes), storage, key, data, !!i.encrypt,
     i.status ?? 'ACTIVE', i.expiresAt ?? null, i.retentionUntil ?? null, i.templateVersionId ?? null, JSON.stringify(i.meta ?? {}), actor, i.kycCaseId ?? null])).rows[0]!;
  return r;
}

async function readStored(q: Queryable, row: Row, fetchImpl?: typeof fetch): Promise<Buffer> {
  if (row.purgedAt) throw rejected('This document has been removed under the retention policy.');
  let raw: Buffer;
  if (row.storage === 'KYC_LEGACY') {   // the store-front's identity evidence stays where it was written
    const r = (await q.query('SELECT data FROM kyc_documents WHERE id=$1', [row.storageKey])).rows[0];
    if (!r) throw notFound('document', row.id);
    return decryptBytes(Buffer.from(r.data));
  } else if (row.storage === 'S3') {
    const c = s3Config(); if (!c) throw new Error('The document store is not configured, so this file cannot be read.');
    raw = await s3Get(c, row.storageKey, fetchImpl);
  } else raw = Buffer.from(row.data);
  return row.encrypted ? decryptBytes(raw) : raw;
}

// ───────────────────────── identity documents ─────────────────────────
export async function uploadKyc(q: Queryable, i: { customerId: string; category: string; name?: string; bytes: Buffer; expiresAt?: string | null }, who: DocWho, fetchImpl?: typeof fetch): Promise<Row> {
  if (!(KYC_CATEGORIES as readonly string[]).includes(i.category)) throw invalid(`The category must be one of ${KYC_CATEGORIES.join(', ')}.`);
  if (!i.bytes.length) throw invalid('The file is empty.');
  if (i.bytes.length > MAX_VAULT_BYTES) throw invalid(`The file is larger than ${(MAX_VAULT_BYTES / 1_000_000).toFixed(0)} MB.`);
  const info = inspectDocument(i.bytes);
  if (!info) throw invalid('Upload a JPEG, PNG, WebP or PDF file.');
  if (!(await q.query('SELECT 1 FROM customers WHERE id=$1', [i.customerId])).rows.length) throw notFound('customer', i.customerId);
  if (i.expiresAt && Number.isNaN(Date.parse(i.expiresAt))) throw invalid('The expiry is not a date.');
  const r = await putDocument(q, { kind: 'KYC', category: i.category, name: i.name?.trim() || i.category.toLowerCase().replace(/_/g, ' '), contentType: info.contentType, bytes: i.bytes, customerId: i.customerId, encrypt: true, status: 'PENDING_VERIFICATION', expiresAt: i.expiresAt ?? null }, who.username, fetchImpl);
  await logDocument(q, who, 'UPLOAD', { documentId: r.id, customerId: i.customerId, detail: { category: i.category, sizeBytes: i.bytes.length } });
  return view(r);
}

/** A person (or the identity check itself) decides on a document. Verified documents can still expire; a rejected one stays on record. */
export async function decideDocument(q: Queryable, id: string, who: DocWho, d: { decision: 'VERIFY' | 'REJECT'; reason?: string; auto?: boolean }): Promise<Row> {
  const doc = (await q.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!doc) throw notFound('document', id);
  if (doc.kind !== 'KYC') throw rejected('Only identity documents are verified.');
  if (doc.purgedAt) throw conflict('This document has been removed.');
  if (d.decision === 'REJECT' && !d.reason?.trim()) throw invalid('Give a reason for rejecting the document.');
  if (d.decision === 'VERIFY' && doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) throw rejected('This document has expired, so it cannot be verified.');
  const status: DocStatus = d.decision === 'REJECT' ? 'REJECTED' : d.auto ? 'VERIFIED_AUTO' : 'VERIFIED_MANUAL';
  const r = (await q.query(`UPDATE documents SET status=$2, status_reason=$3, verified_by=$4, verified_at=now() WHERE id=$1 RETURNING *`, [id, status, d.reason?.trim() ?? null, who.username])).rows[0]!;
  await logDocument(q, who, d.decision, { documentId: id, customerId: doc.customerId, detail: { from: doc.status, to: status, reason: d.reason ?? null } });
  return view(r);
}

/** The store-front's identity evidence is part of the vault: keep its line (and verification state) in step with the case decision. */
export async function mirrorLegacyDocument(q: Queryable, kycDocumentId: string, o: { customerId?: string | null; category: string; kind: string; contentType: string; sizeBytes: number; sha256: string; applicationId: string }) {
  await q.query(`DELETE FROM documents WHERE storage='KYC_LEGACY' AND application_id=$1 AND category=$2 AND storage_key <> $3`, [o.applicationId, o.category, kycDocumentId]);   // a new upload replaces the old one
  await q.query(`INSERT INTO documents (kind, category, customer_id, application_id, name, content_type, size_bytes, sha256, storage, storage_key, encrypted, status, created_by)
    VALUES ('KYC',$1,$2,$3,$4,$5,$6,$7,'KYC_LEGACY',$8,true,'PENDING_VERIFICATION','applicant') ON CONFLICT (storage_key) WHERE storage = 'KYC_LEGACY' DO NOTHING`,
    [o.category, o.customerId ?? null, o.applicationId, o.kind.toLowerCase(), o.contentType, o.sizeBytes, o.sha256, kycDocumentId]);
}
/** The case decision settles every live piece of evidence in it (and the store-front's older rows for the same application). */
export async function settleCaseDocuments(q: Queryable, c: { caseId: string; applicationId: string | null }, outcome: 'APPROVED' | 'REJECTED', customerId: string | null, by: string | null, reason?: string | null) {
  await q.query(`UPDATE documents SET status=$3, status_reason=$6, verified_by=$4, verified_at=now(), customer_id=COALESCE(customer_id,$5)
     WHERE purged_at IS NULL AND status NOT IN ('SUPERSEDED','PURGED_RETENTION') AND (kyc_case_id=$1 OR ($2::uuid IS NOT NULL AND application_id=$2 AND storage='KYC_LEGACY'))`,
    [c.caseId, c.applicationId, outcome === 'APPROVED' ? (by ? 'VERIFIED_MANUAL' : 'VERIFIED_AUTO') : 'REJECTED', by ?? 'system', customerId, outcome === 'REJECTED' ? reason ?? null : null]);
}
/** Evidence taken before the shopper became a customer belongs to the customer from checkout on, so the clean-up of unclaimed uploads leaves it alone. */
export async function claimCaseDocuments(q: Queryable, caseId: string, customerId: string) {
  await q.query(`UPDATE documents SET customer_id=$2 WHERE kyc_case_id=$1 AND customer_id IS NULL`, [caseId, customerId]);
}

// ───────────────────────── listing ─────────────────────────
const view = (r: Row) => { const { data: _d, storageKey: _k, ...rest } = r; return rest as Row; };
export interface DocFilter { customerId?: string; kind?: string; category?: string; status?: string; orderId?: string; serviceId?: string; q?: string; limit?: number; cursor?: string; kinds?: string[] }
export async function listVaultDocuments(q: Queryable, f: DocFilter = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit), b = sqlBuilder(), where: string[] = [];
  if (f.customerId) where.push(`d.customer_id = ${b.p(f.customerId)}`);
  if (f.orderId) where.push(`d.order_id = ${b.p(f.orderId)}`);
  if (f.serviceId) where.push(`d.service_id = ${b.p(f.serviceId)}`);
  if (f.kind) where.push(`d.kind = ${b.p(f.kind)}`);
  if (f.kinds) where.push(`d.kind = ANY(${b.p(f.kinds)}::text[])`);
  if (f.category) where.push(`d.category = ${b.p(f.category)}`);
  if (f.status) where.push(`d.status = ${b.p(f.status)}`);
  if (f.q?.trim()) { const t = `%${f.q.trim().toLowerCase().slice(0, 80)}%`; where.push(`(lower(c.display_name) LIKE ${b.p(t)} OR lower(d.name) LIKE ${b.p(t)} OR d.order_id::text LIKE ${b.p(t)} OR d.customer_id::text LIKE ${b.p(t)})`); }
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(d.created_at::text, d.id::text) < (${b.p(cur[0])}, ${b.p(cur[1])})`);
  const rows = (await q.query(
    `SELECT d.id, d.kind, d.category, d.customer_id, d.order_id, d.service_id, d.name, d.content_type, d.size_bytes, d.sha256, d.storage, d.encrypted, d.status, d.status_reason, d.verified_by, d.verified_at, d.expires_at,
            d.retention_until, d.purged_at, d.template_version_id, d.meta, d.created_by, d.created_at, d.created_at::text AS cursor_ts, c.display_name AS customer_name
       FROM documents d LEFT JOIN customers c ON c.id = d.customer_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit + 1}`, b.params)).rows;
  return tsPage(rows as Array<Row & { cursorTs?: string; id: string }>, limit) as Page<Row>;
}
export async function getVaultDocument(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query(`SELECT d.*, c.display_name AS customer_name FROM documents d LEFT JOIN customers c ON c.id = d.customer_id WHERE d.id=$1`, [id])).rows[0];
  if (!r) throw notFound('document', id);
  return view(r);
}

// ───────────────────────── viewing and downloading ─────────────────────────
/** The bytes of a document, checked against the hash recorded when it was stored, with the access written to the log first. */
export async function openDocument(q: Queryable, id: string, who: DocWho, action: 'VIEW' | 'DOWNLOAD', fetchImpl?: typeof fetch): Promise<{ contentType: string; bytes: Buffer; name: string; row: Row }> {
  const row = (await q.query('SELECT * FROM documents WHERE id=$1', [id])).rows[0];
  if (!row) throw notFound('document', id);
  await logDocument(q, who, action, { documentId: id, customerId: row.customerId, detail: { kind: row.kind, category: row.category } });
  const bytes = await readStored(q, row, fetchImpl);
  if (sha256Hex(bytes) !== row.sha256) { await logDocument(q, who, 'INTEGRITY_FAILURE', { documentId: id, customerId: row.customerId }); throw new Error('The document failed its integrity check.'); }
  return { contentType: row.contentType, bytes, name: row.name, row };
}
/** A link that works for 15 minutes. Contracts held in a bucket get the bucket's own signed link; everything else goes through our own, which is checked against the log. */
export async function documentLink(q: Queryable, id: string, who: DocWho, o: { download?: boolean; baseUrl?: string } = {}): Promise<{ url: string; expiresAt: string; ttlSeconds: number }> {
  const row = (await q.query('SELECT id, kind, storage, storage_key, encrypted, purged_at, customer_id, name FROM documents WHERE id=$1', [id])).rows[0];
  if (!row) throw notFound('document', id);
  if (row.purgedAt) throw rejected('This document has been removed under the retention policy.');
  await logDocument(q, who, 'LINK_ISSUED', { documentId: id, customerId: row.customerId, detail: { download: !!o.download, ttl: LINK_TTL_SECONDS } });
  const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();
  const c = s3Config();
  if (row.storage === 'S3' && !row.encrypted && c) return { url: presignGet(c, row.storageKey, { filename: o.download ? `${row.name}.pdf` : undefined }), expiresAt, ttlSeconds: LINK_TTL_SECONDS };
  return { url: `${o.baseUrl ?? ''}/api/documents/file/${signLink(id, { download: o.download })}`, expiresAt, ttlSeconds: LINK_TTL_SECONDS };
}
export async function fileByLink(q: Queryable, token: string, who: DocWho, fetchImpl?: typeof fetch) {
  const t = verifyLink(token);
  if (!t) throw rejected('This link has expired or is not valid. Ask for a new one.');
  const r = await openDocument(q, t.documentId, { ...who, username: who.username || 'link' }, t.download ? 'DOWNLOAD' : 'VIEW', fetchImpl);
  return { ...r, download: t.download };
}

// ───────────────────────── retention ─────────────────────────
export async function purgeDocument(q: Queryable, id: string, who: DocWho, reason: string, fetchImpl?: typeof fetch): Promise<void> {
  const row = (await q.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw notFound('document', id);
  if (row.purgedAt) return;
  if (row.storage === 'S3') { const c = s3Config(); if (c) await s3Delete(c, row.storageKey, fetchImpl); }
  if (row.storage === 'KYC_LEGACY') await q.query('DELETE FROM kyc_documents WHERE id=$1', [row.storageKey]);
  await q.query(`UPDATE documents SET data=NULL, storage_key=CASE WHEN storage='KYC_LEGACY' THEN storage_key ELSE NULL END, status='PURGED_RETENTION', status_reason=$2, purged_at=now() WHERE id=$1`, [id, reason.slice(0, 300)]);
  await logDocument(q, who, 'PURGE', { documentId: id, customerId: row.customerId, detail: { reason, kind: row.kind, category: row.category } });
}

export interface SweepResult { expired: number; unclaimedPurged: number; retentionSet: number; retentionPurged: number }
/**
 * Run daily. (1) Identity documents past their own expiry become EXPIRED. (2) Uploads that never reached a customer are removed after the configured hours.
 * (3) When a customer has no live service left, their identity documents get a purge date (years after the last termination). (4) Anything past its date is purged.
 * A document is never purged while its customer has a live service.
 */
export async function sweepDocuments(db: Db, now = new Date(), actor = 'system', fetchImpl?: typeof fetch): Promise<SweepResult> {
  const s = await getDocumentSettings(db);
  const who: DocWho = { username: actor };
  return db.tx(async (q) => {
    const expired = (await q.query(`UPDATE documents SET status='EXPIRED' WHERE kind='KYC' AND purged_at IS NULL AND status IN ('VERIFIED_AUTO','VERIFIED_MANUAL') AND expires_at IS NOT NULL AND expires_at < $1 RETURNING id, customer_id`, [now.toISOString()])).rows;
    for (const r of expired) await logDocument(q, who, 'EXPIRE', { documentId: r.id, customerId: r.customerId });
    const stale = (await q.query(`SELECT id FROM documents WHERE kind='KYC' AND customer_id IS NULL AND storage <> 'KYC_LEGACY' AND status='PENDING_VERIFICATION' AND purged_at IS NULL AND created_at < $1
        AND (kyc_case_id IS NULL OR NOT EXISTS (SELECT 1 FROM kyc_cases k LEFT JOIN applications a ON a.id = k.application_id WHERE k.id = documents.kyc_case_id AND k.status IN ('PENDING','RETURNED') AND COALESCE(a.status,'KYC_REVIEW') NOT IN ('EXPIRED','CANCELLED')))`, [new Date(now.getTime() - s.tempUploadHours * 3_600_000).toISOString()])).rows;
    for (const r of stale) await purgeDocument(q, r.id, who, `Unclaimed upload removed after ${s.tempUploadHours} hours`, fetchImpl);
    // Customers with no live service and at least one ended: the retention clock starts at the last termination.
    const ended = (await q.query(
      `SELECT sv.customer_id, max(sv.terminated_at) AS last_end FROM services sv
        WHERE sv.customer_id IS NOT NULL GROUP BY sv.customer_id
       HAVING bool_and(sv.status = 'TERMINATED') AND max(sv.terminated_at) IS NOT NULL`)).rows;
    let retentionSet = 0;
    for (const e of ended) {
      const kyc = new Date(e.lastEnd); kyc.setUTCFullYear(kyc.getUTCFullYear() + s.kycRetentionYears);
      const con = new Date(e.lastEnd); con.setUTCFullYear(con.getUTCFullYear() + s.contractRetentionYears);
      const a = await q.query(`UPDATE documents SET retention_until=$2 WHERE customer_id=$1 AND kind IN ('KYC','SIGNATURE') AND purged_at IS NULL AND retention_until IS NULL`, [e.customerId, kyc.toISOString()]);
      const b = await q.query(`UPDATE documents SET retention_until=$2 WHERE customer_id=$1 AND kind='CONTRACT' AND purged_at IS NULL AND retention_until IS NULL`, [e.customerId, con.toISOString()]);
      retentionSet += (a.rowCount ?? 0) + (b.rowCount ?? 0);
    }
    // A customer who came back (a live service again) stops the clock.
    await q.query(`UPDATE documents d SET retention_until=NULL WHERE d.retention_until IS NOT NULL AND d.purged_at IS NULL AND EXISTS (SELECT 1 FROM services sv WHERE sv.customer_id=d.customer_id AND sv.status <> 'TERMINATED')`);
    const due = (await q.query(`SELECT id FROM documents WHERE purged_at IS NULL AND retention_until IS NOT NULL AND retention_until < $1
       AND NOT EXISTS (SELECT 1 FROM services sv WHERE sv.customer_id = documents.customer_id AND sv.status <> 'TERMINATED')`, [now.toISOString()])).rows;
    for (const r of due) await purgeDocument(q, r.id, who, 'Retention period ended', fetchImpl);
    return { expired: expired.length, unclaimedPurged: stale.length, retentionSet, retentionPurged: due.length };
  });
}

/** Counts for the explorer's header. */
export async function documentSummary(q: Queryable) {
  const r = (await q.query(`SELECT count(*) FILTER (WHERE kind='KYC' AND status='PENDING_VERIFICATION' AND purged_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE kind='KYC' AND purged_at IS NULL)::int AS kyc, count(*) FILTER (WHERE kind='CONTRACT' AND purged_at IS NULL)::int AS contracts,
      count(*) FILTER (WHERE purged_at IS NOT NULL)::int AS purged, count(*) FILTER (WHERE status='EXPIRED')::int AS expired FROM documents`)).rows[0]!;
  return { ...r, storage: s3Config() ? 'S3' : 'DB' };
}
