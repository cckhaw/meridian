'use client';
import { Alert, Badge, Empty, LargeTitle, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, tone } from '@/lib/format';

export default function Cases() {
  const { can } = useAuth();
  const [status, setStatus] = useState('ACTIVE');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged(`/cases?limit=25&status=${status}&type=${type}&q=${encodeURIComponent(term)}`);
  return (
    <>
      <LargeTitle subtitle="Newest first. Search by case number, customer name, mobile number or e-mail.">Cases</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search cases" placeholder="Case number or customer…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="md:max-w-[200px]"><option value="ACTIVE">Open / in progress</option><option value="">All</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></Select>
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="md:max-w-[220px]"><option value="">All types</option>{['FIBER_ASSURANCE', 'BILLING_REFUND', 'MNP_PORT_OUT', 'GENERAL'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term || type ? 'No cases match.' : 'No cases. Create one from a customer’s page.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Case</Th><Th>Customer</Th><Th>Type</Th><Th>Subject</Th><Th>Priority</Th><Th>Status</Th><Th>Opened</Th></tr></thead><tbody>
            {list.items.map((k: any) => <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td>{can('customer:search') ? <Link className="text-accent" href={`/customers/${k.customerId}`}>{k.customerName}</Link> : k.customerName}</Td><Td>{label(k.type)}</Td><Td>{k.subject}</Td><Td><Badge tone={tone(k.priority)}>{label(k.priority)}</Badge></Td><Td><Badge tone={tone(k.status)}>{label(k.status)}</Badge></Td><Td>{dt(k.createdAt)}</Td></tr>)}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="cases" />
        </>
      )}
    </>
  );
}
