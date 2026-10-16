'use client';
import { Alert, Badge, Empty, LargeTitle, LoadMore, Segmented, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useApi, usePaged } from '@/lib/api';
import { dt, label } from '@/lib/format';
import { FLAG_TEXT, ID_TYPE_LABEL, SOURCE_LABEL } from './flags';

const FILTERS = [{ value: 'PENDING', label: 'Needs review' }, { value: 'RETURNED', label: 'Sent back' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }, { value: '', label: 'All' }];

export default function KycQueue() {
  const [status, setStatus] = useState('PENDING');
  const list = usePaged(`/kyc/cases?limit=25&status=${status}`);
  const summary = useApi<{ waiting: number; overdue: number }>('/kyc/summary');
  return (
    <>
      <LargeTitle subtitle="Every new customer’s identity photographs arrive here as a task: from the online shop, from the CRM order screen and from the customer record.">KYC reviews</LargeTitle>
      <div className="mb-4"><Segmented label="Status" value={status} options={FILTERS} onChange={setStatus} /></div>
      {summary.data && summary.data.waiting > 0 && status === 'PENDING' && <p className="mb-3 text-subhead text-label2">{summary.data.waiting} waiting{summary.data.overdue > 0 ? <>, <strong className="text-danger">{summary.data.overdue} overdue</strong></> : ''}. Oldest first.</p>}
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{status === 'PENDING' ? 'Nothing waiting for review.' : 'No cases.'}</Empty>}
      {list.items.length > 0 && (
        <>
        <TableWrap>
          <thead><tr><Th>Applicant</Th><Th>ID</Th><Th>Came from</Th><Th>Checks</Th><Th>Waiting</Th><Th>Orders on hold</Th><Th>Status</Th></tr></thead>
          <tbody>
            {list.items.map((c: any) => (
              <tr key={c.id}>
                <Td><Link className="font-medium text-accent" href={`/kyc/${c.id}`}>{c.fullName}</Link></Td>
                <Td className="text-label2">{ID_TYPE_LABEL[c.idType] ?? c.idType} {c.idNumberMasked}</Td>
                <Td>{SOURCE_LABEL[c.source] ?? (c.method === 'IN_PERSON' ? 'In store' : 'Online')}</Td>
                <Td>{c.flags.length ? c.flags.map((f: string) => <Badge key={f} tone="warning">{FLAG_TEXT[f] ?? label(f)}</Badge>) : <span className="text-label2">Clean</span>}</Td>
                <Td className="text-label2">{dt(c.submittedAt ?? c.createdAt)}{c.overdue && <> <Badge tone="danger">Overdue</Badge></>}</Td>
                <Td>{c.waitingOrders > 0 ? <Badge tone="warning">{c.waitingOrders} {c.waitingOrders === 1 ? 'order' : 'orders'}</Badge> : <span className="text-label2">–</span>}</Td>
                <Td><Badge tone={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'danger' : 'warning'}>{label(c.status)}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="cases" />
        </>
      )}
    </>
  );
}
