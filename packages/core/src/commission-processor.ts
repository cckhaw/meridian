import { createHash } from 'node:crypto';
import { audit } from './audit.js';
import { CommissionCalculator, clawbackBps, pickPolicy, type ClawbackTrigger, type PlanRule } from './commission-calculator.js';
import { getCommissionSettings, loadPlan, postEntryGl } from './commission.js';
import { GL } from './config.js';
import { diffDays, today } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { postJournal } from './ledger.js';
import { toDecimal } from './sap-exporter.js';
import { getRegional } from './settings.js';

/**
 * The scheduled side of commission: approving earnings once their hold has passed, claw-backs when a customer leaves early, the month close (accelerators,
 * bonuses), settlement statements, and the bank / payroll payout files with their GL postings.
 */
const PAYABLE = ['DEALER', 'STAFF'];

// ───────────────────────── approval ─────────────────────────
/** Approves a set of entries (and the claw-backs that follow them). Only PENDING entries move. */
async function approveWhere(q: Queryable, cond: string, params: unknown[]): Promise<number> {
  const ids = (await q.query(`SELECT e.id FROM agent_ledger_entries e WHERE e.status='PENDING' AND ${cond}`, params)).rows.map((r) => r.id as number);
  if (!ids.length) return 0;
  const r = await q.query(`UPDATE agent_ledger_entries SET status='APPROVED', approved_at=now() WHERE status='PENDING' AND (id = ANY($1::bigint[]) OR reverses_id = ANY($1::bigint[]))`, [ids]);
  return r.rowCount;
}
/** Earnings whose plan's hold has passed become approved for payment. */
export async function approveDue(q: Queryable, asOf: string = today()): Promise<number> {
  return approveWhere(q, `e.earned_on + COALESCE((SELECT hold_days FROM commission_plans p WHERE p.id = e.plan_id), 0) <= $1::date`, [asOf]);
}
export async function approveEntries(q: Queryable, actor: string, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const n = await approveWhere(q, 'e.id = ANY($1::bigint[])', [ids]);
  await audit(q, actor, 'commission', 'ledger', 'APPROVED', { requested: ids.length, approved: n });
  return n;
}

// ───────────────────────── claw-backs ─────────────────────────
export interface ClawbackEvent {
  orderId: string; offerId?: string; orderLineId?: string; trigger: ClawbackTrigger; /** The day the service ended or the sale was undone. */ on: string; /** The day the service began (defaults to the day the commission was earned). */ since?: string;
}
/**
 * Takes commission back when a customer leaves inside a claw-back window. Each ended service takes back its share of the line's earning at the percentage of the
 * window it falls in; a cancelled line takes back what is left. The earning keeps its row; a negative CLAWBACK entry (and a GL reversal) records the reversal, and when
 * a whole unpaid earning is taken back the earning and its reversals are marked CLAWED_BACK so neither reaches a statement.
 */
