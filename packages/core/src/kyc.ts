import { checkCaseWithProvider, kycMethods, verifiedAssertion, type ProviderVerdict } from './kyc-providers.js';
import { logDocument, openDocument, putDocument, settleCaseDocuments, type DocWho } from './documents.js';
import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { createCustomer, hashIdDocument, maskIdDocument, type NewCustomer } from './customers.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { raiseEvent } from './events.js';
import { blacklistAdd } from './fraud.js';
import { decryptText, encryptText, sha256Hex } from './field-crypto.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { inspectImage } from './settings.js';
import { ID_TYPES, getStoreSettings, type StoreSettings } from './store-settings.js';

/**
 * Know-your-customer: one workflow for every channel.
 *
 *  1. Evidence. The ID (front and, for a card, back) and a selfie are photographed live with the device camera, never picked from a gallery. They go into the
 *     document vault (encrypted) against a KYC case. A company supplies its registration certificate and the signatory's ID.
 *  2. Rules. Automatic rules reject the obvious (under age, expired ID) before anything is saved, and flag the doubtful: an ID already registered to someone
 *     else, a photo that was already used by another case, photos that were not taken live.
 *  3. Review. Submitting opens a review task in the KYC queue (or, with `kycMode: auto`, a clean case is approved by the rules alone). The customer is
 *     PENDING_REVIEW meanwhile. A person approves, rejects (optionally reporting to the fraud register) or sends the case back for new photos.
 *  4. Consequence. Approval marks the customer VERIFIED and releases every order waiting to be activated; rejection marks them REJECTED and cancels
 *     and refunds those orders.
 *
 * Where it starts: the store-front and the assisted sale start from an application (the shopper is not a customer yet); the CRM order wizard and the
 * customer screen start from a customer. The case, the queue and the decision are the same.
 * The ID number is encrypted (AES-256-GCM); a keyed hash is kept for duplicate detection and a masked form for display.
 */
export const DOC_KINDS = ['ID_FRONT', 'ID_BACK', 'SELFIE', 'PROOF_OF_ADDRESS', 'SIGNATURE', 'COMPANY_REGISTRATION'] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const MAX_DOC_BYTES = 2_500_000;
const CATEGORY: Record<DocKind, string> = { ID_FRONT: 'NATIONAL_ID_FRONT', ID_BACK: 'NATIONAL_ID_BACK', SELFIE: 'SELFIE', PROOF_OF_ADDRESS: 'PROOF_OF_ADDRESS', SIGNATURE: 'CUSTOMER_SIGNATURE', COMPANY_REGISTRATION: 'CORPORATE_REGISTRATION_SSM' };
const KIND_OF = Object.fromEntries(Object.entries(CATEGORY).map(([k, v]) => [v, k as DocKind])) as Record<string, DocKind>;
// A passport is photographed as one page; the vault names that page by its category.
const kindOfRow = (category: string, idType?: string | null): DocKind => (category === 'PASSPORT' ? 'ID_FRONT' : KIND_OF[category] ?? (idType ? 'ID_FRONT' : 'ID_FRONT'));

export interface Personal {
  fullName: string; dateOfBirth: string; nationality?: string; idType: (typeof ID_TYPES)[number]; idNumber: string; idExpiry?: string; email: string; phone: string;
}
/** The identity the CRM captures: the name, contact details and (often) the date of birth are already on the customer. */
export interface IdentityInput { idType: (typeof ID_TYPES)[number]; idNumber: string; idExpiry?: string; nationality?: string; dateOfBirth?: string }
/** How a photo was taken, as reported by the capture screen. Checked again on the server. */
export interface Capture { method: 'LIVE_CAMERA'; at: string; width?: number; height?: number; facing?: string }
export interface Evidence { kind: DocKind; bytes: Buffer; capture?: Capture | null }

const isoDate = (s: unknown): string | null => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s ? s : null);
export function ageOn(dob: string, on: string): number {
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = on.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** Problems with the identity details themselves (fixable by whoever is typing them). */
export function identityProblems(p: Partial<Personal>): string[] {
  const out: string[] = [];
  if (!p.fullName || p.fullName.trim().length < 2 || !/\p{L}/u.test(p.fullName) || p.fullName.length > 120) out.push('Enter the full name as it appears on the ID.');
  if (!isoDate(p.dateOfBirth)) out.push('Enter the date of birth.');
  if (!p.idType || !(ID_TYPES as readonly string[]).includes(p.idType)) out.push('Choose the type of ID.');
  if (!p.idNumber || !/^[A-Za-z0-9][A-Za-z0-9 -]{3,24}$/.test(p.idNumber.trim())) out.push('Enter the ID number (letters and digits only).');
  if (p.idExpiry && !isoDate(p.idExpiry)) out.push('Enter the ID expiry date.');
  if ((p.idType === 'PASSPORT' || p.idType === 'RESIDENCE_PERMIT') && !p.idExpiry) out.push('Enter the expiry date of the passport or permit.');
  return out;
}
/** Format problems with an online applicant's details: the identity, plus how to reach them. */
export function personalProblems(p: Partial<Personal>): string[] {
  const out = identityProblems(p);
  if (p.fullName && /\d/.test(p.fullName) && !out.length) out.push('Enter your full name as it appears on your ID.');   // a person's name has no digits (a staff-keyed company name may)
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p.email) || p.email.length > 120) out.push('Enter a valid email address.');
  if (!p.phone || !/^\+?\d{7,15}$/.test(p.phone.replace(/[\s-]/g, ''))) out.push('Enter a valid mobile number.');
  return out;
}

/** Rules that reject outright (nothing a reviewer could fix by approving). */
export function hardFailures(p: Pick<Personal, 'dateOfBirth' | 'idExpiry'>, s: Pick<StoreSettings, 'minAge'>, onDate: string): string[] {
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

// ───────────────────────── the photos ─────────────────────────
/** A JPEG that carries camera-roll metadata (camera make/model, time taken, GPS, … in Exif, or XMP): what a photo picked from a gallery has and a frame grabbed from the live camera does not. */
/**
 * Browsers that re-encode a camera frame on a canvas (Safari does) still write a small Exif block: colour space and pixel size, nothing about a camera.
 * A picture from a gallery carries camera details: make, model, the moment it was taken, GPS, lens, serial number. Only those count.
 * An Exif block that cannot be read is treated as a gallery photo.
 */
const CAMERA_ROLL_TAGS = new Set([0x010f, 0x0110, 0x0131, 0x9003, 0x9004, 0x8825, 0xa431, 0xa432, 0xa433, 0xa434, 0x927c, 0x9201, 0x829a, 0x8827]);
const EXIF_SUB_IFD = 0x8769;
function exifLooksLikeCameraRoll(tiff: Buffer): boolean {
  try {
    if (tiff.length < 8) return true;
    const le = tiff[0] === 0x49 && tiff[1] === 0x49;
    if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return true;
    const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return true;
    const seen = new Set<number>();
    const walk = (off: number, depth: number): boolean => {
      if (depth > 2 || off < 8 || off + 2 > tiff.length || seen.has(off)) return depth === 0 ? true : false;
      seen.add(off);
      const n = u16(off);
      if (n > 256 || off + 2 + n * 12 > tiff.length) return true;
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12, tag = u16(e);
        if (CAMERA_ROLL_TAGS.has(tag)) return true;
        if (tag === EXIF_SUB_IFD && walk(u32(e + 8), depth + 1)) return true;
      }
      return false;
    };
    return walk(u32(4), 0);
  } catch { return true; }
}

