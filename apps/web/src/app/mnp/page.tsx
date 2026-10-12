'use client';
import { Alert, Badge, Button, Empty, LargeTitle, SectionTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { post, useAction, useApi } from '@/lib/api';
import { label, tone } from '@/lib/format';

export default function Mnp() {
  const { data, error, loading, reload } = useApi('/services?status=PORTING_OUT&limit=100');
  const { run, busy, error: aerr } = useAction(reload);
  return (
    <>
      <LargeTitle subtitle="Port-out requests in progress. Port-in is captured by entering the customer’s number when selling a SIM.">Number portability</LargeTitle>
      {error && <Alert>{error}</Alert>}{aerr && <Alert>{aerr}</Alert>}{loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No port-outs in progress. Start one from the customer’s service list (Manage → Port out).</Empty> : (
        <TableWrap><thead><tr><Th>Number</Th><Th>Customer</Th><Th>Status</Th><Th /></tr></thead><tbody>
          {data.items.map((s: any) => <tr key={s.id}><Td className="font-mono">{s.identifier}</Td><Td><Link className="text-accent" href={`/customers/${s.customerId}`}>Open customer</Link></Td><Td><Badge tone={tone(s.status)}>{label(s.status)}</Badge></Td>
            <Td right><span className="flex justify-end gap-2"><Button disabled={busy} onClick={() => run(() => post(`/services/${s.id}/actions`, { action: 'complete-port-out' }))}>Complete</Button><Button variant="secondary" disabled={busy} onClick={() => run(() => post(`/services/${s.id}/actions`, { action: 'cancel-port-out' }))}>Cancel</Button></span></Td></tr>)}
        </tbody></TableWrap>
      ))}
      <SectionTitle>How it works</SectionTitle>
      <p className="text-subhead text-label2">Completing a port-out terminates the number. If the customer is still inside a contract, an early termination charge is invoiced.</p>
    </>
  );
}