export async function clawBack(q: Queryable, ev: ClawbackEvent, actor = 'system'): Promise<{ clawed: number; entries: number }> {
  const params: unknown[] = [ev.orderId];
  let cond = `order_id=$1 AND entry_type IN ('EARNING','OVERRIDE') AND status <> 'CLAWED_BACK'`;
  if (ev.orderLineId) cond += ` AND order_line_id=$${params.push(ev.orderLineId)}::uuid`;
  if (ev.offerId) cond += ` AND offer_id=$${params.push(ev.offerId)}`;
  const entries = (await q.query(`SELECT * FROM agent_ledger_entries WHERE ${cond} ORDER BY id FOR UPDATE`, params)).rows;
  let total = 0, made = 0;
  for (const e of entries) {
    const remaining = Number(e.amountMinor) - Number(e.clawedMinor);
    const unitsLeft = Math.max(0, e.units - e.clawedUnits);
    if (remaining <= 0 || (e.units > 0 && unitsLeft === 0)) continue;
    const plan = e.planId ? await loadPlan(q, e.planId) : null;
    const term = Number((e.calc as { termMonths?: number })?.termMonths ?? 0);
    const policy = plan ? pickPolicy(plan.clawbacks, ev.trigger, term) : null;
    const wholeLine = ev.trigger === 'ORDER_CANCELLED' || e.units === 0;
    const bps = policy && (e.entryType === 'EARNING' || policy.includeOverrides) ? clawbackBps(policy, Math.max(0, diffDays(ev.on, ev.since ?? e.earnedOn))) : 0;
    const base = wholeLine ? remaining : Math.round(remaining / Math.max(unitsLeft, 1));
    const amount = Math.min(remaining, Math.round((base * bps) / 10_000));
    const units = wholeLine ? e.units - e.clawedUnits : 1;
    // Bookkeeping always moves (so a sweep never counts the same service twice); money moves only when a window applies.
    const settled = e.settlementId != null || e.status === 'PAID';
    await q.query('UPDATE agent_ledger_entries SET clawed_units = clawed_units + $2, clawed_minor = clawed_minor + $3 WHERE id=$1', [e.id, units, amount]);
    if (amount <= 0) continue;
    const id = (await q.query(
      `INSERT INTO agent_ledger_entries (beneficiary_kind, beneficiary_id, dealer_id, dealer_agent_id, store_id, entry_type, status, amount_minor, basis_minor, rate_bps, units, currency, plan_id, rule_id, order_id, order_line_id, offer_id, period, earned_on, approved_at, reverses_id, note, calc)
       VALUES ($1,$2,$3,$4,$5,'CLAWBACK',$6,$7,0,$8,0,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $6='APPROVED' THEN now() END, $17,$18,$19) RETURNING id`,
      [e.beneficiaryKind, e.beneficiaryId, e.dealerId, e.dealerAgentId, e.storeId, settled ? 'APPROVED' : e.status, -amount, bps, e.currency, e.planId, e.ruleId, e.orderId, e.orderLineId, e.offerId, ev.on.slice(0, 7), ev.on, e.id,
       `${ev.trigger.toLowerCase().replace('_', ' ')} ${diffDays(ev.on, ev.since ?? e.earnedOn)} days after the sale`, JSON.stringify({ trigger: ev.trigger, percentBps: bps, policy: policy?.name ?? null, of: e.id })])).rows[0]!.id as number;
    await postEntryGl(q, { id, beneficiaryKind: e.beneficiaryKind, beneficiaryId: e.beneficiaryId, amountMinor: -amount, currency: e.currency, earnedOn: ev.on, entryType: 'CLAWBACK' });
    total += amount; made++;
    if (!settled && Number(e.clawedMinor) + amount >= Number(e.amountMinor)) {
      await q.query(`UPDATE agent_ledger_entries SET status='CLAWED_BACK' WHERE id=$1 OR reverses_id=$1`, [e.id]);
    }
  }
  if (made) await audit(q, actor, 'commission', ev.orderId, 'CLAWED_BACK', { trigger: ev.trigger, amountMinor: total, entries: made });
  return { clawed: total, entries: made };
}

/** Claw-back for an ended service: called as the service is terminated or ported out. */
export async function clawBackService(q: Queryable, s: Row, trigger: ClawbackTrigger, on: string, actor = 'system') {
  if (!s.orderId) return { clawed: 0, entries: 0 };
  return clawBack(q, { orderId: s.orderId, offerId: s.offerId, trigger, on, since: s.activatedAt ? new Date(s.activatedAt).toISOString().slice(0, 10) : undefined }, actor);
}

