import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { hashIdDocument, maskIdDocument } from './customers.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { decryptBytes, decryptText, encryptBytes, encryptText, sha256Hex } from './field-crypto.js';
import { inspectImage } from './settings.js';
import { ID_TYPES, type StoreSettings } from './store-settings.js';

/**
 * Know-your-customer: what is checked, who decides, and what is kept.
 *
 *  - Remote (self-serve): the applicant enters their details and uploads their ID (front/back) and a selfie. Automatic rules reject the obvious
 *    (under age, expired ID) and flag the doubtful (an ID already registered to someone else). In "manual" mode a compliance officer then decides;
 *    in "auto" mode a clean application is approved by the rules alone (intended for use with an eKYC vendor behind the same checks).
 *  - In person (assisted sale): the shop assistant sights the original ID and attests it; the same rules still run.
 *
 * The ID number and every image are encrypted (AES-256-GCM); a keyed hash is kept for duplicate detection and a masked form for display.
 */
export const DOC_KINDS = ['ID_FRONT', 'ID_BACK', 'SELFIE', 'PROOF_OF_ADDRESS', 'SIGNATURE'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const MAX_DOC_BYTES = 2_500_000;

export interface Personal {
  fullName: string; dateOfBirth: string; nationality?: string; idType: (typeof ID_TYPES)[number]; idNumber: string; idExpiry?: string; email: string; phone: string;
}

const isoDate = (s: unknown): string | null => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s ? s : null);
export function ageOn(dob: string, on: string): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = on.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** Format problems with the details themselves (fixable by the applicant). */
export function personalProblems(p: Partial<Personal>): string[] {
  const out: string[] = [];
  if (!p.fullName || p.fullName.trim().length < 2 || /\d/.test(p.fullName) || p.fullName.length > 100) out.push('Enter your full name as it appears on your ID.');
  if (!isoDate(p.dateOfBirth)) out.push('Enter your date of birth.');
  if (!p.idType || !(ID_TYPES as readonly string[]).includes(p.idType)) out.push('Choose the type of ID.');
  if (!p.idNumber || !/^[A-Za-z0-9][A-Za-z0-9 -]{3,24}$/.test(p.idNumber.trim())) out.push('Enter your ID number (letters and digits only).');
  if (p.idExpiry && !isoDate(p.idExpiry)) out.push('Enter the ID expiry date.');
  if ((p.idType === 'PASSPORT' || p.idType === 'RESIDENCE_PERMIT') && !p.idExpiry) out.push('Enter the expiry date of your passport or permit.');
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email) || p.email.length > 120) out.push('Enter a valid email address.');
  if (!p.phone || !/^\+?\d{7,15}$/.test(p.phone.replace(/[\s-]/g, ''))) out.push('Enter a valid mobile number.');
  return out;
}

