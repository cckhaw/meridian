'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, LargeTitle, LoadMore, SearchField, SectionTitle, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, label, money, tone } from '@/lib/format';

export default function Page() { return <Suspense><Billing /></Suspense>; }

const todayStr = () => new Date().toISOString().slice(0, 10);

function Billing() {
  const { can } = useAuth();
  const customerId = useSearchParams().get('customerId') ?? '';
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged(`/invoices?limit=25&status=${status}&q=${encodeURIComponent(term)}${customerId ? `&customerId=${customerId}` : ''}`);
  return (
    <>
      <LargeTitle subtitle="Multi-cycle billing, invoices, payments and dunning">Billing</LargeTitle>
      {!customerId && can('billing:run') && <Runs onDone={() => void list.reload()} />}
      <SectionTitle>Invoices{customerId && <span className="text-subhead font-normal text-label2"> · filtered to one customer</span>}</SectionTitle>
      <div className="mb-3 flex flex-col gap-3 md:flex-row">
        <SearchField label="Search invoices" placeholder="Invoice number (INV-2026…) or customer…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="md:max-w-[220px]">{['', 'ISSUED', 'OVERDUE', 'PAID'].map((s) => <option key={s} value={s}>{s ? label(s) : 'All statuses'}</option>)}</Select>
      </div>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term || status ? 'No invoices match.' : 'No invoices yet. Run a bill cycle above.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <DataList label="Invoices" rows={list.items} rowKey={(i: any) => i.id}
            columns={[
              { key: 'no', label: 'Invoice', primary: true, render: (i: any) => <Link className="font-medium text-accent" href={`/billing/${i.id}`}>{i.number}</Link> },
              { key: 'cust', label: 'Customer', render: (i: any) => (can('customer:search') ? i.customerName : '—') },
              { key: 'period', label: 'Period', render: (i: any) => <span className="whitespace-nowrap">{d(i.periodStart)} – {d(i.periodEnd)}</span> },
              { key: 'due', label: 'Due', render: (i: any) => d(i.dueDate) },
              { key: 'st', label: 'Status', render: (i: any) => <Badge tone={tone(i.status)}>{label(i.status)}</Badge> },
              { key: 'total', label: 'Total', right: true, render: (i: any) => money(i.totalMinor, i.currency) },
              { key: 'bal', label: 'Balance', right: true, render: (i: any) => money(i.balanceMinor, i.currency) },
            ]} />
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="invoices" />
        </>
      )}
    </>
  );
}

function Runs({ onDone }: { onDone: () => void }) {
  const { can } = useAuth();
  const [asOf, setAsOf] = useState(todayStr());
  const gov = useApi<{ enforceGovernance: boolean }>('/billing/runs/settings');
  const bill = useAction(onDone), dun = useAction(onDone);
  const [res, setRes] = useState<any>(null);
  const [dres, setDres] = useState<any>(null);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {gov.data?.enforceGovernance !== false ? (
        <Card>
          <h2 className="text-title3 font-semibold">Bill runs</h2>
          <p className="mb-3 text-subhead text-label2">Each cycle is billed in four steps: a <strong>mock</strong> (nothing is invoiced), a <strong>review</strong> with exclusions, an <strong>approval</strong>, then the real run.</p>
          <div className="flex flex-wrap gap-2"><Link className="inline-flex min-h-tap items-center rounded-control bg-accent px-4 text-subhead font-semibold text-[rgb(var(--accent-label))]" href="/billing/runs">Open bill runs</Link>{can('billing:simulate') && <Link className="inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent" href="/billing/simulate">Billing simulator</Link>}{(can('billing:template') || can('billing:print')) && <Link className="inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent" href="/billing/templates">Bill templates and printing</Link>}</div>
        </Card>
      ) : (
      <Card>
        <h2 className="text-title3 font-semibold">Bill run</h2>
        <p className="mb-3 text-subhead text-label2">Governance is switched off, so a date can be billed directly. <Link className="text-accent" href="/billing/runs">Bill runs</Link> with a mock, review and approval is the safer way.</p>
        <div className="form-row"><Field label="Run date"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
          <Button disabled={bill.busy} onClick={async () => setRes(await bill.run(() => post('/billing/run', { asOf })))}>{bill.busy ? 'Running…' : 'Run bill cycle'}</Button></div>
        {bill.error && <div className="mt-3"><Alert>{bill.error}</Alert></div>}
        {res && <div className="mt-3"><Alert tone={res.errors.length ? 'danger' : 'success'}>{res.accounts} accounts due · {res.invoices} invoices ({money(res.totalMinor)}) · {res.skipped} skipped{res.errors.length > 0 && ` · ${res.errors.length} errors: ${res.errors[0].error}`}</Alert></div>}
      </Card>
      )}
      <Card>
        <h2 className="text-title3 font-semibold">Dunning</h2>
        <p className="mb-3 text-subhead text-label2">Marks unpaid invoices overdue, suspends services 15 days after the due date, and flags accounts at 45 days for write-off review.</p>
        <Button disabled={dun.busy} onClick={async () => setDres(await dun.run(() => post('/billing/dunning', {})))}>{dun.busy ? 'Running…' : 'Run dunning'}</Button>
        {dun.error && <div className="mt-3"><Alert>{dun.error}</Alert></div>}
        {dres && <div className="mt-3"><Alert tone="success">{dres.markedOverdue} invoices marked overdue · {dres.suspendedAccounts} accounts suspended · {dres.flaggedForReview} flagged for review</Alert></div>}
      </Card>
    </div>
  );
}