/** The safety net: services that ended but whose commission was not taken back (an event missed, a rule added later). Each is processed once. */
export async function sweepClawbacks(q: Queryable, asOf: string = today(), lookbackDays = 400): Promise<{ services: number; clawed: number }> {
  const rows = (await q.query(
    `SELECT s.id, s.order_id, s.offer_id, s.activated_at, s.terminated_at, s.terminated_reason
       FROM services s
      WHERE s.status='TERMINATED' AND s.order_id IS NOT NULL AND s.terminated_at >= ($1::date - $2::int)
        AND EXISTS (SELECT 1 FROM agent_ledger_entries e WHERE e.order_id = s.order_id AND e.offer_id = s.offer_id AND e.entry_type='EARNING' AND e.units > e.clawed_units AND e.status <> 'CLAWED_BACK')
      ORDER BY s.terminated_at, s.id LIMIT 2000`, [asOf, lookbackDays])).rows;
  let services = 0, clawed = 0;
  for (const s of rows) {
    // Only services beyond those already counted against the entry are new.
    const e = (await q.query(`SELECT units - clawed_units AS left_units, units FROM agent_ledger_entries WHERE order_id=$1 AND offer_id=$2 AND entry_type='EARNING' AND status <> 'CLAWED_BACK' ORDER BY id LIMIT 1`, [s.orderId, s.offerId])).rows[0];
    if (!e || e.leftUnits <= 0) continue;
    const ended = (await q.query(`SELECT id FROM services WHERE order_id=$1 AND offer_id=$2 AND status='TERMINATED' ORDER BY terminated_at, id`, [s.orderId, s.offerId])).rows.map((r) => r.id);
    const handled = e.units - e.leftUnits;
    if (ended.indexOf(s.id) < handled) continue;
    const r = await clawBackService(q, s, s.terminatedReason === 'PORTED_OUT' ? 'PORT_OUT' : 'TERMINATION', new Date(s.terminatedAt).toISOString().slice(0, 10), 'sweep');
    services++; clawed += r.clawed;
  }
  return { services, clawed };
}

// ───────────────────────── month close ─────────────────────────
const toRule = (r: Row): PlanRule => ({ id: r.id, name: r.name, priority: r.priority, matchKinds: r.matchKinds, matchOfferIds: r.matchOfferIds, minTermMonths: r.minTermMonths, maxTermMonths: r.maxTermMonths, matchTiers: r.matchTiers, calc: r.calc, rateBps: r.rateBps, fixedMinor: Number(r.fixedMinor), slabMode: r.slabMode, slabs: r.slabs, status: r.status });

