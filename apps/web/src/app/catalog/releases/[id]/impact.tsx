'use client';
import { Alert, Badge, Button, Empty, Field, Input, Modal, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, money } from '@/lib/format';
import { NodePicker, type Picked } from '../../node-picker';

interface OfferImpact { id: string; name: string; why: string[]; services: number; inFlightOrders: number; dependents: Array<{ id: string; name: string; via: string }>; capped: boolean }
interface Figures { dueNowMinor: number; monthlyPlanMinor: number; monthlyInstalmentMinor: number; discountMinor: number; problems: string[] }
interface Row { personaId: string | null; name: string; before: Figures | { error: string }; after: Figures | { error: string }; delta?: { dueNowMinor: number; monthlyPlanMinor: number; monthlyInstalmentMinor: number; discountMinor: number }; changed: boolean }
interface Persona { id: string; name: string; description: string; basket: { channel: string; lines: Array<{ offerId: string; quantity?: number }>; payment: { method: string } } }

const count = (n: number, capped: boolean) => (capped && n >= 10_000 ? '10,000+' : n.toLocaleString());
const signed = (n: number) => (n === 0 ? '±0' : `${n > 0 ? '+' : '−'}${money(Math.abs(n))}`);

/** Who is affected: the live services and orders on each offer the release retires, deletes, reprices or changes, and what depends on it. */
export function ImpactPanel({ releaseId }: { releaseId: string }) {
  const imp = useApi<{ offers: OfferImpact[]; skipped: number }>(`/catalog/releases/${releaseId}/impact`);
  if (imp.error) return <Alert>{imp.error}</Alert>;
  if (!imp.data) return <Spinner />;
  const rows = imp.data.offers;
  if (!rows.length) return null;
  return (
    <section className="mb-6" aria-label="Who is affected">
      <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">Who is affected</h2>
      <ul className="space-y-3">
        {rows.map((o) => (
          <li key={o.id} className="rounded-card bg-surface p-4 shadow-card">
            <p className="mb-1 flex flex-wrap items-center gap-2"><span className="font-medium">{o.name}</span>{o.why.map((w) => <Badge key={w} tone={w === 'retired' || w === 'deleted' ? 'danger' : 'neutral'}>{label(w)}</Badge>)}</p>
            <p className="text-subhead">
              <span className={o.services ? 'font-medium' : 'text-label2'}>{count(o.services, o.capped)} live service{o.services === 1 ? '' : 's'}</span>
              <span className="text-label2"> · </span>
              <span className={o.inFlightOrders ? 'font-medium' : 'text-label2'}>{count(o.inFlightOrders, o.capped)} order{o.inFlightOrders === 1 ? '' : 's'} in progress</span>
            </p>
            {o.dependents.length > 0 && <p className="mt-1 text-subhead text-label2">Also named by: {o.dependents.map((d) => `${d.name} (${d.via})`).join(', ')}</p>}
          </li>
        ))}
      </ul>
      {imp.data.skipped > 0 && <p className="mt-2 px-1 text-footnote text-label2">{imp.data.skipped} more offers are not counted here.</p>}
    </section>
  );
}

function PersonaModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [offer, setOffer] = useState<Picked | null>(null);
  const [qty, setQty] = useState('1');
  const [channel, setChannel] = useState('SELF_SERVE');
  const [method, setMethod] = useState('CREDIT_CARD');
  const act = useAction(onDone);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!offer) return;
    if (await act.run(() => post('/catalog/pricing-personas', { name: name.trim(), basket: { channel, payment: { method }, lines: [{ offerId: offer.id, quantity: Math.max(1, Math.floor(Number(qty) || 1)) }] } }))) onClose();
  };
  return (
    <Modal title="New sample basket" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {act.error && <Alert>{act.error}</Alert>}
        <Field label="Name"><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Student on a 5G SIM" /></Field>
        {offer ? <p className="text-subhead">Offer: <span className="font-medium">{offer.name}</span> <button type="button" className="text-accent" onClick={() => setOffer(null)}>Change</button></p> : <NodePicker levels={['OFFER']} placeholder="Find the offer" onPick={setOffer} />}
        <Field label="Quantity"><Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 3))} /></Field>
        <Field label="Sold through"><Select value={channel} onChange={(e) => setChannel(e.target.value)}>{['SELF_SERVE', 'RETAIL_ASSISTED', 'QUICK_SALE', 'TELESALES', 'DEALER', 'CALL_CENTER'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
        <Field label="Paid by"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{['CREDIT_CARD', 'CASH', 'QR'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={act.busy || !name.trim() || !offer}>{act.busy ? 'Saving…' : 'Save basket'}</Button></div>
      </form>
    </Modal>
  );
}

const cell = (f: Figures | { error: string }, k: 'dueNowMinor' | 'monthlyPlanMinor') => ('error' in f ? <span className="text-danger">{f.error}</span> : money(f[k]));

/** What the release does to the price of the saved sample baskets: priced with the real pricing, on the live catalogue and as the release would leave it. */
export function WhatIfPanel({ releaseId }: { releaseId: string }) {
  const { can } = useAuth();
  const list = useApi<{ items: Persona[] }>('/catalog/pricing-personas');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const run = async () => { const r = await act.run(() => post<{ rows: Row[] }>(`/catalog/releases/${releaseId}/what-if`, {})); if (r) setRows(r.rows); };
  const remove = async (id: string) => { if (await act.run(() => del(`/catalog/pricing-personas/${id}`))) { await list.reload(); setRows((x) => x?.filter((r) => r.personaId !== id) ?? null); } };
  const baskets = list.data?.items ?? [];
  return (
    <section className="mb-6" aria-label="What it does to prices">
      <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">What it does to prices</h2>
      <div className="rounded-card bg-surface p-4 shadow-card">
        {act.error && <Alert>{act.error}</Alert>}
        {!baskets.length ? <Empty>No sample baskets yet. Save a typical order and see what each release does to its price.</Empty> : (
          <ul className="divide-y divide-separator text-subhead" aria-label="Sample baskets">
            {baskets.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate">{b.name} <span className="text-label2">· {b.basket.lines.map((l) => `${l.quantity && l.quantity > 1 ? `${l.quantity} × ` : ''}${l.offerId}`).join(', ')}</span></span>
                {can('catalog:write') && <button type="button" className="shrink-0 text-accent" onClick={() => remove(b.id)}>Remove</button>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={run} disabled={act.busy || !baskets.length}>{act.busy ? 'Pricing…' : rows ? 'Price again' : 'Price the baskets'}</Button>
          {can('catalog:write') && <Button variant="secondary" onClick={() => setAdding(true)}>New sample basket</Button>}
        </div>
        {rows && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-subhead">
              <thead className="text-footnote text-label2"><tr><th className="py-1 pr-3 font-medium">Basket</th><th className="py-1 pr-3 font-medium">Due now</th><th className="py-1 pr-3 font-medium">Monthly plan</th></tr></thead>
              <tbody className="divide-y divide-separator">
                {rows.map((r) => (
                  <tr key={r.personaId ?? r.name} className="align-top">
                    <td className="py-2 pr-3 font-medium">{r.name}{!r.changed && <span className="ml-2 font-normal text-label2">no change</span>}</td>
                    <td className="py-2 pr-3">{r.changed ? <><span className="text-label2">{cell(r.before, 'dueNowMinor')}</span> → {cell(r.after, 'dueNowMinor')}{r.delta && <span className="ml-1 text-label2">({signed(r.delta.dueNowMinor)})</span>}</> : cell(r.after, 'dueNowMinor')}</td>
                    <td className="py-2 pr-3">{r.changed ? <><span className="text-label2">{cell(r.before, 'monthlyPlanMinor')}</span> → {cell(r.after, 'monthlyPlanMinor')}{r.delta && <span className="ml-1 text-label2">({signed(r.delta.monthlyPlanMinor)})</span>}</> : cell(r.after, 'monthlyPlanMinor')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && <PersonaModal onClose={() => setAdding(false)} onDone={() => { void list.reload(); }} />}
    </section>
  );
}
