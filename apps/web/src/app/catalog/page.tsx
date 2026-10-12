'use client';
import { Alert, Badge, Button, Card, Empty, LargeTitle, Input, SectionTitle, Segmented, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { patch, useAction, useApi } from '@/lib/api';
import { label, money } from '@/lib/format';

const NETS = [{ value: '', label: 'All' }, { value: 'mobile', label: 'Mobile' }, { value: 'fiber', label: 'Fibre' }, { value: 'iot', label: 'IoT' }, { value: 'none', label: 'Other' }];

/** Mirrors core `quoteEtc` for the interactive preview; the server remains the source of truth when a service is terminated. */
function etc(o: any, elapsed: number): number {
  const c = o.contract; if (!c?.termMonths || !c.etc) return 0;
  const remaining = c.termMonths - Math.min(elapsed, c.termMonths);
  if (remaining === 0 || (c.etc.waiveInLastMonths !== undefined && remaining <= c.etc.waiveInLastMonths)) return 0;
  if (c.etc.method === 'SUBSIDY_AMORTISED') return Math.min(Math.round((c.subsidy.subsidyAmount.amountMinor * remaining) / c.termMonths), Math.round(c.subsidy.subsidyAmount.amountMinor * (c.etc.capSubsidyFraction ?? 1)));
  const fee = o.prices.find((p: any) => p.type === 'RECURRING')?.amount.amountMinor ?? 0;
  return Math.round((fee * remaining * (c.etc.percentOfRemaining ?? 100)) / 100);
}

export default function Catalog() {
  const [net, setNet] = useState('');
  const [q, setQ] = useState('');
  const [elapsed, setElapsed] = useState(6);
  const { data, error, loading, reload } = useApi(`/catalog?level=OFFER&q=${encodeURIComponent(q)}${net ? `&path=${net}` : ''}`);
  const act = useAction(reload);
  return (
    <>
      <LargeTitle subtitle="Network type → Category → Group → Offer. Live from the catalog database.">Catalog</LargeTitle>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center">
        <Segmented label="Network" value={net} options={NETS} onChange={setNet} />
        <Input type="search" aria-label="Search offers" placeholder="Search offers…" value={q} onChange={(e) => setQ(e.target.value)} className="lg:max-w-xs" />
        <label className="flex items-center gap-3 text-subhead text-label2 lg:ml-auto">Months elapsed <span className="w-6 font-semibold text-label">{elapsed}</span>
          <input type="range" min={0} max={36} value={elapsed} onChange={(e) => setElapsed(Number(e.target.value))} className="min-h-tap w-40 accent-[rgb(var(--accent))]" aria-label="Months elapsed for ETC preview" /></label>
      </div>
      {act.error && <Alert>{act.error}</Alert>}
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && (data.items.length === 0 ? <Empty>No offers.</Empty> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.items.map((o: any) => {
            const rec = o.prices.find((p: any) => p.type === 'RECURRING'), once = o.prices.filter((p: any) => p.type === 'ONE_TIME');
            return (
              <Card key={o.id} className="flex flex-col">
                <div className="mb-1 flex items-start justify-between gap-2"><h2 className="text-title3 font-semibold">{o.name}</h2><Badge tone={o.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(o.status)}</Badge></div>
                <p className="mb-1 text-footnote text-label2">{label(o.kind)} · <span className="font-mono">{o.path}</span></p>
                {o.description && <p className="mb-2 text-subhead text-label2">{o.description}</p>}
                {rec && <p className="text-title2 font-semibold">{money(rec.amount.amountMinor, rec.amount.currency)}<span className="text-subhead font-normal text-label2"> /mo incl. tax</span></p>}
                {once.map((p: any, i: number) => <p key={i} className="text-subhead text-label2">{p.amount.amountMinor ? `${money(p.amount.amountMinor, p.amount.currency)} upfront` : 'No upfront cost'}</p>)}
                {o.contract?.termMonths > 0 && (<>
                  <p className="mt-1 text-subhead text-label2">{o.contract.termMonths}-month contract · ETC: {label(o.contract.etc.method)}</p>
                  <p className="mt-2 rounded-control bg-surface2 p-3 text-footnote">Early termination at month {Math.min(elapsed, o.contract.termMonths)}: <strong>{money(etc(o, elapsed))}</strong></p></>)}
                <div className="mt-auto flex gap-2 pt-4">
                  {o.status === 'ACTIVE'
                    ? <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => patch(`/catalog/${o.id}`, { status: 'RETIRED' }))}>Retire</Button>
                    : <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => patch(`/catalog/${o.id}`, { status: 'ACTIVE' }))}>Activate</Button>}
                </div>
              </Card>
            );
          })}
        </div>
      ))}
      <SectionTitle>Hierarchy</SectionTitle>
      <Hierarchy />
    </>
  );
}

function Hierarchy() {
  const { data } = useApi('/catalog?level=GROUP');
  if (!data) return null;
  const byNet = new Map<string, string[]>();
  for (const g of data.items) { const [n, c] = g.path.split('/'); byNet.set(`${n} / ${c}`, [...(byNet.get(`${n} / ${c}`) ?? []), g.name]); }
  return <Card><ul className="space-y-1 text-subhead">{[...byNet].map(([k, v]) => <li key={k}><span className="font-mono text-label2">{k}</span> → {v.join(', ')}</li>)}</ul></Card>;
}