/** Accelerators and bonuses for the month: a RETROACTIVE rule pays the difference once the volume reaches a higher band; a band's bonus is paid once. Safe to repeat. */
export async function trueUpPeriod(q: Queryable, per: string, actor = 'system'): Promise<{ accelerators: number; bonuses: number }> {
  const groups = (await q.query(
    `SELECT e.rule_id, e.beneficiary_kind, e.beneficiary_id, max(e.currency) AS currency, max(e.dealer_id) AS dealer_id FROM agent_ledger_entries e
      WHERE e.period=$1 AND e.entry_type='EARNING' AND e.rule_id IS NOT NULL AND e.units > 0 AND e.status <> 'CLAWED_BACK' GROUP BY 1, 2, 3`, [per])).rows;
  const eom = new Date(Date.UTC(Number(per.slice(0, 4)), Number(per.slice(5)), 0)).toISOString().slice(0, 10);
  let accelerators = 0, bonuses = 0;
  for (const g of groups) {
    const ruleRow = (await q.query('SELECT r.*, p.hold_days FROM commission_rules r JOIN commission_plans p ON p.id=r.plan_id WHERE r.id=$1', [g.ruleId])).rows[0];
    if (!ruleRow || !ruleRow.slabs?.length) continue;
    const rule = toRule(ruleRow);
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`commission:${g.beneficiaryKind}:${g.beneficiaryId}:${per}`]);
    const earnings = (await q.query(`SELECT id, amount_minor, basis_minor, units, clawed_units, clawed_minor, plan_id FROM agent_ledger_entries WHERE period=$1 AND entry_type='EARNING' AND rule_id=$2 AND beneficiary_kind=$3 AND beneficiary_id=$4 AND status <> 'CLAWED_BACK'`, [per, g.ruleId, g.beneficiaryKind, g.beneficiaryId])).rows;
    // Net of what was taken back: units that stayed, at the basis that stayed.
    const net = earnings.map((e) => { const kept = e.units - e.clawedUnits; return { basisMinor: e.units ? Math.round((Number(e.basisMinor) * kept) / e.units) : 0, units: kept }; });
    const planId = earnings[0]?.planId as string | undefined;
    const common = { beneficiaryKind: g.beneficiaryKind, beneficiaryId: g.beneficiaryId, dealerId: g.dealerId, dealerAgentId: null, storeId: null, basisMinor: 0, rateBps: null, units: 0, planId: planId ?? null, ruleId: g.ruleId, orderLineId: null, offerId: null };
    const ins = async (type: 'ACCELERATOR' | 'BONUS', amount: number, note: string, calc: Record<string, unknown>) => {
      const status = 'APPROVED';
      const r = await q.query(
        `INSERT INTO agent_ledger_entries (beneficiary_kind, beneficiary_id, dealer_id, entry_type, status, amount_minor, basis_minor, units, currency, plan_id, rule_id, period, earned_on, approved_at, note, calc)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9,$10,$11,now(),$12,$13) ON CONFLICT DO NOTHING RETURNING id`,
        [common.beneficiaryKind, common.beneficiaryId, common.dealerId, type, status, amount, g.currency, common.planId, common.ruleId, per, eom, note, JSON.stringify(calc)]);
      const id = r.rows[0]?.id as number | undefined;
      if (id) await postEntryGl(q, { id, beneficiaryKind: g.beneficiaryKind, beneficiaryId: g.beneficiaryId, amountMinor: amount, currency: g.currency, earnedOn: eom, entryType: type });
      return !!id;
    };
    const r = CommissionCalculator.retroactiveTarget(rule, net);
    if (rule.slabMode === 'RETROACTIVE' && r.slab) {
      const paid = earnings.reduce((s, e) => s + Number(e.amountMinor) - Number(e.clawedMinor), 0);
      const acc = Number((await q.query(`SELECT COALESCE(sum(amount_minor),0) AS n FROM agent_ledger_entries WHERE period=$1 AND entry_type='ACCELERATOR' AND rule_id=$2 AND beneficiary_kind=$3 AND beneficiary_id=$4`, [per, g.ruleId, g.beneficiaryKind, g.beneficiaryId])).rows[0]!.n);
      const delta = r.targetMinor - paid - acc;
      if (delta !== 0 && (await ins('ACCELERATOR', delta, `${r.totalUnits} activations reached the ${r.slab.from}-${r.slab.to ?? 'and above'} band: every activation of the month paid at that band`, { rule: rule.name, totalUnits: r.totalUnits, band: r.slab, targetMinor: r.targetMinor }))) accelerators++;
    }
    const bonus = CommissionCalculator.bonusFor(rule, r.totalUnits);
    if (bonus > 0 && (await ins('BONUS', bonus, `${r.totalUnits} activations: volume bonus`, { rule: rule.name, totalUnits: r.totalUnits }))) bonuses++;
  }
  if (accelerators || bonuses) await audit(q, actor, 'commission', per, 'TRUE_UP', { accelerators, bonuses });
  return { accelerators, bonuses };
}

// ───────────────────────── statements ─────────────────────────
const methodOf = (kind: string) => (kind === 'DEALER' ? 'BANK' : kind === 'STAFF' ? 'PAYROLL' : 'HOUSE');
async function nameOf(q: Queryable, kind: string, id: string): Promise<string> {
  if (kind === 'DEALER') return ((await q.query('SELECT name FROM dealers WHERE id=$1', [id])).rows[0]?.name as string | undefined) ?? id;
  if (kind === 'STAFF') return ((await q.query('SELECT display_name FROM users WHERE username=$1', [id])).rows[0]?.displayName as string | undefined) ?? id;
  if (kind === 'STORE') return ((await q.query('SELECT name FROM stores WHERE id=$1', [id])).rows[0]?.name as string | undefined) ?? id;
  return id;
}

/**
 * Issues one statement per beneficiary for everything approved and not yet settled up to the end of `per`. A beneficiary whose net is zero or negative (claw-backs
 * exceed earnings) gets no statement: the balance carries into the next month. Store and house commission is recorded as paid on issue (it is not a payment).
 */
