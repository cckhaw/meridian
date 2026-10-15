import { audit } from './audit.js';
import { billAccount, draftCycleBill, priceDraft, streamOfLine } from './billing.js';
import { addDays, dayOf, today, type DateStr } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, invalid, notFound, rejected } from './errors.js';
import { decodeCursor, encodeCursor, pageSize, type Page } from './paging.js';

/**
 * Governed bill runs. Billing a cycle is four steps, and none can be skipped:
 *   1. MOCK      every account is priced as if it were being billed, and nothing is written to the ledger or sent to anyone;
 *   2. REVIEW    a billing administrator reads the totals and the accounts that look wrong (a bill four times last month's, a bill of nothing);
 *   3. EXCLUDE   accounts, or a whole enterprise customer with every department, can be kept out (a legal dispute, a fraud case), or the run
 *                can be limited to chosen accounts;
 *   4. APPROVE   and only then PRODUCTION: the invoices are issued, the journals posted to the sub-ledger, and customers told. With dual control
 *                the person who approves must not be the person who asked for the run.
 * A run is a list of items (one per account) that both passes walk in account order, in short slices that save their place (like the data
 * migration jobs), so a run of millions of accounts is never one long request and can be picked up by any server.
 */
export interface BillRunSettings {
  /** Bill cycles must go through a governed run. When off, the plain "run this date" call is allowed too. */
  enforceGovernance: boolean;
  /** A second person must approve. Each cycle can override this. */
  dualControl: boolean;
  /** A bill this many percent above the account's previous one is flagged. */
  spikePercent: number;
  /** A bill this many percent below the previous one is flagged. */
  dropPercent: number;
  /** A bill at or above this amount (minor units) is flagged; 0 turns it off. */
  largeMinor: number;
  /** An approval is refused when the mock is older than this: the data may have changed. */
  maxMockAgeHours: number;
}
export const DEFAULT_BILL_RUN_SETTINGS: BillRunSettings = { enforceGovernance: true, dualControl: false, spikePercent: 300, dropPercent: 70, largeMinor: 0, maxMockAgeHours: 24 };

