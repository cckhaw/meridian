'use client';
import { Alert, Badge, Empty, LargeTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useApi } from '@/lib/api';
import { dt, label, tone } from '@/lib/format';

export default function AssistedSales() {
  const { data, error, loading } = useApi('/assisted/applications');
  return (
    <>
      <LargeTitle subtitle="Sell with the customer in front of you: verify their ID, get their authority, take payment.">Assisted sale</LargeTitle>
      <p className="mb-5"><Link href="/assisted/new" className="inline-flex min-h-tap items-center rounded-control bg-accent px-5 font-medium text-accent-fg hover:opacity-90">Start an assisted sale</Link></p>
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No assisted sales yet.</Empty> : (
        <TableWrap>
          <thead><tr><Th>Customer</Th><Th>Started</Th><Th>By</Th><Th>Status</Th></tr></thead>
          <tbody>
            {data.items.map((a: any) => (
              <tr key={a.id}>
                <Td><Link className="font-medium text-accent" href={`/assisted/${a.id}`}>{a.customerName ?? 'New customer'}</Link></Td>
                <Td className="text-label2">{dt(a.createdAt)}</Td><Td className="text-label2">{a.createdBy}</Td>
                <Td><Badge tone={a.status === 'ORDERED' ? 'success' : tone(a.status)}>{label(a.status)}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      ))}
    </>
  );
}