export async function generateStatements(db: Db, per: string, actor = 'system'): Promise<{ issued: number; carriedForward: Array<{ beneficiaryId: string; netMinor: number }>; statements: Row[] }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(per)) throw invalid('the period is YYYY-MM');
  return db.tx(async (q) => {
    const groups = (await q.query(
      `SELECT beneficiary_kind, beneficiary_id, currency, sum(amount_minor) AS net, sum(amount_minor) FILTER (WHERE amount_minor > 0) AS gross, COALESCE(sum(amount_minor) FILTER (WHERE amount_minor < 0),0) AS claw, count(*) AS n
         FROM agent_ledger_entries WHERE status='APPROVED' AND settlement_id IS NULL AND period <= $1 GROUP BY 1, 2, 3 ORDER BY 1, 2`, [per])).rows;
    const statements: Row[] = [];
    const carriedForward: Array<{ beneficiaryId: string; netMinor: number }> = [];
    for (const g of groups) {
      const net = Number(g.net);
      if (net <= 0) { carriedForward.push({ beneficiaryId: g.beneficiaryId, netMinor: net }); continue; }
      const method = methodOf(g.beneficiaryKind);
      const no = `CS-${per}-${String((await q.query(`SELECT nextval('commission_statement_seq') AS n`)).rows[0]!.n).padStart(5, '0')}`;
      const st = (await q.query(
        `INSERT INTO commission_settlements (statement_no, period, beneficiary_kind, beneficiary_id, beneficiary_name, payout_method, gross_minor, clawback_minor, net_minor, entry_count, currency, status, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $6='HOUSE' THEN now() END) RETURNING *`,
        [no, per, g.beneficiaryKind, g.beneficiaryId, await nameOf(q, g.beneficiaryKind, g.beneficiaryId), method, Number(g.gross ?? 0), Number(g.claw), net, Number(g.n), g.currency, method === 'HOUSE' ? 'PAID' : 'ISSUED'])).rows[0]!;
      await q.query(`UPDATE agent_ledger_entries SET settlement_id=$1, status = CASE WHEN $2='HOUSE' THEN 'PAID' ELSE status END, paid_at = CASE WHEN $2='HOUSE' THEN now() END WHERE status='APPROVED' AND settlement_id IS NULL AND period <= $3 AND beneficiary_kind=$4 AND beneficiary_id=$5 AND currency=$6`,
        [st.id, method, per, g.beneficiaryKind, g.beneficiaryId, g.currency]);
      statements.push(st);
    }
    await q.query(`INSERT INTO commission_periods (period, closed_by, statements) VALUES ($1,$2,$3) ON CONFLICT (period) DO UPDATE SET statements = commission_periods.statements + EXCLUDED.statements, closed_at=now(), closed_by=EXCLUDED.closed_by`, [per, actor, statements.length]);
    await audit(q, actor, 'commission', per, 'STATEMENTS_ISSUED', { issued: statements.length, carriedForward: carriedForward.length });
    return { issued: statements.length, carriedForward, statements };
  });
}

export async function listStatements(q: Queryable, f: { period?: string; beneficiaryId?: string; dealerId?: string; status?: string } = {}): Promise<Row[]> {
  const params: unknown[] = []; const where: string[] = [];
  if (f.period) where.push(`period = $${params.push(f.period)}`);
  if (f.status) where.push(`status = $${params.push(f.status)}`);
  if (f.beneficiaryId) where.push(`beneficiary_id = $${params.push(f.beneficiaryId)}`);
  if (f.dealerId) where.push(`(beneficiary_kind='DEALER' AND beneficiary_id = $${params.push(f.dealerId)})`);
  return (await q.query(`SELECT * FROM commission_settlements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY issued_at DESC, statement_no DESC LIMIT 200`, params)).rows;
}
export async function getStatement(q: Queryable, id: string): Promise<Row & { entries: Row[] }> {
  const s = (await q.query('SELECT * FROM commission_settlements WHERE id=$1', [id])).rows[0];
  if (!s) throw notFound('statement', id);
  const entries = (await q.query(`SELECT e.*, o.number AS order_number FROM agent_ledger_entries e LEFT JOIN orders o ON o.id=e.order_id WHERE e.settlement_id=$1 ORDER BY e.entry_type, e.id`, [id])).rows;
  return { ...s, entries };
}
const csvCell = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export async function statementCsv(q: Queryable, id: string): Promise<string> {
  const st = await getStatement(q, id);
  const exp = (await getRegional(q)).exponent;
  const rows = st.entries.map((e) => [st.statementNo, st.beneficiaryId, st.beneficiaryName, e.entryType, e.status, e.orderNumber ?? '', e.offerId ?? '', e.earnedOn, e.units, toDecimal(Number(e.basisMinor), exp), e.rateBps ?? '', toDecimal(Number(e.amountMinor), exp), e.currency, e.note ?? ''].map((v) => csvCell(v as string | number)).join(','));
  return ['Statement,Beneficiary,Name,Type,Status,Order,Offer,Date,Units,Basis,RateBps,Amount,Currency,Note', ...rows].join('\r\n') + '\r\n';
}

