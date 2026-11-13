import { csvCell } from './csv.js';
import type { Queryable, Row } from './db.js';
import { invalid } from './errors.js';
import { CASES_FROM, displayNames, QUEUE_SQL } from './kyc-list.js';
import { getOfficerStatus, loadReviewers } from './kyc-review.js';
import { getRegional } from './settings.js';
import { getStoreSettings } from './store-settings.js';

/**
 * Officer KPIs, computed from the case timeline (`kyc_case_events`), so a case that was reopened and decided again counts for each decision, and a case that moved
 * between officers counts for the one who decided it. Only decisions by people count (automatic approvals and rejections are not an officer's work).
 *
 *  decided        approvals + rejections + sent back, by the officer who made the decision (on behalf of an assignee counts for whoever pressed the button)
 *  minutes        from the moment the case was assigned to the officer (else first opened, else submitted) to the decision
 *  slaMetPct      decisions made no later than the review target after submission, as a share of decisions that have the information (not decisions imported before this feature)
 *  overdueAtDecision   decisions made after the target
 *  escalated      cases that went up from the officer: sent by them, or taken from them automatically because they were overdue
 *  reopened       decisions of the officer that a supervisor later reopened (counted when it is reopened)
 *  assigned       new cases that came to the officer: assigned, reassigned, claimed, or escalated to them
 *  qaAgreePct     of the officer's approvals that another officer checked, the share that was agreed with
 *  open, oldestOpenHours   what they hold right now (not limited to the period)
 * Buckets are days, weeks (starting Monday) or months in the deployment's regional time zone (Settings, Regional).
 */
export interface ReportTotals { decided: number; approved: number; rejected: number; returned: number; escalated: number; reopened: number; assigned: number; avgMinutes: number | null; medianMinutes: number | null; slaMetPct: number | null; overdueAtDecision: number; qaAgreePct: number | null; open: number; oldestOpenHours: number | null }
export interface ReportPoint { bucket: string; decided: number; approved: number; rejected: number; returned: number; avgMinutes: number | null }
export interface OfficerReportRow { username: string; displayName: string; totals: ReportTotals; series: ReportPoint[] }
export interface OfficerReport { period: { from: string; to: string; by: 'day' | 'week' | 'month'; tz: string }; officers: OfficerReportRow[]; team: { totals: ReportTotals; series: ReportPoint[] }; buckets: string[] }
export interface ReportQuery { from?: string; to?: string; by?: 'day' | 'week' | 'month'; officer?: string; source?: string; tz?: string }

const MAX_BUCKETS = 400;
const r1 = (n: unknown): number | null => (n == null ? null : Math.round(Number(n) * 10) / 10);
const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => ymd(new Date(parse(s).getTime() + n * 86_400_000));
const monday = (s: string) => addDays(s, -((parse(s).getUTCDay() + 6) % 7));

/** The first day of every bucket from `from` to `to`, zero-filled series depend on it. */
export function bucketsBetween(from: string, to: string, by: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  if (by === 'day') for (let d = from; d <= to && out.length <= MAX_BUCKETS; d = addDays(d, 1)) out.push(d);
  else if (by === 'week') for (let d = monday(from); d <= to && out.length <= MAX_BUCKETS; d = addDays(d, 7)) out.push(d);
  else for (let y = +from.slice(0, 4), m = +from.slice(5, 7); `${y}-${String(m).padStart(2, '0')}-01` <= to && out.length <= MAX_BUCKETS; m === 12 ? (y++, m = 1) : m++) out.push(`${y}-${String(m).padStart(2, '0')}-01`);
  return out;
}

async function zone(q: Queryable, asked?: string): Promise<string> {
  const tz = asked || (await getRegional(q)).timezone || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}
const localToday = async (q: Queryable, tz: string): Promise<string> => (await q.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0]!.d as string;

const EMPTY: ReportTotals = { decided: 0, approved: 0, rejected: 0, returned: 0, escalated: 0, reopened: 0, assigned: 0, avgMinutes: null, medianMinutes: null, slaMetPct: null, overdueAtDecision: 0, qaAgreePct: null, open: 0, oldestOpenHours: null };

