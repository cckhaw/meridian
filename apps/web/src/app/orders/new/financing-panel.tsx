'use client';
import { Alert, Badge, Button, Card, Field, Input } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction } from '@/lib/api';
import { money } from '@/lib/format';
import { lineBody } from './wizard-types';
import type { Wizard } from './steps';

/** Review step, for a device on a contract: paid over the contract by default, a credit check for the upfront share, or pay in full. */
export function FinancingPanel({ w }: { w: Wizard }) {
  const q = w.quote;
  const f = q?.financing;
  const hasDevice = (q?.lines ?? []).some((l: any) => l.deal);
  const [id, setId] = useState('');
  const [agreed, setAgreed] = useState(false);
  const act = useAction();
  if (!hasDevice) return null;
  const fin = w.financing;
  const run = async () => {
    const r = await act.run(() => post('/orders/credit-check', { channel: w.channel, customerId: w.customer?.id, lines: w.items.map((i) => lineBody(i, w.items, w.joinGroup)), idNumber: id, consent: { given: agreed, how: w.portal ? 'online' : 'in person' } }));
    if (r) { fin.setCheck(r); setId(''); }
  };
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-title3 font-semibold">Paying for the device</p>
          <p className="text-subhead text-label2">{fin.payInFull ? 'The device is paid in full today.' : f ? `The price after the subsidy is split evenly over the ${f.months}-month contract and billed with the plan.` : 'Paid as set on the line.'}</p></div>
        <label className="flex items-center gap-2 text-subhead"><input type="checkbox" checked={fin.payInFull} onChange={(e) => fin.setPayInFull(e.target.checked)} /> Pay in full instead</label>
      </div>
      {f && !fin.payInFull && (
        <dl className="rounded-control bg-surface2 px-4 py-2 text-subhead">
          <div className="flex justify-between py-0.5"><dt className="text-label2">Financed</dt><dd className="tabular-nums">{money(f.financedMinor)}</dd></div>
          <div className="flex justify-between py-0.5"><dt className="text-label2">Upfront payment{f.requiresCreditCheck ? ' (estimate)' : ''}</dt><dd className="tabular-nums font-semibold">{money(f.upfrontMinor)} <span className="font-normal text-label2">({f.ratioBps / 100}%)</span></dd></div>
          <div className="flex justify-between py-0.5"><dt className="text-label2">Then each month for {f.months} months</dt><dd className="tabular-nums font-semibold">{money(f.instalmentMinor)}</dd></div>
        </dl>)}
      {f?.checkId && !fin.payInFull && (
        <p className="text-footnote text-label2"><Badge tone="success">Credit check done</Badge> {fin.check?.score !== null && fin.check?.score !== undefined ? `Score ${fin.check.score}${fin.check.band ? ` (${fin.check.band})` : ''}. ` : ''}{fin.check?.fallback ? 'The credit bureau could not be used, so the standard share applies. ' : ''}</p>)}
      {f?.requiresCreditCheck && !fin.payInFull && (
        <div className="space-y-3 border-t border-separator pt-3">
          <p className="text-subhead">A credit check decides how much is paid upfront. {w.customer ? '' : 'Choose the customer first.'}</p>
          {act.error && <Alert>{act.error}</Alert>}
          <Field label="Customer’s ID number" hint="Sent to the credit bureau; only a hash is kept."><Input value={id} maxLength={40} autoComplete="off" onChange={(e) => setId(e.target.value)} /></Field>
          <label className="flex items-start gap-2 text-subhead"><input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> The customer agrees to a credit check on their ID number.</label>
          <Button disabled={act.busy || !w.customer || !agreed || id.trim().length < 3} onClick={() => void run()}>{act.busy ? 'Checking…' : 'Run credit check'}</Button>
        </div>)}
    </Card>
  );
}
