import { randomUUID } from 'node:crypto';
import type { Db, Row } from './db.js';
import { encryptText } from './field-crypto.js';
import { hashIdDocument } from './customers.js';
import { enqueueForReview } from './kyc-review.js';

/** Test helpers for the review workflow: staff and queued cases without the photographs. */
let n = 0;
export async function addOfficer(db: Db, username: string, roles: string[] = ['compliance'], o: { status?: 'ACTIVE' | 'DISABLED'; superuser?: boolean; displayName?: string } = {}): Promise<string> {
  await db.query(`INSERT INTO users (username, display_name, roles, password_hash, status, is_superuser) VALUES ($1,$2,$3,'x',$4,$5)`, [username, o.displayName ?? username, o.superuser ? [] : roles, o.status ?? 'ACTIVE', !!o.superuser]);
  return username;
}
export interface RawCase { submittedBy?: string | null; attestedBy?: string; flags?: string[]; source?: string; name?: string; idNumber?: string; dob?: string; expiry?: string | null; submittedHoursAgo?: number; customerId?: string | null; enqueue?: boolean; checks?: Record<string, unknown> }
/** A waiting review task, queued the way every submit flow queues one. */
export async function addCase(db: Db, o: RawCase = {}): Promise<string> {
  const id = randomUUID(), idNo = o.idNumber ?? `S${String(3000000 + ++n)}Z`;
  await db.query(
    `INSERT INTO kyc_cases (id, customer_id, method, source, full_name, date_of_birth, id_type, id_number_enc, id_number_hash, id_number_masked, id_expiry, flags, checks, submitted_at, submitted_by, attestation, status)
     VALUES ($1,$2,'DOCUMENT_STORE',$3,$4,$5,'NATIONAL_ID',$6,$7,$8,$9,$10,$11, now() - ($12 || ' hours')::interval, $13, $14, 'PENDING')`,
    [id, o.customerId ?? null, o.source ?? 'CRM_CUSTOMER', o.name ?? `Applicant ${n}`, o.dob ?? '1990-04-12', encryptText(idNo), hashIdDocument(idNo), `S****${idNo.slice(-3)}`, o.expiry === undefined ? '2099-01-01' : o.expiry, o.flags ?? [], JSON.stringify(o.checks ?? {}),
      String(o.submittedHoursAgo ?? 0), o.submittedBy === undefined ? 'clerk.one' : o.submittedBy, o.attestedBy ? JSON.stringify({ by: o.attestedBy }) : null]);
  if (o.enqueue !== false) await db.tx((q) => enqueueForReview(q, id));
  return id;
}
export const caseRow = async (db: Db, id: string): Promise<Row> => (await db.query('SELECT * FROM kyc_cases WHERE id=$1', [id])).rows[0]!;
export const holders = async (db: Db): Promise<Record<string, number>> => Object.fromEntries((await db.query(`SELECT assigned_to AS u, count(*)::int AS n FROM kyc_cases WHERE status='PENDING' AND assigned_to IS NOT NULL GROUP BY 1`)).rows.map((r) => [r.u, r.n]));
export const events = async (db: Db, id: string, action?: string): Promise<Row[]> => (await db.query(`SELECT * FROM kyc_case_events WHERE case_id=$1 ${action ? 'AND action=$2' : ''} ORDER BY id`, action ? [id, action] : [id])).rows;
