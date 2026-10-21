'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, LargeTitle, LoadMore, Modal, SearchField, SectionTitle, Segmented, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money } from '@/lib/format';

export default function Page() { return <Suspense><BillRuns /></Suspense>; }

type Tab = 'runs' | 'exclusions' | 'cycles';
interface Run { id: string; kind: string; cycleDay: number | null; asOf: string; status: string; accountsTotal: number; mockNetMinor: number; mockTaxMinor: number; mockTotalMinor: number; billedInvoices: number; billedTotalMinor: number; percent: number; stage: string | null;
  requestedBy: string; submittedBy: string | null; approvedBy: string | null; approvalNote: string | null; note: string | null; mockFinishedAt: string | null; createdAt: string; counts: Record<string, number>; anomalyCounts: Record<string, number>; dualControl: boolean; summary: any; busy?: boolean }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  MOCK_RUNNING: { label: 'Mock running', tone: 'warning' }, MOCK_COMPLETED: { label: 'Mock ready for review', tone: 'neutral' }, PENDING_APPROVAL: { label: 'Waiting for approval', tone: 'warning' }, APPROVED: { label: 'Approved', tone: 'neutral' },
  PRODUCTION_RUNNING: { label: 'Billing', tone: 'warning' }, COMPLETED: { label: 'Completed', tone: 'success' }, FAILED: { label: 'Failed', tone: 'danger' }, CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
const LIVE = ['MOCK_RUNNING', 'PRODUCTION_RUNNING'];
const ANOMALY: Record<string, string> = { SPIKE: 'Spike vs last bill', DROP: 'Drop vs last bill', ZERO: 'Has services, no bill', LARGE: 'Large bill', NO_HISTORY: 'No earlier bill', ALREADY_BILLED: 'Already billed', VARIANCE: 'Differs from the mock' };
const STEPS = ['Mock', 'Review', 'Approval', 'Billing', 'Done'];
const stepOf = (s: string) => ({ MOCK_RUNNING: 0, MOCK_COMPLETED: 1, PENDING_APPROVAL: 2, APPROVED: 2, PRODUCTION_RUNNING: 3, COMPLETED: 4 } as Record<string, number>)[s] ?? -1;
const ord = (n: number) => `${n}${[11, 12, 13].includes(n) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10]}`;

function BillRuns() {
  const { can } = useAuth();
  const router = useRouter();
  const open = useSearchParams().get('run');
  const [tab, setTab] = useState<Tab>('runs');
  return (
    <>
      <LargeTitle subtitle="Every cycle is billed in four steps: a mock, a review, an approval, then the real run">Bill runs</LargeTitle>
      {!open && <p className="mb-4 text-footnote text-label2"><Link className="text-accent" href="/billing">← Invoices and payments</Link></p>}
      {open ? <RunView id={open} onClose={() => router.push('/billing/runs')} /> : (
        <>
          <div className="mb-5"><Segmented label="Bill runs" value={tab} onChange={setTab} options={[{ value: 'runs', label: 'Runs' }, { value: 'exclusions', label: 'Exclusions' }, { value: 'cycles', label: 'Cycles and rules' }]} /></div>
          {tab === 'runs' && <Runs canRun={can('billing:run')} onOpen={(id) => router.push(`/billing/runs?run=${id}`)} />}
          {tab === 'exclusions' && <Exclusions canRun={can('billing:run')} />}
          {tab === 'cycles' && <Cycles canConfigure={can('settings:manage')} />}
        </>
      )}
    </>
  );
}

