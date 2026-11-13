import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { bucketsBetween, kycWorkload, officerMe, officerReport, officerReportCsv } from './kyc-report.js';
import { setKycReviewSettings } from './kyc-review.js';
import { addCase, addOfficer } from './kyc-review-helpers.js';
import { freshDb } from './test-helpers.js';

describe('report buckets', () => {
  it('lists days, weeks that start on Monday, and months', () => {
    expect(new Date('2026-03-09T00:00:00Z').getUTCDay()).toBe(1);
    expect(bucketsBetween('2026-03-02', '2026-03-05', 'day')).toEqual(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
    expect(bucketsBetween('2026-03-04', '2026-03-16', 'week')).toEqual(['2026-03-02', '2026-03-09', '2026-03-16']);
    expect(bucketsBetween('2026-03-08', '2026-03-09', 'week')).toEqual(['2026-03-02', '2026-03-09']);
    expect(bucketsBetween('2025-11-20', '2026-02-02', 'month')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(bucketsBetween('2026-02-27', '2026-03-01', 'day')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});

describe('officer KPIs', () => {
  let db: Db;
  const case_ = async (source = 'CRM_ORDER') => addCase(db, { source, enqueue: false });
  const ev = (caseId: string, actor: string, action: string, at: string, detail: Record<string, unknown> = {}, target: string | null = null) =>
    db.query(`INSERT INTO kyc_case_events (case_id, at, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5,$6)`, [caseId, at, actor, action, target, JSON.stringify(detail)]);
  const decided = (caseId: string, actor: string, at: string, decision: string, minutes: number | null, within: boolean | null, extra: Record<string, unknown> = {}) =>
    ev(caseId, actor, decision === 'RETURN' ? 'RETURNED' : 'DECIDED', at, { decision, ...(minutes === null ? { backfilled: true } : { minutes, withinSla: within, overdue: !within }), ...extra });

  beforeAll(async () => {
    db = await freshDb();
    await addOfficer(db, 'rp.a', ['compliance'], { displayName: 'Ana Lim' });
    await addOfficer(db, 'rp.b', ['compliance'], { displayName: '=HYPERLINK("x")' });
    await addOfficer(db, 'rp.quiet', ['compliance'], { displayName: 'Quiet Qi' });
    await setKycReviewSettings(db, 'root', { autoAssign: false });
    const store = await case_('STOREFRONT'), c = await case_();
    // Singapore is UTC+8: 02:00Z is 10:00 local; 15:30Z on the 8th is 23:30 Sunday local; 16:30Z is 00:30 Monday local
    await decided(store, 'rp.a', '2026-03-02T02:00:00Z', 'APPROVE', 10, true);
    await decided(store, 'rp.a', '2026-03-02T07:00:00Z', 'REJECT', 20, true);
    await decided(c, 'rp.a', '2026-03-08T15:30:00Z', 'APPROVE', 60, false);
    await decided(c, 'rp.a', '2026-03-08T16:30:00Z', 'RETURN', 30, true);
    await ev(c, 'auto-rules', 'DECIDED', '2026-03-03T03:00:00Z', { decision: 'APPROVE', auto: true });
    await decided(c, 'rp.b', '2026-03-03T03:00:00Z', 'APPROVE', 40, true);
    await decided(c, 'rp.b', '2026-03-03T04:00:00Z', 'APPROVE', null, null);                       // decided before the review workflow existed
    await ev(c, 'rp.a', 'ESCALATED', '2026-03-04T03:00:00Z', { reason: 'help' }, 'rp.b');
    await ev(c, 'system', 'ESCALATED', '2026-03-04T05:00:00Z', { reason: 'overdue', from: 'rp.b' }, 'rp.a');
    await ev(c, 'lead', 'REOPENED', '2026-03-05T03:00:00Z', { decidedBy: 'rp.a', reason: 'again' }, 'rp.a');
    for (const at of ['2026-03-02T01:00:00Z', '2026-03-02T01:05:00Z', '2026-03-03T01:00:00Z']) await ev(c, 'system', 'ASSIGNED', at, {}, 'rp.a');
    await ev(c, 'rp.a', 'CLAIMED', '2026-03-03T02:00:00Z', {}, 'rp.a');
    await ev(c, 'system', 'QA_SAMPLED', '2026-03-04T01:00:00Z', {}, 'rp.b');                       // not counted: a sample is not a new case
    await ev(c, 'rp.b', 'QA_DONE', '2026-03-06T03:00:00Z', { result: 'AGREE' }, 'rp.a');
    await ev(c, 'rp.b', 'QA_DONE', '2026-03-06T04:00:00Z', { result: 'DISAGREE', note: 'x' }, 'rp.a');
    await ev(c, 'rp.a', 'QA_DONE', '2026-03-06T05:00:00Z', { result: 'AGREE' }, 'rp.b');
    // what rp.a holds right now
    const h1 = await case_(), h2 = await case_();
    await db.query(`UPDATE kyc_cases SET status='PENDING', assigned_to='rp.a', submitted_at = now() - interval '5 hours' WHERE id=ANY($1)`, [[h1, h2]]);
    await db.query(`UPDATE kyc_cases SET submitted_at = now() - interval '2 hours' WHERE id=$1`, [h2]);
  });
  afterAll(async () => { await db.close(); });

  const row = (r: Awaited<ReturnType<typeof officerReport>>, u: string) => r.officers.find((o) => o.username === u)!;

  it('counts decisions per officer per day in the regional time zone, with empty days present as zeros, and leaves automatic decisions out', async () => {
    const r = await officerReport(db, { from: '2026-03-02', to: '2026-03-09', by: 'day' });
    expect(r.period).toEqual({ from: '2026-03-02', to: '2026-03-09', by: 'day', tz: 'Asia/Singapore' });
    expect(r.buckets).toHaveLength(8);
    const a = row(r, 'rp.a');
    expect(a.series.map((p) => p.bucket)).toEqual(r.buckets);
    expect(a.series.map((p) => p.decided)).toEqual([2, 0, 0, 0, 0, 0, 1, 1]);              // 23:30 Sunday local stays on the 8th; 00:30 Monday is the 9th
    expect(a.series[0]).toMatchObject({ bucket: '2026-03-02', decided: 2, approved: 1, rejected: 1, returned: 0, avgMinutes: 15 });
    expect(a.series[7]).toMatchObject({ bucket: '2026-03-09', decided: 1, approved: 0, rejected: 0, returned: 1, avgMinutes: 30 });
    expect(a.series[1]).toMatchObject({ decided: 0, avgMinutes: null });
    expect(row(r, 'rp.b').series[1]).toMatchObject({ decided: 2, approved: 2 });
    expect(r.team.series.map((p) => p.decided)).toEqual([2, 2, 0, 0, 0, 0, 1, 1]);          // the automatic approval on the 3rd is not an officer's work
  });

  it('computes the totals: counts, average and median minutes, share within the target, overdue, escalations, reopenings, new cases and quality', async () => {
    const r = await officerReport(db, { from: '2026-03-02', to: '2026-03-09', by: 'day' });
    expect(row(r, 'rp.a').totals).toMatchObject({ decided: 4, approved: 2, rejected: 1, returned: 1, avgMinutes: 30, medianMinutes: 25, slaMetPct: 75, overdueAtDecision: 1, escalated: 1, reopened: 1, assigned: 5, qaAgreePct: 50, open: 2 });
    expect(row(r, 'rp.a').totals.oldestOpenHours).toBeGreaterThan(4.9);
    expect(row(r, 'rp.a').totals.oldestOpenHours).toBeLessThan(5.2);
    expect(row(r, 'rp.b').totals).toMatchObject({ decided: 2, approved: 2, avgMinutes: 40, medianMinutes: 40, slaMetPct: 100, overdueAtDecision: 0, escalated: 1, assigned: 1, qaAgreePct: 100, open: 0 });
    const quiet = row(r, 'rp.quiet');
    expect(quiet.totals).toMatchObject({ decided: 0, avgMinutes: null, slaMetPct: null, qaAgreePct: null, open: 0, oldestOpenHours: null });
    expect(quiet.series.every((p) => p.decided === 0)).toBe(true);
    expect(r.team.totals).toMatchObject({ decided: 6, approved: 4, rejected: 1, returned: 1, avgMinutes: 32, medianMinutes: 30, slaMetPct: 80, overdueAtDecision: 1, open: 2 });
    expect(r.officers[0]!.username).toBe('rp.a');                                            // busiest first
    expect(r.officers.map((o) => o.displayName)).toContain('Ana Lim');
  });

  it('puts a week from Monday together: Sunday 23:30 local is the old week, Monday 00:30 the new one', async () => {
    const r = await officerReport(db, { from: '2026-03-02', to: '2026-03-09', by: 'week' });
    expect(r.buckets).toEqual(['2026-03-02', '2026-03-09']);
    expect(row(r, 'rp.a').series.map((p) => p.decided)).toEqual([3, 1]);
    const m = await officerReport(db, { from: '2026-03-01', to: '2026-03-31', by: 'month' });
    expect(m.buckets).toEqual(['2026-03-01']);
    expect(row(m, 'rp.a').series[0]).toMatchObject({ decided: 4 });
  });

  it('uses another time zone when asked, and echoes the one used', async () => {
    const r = await officerReport(db, { from: '2026-03-02', to: '2026-03-09', by: 'day', tz: 'UTC' });
    expect(r.period.tz).toBe('UTC');
    expect(row(r, 'rp.a').series.map((p) => p.decided)).toEqual([2, 0, 0, 0, 0, 0, 2, 0]);   // both late-Sunday decisions are on the 8th in UTC
    expect((await officerReport(db, { from: '2026-03-02', to: '2026-03-09', tz: 'Not/AZone' })).period.tz).toBe('UTC');
  });

  it('narrows to one officer or one source, and refuses nonsense', async () => {
    const one = await officerReport(db, { from: '2026-03-02', to: '2026-03-09', officer: 'RP.B' });
    expect(one.officers.map((o) => o.username)).toEqual(['rp.b']);
    expect(one.team.totals.decided).toBe(2);
    const store = await officerReport(db, { from: '2026-03-02', to: '2026-03-09', source: 'STOREFRONT' });
    expect(row(store, 'rp.a').totals).toMatchObject({ decided: 2, approved: 1, rejected: 1 });
    expect(store.team.totals.decided).toBe(2);
    await expect(officerReport(db, { by: 'year' as never })).rejects.toThrow(/day, week or month/);
    await expect(officerReport(db, { from: '2026-03-09', to: '2026-03-02' })).rejects.toThrow(/starts after/);
    await expect(officerReport(db, { from: '2020-01-01', to: '2026-03-02', by: 'day' })).rejects.toThrow(/more than 400/);
    await expect(officerReport(db, { from: 'soon' })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('defaults to the last 7 days', async () => {
    const r = await officerReport(db, {});
    expect(r.buckets).toHaveLength(7);
    expect(r.period.by).toBe('day');
  });

  it('renders a CSV with a row per bucket, a total per officer and a team row, and defuses spreadsheet formulas', async () => {
    const csv = officerReportCsv(await officerReport(db, { from: '2026-03-02', to: '2026-03-03', by: 'day' }));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('officer,name,bucket,decided,approved,rejected,returned,avg_minutes,median_minutes,sla_met_pct,overdue_at_decision,escalated,reopened,assigned,qa_agree_pct,open,oldest_open_hours');
    expect(lines).toContain(['rp.a', 'Ana Lim', '2026-03-02', 2, 1, 1, 0, 15, ...Array(9).fill('')].join(','));
    expect(lines.find((l) => l.startsWith('rp.a,Ana Lim,TOTAL'))).toMatch(/^rp\.a,Ana Lim,TOTAL,2,1,1,0,15,15,100,0,0,0,4,,2,/);
    expect(lines.some((l) => l.startsWith('TEAM,Team,TOTAL'))).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('shows an officer their own numbers: today, this week and this month, what they hold, and their average time', async () => {
    await addOfficer(db, 'rp.me');
    const c = await case_();
    const now = new Date().toISOString();
    await decided(c, 'rp.me', now, 'APPROVE', 10, true);
    await decided(c, 'rp.me', now, 'APPROVE', 20, true);
    await decided(c, 'rp.me', now, 'REJECT', 30, false);
    await ev(c, 'rp.me', 'DECIDED', now, { decision: 'APPROVE', auto: true });
    const me = await officerMe(db, 'rp.me');
    expect(me).toMatchObject({ username: 'rp.me', away: false, open: 0, overdue: 0, avgMinutesWeek: 20 });
    expect(me.today).toEqual({ decided: 3, approved: 2, rejected: 1, returned: 0 });
    expect(me.week.decided).toBeGreaterThanOrEqual(3);
    expect(me.month.decided).toBeGreaterThanOrEqual(me.week.decided);
    const a = await officerMe(db, 'rp.a');
    expect(a).toMatchObject({ open: 2, overdue: 1 });
  });

  it('shows the workload: what each officer holds, what nobody holds, and how many each has done', async () => {
    await addCase(db, { submittedHoursAgo: 9, enqueue: false });                      // nobody holds it
    const w = await kycWorkload(db);
    expect(w.unassigned).toBeGreaterThanOrEqual(1);
    expect(w.unassignedOverdue).toBeGreaterThanOrEqual(1);
    expect(w.oldestUnassignedHours).toBeGreaterThan(8);
    const a = w.officers.find((o) => o.username === 'rp.a')!;
    expect(a).toMatchObject({ displayName: 'Ana Lim', away: false, open: 2, overdue: 1 });
    expect(a.oldestHours).toBeGreaterThan(4.9);
    expect(w.officers.find((o) => o.username === 'rp.me')).toMatchObject({ decidedToday: 3 });
    expect(w.officers.map((o) => o.open)).toEqual([...w.officers.map((o) => o.open)].sort((x, y) => y - x));
  });
});
