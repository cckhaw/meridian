'use client';
import { Alert, Button, Card, Combobox, Empty, Field, Input, SectionTitle, Segmented, Select, Spinner, Stat, TableWrap, Td, Th, type ComboOption } from '@meridian/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { SOURCE_LABEL } from './flags';
import { approvalRate, bucketLabel, defaultBy, fillSeries, fmtHours, fmtMinutes, fmtPct, niceMax, presetRange, PRESETS, toQuery, topOfficers, type Preset, type SeriesPoint } from './view';

interface Totals { decided: number; approved: number; rejected: number; returned: number; escalated: number; reopened: number; assigned: number; avgMinutes: number | null; medianMinutes: number | null; slaMetPct: number | null; overdueAtDecision: number; qaAgreePct: number | null; open: number; oldestOpenHours: number | null }
interface OfficerRow { username: string; displayName: string; totals: Totals; series: SeriesPoint[] }
interface Report { period: { from: string; to: string; by: 'day' | 'week' | 'month'; tz: string }; officers: OfficerRow[]; team: { totals: Totals; series: SeriesPoint[] }; buckets: string[] }

/** Categorical colours for up to eight officers (the validated reference palette, stepped for each surface), then a neutral for "Others". */
const VIZ_CSS = `.kyc-viz{--v1:#2a78d6;--v2:#eb6834;--v3:#1baf7a;--v4:#eda100;--v5:#e87ba4;--v6:#008300;--v7:#6250d6;--v8:#8a8a8f;--gap:#fff}
.dark .kyc-viz{--v1:#3987e5;--v2:#d95926;--v3:#199e70;--v4:#c98500;--v5:#d55181;--v6:#008300;--v7:#9085e9;--v8:#98989d;--gap:#1c1c1e}`;
const OUTCOMES = [
  { key: 'approved', label: 'Approved', color: 'rgb(var(--success))' },
  { key: 'rejected', label: 'Rejected', color: 'rgb(var(--danger))' },
  { key: 'returned', label: 'Sent back', color: 'rgb(var(--warning))' },
] as const;

const DEFINITIONS: Array<[string, string]> = [
  ['Reviews done', 'Approvals, rejections and cases sent back, counted for the person who made the decision (a supervisor deciding on someone’s behalf counts for the supervisor) on the day the decision was made. Automatic approvals and rejections are not an officer’s work and are not counted.'],
  ['Approval rate', 'Approved decisions out of all decisions in the period (approved, rejected and sent back).'],
  ['Average and median handling time', 'Minutes from the case being assigned to that officer (else from the officer first opening it, else from submission) to the decision. The median is the middle case, so one very slow case does not pull it up. Decisions from before the review workflow existed have no time and are left out.'],
  ['Within SLA', 'The share of decisions made no later than the review target after the case was submitted, out of the decisions that carry that information.'],
  ['Backlog (Open)', 'Cases the officer holds right now and has not decided, whatever the period. The team figure adds up the officers’ cases; cases nobody holds are not included.'],
  ['Escalated', 'Cases that went up from the officer: escalated by them, or taken from them automatically because they were overdue.'],
  ['Reopened', 'Decisions of the officer that a supervisor later reopened, counted in the period in which they were reopened.'],
  ['Quality check agreement', 'Of the officer’s approvals that another officer checked, the share the checker agreed with.'],
];

