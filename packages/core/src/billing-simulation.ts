import { audit } from './audit.js';
import { draftCycleBill, priceDraft, streamOfLine, type DraftLine } from './billing.js';
import { monthlyFee } from './catalog.js';
import { GL } from './config.js';
import { addDays, addMonths, dayOf, diffDays, fmt, today, toDate, type DateStr } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { getLifecycleSettings } from './lifecycle-config.js';
import { closingStatement, etcQuoteForService, scenarioOfTermination, type TerminationOptions } from './lifecycle.js';
import { decodeCursor, encodeCursor, pageSize, type Page } from './paging.js';

/**
 * The billing sandbox: forward-looking answers computed with the same code that bills, and written nowhere (unless the person saves the answer).
 *  - PROJECTION   what an account will be billed over the next months (up to 60), the device balance falling bill by bill, the final instalment, and what
 *                 leaving at each bill would cost;
 *  - TERMINATION  the exact amount a customer would owe if a service ended now (or on a date): early-termination charge with its waivers, the part of the month
 *                 not yet billed, usage not yet billed, tax, and the deposit: the figure an agent can quote;
 *  - PLAN_CHANGE  what changing a service's plan part-way through a bill period does to the next statement.
 * A projection holds today's prices, contracts and charges still; it does not know about price changes, new services or usage that will happen.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROJECTION_MAX_MONTHS = 60;
const ETC_SERVICES_MAX = 200;

/** A service by its id, or by its number or circuit id (the live one if the number has been used before). */
export async function resolveService(q: Queryable, ref: string): Promise<Row> {
  const r = ref.trim();
  if (!r) throw invalid('Give a service id or number.');
  const s = UUID.test(r) ? (await q.query('SELECT * FROM services WHERE id=$1', [r.toLowerCase()])).rows[0]
    : (await q.query(`SELECT * FROM services WHERE identifier=$1 ORDER BY (status='TERMINATED'), updated_at DESC LIMIT 1`, [r.startsWith('+') || !/^\d{8,}$/.test(r) ? r : `+${r}`])).rows[0];
  if (!s) throw notFound('service', r);
  return s;
}
async function accountOf(q: Queryable, ref: string): Promise<Row> {
  const r = ref.trim();
  const a = UUID.test(r) ? (await q.query('SELECT * FROM accounts WHERE id=$1', [r.toLowerCase()])).rows[0] : null;
  if (a) return a;
  const s = await resolveService(q, r).catch(() => null);
  const byService = s ? (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0] : null;
  if (!byService) throw notFound('account', r);
  return byService;
}

const lineOut = (l: DraftLine & { net: number; tax: number }) => ({ kind: l.kind, stream: streamOfLine(l), description: l.description, serviceId: l.serviceId ?? null, netMinor: l.net, taxMinor: l.tax });

/** The first date on or after `from` that is a bill date of this account (daily accounts: every day), skipping a period already billed. */
async function firstBillDate(q: Queryable, a: Row, from: DateStr): Promise<DateStr> {
  let d = from;
  if (a.billCycleDay !== null) { for (let i = 0; i < 40 && dayOf(d) !== a.billCycleDay; i++) d = addDays(d, 1); }
  const periodStart = a.billCycleDay === null ? addDays(d, -1) : addMonths(d, -1);
  const billed = (await q.query(`SELECT 1 FROM invoices WHERE account_id=$1 AND kind='CYCLE' AND period_start=$2 AND period_end=$3`, [a.id, periodStart, addDays(d, -1)])).rows.length;
  return billed ? (a.billCycleDay === null ? addDays(d, 1) : addMonths(d, 1)) : d;
}

// ───────────────────────── projection ─────────────────────────
export interface ProjectionMonth {
  index: number; billDate: DateStr; periodStart: DateStr; periodEnd: DateStr;
  netMinor: number; taxMinor: number; totalMinor: number;
  recurringMinor: number; instalmentMinor: number; otherMinor: number;
  /** What is still to pay on devices after this bill. */
  equipmentBalanceMinor: number;
  cumulativeMinor: number;
  /** What it would cost to end every contract on this bill date (early-termination charges). */
  etcIfEndedMinor: number;
  lines: Array<ReturnType<typeof lineOut>>;
}