export async function getBillRunSettings(q: Queryable): Promise<BillRunSettings> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='billRuns'`)).rows[0]?.value as Partial<BillRunSettings> | undefined;
  return { ...DEFAULT_BILL_RUN_SETTINGS, ...(r ?? {}) };
}
export async function setBillRunSettings(q: Queryable, actor: string, s: BillRunSettings): Promise<BillRunSettings> {
  const num = (v: unknown, name: string, min: number, max: number) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw invalid(`${name} must be a number from ${min} to ${max}.`); return v; };
  const v: BillRunSettings = {
    enforceGovernance: !!s.enforceGovernance, dualControl: !!s.dualControl, spikePercent: num(s.spikePercent, 'The spike limit', 1, 100000), dropPercent: num(s.dropPercent, 'The drop limit', 1, 100),
    largeMinor: Math.round(num(s.largeMinor, 'The large-bill limit', 0, 1e12)), maxMockAgeHours: num(s.maxMockAgeHours, 'The mock age limit', 1, 24 * 30),
  };
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('billRuns', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(v), actor]);
  await audit(q, actor, 'settings', 'billRuns', 'update', { ...v });
  return v;
}

export async function listCycleConfigs(q: Queryable): Promise<Row[]> {
  return (await q.query(`SELECT c.*, (SELECT max(as_of)::text FROM bill_runs r WHERE r.cycle_day = c.cycle_day AND r.status = 'COMPLETED') AS last_billed,
      (SELECT id FROM bill_runs r WHERE r.cycle_day = c.cycle_day AND r.status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at DESC LIMIT 1) AS open_run_id,
      (SELECT status FROM bill_runs r WHERE r.cycle_day = c.cycle_day AND r.status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at DESC LIMIT 1) AS open_run_status
      FROM bill_cycle_configs c ORDER BY cycle_day`)).rows;
}
export async function updateCycleConfig(q: Queryable, actor: string, day: number, p: { label?: string; enabled?: boolean; dualControl?: boolean | null; notes?: string }): Promise<Row> {
  if (!Number.isInteger(day) || day < 1 || day > 28) throw invalid('A bill cycle day is 1 to 28.');
  const cur = (await q.query('SELECT * FROM bill_cycle_configs WHERE cycle_day=$1', [day])).rows[0];
  if (!cur) throw notFound('bill cycle', String(day));
  const label = (p.label ?? cur.label).trim().slice(0, 60);
  await q.query(`UPDATE bill_cycle_configs SET label=$2, enabled=$3, dual_control=$4, notes=$5, updated_by=$6, updated_at=now() WHERE cycle_day=$1`,
    [day, label, p.enabled ?? cur.enabled, p.dualControl === undefined ? cur.dualControl : p.dualControl, (p.notes ?? cur.notes).slice(0, 500), actor]);
  await audit(q, actor, 'settings', `billCycle:${day}`, 'update', { ...p });
  return (await q.query('SELECT * FROM bill_cycle_configs WHERE cycle_day=$1', [day])).rows[0]!;
}

// ───────────────────────── creating a run ─────────────────────────
export interface NewBillRun { cycleDay?: number; daily?: boolean; accountIds?: string[]; asOf?: DateStr; note?: string }
export const SELECTIVE_MAX = 10_000;
const OPEN = ['MOCK_RUNNING', 'MOCK_COMPLETED', 'PENDING_APPROVAL', 'APPROVED', 'PRODUCTION_RUNNING'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The next date on or after `from` that falls on day `d` of a month. */
function nextBillDate(d: number, from: DateStr): DateStr {
  for (let i = 0; i < 40; i++) { const x = addDays(from, i); if (dayOf(x) === d) return x; }
  return from;
}

export async function createBillRun(db: Db, actor: string, i: NewBillRun): Promise<Row> {
  const modes = [i.cycleDay !== undefined, !!i.daily, !!i.accountIds].filter(Boolean).length;
  if (modes !== 1) throw invalid('Choose one: a cycle day, the daily cycle, or specific accounts.');
  const kind = i.accountIds ? 'SELECTIVE' : i.daily ? 'DAILY' : 'CYCLE';
  let cycleDay: number | null = null;
  if (kind === 'CYCLE') {
    cycleDay = i.cycleDay!;
    if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 28) throw invalid('A bill cycle day is 1 to 28.');
    const cfg = (await db.query('SELECT enabled FROM bill_cycle_configs WHERE cycle_day=$1', [cycleDay])).rows[0];
    if (!cfg?.enabled) throw rejected(`Bill cycle ${cycleDay} is switched off.`);
  }
  const asOf = i.asOf ?? (kind === 'CYCLE' ? nextBillDate(cycleDay!, today()) : today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw invalid('The bill date is YYYY-MM-DD.');
  if (kind === 'CYCLE' && dayOf(asOf) !== cycleDay) throw invalid(`${asOf} is not the ${cycleDay}${[, 'st', 'nd', 'rd'][cycleDay! % 10 > 3 || [11, 12, 13].includes(cycleDay!) ? 0 : cycleDay! % 10] ?? 'th'} of a month: bill cycle ${cycleDay} bills on that day.`);
  let ids: string[] = [];
  if (kind === 'SELECTIVE') {
    ids = [...new Set((i.accountIds ?? []).map((x) => String(x).trim().toLowerCase()))];
    if (!ids.length) throw invalid('Give at least one account.');
    if (ids.length > SELECTIVE_MAX) throw invalid(`A selective run takes at most ${SELECTIVE_MAX} accounts. Run the cycle instead.`);
    if (ids.some((x) => !UUID.test(x))) throw invalid('Accounts are given by their id.');
  }
  const dup = (await db.query(
    `SELECT id, status FROM bill_runs WHERE kind=$1 AND as_of=$2 AND cycle_day IS NOT DISTINCT FROM $3 AND status NOT IN ('FAILED','CANCELLED') AND kind <> 'SELECTIVE' LIMIT 1`, [kind, asOf, cycleDay])).rows[0];
  if (dup) throw conflict(dup.status === 'COMPLETED' ? `This cycle was already billed for ${asOf}. Use a selective run for single accounts.` : `There is already a run for this cycle and date (${dup.status.toLowerCase().replace(/_/g, ' ')}). Open it, or cancel it first.`);

  return db.tx(async (q) => {
    const run = (await q.query(
      `INSERT INTO bill_runs (kind, cycle_day, as_of, status, options, note, requested_by, stage, started_at) VALUES ($1,$2,$3,'MOCK_RUNNING',$4,$5,$6,'Listing the accounts', now()) RETURNING *`,
      [kind, cycleDay, asOf, JSON.stringify(kind === 'SELECTIVE' ? { selective: true } : {}), i.note?.slice(0, 500) ?? null, actor])).rows[0]!;
    if (kind === 'SELECTIVE') await q.query(`INSERT INTO bill_run_items (run_id, account_id, customer_id) SELECT $1, id, customer_id FROM accounts WHERE id = ANY($2::uuid[]) AND status='ACTIVE'`, [run.id, ids]);
    else await q.query(`INSERT INTO bill_run_items (run_id, account_id, customer_id) SELECT $1, id, customer_id FROM accounts WHERE status='ACTIVE' AND ${kind === 'DAILY' ? 'bill_cycle_day IS NULL' : 'bill_cycle_day = $2'}`, kind === 'DAILY' ? [run.id] : [run.id, cycleDay]);
    const total = Number((await q.query('SELECT count(*) AS n FROM bill_run_items WHERE run_id=$1', [run.id])).rows[0]!.n);
    const missing = kind === 'SELECTIVE' ? ids.length - total : 0;
    await q.query('UPDATE bill_runs SET accounts_total=$2, summary = summary || $3::jsonb, stage=$4 WHERE id=$1', [run.id, total, JSON.stringify(missing ? { warnings: [`${missing} of the accounts given are not active accounts and were left out.`] } : {}), 'Pricing the accounts (mock)']);
    await applyExclusions(q, run.id);
    await audit(q, actor, 'billing', run.id, 'BILL_RUN_CREATED', { kind, cycleDay, asOf, accounts: total });
    return getBillRun(q, run.id);
  });
}

export async function getBillRun(q: Queryable, id: string): Promise<Row> {
  const r = UUID.test(id) ? (await q.query('SELECT * FROM bill_runs WHERE id=$1', [id])).rows[0] : null;
  if (!r) throw notFound('bill run', id);
  const counts = (await q.query(`SELECT status, count(*) AS n FROM bill_run_items WHERE run_id=$1 GROUP BY status`, [id])).rows;
  const anomalies = (await q.query(`SELECT a, count(*) AS n FROM (SELECT unnest(anomalies) AS a FROM bill_run_items WHERE run_id=$1 AND cardinality(anomalies) > 0) x GROUP BY a ORDER BY a`, [id])).rows;
  const settings = await getBillRunSettings(q);
  return { ...r, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), anomalyCounts: Object.fromEntries(anomalies.map((c) => [c.a, Number(c.n)])), dualControl: await needsDualControl(q, r, settings) };
}

export async function listBillRuns(q: Queryable, f: { status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 20, 100);
  const cur = decodeCursor(f.cursor, 2);
  const rows = (await q.query(
    `SELECT *, created_at::text AS cursor_ts FROM bill_runs WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid)) ORDER BY created_at DESC, id DESC LIMIT $4`,
    [f.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1])).rows;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(({ cursorTs: _t, ...r }) => r), nextCursor: rows.length > limit && last ? encodeCursor([last.cursorTs, last.id]) : null };
}

export async function listBillRunItems(q: Queryable, runId: string, f: { status?: string; anomaly?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 25, 100);
  const cur = decodeCursor(f.cursor, 1);
  const term = (f.q ?? '').trim().toLowerCase();
  const rows = (await q.query(
    `SELECT i.*, c.display_name AS customer_name, a.name AS account_name FROM bill_run_items i JOIN customers c ON c.id = i.customer_id JOIN accounts a ON a.id = i.account_id
      WHERE i.run_id=$1 AND ($2::text IS NULL OR i.status=$2)
        AND ($3::text IS NULL OR ($3 = 'ANY' AND cardinality(i.anomalies) > 0) OR $3 = ANY(i.anomalies))
        AND ($4::text IS NULL OR i.account_id::text = $4 OR i.customer_id::text = $4 OR lower(c.display_name) LIKE $5)
        AND ($6::uuid IS NULL OR i.account_id > $6::uuid)
      ORDER BY i.account_id LIMIT $7`,
    [runId, f.status ?? null, f.anomaly ?? null, term || null, `${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, cur?.[0] ?? null, limit + 1])).rows;
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? encodeCursor([page[page.length - 1]!.accountId]) : null };
}

