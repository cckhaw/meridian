'use client';
import { Card, Field, Input, SearchField, Select } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { useApi, useDebounced } from '@/lib/api';
import { StorePicker } from '@/app/stores/store-picker';
import type { Party, Wizard } from './steps';

export const CHANNEL_LABEL: Record<string, string> = {
  RETAIL_ASSISTED: 'Retail store', QUICK_SALE: 'Quick sale (walk-in)', CALL_CENTER: 'Call center', TELESALES: 'Telesales', DEALER: 'Dealer', SELF_SERVE: 'Self-serve',
};
const WHO: Record<string, string> = {
  RETAIL_ASSISTED: 'Counter sale recorded against your login and your store.',
  QUICK_SALE: 'Walk-in sale recorded against your login and your store.',
  CALL_CENTER: 'Recorded against your login.',
  TELESALES: 'Recorded against your login.',
  DEALER: 'You are placing this on the dealer’s behalf. The dealer and the agent who sold it are recorded with the order.',
};

/** A read-only line: who or what is fixed by the login and cannot be changed here. */
function Fixed({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <Field label={label} hint={hint}><Input readOnly value={value} className="bg-surface2" /></Field>;
}

function DealerPicker({ w }: { w: Wizard }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  // A dealer's own login is bound to one dealer; staff acting on behalf search all active dealers.
  const found = useApi<{ items: any[] }>(w.dealer ? null : `/dealers?status=ACTIVE&limit=8&q=${encodeURIComponent(term)}`);
  useEffect(() => { // bound login: the only dealer visible is theirs
    if (w.fixedDealer && !w.dealer && found.data?.items[0]) w.setDealer({ id: found.data.items[0].id, name: found.data.items[0].name });
  }, [found.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const agents = useApi<{ items: any[] }>(w.dealer ? `/dealers/${encodeURIComponent(w.dealer.id)}/agents?status=ACTIVE&limit=100` : null);
  const items = agents.data?.items ?? [];
  return (
    <>
      <Field label="Dealer" hint={w.dealer ? (w.fixedDealer ? 'Taken from your login' : undefined) : 'Search by dealer id or name'}>
        {w.dealer ? (
          <div className="flex min-h-tap items-center justify-between gap-3 rounded-control bg-surface2 px-4">
            <span><span className="font-mono text-footnote text-label2">{w.dealer.id}</span> <span className="ml-2">{w.dealer.name}</span></span>
            {!w.fixedDealer && <button type="button" className="text-accent" onClick={() => { w.setDealer(null); w.setAgent(null); setQ(''); }}>Change</button>}
          </div>
        ) : (
          <div>
            <SearchField label="Find dealer" placeholder="Dealer id or name…" value={q} onChange={setQ} />
            <ul className="mt-2 divide-y divide-separator overflow-hidden rounded-control bg-surface2">
              {(found.data?.items ?? []).map((d) => (
                <li key={d.id}><button type="button" className="flex min-h-tap w-full items-center gap-3 px-4 text-left hover:bg-surface" onClick={() => { w.setDealer({ id: d.id, name: d.name }); w.setAgent(null); }}>
                  <span className="font-mono text-footnote text-label2">{d.id}</span><span>{d.name}</span>
                </button></li>
              ))}
              {found.data && found.data.items.length === 0 && <li className="px-4 py-3 text-subhead text-label2">{term ? 'No active dealer matches.' : 'No dealers set up yet. Add them under Dealers.'}</li>}
            </ul>
          </div>
        )}
      </Field>
      <Field label="Dealer agent" hint={w.dealer ? 'The agent who made this sale' : 'Choose the dealer first'}>
        <Select value={w.agent?.id ?? ''} disabled={!w.dealer} onChange={(e) => { const a = items.find((x) => x.id === e.target.value); w.setAgent(a ? { id: a.id, name: a.name } : null); }}>
          <option value="">{w.dealer ? (agents.data && items.length === 0 ? 'This dealer has no active agents' : 'Choose an agent…') : '—'}</option>
          {items.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.id}</option>)}
        </Select>
      </Field>
    </>
  );
}

/** Who is selling and through what: the channel, the person (always the signed-in user, or a dealer and agent chosen on their behalf) and the store. */
export function SellingPanel({ w }: { w: Wizard }) {
  const soldBy = `${w.soldBy.name} (${w.soldBy.username})`;
  return (
    <Card className="mb-5">
      <p className="mb-3 text-footnote font-semibold uppercase tracking-wide text-label2">Selling through</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel">
          {w.channels.length > 1
            ? <Select value={w.channel} onChange={(e) => w.setChannel(e.target.value)}>{w.channels.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>)}</Select>
            : <Input readOnly value={CHANNEL_LABEL[w.channel] ?? w.channel} className="bg-surface2" />}
        </Field>
        <Fixed label={w.channel === 'DEALER' ? 'Entered by' : 'Sold by'} value={soldBy} hint="Your login" />
        {w.retail && (w.fixedStore
          ? <Fixed label="Store" value={w.fixedStore} hint="Taken from your login" />
          : <Field label="Store"><StorePicker value={w.store} onChange={w.setStore} /></Field>)}
        {w.channel === 'DEALER' && <DealerPicker w={w} />}
      </div>
      {WHO[w.channel] && <p className="mt-3 text-footnote text-label2">{WHO[w.channel]}</p>}
    </Card>
  );
}
