'use client';
import { Alert, Badge, Empty, LargeTitle, Segmented, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';
import { FLAG_TEXT, ID_TYPE_LABEL } from './flags';

const FILTERS = [{ value: 'PENDING', label: 'Needs review' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }, { value: '', label: 'All' }];

export default function KycQueue() {
  const [status, setStatus] = useState('PENDING');
  const { data, error, loading } = useApi(`/kyc/cases?status=${status}`);
  return (
    <>
      <LargeTitle subtitle="Identity checks for online sign-ups and cases that store staff could not approve on their own.">KYC reviews</LargeTitle>
      <div className="mb-4"><Segmented label="Status" value={status} options={FILTERS} onChange={setStatus} /></div>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>{status === 'PENDING' ? 'Nothing waiting for review.' : 'No cases.'}</Empty> : (
        <TableWrap>
          <thead><tr><Th>Applicant</Th><Th>ID</Th><Th>Channel</Th><Th>Checks</Th><Th>Submitted</Th><Th>Status</Th></tr></thead>
          <tbody>
            {data.items.map((c: any) => (
              <tr key={c.id}>
                <Td><Link className="font-medium text-accent" href={`/kyc/${c.id}`}>{c.fullName}</Link></Td>
                <Td className="text-label2">{ID_TYPE_LABEL[c.idType] ?? c.idType} {c.idNumberMasked}</Td>
                <Td>{c.method === 'IN_PERSON' ? 'In store' : 'Online'}</Td>
                <Td>{c.flags.length ? c.flags.map((f: string) => <Badge key={f} tone="warning">{FLAG_TEXT[f] ?? label(f)}</Badge>) : <span className="text-label2">Clean</span>}</Td>
                <Td className="text-label2">{dt(c.createdAt)}</Td>
                <Td><Badge tone={c.status === 'APPROVED' ? 'success' : c.status === 'REJECTED' ? 'danger' : 'warning'}>{label(c.status)}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      ))}
    </>
  );
}