// ───────────────────────── the list of runs, and starting one ─────────────────────────
function Runs({ canRun, onOpen }: { canRun: boolean; onOpen: (id: string) => void }) {
  const list = usePaged<Run>('/billing/runs?limit=20');
  const cycles = useApi<{ items: any[] }>('/billing/cycles');
  const [mode, setMode] = useState<'cycle' | 'daily' | 'selective'>('cycle');
  const [day, setDay] = useState('1');
  const [asOf, setAsOf] = useState('');
  const [ids, setIds] = useState('');
  const act = useAction();
  const start = async () => {
    const body: any = { ...(asOf ? { asOf } : {}) };
    if (mode === 'cycle') body.cycleDay = Number(day); else if (mode === 'daily') body.daily = true; else body.accountIds = ids.split(/[\s,;]+/).filter(Boolean);
    const r = await act.run(() => post('/billing/runs', body));
    if (r?.id) onOpen(r.id);
  };
  const enabled = (cycles.data?.items ?? []).filter((c) => c.enabled);
  const current = (cycles.data?.items ?? []).find((c) => String(c.cycleDay) === day);
  useEffect(() => { if (list.items.some((r) => LIVE.includes(r.status))) { const t = setInterval(() => void list.reload(), 3000); return () => clearInterval(t); } }, [list]);
  return (
    <div className="space-y-5">
      {canRun && (
        <Card>
          <SectionTitle>Start a bill run</SectionTitle>
          <p className="mb-3 text-footnote text-label2">This starts the <strong>mock</strong>: every account is priced as if it were being billed, and nothing is invoiced, posted or sent. You review it, then it goes for approval.</p>
          <div className="space-y-4">
            <Segmented label="What to bill" value={mode} onChange={setMode} options={[{ value: 'cycle', label: 'A cycle day' }, { value: 'daily', label: 'Daily-cycle accounts' }, { value: 'selective', label: 'Chosen accounts only' }]} />
            {mode === 'cycle' && (
              <div className="form-row">
                <Field label="Bill cycle"><Select value={day} onChange={(e) => setDay(e.target.value)}>{enabled.map((c) => <option key={c.cycleDay} value={c.cycleDay}>{c.label && c.label !== `Cycle ${c.cycleDay}` ? `${c.cycleDay} · ${c.label}` : `The ${ord(c.cycleDay)} of the month`}</option>)}</Select></Field>
                <Field label="Bill date" hint="Leave empty for the next date on that day."><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
              </div>
            )}
            {mode === 'cycle' && current?.openRunId && <Alert tone="info">This cycle has a run in progress ({label(current.openRunStatus)}). <button className="font-medium text-accent" onClick={() => onOpen(current.openRunId)}>Open it</button>{current.lastBilled ? ` Last billed ${d(current.lastBilled)}.` : ''}</Alert>}
            {mode === 'daily' && <Field label="Bill date" hint="Leave empty for today."><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>}
            {mode === 'selective' && (
              <>
                <Field label="Account ids" hint="One per line or separated by commas (up to 10,000). Use this to bill only these accounts. A period that is already billed is skipped."><textarea className="min-h-[96px] w-full rounded-control border border-separator bg-surface p-3 font-mono text-footnote" value={ids} onChange={(e) => setIds(e.target.value)} /></Field>
                <Field label="Bill date" hint="Leave empty for today."><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
              </>
            )}
            {act.error && <Alert>{act.error}</Alert>}
            <Button disabled={act.busy || (mode === 'selective' && !ids.trim())} onClick={() => void start()}>{act.busy ? 'Starting…' : 'Start the mock'}</Button>
          </div>
        </Card>
      )}
      <div>
        <SectionTitle>Runs</SectionTitle>
        {list.error && <Alert>{list.error}</Alert>}
        {list.loading && list.items.length === 0 && <Spinner />}
        {!list.loading && list.items.length === 0 && !list.error && <Empty>No bill runs yet.</Empty>}
        {list.items.length > 0 && (
          <>
            <DataList label="Bill runs" rows={list.items} rowKey={(r: Run) => r.id}
              columns={[
                { key: 'what', label: 'Run', primary: true, render: (r: Run) => <button className="text-left font-medium text-accent" onClick={() => onOpen(r.id)}>{r.kind === 'CYCLE' ? `Cycle ${r.cycleDay}` : r.kind === 'DAILY' ? 'Daily cycle' : 'Chosen accounts'} · {d(r.asOf)}</button> },
                { key: 'st', label: 'Status', render: (r: Run) => <Badge tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Badge> },
                { key: 'acc', label: 'Accounts', right: true, render: (r: Run) => r.accountsTotal.toLocaleString() },
                { key: 'mock', label: 'Mock total', right: true, render: (r: Run) => money(r.mockTotalMinor) },
                { key: 'billed', label: 'Billed', right: true, render: (r: Run) => (r.status === 'COMPLETED' || r.billedInvoices ? `${r.billedInvoices.toLocaleString()} · ${money(r.billedTotalMinor)}` : '—') },
                { key: 'by', label: 'By', render: (r: Run) => <span className="text-footnote text-label2">{r.requestedBy} · {dt(r.createdAt)}</span> },
              ]} />
            <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="runs" />
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── one run ─────────────────────────
function RunView({ id, onClose }: { id: string; onClose: () => void }) {
  const { can, me } = useAuth();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => { try { const r = await api<Run>(`/billing/runs/${id}`); if (alive.current) { setRun(r); setError(null); } } catch (e) { if (alive.current) setError((e as Error).message); } }, [id]);
  useEffect(() => { void reload(); }, [reload]);
  // While the mock or the real run has work to do, this page drives it: each call works for up to about 20 seconds.
  const live = !!run && LIVE.includes(run.status);
  useEffect(() => {
    if (!live || !can('billing:run')) return;
    let stop = false;
    (async () => { while (!stop && alive.current) { try { const r: Run = await post(`/billing/runs/${id}/work`); if (stop || !alive.current) return; setRun(r); if (!LIVE.includes(r.status)) return; if (r.busy) await new Promise((x) => setTimeout(x, 2500)); } catch (e) { setError((e as Error).message); await new Promise((x) => setTimeout(x, 4000)); } } })();
    return () => { stop = true; };
  }, [live, id, can]);
  if (!run) return error ? <Alert>{error}</Alert> : <Spinner />;

  const step = stepOf(run.status);
  const you = me?.username ?? '';
  const needSecond = run.dualControl && (you === run.requestedBy || you === run.submittedBy);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="text-subhead font-medium text-accent" onClick={onClose}>← All runs</button>
        <Badge tone={STATUS[run.status]?.tone ?? 'neutral'}>{STATUS[run.status]?.label ?? run.status}</Badge>
      </div>
      <Card>
        <h2 className="text-title2 font-semibold">{run.kind === 'CYCLE' ? `Cycle ${run.cycleDay}, the ${ord(run.cycleDay!)} of the month` : run.kind === 'DAILY' ? 'Daily-cycle accounts' : 'Chosen accounts'} · bill date {d(run.asOf)}</h2>
        <p className="text-footnote text-label2">Asked for by {run.requestedBy} on {dt(run.createdAt)}{run.submittedBy ? ` · submitted by ${run.submittedBy}` : ''}{run.approvedBy ? ` · approved by ${run.approvedBy}` : ''}{run.dualControl ? ' · needs a second person to approve' : ''}</p>
        <ol className="my-4 flex flex-wrap gap-2" aria-label="Stages">
          {STEPS.map((s, i) => <li key={s} className={`rounded-full px-3 py-1 text-footnote ${i === step ? 'bg-accent font-semibold text-[rgb(var(--accent-label))]' : i < step ? 'bg-accent/15 text-accent' : 'bg-surface2 text-label2'}`}>{i + 1}. {s}</li>)}
        </ol>
        {(live || run.status === 'COMPLETED') && <div className="mb-3"><div className="h-2 overflow-hidden rounded-full bg-surface2"><div className="h-full bg-accent transition-[width]" style={{ width: `${run.percent}%` }} /></div><span className="text-caption text-label2">{run.percent}% · {run.stage}</span></div>}
        {run.summary?.problem && <Alert>{run.summary.problem}</Alert>}
        {run.summary?.warnings?.map((w: string) => <Alert key={w} tone="info">{w}</Alert>)}
        {run.approvalNote && <p className="mt-2 text-footnote text-label2">Note: {run.approvalNote}</p>}
        {error && <Alert>{error}</Alert>}
        <Summary run={run} />
      </Card>
      <Actions run={run} needSecond={needSecond} onChange={reload} can={can} />
      {run.status !== 'MOCK_RUNNING' && <Items run={run} onChange={reload} canRun={can('billing:run')} />}
      <RunExclusions run={run} onChange={reload} canRun={can('billing:run')} />
    </div>
  );
}

function Summary({ run }: { run: Run }) {
  const c = run.counts;
  const streams = Object.entries((run.summary?.byStream ?? {}) as Record<string, number>);
  const markets = Object.entries((run.summary?.byMarket ?? {}) as Record<string, { name: string; bps: number; net: number; tax: number }>);
  const tile = (k: string, v: string, hint?: string) => <div key={k} className="rounded-control bg-surface2 p-3"><p className="text-caption text-label2">{k}</p><p className="text-title3 font-semibold">{v}</p>{hint && <p className="text-caption text-label2">{hint}</p>}</div>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile('Accounts in the run', run.accountsTotal.toLocaleString(), `${(c.MOCKED ?? 0) + (c.BILLED ?? 0)} to bill · ${c.EXCLUDED ?? 0} excluded · ${c.NO_INVOICE ?? 0} no bill`)}
        {tile('Mock total', money(run.mockTotalMinor), `${money(run.mockNetMinor)} + tax ${money(run.mockTaxMinor)}`)}
        {tile('Anomalies', Object.values(run.anomalyCounts ?? {}).reduce((a, b) => a + b, 0).toLocaleString(), Object.entries(run.anomalyCounts ?? {}).map(([k, v]) => `${ANOMALY[k] ?? k}: ${v}`).join(' · ') || 'None found')}
        {tile('Billed', run.billedInvoices ? `${run.billedInvoices.toLocaleString()} · ${money(run.billedTotalMinor)}` : '—', c.FAILED ? `${c.FAILED} failed` : run.summary?.result?.variance ? `${run.summary.result.variance} differ from the mock` : undefined)}
      </div>
      {(streams.length > 0 || markets.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {streams.length > 0 && <div><p className="mb-1 text-footnote font-semibold text-label2">Revenue by stream (before tax)</p><ul className="text-subhead">{streams.map(([k, v]) => <li key={k} className="flex justify-between border-b border-separator py-1"><span>{label(k)}</span><span>{money(v)}</span></li>)}</ul></div>}
          {markets.length > 0 && <div><p className="mb-1 text-footnote font-semibold text-label2">Tax by market</p><ul className="text-subhead">{markets.map(([k, v]) => <li key={k} className="flex justify-between border-b border-separator py-1"><span>{k} · {v.name} {v.bps / 100}%</span><span>{money(v.tax)} on {money(v.net)}</span></li>)}</ul></div>}
        </div>
      )}
    </div>
  );
}