/** What an account will be billed over the next `months` bills (up to 60; for a daily-cycle account the "months" are days). */
export async function projectAccount(q: Queryable, ref: string, o: { months: number; from?: DateStr }): Promise<Row> {
  const months = Math.floor(o.months);
  if (!(months >= 1 && months <= PROJECTION_MAX_MONTHS)) throw invalid(`Project 1 to ${PROJECTION_MAX_MONTHS} months ahead.`);
  const a = await accountOf(q, ref);
  const first = await firstBillDate(q, a, o.from ?? today());
  const daily = a.billCycleDay === null;
  const contracts = (await q.query(`SELECT * FROM services WHERE account_id=$1 AND status <> 'TERMINATED' AND contract_term_months > 0 AND contract_start IS NOT NULL ORDER BY identifier LIMIT $2`, [a.id, ETC_SERVICES_MAX + 1])).rows;
  const etcServices = contracts.slice(0, ETC_SERVICES_MAX);
  const all = (await q.query(`SELECT * FROM service_charges WHERE account_id=$1 AND remaining_cycles > 0`, [a.id])).rows;
  const balanceNow = all.filter((c) => c.kind === 'INSTALLMENT').reduce((s, c) => s + Number(c.amountMinor) * c.remainingCycles, 0);
  const out: ProjectionMonth[] = [];
  let cumulative = 0, lastInstalment = -1;
  for (let i = 0; i < months; i++) {
    const billDate = daily ? addDays(first, i) : addMonths(first, i);
    const d = await draftCycleBill(q, a, billDate, { monthOffset: i });
    const p = await priceDraft(q, a, d.lines);
    const lines = p.priced.map(lineOut);
    const sum = (f: (l: ReturnType<typeof lineOut>) => boolean) => lines.filter(f).reduce((s, l) => s + l.netMinor + l.taxMinor, 0);
    const recurring = sum((l) => l.kind === 'RECURRING'), instalment = sum((l) => l.kind === 'INSTALLMENT');
    if (instalment > 0) lastInstalment = i;
    const balance = all.filter((c) => c.kind === 'INSTALLMENT').reduce((s, c) => s + Number(c.amountMinor) * Math.max(0, c.remainingCycles - (i + 1)), 0);
    let etc = 0;
    for (const s of etcServices) etc += (await etcQuoteForService(q, s, toDate(billDate))).chargeMinor;
    cumulative += p.net + p.tax;
    out.push({ index: i + 1, billDate, periodStart: d.periodStart, periodEnd: d.periodEnd, netMinor: p.net, taxMinor: p.tax, totalMinor: p.net + p.tax, recurringMinor: recurring, instalmentMinor: instalment,
      otherMinor: p.net + p.tax - recurring - instalment, equipmentBalanceMinor: balance, cumulativeMinor: cumulative, etcIfEndedMinor: etc, lines });
  }
  const notes = ['Prices, contracts and instalments are as they are today: price changes, new services, plan changes and usage are not known.'];
  if (contracts.length > ETC_SERVICES_MAX) notes.push(`Early-termination figures cover the first ${ETC_SERVICES_MAX} contracts of ${contracts.length}.`);
  if (daily) notes.push('This account is billed daily: each "month" below is one day.');
  const instalmentTotal = out.reduce((s, m) => s + m.instalmentMinor, 0);
  return {
    account: { id: a.id, name: a.name, currency: a.currency, billCycleDay: a.billCycleDay },
    from: first, months: out,
    totals: { netMinor: out.reduce((s, m) => s + m.netMinor, 0), taxMinor: out.reduce((s, m) => s + m.taxMinor, 0), totalMinor: cumulative, recurringMinor: out.reduce((s, m) => s + m.recurringMinor, 0), instalmentMinor: instalmentTotal, otherMinor: out.reduce((s, m) => s + m.otherMinor, 0) },
    equipmentBalanceNowMinor: balanceNow,
    // The bill that finishes the device payments, and whether the horizon reaches it.
    finalInstalment: lastInstalment >= 0 ? { index: lastInstalment + 1, billDate: out[lastInstalment]!.billDate, billTotalMinor: out[lastInstalment]!.totalMinor, instalmentMinor: out[lastInstalment]!.instalmentMinor, balanceAfterMinor: out[lastInstalment]!.equipmentBalanceMinor, settled: out[lastInstalment]!.equipmentBalanceMinor === 0 } : null,
    contracts: contracts.map((s) => ({ serviceId: s.id, identifier: s.identifier, offerId: s.offerId, contractStart: fmt(new Date(s.contractStart)), termMonths: s.contractTermMonths, endsOn: addMonths(fmt(new Date(s.contractStart)), s.contractTermMonths) })).slice(0, ETC_SERVICES_MAX),
    notes,
  };
}