export function carriesCameraRollMetadata(b: Buffer): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd9 || marker === 0xda) return false;   // end of image / start of the picture data: no metadata after this
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1) {
      const head = b.subarray(i + 4, i + 4 + 32).toString('latin1');
      if (head.startsWith('http://ns.adobe.com/xap')) return true;
      if (head.startsWith('Exif')) { if (exifLooksLikeCameraRoll(b.subarray(i + 10, i + 2 + len))) return true; }
    }
    i += 2 + len;
  }
  return false;
}

const LIVE_WINDOW_MS = 15 * 60_000;
/** Everything the server can check about "taken just now with the camera". It cannot be proof against a determined forger; it stops the honest mistake and the casual shortcut. */
export function captureProblems(bytes: Buffer, capture: Capture | null | undefined, now = new Date()): string[] {
  const out: string[] = [];
  if (!capture || capture.method !== 'LIVE_CAMERA') return ['Take the photo with the camera in this screen; choosing a file is not accepted.'];
  const at = Date.parse(capture.at);
  if (Number.isNaN(at) || Math.abs(now.getTime() - at) > LIVE_WINDOW_MS) out.push('This photo was not taken just now. Take it again.');
  const info = inspectImage(bytes);
  if (!info || info.contentType !== 'image/jpeg') out.push('Take the photo with the camera; this file is not a camera photo.');
  else {
    if (carriesCameraRollMetadata(bytes)) out.push('This looks like a photo from the gallery (it carries photo-library details). Take the photo again with the camera.');
    if (Math.max(info.width, info.height) < 640 || Math.min(info.width, info.height) < 400) out.push('The photo is too small to read. Hold the camera closer and take it again.');
  }
  return out;
}

/** Classifies an uploaded file by its bytes (never by the claimed type). Images and PDFs only. */
export function inspectDocument(b: Buffer): { contentType: string } | null {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { contentType: 'application/pdf' };
  const img = inspectImage(b);
  return img ? { contentType: img.contentType } : null;
}

interface CaseRef { id: string; applicationId: string | null; customerId: string | null; source: string }

/** Puts one photo in the vault against the case, replacing (not deleting) an earlier one of the same kind. */
export async function addEvidence(q: Queryable, c: CaseRef, e: Evidence, s: StoreSettings, actor: string, who: DocWho = { username: actor }): Promise<{ id: string; kind: DocKind; sizeBytes: number }> {
  if (!(DOC_KINDS as readonly string[]).includes(e.kind)) throw invalid(`unknown document kind ${e.kind}`);
  if (!e.bytes.length) throw invalid('The file is empty.');
  if (e.bytes.length > MAX_DOC_BYTES) throw invalid(`The photo is larger than ${(MAX_DOC_BYTES / 1_000_000).toFixed(1)} MB. Take it again.`);
  const info = inspectDocument(e.bytes);
  if (!info) throw invalid('Take a photo with the camera.');
  if (e.kind === 'SIGNATURE') { if (info.contentType === 'application/pdf') throw invalid('A signature must be an image.'); }
  else if (s.kycRequireLiveCapture) { const bad = captureProblems(e.bytes, e.capture); if (bad.length) throw invalid(bad[0]!); }
  else if (info.contentType === 'application/pdf' && e.kind === 'SELFIE') throw invalid('A selfie must be a photo.');
  const category = CATEGORY[e.kind];
  await q.query(`UPDATE documents SET status='SUPERSEDED', status_reason='Replaced by a newer photo' WHERE kyc_case_id=$1 AND category=$2 AND status <> 'SUPERSEDED' AND purged_at IS NULL`, [c.id, category]);
  const img = inspectImage(e.bytes);
  const r = await putDocument(q, {
    kind: 'KYC', category, name: e.kind.toLowerCase().replace(/_/g, ' '), contentType: info.contentType, bytes: e.bytes, customerId: c.customerId, applicationId: c.applicationId, kycCaseId: c.id, encrypt: true, status: 'PENDING_VERIFICATION',
    meta: { source: c.source, capture: e.capture && e.capture.method === 'LIVE_CAMERA' ? { method: 'LIVE_CAMERA', at: e.capture.at, facing: e.capture.facing ?? null, width: img?.width ?? null, height: img?.height ?? null } : null },
  }, actor);
  await logDocument(q, who, 'UPLOAD', { documentId: r.id, customerId: c.customerId, detail: { category, sizeBytes: e.bytes.length, kycCaseId: c.id, live: !!e.capture } });
  return { id: r.id as string, kind: e.kind, sizeBytes: e.bytes.length };
}

export interface CaseDocument { id: string; kind: DocKind; category: string; contentType: string; sizeBytes: number; status: string; live: boolean; takenAt: string | null; width: number | null; height: number | null }
/** The evidence currently on a case (replaced photos are not shown), whether it was written by the vault or by the store-front's older upload table. */
export async function listCaseDocuments(q: Queryable, c: { id: string; applicationId?: string | null }): Promise<CaseDocument[]> {
  const rows = (await q.query(
    `SELECT id, category, content_type, size_bytes, status, meta FROM documents
      WHERE purged_at IS NULL AND status NOT IN ('SUPERSEDED','PURGED_RETENTION') AND (kyc_case_id=$1 OR ($2::uuid IS NOT NULL AND application_id=$2 AND storage='KYC_LEGACY')) ORDER BY category, created_at`, [c.id, c.applicationId ?? null])).rows;
  return rows.map((r) => ({ id: r.id, kind: kindOfRow(r.category), category: r.category, contentType: r.contentType, sizeBytes: r.sizeBytes, status: r.status, live: r.meta?.capture?.method === 'LIVE_CAMERA', takenAt: r.meta?.capture?.at ?? null, width: r.meta?.capture?.width ?? null, height: r.meta?.capture?.height ?? null }));
}