export async function officerReport(q: Queryable, o: ReportQuery = {}): Promise<OfficerReport> {
  const by = o.by ?? 'day';
  if (!['day', 'week', 'month'].includes(by)) throw invalid('The report is by day, week or month.');
  const tz = await zone(q, o.tz);
  const today = await localToday(q, tz);
  const to = o.to ?? today;
  const from = o.from ?? (by === 'day' ? addDays(to, -6) : by === 'week' ? addDays(monday(to), -49) : `${addDays(to, -150).slice(0, 7)}-01`);
  for (const [v, n] of [[from, 'from'], [to, 'to']] as const) if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw invalid(`${n} is a date as YYYY-MM-DD.`);
  if (from > to) throw invalid('The report starts after it ends.');
  const buckets = bucketsBetween(from, to, by);
  if (buckets.length > MAX_BUCKETS) throw invalid(`That is more than ${MAX_BUCKETS} ${by}s; choose a shorter period.`);
  const officer = o.officer?.trim().toLowerCase() || null;
  const source = o.source || null;
  const params = [tz, from, to, source, officer];
  const range = `e.at >= ($2::date)::timestamp AT TIME ZONE $1 AND e.at < (($3::date + 1)::timestamp AT TIME ZONE $1) AND ($4::text IS NULL OR k.source = $4)`;
  const bucket = `to_char(date_trunc('${by}', e.at AT TIME ZONE $1), 'YYYY-MM-DD')`;

  const decisions = (await q.query(
    `SELECT GROUPING(u, b) AS g, u, b, count(*)::int AS decided, count(*) FILTER (WHERE dec='APPROVE')::int AS approved, count(*) FILTER (WHERE dec='REJECT')::int AS rejected, count(*) FILTER (WHERE dec='RETURN')::int AS returned,
            avg(minutes) AS avg_minutes, percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) AS median_minutes,
            count(*) FILTER (WHERE sla)::int AS met, count(*) FILTER (WHERE sla IS NOT NULL)::int AS judged, count(*) FILTER (WHERE sla = false)::int AS overdue
       FROM (SELECT e.actor AS u, ${bucket} AS b, e.detail->>'decision' AS dec, (e.detail->>'minutes')::numeric AS minutes, (e.detail->>'withinSla')::boolean AS sla
               FROM kyc_case_events e JOIN kyc_cases k ON k.id = e.case_id
              WHERE e.action IN ('DECIDED','RETURNED') AND e.detail->>'auto' IS DISTINCT FROM 'true' AND ${range} AND ($5::text IS NULL OR lower(e.actor) = $5)) d
      GROUP BY GROUPING SETS ((u, b), (u), (b), ())`, params)).rows;

  const others = (await q.query(
    `SELECT m, u, count(*)::int AS n, count(*) FILTER (WHERE agree)::int AS agree FROM (
        SELECT 'escalated' AS m, COALESCE(NULLIF(e.actor, 'system'), e.detail->>'from') AS u, false AS agree FROM kyc_case_events e JOIN kyc_cases k ON k.id = e.case_id WHERE e.action = 'ESCALATED' AND ${range}
        UNION ALL SELECT 'reopened', e.detail->>'decidedBy', false FROM kyc_case_events e JOIN kyc_cases k ON k.id = e.case_id WHERE e.action = 'REOPENED' AND ${range}
        UNION ALL SELECT 'assigned', e.target, false FROM kyc_case_events e JOIN kyc_cases k ON k.id = e.case_id WHERE e.action IN ('ASSIGNED','REASSIGNED','CLAIMED','ESCALATED') AND e.target IS NOT NULL AND ${range}
        UNION ALL SELECT 'qa', e.target, e.detail->>'result' = 'AGREE' FROM kyc_case_events e JOIN kyc_cases k ON k.id = e.case_id WHERE e.action = 'QA_DONE' AND e.target IS NOT NULL AND ${range}
     ) x WHERE u IS NOT NULL AND ($5::text IS NULL OR lower(u) = $5) GROUP BY m, u`, params)).rows;

  const open = (await q.query(
    `SELECT k.assigned_to AS u, count(*)::int AS n, min(COALESCE(k.submitted_at, k.created_at)) AS oldest FROM ${CASES_FROM}
      WHERE k.status='PENDING' AND k.assigned_to IS NOT NULL AND ${QUEUE_SQL} GROUP BY k.assigned_to`)).rows;

  // Everyone with work in the period, everyone who holds cases, and every active reviewer (so a quiet officer shows a row of zeros).
  const key = (u: string) => u.toLowerCase();
  const names = new Map<string, string>();
  const reviewers = await loadReviewers(q, {});
  for (const r of reviewers) if (!r.isSuperuser) names.set(key(r.username), r.username);
  for (const r of decisions) if (r.g === 1) names.set(key(r.u), names.get(key(r.u)) ?? r.u);
  for (const r of others) names.set(key(r.u), names.get(key(r.u)) ?? r.u);
  for (const r of open) names.set(key(r.u), names.get(key(r.u)) ?? r.u);
  if (officer) for (const k of [...names.keys()]) if (k !== officer) names.delete(k);
  const display = await displayNames(q, [...names.values()]);

  const fill = (rows: Row[]): ReportPoint[] => {
    const by = new Map(rows.map((r) => [r.b as string, r]));
    return buckets.map((b) => { const r = by.get(b); return { bucket: b, decided: r?.decided ?? 0, approved: r?.approved ?? 0, rejected: r?.rejected ?? 0, returned: r?.returned ?? 0, avgMinutes: r1(r?.avgMinutes) }; });
  };
  const totalsOf = (d: Row | undefined): ReportTotals => ({ ...EMPTY, decided: d?.decided ?? 0, approved: d?.approved ?? 0, rejected: d?.rejected ?? 0, returned: d?.returned ?? 0, avgMinutes: r1(d?.avgMinutes), medianMinutes: r1(d?.medianMinutes), slaMetPct: pct(d?.met ?? 0, d?.judged ?? 0), overdueAtDecision: d?.overdue ?? 0 });
  const nowMs = Date.now();
  const officers: OfficerReportRow[] = [...names.values()].map((u) => {
    const totals = totalsOf(decisions.find((r) => r.g === 1 && key(r.u) === key(u)));
    const n = (m: string) => others.find((r) => r.m === m && key(r.u) === key(u));
    totals.escalated = n('escalated')?.n ?? 0; totals.reopened = n('reopened')?.n ?? 0; totals.assigned = n('assigned')?.n ?? 0;
    totals.qaAgreePct = pct(n('qa')?.agree ?? 0, n('qa')?.n ?? 0);
    const op = open.find((r) => key(r.u) === key(u));
    totals.open = op?.n ?? 0; totals.oldestOpenHours = op ? r1((nowMs - Date.parse(op.oldest)) / 3_600_000) : null;
    return { username: u, displayName: display.get(key(u)) ?? u, totals, series: fill(decisions.filter((r) => r.g === 0 && key(r.u) === key(u))) };
  }).sort((a, b) => b.totals.decided - a.totals.decided || a.displayName.localeCompare(b.displayName));

  const team = totalsOf(decisions.find((r) => r.g === 3));
  for (const k of ['escalated', 'reopened', 'assigned', 'open'] as const) team[k] = officers.reduce((s, x) => s + x.totals[k], 0);
  const qa = others.filter((r) => r.m === 'qa');
  team.qaAgreePct = pct(qa.reduce((s, r) => s + r.agree, 0), qa.reduce((s, r) => s + r.n, 0));
  const olds = officers.map((x) => x.totals.oldestOpenHours).filter((x): x is number => x != null);
  team.oldestOpenHours = olds.length ? Math.max(...olds) : null;
  return { period: { from, to, by, tz }, officers, team: { totals: team, series: fill(decisions.filter((r) => r.g === 2)) }, buckets };
}

