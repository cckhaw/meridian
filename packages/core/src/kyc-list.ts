import { hashIdDocument } from './customers.js';
import type { Queryable, Row } from './db.js';
import { invalid } from './errors.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { getRegional } from './settings.js';
import { getStoreSettings } from './store-settings.js';

/** A case is in the queue once it is submitted: a store-front case exists from the first typed detail, a customer case is submitted by definition. */
export const QUEUE_SQL = `(k.application_id IS NULL OR a.status IN ('KYC_REVIEW','ORDERED'))`;
export const CASES_FROM = `kyc_cases k LEFT JOIN applications a ON a.id = k.application_id`;
/** When the case started to wait: the sort key and the start of the review target. */
const SUB = `COALESCE(k.submitted_at, k.created_at)`;

// ───────────────────────── wildcard search ─────────────────────────
/**
 * What a person types in a search box, as a SQL LIKE pattern (use it with ILIKE: the match ignores case). `*` is any run of characters, `?` is exactly one;
 * everything else is literal, including `%`, `_` and a backslash (escaped, so nobody can smuggle SQL wildcards in). With no `*` or `?` the text is looked for anywhere
 * ("contains"); with one, the pattern must match the whole value ("tan*" starts with tan, "*tan" ends with it, "t?n" is three letters). Empty input gives null.
 */
export function wildcardPattern(input: string | null | undefined): string | null {
  const s = (input ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!s) return null;
  let out = '', wild = false, star = false;
  for (const ch of s) {
    if (ch === '*') { wild = true; if (!star) out += '%'; star = true; continue; }
    star = false;
    if (ch === '?') { wild = true; out += '_'; continue; }
    out += ch === '%' || ch === '_' || ch === '\\' ? `\\${ch}` : ch;
  }
  return wild ? out : `%${out}%`;
}