/** What a person must photograph for this kind of customer and ID. */
export function requiredKinds(o: { individual: boolean; idType: string }): DocKind[] {
  const id: DocKind[] = o.idType === 'PASSPORT' ? ['ID_FRONT'] : ['ID_FRONT', 'ID_BACK'];
  return o.individual ? [...id, 'SELFIE'] : ['COMPANY_REGISTRATION', ...id];
}
const KIND_TEXT: Record<DocKind, string> = { ID_FRONT: 'the front of the ID', ID_BACK: 'the back of the ID', SELFIE: 'a selfie', PROOF_OF_ADDRESS: 'proof of address', SIGNATURE: 'the signature', COMPANY_REGISTRATION: 'the company registration certificate' };

// ───────────────────────── the case ─────────────────────────
/** Creates or refreshes the KYC case from an application's personal details. Called whenever they change. */
export async function syncCase(q: Queryable, appId: string, method: 'DOCUMENT_REMOTE' | 'IN_PERSON' | 'MYDIGITAL_ID'): Promise<Row | null> {
  const app = await loadApp(q, appId);
  const p = app.personal as Partial<Personal>;
  if (personalProblems(p).length) return null;
  const pp = p as Personal;
  const hash = hashIdDocument(pp.idNumber);
  const existing = (await q.query('SELECT * FROM kyc_cases WHERE application_id=$1', [appId])).rows[0];
  const vals = [pp.fullName.trim(), pp.dateOfBirth, pp.nationality ?? null, pp.idType, encryptText(pp.idNumber.trim()), hash, maskIdDocument(pp.idNumber.trim()), pp.idExpiry ?? null];
  if (existing) {
    await q.query(`UPDATE kyc_cases SET method=$2, full_name=$3, date_of_birth=$4, nationality=$5, id_type=$6, id_number_enc=$7, id_number_hash=$8, id_number_masked=$9, id_expiry=$10,
      status='PENDING', decided_by=NULL, decided_at=NULL, decision_reason=NULL, reason_code=NULL, attestation=NULL, updated_at=now() WHERE id=$1`, [existing.id, method, ...vals]);
    return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [existing.id])).rows[0]!;
  }
  const id = randomUUID();
  await q.query(`INSERT INTO kyc_cases (id, application_id, customer_id, method, source, full_name, date_of_birth, nationality, id_type, id_number_enc, id_number_hash, id_number_masked, id_expiry)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, appId, app.customerId, method, app.channel === 'RETAIL_ASSISTED' ? 'ASSISTED' : 'STOREFRONT', ...vals]);
  return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [id])).rows[0]!;
}

/** A store-front or assisted applicant photographs a document. */
export async function addDocument(q: Queryable, appId: string, kind: DocKind, bytes: Buffer, capture: Capture | null | undefined, s: StoreSettings, who: DocWho = { username: 'applicant' }): Promise<{ id: string; kind: DocKind; sizeBytes: number }> {
  const c = (await q.query('SELECT id, customer_id, source FROM kyc_cases WHERE application_id=$1', [appId])).rows[0];
  if (!c) throw rejected('Enter and save your personal details before adding documents.');
  return addEvidence(q, { id: c.id, applicationId: appId, customerId: c.customerId ?? null, source: c.source }, { kind, bytes, capture }, s, who.username, who);
}

export async function listDocuments(q: Queryable, appId: string): Promise<CaseDocument[]> {
  const c = (await q.query('SELECT id FROM kyc_cases WHERE application_id=$1', [appId])).rows[0];
  return c ? listCaseDocuments(q, { id: c.id, applicationId: appId }) : [];
}

interface Outcome { case: 'PENDING' | 'APPROVED' | 'REJECTED' | 'RETURNED'; app?: string; by: string | null; reason?: string; reasonCode?: string; flags?: string[]; checks?: Record<string, unknown>; attestation?: unknown }
async function setOutcome(q: Queryable, app: Row | null, c: Row, o: Outcome) {
  const decided = o.case === 'APPROVED' || o.case === 'REJECTED';
  await q.query(`UPDATE kyc_cases SET status=$2, decided_by=$3, decided_at=CASE WHEN $4 THEN now() ELSE NULL END, decision_reason=$5, reason_code=$9, flags=COALESCE($6, flags),
      checks=COALESCE($7, checks), attestation=COALESCE($8, attestation), updated_at=now() WHERE id=$1`,
    [c.id, o.case, o.by, decided, o.reason ?? null, o.flags ?? null, o.checks ? JSON.stringify(o.checks) : null, o.attestation ? JSON.stringify(o.attestation) : null, o.reasonCode ?? null]);
  // An application that has already become an order keeps that status; only an application still in the KYC steps moves with the case.
  if (app && o.app && app.status !== 'ORDERED') await q.query(`UPDATE applications SET status=$2, updated_at=now() WHERE id=$1`, [app.id, o.app]);
  const customerId = (c.customerId ?? app?.customerId ?? null) as string | null;
  if (customerId) await q.query(`UPDATE customers SET kyc_status=$2, kyc_verified_at=CASE WHEN $2='VERIFIED' THEN now() ELSE NULL END WHERE id=$1`,
    [customerId, ({ APPROVED: 'VERIFIED', REJECTED: 'REJECTED', PENDING: 'PENDING_REVIEW', RETURNED: 'NOT_VERIFIED' } as const)[o.case]]);
  if (decided) await settleCaseDocuments(q, { caseId: c.id, applicationId: c.applicationId ?? null }, o.case === 'APPROVED' ? 'APPROVED' : 'REJECTED', customerId, o.by && !/^auto/.test(o.by) ? o.by : null, o.reason ?? null);
}

export async function markVerified(q: Queryable, customerId: string) {
  await q.query(`UPDATE customers SET kyc_status='VERIFIED', kyc_verified_at=now() WHERE id=$1`, [customerId]);
}

/** Runs the automatic checks. `personal` carries what matters for the rules: date of birth, expiry and the identity behind the case. */
async function evaluate(q: Queryable, o: { personal: Pick<Personal, 'dateOfBirth' | 'idExpiry'>; c: Row; customerId: string | null; individual: boolean; s: StoreSettings }) {
  const { c, s } = o;
  const hard = hardFailures(o.personal, s, todayStr());
  const flags: string[] = [];
  if (o.individual) {
    const dup = (await q.query(`SELECT id FROM customers WHERE id_document_hash=$1 AND kyc_status='VERIFIED' LIMIT 1`, [c.idNumberHash])).rows[0]
      ?? (await q.query(`SELECT id FROM customers WHERE id_document_hash=$1 LIMIT 1`, [c.idNumberHash])).rows[0];
    if (dup && dup.id !== o.customerId) flags.push('DUPLICATE_IDENTITY');
    const otherApp = (await q.query(`SELECT 1 FROM kyc_cases WHERE id_number_hash=$1 AND id<>$2 AND status='APPROVED' AND COALESCE(customer_id::text,'') <> COALESCE($3,'') LIMIT 1`, [c.idNumberHash, c.id, o.customerId])).rows.length;
    if (otherApp && !flags.includes('DUPLICATE_IDENTITY')) flags.push('IDENTITY_USED_ELSEWHERE');
  }
  // The same picture on two different cases is how a borrowed or downloaded ID shows up.
  const reused = (await q.query(
    `SELECT 1 FROM documents d JOIN documents m ON m.sha256 = d.sha256 AND m.id <> d.id AND m.kind='KYC' AND m.purged_at IS NULL AND m.status <> 'SUPERSEDED' AND m.kyc_case_id IS DISTINCT FROM d.kyc_case_id
      WHERE d.kyc_case_id=$1 AND d.status <> 'SUPERSEDED' AND d.category <> 'CUSTOMER_SIGNATURE' LIMIT 1`, [c.id])).rows.length;
  if (reused) flags.push('IMAGE_REUSED');
  const docs = await listCaseDocuments(q, { id: c.id, applicationId: c.applicationId });
  if (docs.some((d) => !d.live && d.kind !== 'SIGNATURE')) flags.push('NOT_LIVE_CAPTURE');
  const age = ageOn(o.personal.dateOfBirth, todayStr());
  return { hard, flags, checks: { evaluatedAt: new Date().toISOString(), age, idExpired: !!o.personal.idExpiry && o.personal.idExpiry < todayStr(), duplicateIdentity: flags.includes('DUPLICATE_IDENTITY'), imageReused: flags.includes('IMAGE_REUSED'), liveCapture: docs.length > 0 && docs.every((d) => d.live || d.kind === 'SIGNATURE') } };
}

/** What the automatic part of the process concluded about a case. */
interface Judged { result: 'APPROVE' | 'REJECT' | 'REVIEW'; by: string | null; reason?: string; reasonCode?: string; flags: string[]; checks: Record<string, unknown> }

/**
 * Decides what the rules and, when one is connected, the ID check service make of a case.
 *   service says pass, nothing else flagged, automatic approval on → approve        (customer VERIFIED, orders released)
 *   service says fail                                              → reject         (orders cancelled and refunded)
 *   doubtful, flagged, or the service could not be reached         → review task    (the verdict is shown to the reviewer)
 * Without a service the earlier rule stands: only `kycMode: auto` with no flags approves by itself.
 * A service that is down never rejects anyone and never blocks the order wait: the case just goes to a person.
 */
async function judgeCase(q: Queryable, o: { ev: { flags: string[]; checks: Record<string, unknown> }; c: Row; personal: Personal; individual: boolean; s: StoreSettings }): Promise<Judged> {
  const flags = [...o.ev.flags];
  const checks: Record<string, unknown> = { ...o.ev.checks };
  const docs = await listCaseDocuments(q, { id: o.c.id, applicationId: o.c.applicationId });
  const ran = o.individual ? await checkCaseWithProvider(q, { caseId: o.c.id, docs, idType: o.personal.idType, claimed: { fullName: o.personal.fullName, dateOfBirth: o.personal.dateOfBirth, idNumber: o.personal.idNumber, idExpiry: o.personal.idExpiry ?? null, nationality: o.personal.nationality ?? null } }) : null;
  if (!ran) return o.s.kycMode === 'auto' && !flags.length ? { result: 'APPROVE', by: 'auto-rules', reason: 'All automatic checks passed', flags, checks } : { result: 'REVIEW', by: null, flags, checks };
  const v: ProviderVerdict = ran.verdict;
  checks.provider = v;
  if (v.status === 'FAIL' && ran.settings.autoReject) return { result: 'REJECT', by: 'id-check-service', reason: v.reasons.join(' ') || 'The ID check service did not accept the documents.', reasonCode: 'PROVIDER', flags, checks };
  if (v.status === 'FAIL') flags.push('PROVIDER_FAIL');
  if (v.status === 'REVIEW') flags.push('PROVIDER_REVIEW');
  if (v.status === 'UNAVAILABLE') flags.push('PROVIDER_UNAVAILABLE');
  if (v.status === 'PASS' && !flags.length && ran.settings.autoApprove) return { result: 'APPROVE', by: 'id-check-service', reason: 'Passed the ID check service and all automatic checks', flags, checks };
  return { result: 'REVIEW', by: null, flags, checks };
}

async function afterSubmit(q: Queryable, c: Row, customerId: string | null, actor: string, flags: string[], status: string) {
  await audit(q, actor, 'kyc_case', c.id, 'SUBMITTED', { customerId, source: c.source, flags });
  await raiseEvent(q, 'KYC_SUBMITTED', { resourceId: c.id, payload: { caseId: c.id, customerId, source: c.source, status, flags } }, { onlyIfWanted: true });
}

/** Self-serve: the applicant is done photographing. Rules run; then a person (manual) or the rules alone (auto) decide. */
export async function submitRemote(q: Queryable, appId: string, s: StoreSettings): Promise<Row> {
  const app = await loadApp(q, appId);
  if (app.status !== 'DRAFT') throw rejected(`This application is ${app.status.toLowerCase().replace('_', ' ')}.`);
  // Identity already confirmed by MyDigital ID (and the details unchanged since): no photographs, the same rules, then approve or refer.
  const proven = await verifiedAssertion(q, appId, app.personal as Personal);
  if (proven) return recordAssertedIdentity(q, { applicationId: appId, customerId: app.customerId ?? null, source: 'STOREFRONT', actor: 'applicant', personal: app.personal as Personal, assertion: proven.assertion, autoApprove: proven.autoApprove });
  const c = await syncCase(q, appId, 'DOCUMENT_REMOTE');
  if (!c) throw invalid(personalProblems(app.personal).join(' '));
  const kinds = new Set((await listCaseDocuments(q, { id: c.id, applicationId: appId })).map((d) => d.kind));
  const missing = requiredKinds({ individual: true, idType: c.idType }).filter((k) => !kinds.has(k));
  if (missing.length) throw invalid(`Photograph ${missing.map((k) => KIND_TEXT[k]).join(', ')}.`);
  const ev = await evaluate(q, { personal: app.personal as Personal, c, customerId: app.customerId ?? null, individual: true, s });
  await q.query('UPDATE kyc_cases SET submitted_at=now(), submitted_by=$2 WHERE id=$1', [c.id, 'applicant']);
  let flags = ev.flags;
  if (ev.hard.length) {
    await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: 'system', reason: ev.hard.join(' '), reasonCode: 'RULES', flags: ev.flags, checks: ev.checks });
  } else {
    const j = await judgeCase(q, { ev, c, personal: app.personal as Personal, individual: true, s });
    flags = j.flags;
    if (j.result === 'APPROVE') await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: j.by, reason: j.reason, flags, checks: j.checks });
    else if (j.result === 'REJECT') await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: j.by, reason: j.reason, reasonCode: j.reasonCode, flags, checks: j.checks });
    else await setOutcome(q, app, c, { case: 'PENDING', app: 'KYC_REVIEW', by: null, flags, checks: j.checks });
  }
  const done = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [c.id])).rows[0]!;
  await afterSubmit(q, done, app.customerId ?? null, 'applicant', flags, done.status);
  if (done.customerId && done.status === 'APPROVED') await releaseOrders(q, done.customerId, 'APPROVED', done.decidedBy ?? 'auto-rules');
  else if (done.customerId && done.status === 'REJECTED') await releaseOrders(q, done.customerId, 'REJECTED', done.decidedBy ?? 'system');
  return done;
}

export interface Attestation { idSighted: boolean; faceMatches: boolean; notes?: string }

/** Assisted sale: the assistant has the customer and their original ID in front of them. Same rules; the attestation replaces the photographs. */
export async function attestInPerson(q: Queryable, appId: string, staff: { username: string; storeId?: string | null }, a: Attestation, s: StoreSettings): Promise<Row> {
  const app = await loadApp(q, appId);
  if (!['DRAFT', 'KYC_REVIEW'].includes(app.status)) throw rejected(`This application is ${app.status.toLowerCase().replace('_', ' ')}.`);
  if (!a.idSighted || !a.faceMatches) throw rejected('Confirm that you have seen the original ID and that the photo matches the customer, or send the customer to online verification.');
  const c = await syncCase(q, appId, 'IN_PERSON');
  if (!c) throw invalid(personalProblems(app.personal).join(' '));
  const ev = await evaluate(q, { personal: app.personal as Personal, c, customerId: app.customerId ?? null, individual: true, s });
  const attestation = { ...a, by: staff.username, storeId: staff.storeId ?? null, at: new Date().toISOString() };
  await q.query('UPDATE kyc_cases SET submitted_at=now(), submitted_by=$2 WHERE id=$1', [c.id, staff.username]);
  const flags = ev.flags.filter((f) => f !== 'NOT_LIVE_CAPTURE');   // in person there are no photographs to be live
  if (ev.hard.length) await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: staff.username, reason: ev.hard.join(' '), reasonCode: 'RULES', flags, checks: ev.checks, attestation });
  else if (flags.length) await setOutcome(q, app, c, { case: 'PENDING', app: 'KYC_REVIEW', by: null, flags, checks: ev.checks, attestation });
  else await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: staff.username, reason: 'Original ID sighted in person', flags, checks: ev.checks, attestation });
  await audit(q, staff.username, 'kyc_case', c.id, 'ATTESTED', { applicationId: appId, flags });
  return (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [c.id])).rows[0]!;
}

// ───────────────────────── from the CRM: a customer's identity check ─────────────────────────
export interface CustomerKycInput {
  customerId: string; source: 'CRM_ORDER' | 'CRM_CUSTOMER'; actor: string; storeId?: string | null; orderId?: string | null;
  identity: IdentityInput; evidence: Evidence[]; who?: DocWho;
}

/**
 * Opens (or reopens) the identity check of a customer and puts it in the review queue. Everything is checked before anything is kept: wrong ID number,
 * under age, expired ID, a missing or non-live photograph. Call inside a transaction so a refusal leaves nothing behind (not even a half-made customer).
 */
export async function submitCustomerKyc(q: Queryable, i: CustomerKycInput): Promise<Row> {
  const s = await getStoreSettings(q);
  const cust = (await q.query(`SELECT c.*, s.individual FROM customers c JOIN customer_segments s ON s.id = c.segment WHERE c.id=$1`, [i.customerId])).rows[0];
  if (!cust) throw notFound('customer', i.customerId);
  const individual = !!cust.individual;
  const dob = i.identity.dateOfBirth ?? (cust.dateOfBirth ? String(cust.dateOfBirth).slice(0, 10) : undefined);
  const p: Partial<Personal> = { fullName: cust.displayName, dateOfBirth: dob, idType: i.identity.idType, idNumber: i.identity.idNumber, idExpiry: i.identity.idExpiry || undefined, nationality: i.identity.nationality };
  const problems = identityProblems(p);
  if (problems.length) throw invalid(problems.join(' '));
  const pp = p as Personal;
  const hash = hashIdDocument(pp.idNumber);
  if (individual && cust.idDocumentHash && hash !== cust.idDocumentHash) throw rejected('The ID number does not match the one on the customer record.');
  const hard = hardFailures(pp, s, todayStr());
  if (hard.length) throw rejected(hard.join(' '));

  const prior = (await q.query(`SELECT * FROM kyc_cases WHERE customer_id=$1 AND application_id IS NULL ORDER BY created_at DESC LIMIT 1`, [i.customerId])).rows[0];
  if (prior && prior.status === 'PENDING') throw conflict('An identity check is already waiting for review for this customer.');
  if (prior && prior.status === 'APPROVED' && cust.kycStatus === 'VERIFIED') throw conflict('This customer is already verified.');
  if (prior && prior.status === 'REJECTED' && (prior.fraudReported || prior.reasonCode === 'SUSPECTED_FRAUD')) throw rejected('The last identity check was rejected as suspected fraud. This customer cannot be re-submitted; speak to compliance.');

  const vals = [pp.fullName.trim(), pp.dateOfBirth, pp.nationality ?? null, pp.idType, encryptText(pp.idNumber.trim()), hash, maskIdDocument(pp.idNumber.trim()), pp.idExpiry ?? null];
  let caseId: string;
  if (prior && prior.status !== 'APPROVED') {
    caseId = prior.id;
    await q.query(`UPDATE kyc_cases SET method='DOCUMENT_STORE', source=$2, full_name=$3, date_of_birth=$4, nationality=$5, id_type=$6, id_number_enc=$7, id_number_hash=$8, id_number_masked=$9, id_expiry=$10, order_id=COALESCE($11, order_id),
      status='PENDING', decided_by=NULL, decided_at=NULL, decision_reason=NULL, reason_code=NULL, fraud_reported=false, flags='{}', checks='{}', updated_at=now() WHERE id=$1`, [caseId, i.source, ...vals, i.orderId ?? null]);
  } else {
    caseId = randomUUID();
    await q.query(`INSERT INTO kyc_cases (id, application_id, customer_id, method, source, full_name, date_of_birth, nationality, id_type, id_number_enc, id_number_hash, id_number_masked, id_expiry, order_id)
      VALUES ($1,NULL,$2,'DOCUMENT_STORE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [caseId, i.customerId, i.source, ...vals, i.orderId ?? null]);
  }
  const ref: CaseRef = { id: caseId, applicationId: null, customerId: i.customerId, source: i.source };
  for (const e of i.evidence) await addEvidence(q, ref, e, s, i.actor, i.who);
  const have = new Set((await listCaseDocuments(q, { id: caseId })).map((d) => d.kind));
  const missing = requiredKinds({ individual, idType: pp.idType }).filter((k) => !have.has(k));
  if (missing.length) throw invalid(`Photograph ${missing.map((k) => KIND_TEXT[k]).join(', ')}.`);
  // The date of birth given here is kept on the customer when the record had none, so the next check does not ask again.
  if (!cust.dateOfBirth && individual) await q.query('UPDATE customers SET date_of_birth=$2 WHERE id=$1', [i.customerId, pp.dateOfBirth]);

  const c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [caseId])).rows[0]!;
  const ev = await evaluate(q, { personal: pp, c, customerId: i.customerId, individual, s });
  await q.query('UPDATE kyc_cases SET submitted_at=now(), submitted_by=$2 WHERE id=$1', [caseId, i.actor]);
  const j = await judgeCase(q, { ev, c, personal: pp, individual, s });
  if (j.result === 'APPROVE') await setOutcome(q, null, c, { case: 'APPROVED', by: j.by, reason: j.reason, flags: j.flags, checks: j.checks });
  else if (j.result === 'REJECT') await setOutcome(q, null, c, { case: 'REJECTED', by: j.by, reason: j.reason, reasonCode: j.reasonCode, flags: j.flags, checks: j.checks });
  else await setOutcome(q, null, c, { case: 'PENDING', by: null, flags: j.flags, checks: j.checks });
  const done = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [caseId])).rows[0]!;
  await afterSubmit(q, done, i.customerId, i.actor, j.flags, done.status);
  if (done.status === 'APPROVED') await releaseOrders(q, i.customerId, 'APPROVED', j.by ?? 'auto-rules');
  else if (done.status === 'REJECTED') await releaseOrders(q, i.customerId, 'REJECTED', j.by ?? 'system');
  return done;
}

