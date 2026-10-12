import { createHmac, randomUUID } from 'node:crypto';
import type { Account, Customer, CustomerSegment } from '@meridian/types';
import { marketFor } from './settings.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { shardFor } from './shard.js';

export interface NewCustomer {
  segment: CustomerSegment;
  displayName: string;
  idDocument: string;
  marketCode?: string;
  email?: string;
  phone?: string;
  parentCustomerId?: string;
  /** Create a default account (bill cycle day 1..28, or null for daily). `false` skips it. */
  account?: { name?: string; billCycleDay?: number | null } | false;
}

const label = (id: string) => 'c_' + id.replaceAll('-', '_'); // ltree labels allow [A-Za-z0-9_]
const mask = (doc: string) => (doc.length <= 4 ? '****' : doc.slice(0, 1) + '*'.repeat(doc.length - 4) + doc.slice(-3));
// Keyed hash for duplicate detection. Set MERIDIAN_ID_PEPPER in production; raw ID documents are never stored.
const hashDoc = (doc: string) => createHmac('sha256', process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper').update(doc.trim().toUpperCase()).digest('hex');

/** Internal-only columns never leave the service (the ID hash exists purely for duplicate detection). */
const strip = <T extends Row>(r: T): T => { const { idDocumentHash: _h, ...rest } = r; return rest as T; };

export async function createCustomer(q: Queryable, input: NewCustomer): Promise<{ customer: Customer; account?: Account }> {
  if (!input.displayName.trim()) throw invalid('displayName is required');
  const id = randomUUID();
  const shardId = shardFor(id);
  const marketCode = input.marketCode ?? 'SG';
  const hash = hashDoc(input.idDocument);
  // Individuals must be unique by ID document; enterprises/departments may legitimately share one.
  if (input.segment === 'CONSUMER' || input.segment === 'FAMILY') {
    const dup = (await q.query('SELECT id FROM customers WHERE id_document_hash=$1 AND market_code=$2 LIMIT 1', [hash, marketCode])).rows[0];
    if (dup) throw conflict(`a customer with this ID document already exists (${dup.id})`);
  }
  let path = label(id);
  if (input.parentCustomerId) {
    const parent = (await q.query('SELECT hierarchy_path FROM customers WHERE id=$1', [input.parentCustomerId])).rows[0];
    if (!parent) throw notFound('parent customer', input.parentCustomerId);
    path = `${parent.hierarchyPath}.${path}`;
  }
  await q.query(
    `INSERT INTO customers (id, shard_id, segment, display_name, id_document_ref, id_document_hash, market_code, parent_customer_id, hierarchy_path, email, phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, shardId, input.segment, input.displayName.trim(), mask(input.idDocument), hash, marketCode, input.parentCustomerId ?? null, path, input.email ?? null, input.phone ?? null],
  );
  const customer = await getCustomer(q, id);
  if (input.account === false) return { customer };
  const account = await createAccount(q, id, input.account ?? {});
  return { customer, account };
}

export async function createAccount(q: Queryable, customerId: string, o: { name?: string; billCycleDay?: number | null; payerAccountId?: string }): Promise<Account> {
  const c = (await q.query('SELECT shard_id, market_code FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!c) throw notFound('customer', customerId);
  const day = o.billCycleDay === undefined ? 1 : o.billCycleDay;
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 28)) throw invalid('billCycleDay must be 1-28, or null for a daily cycle');
  const id = randomUUID();
  await q.query(
    `INSERT INTO accounts (id, shard_id, customer_id, bill_cycle_day, currency, name, payer_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, c.shardId, customerId, day, (await marketFor(q, c.marketCode)).currency, o.name ?? 'Main account', o.payerAccountId ?? null],
  );
  return (await q.query<Account>('SELECT * FROM accounts WHERE id=$1', [id])).rows[0]!;
}

export async function getCustomer(q: Queryable, id: string): Promise<Customer & Row> {
  const r = (await q.query<Customer & Row>('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('customer', id);
  return strip(r);
}

export async function searchCustomers(q: Queryable, f: { q?: string; segment?: string; limit?: number; offset?: number }) {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.segment) where.push(`c.segment = ${p(f.segment)}`);
  if (f.q?.trim()) {
    const like = p(`%${f.q.trim()}%`);
    where.push(`(c.display_name ILIKE ${like} OR c.email ILIKE ${like} OR c.phone ILIKE ${like} OR c.id::text = ${p(f.q.trim())}
      OR EXISTS (SELECT 1 FROM services s WHERE s.customer_id = c.id AND s.identifier ILIKE ${like}))`);
  }
  const lim = p(Math.min(f.limit ?? 25, 100)); const off = p(f.offset ?? 0);
  const sql = `SELECT c.*, (SELECT count(*) FROM services s WHERE s.customer_id = c.id AND s.status IN ('ACTIVE','SUSPENDED')) AS service_count,
      (SELECT count(*) FROM customers k WHERE k.parent_customer_id = c.id) AS child_count
    FROM customers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC, c.id LIMIT ${lim} OFFSET ${off}`;
  const rows = (await q.query(sql, params)).rows.map(strip);
  const total = (await q.query(`SELECT count(*) AS n FROM customers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params.slice(0, params.length - 2))).rows[0]!.n;
  return { items: rows, total };
}

/** Direct children (departments / sub-accounts) of a customer, or the whole subtree with `deep`. */
export async function listChildren(q: Queryable, customerId: string, deep = false, limit = 100) {
  const c = await getCustomer(q, customerId);
  if (deep) return (await q.query(`SELECT * FROM customers WHERE hierarchy_path <@ $1::ltree AND id <> $2 ORDER BY hierarchy_path LIMIT $3`, [c.hierarchyPath, customerId, limit])).rows.map(strip);
  return (await q.query(`SELECT * FROM customers WHERE parent_customer_id = $1 ORDER BY display_name LIMIT $2`, [customerId, limit])).rows.map(strip);
}

export async function addToGroup(q: Queryable, groupCustomerId: string, memberCustomerId: string, role: 'OWNER' | 'MEMBER' | 'DEPARTMENT' = 'MEMBER') {
  const g = await getCustomer(q, groupCustomerId);
  await getCustomer(q, memberCustomerId);
  await q.query(
    `INSERT INTO group_memberships (group_customer_id, member_customer_id, shard_id, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (shard_id, group_customer_id, member_customer_id) DO UPDATE SET role = EXCLUDED.role`,
    [groupCustomerId, memberCustomerId, g.shardId, role],
  );
}

export async function updateCustomer(q: Queryable, id: string, patch: { displayName?: string; email?: string; phone?: string; status?: string }) {
  await getCustomer(q, id);
  await q.query(
    `UPDATE customers SET display_name = COALESCE($2, display_name), email = COALESCE($3, email), phone = COALESCE($4, phone),
       status = COALESCE($5, status), version = version + 1, updated_at = now() WHERE id = $1`,
    [id, patch.displayName ?? null, patch.email ?? null, patch.phone ?? null, patch.status ?? null],
  );
  return getCustomer(q, id);
}