// ───────────────────────── termination ─────────────────────────
export interface TerminationPreviewInput { scenario?: string; date?: string; unbilledUsageMinor?: number; etcAdjust?: TerminationOptions['etcAdjust']; refundDeposit?: boolean }

/**
 * What a customer would owe if this service ended: the same calculation the termination itself uses (`closingStatement`), without ending anything.
 * `payNowMinor` is the closing invoice less any deposit that would be applied to it.
 */
export async function previewTermination(q: Queryable, ref: string, i: TerminationPreviewInput = {}, actor = 'simulation'): Promise<Row> {
  const s = await resolveService(q, ref);
  if (s.status === 'TERMINATED') throw rejected('This service has already ended.');
  const when = i.date ? new Date(`${i.date}T12:00:00Z`) : new Date();
  if (Number.isNaN(when.getTime())) throw invalid('The date is YYYY-MM-DD.');
  if (fmt(when) < today()) throw invalid('A termination cannot be dated in the past.');
  const cfg = await getLifecycleSettings(q);
  const cs = await closingStatement(q, s, { unbilledUsageMinor: i.unbilledUsageMinor, etcAdjust: i.etcAdjust, scenario: i.scenario as never }, cfg, actor, when);
  const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0]!;
  const p = await priceDraft(q, acct, cs.lines);
  const quote = s.contractTermMonths > 0 && s.contractStart ? await etcQuoteForService(q, s, when, { scenario: scenarioOfTermination({ scenario: i.scenario }) }) : null;
  const charges = (await q.query(`SELECT description, amount_minor, remaining_cycles FROM service_charges WHERE service_id=$1 AND kind='INSTALLMENT' AND remaining_cycles > 0`, [s.id])).rows;
  const instalmentBalance = charges.reduce((t, c) => t + Number(c.amountMinor) * c.remainingCycles, 0);
  const total = p.net + p.tax;
  let depositApplied = 0, depositRefund = 0;
  if (i.refundDeposit && Number(acct.depositMinor) > 0) {
    const others = (await q.query(`SELECT 1 FROM services WHERE account_id=$1 AND id<>$2 AND status <> 'TERMINATED' LIMIT 1`, [s.accountId, s.id])).rows.length;
    if (!others) { depositApplied = Math.min(Number(acct.depositMinor), Math.max(total, 0)); depositRefund = Number(acct.depositMinor) - depositApplied; }
  }
  return {
    service: { id: s.id, identifier: s.identifier, type: s.type, offerId: s.offerId, status: s.status, contractStart: s.contractStart ? fmt(new Date(s.contractStart)) : null, contractTermMonths: s.contractTermMonths },
    date: fmt(when), currency: acct.currency,
    etc: { quotedMinor: cs.quoted, chargeMinor: cs.etc, waived: cs.waived, adjustedBy: cs.adjustedBy, recurringMinor: cs.recurringPart, clawbackMinor: cs.clawbackPart, monthsElapsed: quote?.monthsElapsed ?? null, monthsRemaining: quote?.monthsRemaining ?? null, vipMultiplierBps: quote?.vipMultiplierBps ?? null },
    unbilledRecurringMinor: cs.unbilledRecurring, unbilledUsageMinor: cs.usage,
    lines: p.priced.map(lineOut), netMinor: p.net, taxMinor: p.tax, taxName: p.mk.taxName, invoiceTotalMinor: total,
    depositHeldMinor: Number(acct.depositMinor), depositAppliedMinor: depositApplied, depositRefundedMinor: depositRefund,
    payNowMinor: Math.max(0, total - depositApplied),
    // Terminating cancels instalments still to come (see terminateService); what that is, so nobody is surprised by it.
    instalmentBalanceCancelledMinor: instalmentBalance,
    notes: [
      ...(instalmentBalance > 0 ? [`${instalmentBalance} minor units of device instalments are still to come. Ending the service cancels them; the early-termination charge is the only charge for the device.`] : []),
      ...(cs.etc === 0 && cs.quoted === 0 && s.contractTermMonths > 0 ? ['The contract has run its term, or is inside the free period at its end: no early-termination charge.'] : []),
      'Usage the charging system has not reported yet is not known: enter it if you have it.',
    ],
  };
}