export function Performance({ report }: { report: boolean }) {
  const { me } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const preset = (sp.get('range') as Preset) || '7d';
  const custom = { from: sp.get('pfrom') ?? '', to: sp.get('pto') ?? '' };
  const range = preset === 'custom' ? custom : presetRange(preset);
  const by = (sp.get('by') as 'day' | 'week' | 'month' | null) ?? (range.from && range.to ? defaultBy(range.from, range.to) : 'day');
  const officer = report ? sp.get('off') ?? '' : me?.username ?? '';
  const source = sp.get('psource') ?? '';
  const put = (p: Record<string, string>) => {
    const n = new URLSearchParams(sp.toString()); n.set('tab', 'performance');
    for (const [k, v] of Object.entries(p)) { if (v) n.set(k, v); else n.delete(k); }
    router.replace(`${path}?${n.toString()}`, { scroll: false });
  };
  const params = { from: range.from, to: range.to, by, officer: officer || undefined, source: source || undefined };
  const ready = !!range.from && !!range.to && range.from <= range.to;
  const qs = toQuery(params);
  const { data, error, loading } = useApi<Report>(ready ? `/kyc/reports/officers?${qs}` : null);

  // The officer filter's choices come from the report itself (so people without the assign permission can use it); remembered while one officer is chosen.
  const roster = useRef<ComboOption[]>([]);
  if (data && !officer) roster.current = data.officers.map((o) => ({ value: o.username, label: o.displayName || o.username, detail: `${o.totals.decided} done` }));
  const [stack, setStack] = useState<'outcome' | 'officer'>('outcome');
  const [open, setOpen] = useState<string | null>(null);
  const multi = (data?.officers.length ?? 0) > 1;
  useEffect(() => { if (!multi) setStack('outcome'); }, [multi]);
  const t = data?.team.totals;

  return (
    <div>
      <style>{VIZ_CSS}</style>
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Period" value={preset} options={PRESETS} onChange={(p) => (p === 'custom' ? put({ range: p, pfrom: range.from, pto: range.to, by: '' }) : put({ range: p === '7d' ? '' : p, pfrom: '', pto: '', by: '' }))} />
          <Segmented label="Group by" value={by} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} onChange={(b) => put({ by: b })} />
        </div>
        {preset === 'custom' && (
          <div className="grid max-w-md grid-cols-2 gap-3">
            <Field label="From"><Input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => put({ pfrom: e.target.value })} /></Field>
            <Field label="To"><Input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => put({ pto: e.target.value })} /></Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
          {report ? <Combobox label="Officer" placeholder="All officers" options={roster.current} value={officer || null} valueLabel={officer} onChange={(v) => put({ off: v ?? '' })} emptyText="No officer matches" /> : <p className="self-center text-subhead text-label2">Showing your own numbers.</p>}
          <Select aria-label="Came from" value={source} onChange={(e) => put({ psource: e.target.value })}><option value="">Any source</option>{Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
      </div>

      {!ready && <Alert tone="info">Choose a start date that is not after the end date.</Alert>}
      {error && <Alert>{error}</Alert>}
      {loading && !data && ready && <Spinner />}
      {data && t && (
        <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={loading}>
          <p className="mb-3 text-footnote text-label2">{bucketLabel(data.period.from, 'day')} to {bucketLabel(data.period.to, 'day')}, grouped by {data.period.by}{data.period.tz ? `, times in ${data.period.tz}` : ''}.</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" role="group" aria-label="Team totals">
            <Stat label="Reviews done" value={t.decided.toLocaleString()} sub={`${t.approved} approved, ${t.rejected} rejected, ${t.returned} sent back`} />
            <Stat label="Approval rate" value={fmtPct(approvalRate(t))} />
            <Stat label="Average handling time" value={fmtMinutes(t.avgMinutes)} />
            <Stat label="Median handling time" value={fmtMinutes(t.medianMinutes)} />
            <Stat label="Within SLA" value={fmtPct(t.slaMetPct)} tone={t.slaMetPct !== null && t.slaMetPct < 80 ? 'danger' : undefined} sub={t.overdueAtDecision > 0 ? `${t.overdueAtDecision} decided late` : undefined} />
            <Stat label="Backlog" value={t.open.toLocaleString()} sub={t.oldestOpenHours !== null ? `oldest ${fmtHours(t.oldestOpenHours)}` : undefined} />
          </div>
          <details className="mt-3 rounded-card bg-surface p-4 text-subhead shadow-card">
            <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">How these are measured</summary>
            <dl className="mt-3 space-y-2">{DEFINITIONS.map(([k, v]) => <div key={k}><dt className="font-medium">{k}</dt><dd className="text-label2">{v}</dd></div>)}</dl>
          </details>

          <SectionTitle action={<div className="flex flex-wrap items-center gap-3">
            {multi && <Segmented label="Stack bars by" value={stack} options={[{ value: 'outcome', label: 'Outcome' }, { value: 'officer', label: 'Officer' }]} onChange={setStack} />}
            <a href={`/api/kyc/reports/officers.csv?${qs}`} download className="inline-flex min-h-tap items-center rounded-control border border-separator bg-surface2 px-4 text-subhead font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Download CSV</a></div>}>Reviews done</SectionTitle>
          <Card>
            {t.decided === 0 && <p className="mb-2 text-subhead text-label2">No reviews were done in this period.</p>}
            <Chart data={data} stack={stack} />
            <details className="mt-4 text-subhead">
              <summary className="cursor-pointer font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Show the numbers as a table</summary>
              <DataTable data={data} />
            </details>
          </Card>

          <SectionTitle>By officer</SectionTitle>
          {data.officers.length === 0 ? <Empty>No officer has anything to report for this selection.</Empty> : (
            <TableWrap>
              <thead><tr><Th>Officer</Th><Th right>Done</Th><Th right>Approved</Th><Th right>Rejected</Th><Th right>Sent back</Th><Th right>Escalated</Th><Th right>Reopened</Th><Th right>Average</Th><Th right>Median</Th><Th right>Within SLA</Th><Th right>QA agreed</Th><Th right>Open</Th></tr></thead>
              <tbody>
                {data.officers.map((o) => {
                  const x = o.totals, on = open === o.username;
                  return (
                    <Fragment key={o.username}>
                      <tr>
                        <Td className="whitespace-nowrap"><button type="button" aria-expanded={on} onClick={() => setOpen(on ? null : o.username)} className="flex items-center gap-2 rounded text-left font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span aria-hidden className={`inline-block transition-transform ${on ? 'rotate-90' : ''}`}>›</span>{o.displayName || o.username}<span className="sr-only">, {on ? 'hide' : 'show'} daily numbers</span></button></Td>
                        <Td right>{x.decided}</Td><Td right>{x.approved}</Td><Td right>{x.rejected}</Td><Td right>{x.returned}</Td><Td right>{x.escalated}</Td><Td right>{x.reopened}</Td>
                        <Td right className="whitespace-nowrap">{fmtMinutes(x.avgMinutes)}</Td><Td right className="whitespace-nowrap">{fmtMinutes(x.medianMinutes)}</Td><Td right>{fmtPct(x.slaMetPct)}</Td><Td right>{fmtPct(x.qaAgreePct)}</Td>
                        <Td right>{x.open}{x.oldestOpenHours !== null && x.open > 0 && <span className="block text-caption text-label2">oldest {fmtHours(x.oldestOpenHours)}</span>}</Td>
                      </tr>
                      {on && (
                        <tr><td colSpan={12} className="border-b border-separator bg-surface2 px-4 py-3">
                          <table className="w-full text-left text-footnote"><caption className="sr-only">{o.displayName || o.username}, {data.period.by}ly numbers</caption>
                            <thead><tr><th className="py-1 font-medium text-label2">{by === 'day' ? 'Day' : by === 'week' ? 'Week' : 'Month'}</th><th className="py-1 text-right font-medium text-label2">Done</th><th className="py-1 text-right font-medium text-label2">Approved</th><th className="py-1 text-right font-medium text-label2">Rejected</th><th className="py-1 text-right font-medium text-label2">Sent back</th><th className="py-1 text-right font-medium text-label2">Average</th></tr></thead>
                            <tbody>{fillSeries(o.series, data.buckets).map((p) => <tr key={p.bucket} className={p.decided === 0 ? 'text-label2' : ''}><td className="py-1">{bucketLabel(p.bucket, by)}</td><td className="py-1 text-right tabular-nums">{p.decided}</td><td className="py-1 text-right tabular-nums">{p.approved}</td><td className="py-1 text-right tabular-nums">{p.rejected}</td><td className="py-1 text-right tabular-nums">{p.returned}</td><td className="py-1 text-right tabular-nums">{fmtMinutes(p.avgMinutes)}</td></tr>)}</tbody>
                          </table>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </TableWrap>
          )}
          <div className="mt-3 flex justify-end"><Button variant="plain" onClick={() => put({ range: '', pfrom: '', pto: '', by: '', off: '', psource: '' })}>Reset</Button></div>
        </div>
      )}
    </div>
  );
}

interface Layer { key: string; label: string; color: string; values: number[] }
/** Stacks for the chart: outcome (approved / rejected / sent back) for the team or the one chosen officer, or the busiest officers, with the rest folded into "Others". */
function layers(data: Report, stack: 'outcome' | 'officer'): Layer[] {
  if (stack === 'officer' && data.officers.length > 1) {
    const { top, rest } = topOfficers(data.officers, 7);
    const vals = (os: OfficerRow[]) => data.buckets.map((b) => os.reduce((n, o) => n + (o.series.find((s) => s.bucket === b)?.decided ?? 0), 0));
    const out: Layer[] = top.map((o, i) => ({ key: o.username, label: o.displayName || o.username, color: `var(--v${i + 1})`, values: vals([o]) }));
    if (rest.length) out.push({ key: '_others', label: `Others (${rest.length})`, color: 'var(--v8)', values: vals(rest) });
    return out;
  }
  const series = fillSeries(data.team.series, data.buckets);
  return OUTCOMES.map((o) => ({ key: o.key, label: o.label, color: o.color, values: series.map((p) => p[o.key]) }));
}

function Chart({ data, stack }: { data: Report; stack: 'outcome' | 'officer' }) {
  const L = useMemo(() => layers(data, stack), [data, stack]);
  const [hot, setHot] = useState<number | null>(null);
  const n = data.buckets.length;
  // Drawn at the width it has, so type and bars keep their size; narrower than the minimum, it scrolls sideways (the table below has the same numbers).
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(640);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth || 640)); ro.observe(el); setAvail(el.clientWidth || 640);
    return () => ro.disconnect();
  }, []);
  // The newest days are on the right: when the chart scrolls, start there.
  useEffect(() => { const el = wrap.current; if (el) el.scrollLeft = el.scrollWidth; }, [data, avail]);
  const totals = data.buckets.map((_, i) => L.reduce((s, l) => s + (l.values[i] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const H = 240, padL = 34, padB = 26, padT = 10;
  const slot = Math.max(20, Math.min(90, (avail - padL - 8) / Math.max(n, 1)));
  const W = Math.max(avail, padL + n * slot + 8);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  const every = Math.ceil(n / Math.max(1, Math.floor((W - padL) / 46)));
  const ticks = [0, top / 2, top].filter((v, i, a) => a.indexOf(v) === i);
  const label = (i: number) => `${bucketLabel(data.buckets[i]!, data.period.by)}: ${totals[i]} ${totals[i] === 1 ? 'review' : 'reviews'}${totals[i] ? ` (${L.filter((l) => l.values[i]).map((l) => `${l.values[i]} ${l.label.toLowerCase()}`).join(', ')})` : ''}`;
  return (
    <figure className="kyc-viz">
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-footnote" aria-label="Legend">{L.map((l) => <li key={l.key} className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-3 w-3 rounded-[3px]" style={{ background: l.color }} />{l.label}</li>)}</ul>
      <p className="mb-1 min-h-[1.25rem] text-footnote text-label2" aria-live="polite">{hot !== null ? label(hot) : 'Hover, tap or focus a column to read it.'}</p>
      <div ref={wrap} className="overflow-x-auto">
        <svg role="img" aria-label={`Reviews done per ${data.period.by}. ${totals.reduce((a, b) => a + b, 0)} in total. The table below has the numbers.`} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-none text-label2">
          {ticks.map((v) => <g key={v}><line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.5 : 0.15} /><text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="currentColor">{v}</text></g>)}
          {data.buckets.map((b, i) => {
            const x = padL + i * slot + slot * 0.18, w = slot * 0.64;
            let acc = 0;
            return (
              <g key={b} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)}>
                {L.map((l, k) => {
                  const v = l.values[i] ?? 0; if (!v) return null;
                  const y0 = y(acc), y1 = y(acc + v); acc += v;
                  const isTop = L.slice(k + 1).every((m) => !(m.values[i] ?? 0));
                  return <rect key={l.key} x={x} y={y1} width={w} height={Math.max(1, y0 - y1)} fill={l.color} stroke="var(--gap)" strokeWidth="1" rx={isTop ? 3 : 0} />;
                })}
                {i % every === 0 && <text x={x + w / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="currentColor">{bucketLabel(b, data.period.by, true)}</text>}
                <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" tabIndex={0} role="img" aria-label={label(i)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} className="outline-none focus-visible:[stroke:rgb(var(--accent))] focus-visible:[stroke-width:2px]"><title>{label(i)}</title></rect>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}

/** The chart's numbers as a table: one row per officer and one column per day, week or month, plus the team row. */
function DataTable({ data }: { data: Report }) {
  const by = data.period.by;
  const rows = [...data.officers.map((o) => ({ name: o.displayName || o.username, vals: fillSeries(o.series, data.buckets).map((p) => p.decided), total: o.totals.decided })), { name: 'Team', vals: fillSeries(data.team.series, data.buckets).map((p) => p.decided), total: data.team.totals.decided }];
  return (
    <div className="mt-3 overflow-x-auto rounded-control border border-separator">
      <table className="w-full text-left text-footnote"><caption className="sr-only">Reviews done per officer per {by}</caption>
        <thead><tr><th scope="col" className="sticky left-0 bg-surface px-3 py-2 font-medium text-label2">Officer</th>{data.buckets.map((b) => <th key={b} scope="col" className="whitespace-nowrap px-3 py-2 text-right font-medium text-label2">{bucketLabel(b, by, true)}</th>)}<th scope="col" className="px-3 py-2 text-right font-medium">Total</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.name} className="border-t border-separator"><th scope="row" className="sticky left-0 whitespace-nowrap bg-surface px-3 py-2 font-medium">{r.name}</th>{r.vals.map((v, i) => <td key={i} className={`px-3 py-2 text-right tabular-nums ${v ? '' : 'text-label2'}`}>{v}</td>)}<td className="px-3 py-2 text-right font-semibold tabular-nums">{r.total}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
