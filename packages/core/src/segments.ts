import { DEFAULT_CUSTOMER_FIELDS, normaliseFields, type CustomerFieldSettings } from './customer-config.js';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';

/**
 * Customer segments (Consumer, Enterprise, IoT, …) are data the operator maintains in Settings → Customers.
 * A segment says one thing the platform acts on: whether its customers are individuals (`individual`), i.e. one customer per ID document.
 * Segments are never deleted (customers and history point at them); an unused one is switched off instead.
 */
export interface Segment { id: string; name: string; description: string | null; individual: boolean; status: 'ACTIVE' | 'INACTIVE'; sortOrder: number }

const COUNT_CAP = 1000;

export async function listSegments(q: Queryable, o: { withCounts?: boolean; activeOnly?: boolean } = {}): Promise<Array<Segment & { customers?: number; customersCapped?: boolean }>> {
  const rows = (await q.query<Segment & Row>(`SELECT id, name, description, individual, status, sort_order FROM customer_segments ${o.activeOnly ? `WHERE status='ACTIVE'` : ''} ORDER BY sort_order, name`)).rows;
  if (!o.withCounts) return rows;
  // A bounded count: "1000+" is enough to know a segment is in use, and never scans a huge table.
  return Promise.all(rows.map(async (s) => {
    const n = Number((await q.query(`SELECT count(*) AS n FROM (SELECT 1 FROM customers WHERE segment=$1 LIMIT ${COUNT_CAP + 1}) x`, [s.id])).rows[0]!.n);
    return { ...s, customers: Math.min(n, COUNT_CAP), customersCapped: n > COUNT_CAP };
  }));
}

