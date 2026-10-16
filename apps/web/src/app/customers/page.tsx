'use client';
import { Alert, Button, Card, Empty, LargeTitle, LoadMore, SearchField, Segmented, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRegional } from '@/components/settings-provider';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useSegments } from '@/lib/segments';
import { useAuth } from '@/lib/auth';
import { label } from '@/lib/format';
import { CustomerForm } from './customer-form';

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join('') || '?';

export default function Customers() {
  const { can } = useAuth();
  const regional = useRegional();
  const segs = useSegments();
  // Customers normally come from an order; the Customers screen only offers "New customer" when the administrator has allowed it (Settings → Customers).
  const meta = useApi<any>('/meta');
  const canCreate = can('customer:create') && !!meta.data?.customers?.allowCreateWithoutOrder;
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [adding, setAdding] = useState(false);
  const term = useDebounced(q.trim());
  // Always a bounded page: the newest customers, or the best matches for what was typed. Never the whole table.
  const list = usePaged(`/customers?limit=25&q=${encodeURIComponent(term)}&segment=${segment}`);
  return (
    <>
      <LargeTitle subtitle="Find a customer by name, mobile number, e-mail or ID. Results appear as you type.">Customers</LargeTitle>
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search customers" placeholder={`Name, ${regional?.dialCode ? `${regional.dialCode} ` : ""}mobile number, e-mail…`} value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Segmented label="Segment" value={segment} options={[{ value: '', label: 'All' }, ...segs.list.map((x) => ({ value: x.id, label: x.name }))]} onChange={setSegment} />
        {canCreate && <Button className="md:ml-auto" onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'New customer'}</Button>}
      </div>
      {adding && canCreate && <NewCustomer onDone={() => setAdding(false)} />}
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term ? `No customers match “${term}”.` : 'No customers yet.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{term ? 'Best matches' : 'Recently added'}</h2>
          <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {list.items.map((c: any) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className="flex min-h-[64px] items-center gap-3 px-4 py-2.5 hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none">
                  <span aria-hidden className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-subhead font-semibold ${!segs.individual(c.segment) ? 'bg-accent text-accent-fg' : 'bg-accent/15 text-accent'}`}>{initials(c.displayName)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.displayName}</span>
                    <span className="block truncate text-footnote text-label2">{segs.name(c.segment)} · {c.phone ?? c.email ?? 'no contact on file'}{c.kycStatus === 'VERIFIED' ? ' · ID verified' : c.kycStatus === 'PENDING_REVIEW' ? ' · ID in review' : c.kycStatus === 'REJECTED' ? ' · ID not approved' : ''}</span>
                  </span>
                  <span className="hidden shrink-0 text-right text-footnote text-label2 sm:block">
                    <span className="block">{Number(c.serviceCount).toLocaleString()} service{Number(c.serviceCount) === 1 ? '' : 's'}</span>
                    {Number(c.childCount) > 0 && <span className="block">{Number(c.childCount).toLocaleString()} sub-account{Number(c.childCount) === 1 ? '' : 's'}</span>}
                  </span>
                  <span aria-hidden className="text-label2">›</span>
                </Link>
              </li>
            ))}
          </ul>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="customers" />
        </>
      )}
    </>
  );
}

function NewCustomer({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const { run, busy, error } = useAction();
  const submit = async (body: Record<string, unknown>) => {
    const r = await run(() => post('/customers', body));
    if (r) { onDone(); router.push(`/customers/${r.customer.id}`); }
  };
  return <Card className="mb-6"><CustomerForm submitLabel="Create customer" busy={busy} error={error} onSubmit={(b) => void submit(b)} onConfirmed={(id) => { onDone(); router.push(`/customers/${id}`); }} /></Card>;
}