// ───────────────────────── payouts ─────────────────────────
/** Builds the disbursement file for the issued statements (bank transfers for dealers, a payroll file for staff). Statements missing payee details are left out and named. */
export async function createPayoutBatch(db: Db, o: { period?: string; actor: string }): Promise<{ batch: Row | null; skipped: Array<{ statementNo: string; reason: string }> }> {
  return db.tx(async (q) => {
    const params: unknown[] = []; let cond = `s.status='ISSUED' AND s.payout_method IN ('BANK','PAYROLL')`;
    if (o.period) cond += ` AND s.period <= $${params.push(o.period)}`;
    const sts = (await q.query(`SELECT s.*, d.bank_account_name, d.bank_account_no, d.bank_code, d.sap_vendor_no FROM commission_settlements s LEFT JOIN dealers d ON s.beneficiary_kind='DEALER' AND d.id = s.beneficiary_id WHERE ${cond} ORDER BY s.statement_no FOR UPDATE OF s`, params)).rows;
    const skipped: Array<{ statementNo: string; reason: string }> = [];
    const ok = sts.filter((s) => { if (s.payoutMethod === 'BANK' && (!s.bankAccountNo || !s.bankCode)) { skipped.push({ statementNo: s.statementNo, reason: `${s.beneficiaryName} has no bank account on file` }); return false; } return true; });
    if (!ok.length) return { batch: null, skipped };
    const exp = (await getRegional(q)).exponent;
    const currency = ok[0]!.currency as string;
    if (ok.some((s) => s.currency !== currency)) throw rejected('statements in different currencies cannot share one payout file');
    const batchNo = `P${String((await q.query(`SELECT nextval('commission_payout_seq') AS n`)).rows[0]!.n).padStart(6, '0')}`;
    const head = 'PayeeType,PayeeId,PayeeName,Method,BankCode,BankAccountName,BankAccountNo,SapVendor,Amount,Currency,Reference,Period';
    const lines = ok.map((s) => [s.beneficiaryKind, s.beneficiaryId, s.beneficiaryName, s.payoutMethod, s.bankCode ?? '', s.bankAccountName ?? '', s.bankAccountNo ?? '', s.sapVendorNo ?? '', toDecimal(Number(s.netMinor), exp), s.currency, s.statementNo, s.period].map((v) => csvCell(v as string)).join(','));
    const content = [head, ...lines].join('\r\n') + '\r\n';
    const total = ok.reduce((t, s) => t + Number(s.netMinor), 0);
    const fileName = `commission-payout-${batchNo}.csv`;
    const batch = (await q.query(
      `INSERT INTO commission_payout_batches (batch_no, period, file_name, content, file_sha256, total_minor, statement_count, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, batch_no, period, status, file_name, file_sha256, total_minor, statement_count, currency, created_by, created_at`,
      [batchNo, o.period ?? ok.map((s) => s.period as string).sort().pop()!, fileName, content, createHash('sha256').update(content).digest('hex'), total, ok.length, currency, o.actor])).rows[0]!;
    await q.query(`UPDATE commission_settlements SET status='PAYOUT_PENDING', payout_batch_id=$1 WHERE id = ANY($2::uuid[])`, [batch.id, ok.map((s) => s.id)]);
    await audit(q, o.actor, 'commission', batch.id, 'PAYOUT_CREATED', { batchNo, statements: ok.length, totalMinor: total });
    return { batch, skipped };
  });
}
export async function listPayoutBatches(q: Queryable): Promise<Row[]> {
  return (await q.query(`SELECT id, batch_no, period, status, file_name, file_sha256, total_minor, statement_count, currency, created_by, created_at, paid_at, confirmed_by FROM commission_payout_batches ORDER BY created_at DESC LIMIT 100`)).rows;
}
export async function getPayoutFile(q: Queryable, id: string): Promise<{ fileName: string; contentType: string; content: string }> {
  const b = (await q.query('SELECT file_name, content_type, content FROM commission_payout_batches WHERE id=$1', [id])).rows[0];
  if (!b) throw notFound('payout batch', id);
  return { fileName: b.fileName, contentType: b.contentType, content: b.content };
}
/** The bank confirmed the file: statements and their entries are PAID, and each payout is booked (payable against the disbursement clearing account). */
export async function confirmPayoutBatch(db: Db, batchId: string, actor: string): Promise<Row> {
  return db.tx(async (q) => {
    const b = (await q.query('SELECT * FROM commission_payout_batches WHERE id=$1 FOR UPDATE', [batchId])).rows[0];
    if (!b) throw notFound('payout batch', batchId);
    if (b.status === 'PAID') throw rejected('This payout was already confirmed.');
    const sts = (await q.query(`SELECT * FROM commission_settlements WHERE payout_batch_id=$1 ORDER BY statement_no`, [batchId])).rows;
    const date = today();
    for (const s of sts) {
      await postJournal(q, {
        date, sourceType: 'COMMISSION_PAYOUT', sourceId: s.statementNo, currency: s.currency, eventType: 'COMMISSION_PAID', eventId: `payout-${s.statementNo}`,
        lines: [
          { account: GL.COMMISSION_PAYABLE, debit: Number(s.netMinor), description: `Commission paid ${s.beneficiaryId} ${s.period}` },
          { account: GL.DISBURSEMENT, credit: Number(s.netMinor), description: `Commission payout ${s.beneficiaryId} ${s.statementNo}` },
        ],
      });
      await q.query(`UPDATE agent_ledger_entries SET status='PAID', paid_at=now() WHERE settlement_id=$1 AND status='APPROVED'`, [s.id]);
    }
    await q.query(`UPDATE commission_settlements SET status='PAID', paid_at=now() WHERE payout_batch_id=$1`, [batchId]);
    const r = (await q.query(`UPDATE commission_payout_batches SET status='PAID', paid_at=now(), confirmed_by=$2 WHERE id=$1 RETURNING id, batch_no, period, status, total_minor, statement_count, paid_at`, [batchId, actor])).rows[0]!;
    await audit(q, actor, 'commission', batchId, 'PAYOUT_CONFIRMED', { statements: sts.length });
    return r;
  });
}

