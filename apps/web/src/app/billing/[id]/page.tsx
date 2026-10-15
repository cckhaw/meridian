'use client';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Td, Th } from '@meridian/ui';
import Link from 'next/link';
import { use, useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';
import { useBrand } from '@/components/settings-provider';
import { useAuth } from '@/lib/auth';
import { d, dt, label, money, step, toMinor, tone } from '@/lib/format';

export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can, me } = useAuth();
  const brand = useBrand();
  const meta = useApi('/meta');
  const [ref, setRef] = useState('');
  const { data: i, error, loading, reload } = useApi(`/invoices/${id}`);
  const [amt, setAmt] = useState('');
  const [method, setMethod] = useState('CREDIT_CARD');
  const [cAmt, setCAmt] = useState('');
  const [reason, setReason] = useState('');
  const payA = useAction(reload), credA = useAction(reload);
  if (error) return <Alert>{error}</Alert>;
  if (loading && !i) return <Spinner />;
  if (!i) return null;
  const open = i.balanceMinor > 0 && i.status !== 'VOID';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <article className="rounded-card bg-surface p-6 shadow-card sm:p-8 print:shadow-none" aria-label={`Invoice ${i.number}`}>
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-separator pb-5">
          <div><p className="text-title2 font-bold">{brand.name}</p><p className="text-footnote text-label2">Tax invoice</p></div>
          <div className="text-right"><p className="text-title3 font-semibold">{i.number}</p><Badge tone={tone(i.status)}>{label(i.status)}</Badge></div>
        </header>
        <dl className="grid gap-4 py-5 text-subhead sm:grid-cols-3">
          <div><dt className="text-label2">Billed to</dt><dd>{can('customer:search') ? <Link className="font-medium text-accent" href={`/customers/${i.customerId}`}>{i.customerName}</Link> : <span className="font-medium">{i.customerName}</span>}<div className="text-label2">{i.accountName}</div></dd></div>
          <div><dt className="text-label2">Period</dt><dd>{d(i.periodStart)} – {d(i.periodEnd)}</dd></div>
          <div><dt className="text-label2">Issued / due</dt><dd>{d(i.issueDate)} / <span className={i.status === 'OVERDUE' ? 'font-medium text-danger' : ''}>{d(i.dueDate)}</span></dd></div>
        </dl>
        <div className="overflow-x-auto rounded-card bg-surface2">
          <table className="w-full text-left text-subhead"><thead><tr><Th>Description</Th><Th right>Net</Th><Th right>{i.taxName}</Th></tr></thead><tbody>
            {i.lines.map((l: any) => <tr key={l.id}><Td>{l.description}</Td><Td right className="whitespace-nowrap">{money(l.netMinor, i.currency)}</Td><Td right className="whitespace-nowrap">{money(l.taxMinor, i.currency)}</Td></tr>)}
          </tbody></table>
        </div>
        <dl className="ml-auto mt-5 max-w-xs space-y-1 text-subhead">
          <div className="flex justify-between"><dt className="text-label2">Subtotal</dt><dd className="tabular-nums">{money(i.netMinor, i.currency)}</dd></div>
          <div className="flex justify-between"><dt className="text-label2">{i.taxName}</dt><dd className="tabular-nums">{money(i.taxMinor, i.currency)}</dd></div>
          <div className="flex justify-between font-semibold"><dt>Total</dt><dd className="tabular-nums">{money(i.totalMinor, i.currency)}</dd></div>
          {i.creditedMinor > 0 && <div className="flex justify-between"><dt className="text-label2">Credit notes</dt><dd className="tabular-nums">−{money(i.creditedMinor, i.currency)}</dd></div>}
          <div className="flex justify-between"><dt className="text-label2">Paid</dt><dd className="tabular-nums">−{money(i.paidMinor, i.currency)}</dd></div>
          <div className="flex justify-between border-t border-separator pt-2 text-title3 font-semibold"><dt>Balance due</dt><dd className="tabular-nums">{money(i.balanceMinor, i.currency)}</dd></div>
        </dl>
        {i.payments.length > 0 && <div className="mt-6 text-footnote text-label2">{i.payments.map((p: any) => <p key={p.id}>{dt(p.createdAt)} · {label(p.method)} · {p.status === 'REFUNDED' ? 'refund' : 'payment'} {money(p.amountMinor, i.currency)}</p>)}</div>}
        <div className="mt-6 flex flex-wrap gap-2 print:hidden"><Button variant="secondary" onClick={() => window.print()}>Print this page</Button><a className="inline-flex min-h-tap items-center rounded-control bg-accent px-4 text-subhead font-semibold text-[rgb(var(--accent-label))]" href={`/api/invoices/${id}/pdf`} target="_blank" rel="noreferrer">Download the PDF bill</a></div>
      </article>

      <aside className="space-y-4 print:hidden">
        {payA.ok && <Alert tone="success">{payA.ok}. Balance is now {money(i.balanceMinor, i.currency)}.</Alert>}
        {open && can('billing:pay') && (
          <Card className="space-y-3">
            <h2 className="text-title3 font-semibold">Record payment</h2>
            <Field label="Amount" hint={`Outstanding ${money(i.balanceMinor, i.currency)}; leave blank to pay in full`}><Input type="number" step={step()} min="0" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
            <Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="CREDIT_CARD">Credit card</option><option value="CASH">Cash</option><option value="QR">QR</option></Select></Field>
            <Field label={method === 'CASH' ? 'Receipt number' : method === 'QR' ? 'QR transaction reference' : 'Terminal approval code'} hint={meta.data?.paymentMode === 'manual' ? 'Required: the evidence the money was received.' : undefined}><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
            {payA.error && <Alert>{payA.error}</Alert>}
            <Button className="w-full" disabled={payA.busy} onClick={() => payA.run(() => post(`/invoices/${id}/pay`, { amountMinor: amt ? toMinor(amt) : undefined, method, reference: ref || undefined }), 'Payment recorded')}>Record payment</Button>
          </Card>
        )}
        {i.status !== 'VOID' && can('billing:credit') && (
          <Card className="space-y-3">
            <h2 className="text-title3 font-semibold">Credit note</h2>
            <Field label="Amount" hint={`Reduces what is owed; refunds the excess if already paid. ${me?.creditLimitMinor === null ? 'No limit on your role.' : `Your limit is ${money(me?.creditLimitMinor ?? 0, i.currency)} per credit note.`}`}><Input type="number" step={step()} min="0" value={cAmt} onChange={(e) => setCAmt(e.target.value)} /></Field>
            <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            {credA.error && <Alert>{credA.error}</Alert>}{credA.ok && <Alert tone="success">{credA.ok}</Alert>}
            <Button variant="secondary" className="w-full" disabled={credA.busy || !cAmt || !reason} onClick={() => credA.run(() => post(`/invoices/${id}/credit`, { amountMinor: toMinor(cAmt), reason }), 'Credit note issued')}>Issue credit note</Button>
          </Card>
        )}
      </aside>
    </div>
  );
}
