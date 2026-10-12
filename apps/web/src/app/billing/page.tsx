'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, LoadMore, SearchField, SectionTitle, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { post, useAction, useDebounced, usePaged } from '@/lib/api';
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
          <TableWrap><thead><tr><Th>Invoice</Th><Th>Customer</Th><Th>Period</Th><Th>Due</Th><Th>Status</Th><Th right>Total</Th><Th right>Balance</Th></tr></thead><tbody>
            {list.items.map((i: any) => (
              <tr key={i.id}><Td><Link className="font-medium text-accent" href={`/billing/${i.id}`}>{i.number}</Link></Td><Td>{can('customer:search') ? i.customerName : '—'}</Td><Td className="whitespace-nowrap">{d(i.periodStart)} – {d(i.periodEnd)}</Td>
                <Td>{d(i.dueDate)}</Td><Td><Badge tone={tone(i.status)}>{label(i.status)}</Badge></Td><Td right>{money(i.totalMinor, i.currency)}</Td><Td right>{money(i.balanceMinor, i.currency)}</Td></tr>
            ))}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="invoices" />
        </>
      )}
    </>
  );
}

function Runs({ onDone }: { onDone: () => void }) {
  const [asOf, setAsOf] = useState(todayStr());
  const bill = useAction(onDone), dun = useAction(onDone);
  const [res, setRes] = useState<any>(null);
  const [dres, setDres] = useState<any>(null);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <h2 className="text-title3 font-semibold">Bill run</h2>
        <p className="mb-3 text-subhead text-label2">Bills every account whose cycle day matches the date (daily-cycle accounts every day), in arrears. Safe to re-run: existing invoices are skipped.</p>
        <div className="flex flex-wrap items-end gap-3"><Field label="Run date"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
          <Button disabled={bill.busy} onClick={async () => setRes(await bill.run(() => post('/billing/run', { asOf })))}>{bill.busy ? 'Running…' : 'Run bill cycle'}</Button></div>
        {bill.error && <div className="mt-3"><Alert>{bill.error}</Alert></div>}
        {res && <div className="mt-3"><Alert tone={res.errors.length ? 'danger' : 'success'}>{res.accounts} accounts due · {res.invoices} invoices ({money(res.totalMinor)}) · {res.skipped} skipped{res.errors.length > 0 && ` · ${res.errors.length} errors: ${res.errors[0].error}`}</Alert></div>}
      </Card>
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