export async function getSegment(q: Queryable, id: string): Promise<Segment> {
  const r = (await q.query<Segment & Row>('SELECT id, name, description, individual, status, sort_order FROM customer_segments WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('segment', id);
  return r;
}

/** The segment a new customer or a move may use: it must exist and be switched on. */
export async function assertSegmentUsable(q: Queryable, id: string): Promise<Segment> {
  const s = (await q.query<Segment & Row>('SELECT id, name, description, individual, status, sort_order FROM customer_segments WHERE id=$1', [id])).rows[0];
  if (!s) throw invalid(`unknown customer segment ${id}`);
  if (s.status !== 'ACTIVE') throw invalid(`the ${s.name} segment is switched off`);
  return s;
}

const clean = (v: string | undefined | null, max: number, what: string) => {
  const t = v?.trim();
  if (t && t.length > max) throw invalid(`${what} is too long (max ${max} characters)`);
  return t || null;
};

/** A short code from the name ("Small business" → SMALL_BUSINESS), made unique. It is issued once and never changes. */
async function codeFor(q: Queryable, name: string): Promise<string> {
  const base = name.toUpperCase().normalize('NFKD').replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'SEGMENT';
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}_${i}`;
    if (!(await q.query('SELECT 1 FROM customer_segments WHERE id=$1', [id])).rows.length) return id;
  }
  throw conflict('could not issue a segment code');
}

export async function createSegment(q: Queryable, actor: string, i: { name: string; description?: string; individual?: boolean }): Promise<Segment> {
  const name = clean(i.name, 40, 'the name');
  if (!name) throw invalid('a segment needs a name');
  if ((await q.query('SELECT 1 FROM customer_segments WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already a segment called ${name}`);
  const id = await codeFor(q, name);
  const order = Number((await q.query('SELECT COALESCE(max(sort_order),0) + 10 AS n FROM customer_segments')).rows[0]!.n);
  await q.query(`INSERT INTO customer_segments (id, name, description, individual, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, name, clean(i.description, 200, 'the description'), !!i.individual, order, actor]);
  await audit(q, actor, 'customer_segment', id, 'create', { name, individual: !!i.individual });
  return getSegment(q, id);
}

export async function updateSegment(q: Queryable, actor: string, id: string, p: { name?: string; description?: string; individual?: boolean; status?: 'ACTIVE' | 'INACTIVE' }): Promise<Segment> {
  const cur = await getSegment(q, id);
  const name = p.name === undefined ? cur.name : clean(p.name, 40, 'the name');
  if (!name) throw invalid('a segment needs a name');
  if (name.toLowerCase() !== cur.name.toLowerCase() && (await q.query('SELECT 1 FROM customer_segments WHERE lower(name)=lower($1)', [name])).rows.length) throw conflict(`there is already a segment called ${name}`);
  if (p.individual !== undefined && p.individual !== cur.individual && (await q.query('SELECT 1 FROM customers WHERE segment=$1 LIMIT 1', [id])).rows.length)
    throw rejected('customers already belong to this segment, so whether they are individuals cannot change. Create a new segment and move them across instead.');
  if (p.status === 'INACTIVE' && cur.status === 'ACTIVE' && Number((await q.query(`SELECT count(*) AS n FROM customer_segments WHERE status='ACTIVE'`)).rows[0]!.n) <= 1)
    throw rejected('at least one segment must stay switched on');
  await q.query(
    `UPDATE customer_segments SET name=$2, description=$3, individual=$4, status=$5, updated_at=now() WHERE id=$1`,
    [id, name, p.description === undefined ? cur.description : clean(p.description, 200, 'the description'), p.individual ?? cur.individual, p.status ?? cur.status]);
  await audit(q, actor, 'customer_segment', id, 'update', { ...p });
  return getSegment(q, id);
}

/**
 * Moves a customer to another segment. It is a considered change, so a reason is required and both the move and the reason are kept.
 * Moving to an individual segment re-checks that nobody else holds the same ID document and that the customer is not a company with departments.
 */
export async function moveCustomerSegment(q: Queryable, actor: string, customerId: string, toSegment: string, reason: string): Promise<Row> {
  const why = reason?.trim();
  if (!why || why.length < 3) throw invalid('say why the customer is moving (at least a few words)');
  if (why.length > 300) throw invalid('the reason is limited to 300 characters');
  const c = (await q.query('SELECT id, segment, id_document_hash, market_code, parent_customer_id FROM customers WHERE id=$1 FOR UPDATE', [customerId])).rows[0];
  if (!c) throw notFound('customer', customerId);
  if (c.segment === toSegment) throw invalid('the customer is already in that segment');
  const to = await assertSegmentUsable(q, toSegment);
  if (to.individual) {
    const kids = (await q.query('SELECT 1 FROM customers WHERE parent_customer_id=$1 LIMIT 1', [customerId])).rows.length;
    if (kids || c.parentCustomerId) throw rejected('a customer with departments, or a department of another customer, cannot become an individual customer');
    const dup = (await q.query('SELECT id FROM customers WHERE id_document_hash=$1 AND market_code=$2 AND id<>$3 LIMIT 1', [c.idDocumentHash, c.marketCode, customerId])).rows[0];
    if (dup) throw rejected(`another customer already holds this ID document (${dup.id}), so this customer cannot become an individual customer`);
  }
  await q.query('UPDATE customers SET segment=$2, version=version+1, updated_at=now() WHERE id=$1', [customerId, toSegment]);
  await q.query('INSERT INTO customer_segment_changes (customer_id, from_segment, to_segment, reason, changed_by) VALUES ($1,$2,$3,$4,$5)', [customerId, c.segment, toSegment, why, actor]);
  await audit(q, actor, 'customer', customerId, 'segment_change', { from: c.segment, to: toSegment, reason: why });
  return (await q.query('SELECT id, display_name, segment FROM customers WHERE id=$1', [customerId])).rows[0]!;
}

export async function listSegmentChanges(q: Queryable, customerId: string): Promise<Row[]> {
  return (await q.query(
    `SELECT h.id, h.from_segment, h.to_segment, h.reason, h.changed_by, h.changed_at, f.name AS from_name, t.name AS to_name
       FROM customer_segment_changes h LEFT JOIN customer_segments f ON f.id = h.from_segment LEFT JOIN customer_segments t ON t.id = h.to_segment
      WHERE h.customer_id=$1 ORDER BY h.changed_at DESC LIMIT 50`, [customerId])).rows;
}

// ───────────────────────── customer settings ─────────────────────────
export interface CustomerSettings {
  /** Whether the Customers screen may create a customer on its own. Off by default: a customer normally comes into being with their first order. */
  allowCreateWithoutOrder: boolean;
  /** Which details the customer form asks for: hidden, optional or required. */
  fields: CustomerFieldSettings;
}
export const DEFAULT_CUSTOMER_SETTINGS: CustomerSettings = { allowCreateWithoutOrder: false, fields: DEFAULT_CUSTOMER_FIELDS };

export async function getCustomerSettings(q: Queryable): Promise<CustomerSettings> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='customers'`)).rows[0];
  const v = (r?.value ?? {}) as Partial<CustomerSettings>;
  return { allowCreateWithoutOrder: !!v.allowCreateWithoutOrder, fields: normaliseFields(v.fields) };
}

export async function setCustomerSettings(q: Queryable, actor: string, s: { allowCreateWithoutOrder: boolean; fields?: Partial<CustomerFieldSettings> }): Promise<CustomerSettings> {
  const cur = await getCustomerSettings(q);
  const value: CustomerSettings = { allowCreateWithoutOrder: !!s.allowCreateWithoutOrder, fields: s.fields ? normaliseFields({ ...cur.fields, ...s.fields }) : cur.fields };
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('customers', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(value), actor]);
  await audit(q, actor, 'settings', 'customers', 'update', { ...value });
  return value;
}