function Actions({ run, needSecond, onChange, can }: { run: Run; needSecond: boolean; onChange: () => void; can: (...p: string[]) => boolean }) {
  const act = useAction(onChange);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<null | 'approve' | 'reject' | 'cancel'>(null);
  const go = async (path: string, body?: unknown) => { await act.run(() => post(`/billing/runs/${run.id}/${path}`, body)); setConfirm(null); setNote(''); };
  const canRun = can('billing:run'), canApprove = can('billing:approve');
  const s = run.status;
  const anomalies = Object.values(run.anomalyCounts ?? {}).reduce((a, b) => a + b, 0);
  if (['COMPLETED', 'FAILED', 'CANCELLED', 'MOCK_RUNNING', 'PRODUCTION_RUNNING'].includes(s) && !(s === 'COMPLETED' && run.counts.FAILED && canRun) && !(s === 'MOCK_RUNNING' && canRun)) return act.error ? <Alert>{act.error}</Alert> : null;
  return (
    <Card>
      <SectionTitle>What happens next</SectionTitle>
      {s === 'MOCK_COMPLETED' && (
        <p className="mb-3 text-subhead text-label2">Read the totals and the accounts that look wrong{anomalies ? ` (${anomalies} flagged below)` : ''}. Keep accounts out with <strong>Exclude</strong> (a legal dispute, a fraud case), then {run.dualControl ? 'submit the run to a second person for approval.' : 'approve it to bill for real.'}</p>
      )}
      {s === 'PENDING_APPROVAL' && <p className="mb-3 text-subhead text-label2">Submitted by {run.submittedBy}. {canApprove ? (needSecond ? 'You asked for or submitted this run, so someone else has to approve it.' : 'Approving issues the invoices, posts the journals and notifies the customers.') : 'It waits for someone with approval rights.'}</p>}
      {s === 'APPROVED' && <p className="mb-3 text-subhead text-label2">Approved by {run.approvedBy}. Start the billing run when ready.</p>}
      {s === 'COMPLETED' && !!run.counts.FAILED && <p className="mb-3 text-subhead text-label2">{run.counts.FAILED} account{run.counts.FAILED === 1 ? '' : 's'} could not be billed (see Failed below). Fix the cause, then bill just those again; nobody else is touched.</p>}
      {confirm && (
        <div className="mb-3 space-y-2">
          <Field label={confirm === 'approve' ? 'Note (optional)' : confirm === 'reject' ? 'What needs another look' : 'Why cancel (optional)'}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} /></Field>
        </div>
      )}
      {act.error && <div className="mb-3"><Alert>{act.error}</Alert></div>}
      <div className="flex flex-wrap gap-2">
        {s === 'MOCK_COMPLETED' && canRun && run.dualControl && <Button disabled={act.busy} onClick={() => void go('submit')}>Submit for approval</Button>}
        {['MOCK_COMPLETED', 'PENDING_APPROVAL'].includes(s) && canApprove && !(run.dualControl && s === 'MOCK_COMPLETED') && (confirm === 'approve'
          ? <Button disabled={act.busy || needSecond} onClick={() => void go('approve', { note: note || undefined, execute: true })}>{act.busy ? 'Starting…' : `Confirm: bill ${((run.counts.MOCKED ?? 0)).toLocaleString()} accounts (${money(run.mockTotalMinor)})`}</Button>
          : <Button disabled={needSecond} onClick={() => setConfirm('approve')}>Approve and bill</Button>)}
        {s === 'PENDING_APPROVAL' && canApprove && (confirm === 'reject' ? <Button variant="secondary" disabled={act.busy || !note.trim()} onClick={() => void go('reject', { note })}>Send back</Button> : <Button variant="secondary" onClick={() => setConfirm('reject')}>Send back for review</Button>)}
        {s === 'APPROVED' && canApprove && <Button disabled={act.busy} onClick={() => void go('execute')}>Start billing</Button>}
        {['MOCK_COMPLETED', 'PENDING_APPROVAL'].includes(s) && canRun && <Button variant="secondary" disabled={act.busy} onClick={() => void go('remock')}>Run the mock again</Button>}
        {s === 'COMPLETED' && !!run.counts.FAILED && canRun && <Button disabled={act.busy} onClick={() => void go('retry')}>Bill the failed accounts again</Button>}
        {['MOCK_RUNNING', 'MOCK_COMPLETED', 'PENDING_APPROVAL', 'APPROVED'].includes(s) && canRun && (confirm === 'cancel' ? <Button variant="secondary" disabled={act.busy} onClick={() => void go('cancel', { note: note || undefined })}>Confirm cancel</Button> : <Button variant="secondary" onClick={() => setConfirm('cancel')}>Cancel the run</Button>)}
      </div>
    </Card>
  );
}