// ───────────────────────── CSV ─────────────────────────
const safe = (v: unknown): string => { const s = v == null ? '' : String(v); return csvCell(/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s); };
/** One flat table: a row per officer per bucket, a TOTAL row per officer, and the same for the team. */
export function officerReportCsv(r: OfficerReport): string {
  const head = ['officer', 'name', 'bucket', 'decided', 'approved', 'rejected', 'returned', 'avg_minutes', 'median_minutes', 'sla_met_pct', 'overdue_at_decision', 'escalated', 'reopened', 'assigned', 'qa_agree_pct', 'open', 'oldest_open_hours'];
  const lines = [head.join(',')];
  const add = (u: string, name: string, totals: ReportTotals, series: ReportPoint[]) => {
    for (const p of series) lines.push([u, name, p.bucket, p.decided, p.approved, p.rejected, p.returned, p.avgMinutes, '', '', '', '', '', '', '', '', ''].map(safe).join(','));
    const t = totals;
    lines.push([u, name, 'TOTAL', t.decided, t.approved, t.rejected, t.returned, t.avgMinutes, t.medianMinutes, t.slaMetPct, t.overdueAtDecision, t.escalated, t.reopened, t.assigned, t.qaAgreePct, t.open, t.oldestOpenHours].map(safe).join(','));
  };
  for (const o of r.officers) add(o.username, o.displayName, o.totals, o.series);
  add('TEAM', 'Team', r.team.totals, r.team.series);
  return lines.join('\r\n') + '\r\n';
}

// ───────────────────────── "my numbers" and the workload ─────────────────────────
export interface DoneCounts { decided: number; approved: number; rejected: number; returned: number }
export interface OfficerMe { username: string; away: boolean; awayUntil: string | null; today: DoneCounts; week: DoneCounts; month: DoneCounts; open: number; overdue: number; avgMinutesWeek: number | null }

