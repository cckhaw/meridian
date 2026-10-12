'use client';
import { Alert, Badge, Empty, LargeTitle, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label, tone } from '@/lib/format';

export default function Cases() {
  const { can } = useAuth();
  const [status, setStatus] = useState('ACTIVE');
  const [type, setType] = useState('');
  const { data, error, loading } = useApi(`/cases?limit=50&status=${status}&type=${type}`);
  return (
    <>
      <LargeTitle subtitle="Fibre assurance, billing refunds, number porting and general enquiries">Cases</LargeTitle>
      <div className="mb-4 flex flex-wrap gap-3">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="sm:max-w-[200px]"><option value="ACTIVE">Open / in progress</option><option value="">All</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></Select>
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="sm:max-w-[220px]"><option value="">All types</option>{['FIBER_ASSURANCE', 'BILLING_REFUND', 'MNP_PORT_OUT', 'GENERAL'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>
      </div>
      {error && <Alert>{error}</Alert>}{loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No cases. Create one from a customer’s page.</Empty> : (
        <TableWrap><thead><tr><Th>Case</Th><Th>Customer</Th><Th>Type</Th><Th>Subject</Th><Th>Priority</Th><Th>Status</Th><Th>Opened</Th></tr></thead><tbody>
          {data.items.map((k: any) => <tr key={k.id}><Td><Link className="font-mono text-accent" href={`/cases/${k.id}`}>{k.number}</Link></Td><Td>{can('customer:search') ? <Link className="text-accent" href={`/customers/${k.customerId}`}>{k.customerName}</Link> : k.customerName}</Td><Td>{label(k.type)}</Td><Td>{k.subject}</Td><Td><Badge tone={tone(k.priority)}>{label(k.priority)}</Badge></Td><Td><Badge tone={tone(k.status)}>{label(k.status)}</Badge></Td><Td>{dt(k.createdAt)}</Td></tr>)}
        </tbody></TableWrap>
      ))}
    </>
  );
}