// ───────────────────────── plan change ─────────────────────────
export interface PlanChangeInput { newOfferId: string; effectiveDate?: string }

/** What changing a service's plan on a date does to the statement that covers that date, and the one after. */
export async function simulatePlanChange(q: Queryable, ref: string, i: PlanChangeInput): Promise<Row> {
  const s = await resolveService(q, ref);
  if (s.status === 'TERMINATED') throw rejected('This service has ended.');
  if (!i.newOfferId) throw invalid('Choose the new plan.');
  if (i.newOfferId === s.offerId) throw invalid('The service is already on that plan.');
  const load = async (id: string) => {
    const r = (await q.query(`SELECT * FROM catalog_nodes WHERE id=$1 AND level='OFFER'`, [id])).rows[0];
    if (!r) throw notFound('plan', id);
    return { r, node: { id, name: r.name, kind: r.kind, ...r.data } as never };
  };
  const oldO = await load(s.offerId), newO = await load(i.newOfferId);
  if (newO.r.status !== 'ACTIVE') throw rejected(`The plan ${newO.r.name} is not on sale (${String(newO.r.status).toLowerCase()}).`);
  const oldFee = monthlyFee(oldO.node), newFee = monthlyFee(newO.node);
  if (!newFee) throw invalid(`${newO.r.name} has no monthly fee to project.`);
  const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [s.accountId])).rows[0]!;
  const eff = i.effectiveDate ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eff)) throw invalid('The date is YYYY-MM-DD.');
  if (eff < today()) throw invalid('A plan change cannot be dated in the past.');
  // The statement covering the date: the first bill date after it, and the period ending the day before.
  const daily = acct.billCycleDay === null;
  let billDate = addDays(eff, 1);
  if (!daily) { for (let k = 0; k < 40 && dayOf(billDate) !== acct.billCycleDay; k++) billDate = addDays(billDate, 1); }
  const periodStart = daily ? addDays(billDate, -1) : addMonths(billDate, -1), periodEnd = addDays(billDate, -1);
  const days = diffDays(periodEnd, periodStart) + 1;
  const daysOld = Math.max(0, Math.min(days, diffDays(eff, periodStart)));
  const daysNew = days - daysOld;
  const monthly = (f: NonNullable<typeof oldFee>) => f.amount.amountMinor / (f.periodMonths ?? 1);
  const oldMonthly = oldFee ? monthly(oldFee) : 0, newMonthly = monthly(newFee);
  const prorate = (m: number, d: number) => (daily ? Math.round(m / 30) : Math.round((m * d) / days));
  const activated = s.activatedAt ? fmt(new Date(s.activatedAt)) : null;
  const beforeLines: DraftLine[] = [], afterLines: DraftLine[] = [], nextLines: DraftLine[] = [];
  const mk = (o: typeof oldO, f: NonNullable<typeof oldFee>, amount: number, text: string): DraftLine => ({ serviceId: s.id, kind: 'RECURRING', stream: o.r.data?.partnerCode ? 'THIRD_PARTY' : 'SUBSCRIPTION', revenueAccount: GL.SERVICE_REVENUE, taxInclusive: f.taxInclusive, description: text, amountMinor: amount });
  const stay = oldFee && s.status === 'ACTIVE' && (!activated || activated <= periodStart) ? [mk(oldO, oldFee, daily ? Math.round(oldMonthly / 30) : Math.round(oldMonthly), `${oldO.r.name} ${s.identifier} (whole period, if nothing changes)`)] : [];
  if (oldFee && daysOld > 0) beforeLines.push(mk(oldO, oldFee, prorate(oldMonthly, daysOld), `${oldO.r.name} ${s.identifier} (pro-rated ${daysOld}/${days} days, until ${addDays(eff, -1)})`));
  if (daysNew > 0) afterLines.push(mk(newO, newFee, prorate(newMonthly, daysNew), `${newO.r.name} ${s.identifier} (pro-rated ${daysNew}/${days} days, from ${eff})`));
  nextLines.push(mk(newO, newFee, daily ? Math.round(newMonthly / 30) : Math.round(newMonthly), `${newO.r.name} ${s.identifier} (whole period)`));
  const price = async (lines: DraftLine[]) => { const p = await priceDraft(q, acct, lines); return { lines: p.priced.map(lineOut), netMinor: p.net, taxMinor: p.tax, totalMinor: p.net + p.tax }; };
  const baseline = await price(stay), changed = await price([...beforeLines, ...afterLines]), following = await price(nextLines);
  const notes: string[] = [];
  const newTerm = Number(newO.r.data?.contract?.termMonths ?? 0);
  if (s.contractTermMonths > 0 && s.contractStart) {
    const quote = await etcQuoteForService(q, s, toDate(eff), { scenario: 'PLAN_DOWNGRADE', newMonthlyFee: Math.round(newMonthly) });
    if (quote.chargeMinor > 0) notes.push(`The service is on a ${s.contractTermMonths}-month contract with ${quote.monthsRemaining} months to run: changing plan during it may be treated as a change of contract. Ending it on ${eff} would cost ${quote.chargeMinor} minor units.`);
  }
  if (newTerm > 0) notes.push(`${newO.r.name} comes with a ${newTerm}-month contract, which would start on ${eff}.`);
  if (newFee.amount.amountMinor < (oldFee?.amount.amountMinor ?? 0)) notes.push('This is a downgrade: check the contract allows it before promising the customer.');
  return {
    service: { id: s.id, identifier: s.identifier, status: s.status },
    from: { offerId: s.offerId, name: oldO.r.name, monthlyMinor: Math.round(oldMonthly) }, to: { offerId: i.newOfferId, name: newO.r.name, monthlyMinor: Math.round(newMonthly) },
    effectiveDate: eff, currency: acct.currency, statementDate: billDate, periodStart, periodEnd, daysBefore: daysOld, daysAfter: daysNew,
    ifNothingChanges: baseline, withChange: changed, differenceMinor: changed.totalMinor - baseline.totalMinor,
    followingStatement: following, followingDifferenceMinor: following.totalMinor - baseline.totalMinor,
    notes,
  };
}