/** Rules that reject outright (nothing a reviewer could fix by approving). */
export function hardFailures(p: Personal, s: Pick<StoreSettings, 'minAge'>, onDate: string): string[] {
  const out: string[] = [];
  if (ageOn(p.dateOfBirth, onDate) < s.minAge) out.push(`The applicant is under the minimum age of ${s.minAge}.`);
  if (p.idExpiry && p.idExpiry < onDate) out.push('The ID has expired.');
  return out;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

async function loadApp(q: Queryable, id: string): Promise<Row> {
  const a = (await q.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0];
  if (!a) throw notFound('application', id);
  return a;
}

/** Creates or refreshes the KYC case from the application's personal details. Called whenever they change. */
export async function syncCase(q: Queryable, appId: string, method: 'DOCUMENT_REMOTE' | 'IN_PERSON'): Promise<Row | null> {
  const app = await loadApp(q, appId);
  const p = app.personal as Partial<Personal>;
  if (personalProblems(p).length) return null;
  const pp = p as Personal;
  const hash = hashIdDocument(pp.idNumber);
  const existing = (await q.query('SELECT * FROM kyc_cases WHERE application_id=$1', [appId])).rows[0];
  const vals = [pp.fullName.trim(), pp.dateOfBirth, pp.nationality ?? null, pp.idType, encryptText(pp.idNumber.trim()), hash, maskIdDocument(pp.idNumber.trim()), pp.idExpiry ?? null];
  if (existing) {
    await q.query(`UPDATE kyc_cases SET method=$2, full_name=$3, date_of_birth=$4, nationality=$5, id_type=$6, id_number_enc=$7, id_number_hash=$8, id_number_masked=$9, id_expiry=$10,
      status='PENDING', decided_by=NULL, decided_at=NULL, decision_reason=NULL, attestation=NULL, updated_at=now() WHERE id=$1`, [existing.id, method, ...vals]);
    return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [existing.id])).rows[0]!;
  }
  const id = randomUUID();
  await q.query(`INSERT INTO kyc_cases (id, application_id, customer_id, method, full_name, date_of_birth, nationality, id_type, id_number_enc, id_number_hash, id_number_masked, id_expiry)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, appId, app.customerId, method, ...vals]);
  return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [id])).rows[0]!;
}

/** Classifies an uploaded file by its bytes (never by the claimed type). Images and PDFs only. */
export function inspectDocument(b: Buffer): { contentType: string } | null {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { contentType: 'application/pdf' };
  const img = inspectImage(b);
  return img ? { contentType: img.contentType } : null;
}

export async function addDocument(q: Queryable, appId: string, kind: DocKind, bytes: Buffer): Promise<{ id: string; kind: DocKind; sizeBytes: number }> {
  if (!(DOC_KINDS as readonly string[]).includes(kind)) throw invalid(`unknown document kind ${kind}`);
  if (!bytes.length) throw invalid('The file is empty.');
  if (bytes.length > MAX_DOC_BYTES) throw invalid(`The file is larger than ${(MAX_DOC_BYTES / 1_000_000).toFixed(1)} MB. Take a smaller photo.`);
  const info = inspectDocument(bytes);
  if (!info) throw invalid('Upload a JPEG, PNG, WebP or PDF file.');
  if (kind === 'SIGNATURE' && info.contentType === 'application/pdf') throw invalid('A signature must be an image.');
  const c = (await q.query('SELECT id FROM kyc_cases WHERE application_id=$1', [appId])).rows[0];
  if (!c) throw rejected('Enter and save your personal details before uploading documents.');
  await q.query('DELETE FROM kyc_documents WHERE application_id=$1 AND kind=$2', [appId, kind]); // one per kind: a new upload replaces
  const id = randomUUID();
  await q.query(`INSERT INTO kyc_documents (id, case_id, application_id, kind, content_type, size_bytes, sha256, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, c.id, appId, kind, info.contentType, bytes.length, sha256Hex(bytes), encryptBytes(bytes)]);
  return { id, kind, sizeBytes: bytes.length };
}

export async function listDocuments(q: Queryable, appId: string): Promise<Array<{ id: string; kind: DocKind; contentType: string; sizeBytes: number }>> {
  return (await q.query('SELECT id, kind, content_type, size_bytes FROM kyc_documents WHERE application_id=$1 ORDER BY kind', [appId])).rows as Array<{ id: string; kind: DocKind; contentType: string; sizeBytes: number }>;
}

async function setOutcome(q: Queryable, app: Row, c: Row, o: { case: 'PENDING' | 'APPROVED' | 'REJECTED'; app: string; by: string | null; reason?: string; flags?: string[]; checks?: Record<string, unknown>; attestation?: unknown }) {
  const decided = o.case !== 'PENDING';
  await q.query(`UPDATE kyc_cases SET status=$2, decided_by=$3, decided_at=CASE WHEN $4 THEN now() ELSE NULL END, decision_reason=$5, flags=COALESCE($6, flags),
      checks=COALESCE($7, checks), attestation=COALESCE($8, attestation), updated_at=now() WHERE id=$1`,
    [c.id, o.case, o.by, decided, o.reason ?? null, o.flags ?? null, o.checks ? JSON.stringify(o.checks) : null, o.attestation ? JSON.stringify(o.attestation) : null]);
  await q.query(`UPDATE applications SET status=$2, updated_at=now() WHERE id=$1`, [app.id, o.app]);
  if (o.case === 'APPROVED' && app.customerId) await markVerified(q, app.customerId);
}

export async function markVerified(q: Queryable, customerId: string) {
  await q.query(`UPDATE customers SET kyc_status='VERIFIED', kyc_verified_at=now() WHERE id=$1`, [customerId]);
}

