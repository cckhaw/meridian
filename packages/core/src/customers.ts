import { createHmac, randomUUID } from 'node:crypto';
import type { Account, Customer, CustomerSegment } from '@meridian/types';
import { effectiveMarket, marketDuplicates, marketFor } from './settings.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, tsPage, type Page } from './paging.js';
import { customerIdsMatching, parseQuery } from './search.js';
import { getBillCycles, defaultCycleDay, type CustomerDetails } from './customer-config.js';
import { assertSegmentUsable } from './segments.js';
import { shardFor } from './shard.js';

export interface NewCustomer {
  segment: CustomerSegment;
  displayName: string;
  idDocument: string;
  marketCode?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: CustomerDetails['address'];
  parentCustomerId?: string;
  /** Create a default account (bill cycle day 1..28, or null for daily). `false` skips it. */
  account?: { name?: string; billCycleDay?: number | null } | false;
}

const label = (id: string) => 'c_' + id.replaceAll('-', '_'); // ltree labels allow [A-Za-z0-9_]
export const maskIdDocument = (doc: string) => (doc.length <= 4 ? '****' : doc.slice(0, 1) + '*'.repeat(doc.length - 4) + doc.slice(-3));
// Keyed hash for duplicate detection. Set MERIDIAN_ID_PEPPER in production; raw ID documents are never stored.
export const hashIdDocument = (doc: string) => createHmac('sha256', process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper').update(doc.trim().toUpperCase()).digest('hex');

/** Internal-only columns never leave the service (the ID hash exists purely for duplicate detection). */
const strip = <T extends Row>(r: T): T => { const { idDocumentHash: _h, ...rest } = r; return rest as T; };

export async function createCustomer(q: Queryable, input: NewCustomer): Promise<{ customer: Customer; account?: Account }> {
  if (!input.displayName.trim()) throw invalid('displayName is required');
  const id = randomUUID();
  const shardId = shardFor(id);
  const marketCode = await effectiveMarket(q, input.marketCode);
  const hash = hashIdDocument(input.idDocument);
  // Individuals must be unique by ID document; companies and fleets (non-individual segments) may legitimately share one.
  const segment = await assertSegmentUsable(q, input.segment);
  if (segment.individual) {
    const dup = (await q.query('SELECT id FROM customers WHERE id_document_hash=$1 AND ($2::text IS NULL OR market_code=$2) LIMIT 1', [hash, await marketDuplicates(q, marketCode)])).rows[0];
    if (dup) throw conflict(`a customer with this ID document already exists (${dup.id})`);
  }
  let path = label(id);
  if (input.parentCustomerId) {
    const parent = (await q.query('SELECT hierarchy_path FROM customers WHERE id=$1', [input.parentCustomerId])).rows[0];
    if (!parent) throw notFound('parent customer', input.parentCustomerId);
    path = `${parent.hierarchyPath}.${path}`;
  }
  await q.query(
    `INSERT INTO customers (id, shard_id, segment, display_name, id_document_ref, id_document_hash, market_code, parent_customer_id, hierarchy_path, email, phone, date_of_birth, gender, address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, shardId, input.segment, input.displayName.trim(), maskIdDocument(input.idDocument), hash, marketCode, input.parentCustomerId ?? null, path, input.email ?? null, input.phone ?? null,
     input.dateOfBirth ?? null, input.gender ?? null, input.address && Object.keys(input.address).length ? JSON.stringify(input.address) : null],
  );
  const customer = await getCustomer(q, id);
  if (input.account === false) return { customer };
  const account = await createAccount(q, id, input.account ?? {});
  return { customer, account };
}

export async function createAccount(q: Queryable, customerId: string, o: { name?: string; billCycleDay?: number | null; payerAccountId?: string }): Promise<Account> {
  const c = (await q.query('SELECT shard_id, market_code FROM customers WHERE id=$1', [customerId])).rows[0];
  if (!c) throw notFound('customer', customerId);
  const day = o.billCycleDay === undefined ? defaultCycleDay(await getBillCycles(q)) : o.billCycleDay; // the operator's default cycle unless one was chosen
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

export async function searchCustomers(q: Queryable, f: { q?: string; segment?: string; limit?: number; cursor?: string }): Promise<Page<Row>> {
  const limit = pageSize(f.limit);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.segment) where.push(`c.segment = ${p(f.segment)}`);
  const ids = customerIdsMatching(await parseQuery(q, f.q), p);
  // An ID document number (NRIC, passport, UEN) finds its owner exactly, through the keyed hash: the number itself is never stored.
  const text = (f.q ?? '').trim();
  const doc = /^[A-Za-z0-9][A-Za-z0-9-]{4,19}$/.test(text) && /\d/.test(text) ? `c.id_document_hash = ${p(hashIdDocument(text))}` : null;
  if (ids && doc) where.push(`(c.id IN (${ids}) OR ${doc})`);
  else if (ids) where.push(`c.id IN (${ids})`);
  else if (doc) where.push(doc);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(c.created_at, c.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT c.*, c.created_at::text AS cursor_ts, (SELECT count(*) FROM services s WHERE s.customer_id = c.id AND s.status IN ('ACTIVE','SUSPENDED')) AS service_count,
       (SELECT count(*) FROM customers k WHERE k.parent_customer_id = c.id) AS child_count
     FROM customers c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.created_at DESC, c.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  const page = tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
  return { items: page.items.map(strip), nextCursor: page.nextCursor };
}

/**
 * Direct children (departments / sub-accounts) of a customer, or the whole subtree with `deep`. Paged and searchable by name, so an enterprise with
 * tens of thousands of departments opens instantly.
 */
export async function listChildren(q: Queryable, customerId: string, o: { deep?: boolean; limit?: number; cursor?: string; q?: string } = {}): Promise<Page<Row>> {
  const c = await getCustomer(q, customerId);
  const limit = pageSize(o.limit);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  const words = await parseQuery(q, o.q);
  if (o.deep) where.push(`k.hierarchy_path <@ ${p(c.hierarchyPath)}::ltree`, `k.id <> ${p(customerId)}`); else where.push(`k.parent_customer_id = ${p(customerId)}`);
  if (words.kind === 'words') where.push(`to_tsvector('simple', k.display_name) @@ to_tsquery('simple', ${p(words.tsquery)})`);
  else if (words.kind !== 'empty') where.push(`k.id IN (${customerIdsMatching(words, p)})`);
  const orderCol = o.deep ? 'k.hierarchy_path::text' : 'k.display_name';
  const cur = decodeCursor(o.cursor, 2);
  if (cur) where.push(`(${orderCol}, k.id) > (${p(cur[0])}::text, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT k.*, ${orderCol} AS cursor_ord, (SELECT count(*) FROM customers g WHERE g.parent_customer_id = k.id) AS child_count,
       (SELECT count(*) FROM services s WHERE s.customer_id = k.id AND s.status IN ('ACTIVE','SUSPENDED')) AS service_count
     FROM customers k WHERE ${where.join(' AND ')} ORDER BY ${orderCol}, k.id LIMIT ${p(limit + 1)}`, params)).rows;
  const page = toPage(rows as Array<Row & { cursorOrd: string; id: string }>, limit, (r) => [r.cursorOrd, r.id]);
  return { items: page.items.map(({ cursorOrd: _o, ...rest }) => strip(rest)), nextCursor: page.nextCursor };
}

export async function updateCustomer(q: Queryable, id: string, patch: { displayName?: string; email?: string; phone?: string; status?: string; dateOfBirth?: string; gender?: string; address?: CustomerDetails['address'] }) {
  const cur = await getCustomer(q, id);
  // The address is replaced as a whole when any part of it is sent, merged with what was there so a single changed field does not wipe the rest.
  const address = patch.address ? { ...((cur.address as object | null) ?? {}), ...patch.address } : undefined;
  await q.query(
    `UPDATE customers SET display_name = COALESCE($2, display_name), email = COALESCE($3, email), phone = COALESCE($4, phone),
       status = COALESCE($5, status), date_of_birth = COALESCE($6::date, date_of_birth), gender = COALESCE($7, gender), address = COALESCE($8::jsonb, address), version = version + 1, updated_at = now() WHERE id = $1`,
    [id, patch.displayName ?? null, patch.email ?? null, patch.phone ?? null, patch.status ?? null, patch.dateOfBirth ?? null, patch.gender ?? null, address ? JSON.stringify(address) : null],
  );
  return getCustomer(q, id);
}

// ───────────────────────── hierarchy navigation: group → customer → account → services ─────────────────────────

/** The accounts of one customer, oldest first, a page at a time, each with its open balance and live service count (computed for the page only). */
export async function listAccounts(q: Queryable, customerId: string, f: { q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 20, 100);
  const { params, p } = sqlBuilder();
  const where = [`a.customer_id = ${p(customerId)}`];
  const text = (f.q ?? '').trim();
  if (text) where.push(`lower(a.name) LIKE ${p(`%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`); // bounded by the customer, so a substring match is cheap
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(a.created_at, a.id) > (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(`SELECT a.*, a.created_at::text AS cursor_ts FROM accounts a WHERE ${where.join(' AND ')} ORDER BY a.created_at, a.id LIMIT ${p(limit + 1)}`, params)).rows;
  const page = tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
  const ids = page.items.map((a) => a.id as string);
  const bal = new Map<string, number>(), svc = new Map<string, number>();
  if (ids.length) {
    for (const r of (await q.query(`SELECT account_id, sum(total_minor - paid_minor - credited_minor) AS b FROM invoices WHERE account_id = ANY($1) AND status IN ('ISSUED','OVERDUE') GROUP BY account_id`, [ids])).rows) bal.set(r.accountId, Number(r.b));
    for (const r of (await q.query(`SELECT account_id, count(*) AS n FROM services WHERE account_id = ANY($1) AND status IN ('ACTIVE','SUSPENDED') GROUP BY account_id`, [ids])).rows) svc.set(r.accountId, Number(r.n));
  }
  return { items: page.items.map((a) => ({ ...a, balanceMinor: bal.get(a.id as string) ?? 0, serviceCount: svc.get(a.id as string) ?? 0 })), nextCursor: page.nextCursor };
}

export async function getAccount(q: Queryable, accountId: string): Promise<Row> {
  const a = (await q.query('SELECT * FROM accounts WHERE id=$1', [accountId])).rows[0];
  if (!a) throw notFound('account', accountId);
  const [bal, svc, cust] = await Promise.all([
    q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS b FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE')`, [accountId]),
    q.query(`SELECT count(*) AS n FROM services WHERE account_id=$1 AND status IN ('ACTIVE','SUSPENDED')`, [accountId]),
    q.query('SELECT id, display_name, segment FROM customers WHERE id=$1', [a.customerId]),
  ]);
  return { ...a, balanceMinor: Number(bal.rows[0]!.b), serviceCount: Number(svc.rows[0]!.n), customer: cust.rows[0] };
}

/** Where a customer sits: the chain of parent customers above it (enterprise → department …). A short list. */
export async function customerLineage(q: Queryable, customerId: string): Promise<{ ancestors: Row[] }> {
  const c = await getCustomer(q, customerId);
  const anc = await q.query(`SELECT id, display_name, segment FROM customers WHERE hierarchy_path @> $1::ltree AND id <> $2 ORDER BY nlevel(hierarchy_path) LIMIT 12`, [c.hierarchyPath, customerId]);
  return { ancestors: anc.rows };
}