// ───────────────────────── saving and listing ─────────────────────────
export type SimulationKind = 'PROJECTION' | 'TERMINATION' | 'PLAN_CHANGE';

/** Keeps a simulation (a quote that was given, a forecast): the answer, what was asked, who asked. */
export async function saveSimulation(db: Db, actor: string, kind: SimulationKind, params: Record<string, unknown>, result: Row, title = ''): Promise<Row> {
  const accountId = (result.account?.id as string | undefined) ?? null;
  const serviceId = (result.service?.id as string | undefined) ?? null;
  const acct = accountId ?? (serviceId ? ((await db.query('SELECT account_id FROM services WHERE id=$1', [serviceId])).rows[0]?.accountId as string | undefined) ?? null : null);
  const cd = acct ? Number((await db.query('SELECT bill_cycle_day FROM accounts WHERE id=$1', [acct])).rows[0]?.billCycleDay ?? 0) : 0;
  const summary = kind === 'PROJECTION' ? { totals: result.totals, months: result.months.length, from: result.from, finalInstalment: result.finalInstalment, equipmentBalanceNowMinor: result.equipmentBalanceNowMinor }
    : kind === 'TERMINATION' ? { date: result.date, payNowMinor: result.payNowMinor, etcMinor: result.etc.chargeMinor, invoiceTotalMinor: result.invoiceTotalMinor, identifier: result.service.identifier }
    : { effectiveDate: result.effectiveDate, differenceMinor: result.differenceMinor, from: result.from.name, to: result.to.name, identifier: result.service.identifier };
  return db.tx(async (q) => {
    const run = (await q.query(`INSERT INTO simulation_runs (kind, title, account_id, service_id, cycle_day, params, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [kind, title.slice(0, 120), acct, serviceId, cd, JSON.stringify(params), JSON.stringify(summary), actor])).rows[0]!;
    const rows: Array<Record<string, unknown>> = kind === 'PROJECTION'
      ? (result.months as ProjectionMonth[]).map((m, n) => ({ seq: n + 1, kind: 'BILL', date: m.billDate, ps: m.periodStart, pe: m.periodEnd, net: m.netMinor, tax: m.taxMinor, total: m.totalMinor, bal: m.equipmentBalanceMinor, lines: m.lines }))
      : kind === 'TERMINATION' ? [{ seq: 1, kind: 'SETTLEMENT', date: result.date, ps: null, pe: null, net: result.netMinor, tax: result.taxMinor, total: result.invoiceTotalMinor, bal: null, lines: result.lines }]
      : [{ seq: 1, kind: 'PLAN_CHANGE', date: result.statementDate, ps: result.periodStart, pe: result.periodEnd, net: result.withChange.netMinor, tax: result.withChange.taxMinor, total: result.withChange.totalMinor, bal: null, lines: result.withChange.lines }];
    for (const r of rows) await q.query(`INSERT INTO simulation_ledger (cycle_day, run_id, seq, kind, bill_date, period_start, period_end, net_minor, tax_minor, total_minor, balance_minor, lines) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [cd, run.id, r.seq, r.kind, r.date, r.ps, r.pe, r.net, r.tax, r.total, r.bal, JSON.stringify(r.lines)]);
    await audit(q, actor, 'billing', run.id, 'SIMULATION_SAVED', { kind, title });
    return run;
  });
}

export async function listSimulations(q: Queryable, f: { kind?: string; accountId?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 20, 100);
  const cur = decodeCursor(f.cursor, 2);
  const rows = (await q.query(
    `SELECT *, created_at::text AS cursor_ts FROM simulation_runs WHERE ($1::text IS NULL OR kind=$1) AND ($2::uuid IS NULL OR account_id=$2) AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $5`, [f.kind ?? null, f.accountId ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1])).rows;
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return { items: page.map(({ cursorTs: _t, ...r }) => r), nextCursor: rows.length > limit && last ? encodeCursor([last.cursorTs, last.id]) : null };
}
export async function getSimulation(q: Queryable, id: string): Promise<Row> {
  const r = UUID.test(id) ? (await q.query('SELECT * FROM simulation_runs WHERE id=$1', [id])).rows[0] : null;
  if (!r) throw notFound('simulation', id);
  const rows = (await q.query(`SELECT seq, kind, bill_date::text AS bill_date, period_start::text AS period_start, period_end::text AS period_end, net_minor, tax_minor, total_minor, balance_minor, lines FROM simulation_ledger WHERE cycle_day=$1 AND run_id=$2 ORDER BY seq`, [r.cycleDay, id])).rows;
  return { ...r, rows };
}
export async function deleteSimulation(db: Db, actor: string, id: string): Promise<void> {
  const r = (await db.query('SELECT created_by FROM simulation_runs WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('simulation', id);
  await db.query('DELETE FROM simulation_runs WHERE id=$1', [id]);
  await audit(db, actor, 'billing', id, 'SIMULATION_DELETED', {});
}
/** Simulations are scratch work: this removes the ones older than `days`. */
export async function purgeSimulations(db: Db, days = 90): Promise<number> {
  return (await db.query(`DELETE FROM simulation_runs WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)])).rowCount;
}
