'use client';
import { Alert, Empty, LargeTitle, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';
import { CaseBadges, SlaPill } from './parts';

export default function Cases() {
  const { can, me } = useAuth();
  const [status, setStatus] = useState('ACTIVE');
  const [severity, setSeverity] = useState('');
  const [who, setWho] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const qs = `limit=25&status=${status}&severity=${severity}&q=${encodeURIComponent(term)}${who === 'me' && me ? `&assignee=${encodeURIComponent(me.username)}` : ''}${who === 'none' ? '&unassigned=1' : ''}${who === 'late' ? '&breached=1' : ''}`;
  const list = usePaged(`/cases?${qs}`);
  return (
    <>
      <LargeTitle subtitle="Newest first. Search by case number, customer name, mobile number or e-mail.">Cases</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
        <SearchField label="Search cases" placeholder="Case number or customer…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="md:max-w-[190px]"><option value="ACTIVE">Open</option><option value="">All</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option>{['NEW', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_THIRD_PARTY', 'PENDING_DISPATCH', 'DISPATCHED', 'REOPENED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        <Select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="md:max-w-[200px]"><option value="">All severities</option>{['CRITICAL_OUTAGE', 'MAJOR_DEGRADATION', 'MINOR_INQUIRY'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        {can('case:write') && <Select aria-label="Show" value={who} onChange={(e) => setWho(e.target.value)} className="md:max-w-[200px]"><option value="">Everyone’s</option><option value="me">Assigned to me</option><option value="none">Unassigned</option><option value="late">Past their SLA</option></Select>}
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term || severity || who ? 'No cases match.' : 'No cases. Create one from a customer’s page.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Case</Th><Th>Customer</Th><Th>Issue</Th><Th>Status</Th><Th>SLA</Th><Th>Assigned</Th><Th>Opened</Th></tr></thead><tbody>
            {list.items.map((k: any) => <tr key={k.id}>
              <Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td>
              <Td>{can('customer:search') ? <Link className="text-accent" href={`/customers/${k.customerId}`}>{k.customerName}</Link> : k.customerName}{k.tier !== 'STANDARD' && <span className="ml-1 text-caption text-label2">{label(k.tier)}</span>}</Td>
              <Td>{k.subject}<div className="text-caption text-label2">{k.categoryPath}</div></Td>
              <Td><CaseBadges c={k} /></Td><Td><SlaPill sla={k.sla} /></Td><Td>{k.assignee ?? <span className="text-label2">—</span>}</Td><Td className="whitespace-nowrap">{dt(k.createdAt)}</Td></tr>)}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="cases" />
        </>
      )}
    </>
  );
}
