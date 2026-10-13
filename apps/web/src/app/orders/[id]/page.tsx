'use client';
import { Alert, Badge, Button, Card, Field, Input, LargeTitle, SectionTitle, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { use, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money, tone, toMinor } from '@/lib/format';

const GROUP_TITLE: Record<string, string> = { GOODS: 'Delivery', INSTALL: 'Installation', ACTIVATION: 'Service activation' };
const gt = (k: string) => GROUP_TITLE[k] ?? k;
const GROUP_STATUS: Record<string, string> = { PENDING: 'Not started', LOCKED: 'In progress, locked', DONE: 'Done', CANCELLED: 'Cancelled', RETURNED: 'Returned' };
const ACTION_LABEL: Record<string, string> = { confirm_payment: 'Confirm payment received', schedule_installation: 'Schedule installation', dispatch_technician: 'Dispatch technician', complete_installation: 'Mark installation complete', ship: 'Ship goods', deliver: 'Mark delivered', ready_for_collection: 'Ready for collection', collect: 'Customer has collected' };

export default function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useAuth();
  const meta = useApi('/meta');
  const [ref, setRef] = useState('');
  const { data: o, error, loading, reload } = useApi(`/orders/${id}`);
  const { run, busy, error: aerr } = useAction(reload);
  const [slot, setSlot] = useState('');
  const [reason, setReason] = useState('');
  const [deduction, setDeduction] = useState('');
  const [condition, setCondition] = useState('GOOD');
  const [confirming, setConfirming] = useState<string | null>(null);
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
            {o.lines.map((l: any) => <tr key={l.id}><Td>{l.description}{l.options?.colour && <div className="text-caption text-label2">{l.options.colour}{l.options.storage ? ` · ${l.options.storage}` : ''}</div>}{l.msisdn && <div className="font-mono text-caption text-label2">port-in {l.msisdn}</div>}{l.payMode === 'INSTALLMENT' && <div className="text-caption text-label2">{l.installmentMonths} instalments{l.downPaymentMinor > 0 ? `, ${money(l.downPaymentMinor, o.currency)} down` : ''}</div>}{l.discountMinor > 0 && l.discountRules.length > 0 && <div className="text-caption text-success">bundle discount {money(l.discountMinor, o.currency)}</div>}{l.status !== 'ACTIVE' && <div className="text-caption text-danger">{label(l.status)}</div>}</Td><Td right>{l.quantity.toLocaleString()}</Td><Td right>{money(l.netMinor, o.currency)}</Td><Td right>{money(l.taxMinor, o.currency)}</Td><Td right>{money(l.netMinor + l.taxMinor, o.currency)}</Td></tr>)}
            <tr><Td className="font-semibold">Paid at checkout{o.lines.some((l: any) => l.payMode === 'INSTALLMENT') && <span className="font-normal text-label2"> (the rest is billed monthly)</span>}</Td><Td /><Td /><Td /><Td right className="font-semibold">{money(o.totalMinor, o.currency)}</Td></tr>{o.refundedMinor > 0 && <tr><Td>Refunded</Td><Td /><Td /><Td /><Td right>− {money(o.refundedMinor, o.currency)}</Td></tr>}
          </tbody></TableWrap>

          {o.payments.length > 0 && <><SectionTitle>Payments</SectionTitle><TableWrap><thead><tr><Th>Method</Th><Th>Status</Th><Th right>Amount</Th></tr></thead><tbody>
            {o.payments.map((p: any) => <tr key={p.id}><Td>{label(p.method)}</Td><Td><Badge tone={tone(p.status === 'CAPTURED' ? 'PAID' : p.status)}>{label(p.status)}</Badge></Td><Td right>{money(p.amountMinor, o.currency)}{p.refundedMinor > 0 && <div className="text-caption text-label2">{money(p.refundedMinor, o.currency)} refunded</div>}</Td></tr>)}</tbody></TableWrap></>}

          {o.groups.length > 0 && (<>
            <SectionTitle>Parts of this order</SectionTitle>
            <div className="space-y-3">
              {o.groups.map((g: any) => (
                <Card key={g.kind} className="!p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">{GROUP_TITLE[g.kind]}</h3>
                    <span className="flex items-center gap-2">{g.atRisk && <Badge tone="danger">At risk: running late</Badge>}<Badge tone={tone(g.status === 'DONE' ? 'COMPLETED' : g.status === 'LOCKED' ? 'SHIPPED' : g.status)}>{GROUP_STATUS[g.status]}</Badge></span>
                  </div>
                  <p className="mt-1 text-subhead text-label2">
                    {g.status === 'CANCELLED' ? `Cancelled${g.refundedMinor > 0 ? ` · ${money(g.refundedMinor, o.currency)} refunded` : ''}${g.feeMinor > 0 ? ` · ${money(g.feeMinor, o.currency)} kept` : ''}${g.details?.cancelReason ? ` · ${g.details.cancelReason}` : ''}`
                      : g.status === 'RETURNED' ? `Returned · ${money(g.refundedMinor, o.currency)} refunded${g.feeMinor > 0 ? ` · ${money(g.feeMinor, o.currency)} kept` : ''}`
                      : g.canCancel ? `Can still be cancelled${g.refundMinor > 0 ? `: refunds ${money(g.refundMinor, o.currency)}` : ''}${g.feeMinor > 0 ? `, keeping ${money(g.feeMinor, o.currency)}` : ''}${g.clawbackMinor > 0 ? `, less ${money(g.clawbackMinor, o.currency)} of bundle discount that would no longer apply` : ''}.`
                      : g.returnable ? `Delivered. Can be returned${g.returnUntil ? ` until ${d(g.returnUntil)}` : ''} for up to ${money(g.refundMinor, o.currency)}.${g.needsOverride ? ' Needs a supervisor’s approval.' : ''}` : g.needsOverride ? `${g.why}${can('order:override') ? '' : ' Ask a supervisor to approve it.'}` : g.why}
                    {g.kind === 'GOODS' && g.details?.trackingNumber && <span> Tracking <span className="font-mono">{g.details.trackingNumber}</span>.</span>}
                  </p>
                  {can('order:cancel') && g.returnable && (!g.needsOverride || can('order:override')) && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_150px_150px_auto] sm:items-end">
                      <Field label="Reason for the return"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                      <Field label="Condition"><Select value={condition} onChange={(e) => setCondition(e.target.value)}><option value="GOOD">As new</option><option value="DAMAGED">Damaged</option><option value="INCOMPLETE">Missing parts</option></Select></Field>
                      <Field label="Damage deduction"><Input type="number" min="0" value={deduction} onChange={(e) => setDeduction(e.target.value)} placeholder="0.00" /></Field>
                      <Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => { if (confirm('Return these goods and refund the customer?')) void act('return', { reason, condition, deductionMinor: deduction ? toMinor(deduction) : undefined }); }}>Return goods</Button>
                    </div>
                  )}
                  {can('order:cancel') && (g.canCancel || (g.needsOverride && can('order:override'))) && o.groups.filter((x: any) => x.canCancel || x.needsOverride).length > 1 && (
                    confirming === g.kind
                      ? <div className="mt-3 flex gap-2"><Button variant="destructive" disabled={busy} onClick={() => { setConfirming(null); void act('cancel', { reason: reason || 'cancelled by user', groups: [g.kind] }); }}>Confirm: cancel the {gt(g.kind).toLowerCase()}</Button><Button variant="secondary" onClick={() => setConfirming(null)}>Keep</Button></div>
                      : <Button className="mt-3" variant="secondary" onClick={() => setConfirming(g.kind)}>Cancel only the {gt(g.kind).toLowerCase()}…</Button>
                  )}
                </Card>
              ))}
            </div>
          </>)}

          {o.services.length > 0 && <><SectionTitle>Services activated {o.serviceCount > o.services.length && <span className="text-subhead font-normal text-label2">(showing {o.services.length} of {o.serviceCount.toLocaleString()})</span>}</SectionTitle>
            <TableWrap><thead><tr><Th>Number / ID</Th><Th>Type</Th><Th>Status</Th></tr></thead><tbody>{o.services.map((s: any) => <tr key={s.id}><Td className="font-mono">{s.identifier}</Td><Td>{label(s.type)}</Td><Td><Badge tone={tone(s.status)}>{label(s.status)}</Badge></Td></tr>)}</tbody></TableWrap></>}

          {o.appointments.length > 0 && <><SectionTitle>Installation</SectionTitle><TableWrap><thead><tr><Th>Window</Th><Th>Status</Th></tr></thead><tbody>
            {o.appointments.map((a: any, i: number) => <tr key={i}><Td>{dt(a.slotStart)} – {dt(a.slotEnd)}</Td><Td><Badge tone={tone(a.status)}>{label(a.status)}</Badge></Td></tr>)}</tbody></TableWrap></>}
          {o.fulfilment.trackingNumber && <p className="mt-4 text-subhead">Tracking: <span className="font-mono">{o.fulfilment.trackingNumber}</span></p>}
          {o.fulfilment.delivery?.method === 'COLLECT'
            ? <p className="text-subhead text-label2">Collect in store: <span className="font-mono">{o.fulfilment.delivery.pickupStoreId}</span>{o.fulfilment.readyForCollection ? ' · ready for collection' : ''}</p>
            : o.fulfilment.address && <p className="text-subhead text-label2">Address: {o.fulfilment.address}</p>}
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
                {o.cancelAll && o.cancelAll.kinds.length > 0 && (
                  <p className="text-subhead text-label2">Cancels {o.cancelAll.kinds.map((k: string) => gt(k).toLowerCase()).join(' and ')}. Refunds <strong className="text-label">{money(o.cancelAll.refundMinor, o.currency)}</strong>
                    {o.cancelAll.feeMinor > 0 ? `, keeping a ${money(o.cancelAll.feeMinor, o.currency)} call-out fee` : ''}{o.cancelAll.clawbackMinor > 0 ? `, less ${money(o.cancelAll.clawbackMinor, o.currency)} of bundle discount that no longer applies` : ''}.
                    {o.groups.some((g: any) => !g.canCancel && ['LOCKED', 'DONE'].includes(g.status)) && ' Parts already shipped, dispatched or active stay.'}</p>
                )}
                <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Button variant="destructive" className="w-full" disabled={busy} onClick={() => act('cancel', { reason: reason || 'cancelled by user' })}>Cancel order</Button></>
              ) : o.groups.some((g: any) => g.needsOverride) ? <Alert tone="info">Cancelling this order needs a supervisor’s approval under the cancellation rules. Ask someone with override approval to do it.</Alert> : <Alert tone="info">Past the point of no return: goods shipped, the technician dispatched or the service switched on. Delivered goods can be returned within the cooling-off period; services are ended under their contract terms.</Alert>}
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
