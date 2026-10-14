'use client';
import { Alert, Badge, Button, Empty, LargeTitle, SectionTitle, Segmented, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { dt, label, tone } from '@/lib/format';
import { post, useAction, useApi } from '@/lib/api';

export default function NumberPortability() {
  const [tab, setTab] = useState<'in' | 'out'>('in');
  return (
    <>
      <LargeTitle subtitle="Numbers coming in from other operators (port-in) and going out (port-out).">Number portability</LargeTitle>
      <div className="mb-4"><Segmented label="Direction" value={tab} onChange={setTab} options={[{ value: 'in' as const, label: 'Port-in' }, { value: 'out' as const, label: 'Port-out' }]} /></div>
      {tab === 'in' ? <PortIn /> : <Mnp />}
    </>
  );
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { PENDING: 'warning', APPROVED: 'warning', COMPLETED: 'success', REJECTED: 'danger', CANCELLED: 'neutral', EXPIRED: 'neutral' };

/** Port-in requests: raised by an order line that brings a number from another operator, answered by the clearinghouse, finished by the switch-over. */
function PortIn() {
  const [status, setStatus] = useState('PENDING');
  const list = useApi<{ items: any[] }>(`/mnp/port-in?limit=50${status ? `&status=${status}` : ''}`);
  const { run, busy, error } = useAction(list.reload);
  const decide = (id: string, approved: boolean) => run(async () => {
    const reason = approved ? undefined : window.prompt('Why was it refused?', 'Rejected by the donor operator') ?? undefined;
    if (!approved && reason === undefined) return;
    await post(`/mnp/port-in/${id}/decision`, { approved, reason, complete: approved });
  });
  return (
    <>
      <div className="mb-3 max-w-xs"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Every status</option>{['PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select></div>
      {list.error && <Alert>{list.error}</Alert>}{error && <Alert>{error}</Alert>}{list.loading && !list.data && <Spinner />}
      {list.data && (list.data.items.length === 0 ? <Empty>No port-in requests{status ? ` that are ${label(status).toLowerCase()}` : ''}. They are raised when an order brings a number from another operator.</Empty> : (
        <TableWrap><thead><tr><Th>Number</Th><Th>From</Th><Th>Holder</Th><Th>Line now</Th><Th>Status</Th><Th>Raised</Th><Th /></tr></thead><tbody>
          {list.data.items.map((r) => (
            <tr key={r.id}>
              <Td className="font-mono">{r.donorMsisdn}</Td><Td>{r.donorOperator}</Td><Td>{r.holderName}<span className="block text-caption text-label2">{r.holderIdType.toLowerCase().replace(/_/g, ' ')} {r.holderIdNumber}</span></Td>
              <Td><span className="font-mono">{r.serviceIdentifier}</span>{r.temporaryMsisdn && r.status !== 'COMPLETED' && <span className="block text-caption text-label2">temporary number</span>}<Link className="block text-caption text-accent" href={`/customers/${r.customerId}`}>{r.customerName ?? 'Open customer'}</Link></Td>
              <Td><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{label(r.status)}</Badge>{r.failureReason && <span className="block text-caption text-label2">{r.failureReason}</span>}</Td>
              <Td className="text-footnote text-label2">{dt(r.createdAt)}</Td>
              <Td right><span className="flex justify-end gap-2">
                {r.status === 'PENDING' && <><Button disabled={busy} onClick={() => decide(r.id, true)}>Donor approved</Button><Button variant="secondary" disabled={busy} onClick={() => decide(r.id, false)}>Refused</Button></>}
                {r.status === 'APPROVED' && <Button disabled={busy} onClick={() => run(() => post(`/mnp/port-in/${r.id}/complete`, {}))}>Switch over now</Button>}
                {(r.status === 'PENDING' || r.status === 'APPROVED') && <Button variant="plain" disabled={busy} onClick={() => run(() => post(`/mnp/port-in/${r.id}/cancel`, { reason: 'cancelled by staff' }))}>Cancel</Button>}
              </span></Td>
            </tr>
          ))}
        </tbody></TableWrap>
      ))}
      <SectionTitle>How it works</SectionTitle>
      <p className="text-subhead text-label2">The request goes to the national clearinghouse. While it waits the customer can use a temporary number from our pool; when the donor approves, the line takes the ported number and the temporary one rests. The line’s plan, group and shared allowance stay as they were. In production the clearinghouse answers through the callback <span className="font-mono">POST /api/mnp/port-in/:id/decision</span>; the buttons are for answers that arrive by phone or email. A request that is never answered expires (Settings → Numbers &amp; SIMs).</p>
    </>
  );
}

function Mnp() {
  const { data, error, loading, reload } = useApi('/services?status=PORTING_OUT&limit=100');
  const { run, busy, error: aerr } = useAction(reload);
  return (
    <>
      {error && <Alert>{error}</Alert>}{aerr && <Alert>{aerr}</Alert>}{loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No port-outs in progress. Start one from the customer’s service list (Manage → Port out).</Empty> : (
        <TableWrap><thead><tr><Th>Number</Th><Th>Customer</Th><Th>Status</Th><Th /></tr></thead><tbody>
          {data.items.map((s: any) => <tr key={s.id}><Td className="font-mono">{s.identifier}</Td><Td><Link className="text-accent" href={`/customers/${s.customerId}`}>Open customer</Link></Td><Td><Badge tone={tone(s.status)}>{label(s.status)}</Badge></Td>
            <Td right><span className="flex justify-end gap-2"><Button disabled={busy} onClick={() => run(() => post(`/services/${s.id}/actions`, { action: 'complete-port-out' }))}>Complete</Button><Button variant="secondary" disabled={busy} onClick={() => run(() => post(`/services/${s.id}/actions`, { action: 'cancel-port-out' }))}>Cancel</Button></span></Td></tr>)}
        </tbody></TableWrap>
      ))}
      <SectionTitle>How port-out works</SectionTitle>
      <p className="text-subhead text-label2">Completing a port-out terminates the number. If the customer is still inside a contract, an early termination charge is invoiced.</p>
    </>
  );
}
