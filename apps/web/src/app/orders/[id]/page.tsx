'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, SectionTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { use, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money, tone } from '@/lib/format';

const ACTION_LABEL: Record<string, string> = { confirm_payment: 'Confirm payment received', schedule_installation: 'Schedule installation', dispatch_technician: 'Dispatch technician', complete_installation: 'Mark installation complete', ship: 'Ship goods', deliver: 'Mark delivered' };

export default function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const meta = useApi('/meta');
  const [ref, setRef] = useState('');
  const { data: o, error, loading, reload } = useApi(`/orders/${id}`);
  const { run, busy, error: aerr } = useAction(reload);
  const [slot, setSlot] = useState('');
  const [reason, setReason] = useState('');
  if (error) return <Alert>{error}</Alert>;
  if (loading && !o) return <Spinner />;
  if (!o) return null;
  const act = (type: string, extra: object = {}) => run(() => post(`/orders/${id}/actions`, { type, ...extra }));
  const terminal = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(o.state);
  return (
    <>
      <LargeTitle subtitle={<span className="flex flex-wrap items-center gap-2"><Badge tone={tone(o.state)}>{label(o.state)}</Badge><Badge>{label(o.channel)}</Badge><span>{dt(o.createdAt)}</span></span>}>Order {o.id.slice(0, 8)}</LargeTitle>
      <p className="mb-4 text-body">Customer {can('customer:search') ? <Link className="text-accent" href={`/customers/${o.customerId}`}>{o.customerName}</Link> : o.customerName}{o.storeId && <> · store {o.storeId}</>}{o.salespersonId && <> · agent {o.salespersonId}</>}{o.dealerId && <> · dealer {o.dealerId}</>}</p>
      {o.failureReason && <Alert>{label(o.state)}: {o.failureReason}</Alert>}
      {aerr && <div className="mt-3"><Alert>{aerr}</Alert></div>}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div>
          <SectionTitle>Items</SectionTitle>
          <TableWrap><thead><tr><Th>Item</Th><Th right>Qty</Th><Th right>Net</Th><Th right>Tax</Th><Th right>Upfront</Th></tr></thead><tbody>
            {o.lines.map((l: any) => <tr key={l.id}><Td>{l.description}{l.msisdn && <div className="font-mono text-caption text-label2">port-in {l.msisdn}</div>}</Td><Td right>{l.quantity.toLocaleString()}</Td><Td right>{money(l.netMinor, o.currency)}</Td><Td right>{money(l.taxMinor, o.currency)}</Td><Td right>{money(l.netMinor + l.taxMinor, o.currency)}</Td></tr>)}
            <tr><Td className="font-semibold">Total{o.paymentMethod === 'INSTALLMENT' && <span className="font-normal text-label2"> (billed over {o.installmentMonths} months)</span>}</Td><Td /><Td /><Td /><Td right className="font-semibold">{money(o.totalMinor, o.currency)}</Td></tr>
          </tbody></TableWrap>

          {o.payments.length > 0 && <><SectionTitle>Payments</SectionTitle><TableWrap><thead><tr><Th>Method</Th><Th>Status</Th><Th right>Amount</Th></tr></thead><tbody>
            {o.payments.map((p: any) => <tr key={p.id}><Td>{label(p.method)}</Td><Td><Badge tone={tone(p.status === 'CAPTURED' ? 'PAID' : p.status)}>{label(p.status)}</Badge></Td><Td right>{money(p.amountMinor, o.currency)}</Td></tr>)}</tbody></TableWrap></>}

          {o.services.length > 0 && <><SectionTitle>Services activated {o.serviceCount > o.services.length && <span className="text-subhead font-normal text-label2">(showing {o.services.length} of {o.serviceCount.toLocaleString()})</span>}</SectionTitle>
            <TableWrap><thead><tr><Th>Number / ID</Th><Th>Type</Th><Th>Status</Th></tr></thead><tbody>{o.services.map((s: any) => <tr key={s.id}><Td className="font-mono">{s.identifier}</Td><Td>{label(s.type)}</Td><Td><Badge tone={tone(s.status)}>{label(s.status)}</Badge></Td></tr>)}</tbody></TableWrap></>}

          {o.appointments.length > 0 && <><SectionTitle>Installation</SectionTitle><TableWrap><thead><tr><Th>Window</Th><Th>Status</Th></tr></thead><tbody>
            {o.appointments.map((a: any, i: number) => <tr key={i}><Td>{dt(a.slotStart)} – {dt(a.slotEnd)}</Td><Td><Badge tone={tone(a.status)}>{label(a.status)}</Badge></Td></tr>)}</tbody></TableWrap></>}
          {o.fulfilment.trackingNumber && <p className="mt-4 text-subhead">Tracking: <span className="font-mono">{o.fulfilment.trackingNumber}</span></p>}
          {o.fulfilment.address && <p className="text-subhead text-label2">Address: {o.fulfilment.address}</p>}
        </div>

        <aside className="space-y-4">
          {!terminal && (o.nextActions.length > 0) && (
            <Card className="space-y-3">
              <h2 className="text-title3 font-semibold">Next step</h2>
              {o.nextActions.length === 0 && <p className="text-subhead text-label2">Waiting on an earlier step to finish.</p>}
              {o.nextActions.includes('confirm_payment') && can('order:payment') && meta.data?.paymentMode === 'manual' && (
                <Field label="Payment reference" hint="Terminal approval, receipt or transfer number"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
              )}
              {o.nextActions.includes('confirm_payment') && !can('order:payment') && <Alert tone="info">Waiting for your payment to be confirmed. This order is released automatically once it is.</Alert>}
              {o.nextActions.includes('schedule_installation') && (
                <Field label="Installation slot"><Input type="datetime-local" value={slot} onChange={(e) => setSlot(e.target.value)} /></Field>
              )}
              {o.nextActions.filter((a: string) => can(a === 'confirm_payment' ? 'order:payment' : 'order:fulfil')).map((a: string) => (
                <Button key={a} className="w-full" disabled={busy || (a === 'schedule_installation' && !slot) || (a === 'confirm_payment' && meta.data?.paymentMode === 'manual' && !ref.trim())}
                  onClick={() => act(a, a === 'schedule_installation' ? { slot: new Date(slot).toISOString() } : a === 'confirm_payment' ? { reference: ref || undefined } : {})}>{ACTION_LABEL[a] ?? label(a)}</Button>
              ))}
            </Card>
          )}
          {!terminal && can('order:cancel') && (
            <Card className="space-y-3">
              <h2 className="text-title3 font-semibold">Cancel</h2>
              {o.cancellable ? (<>
                <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Button variant="destructive" className="w-full" disabled={busy} onClick={() => act('cancel', { reason: reason || 'cancelled by user' })}>Cancel order</Button></>
              ) : <Alert tone="info">Past the point of no return ({d(o.pointOfNoReturnAt)}): goods shipped or technician dispatched. Raise a return or termination instead.</Alert>}
            </Card>
          )}
          <Card>
            <h2 className="mb-3 text-title3 font-semibold">Timeline</h2>
            <ol className="space-y-2 border-l border-separator pl-4">
              {o.history.map((h: any, i: number) => <li key={i} className="text-subhead"><span className="font-medium">{label(h.toState)}</span>{h.reason && <span className="text-label2"> – {h.reason}</span>}<div className="text-caption text-label2">{dt(h.occurredAt)} · {h.actor}</div></li>)}
            </ol>
          </Card>
        </aside>
      </div>
    </>
  );
}