// ───────────────────────── the scheduled workflow ─────────────────────────
export const previousPeriod = (asOf: string) => { const d = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

/**
 * The daily commission job. Approves earnings whose hold has passed and takes back commission for services that ended without it. On the first of the month, when
 * the automatic close is switched on, it also closes the month just ended: accelerators and bonuses, then statements. Safe to run again.
 */
export async function runCommissionDaily(db: Db, o: { asOf?: string; actor?: string; force?: boolean } = {}) {
  const asOf = o.asOf ?? today();
  const actor = o.actor ?? 'commission-job';
  const approved = await db.tx((q) => approveDue(q, asOf));
  const swept = await db.tx((q) => sweepClawbacks(q, asOf));
  let closed: { period: string; accelerators: number; bonuses: number; issued: number } | null = null;
  if (asOf.endsWith('-01') && ((await getCommissionSettings(db)).autoClose || o.force)) closed = await closePeriod(db, previousPeriod(asOf), actor);
  return { asOf, approved, clawbacks: swept, closed };
}

/** Closes a month: approve what is due, pay accelerators and bonuses, then issue statements. */
export async function closePeriod(db: Db, per: string, actor: string, asOf: string = today()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(per)) throw invalid('the period is YYYY-MM');
  await db.tx((q) => approveDue(q, asOf));
  const t = await db.tx((q) => trueUpPeriod(q, per, actor));
  const s = await generateStatements(db, per, actor);
  return { period: per, accelerators: t.accelerators, bonuses: t.bonuses, issued: s.issued, carriedForward: s.carriedForward };
}
