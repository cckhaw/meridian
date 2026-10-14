import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';

/** The operators a number can be ported in from. Maintained in Settings; each has the routing code the clearinghouse uses to route the request. */
export interface DonorOperator { id: string; name: string; routingCode: string; status: 'ACTIVE' | 'INACTIVE'; inUse?: number }

const cleanName = (v: unknown) => {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (t.length < 2 || t.length > 60) throw invalid('The operator’s name is 2 to 60 characters.');
  return t;
};
const cleanCode = (v: unknown) => {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(t)) throw invalid('The routing code is 1 to 20 letters, digits, dots, dashes or underscores.');
  return t;
};
const dupe = (e: unknown, name: string, code: string) => {
  if (/donor_operators_name_uq/.test((e as Error).message)) throw conflict(`There is already an operator called “${name}”.`);
  if (/donor_operators_code_uq/.test((e as Error).message)) throw conflict(`The routing code ${code} belongs to another operator.`);
  throw e;
};

/** Operators for a screen: everyone for the settings list, only the active ones for the ordering drop-down. */
export async function listDonorOperators(q: Queryable, o: { activeOnly?: boolean } = {}): Promise<DonorOperator[]> {
  return (await q.query(
    `SELECT d.id, d.name, d.routing_code, d.status, (SELECT count(*)::int FROM port_in_requests p WHERE p.donor_operator_id = d.id) AS in_use
       FROM donor_operators d ${o.activeOnly ? `WHERE d.status='ACTIVE'` : ''} ORDER BY lower(d.name)`)).rows as DonorOperator[];
}

export async function getDonorOperator(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT * FROM donor_operators WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('operator', id);
  return r;
}

export async function createDonorOperator(q: Queryable, actor: string, i: { name: string; routingCode: string }): Promise<Row> {
  const name = cleanName(i.name), code = cleanCode(i.routingCode);
  try {
    const r = (await q.query(`INSERT INTO donor_operators (name, routing_code, updated_by) VALUES ($1,$2,$3) RETURNING *`, [name, code, actor])).rows[0]!;
    await audit(q, actor, 'donor_operator', r.id, 'CREATED', { name, routingCode: code });
    return r;
  } catch (e) { return dupe(e, name, code); }
}

export async function updateDonorOperator(q: Queryable, actor: string, id: string, p: { name?: string; routingCode?: string; status?: 'ACTIVE' | 'INACTIVE' }): Promise<Row> {
  const cur = await getDonorOperator(q, id);
  const name = p.name === undefined ? cur.name : cleanName(p.name), code = p.routingCode === undefined ? cur.routingCode : cleanCode(p.routingCode);
  if (p.status && !['ACTIVE', 'INACTIVE'].includes(p.status)) throw invalid('The status is ACTIVE or INACTIVE.');
  try {
    const r = (await q.query(`UPDATE donor_operators SET name=$2, routing_code=$3, status=$4, updated_at=now(), updated_by=$5 WHERE id=$1 RETURNING *`, [id, name, code, p.status ?? cur.status, actor])).rows[0]!;
    await audit(q, actor, 'donor_operator', id, 'UPDATED', { ...p });
    return r;
  } catch (e) { return dupe(e, name, code); }
}

/** An operator no request ever used can be removed; one that was used is switched off instead, so the history keeps its name. */
export async function deleteDonorOperator(q: Queryable, actor: string, id: string): Promise<{ deleted: boolean; deactivated: boolean }> {
  await getDonorOperator(q, id);
  const used = Number((await q.query('SELECT count(*) AS n FROM port_in_requests WHERE donor_operator_id=$1', [id])).rows[0]!.n);
  if (used > 0) { await updateDonorOperator(q, actor, id, { status: 'INACTIVE' }); return { deleted: false, deactivated: true }; }
  await q.query('DELETE FROM donor_operators WHERE id=$1', [id]);
  await audit(q, actor, 'donor_operator', id, 'DELETED', {});
  return { deleted: true, deactivated: false };
}
