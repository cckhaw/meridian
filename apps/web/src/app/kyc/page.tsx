'use client';
import { Alert, Badge, Button, DataList, Empty, LargeTitle, LoadMore, SearchField, Segmented, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { post, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label } from '@/lib/format';
import { AssignBar } from './assign-bar';
import { FLAG_TEXT, ID_TYPE_LABEL, SOURCE_LABEL } from './flags';
import { OfficerCard } from './officer-card';
import { OfficerPicker } from './officer-picker';
import { Assignee, RiskBadge, Waiting } from './parts';
import { Performance } from './performance';
import { defaultTab, EMPTY_SELECTION, isSelected, listQuery, NO_FILTERS, OUTCOMES, searchToView, selectionCount, SORTS, toggleId, togglePage, viewToSearch, type Filters, type Tab } from './view';
import { WorkloadStrip } from './workload';

interface Summary { waiting: number; overdue: number; unassigned: number; mine: number; mineOverdue: number; escalated: number; awaitingSecondReview: number; decidedToday: number; qaTasks: number }
const BATCH_TABS: Tab[] = ['mine', 'waiting', 'unassigned', 'escalated'];

export default function KycWorkspace() {
  return <Suspense fallback={<Spinner />}><Workspace /></Suspense>;
}

function Workspace() {
  const { can, me, loading: authLoading } = useAuth();
  const ok = (...p: string[]) => !!me?.isSuperuser || can(...p);
  const review = ok('kyc:review'), assign = ok('kyc:assign'), report = ok('kyc:report');
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const defTab = defaultTab((...p) => ok(...p));
  const { tab, f } = useMemo(() => searchToView(new URLSearchParams(sp.toString()), defTab), [sp, defTab]);
  const setView = (t: Tab, nf: Filters) => { const s = viewToSearch(t, nf, defTab); router.replace(s ? `${path}?${s}` : path, { scroll: false }); };
  const patchF = (p: Partial<Filters>) => setView(tab, { ...f, ...p });

  // The search box types freely; the address (and so the list) follows after a pause.
  const [qBox, setQBox] = useState(f.q);
  const qDeb = useDebounced(qBox, 300);
  useEffect(() => { if (qDeb !== f.q) setView(tab, { ...f, q: qDeb }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [qDeb]);
  useEffect(() => { setQBox(f.q); }, [f.q]);

  const summary = useApi<Summary>(review || assign ? '/kyc/summary' : null);
  const s = summary.data;
  const [version, setVersion] = useState(0);
  const refresh = () => { void summary.reload(); setVersion((v) => v + 1); };
  const [sel, setSel] = useState(EMPTY_SELECTION);
  const [next, setNext] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  useEffect(() => { setSel(EMPTY_SELECTION); }, [tab, sp.toString()]); // eslint-disable-line react-hooks/exhaustive-deps

  const listing = tab !== 'performance';
  const list = usePaged(listing && (review || assign) ? `/kyc/cases?${listQuery(tab, f, { limit: 25 })}` : null);
  if (authLoading) return <Spinner />;
  if (!review && !assign && !report) return <><LargeTitle>KYC reviews</LargeTitle><Alert tone="info">Your role does not include KYC reviews.</Alert></>;

  const count = (t: Tab): number | undefined => s ? ({ mine: s.mine, waiting: s.waiting, unassigned: s.unassigned, escalated: s.escalated, second: s.awaitingSecondReview, qa: s.qaTasks } as Record<string, number>)[t] : undefined;
  const tabs: Array<{ value: Tab; label: string }> = ([
    review && { value: 'mine', label: 'My queue' },
    { value: 'waiting', label: 'All waiting' }, { value: 'unassigned', label: 'Unassigned' }, { value: 'escalated', label: 'Escalated' },
    ((s?.awaitingSecondReview ?? 0) > 0 || tab === 'second') && { value: 'second', label: 'Second review' },
    ((s?.qaTasks ?? 0) > 0 || tab === 'qa') && { value: 'qa', label: 'Quality checks' },
    { value: 'decided', label: 'Decided' }, { value: 'returned', label: 'Sent back' },
  ] as Array<false | { value: Tab; label: string }>).filter((x): x is { value: Tab; label: string } => !!x)
    .map((t) => { const n = count(t.value); return { ...t, label: n !== undefined && t.value !== 'performance' ? `${t.label} ${n}` : t.label }; });

  const getNext = async () => {
    setNext({ busy: true, msg: null });
    try { const r = await post<{ caseId: string | null }>('/kyc/next'); if (r.caseId) router.push(`/kyc/${r.caseId}`); else setNext({ busy: false, msg: 'No case is waiting for you right now.' }); }
    catch (e) { setNext({ busy: false, msg: (e as Error).message }); }
  };

  const items = list.items as any[];
  const batch = assign && BATCH_TABS.includes(tab);
  const plain = !f.q && !f.source && !f.risk && !f.flag && !f.overdue && !f.escalated && !f.from && !f.to && !f.assignee;
  const tabTotal = plain ? count(tab) ?? null : null;
  const matching = !list.hasMore && !list.loading ? items.length : tabTotal;
  const pageIds = items.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((i) => sel.ids.includes(i));
  const bar = batch && (sel.all || sel.ids.length > 0);
  const filtered = !!(f.q || f.source || f.risk || f.flag || f.overdue || f.escalated || f.from || f.to || f.assignee);

  return (
    <>
      <LargeTitle subtitle="Identity checks that need a person arrive here as a task: from the online shop, from the CRM order screen and from the customer record.">KYC reviews</LargeTitle>

      {review && listing && <OfficerCard onChanged={refresh} />}
      {assign && listing && <WorkloadStrip active={f.assignee} version={version} onChanged={refresh} onPick={(u) => setView(u ? (BATCH_TABS.includes(tab) && tab !== 'unassigned' ? tab : 'waiting') : tab, { ...f, assignee: u })} onUnassigned={() => setView('unassigned', f)} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {listing && <div className="min-w-0 max-w-full"><Segmented label="View" value={tab} options={tabs} onChange={(t) => setView(t, t === 'unassigned' ? { ...f, assignee: '' } : f)} /></div>}
        <div className="flex items-center gap-3 sm:ml-auto">
          {review && listing && <Button variant="secondary" onClick={() => void getNext()} disabled={next.busy}>{next.busy ? 'Finding…' : 'Get next case'}</Button>}
          {(review || report) && <Button variant={listing ? 'secondary' : 'primary'} aria-pressed={!listing} onClick={() => setView(listing ? 'performance' : defTab, f)}>{listing ? 'Performance' : 'Back to the queue'}</Button>}
        </div>
      </div>
      <p className="mb-3 min-h-0 text-subhead text-label2" role="status" aria-live="polite">{next.msg}</p>

      {tab === 'performance' ? <Performance report={report} /> : (
        <>
          <div className="mb-4 space-y-3">
            <div>
              <SearchField label="Search cases" placeholder="Name, ID, case number, phone, officer…" value={qBox} onChange={setQBox} />
              <p className="mt-1.5 px-1 text-footnote text-label2" id="kyc-search-help"><code className="font-mono">*</code> matches any characters, <code className="font-mono">?</code> matches one: <code className="font-mono">Tan*</code>, <code className="font-mono">*4567</code>, <code className="font-mono">KYC-00120?</code></p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Select aria-label="Came from" value={f.source} onChange={(e) => patchF({ source: e.target.value })}><option value="">Any source</option>{Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              <Select aria-label="Risk" value={f.risk} onChange={(e) => patchF({ risk: e.target.value })}><option value="">Any risk</option><option value="HIGH">High risk</option><option value="MEDIUM">Medium risk</option><option value="LOW">Low risk</option></Select>
              <Select aria-label="Check that raised a flag" value={f.flag} onChange={(e) => patchF({ flag: e.target.value })}><option value="">Any checks</option>{Object.keys(FLAG_TEXT).map((v) => <option key={v} value={v}>{label(v)}</option>)}</Select>
              <Select aria-label="Sort by" value={f.sort || (tab === 'decided' || tab === 'returned' ? 'newest' : 'priority')} onChange={(e) => patchF({ sort: e.target.value })}>{SORTS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}</Select>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.overdue} onChange={(e) => patchF({ overdue: e.target.checked })} />Overdue only</label>
              {tab !== 'escalated' && <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.escalated} onChange={(e) => patchF({ escalated: e.target.checked })} />Escalated only</label>}
              <label className="flex items-center gap-2 text-subhead"><span className="text-label2">From</span><input type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => patchF({ from: e.target.value })} className="min-h-tap rounded-control border border-separator bg-surface px-2 text-body" /></label>
              <label className="flex items-center gap-2 text-subhead"><span className="text-label2">To</span><input type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => patchF({ to: e.target.value })} className="min-h-tap rounded-control border border-separator bg-surface px-2 text-body" /></label>
              {filtered && <Button variant="plain" onClick={() => { setQBox(''); setView(tab, { ...NO_FILTERS, outcome: f.outcome, who: f.who, sort: f.sort }); }}>Clear filters</Button>}
            </div>
            {(tab === 'decided' || tab === 'returned' || tab === 'waiting' || tab === 'escalated') && assign && (
              <div className="max-w-md"><OfficerPicker label="Assigned to" placeholder="Filter by assigned officer…" value={f.assignee || null} valueLabel={f.assignee} onChange={(u) => patchF({ assignee: u ?? '' })} /></div>
            )}
            {tab === 'decided' && (
              <div className="flex flex-wrap items-center gap-3">
                <Select aria-label="Outcome" value={f.outcome} onChange={(e) => patchF({ outcome: e.target.value })} className="max-w-[14rem]">{OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                {review && <Segmented label="Whose decisions" value={f.who} options={[{ value: 'any', label: 'Everyone’s' }, { value: 'me', label: 'Mine' }]} onChange={(w) => patchF({ who: w })} />}
              </div>
            )}
          </div>

          {tab === 'waiting' && s && <p className="mb-3 text-subhead text-label2">{s.waiting} waiting{s.overdue > 0 && <>, <strong className="text-danger">{s.overdue} overdue</strong></>}, {s.unassigned} of them unassigned. Search the list to see who each case is assigned to.</p>}
          {tab === 'mine' && s && <p className="mb-3 text-subhead text-label2">{s.mine} assigned to you{s.mineOverdue > 0 && <>, <strong className="text-danger">{s.mineOverdue} overdue</strong></>}. Highest priority first.</p>}

          {list.error && <Alert>{list.error}</Alert>}
          {list.loading && items.length === 0 && <Spinner />}
          {!list.loading && items.length === 0 && !list.error && <Empty>{filtered ? 'No case matches this search.' : tab === 'mine' ? 'Nothing is assigned to you. Use “Get next case” to take one from the pool.' : tab === 'unassigned' ? 'Every waiting case has an officer.' : tab === 'waiting' ? 'Nothing waiting for review.' : tab === 'escalated' ? 'No escalated cases.' : 'No cases.'}</Empty>}
          {items.length > 0 && (
            <>
              {batch && (
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-subhead" aria-live="polite">
                  <label className="flex min-h-tap items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={allOnPage || sel.all} onChange={() => setSel(togglePage(sel, pageIds))} />Select all {pageIds.length} on this page</label>
                  {allOnPage && !sel.all && (list.hasMore || tabTotal !== null) && <button type="button" onClick={() => setSel({ ids: pageIds, all: true })} className="rounded text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Select all{tabTotal !== null ? ` ${tabTotal.toLocaleString()}` : ''} matching this {filtered ? 'search' : 'view'} (at most 2,000)</button>}
                  {sel.all && <span className="text-label2">Every matching case is selected (at most 2,000). <button type="button" className="text-accent" onClick={() => setSel(EMPTY_SELECTION)}>Clear</button></span>}
                </div>
              )}
              <DataList label="KYC cases" rows={items} rowKey={(c) => c.id} onRowClick={(c) => router.push(`/kyc/${c.id}`)} columns={[
                { key: 'case', label: 'Case', primary: true, render: (c) => (
                  <span className="flex items-start gap-3">
                    {batch && <input type="checkbox" aria-label={`Select ${c.caseNumber ?? c.fullName}`} className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={isSelected(sel, c.id)} onChange={() => setSel(toggleId(sel.all ? { ids: pageIds, all: false } : sel, c.id))} />}
                    <span className="min-w-0">
                      <Link className="font-mono font-medium text-accent" href={`/kyc/${c.id}`}>{c.caseNumber ?? c.id.slice(0, 8)}</Link>
                      <span className="mt-1 flex flex-wrap gap-1"><Badge tone={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'danger' : 'warning'}>{label(c.status)}</Badge>{c.escalated && <Badge tone="danger">Escalated</Badge>}</span>
                    </span>
                  </span>) },
                { key: 'applicant', label: 'Applicant', render: (c) => <span><span className="block font-medium">{c.fullName}</span><span className="block text-footnote text-label2">{ID_TYPE_LABEL[c.idType] ?? c.idType} {c.idNumberMasked}</span></span> },
                { key: 'from', label: 'Came from', render: (c) => <span>{SOURCE_LABEL[c.source] ?? (c.method === 'IN_PERSON' ? 'In store' : 'Online')}{c.method === 'MYDIGITAL_ID' ? ' · MyDigital ID' : ''}</span> },
                { key: 'checks', label: 'Risk and checks', render: (c) => <span className="flex flex-wrap justify-end gap-1 sm:justify-start"><RiskBadge risk={c.risk} />{c.flags?.length ? c.flags.map((x: string) => <Badge key={x} tone="warning">{label(x)}</Badge>) : <span className="text-label2">Clean</span>}</span> },
                { key: 'waiting', label: tab === 'decided' || tab === 'returned' ? 'Submitted' : 'Waiting', render: (c) => <Waiting submittedAt={c.submittedAt} dueAt={c.dueAt} overdue={c.overdue} done={c.status !== 'PENDING'} /> },
                { key: 'orders', label: 'Orders on hold', render: (c) => (c.waitingOrders > 0 ? <Badge tone="warning">{c.waitingOrders} {c.waitingOrders === 1 ? 'order' : 'orders'}</Badge> : <span className="text-label2">–</span>) },
                { key: 'assignee', label: tab === 'decided' ? 'Decided by' : 'Assigned to', render: (c) => (tab === 'decided' && c.decidedBy ? <span>{c.decidedBy}</span> : <Assignee username={c.assignedTo} name={c.assignedToName} me={me?.username} source={c.assignmentSource} />) },
              ]} />
              <LoadMore shown={items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="cases" />
              {bar && <AssignBar sel={sel} count={selectionCount(sel, matching)} rows={items} tab={tab} filters={f} onClear={() => setSel(EMPTY_SELECTION)} onDone={() => { setSel(EMPTY_SELECTION); void list.reload(); refresh(); }} />}
            </>
          )}
        </>
      )}
    </>
  );
}