function Items({ run, onChange, canRun }: { run: Run; onChange: () => void; canRun: boolean }) {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [bill, setBill] = useState<any | null>(null);
  const [excl, setExcl] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const act = useAction(async () => { onChange(); await list.reload(); });
  const query = filter === 'EXCLUDED' || filter === 'FAILED' || filter === 'NO_INVOICE' || filter === 'BILLED' ? `status=${filter}` : filter ? `anomaly=${filter}` : '';
  const list = usePaged<any>(`/billing/runs/${run.id}/items?limit=25&${query}&q=${encodeURIComponent(term)}`);
  useEffect(() => { void list.reload(); }, [run.status, run.counts.EXCLUDED]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = run.status === 'MOCK_COMPLETED' && canRun;
  const opts = [['', 'All accounts'], ['ANY', 'Any anomaly'], ...Object.entries(run.anomalyCounts ?? {}).map(([k, v]) => [k, `${ANOMALY[k] ?? k} (${v})`]), ['EXCLUDED', `Excluded (${run.counts.EXCLUDED ?? 0})`], ['NO_INVOICE', `No bill (${run.counts.NO_INVOICE ?? 0})`], ...(run.counts.FAILED ? [['FAILED', `Failed (${run.counts.FAILED})`]] : []), ...(run.counts.BILLED ? [['BILLED', `Billed (${run.counts.BILLED})`]] : [])];
  const show = async (accountId: string) => { try { setBill(await api(`/billing/runs/${run.id}/accounts/${accountId}`)); } catch (e) { setBill({ error: (e as Error).message }); } };
  return (
    <div>
      <SectionTitle>Accounts</SectionTitle>
      <div className="mb-3 flex flex-col gap-3 md:flex-row">
        <SearchField label="Search accounts" placeholder="Customer name, or an account or customer id" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} className="md:max-w-[280px]">{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      </div>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>No accounts match.</Empty>}
      {list.items.length > 0 && (
        <>
          <DataList label="Accounts in the run" rows={list.items} rowKey={(i: any) => i.accountId}
            columns={[
              { key: 'c', label: 'Customer', primary: true, render: (i: any) => <><span className="font-medium">{i.customerName}</span><span className="block text-caption text-label2">{i.accountName}</span></> },
              { key: 'st', label: 'Status', render: (i: any) => <><Badge tone={i.status === 'BILLED' ? 'success' : i.status === 'FAILED' ? 'danger' : i.status === 'EXCLUDED' ? 'warning' : 'neutral'}>{label(i.status)}</Badge>{i.excludedReason && <span className="block text-caption text-label2">{i.excludedReason}</span>}{i.error && <span className="block text-caption text-danger">{i.error}</span>}</> },
              { key: 'an', label: 'Flags', render: (i: any) => (i.anomalies?.length ? <span className="flex flex-wrap gap-1">{i.anomalies.map((a: string) => <Badge key={a} tone={a === 'NO_HISTORY' ? 'neutral' : 'warning'}>{ANOMALY[a] ?? a}</Badge>)}</span> : '—') },
              { key: 'prev', label: 'Last bill', right: true, render: (i: any) => (i.prevTotalMinor == null ? '—' : money(i.prevTotalMinor)) },
              { key: 'tot', label: 'This bill', right: true, render: (i: any) => (i.status === 'BILLED' ? money(i.billedTotalMinor) : i.totalMinor ? money(i.totalMinor) : '—') },
            ]}
            actions={(i: any) => (<>
              <Button variant="secondary" onClick={() => void show(i.accountId)}>View bill</Button>
              {editable && i.status !== 'EXCLUDED' && <Button variant="secondary" onClick={() => { setExcl(i); setReason(''); }}>Exclude</Button>}
              {editable && i.status === 'EXCLUDED' && <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/billing/runs/${run.id}/include`, { accountIds: [i.accountId] }))}>Put back</Button>}
            </>)} />
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="accounts" />
        </>
      )}
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      {bill && (
        <Modal title={bill.error ? 'Bill' : `Bill for ${d(bill.periodStart)} to ${d(bill.periodEnd)}`} onClose={() => setBill(null)} wide>
          {bill.error ? <Alert>{bill.error}</Alert> : (
            <div className="space-y-3">
              {bill.exists && <Alert tone="info">This period is already billed.</Alert>}
              <table className="w-full text-subhead"><thead><tr className="text-left text-label2"><th>Line</th><th>Stream</th><th className="text-right">Net</th><th className="text-right">Tax</th></tr></thead>
                <tbody>{bill.lines.map((l: any, k: number) => <tr key={k} className="border-t border-separator"><td className="py-1 pr-2">{l.description}</td><td className="pr-2 text-label2">{label(l.stream)}</td><td className="text-right">{money(l.netMinor, bill.currency)}</td><td className="text-right">{money(l.taxMinor, bill.currency)}</td></tr>)}</tbody>
                <tfoot><tr className="border-t-2 border-separator font-semibold"><td colSpan={2} className="py-1">Total ({bill.taxName} {bill.taxBps / 100}%)</td><td className="text-right">{money(bill.netMinor, bill.currency)}</td><td className="text-right">{money(bill.taxMinor, bill.currency)}</td></tr></tfoot></table>
              {bill.history.length > 0 && <div><p className="mb-1 text-footnote font-semibold text-label2">Earlier bills</p><ul className="text-footnote">{bill.history.map((h: any) => <li key={h.number} className="flex justify-between py-0.5"><span>{h.number} · {d(h.issueDate)}</span><span>{money(h.totalMinor, bill.currency)} · {label(h.status)}</span></li>)}</ul></div>}
            </div>
          )}
        </Modal>
      )}
      {excl && (
        <Modal title={`Keep ${excl.customerName} out of this run`} onClose={() => setExcl(null)}>
          <div className="space-y-3">
            <Field label="Why (it goes in the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Legal dispute LD-42, fraud investigation…" /></Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={act.busy || reason.trim().length < 5} onClick={async () => { await act.run(() => post('/billing/exclusions', { accountId: excl.accountId, runId: run.id, reason })); setExcl(null); }}>Exclude this account</Button>
              <Button variant="secondary" disabled={act.busy || reason.trim().length < 5} onClick={async () => { await act.run(() => post('/billing/exclusions', { customerId: excl.customerId, runId: run.id, reason })); setExcl(null); }}>Exclude the customer and every department below it</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RunExclusions({ run, onChange, canRun }: { run: Run; onChange: () => void; canRun: boolean }) {
  const ex = useApi<{ items: any[] }>(`/billing/exclusions?runId=${run.id}`);
  const act = useAction(async () => { await ex.reload(); onChange(); });
  useEffect(() => { void ex.reload(); }, [run.counts.EXCLUDED]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = ex.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div>
      <SectionTitle>Exclusions that apply to this run</SectionTitle>
      <ExclusionList items={items} canRun={canRun && ['MOCK_RUNNING', 'MOCK_COMPLETED'].includes(run.status)} act={act} />
    </div>
  );
}

function ExclusionList({ items, canRun, act }: { items: any[]; canRun: boolean; act: ReturnType<typeof useAction> }) {
  return (
    <>
      <DataList label="Exclusions" rows={items} rowKey={(e: any) => String(e.id)}
        columns={[
          { key: 'w', label: 'Who', primary: true, render: (e: any) => <><span className="font-medium">{e.customerName ?? '—'}</span><span className="block text-caption text-label2">{e.scope === 'ACCOUNT' ? `Account ${e.accountName ?? ''}` : 'Customer and every department below it'}</span></> },
          { key: 'r', label: 'Reason', render: (e: any) => e.reason },
          { key: 'sc', label: 'Applies to', render: (e: any) => (e.runId ? 'This run only' : e.untilDate ? `Every run until ${d(e.untilDate)}` : 'Every run until lifted') },
          { key: 'by', label: 'Added', render: (e: any) => <span className="text-footnote text-label2">{e.createdBy} · {dt(e.createdAt)}</span> },
        ]}
        actions={canRun ? (e: any) => <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post(`/billing/exclusions/${e.id}/remove`))}>Lift</Button> : undefined} />
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
    </>
  );
}

// ───────────────────────── exclusions (standing) ─────────────────────────
function Exclusions({ canRun }: { canRun: boolean }) {
  const ex = useApi<{ items: any[] }>('/billing/exclusions');
  const act = useAction(async () => { await ex.reload(); });
  const [kind, setKind] = useState<'account' | 'customer'>('account');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const add = async () => { const r = await act.run(() => post('/billing/exclusions', { [kind === 'account' ? 'accountId' : 'customerId']: target.trim(), reason, ...(until ? { untilDate: until } : {}) })); if (r) { setTarget(''); setReason(''); setUntil(''); } };
  const standing = (ex.data?.items ?? []).filter((e) => !e.runId);
  return (
    <div className="space-y-5">
      <p className="text-subhead text-label2">A standing exclusion keeps an account, or an enterprise customer with every department below it, out of <strong>every</strong> bill run until it is lifted (or its end date passes): a legal dispute, a fraud investigation. It also applies at once to runs now under review. To keep accounts out of one run only, use Exclude on the run.</p>
      {canRun && (
        <Card>
          <SectionTitle>Add a standing exclusion</SectionTitle>
          <div className="space-y-4">
            <Segmented label="What to exclude" value={kind} onChange={setKind} options={[{ value: 'account', label: 'An account' }, { value: 'customer', label: 'A customer and its departments' }]} />
            <Field label={kind === 'account' ? 'Account id' : 'Customer id'}><Input value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono" /></Field>
            <Field label="Why (at least 5 characters)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
            <Field label="Until (optional)" hint="Empty: until someone lifts it."><Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
            {act.error && <Alert>{act.error}</Alert>}
            <Button disabled={act.busy || !target.trim() || reason.trim().length < 5} onClick={() => void add()}>Add</Button>
          </div>
        </Card>
      )}
      <div>
        <SectionTitle>Standing exclusions</SectionTitle>
        {ex.loading && !ex.data && <Spinner />}
        {ex.data && standing.length === 0 && <Empty>None.</Empty>}
        {standing.length > 0 && <ExclusionList items={standing} canRun={canRun} act={act} />}
      </div>
    </div>
  );
}

// ───────────────────────── the 28 cycles and the rules ─────────────────────────
function Cycles({ canConfigure }: { canConfigure: boolean }) {
  const cycles = useApi<{ items: any[] }>('/billing/cycles');
  const settings = useApi<any>('/billing/runs/settings');
  const act = useAction(async () => { await cycles.reload(); await settings.reload(); });
  const [form, setForm] = useState<any | null>(null);
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });
  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Rules for every run</SectionTitle>
        {!form ? <Spinner /> : (
          <div className="space-y-4">
            <label className="flex min-h-tap items-start gap-3"><input type="checkbox" disabled={!canConfigure} className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={form.enforceGovernance} onChange={(e) => setForm({ ...form, enforceGovernance: e.target.checked })} /><span><span className="block">Every bill cycle goes through mock, review and approval</span><span className="text-footnote text-label2">Off: the plain “run this date” call is allowed as well. Leave it on in production.</span></span></label>
            <label className="flex min-h-tap items-start gap-3"><input type="checkbox" disabled={!canConfigure} className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={form.dualControl} onChange={(e) => setForm({ ...form, dualControl: e.target.checked })} /><span><span className="block">Dual control: a second person must approve</span><span className="text-footnote text-label2">The person who asked for the run, or submitted it, cannot approve it. A cycle can override this below.</span></span></label>
            <div className="form-row">
              <Field label="Flag a bill this many % above the last one"><Input type="number" disabled={!canConfigure} value={form.spikePercent} onChange={num('spikePercent')} /></Field>
              <Field label="Flag a bill this many % below the last one"><Input type="number" disabled={!canConfigure} value={form.dropPercent} onChange={num('dropPercent')} /></Field>
            </div>
            <div className="form-row">
              <Field label="Flag any bill at or above (minor units, 0 = off)"><Input type="number" disabled={!canConfigure} value={form.largeMinor} onChange={num('largeMinor')} /></Field>
              <Field label="Refuse approval when the mock is older than (hours)"><Input type="number" disabled={!canConfigure} value={form.maxMockAgeHours} onChange={num('maxMockAgeHours')} /></Field>
            </div>
            {act.error && <Alert>{act.error}</Alert>}
            {canConfigure ? <Button disabled={act.busy} onClick={() => void act.run(() => post('/billing/runs/settings', form), 'Saved.')}>Save</Button> : <p className="text-footnote text-label2">Only people with the Settings permission can change these.</p>}
            {act.ok && <Alert tone="success">{act.ok}</Alert>}
          </div>
        )}
      </Card>
      <div>
        <SectionTitle>The 28 monthly cycles</SectionTitle>
        {cycles.loading && !cycles.data && <Spinner />}
        {cycles.data && (
          <DataList label="Bill cycles" rows={cycles.data.items} rowKey={(c: any) => String(c.cycleDay)}
            columns={[
              { key: 'd', label: 'Cycle', primary: true, render: (c: any) => <><span className="font-medium">The {ord(c.cycleDay)}</span>{c.label && c.label !== `Cycle ${c.cycleDay}` && <span className="block text-caption text-label2">{c.label}</span>}</> },
              { key: 'on', label: 'State', render: (c: any) => <Badge tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? 'On' : 'Off'}</Badge> },
              { key: 'dc', label: 'Second approver', render: (c: any) => (c.dualControl === null ? 'Follows the rule above' : c.dualControl ? 'Always' : 'Never') },
              { key: 'last', label: 'Last billed', render: (c: any) => (c.lastBilled ? d(c.lastBilled) : '—') },
              { key: 'open', label: 'In progress', render: (c: any) => (c.openRunId ? <Link className="text-accent" href={`/billing/runs?run=${c.openRunId}`}>{label(c.openRunStatus)}</Link> : '—') },
            ]}
            actions={canConfigure ? (c: any) => (<>
              <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => api(`/billing/cycles/${c.cycleDay}`, { method: 'PATCH', json: { enabled: !c.enabled } }))}>{c.enabled ? 'Switch off' : 'Switch on'}</Button>
              <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => api(`/billing/cycles/${c.cycleDay}`, { method: 'PATCH', json: { dualControl: c.dualControl === null ? true : c.dualControl ? false : null } }))}>{c.dualControl === null ? 'Always second approver' : c.dualControl ? 'Never second approver' : 'Follow the rule'}</Button>
            </>) : undefined} />
        )}
      </div>
    </div>
  );
}