/** What one account's bill would hold, line by line, worked out now (the run keeps only totals), with its recent bills for comparison. */
export async function previewRunAccount(db: Db, runId: string, accountId: string): Promise<Row> {
  const run = await getBillRun(db, runId);
  const item = (await db.query('SELECT * FROM bill_run_items WHERE run_id=$1 AND account_id=$2', [runId, accountId])).rows[0];
  if (!item) throw notFound('account in this run', accountId);
  const a = (await db.query('SELECT * FROM accounts WHERE id=$1', [accountId])).rows[0]!;
  const d = await draftCycleBill(db, a, run.asOf);
  const p = await priceDraft(db, a, d.lines);
  const history = (await db.query(`SELECT number, issue_date::text AS issue_date, total_minor, status FROM invoices WHERE account_id=$1 ORDER BY issue_date DESC LIMIT 6`, [accountId])).rows;
  return { item, exists: d.exists, periodStart: d.periodStart, periodEnd: d.periodEnd, currency: a.currency, netMinor: p.net, taxMinor: p.tax, taxName: p.mk.taxName, taxBps: p.mk.taxBps,
    lines: p.priced.map((l) => ({ kind: l.kind, stream: streamOfLine(l), description: l.description, netMinor: l.net, taxMinor: l.tax })), history };
}

// ───────────────────────── exclusions ─────────────────────────
export interface NewExclusion { accountId?: string; customerId?: string; runId?: string; reason: string; untilDate?: string }

export async function listExclusions(q: Queryable, f: { runId?: string } = {}): Promise<Row[]> {
  return (await q.query(
    `SELECT e.*, a.name AS account_name, c.display_name AS customer_name, (SELECT count(*) FROM bill_run_items i WHERE i.exclusion_id = e.id) AS items_held
       FROM bill_run_exclusions e LEFT JOIN accounts a ON a.id = e.account_id LEFT JOIN customers c ON c.id = COALESCE(e.customer_id, a.customer_id)
      WHERE e.removed_at IS NULL AND ($1::uuid IS NULL OR e.run_id IS NULL OR e.run_id = $1::uuid) ORDER BY e.created_at DESC LIMIT 500`, [f.runId ?? null])).rows;
}

