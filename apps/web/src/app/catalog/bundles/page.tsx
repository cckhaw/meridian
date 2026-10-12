'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, money, step, toMinor } from '@/lib/format';

const KINDS = ['SIM_ONLY', 'SIM_DEVICE', 'WEARABLE', 'FIBER', 'IOT_CONNECTIVITY', 'VAS', 'NON_TELCO_SUBSCRIPTION', 'PHYSICAL_GOOD'];
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const kindName = (t: string) => (t.startsWith('kind:') ? label(t.slice(5)) : t.slice(6));

/** "Fibre + a phone plan = 10% off the phone": what must be in the order, what gets the discount, and by how much. */
export default function Bundles() {
  const { can } = useAuth();
  const rules = useApi<{ items: any[] }>('/bundle-rules');
  const act = useAction(rules.reload);
  const [f, setF] = useState({ name: '', a: 'FIBER', b: 'SIM_DEVICE', target: 'SIM_DEVICE', mode: 'percent', value: '10' });
  const edit = can('catalog:write');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const when = [...new Set([f.a, f.b])].map((k) => `kind:${k}`);
    const body = { id: slug(f.name), name: f.name.trim(), when, target: `kind:${f.target}`, ...(f.mode === 'percent' ? { percentBps: Math.round(Number(f.value) * 100) } : { amountMinor: toMinor(f.value) }) };
    if (await act.run(() => post('/bundle-rules', body))) setF({ ...f, name: '' });
  };
  return (
    <>
      <LargeTitle subtitle="Discounts that apply when certain products are bought together. They show on the quote and the order.">Bundle discounts</LargeTitle>
      <p className="mb-4"><Link href="/catalog" className="text-subhead text-accent">← Back to catalog</Link></p>
      {act.error && <div className="mb-4"><Alert>{act.error}</Alert></div>}
      {rules.loading && !rules.data && <Spinner />}
      {rules.data && (rules.data.items.length === 0 ? <Empty>No bundle discounts yet.</Empty> : (
        <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {rules.data.items.map((r: any) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.name} <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>{r.status === 'ACTIVE' ? 'Live' : label(r.status)}</Badge></p>
                <p className="text-footnote text-label2">When an order has {r.when.map(kindName).join(' + ')}: {r.percentBps !== undefined ? `${r.percentBps / 100}%` : money(r.amountMinor)} off {kindName(r.target)}</p>
              </div>
              {edit && <span className="flex gap-2">
                <Button variant="secondary" className="!min-h-[36px] !px-3 !text-subhead" onClick={() => act.run(() => patch(`/bundle-rules/${r.id}`, { ...r, status: r.status === 'ACTIVE' ? 'RETIRED' : 'ACTIVE' }))}>{r.status === 'ACTIVE' ? 'Retire' : 'Make live'}</Button>
                <Button variant="destructive" className="!min-h-[36px] !px-3 !text-subhead" onClick={() => { if (confirm(`Delete “${r.name}”? Orders already placed keep their discount.`)) void act.run(() => del(`/bundle-rules/${r.id}`)); }}>Delete</Button>
              </span>}
            </li>
          ))}
        </ul>
      ))}
      {edit && (
        <Card className="mt-6">
          <h2 className="mb-3 text-title3 font-semibold">New bundle discount</h2>
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Name" hint="What agents and customers will see, e.g. “Fibre + phone plan: 10% off the phone”."><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></Field></div>
            <Field label="Order contains"><Select value={f.a} onChange={(e) => setF({ ...f, a: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
            <Field label="and also"><Select value={f.b} onChange={(e) => setF({ ...f, b: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
            <Field label="Discount applies to"><Select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Type"><Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="percent">Percent off</option><option value="amount">Amount off</option></Select></Field>
              <Field label={f.mode === 'percent' ? 'Percent' : 'Amount'}><Input required type="number" min="0.01" step={f.mode === 'percent' ? '0.01' : step()} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
            </div>
            <div className="sm:col-span-2"><Button type="submit" disabled={act.busy || !slug(f.name)}>{act.busy ? 'Saving…' : 'Add discount'}</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
