import type { Db, Queryable, Row } from './db.js';
import { audit } from './audit.js';
import { invalid, notFound } from './errors.js';

export const CASE_TYPES = ['FIBER_ASSURANCE', 'BILLING_REFUND', 'MNP_PORT_OUT', 'GENERAL'] as const;
export const CASE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export async function createCase(q: Queryable, i: { customerId: string; serviceId?: string; type: (typeof CASE_TYPES)[number]; subject: string; priority?: string; note?: string }, actor = 'system') {
  if (!CASE_TYPES.includes(i.type)) throw invalid(`type must be one of ${CASE_TYPES.join(', ')}`);
  if (!i.subject.trim()) throw invalid('subject is required');
  if (!(await q.query('SELECT 1 FROM customers WHERE id=$1', [i.customerId])).rows.length) throw notFound('customer', i.customerId);
  const seq = (await q.query(`SELECT nextval('case_seq') AS n`)).rows[0]!.n;
  const notes = i.note ? [{ at: new Date().toISOString(), by: actor, text: i.note }] : [];
  const c = (await q.query(
    `INSERT INTO cases (number, customer_id, service_id, type, priority, subject, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [`CS-${String(seq).padStart(6, '0')}`, i.customerId, i.serviceId ?? null, i.type, i.priority ?? 'NORMAL', i.subject.trim(), JSON.stringify(notes)])).rows[0]!;
  await audit(q, actor, 'case', c.id, 'CREATED', { type: i.type });
  return c;
}

export async function updateCase(q: Queryable, id: string, p: { status?: string; priority?: string; note?: string }, actor = 'system') {
  if (p.status && !CASE_STATUSES.includes(p.status as never)) throw invalid(`status must be one of ${CASE_STATUSES.join(', ')}`);
  const r = await q.query(
    `UPDATE cases SET status = COALESCE($2, status), priority = COALESCE($3, priority),
       notes = CASE WHEN $4::text IS NULL THEN notes ELSE notes || jsonb_build_array(jsonb_build_object('at', now(), 'by', $5::text, 'text', $4::text)) END, updated_at = now()
     WHERE id=$1`, [id, p.status ?? null, p.priority ?? null, p.note ?? null, actor]);
  if (!r.rowCount) throw notFound('case', id);
  return (await q.query('SELECT * FROM cases WHERE id=$1', [id])).rows[0]!;
}

export async function listCases(q: Queryable, f: { customerId?: string; status?: string; type?: string; limit?: number; offset?: number } = {}) {
  const params: unknown[] = []; const where: string[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (f.customerId) where.push(`k.customer_id = ${p(f.customerId)}`);
  if (f.status === 'ACTIVE') where.push(`k.status IN ('OPEN','IN_PROGRESS')`); else if (f.status) where.push(`k.status = ${p(f.status)}`);
  if (f.type) where.push(`k.type = ${p(f.type)}`);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await q.query(`SELECT count(*) AS n FROM cases k ${w}`, params)).rows[0]!.n;
  const lim = p(Math.min(f.limit ?? 25, 100)); const off = p(f.offset ?? 0);
  const items = (await q.query(`SELECT k.*, c.display_name AS customer_name FROM cases k JOIN customers c ON c.id = k.customer_id ${w} ORDER BY k.created_at DESC LIMIT ${lim} OFFSET ${off}`, params)).rows;
  return { items, total };
}

export const getCase = async (q: Queryable, id: string): Promise<Row> => {
  const c = (await q.query('SELECT k.*, c.display_name AS customer_name FROM cases k JOIN customers c ON c.id = k.customer_id WHERE k.id=$1', [id])).rows[0];
  if (!c) throw notFound('case', id);
  return c;
};
export type { Db };