export async function addExclusion(db: Db, actor: string, x: NewExclusion): Promise<Row> {
  if (!!x.accountId === !!x.customerId) throw invalid('Exclude an account, or a customer (with every department below it), not both.');
  if (!x.reason?.trim() || x.reason.trim().length < 5) throw invalid('Say why (at least 5 characters): it goes in the audit log.');
  if (x.untilDate && !/^\d{4}-\d{2}-\d{2}$/.test(x.untilDate)) throw invalid('The end date is YYYY-MM-DD.');
  const target = x.accountId ?? x.customerId!;
  if (!UUID.test(target)) throw invalid('Give the account or customer id.');
  if (x.accountId && !(await db.query('SELECT 1 FROM accounts WHERE id=$1', [x.accountId])).rows.length) throw notFound('account', x.accountId);
  if (x.customerId && !(await db.query('SELECT 1 FROM customers WHERE id=$1', [x.customerId])).rows.length) throw notFound('customer', x.customerId);
  if (x.runId) {
    const r = await getBillRun(db, x.runId);
    if (!['MOCK_COMPLETED'].includes(r.status)) throw rejected('Accounts can be excluded from a run while its mock is complete and under review.');
  }
  return db.tx(async (q) => {
    const e = (await q.query(
      `INSERT INTO bill_run_exclusions (scope, account_id, customer_id, run_id, reason, until_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [x.accountId ? 'ACCOUNT' : 'CUSTOMER_NODE', x.accountId ?? null, x.customerId ?? null, x.runId ?? null, x.reason.trim(), x.untilDate ?? null, actor])).rows[0]!;
    const runs = x.runId ? [x.runId] : (await q.query(`SELECT id FROM bill_runs WHERE status = 'MOCK_COMPLETED' OR status = 'MOCK_RUNNING'`)).rows.map((r) => r.id as string);
    for (const id of runs) { await applyExclusions(q, id); await recomputeTotals(q, id); }
    await audit(q, actor, 'billing', String(e.id), 'BILL_EXCLUSION_ADDED', { scope: e.scope, target, runId: x.runId ?? null, reason: x.reason.trim() });
    return e;
  });
}

export async function removeExclusion(db: Db, actor: string, id: number): Promise<void> {
  const e = (await db.query('SELECT * FROM bill_run_exclusions WHERE id=$1 AND removed_at IS NULL', [id])).rows[0];
  if (!e) throw notFound('exclusion', String(id));
  await db.tx(async (q) => {
    await q.query('UPDATE bill_run_exclusions SET removed_at=now(), removed_by=$2 WHERE id=$1', [id, actor]);
    // What it was holding goes back to be priced, in runs still under review. A run already approved keeps what was approved.
    const back = (await q.query(
      `UPDATE bill_run_items i SET status='PENDING', excluded_reason=NULL, exclusion_id=NULL FROM bill_runs r WHERE i.exclusion_id=$1 AND r.id=i.run_id AND r.status IN ('MOCK_RUNNING','MOCK_COMPLETED') RETURNING i.run_id`, [id])).rows;
    for (const runId of new Set(back.map((r) => r.runId as string))) {
      await applyExclusions(q, runId); // another exclusion may still apply
      await q.query(`UPDATE bill_runs SET status='MOCK_RUNNING', stage='Pricing the accounts that came back', mock_finished_at=NULL, updated_at=now() WHERE id=$1 AND status='MOCK_COMPLETED'`, [runId]);
    }
    await audit(q, actor, 'billing', String(id), 'BILL_EXCLUSION_REMOVED', { scope: e.scope });
  });
}

/** Marks the items every active exclusion covers (standing ones, and those of this run) as excluded. */
async function applyExclusions(q: Queryable, runId: string): Promise<void> {
  const run = (await q.query('SELECT as_of::text AS as_of FROM bill_runs WHERE id=$1', [runId])).rows[0]!;
  const ex = (await q.query(
    `SELECT * FROM bill_run_exclusions WHERE removed_at IS NULL AND (run_id IS NULL OR run_id=$1) AND (until_date IS NULL OR until_date >= $2::date) ORDER BY id`, [runId, run.asOf])).rows;
  for (const e of ex) {
    if (e.scope === 'ACCOUNT') {
      await q.query(`UPDATE bill_run_items SET status='EXCLUDED', excluded_reason=$3, exclusion_id=$4 WHERE run_id=$1 AND account_id=$2 AND status IN ('PENDING','MOCKED','NO_INVOICE')`, [runId, e.accountId, e.reason, e.id]);
    } else {
      await q.query(
        `UPDATE bill_run_items SET status='EXCLUDED', excluded_reason=$3, exclusion_id=$4 WHERE run_id=$1 AND status IN ('PENDING','MOCKED','NO_INVOICE')
           AND customer_id IN (SELECT c.id FROM customers c WHERE c.hierarchy_path <@ (SELECT hierarchy_path FROM customers WHERE id=$2 LIMIT 1))`, [runId, e.customerId, e.reason, e.id]);
    }
  }
}

/** The run's totals, from its items. */
async function recomputeTotals(q: Queryable, runId: string): Promise<void> {
  await q.query(
    `UPDATE bill_runs r SET mock_net_minor = t.net, mock_tax_minor = t.tax, mock_total_minor = t.total, updated_at=now()
       FROM (SELECT COALESCE(sum(net_minor),0) AS net, COALESCE(sum(tax_minor),0) AS tax, COALESCE(sum(total_minor),0) AS total FROM bill_run_items WHERE run_id=$1 AND status='MOCKED') t WHERE r.id=$1`, [runId]);
}

/** Take a chosen account back into a run under review: it is priced again straight away. */
export async function includeAccounts(db: Db, actor: string, runId: string, accountIds: string[]): Promise<Row> {
  const run = await getBillRun(db, runId);
  if (run.status !== 'MOCK_COMPLETED') throw rejected('Accounts can be put back while the mock is complete and under review.');
  if (!accountIds.length || accountIds.some((a) => !UUID.test(a))) throw invalid('Give the account ids.');
  const held = (await db.query(`SELECT account_id, exclusion_id FROM bill_run_items WHERE run_id=$1 AND account_id = ANY($2::uuid[]) AND status='EXCLUDED'`, [runId, accountIds])).rows;
  if (!held.length) throw invalid('None of these accounts is excluded from this run.');
  const standing = (await db.query(`SELECT id FROM bill_run_exclusions WHERE id = ANY($1::bigint[]) AND removed_at IS NULL AND run_id IS NULL`, [held.map((h) => h.exclusionId).filter(Boolean)])).rows;
  if (standing.length) throw rejected('A standing exclusion keeps some of these out of every run. Lift that exclusion (Exclusions list), or exclude them from this run only.');
  await db.tx(async (q) => {
    await q.query(`UPDATE bill_run_items SET status='PENDING', excluded_reason=NULL, exclusion_id=NULL WHERE run_id=$1 AND account_id = ANY($2::uuid[]) AND status='EXCLUDED'`, [runId, held.map((h) => h.accountId)]);
    await q.query(`UPDATE bill_run_exclusions SET removed_at=now(), removed_by=$3 WHERE run_id=$1 AND scope='ACCOUNT' AND account_id = ANY($2::uuid[]) AND removed_at IS NULL`, [runId, held.map((h) => h.accountId), actor]);
    await q.query(`UPDATE bill_runs SET status='MOCK_RUNNING', stage='Pricing the accounts that came back', mock_finished_at=NULL, updated_at=now() WHERE id=$1`, [runId]);
    await audit(q, actor, 'billing', runId, 'BILL_RUN_INCLUDED', { accounts: held.length });
  });
  return getBillRun(db, runId);
}

// ───────────────────────── governance transitions ─────────────────────────
async function needsDualControl(q: Queryable, run: Row, settings?: BillRunSettings): Promise<boolean> {
  const s = settings ?? (await getBillRunSettings(q));
  if (run.cycleDay) {
    const c = (await q.query('SELECT dual_control FROM bill_cycle_configs WHERE cycle_day=$1', [run.cycleDay])).rows[0];
    if (c && c.dualControl !== null) return c.dualControl;
  }
  return s.dualControl;
}
const assertStatus = (run: Row, ...ok: string[]) => { if (!ok.includes(run.status)) throw rejected(`This run is ${run.status.toLowerCase().replace(/_/g, ' ')}; that is not possible now.`); };

/** Start the mock again (after data was fixed): every account not excluded is priced afresh. */
export async function remock(db: Db, actor: string, runId: string): Promise<Row> {
  const run = await getBillRun(db, runId);
  assertStatus(run, 'MOCK_COMPLETED', 'PENDING_APPROVAL');
  await db.tx(async (q) => {
    await q.query(`UPDATE bill_run_items SET status='PENDING', anomalies='{}', net_minor=0, tax_minor=0, total_minor=0, line_count=0, error=NULL WHERE run_id=$1 AND status IN ('MOCKED','NO_INVOICE','FAILED','SKIPPED')`, [runId]);
    await q.query(`UPDATE bill_runs SET status='MOCK_RUNNING', stage='Pricing the accounts (mock)', mock_finished_at=NULL, submitted_by=NULL, submitted_at=NULL, percent=0, summary = (summary - 'byStream' - 'byMarket'), mock_net_minor=0, mock_tax_minor=0, mock_total_minor=0, updated_at=now() WHERE id=$1`, [runId]);
    await audit(q, actor, 'billing', runId, 'BILL_RUN_REMOCK', {});
  });
  return getBillRun(db, runId);
}

export async function submitForApproval(db: Db, actor: string, runId: string, note?: string): Promise<Row> {
  const run = await getBillRun(db, runId);
  assertStatus(run, 'MOCK_COMPLETED');
  await db.query(`UPDATE bill_runs SET status='PENDING_APPROVAL', submitted_by=$2, submitted_at=now(), note=COALESCE($3, note), stage='Waiting for approval', updated_at=now() WHERE id=$1`, [runId, actor, note?.slice(0, 500) ?? null]);
  await audit(db, actor, 'billing', runId, 'BILL_RUN_SUBMITTED', { note: note ?? null });
  return getBillRun(db, runId);
}

export async function rejectBillRun(db: Db, actor: string, runId: string, note: string): Promise<Row> {
  const run = await getBillRun(db, runId);
  assertStatus(run, 'PENDING_APPROVAL');
  if (!note?.trim()) throw invalid('Say what needs another look.');
  await db.query(`UPDATE bill_runs SET status='MOCK_COMPLETED', approval_note=$2, stage='Sent back for review', submitted_by=NULL, submitted_at=NULL, updated_at=now() WHERE id=$1`, [runId, `${actor}: ${note.trim().slice(0, 400)}`]);
  await audit(db, actor, 'billing', runId, 'BILL_RUN_REJECTED', { note });
  return getBillRun(db, runId);
}

/** Approves a run. With dual control the approver must be someone other than the person who asked for the run and the person who submitted it. */
export async function approveBillRun(db: Db, actor: string, runId: string, o: { note?: string; execute?: boolean } = {}): Promise<Row> {
  const run = await getBillRun(db, runId);
  const dual = run.dualControl as boolean;
  if (dual && run.status === 'MOCK_COMPLETED') throw rejected('This run needs a second person to approve it: submit it for approval first.');
  assertStatus(run, 'MOCK_COMPLETED', 'PENDING_APPROVAL');
  if (dual && (actor === run.requestedBy || actor === run.submittedBy)) throw rejected('This run needs a second person: it cannot be approved by the person who asked for it or submitted it.');
  const settings = await getBillRunSettings(db);
  const age = (Date.now() - new Date(run.mockFinishedAt).getTime()) / 3_600_000;
  if (!run.mockFinishedAt || age > settings.maxMockAgeHours) throw rejected(`The mock is ${Math.round(age)} hours old (the limit is ${settings.maxMockAgeHours}). Run the mock again so what is billed is what was reviewed.`);
  if ((run.counts?.PENDING ?? 0) > 0) throw rejected('Some accounts have not been priced yet.');
  const mocked = run.counts?.MOCKED ?? 0;
  if (!mocked) throw rejected('There is nothing to bill: every account is excluded, or has no charges.');
  await db.query(`UPDATE bill_runs SET status='APPROVED', approved_by=$2, approved_at=now(), approval_note=COALESCE($3, approval_note), stage='Approved: ready to bill', updated_at=now() WHERE id=$1`, [runId, actor, o.note?.slice(0, 400) ?? null]);
  await audit(db, actor, 'billing', runId, 'BILL_RUN_APPROVED', { accounts: mocked, totalMinor: run.mockTotalMinor, dual, note: o.note ?? null });
  return o.execute ? executeBillRun(db, actor, runId) : getBillRun(db, runId);
}

/** Starts production billing of an approved run. The exclusions are applied once more first: one added since the mock still holds. */
export async function executeBillRun(db: Db, actor: string, runId: string): Promise<Row> {
  const run = await getBillRun(db, runId);
  assertStatus(run, 'APPROVED');
  await db.tx(async (q) => {
    await applyExclusions(q, runId);
    await q.query(`UPDATE bill_runs SET status='PRODUCTION_RUNNING', stage='Issuing the invoices', percent=0, started_at=COALESCE(started_at, now()), updated_at=now(), summary = summary || '{"productionStarted":true}'::jsonb WHERE id=$1`, [runId]);
    await audit(q, actor, 'billing', runId, 'BILL_RUN_EXECUTE', {});
  });
  return getBillRun(db, runId);
}

export async function cancelBillRun(db: Db, actor: string, runId: string, note?: string): Promise<Row> {
  const run = await getBillRun(db, runId);
  assertStatus(run, 'MOCK_RUNNING', 'MOCK_COMPLETED', 'PENDING_APPROVAL', 'APPROVED');
  await db.query(`UPDATE bill_runs SET status='CANCELLED', stage='Cancelled', finished_at=now(), approval_note=COALESCE($2, approval_note), updated_at=now() WHERE id=$1`, [runId, note?.slice(0, 400) ?? null]);
  await audit(db, actor, 'billing', runId, 'BILL_RUN_CANCELLED', { note: note ?? null });
  return getBillRun(db, runId);
}

/** Bills again only the accounts that failed in a completed run: no sweep of the cycle. */
export async function retryFailedItems(db: Db, actor: string, runId: string, accountIds?: string[]): Promise<Row> {
  const run = await getBillRun(db, runId);
  assertStatus(run, 'COMPLETED');
  const n = (await db.query(
    `UPDATE bill_run_items SET status='MOCKED', error=NULL WHERE run_id=$1 AND status='FAILED' AND ($2::uuid[] IS NULL OR account_id = ANY($2::uuid[]))`, [runId, accountIds?.length ? accountIds : null])).rowCount;
  if (!n) throw rejected('No account failed in this run.');
  await db.query(`UPDATE bill_runs SET status='PRODUCTION_RUNNING', stage='Billing the accounts that failed', finished_at=NULL, percent=0, updated_at=now() WHERE id=$1`, [runId]);
  await audit(db, actor, 'billing', runId, 'BILL_RUN_RETRY', { accounts: n });
  return getBillRun(db, runId);
}

// ───────────────────────── the slice ─────────────────────────
export const BILL_SLICE_MS = 20_000;
const MOCK_BATCH = 100;
const PROD_BATCH = 25;
const ACTIVE = ['MOCK_RUNNING', 'PRODUCTION_RUNNING'];
export interface BillSlice { run: Row; busy?: boolean }

/** Works on a run for about `budgetMs` and says where it is. Safe to call again from anywhere; only one caller works on a run at a time. */
export async function runBillRunSlice(db: Db, runId: string, o: { budgetMs?: number } = {}): Promise<BillSlice> {
  const deadline = Date.now() + (o.budgetMs ?? BILL_SLICE_MS);
  const got = await db.query(`UPDATE bill_runs SET claimed_until = now() + interval '90 seconds' WHERE id=$1 AND status = ANY($2::text[]) AND (claimed_until IS NULL OR claimed_until < now()) RETURNING *`, [runId, ACTIVE]);
  if (!got.rowCount) { const r = await getBillRun(db, runId); return { run: r, busy: ACTIVE.includes(r.status) }; }
  let status = got.rows[0]!.status as string;
  try {
    for (let first = true; (first || Date.now() < deadline) && ACTIVE.includes(status); first = false) {
      try { status = status === 'MOCK_RUNNING' ? await mockBatch(db, runId) : await productionBatch(db, runId); }
      catch (e) {
        await db.query(`UPDATE bill_runs SET status='FAILED', stage='Stopped: something went wrong', finished_at=now(), summary = summary || $2::jsonb, updated_at=now() WHERE id=$1`, [runId, JSON.stringify({ problem: (e as Error).message })]);
        status = 'FAILED';
      }
    }
  } finally { await db.query('UPDATE bill_runs SET claimed_until=NULL WHERE id=$1', [runId]); }
  return { run: await getBillRun(db, runId) };
}

/** The scheduler's call: works on every run that has something to do until the time is up. */
export async function runDueBillRuns(db: Db, o: { budgetMs?: number } = {}): Promise<{ ran: number }> {
  const deadline = Date.now() + (o.budgetMs ?? BILL_SLICE_MS);
  const ids = (await db.query(`SELECT id FROM bill_runs WHERE status = ANY($1::text[]) AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY created_at LIMIT 10`, [ACTIVE])).rows.map((r) => r.id as string);
  let ran = 0;
  for (const id of ids) { const left = deadline - Date.now(); if (left < 500) break; await runBillRunSlice(db, id, { budgetMs: left }); ran++; }
  return { ran };
}

type Delta = { byStream: Record<string, number>; byMarket: Record<string, { name: string; bps: number; net: number; tax: number }>; anomalies: Record<string, number> };
const bump = (m: Record<string, number>, k: string, v: number) => { m[k] = (m[k] ?? 0) + v; };

/** Prices one batch of accounts as if billing them, writing nothing but the run's own items. Returns the run's new status. */
async function mockBatch(db: Db, runId: string): Promise<string> {
  const run = (await db.query('SELECT * FROM bill_runs WHERE id=$1', [runId])).rows[0]!;
  const settings = await getBillRunSettings(db);
  const todo = (await db.query(`SELECT account_id FROM bill_run_items WHERE run_id=$1 AND status='PENDING' ORDER BY account_id LIMIT $2`, [runId, MOCK_BATCH])).rows.map((r) => r.accountId as string);
  if (!todo.length) return finishMock(db, runId);
  const accts = (await db.query(
    `SELECT a.*, p.total_minor AS prev_total FROM accounts a LEFT JOIN LATERAL (SELECT total_minor FROM invoices WHERE account_id = a.id AND kind='CYCLE' ORDER BY issue_date DESC LIMIT 1) p ON true WHERE a.id = ANY($1::uuid[])`, [todo])).rows;
  const byId = new Map(accts.map((a) => [a.id as string, a]));
  const delta: Delta = { byStream: {}, byMarket: {}, anomalies: {} };
  let net = 0, tax = 0;
  const out: Array<Record<string, unknown>> = [];
  for (const id of todo) {
    const a = byId.get(id);
    const item: Record<string, unknown> = { id, status: 'MOCKED', period_start: null, period_end: null, net: 0, tax: 0, total: 0, lines: 0, prev: null, anomalies: [] as string[], error: null };
    try {
      if (!a || a.status !== 'ACTIVE') { item.status = 'SKIPPED'; item.error = 'The account is not active.'; }
      else {
        const d = await draftCycleBill(db, a, run.asOf);
        item.period_start = d.periodStart; item.period_end = d.periodEnd; item.prev = a.prevTotal ?? null;
        if (d.exists) { item.status = 'SKIPPED'; item.error = 'This period is already billed.'; (item.anomalies as string[]).push('ALREADY_BILLED'); }
        else {
          const p = await priceDraft(db, a, d.lines);
          item.net = p.net; item.tax = p.tax; item.total = p.net + p.tax; item.lines = p.priced.length;
          if (p.net + p.tax <= 0) {
            item.status = 'NO_INVOICE';
            if ((await db.query(`SELECT 1 FROM services WHERE account_id=$1 AND status='ACTIVE' LIMIT 1`, [id])).rows.length) (item.anomalies as string[]).push('ZERO');
          } else {
            const total = p.net + p.tax, prev = a.prevTotal as number | null;
            const an = item.anomalies as string[];
            if (prev && prev > 0) {
              if (total >= prev * (1 + settings.spikePercent / 100)) an.push('SPIKE');
              else if (total <= prev * (1 - settings.dropPercent / 100)) an.push('DROP');
            } else an.push('NO_HISTORY');
            if (settings.largeMinor > 0 && total >= settings.largeMinor) an.push('LARGE');
            net += p.net; tax += p.tax;
            for (const l of p.priced) bump(delta.byStream, streamOfLine(l), l.net);
            const m = (delta.byMarket[p.mk.code] ??= { name: p.mk.taxName, bps: p.mk.taxBps, net: 0, tax: 0 });
            m.net += p.net; m.tax += p.tax;
          }
        }
      }
    } catch (e) { item.status = 'FAILED'; item.error = (e as Error).message.slice(0, 300); }
    for (const an of item.anomalies as string[]) bump(delta.anomalies, an, 1);
    out.push(item);
  }
  return db.tx(async (q) => {
    const cur = (await q.query('SELECT status, summary FROM bill_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]!;
    if (cur.status !== 'MOCK_RUNNING') return cur.status as string; // cancelled or sent back while this batch was being priced
    await q.query(
      `UPDATE bill_run_items i SET status=u.status, period_start=u.ps::date, period_end=u.pe::date, net_minor=u.net, tax_minor=u.tax, total_minor=u.total, line_count=u.lines, prev_total_minor=u.prev, anomalies=COALESCE(string_to_array(NULLIF(u.an,''), ','), '{}'), error=u.err
         FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[], $9::int[], $10::bigint[], $11::text[], $12::text[]) AS u(id, status, ps, pe, net, tax, total, lines, prev, an, err)
        WHERE i.run_id=$1 AND i.account_id=u.id AND i.status='PENDING'`,
      [runId, out.map((x) => x.id), out.map((x) => x.status), out.map((x) => x.period_start), out.map((x) => x.period_end), out.map((x) => x.net), out.map((x) => x.tax), out.map((x) => x.total), out.map((x) => x.lines), out.map((x) => x.prev),
        out.map((x) => (x.anomalies as string[]).join(',')), out.map((x) => x.error)]);
    const sum = cur.summary as { byStream?: Record<string, number>; byMarket?: Delta['byMarket']; anomalies?: Record<string, number> };
    const byStream = { ...(sum.byStream ?? {}) }; for (const [k, v] of Object.entries(delta.byStream)) bump(byStream, k, v);
    const byMarket = { ...(sum.byMarket ?? {}) }; for (const [k, v] of Object.entries(delta.byMarket)) { const c = (byMarket[k] ??= { ...v, net: 0, tax: 0 }); c.net += v.net; c.tax += v.tax; }
    const left = Number((await q.query(`SELECT count(*) AS n FROM bill_run_items WHERE run_id=$1 AND status='PENDING'`, [runId])).rows[0]!.n);
    await q.query(`UPDATE bill_runs SET mock_net_minor = mock_net_minor + $2, mock_tax_minor = mock_tax_minor + $3, mock_total_minor = mock_total_minor + $4, summary = summary || $5::jsonb,
        percent = CASE WHEN accounts_total > 0 THEN LEAST(99, floor((accounts_total - $6) * 100.0 / accounts_total)) ELSE 99 END, updated_at=now(), claimed_until = now() + interval '90 seconds' WHERE id=$1`,
      [runId, net, tax, net + tax, JSON.stringify({ byStream, byMarket }), left]);
    return 'MOCK_RUNNING';
  });
}

async function finishMock(db: Db, runId: string): Promise<string> {
  const anomalies = (await db.query(`SELECT a, count(*) AS n FROM (SELECT unnest(anomalies) AS a FROM bill_run_items WHERE run_id=$1 AND cardinality(anomalies) > 0) x GROUP BY a`, [runId])).rows;
  await db.tx(async (q) => {
    await recomputeTotals(q, runId);
    await q.query(`UPDATE bill_runs SET status='MOCK_COMPLETED', stage='Mock complete: ready for review', percent=100, mock_finished_at=now(), summary = summary || $2::jsonb, updated_at=now() WHERE id=$1 AND status='MOCK_RUNNING'`,
      [runId, JSON.stringify({ anomalies: Object.fromEntries(anomalies.map((r) => [r.a, Number(r.n)])) })]);
  });
  return 'MOCK_COMPLETED';
}

/** Issues the invoices of one batch of approved accounts, each in its own transaction so a bad account cannot stop the others. */
async function productionBatch(db: Db, runId: string): Promise<string> {
  const run = (await db.query('SELECT * FROM bill_runs WHERE id=$1', [runId])).rows[0]!;
  const todo = (await db.query(
    `SELECT i.*, a.id AS a_id FROM bill_run_items i LEFT JOIN accounts a ON a.id = i.account_id WHERE i.run_id=$1 AND i.status='MOCKED' ORDER BY i.account_id LIMIT $2`, [runId, PROD_BATCH])).rows;
  if (!todo.length) return finishProduction(db, runId);
  let invoices = 0, total = 0;
  for (const it of todo) {
    const upd = async (status: string, f: { invoiceId?: string; billed?: number; error?: string; anomaly?: string } = {}) => {
      await db.query(`UPDATE bill_run_items SET status=$3, invoice_id=$4, billed_total_minor=$5, error=$6, anomalies = CASE WHEN $7::text IS NULL THEN anomalies ELSE array_append(anomalies, $7::text) END WHERE run_id=$1 AND account_id=$2`,
        [runId, it.accountId, status, f.invoiceId ?? null, f.billed ?? null, f.error ?? null, f.anomaly ?? null]);
    };
    try {
      const a = (await db.query('SELECT * FROM accounts WHERE id=$1', [it.accountId])).rows[0];
      if (!a || a.status !== 'ACTIVE') { await upd('SKIPPED', { error: 'The account is no longer active.' }); continue; }
      const inv = await db.tx(async (q) => {
        const r = await billAccount(q, a, run.asOf, { billRunId: runId });
        // Customers are told about a real invoice, never about a mock.
        if (r && r !== 'EXISTS') await q.query(`INSERT INTO lifecycle_outbox (kind, account_id, instruction, payload) VALUES ('NOTIFY', $1, 'INVOICE_ISSUED', $2)`, [a.id, JSON.stringify({ invoiceId: r.id, number: r.number, totalMinor: r.totalMinor, dueDate: r.dueDate, billRunId: runId })]);
        return r;
      });
      if (inv === 'EXISTS') await upd('SKIPPED', { error: 'This period was billed in the meantime.' });
      else if (!inv) await upd('NO_INVOICE');
      else { invoices++; total += inv.totalMinor; await upd('BILLED', { invoiceId: inv.id, billed: inv.totalMinor, anomaly: inv.totalMinor !== Number(it.totalMinor) ? 'VARIANCE' : undefined }); }
    } catch (e) { await upd('FAILED', { error: (e as Error).message.slice(0, 300) }); }
  }
  await db.query(
    `UPDATE bill_runs SET billed_invoices = billed_invoices + $2, billed_total_minor = billed_total_minor + $3, updated_at=now(), claimed_until = now() + interval '90 seconds',
       percent = LEAST(99, COALESCE((SELECT floor(100.0 * count(*) FILTER (WHERE status IN ('BILLED','FAILED')) / NULLIF(count(*) FILTER (WHERE status IN ('MOCKED','BILLED','FAILED')), 0)) FROM bill_run_items WHERE run_id=$1), 0)) WHERE id=$1`, [runId, invoices, total]);
  return 'PRODUCTION_RUNNING';
}

async function finishProduction(db: Db, runId: string): Promise<string> {
  const c = Object.fromEntries((await db.query(`SELECT status, count(*) AS n FROM bill_run_items WHERE run_id=$1 GROUP BY status`, [runId])).rows.map((r) => [r.status, Number(r.n)]));
  const variance = Number((await db.query(`SELECT count(*) AS n FROM bill_run_items WHERE run_id=$1 AND 'VARIANCE' = ANY(anomalies)`, [runId])).rows[0]!.n);
  const run = (await db.query('SELECT * FROM bill_runs WHERE id=$1', [runId])).rows[0]!;
  await db.tx(async (q) => {
    await q.query(`UPDATE bill_runs SET status='COMPLETED', stage=$2, percent=100, finished_at=now(), summary = summary || $3::jsonb, updated_at=now() WHERE id=$1`,
      [runId, c.FAILED ? `Done, with ${c.FAILED} account${c.FAILED === 1 ? '' : 's'} to retry` : 'Done', JSON.stringify({ result: { billed: c.BILLED ?? 0, failed: c.FAILED ?? 0, skipped: c.SKIPPED ?? 0, excluded: c.EXCLUDED ?? 0, noInvoice: c.NO_INVOICE ?? 0, variance } })]);
    await q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) VALUES ('EVENT', 'BILL_RUN_COMPLETED', $1)`, [JSON.stringify({ billRunId: runId, cycleDay: run.cycleDay, asOf: run.asOf, invoices: c.BILLED ?? 0, failed: c.FAILED ?? 0, topic: 'meridian.billing.events' })]);
    await audit(q, run.approvedBy ?? 'system', 'billing', runId, 'BILL_RUN_COMPLETED', { billed: c.BILLED ?? 0, failed: c.FAILED ?? 0 });
  });
  return 'COMPLETED';
}