/** The signed-in officer's own numbers: today, this week (from Monday) and this month, in the regional time zone. */
export async function officerMe(q: Queryable, username: string): Promise<OfficerMe> {
  const tz = await zone(q);
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const st = await getOfficerStatus(q, username);
  const r = (await q.query(
    `WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS d, date_trunc('week', now() AT TIME ZONE $2) AT TIME ZONE $2 AS w, date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2 AS m),
          ev AS (SELECT e.at, e.detail->>'decision' AS dec, (e.detail->>'minutes')::numeric AS minutes FROM kyc_case_events e, b
                  WHERE e.actor = $1 AND e.action IN ('DECIDED','RETURNED') AND e.detail->>'auto' IS DISTINCT FROM 'true' AND e.at >= LEAST(b.w, b.m))
     SELECT ${(['d', 'w', 'm'] as const).map((k) => `count(*) FILTER (WHERE at >= b.${k})::int AS ${k}_decided, count(*) FILTER (WHERE at >= b.${k} AND dec='APPROVE')::int AS ${k}_approved, count(*) FILTER (WHERE at >= b.${k} AND dec='REJECT')::int AS ${k}_rejected, count(*) FILTER (WHERE at >= b.${k} AND dec='RETURN')::int AS ${k}_returned`).join(', ')},
            avg(minutes) FILTER (WHERE at >= b.w) AS avg_week FROM ev, b`, [username, tz])).rows[0]!;
  const load = (await q.query(
    `SELECT count(*)::int AS open, count(*) FILTER (WHERE COALESCE(k.submitted_at, k.created_at) < now() - make_interval(hours => $2::int))::int AS overdue FROM ${CASES_FROM}
      WHERE k.status='PENDING' AND lower(k.assigned_to) = lower($1) AND ${QUEUE_SQL}`, [username, sla])).rows[0]!;
  const c = (k: string): DoneCounts => ({ decided: r[`${k}Decided`], approved: r[`${k}Approved`], rejected: r[`${k}Rejected`], returned: r[`${k}Returned`] });
  return { username, away: st.away, awayUntil: st.awayUntil, today: c('d'), week: c('w'), month: c('m'), open: load.open, overdue: load.overdue, avgMinutesWeek: r1(r.avgWeek) };
}

export interface Workload { officers: Array<{ username: string; displayName: string; away: boolean; open: number; overdue: number; oldestHours: number | null; decidedToday: number; decidedWeek: number }>; unassigned: number; unassignedOverdue: number; oldestUnassignedHours: number | null }
/** Who holds how much right now, and what nobody holds. */
export async function kycWorkload(q: Queryable): Promise<Workload> {
  const tz = await zone(q);
  const sla = (await getStoreSettings(q)).kycSlaHours;
  const held = (await q.query(
    `SELECT k.assigned_to AS u, count(*)::int AS open, count(*) FILTER (WHERE COALESCE(k.submitted_at, k.created_at) < now() - make_interval(hours => $1::int))::int AS overdue,
            extract(epoch FROM now() - min(COALESCE(k.submitted_at, k.created_at))) / 3600 AS oldest
       FROM ${CASES_FROM} WHERE k.status='PENDING' AND ${QUEUE_SQL} GROUP BY k.assigned_to`, [sla])).rows;
  const done = (await q.query(
    `WITH b AS (SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS d, date_trunc('week', now() AT TIME ZONE $1) AT TIME ZONE $1 AS w)
     SELECT e.actor AS u, count(*) FILTER (WHERE e.at >= b.d)::int AS today, count(*)::int AS week FROM kyc_case_events e, b
      WHERE e.action IN ('DECIDED','RETURNED') AND e.detail->>'auto' IS DISTINCT FROM 'true' AND e.at >= b.w GROUP BY e.actor`, [tz])).rows;
  const key = (u: string) => u.toLowerCase();
  const reviewers = (await loadReviewers(q, {})).filter((r) => !r.isSuperuser || held.some((h) => h.u && key(h.u) === key(r.username)));
  const names = new Map(reviewers.map((r) => [key(r.username), r]));
  const officers = reviewers.map((r) => {
    const h = held.find((x) => x.u && key(x.u) === key(r.username)), d = done.find((x) => key(x.u) === key(r.username));
    return { username: r.username, displayName: r.displayName, away: r.away, open: h?.open ?? 0, overdue: h?.overdue ?? 0, oldestHours: h ? r1(h.oldest) : null, decidedToday: d?.today ?? 0, decidedWeek: d?.week ?? 0 };
  });
  // Cases held by someone who is no longer a reviewer still show, so the numbers add up to the queue.
  for (const h of held) if (h.u && !names.has(key(h.u))) officers.push({ username: h.u, displayName: h.u, away: false, open: h.open, overdue: h.overdue, oldestHours: r1(h.oldest), decidedToday: 0, decidedWeek: 0 });
  const pool = held.find((h) => !h.u);
  return { officers: officers.sort((a, b) => b.open - a.open || a.displayName.localeCompare(b.displayName)), unassigned: pool?.open ?? 0, unassignedOverdue: pool?.overdue ?? 0, oldestUnassignedHours: pool ? r1(pool.oldest) : null };
}