async function evaluate(q: Queryable, app: Row, c: Row, s: StoreSettings) {
  const p = app.personal as Personal;
  const hard = hardFailures(p, s, todayStr());
  const flags: string[] = [];
  const dup = (await q.query(`SELECT id FROM customers WHERE id_document_hash=$1 AND kyc_status='VERIFIED' LIMIT 1`, [c.idNumberHash])).rows[0]
    ?? (await q.query(`SELECT id FROM customers WHERE id_document_hash=$1 LIMIT 1`, [c.idNumberHash])).rows[0];
  if (dup && dup.id !== app.customerId) flags.push('DUPLICATE_IDENTITY');
  const otherApp = (await q.query(`SELECT 1 FROM kyc_cases WHERE id_number_hash=$1 AND application_id<>$2 AND status='APPROVED' LIMIT 1`, [c.idNumberHash, app.id])).rows.length;
  if (otherApp && !dup) flags.push('IDENTITY_USED_ELSEWHERE');
  return { hard, flags, checks: { evaluatedAt: new Date().toISOString(), age: ageOn(p.dateOfBirth, todayStr()), idExpired: !!p.idExpiry && p.idExpiry < todayStr(), duplicateIdentity: flags.includes('DUPLICATE_IDENTITY') } };
}

/** Self-serve: the applicant is done uploading. Rules run; then a person (manual) or the rules alone (auto) decide. */
export async function submitRemote(q: Queryable, appId: string, s: StoreSettings): Promise<Row> {
  const app = await loadApp(q, appId);
  if (app.status !== 'DRAFT') throw rejected(`This application is ${app.status.toLowerCase().replace('_', ' ')}.`);
  const c = await syncCase(q, appId, 'DOCUMENT_REMOTE');
  if (!c) throw invalid(personalProblems(app.personal).join(' '));
  const kinds = new Set((await listDocuments(q, appId)).map((d) => d.kind));
  const need: DocKind[] = ['ID_FRONT', 'SELFIE', ...(c.idType === 'PASSPORT' ? [] : ['ID_BACK' as DocKind])];
  const missing = need.filter((k) => !kinds.has(k));
  if (missing.length) throw invalid(`Upload: ${missing.map((k) => ({ ID_FRONT: 'the front of your ID', ID_BACK: 'the back of your ID', SELFIE: 'a selfie' }[k as 'ID_FRONT'] ?? k)).join(', ')}.`);
  const ev = await evaluate(q, app, c, s);
  if (ev.hard.length) {
    await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: 'system', reason: ev.hard.join(' '), flags: ev.flags, checks: ev.checks });
  } else if (s.kycMode === 'auto' && !ev.flags.length) {
    await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: 'auto-rules', reason: 'All automatic checks passed', flags: ev.flags, checks: ev.checks });
  } else {
    await setOutcome(q, app, c, { case: 'PENDING', app: 'KYC_REVIEW', by: null, flags: ev.flags, checks: ev.checks });
  }
  return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [c.id])).rows[0]!;
}

export interface Attestation { idSighted: boolean; faceMatches: boolean; notes?: string }

/** Assisted sale: the assistant has the customer and their original ID in front of them. Same rules; the attestation replaces the uploads. */
export async function attestInPerson(q: Queryable, appId: string, staff: { username: string; storeId?: string | null }, a: Attestation, s: StoreSettings): Promise<Row> {
  const app = await loadApp(q, appId);
  if (!['DRAFT', 'KYC_REVIEW'].includes(app.status)) throw rejected(`This application is ${app.status.toLowerCase().replace('_', ' ')}.`);
  if (!a.idSighted || !a.faceMatches) throw rejected('Confirm that you have seen the original ID and that the photo matches the customer, or send the customer to online verification.');
  const c = await syncCase(q, appId, 'IN_PERSON');
  if (!c) throw invalid(personalProblems(app.personal).join(' '));
  const ev = await evaluate(q, app, c, s);
  const attestation = { ...a, by: staff.username, storeId: staff.storeId ?? null, at: new Date().toISOString() };
  if (ev.hard.length) await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: staff.username, reason: ev.hard.join(' '), flags: ev.flags, checks: ev.checks, attestation });
  else if (ev.flags.length) await setOutcome(q, app, c, { case: 'PENDING', app: 'KYC_REVIEW', by: null, flags: ev.flags, checks: ev.checks, attestation });
  else await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: staff.username, reason: 'Original ID sighted in person', flags: ev.flags, checks: ev.checks, attestation });
  await audit(q, staff.username, 'kyc_case', c.id, 'ATTESTED', { applicationId: appId, flags: ev.flags });
  return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [c.id])).rows[0]!;
}

