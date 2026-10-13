import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { invalid, notFound } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';

/** Dealers and their agents: master data managed in the CRM. Staff operating the CRM sell on behalf of a dealer and name the agent. */
const text = (v: string | undefined | null, max: number) => { const t = v?.trim(); if (t && t.length > max) throw invalid(`too long (max ${max} characters)`); return t || null; };

export interface DealerInput { name: string; contactName?: string; email?: string; phone?: string }

export async function listDealers(q: Queryable, f: { q?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  const term = f.q?.trim();
  if (term) where.push(`(upper(d.id) LIKE ${p(likePrefix(term.toUpperCase()))} OR lower(d.name) LIKE ${p(likePrefix(term.toLowerCase()))})`);
  if (f.status) where.push(`d.status = ${p(f.status)}`);
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`d.id > ${p(cur[0])}::text`);
  const rows = (await q.query(
    `SELECT d.id, d.name, d.status, d.contact_name, d.email, d.phone, d.created_at,
            (SELECT count(*) FROM dealer_agents a WHERE a.dealer_id = d.id AND a.status='ACTIVE') AS active_agents
       FROM dealers d ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.id as string]);
}

export async function getDealer(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM dealers WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound(`dealer ${id}`);
  return r;
}

/** The dealer id is issued by the system (DLR-00001, …) and never edited, so it can be quoted on orders and commission without clashes. */
export async function createDealer(q: Queryable, actor: string, i: DealerInput): Promise<Row> {
  const name = text(i.name, 120);
  if (!name) throw invalid('dealer name is required');
  const r = await q.query(
    `INSERT INTO dealers (id, name, contact_name, email, phone, created_by) VALUES ('DLR-' || lpad(nextval('dealer_id_seq')::text, 5, '0'), $1,$2,$3,$4,$5) RETURNING *`,
    [name, text(i.contactName, 120), text(i.email, 200), text(i.phone, 40), actor]);
  const d = r.rows[0]!;
  await audit(q, actor, 'dealer', d.id as string, 'create', { name });
  return d;
}

export async function updateDealer(q: Queryable, actor: string, id: string, p: Partial<Omit<DealerInput, 'id'>> & { status?: 'ACTIVE' | 'INACTIVE' }): Promise<Row> {
  await getDealer(q, id);
  const name = p.name === undefined ? null : text(p.name, 120);
  if (p.name !== undefined && !name) throw invalid('dealer name is required');
  const r = await q.query(
    `UPDATE dealers SET name=COALESCE($2,name), status=COALESCE($3,status), contact_name=CASE WHEN $4::boolean THEN $5 ELSE contact_name END,
       email=CASE WHEN $6::boolean THEN $7 ELSE email END, phone=CASE WHEN $8::boolean THEN $9 ELSE phone END, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, name, p.status ?? null, p.contactName !== undefined, text(p.contactName, 120), p.email !== undefined, text(p.email, 200), p.phone !== undefined, text(p.phone, 40)]);
  await audit(q, actor, 'dealer', id, 'update', { ...p });
  return r.rows[0]!;
}

export async function listAgents(q: Queryable, dealerId: string, f: { status?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where = [`a.dealer_id = ${p(dealerId)}`];
  if (f.status) where.push(`a.status = ${p(f.status)}`);
  if (f.q?.trim()) where.push(`(upper(a.id) LIKE ${p(likePrefix(f.q.trim().toUpperCase()))} OR lower(a.name) LIKE ${p(likePrefix(f.q.trim().toLowerCase()))})`);
  const cur = decodeCursor(f.cursor, 1);
  if (cur) where.push(`a.id > ${p(cur[0])}::text`);
  const rows = (await q.query(`SELECT a.id, a.dealer_id, a.name, a.status, a.email, a.phone, a.created_at FROM dealer_agents a WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.id as string]);
}

export async function createAgent(q: Queryable, actor: string, dealerId: string, i: { name: string; email?: string; phone?: string }): Promise<Row> {
  const d = await getDealer(q, dealerId);
  if (d.status !== 'ACTIVE') throw invalid('this dealer is inactive');
  const name = text(i.name, 120);
  if (!name) throw invalid('agent name is required');
  const n = Number((await q.query('SELECT count(*) AS n FROM dealer_agents WHERE dealer_id=$1', [dealerId])).rows[0]!.n);
  const id = `${dealerId}-A${String(n + 1).padStart(3, '0')}`;
  const r = await q.query(`INSERT INTO dealer_agents (id, dealer_id, name, email, phone, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [id, dealerId, name, text(i.email, 200), text(i.phone, 40), actor]);
  await audit(q, actor, 'dealer_agent', id, 'create', { dealerId, name });
  return r.rows[0]!;
}

export async function updateAgent(q: Queryable, actor: string, id: string, p: { name?: string; email?: string; phone?: string; status?: 'ACTIVE' | 'INACTIVE' }): Promise<Row> {
  const cur = (await q.query('SELECT * FROM dealer_agents WHERE id=$1', [id])).rows[0];
  if (!cur) throw notFound(`dealer agent ${id}`);
  const name = p.name === undefined ? null : text(p.name, 120);
  if (p.name !== undefined && !name) throw invalid('agent name is required');
  const r = await q.query(
    `UPDATE dealer_agents SET name=COALESCE($2,name), status=COALESCE($3,status), email=CASE WHEN $4::boolean THEN $5 ELSE email END, phone=CASE WHEN $6::boolean THEN $7 ELSE phone END, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, name, p.status ?? null, p.email !== undefined, text(p.email, 200), p.phone !== undefined, text(p.phone, 40)]);
  await audit(q, actor, 'dealer_agent', id, 'update', { ...p });
  return r.rows[0]!;
}

/** An order sold for a dealer needs an active dealer and one of its active agents. */
export async function assertDealerSale(q: Queryable, dealerId: string, agentId: string): Promise<void> {
  const d = (await q.query('SELECT status FROM dealers WHERE id=$1', [dealerId])).rows[0];
  if (!d) throw invalid(`unknown dealer ${dealerId}: dealers are set up under Dealers`);
  if (d.status !== 'ACTIVE') throw invalid(`dealer ${dealerId} is inactive`);
  const a = (await q.query('SELECT status, dealer_id FROM dealer_agents WHERE id=$1', [agentId])).rows[0];
  if (!a || a.dealerId !== dealerId) throw invalid('choose one of this dealer’s agents');
  if (a.status !== 'ACTIVE') throw invalid('this agent is inactive');
}