// ───────────────────────── identity confirmed by an identity provider (MyDigital ID) ─────────────────────────
export interface AssertedIdentity {
  /** An application (store-front) or a customer (CRM) the check belongs to. */
  applicationId?: string | null; customerId?: string | null; source: 'STOREFRONT' | 'CRM_ORDER' | 'CRM_CUSTOMER'; actor: string;
  personal: Personal; individual?: boolean;
  /** What the provider confirmed, kept on the case for the reviewer (no ID number, no tokens). */
  assertion: Record<string, unknown>; autoApprove: boolean;
}

/**
 * The person proved who they are with an identity provider instead of photographing their ID. The provider's answer has already been matched with what was
 * typed. This opens the case, runs the same rules (age, expiry, duplicates) and approves it, or leaves it for a person when automatic approval is off or
 * a rule flags it. No photographs exist for such a case; the reviewer sees the provider's confirmation instead.
 */
export async function recordAssertedIdentity(q: Queryable, a: AssertedIdentity): Promise<Row> {
  const s = await getStoreSettings(q);
  const pp = a.personal;
  const hard = hardFailures(pp, s, todayStr());
  if (hard.length) throw rejected(hard.join(' '));
  const individual = a.individual ?? true;
  let c: Row;
  if (a.applicationId) {
    const app = await loadApp(q, a.applicationId);
    if (app.status !== 'DRAFT') throw rejected(`This application is ${app.status.toLowerCase().replace('_', ' ')}.`);
    const synced = await syncCase(q, a.applicationId, 'MYDIGITAL_ID');
    if (!synced) throw invalid(personalProblems(app.personal).join(' '));
    c = synced;
  } else {
    const cid = a.customerId!;
    const cust = (await q.query('SELECT * FROM customers WHERE id=$1', [cid])).rows[0];
    if (!cust) throw notFound('customer', cid);
    const prior = (await q.query(`SELECT * FROM kyc_cases WHERE customer_id=$1 AND application_id IS NULL ORDER BY created_at DESC LIMIT 1`, [cid])).rows[0];
    if (prior && prior.status === 'PENDING') throw conflict('An identity check is already waiting for review for this customer.');
    if (cust.kycStatus === 'VERIFIED') throw conflict('This customer is already verified.');
    if (prior && prior.status === 'REJECTED' && (prior.fraudReported || prior.reasonCode === 'SUSPECTED_FRAUD')) throw rejected('The last identity check was rejected as suspected fraud. This customer cannot be re-submitted; speak to compliance.');
    const hash = hashIdDocument(pp.idNumber);
    const vals = [pp.fullName.trim(), pp.dateOfBirth, pp.nationality ?? null, pp.idType, encryptText(pp.idNumber.trim()), hash, maskIdDocument(pp.idNumber.trim()), pp.idExpiry ?? null];
    let id: string;
    if (prior && prior.status !== 'APPROVED') {
      id = prior.id;
      await q.query(`UPDATE kyc_cases SET method='MYDIGITAL_ID', source=$2, full_name=$3, date_of_birth=$4, nationality=$5, id_type=$6, id_number_enc=$7, id_number_hash=$8, id_number_masked=$9, id_expiry=$10,
        status='PENDING', decided_by=NULL, decided_at=NULL, decision_reason=NULL, reason_code=NULL, fraud_reported=false, flags='{}', checks='{}', updated_at=now() WHERE id=$1`, [id, a.source, ...vals]);
    } else {
      id = randomUUID();
      await q.query(`INSERT INTO kyc_cases (id, application_id, customer_id, method, source, full_name, date_of_birth, nationality, id_type, id_number_enc, id_number_hash, id_number_masked, id_expiry)
        VALUES ($1,NULL,$2,'MYDIGITAL_ID',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, cid, a.source, ...vals]);
    }
    if (!cust.dateOfBirth && individual) await q.query('UPDATE customers SET date_of_birth=$2 WHERE id=$1', [cid, pp.dateOfBirth]);
    c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [id])).rows[0]!;
  }
  const customerId = (a.customerId ?? c.customerId ?? null) as string | null;
  const ev = await evaluate(q, { personal: pp, c, customerId, individual, s });
  const checks = { ...ev.checks, liveCapture: null, mydigitalid: a.assertion };
  await q.query('UPDATE kyc_cases SET submitted_at=now(), submitted_by=$2 WHERE id=$1', [c.id, a.actor]);
  const app = a.applicationId ? await loadApp(q, a.applicationId) : null;
  if (a.autoApprove && !ev.flags.length) await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: 'mydigital-id', reason: 'Identity confirmed by MyDigital ID', flags: ev.flags, checks });
  else await setOutcome(q, app, c, { case: 'PENDING', app: 'KYC_REVIEW', by: null, flags: ev.flags, checks });
  const done = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [c.id])).rows[0]!;
  await afterSubmit(q, done, customerId, a.actor, ev.flags, done.status);
  if (customerId && done.status === 'APPROVED') await releaseOrders(q, customerId, 'APPROVED', 'mydigital-id');
  return done;
}

/**
 * The CRM creates a customer. Identity is not optional: the customer, the evidence and the review task come into being together or not at all.
 * `input.idDocument` is the ID number typed on the customer form.
 */
export async function createCustomerWithKyc(db: Db, input: NewCustomer, kyc: Omit<CustomerKycInput, 'customerId' | 'identity'> & { identity: Omit<IdentityInput, 'idNumber'> }, extra: { details?: (customerId: string) => Promise<void> } = {}) {
  return db.tx(async (q) => {
    const made = await createCustomer(q, input);
    const c = await submitCustomerKyc(q, { ...kyc, customerId: made.customer.id as string, identity: { ...kyc.identity, idNumber: input.idDocument } });
    await extra.details?.(made.customer.id as string);
    const customer = (await q.query('SELECT * FROM customers WHERE id=$1', [made.customer.id])).rows[0]!;
    const { idDocumentHash: _h, ...safe } = customer;
    return { ...made, customer: safe, kyc: { caseId: c.id as string, status: c.status as string, flags: c.flags as string[] } };
  });
}

/** Everything a screen needs about a customer's identity check: status, the case, which photographs are on file, and the orders waiting on it. Never the images. */
export async function customerKycView(q: Queryable, customerId: string): Promise<Record<string, unknown>> {
  const cust = (await q.query('SELECT id, display_name, kyc_status, kyc_verified_at, segment, date_of_birth IS NOT NULL AS dob_known FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!cust) throw notFound('customer', customerId);
  const s = await getStoreSettings(q);
  const c = (await q.query(`SELECT * FROM kyc_cases WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`, [customerId])).rows[0];
  const seg = (await q.query('SELECT individual FROM customer_segments WHERE id=$1', [cust.segment])).rows[0];
  return {
    status: cust.kycStatus, verifiedAt: cust.kycVerifiedAt, dateOfBirthKnown: !!cust.dobKnown, individual: seg?.individual ?? true, gate: s.kycGate, liveCaptureRequired: s.kycRequireLiveCapture, minAge: s.minAge,
    case: c ? { id: c.id, status: c.status, method: c.method, source: c.source, flags: c.flags, submittedAt: c.submittedAt, decidedAt: c.decidedAt, decidedBy: c.decidedBy, reason: c.decisionReason ?? c.checks?.returnReason ?? null, reasonCode: c.reasonCode, idType: c.idType, idNumberMasked: c.idNumberMasked,
      canResubmit: c.status === 'RETURNED' || (c.status === 'REJECTED' && !c.fraudReported && c.reasonCode !== 'SUSPECTED_FRAUD'), documents: (await listCaseDocuments(q, { id: c.id, applicationId: c.applicationId })).map(({ id, kind, status, live, takenAt }) => ({ id, kind, status, live, takenAt })) } : null,
    waitingOrders: await waitingOrders(q, customerId),
    methods: await kycMethods(q),
  };
}

/** Orders whose service activation is waiting for this customer's identity to be settled. */
async function waitingOrders(q: Queryable, customerId: string): Promise<Row[]> {
  return (await q.query(
    `SELECT o.id, o.number, o.state, o.total_minor, o.currency, o.created_at FROM orders o JOIN order_groups g ON g.order_id = o.id AND g.kind='ACTIVATION' AND g.status='PENDING'
      WHERE o.customer_id=$1 AND o.state NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY o.created_at`, [customerId])).rows;
}

async function releaseOrders(q: Queryable, customerId: string, outcome: 'APPROVED' | 'REJECTED', actor: string) {
  const { applyKycOutcomeToOrders } = await import('./orders.js');   // orders already depend on identity (hold at activation); this is the way back, loaded late
  return applyKycOutcomeToOrders(q, customerId, outcome, actor);
}

// ───────────────────────── compliance review ─────────────────────────
export async function listKycCases(q: Queryable, f: { status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 100);
  const { params, p } = sqlBuilder();
  const sla = (await getStoreSettings(q)).kycSlaHours;
  // A store-front case exists as soon as details are typed in; it only reaches the queue once submitted. A case that belongs to a customer is submitted by definition.
  const where: string[] = [`(k.status <> 'PENDING' OR k.application_id IS NULL OR a.status IN ('KYC_REVIEW','ORDERED'))`];
  if (f.status) where.push(`k.status = ${p(f.status)}`);
  const cur = decodeCursor(f.cursor, 2); // oldest waiting first
  if (cur) where.push(`(k.created_at, k.id) > (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const slaP = p(String(sla));
  const rows = (await q.query(
    `SELECT k.id, k.application_id, k.customer_id, k.method, k.source, k.status, k.full_name, k.id_type, k.id_number_masked, k.flags, k.created_at, k.created_at::text AS cursor_ts, k.submitted_at, k.decided_by, k.decided_at, k.reason_code,
            COALESCE(a.channel, 'RETAIL_ASSISTED') AS channel, a.status AS application_status,
            (k.status = 'PENDING' AND COALESCE(k.submitted_at, k.created_at) < now() - (${slaP} || ' hours')::interval) AS overdue,
            (SELECT count(*) FROM orders o JOIN order_groups g ON g.order_id = o.id AND g.kind='ACTIVATION' AND g.status='PENDING'
               WHERE k.status = 'PENDING' AND o.customer_id = k.customer_id AND o.state NOT IN ('COMPLETED','CANCELLED','FAILED'))::int AS waiting_orders
     FROM kyc_cases k LEFT JOIN applications a ON a.id = k.application_id WHERE ${where.join(' AND ')} ORDER BY k.created_at, k.id LIMIT ${p(limit + 1)}`, params)).rows;
  const page = toPage(rows as Array<Row & { id: string; cursorTs: string }>, limit, (r) => [r.cursorTs, r.id]);
  return { items: page.items.map(({ cursorTs: _d, ...r }) => r), nextCursor: page.nextCursor };
}

/** How many tasks wait, and how many are overdue: the number on the menu. */
export async function kycQueueCounts(q: Queryable): Promise<{ waiting: number; overdue: number }> {
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const r = (await q.query(
    `SELECT count(*)::int AS waiting, count(*) FILTER (WHERE COALESCE(k.submitted_at, k.created_at) < now() - ($1 || ' hours')::interval)::int AS overdue
       FROM kyc_cases k LEFT JOIN applications a ON a.id = k.application_id WHERE k.status='PENDING' AND (k.application_id IS NULL OR a.status IN ('KYC_REVIEW','ORDERED'))`, [String(sla)])).rows[0]!;
  return { waiting: r.waiting, overdue: r.overdue };
}

/** One case with the full ID number (decrypted for the reviewer) and its documents. Opening it is itself audited. */
export async function getKycCase(q: Queryable, id: string, reviewer: string): Promise<Row> {
  const c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1', [id])).rows[0];
  if (!c) throw notFound('KYC case', id);
  const app = c.applicationId ? (await q.query('SELECT id, channel, status, personal, address, consent, lines, created_at FROM applications WHERE id=$1', [c.applicationId])).rows[0] : null;
  const cust = c.customerId ? (await q.query('SELECT id, display_name, email, phone, segment, kyc_status, address, created_at FROM customers WHERE id=$1', [c.customerId])).rows[0] : null;
  const s = await getStoreSettings(q);
  const { idNumberEnc, idNumberHash: _h, ...rest } = c;
  await audit(q, reviewer, 'kyc_case', id, 'VIEWED');
  const due = new Date(new Date(c.submittedAt ?? c.createdAt).getTime() + s.kycSlaHours * 3_600_000).toISOString();
  return {
    ...rest, idNumber: decryptText(idNumberEnc), application: app, customer: cust, documents: await listCaseDocuments(q, { id: c.id, applicationId: c.applicationId }),
    waitingOrders: c.customerId && c.status === 'PENDING' ? await waitingOrders(q, c.customerId) : [], dueAt: due, overdue: c.status === 'PENDING' && Date.now() > Date.parse(due),
    canReturn: !app || app.status === 'KYC_REVIEW', canReportFraud: true,
  };
}

/** The bytes of one piece of evidence, for the reviewer. The access is written to the document log. */
export async function getKycDocument(q: Queryable, docId: string, viewer: DocWho | string): Promise<{ contentType: string; bytes: Buffer }> {
  const who: DocWho = typeof viewer === 'string' ? { username: viewer } : viewer;
  const row = (await q.query(`SELECT kind, kyc_case_id, application_id, storage FROM documents WHERE id=$1`, [docId])).rows[0];
  if (!row || row.kind !== 'KYC' || (!row.kycCaseId && row.storage !== 'KYC_LEGACY')) throw notFound('document', docId);
  const r = await openDocument(q, docId, who, 'VIEW');
  return { contentType: r.contentType, bytes: r.bytes };
}

export type Decision = { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string; reasonCode?: string; reportFraud?: boolean };
export const REASON_CODES = ['NOT_AN_ID', 'UNREADABLE', 'MISMATCH', 'EXPIRED', 'SUSPECTED_FRAUD', 'OTHER'] as const;

export async function decideKycCase(q: Queryable, caseId: string, reviewer: string, d: Decision, s: StoreSettings, o: { canReportFraud?: boolean } = {}): Promise<Row> {
  const c = (await q.query('SELECT * FROM kyc_cases WHERE id=$1 FOR UPDATE', [caseId])).rows[0];
  if (!c) throw notFound('KYC case', caseId);
  if (c.status !== 'PENDING') throw conflict(`This case was already ${c.status.toLowerCase()}${c.decidedBy ? ` by ${c.decidedBy}` : ''}.`);
  const app = c.applicationId ? await loadApp(q, c.applicationId) : null;
  if (app && !['KYC_REVIEW', 'ORDERED'].includes(app.status)) throw rejected('This application is not waiting for review.');
  const reason = d.reason?.trim();
  if (d.decision !== 'APPROVE' && !reason) throw invalid('Give a reason; the applicant or store will see it.');
  if (d.reasonCode && !(REASON_CODES as readonly string[]).includes(d.reasonCode)) throw invalid(`The reason code is one of ${REASON_CODES.join(', ')}.`);
  if (d.reportFraud && !o.canReportFraud) throw rejected('You are not allowed to add to the fraud register.');
  const personal = { dateOfBirth: String(c.dateOfBirth).slice(0, 10), idExpiry: c.idExpiry ? String(c.idExpiry).slice(0, 10) : undefined };
  const customerId = (c.customerId ?? app?.customerId ?? null) as string | null;
  if (d.decision === 'APPROVE') {
    const hard = hardFailures(personal, s, todayStr());
    if (hard.length) throw rejected(`This cannot be approved: ${hard.join(' ')}`);
    // An online applicant whose ID already belongs to a customer must never be attached to that customer's account: the existing owner would be billed.
    if (app?.channel === 'SELF_SERVE' && (c.flags as string[]).includes('DUPLICATE_IDENTITY')) {
      throw rejected('This ID is already registered to an existing customer, so it cannot be approved online. Reject it (the customer can visit a store) or send it back.');
    }
    // Whoever attested or submitted in person cannot also approve their own case.
    if (c.attestation?.by === reviewer || c.submittedBy === reviewer) throw rejected('A different person must review a case you submitted.');
    await setOutcome(q, app, c, { case: 'APPROVED', app: 'KYC_APPROVED', by: reviewer, reason: reason ?? 'Approved after review' });
  } else if (d.decision === 'REJECT') {
    await setOutcome(q, app, c, { case: 'REJECTED', app: 'KYC_REJECTED', by: reviewer, reason, reasonCode: d.reasonCode ?? (d.reportFraud ? 'SUSPECTED_FRAUD' : 'OTHER') });
    if (d.reportFraud) {
      await blacklistAdd(q, { kind: 'ID_DOCUMENT', hash: c.idNumberHash, hint: c.idNumberMasked, reason: `KYC rejected: ${reason}`, actor: reviewer }).catch((e) => { if (!/already on the blacklist/.test((e as Error).message)) throw e; });
      await q.query('UPDATE kyc_cases SET fraud_reported=true WHERE id=$1', [caseId]);
    }
  } else {
    if (app && app.status !== 'KYC_REVIEW') throw rejected('The order has already been placed, so this cannot be sent back. Approve it or reject it.');
    // Sent back: the applicant (or the store) fixes the details or photographs again, then submits again.
    await q.query(`UPDATE kyc_cases SET checks = checks || $2::jsonb, updated_at=now() WHERE id=$1`, [caseId, JSON.stringify({ returnReason: reason, returnedBy: reviewer })]);
    if (app) await q.query(`UPDATE applications SET status='DRAFT', updated_at=now() WHERE id=$1`, [app.id]);
    else await setOutcome(q, null, c, { case: 'RETURNED', by: reviewer, reason, reasonCode: d.reasonCode ?? 'OTHER' });
  }
  await audit(q, reviewer, 'kyc_case', caseId, d.decision, { applicationId: app?.id ?? null, customerId, reason, reasonCode: d.reasonCode ?? null, fraud: !!d.reportFraud });
  const after = (await q.query('SELECT id, status, decided_by, decision_reason, reason_code FROM kyc_cases WHERE id=$1', [caseId])).rows[0]!;
  await raiseEvent(q, 'KYC_DECIDED', { resourceId: caseId, payload: { caseId, customerId, decision: d.decision, status: after.status, reasonCode: after.reasonCode ?? null } }, { onlyIfWanted: true });
  if (customerId && d.decision !== 'RETURN') await releaseOrders(q, customerId, d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewer);
  return after;
}