// ───────────────────────── orders waiting ─────────────────────────
/** Orders whose service activation waits on each customer's identity, in one query. */
export async function waitingCounts(q: Queryable, customerIds: Array<string | null | undefined>): Promise<Map<string, number>> {
  const ids = [...new Set(customerIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = (await q.query(
    `SELECT o.customer_id, count(*)::int AS n FROM orders o JOIN order_groups g ON g.order_id = o.id AND g.kind='ACTIVATION' AND g.status='PENDING'
      WHERE o.customer_id = ANY($1::uuid[]) AND o.state NOT IN ('COMPLETED','CANCELLED','FAILED') GROUP BY o.customer_id`, [ids])).rows;
  return new Map(rows.map((r) => [r.customerId as string, r.n as number]));
}

// ───────────────────────── the list ─────────────────────────
export interface KycListFilter {
  status?: string; assignee?: string; q?: string; source?: string; risk?: string; flag?: string; overdue?: boolean; escalated?: boolean; qa?: boolean;
  from?: string; to?: string; sort?: 'priority' | 'oldest' | 'due' | 'newest'; limit?: number; cursor?: string;
  /** The signed-in officer: what `assignee=me` and `qa` mean. */
  me?: string;
}
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED'];
const SOURCES = ['STOREFRONT', 'ASSISTED', 'CRM_ORDER', 'CRM_CUSTOMER'];
const day = (s: string, what: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw invalid(`${what} is a date as YYYY-MM-DD.`); return s; };
const caseNumberOf = (text: string): string | null => { const m = /^(?:kyc-?)?0*(\d{1,9})$/i.exec(text.trim()); return m ? `KYC-${m[1]!.padStart(6, '0')}` : null; };

/**
 * Search inside the already filtered set: name, the masked ID number (its last digits), the case number (`KYC-123` or `123`), the customer's name, phone and e-mail, the
 * officer's username and name, and, while looking at waiting cases, the number of an order that waits on the case. A whole ID number typed exactly is compared by its
 * keyed hash; the decrypted number is never searched.
 */
function searchSql(p: (v: unknown) => string, text: string, status: string | undefined): string | null {
  const pat = wildcardPattern(text);
  if (!pat) return null;
  const n = p(pat);
  const parts = [`k.full_name ILIKE ${n}`, `k.id_number_masked ILIKE ${n}`, `k.case_number ILIKE ${n}`, `k.assigned_to ILIKE ${n}`, `a.personal->>'email' ILIKE ${n}`, `a.personal->>'phone' ILIKE ${n}`,
    `EXISTS (SELECT 1 FROM customers c WHERE c.id = k.customer_id AND (c.display_name ILIKE ${n} OR c.phone ILIKE ${n} OR c.email ILIKE ${n}))`,
    `EXISTS (SELECT 1 FROM users u WHERE lower(u.username) = lower(k.assigned_to) AND u.display_name ILIKE ${n})`];
  const no = caseNumberOf(text); if (no) parts.push(`k.case_number = ${p(no)}`);
  if (!/[*?]/.test(text) && /^[A-Za-z0-9][A-Za-z0-9 -]{3,24}$/.test(text.trim())) parts.push(`k.id_number_hash = ${p(hashIdDocument(text.trim()))}`);
  if (status === 'PENDING') parts.push(`EXISTS (SELECT 1 FROM orders o JOIN order_groups g ON g.order_id = o.id AND g.kind='ACTIVATION' AND g.status='PENDING' WHERE o.customer_id = k.customer_id AND o.number ILIKE ${n})`);
  return `(${parts.join(' OR ')})`;
}

async function whereOf(q: Queryable, f: KycListFilter, p: (v: unknown) => string, sla: number): Promise<string[]> {
  const status = f.status && f.status.toLowerCase() !== 'any' ? f.status.toUpperCase() : undefined;
  if (status && !STATUSES.includes(status)) throw invalid(`The status is one of ${STATUSES.join(', ')}.`);
  if (f.source && !SOURCES.includes(f.source)) throw invalid(`The source is one of ${SOURCES.join(', ')}.`);
  if (f.risk && !['LOW', 'MEDIUM', 'HIGH'].includes(f.risk)) throw invalid('The risk is LOW, MEDIUM or HIGH.');
  const where: string[] = [`(k.status <> 'PENDING' OR ${QUEUE_SQL})`];
  if (status) where.push(`k.status = ${p(status)}`);
  const who = f.assignee?.trim();
  if (who && who !== 'any') {
    if (who === 'me') { if (!f.me) throw invalid('Sign in to see your own cases.'); where.push(`lower(k.assigned_to) = lower(${p(f.me)})`); }
    else if (who === 'unassigned') where.push(`k.assigned_to IS NULL AND k.status = 'PENDING'`);
    else where.push(`lower(k.assigned_to) = lower(${p(who)})`);
  }
  if (f.source) where.push(`k.source = ${p(f.source)}`);
  if (f.risk) where.push(`k.risk = ${p(f.risk)}`);
  if (f.flag) where.push(`${p(f.flag.toUpperCase())} = ANY(k.flags)`);
  if (f.overdue) where.push(`k.status = 'PENDING' AND ${SUB} < now() - make_interval(hours => ${p(sla)}::int)`);
  if (f.escalated) where.push(`k.status = 'PENDING' AND k.escalated_at IS NOT NULL`);
  if (f.qa) { if (!f.me) throw invalid('Sign in to see your quality checks.'); where.push(`lower(k.qa_assigned_to) = lower(${p(f.me)}) AND k.qa_result IS NULL`); }
  if (f.from || f.to) {
    const tz = p((await getRegional(q)).timezone);
    if (f.from) where.push(`${SUB} >= (${p(day(f.from, 'The from date'))}::date)::timestamp AT TIME ZONE ${tz}`);
    if (f.to) where.push(`${SUB} < ((${p(day(f.to, 'The to date'))}::date + 1)::timestamp AT TIME ZONE ${tz})`);
  }
  const s = f.q ? searchSql(p, f.q, status) : null;
  if (s) where.push(s);
  return where;
}

/** Ids of the cases a filter selects, most urgent first, at most `max` + 1 (so the caller can tell there are more). */
export async function listCaseIds(q: Queryable, f: KycListFilter, max: number): Promise<string[]> {
  const { params, p } = sqlBuilder();
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const where = await whereOf(q, f, p, sla);
  return (await q.query(`SELECT k.id FROM ${CASES_FROM} WHERE ${where.join(' AND ')} ORDER BY k.priority DESC, ${SUB}, k.id LIMIT ${p(max + 1)}`, params)).rows.map((r) => r.id as string);
}

/**
 * The review list, for waiting and decided cases alike. Sorts: `priority` (overdue, escalated, risk, then oldest; the default for waiting cases), `oldest` and `due`
 * (the review target is a fixed time after submission, so both are oldest first), `newest` (by decision, else submission; the default for decided cases). Paging is
 * by keyset on the chosen sort, so every page costs the same. A search with a status of "any" reads every case: it is a sequential scan with ILIKE (tens of thousands
 * of cases answer in well under a second); narrow by status, assignee or dates to keep it fast on a very large history.
 */
export async function listKycCases(q: Queryable, f: KycListFilter = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 50, 100);
  const { params, p } = sqlBuilder();
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const where = await whereOf(q, f, p, sla);
  const sort = f.sort ?? (f.status?.toUpperCase() === 'PENDING' ? 'priority' : 'newest');
  if (!['priority', 'oldest', 'due', 'newest'].includes(sort)) throw invalid('The sort is priority, oldest, due or newest.');
  const ord = `COALESCE(k.decided_at, ${SUB})`;
  let order: string, key: string;
  if (sort === 'priority') {
    order = `k.priority DESC, ${SUB}, k.id`; key = SUB;
    const c = decodeCursor(f.cursor, 3);
    if (c) where.push(`(k.priority < ${p(c[0])}::int OR (k.priority = ${p(c[0])}::int AND (${SUB}, k.id) > (${p(c[1])}::timestamptz, ${p(c[2])}::uuid)))`);
  } else if (sort === 'newest') {
    order = `${ord} DESC, k.id DESC`; key = ord;
    const c = decodeCursor(f.cursor, 2);
    if (c) where.push(`(${ord}, k.id) < (${p(c[0])}::timestamptz, ${p(c[1])}::uuid)`);
  } else {
    order = `${SUB}, k.id`; key = SUB;
    const c = decodeCursor(f.cursor, 2);
    if (c) where.push(`(${SUB}, k.id) > (${p(c[0])}::timestamptz, ${p(c[1])}::uuid)`);
  }
  const rows = (await q.query(
    `SELECT k.id, k.case_number, k.application_id, k.customer_id, k.method, k.source, k.status, k.full_name, k.id_type, k.id_number_masked, k.flags, k.risk, k.priority, k.created_at, k.submitted_at,
            ${SUB} + make_interval(hours => ${p(sla)}::int) AS due_at, (k.status = 'PENDING' AND ${SUB} < now() - make_interval(hours => ${p(sla)}::int)) AS overdue,
            k.assigned_to, k.assigned_at, k.assignment_source, (k.escalated_at IS NOT NULL) AS escalated, k.decided_by, k.decided_at, k.reason_code, k.qa_assigned_to, k.qa_result,
            k.second_review->>'status' AS second_review_status, COALESCE(a.channel, 'RETAIL_ASSISTED') AS channel, a.status AS application_status, ${key}::text AS cursor_ts
       FROM ${CASES_FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${p(limit + 1)}`, params)).rows;
  const page = toPage(rows as Array<Row & { id: string; cursorTs: string; priority: number }>, limit, (r) => (sort === 'priority' ? [r.priority, r.cursorTs, r.id] : [r.cursorTs, r.id]));
  const names = await displayNames(q, page.items.map((r) => r.assignedTo).filter(Boolean));
  const waiting = await waitingCounts(q, page.items.filter((r) => r.status === 'PENDING').map((r) => r.customerId));
  return { items: page.items.map(({ cursorTs: _t, ...r }) => ({ ...r, assignedToName: r.assignedTo ? names.get(String(r.assignedTo).toLowerCase()) ?? r.assignedTo : null, waitingOrders: waiting.get(r.customerId) ?? 0 })), nextCursor: page.nextCursor };
}

/** Display names by lower-case username. */
export async function displayNames(q: Queryable, usernames: string[]): Promise<Map<string, string>> {
  const u = [...new Set(usernames.map((x) => x.toLowerCase()))];
  if (!u.length) return new Map();
  return new Map((await q.query(`SELECT lower(username) AS u, display_name FROM users WHERE lower(username) = ANY($1::text[])`, [u])).rows.map((r) => [r.u as string, r.displayName as string]));
}

// ───────────────────────── counts ─────────────────────────
/** How many tasks wait, and how many are overdue: the number on the menu. */
export async function kycQueueCounts(q: Queryable): Promise<{ waiting: number; overdue: number }> {
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const r = (await q.query(
    `SELECT count(*)::int AS waiting, count(*) FILTER (WHERE ${SUB} < now() - make_interval(hours => $1::int))::int AS overdue FROM ${CASES_FROM} WHERE k.status='PENDING' AND ${QUEUE_SQL}`, [sla])).rows[0]!;
  return { waiting: r.waiting, overdue: r.overdue };
}

export interface KycSummary { waiting: number; overdue: number; unassigned: number; mine: number; mineOverdue: number; escalated: number; awaitingSecondReview: number; decidedToday: number; qaTasks: number }
/** The numbers on the review screen: the whole queue and the signed-in officer's share of it. */
export async function kycSummary(q: Queryable, me: string): Promise<KycSummary> {
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const tz = (await getRegional(q)).timezone;
  const r = (await q.query(
    `SELECT count(*)::int AS waiting, count(*) FILTER (WHERE ${SUB} < now() - make_interval(hours => $1::int))::int AS overdue,
            count(*) FILTER (WHERE k.assigned_to IS NULL)::int AS unassigned, count(*) FILTER (WHERE lower(k.assigned_to) = lower($2))::int AS mine,
            count(*) FILTER (WHERE lower(k.assigned_to) = lower($2) AND ${SUB} < now() - make_interval(hours => $1::int))::int AS mine_overdue,
            count(*) FILTER (WHERE k.escalated_at IS NOT NULL)::int AS escalated, count(*) FILTER (WHERE k.second_review->>'status' = 'AWAITING')::int AS awaiting_second_review
       FROM ${CASES_FROM} WHERE k.status='PENDING' AND ${QUEUE_SQL}`, [sla, me])).rows[0]!;
  const today = (await q.query(
    `SELECT count(*)::int AS n FROM kyc_case_events WHERE actor = $1 AND action IN ('DECIDED','RETURNED') AND detail->>'auto' IS DISTINCT FROM 'true'
        AND at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2`, [me, tz])).rows[0]!;
  const qa = (await q.query(`SELECT count(*)::int AS n FROM kyc_cases WHERE lower(qa_assigned_to) = lower($1) AND qa_result IS NULL`, [me])).rows[0]!;
  return { waiting: r.waiting, overdue: r.overdue, unassigned: r.unassigned, mine: r.mine, mineOverdue: r.mineOverdue, escalated: r.escalated, awaitingSecondReview: r.awaitingSecondReview, decidedToday: today.n, qaTasks: qa.n };
}