// ───────────────────────── compliance review ─────────────────────────
export async function listKycCases(q: Queryable, f: { status?: string; limit?: number } = {}): Promise<Row[]> {
  const params: unknown[] = []; const where: string[] = [];
  if (f.status) where.push(`k.status = $${params.push(f.status)}`);
  params.push(Math.min(f.limit ?? 50, 200));
  return (await q.query(
    `SELECT k.id, k.application_id, k.method, k.status, k.full_name, k.id_type, k.id_number_masked, k.flags, k.created_at, k.decided_by, k.decided_at, a.channel, a.status AS application_status
     FROM kyc_cases k JOIN applications a ON a.id = k.application_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (k.status='PENDING') DESC, k.created_at LIMIT $${params.length}`, params)).rows;
}

/** One case with the full ID number (decrypted for the reviewer) and its documents. Opening it is itself audited. */
export async function getKycCase(q: Queryable, id: string, reviewer: string): Promise<Row> {
  const c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [id])).rows[0];
  if (!c) throw notFound('KYC case', id);
  const app = (await q.query('SELECT id, channel, status, personal, address, consent, lines, created_at FROM applications WHERE id=$1', [c.applicationId])).rows[0];
  const { idNumberEnc, idNumberHash: _h, ...rest } = c;
  await audit(q, reviewer, 'kyc_case', id, 'VIEWED');
  return { ...rest, idNumber: decryptText(idNumberEnc), application: app, documents: await listDocuments(q, c.applicationId) };
}

export async function getKycDocument(q: Queryable, docId: string, viewer: string): Promise<{ contentType: string; bytes: Buffer }> {
  const d = (await q.query('SELECT * FROM kyc_documents WHERE id=$1', [docId])).rows[0];
  if (!d) throw notFound('document', docId);
  await audit(q, viewer, 'kyc_document', docId, 'VIEWED', { kind: d.kind, applicationId: d.applicationId });
  const bytes = decryptBytes(Buffer.from(d.data));
  if (sha256Hex(bytes) !== d.sha256) throw new Error('KYC document failed its integrity check');
  return { contentType: d.contentType, bytes };
}

export type Decision = { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string };

export async function decideKycCase(q: Queryable, caseId: string, reviewer: string, d: Decision, s: StoreSettings): Promise<Row> {
  const c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!c) throw notFound('KYC case', caseId);
  if (c.status !== 'PENDING') throw conflict(`This case was already ${c.status.toLowerCase()} by ${c.decidedBy}.`);
  const app = await loadApp(q, c.applicationId);
  if (app.status !== 'KYC_REVIEW') throw rejected('This application is not waiting for review.');
  const reason = d.reason?.trim();
  if (d.decision !== 'APPROVE' && !reason) throw invalid('Give a reason; the applicant or store will see it.');
  if (d.decision === 'APPROVE') {
    const hard = hardFailures(app.personal as Personal, s, todayStr());
    if (hard.length) throw rejected(`This cannot be approved: ${hard.join(' ')}`);
    // Whoever attested in person cannot also approve their own flagged case.
    if (c.attestation?.by === reviewer) throw rejected('A different person must review a case you attested.');
    await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: reviewer, reason: reason ?? 'Approved after review' });
  } else if (d.decision === 'REJECT') {
    await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: reviewer, reason });
  } else {
    // Sent back: the applicant fixes the details or re-uploads, then submits again.
    await q.query(`UPDATE kyc_cases SET checks = checks || $2::jsonb, updated_at=now() WHERE id=$1`, [caseId, JSON.stringify({ returnReason: reason, returnedBy: reviewer })]);
    await q.query(`UPDATE applications SET status='DRAFT', updated_at=now() WHERE id=$1`, [app.id]);
  }
  await audit(q, reviewer, 'kyc_case', caseId, d.decision, { applicationId: app.id, reason });
  return (await q.query('SELECT id, status, decided_by, decision_reason FROM kyc_cases WHERE id=$1', [caseId])).rows[0]!;
}
