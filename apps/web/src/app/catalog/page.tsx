'use client';
import { Badge, Card, LargeTitle, Segmented } from '@nexus/ui';
import { useMemo, useState } from 'react';
import { sampleOffers } from '@/lib/sample-catalog';

const kinds = [{ value: 'ALL', label: 'All' }, { value: 'MOBILE', label: 'Mobile' }, { value: 'FIBER', label: 'Fiber' }, { value: 'OTHER', label: 'Other' }] as const;
type Filter = (typeof kinds)[number]['value'];

const fmt = (minor: number, cur: string) => new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(minor / 100);

/** Mirrors services/catalog-service ETC (subsidy amortised) for an interactive preview. */
const etc = (subsidy: number, term: number, elapsed: number) => (term === 0 ? 0 : Math.round((subsidy * (term - Math.min(elapsed, term))) / term));

export default function CatalogPage() {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [elapsed, setElapsed] = useState(6);
  const rows = useMemo(() => sampleOffers.filter((o) => filter === 'ALL' || (filter === 'MOBILE' ? o.path.startsWith('mobile') : filter === 'FIBER' ? o.path.startsWith('fiber') : o.path.startsWith('none'))), [filter]);

  return (
    <>
      <LargeTitle subtitle="Network type → Category → Group → Offer">Catalog</LargeTitle>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Segmented label="Network" value={filter} options={[...kinds]} onChange={setFilter} />
        <label className="flex items-center gap-3 text-subhead text-label2">
          Months elapsed: <span className="w-6 font-semibold text-label">{elapsed}</span>
          <input type="range" min={0} max={36} value={elapsed} onChange={(e) => setElapsed(Number(e.target.value))} className="min-h-tap w-40 accent-[rgb(var(--accent))]" aria-label="Months elapsed" />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((o) => (
          <Card key={o.id}>
            <div className="mb-1 flex items-start justify-between gap-2"><h2 className="text-title3 font-semibold">{o.name}</h2><Badge>{o.kind.replace(/_/g, ' ')}</Badge></div>
            <p className="mb-3 font-mono text-caption text-label2">{o.path}</p>
            {o.monthly !== undefined && <p className="text-title2 font-semibold">{fmt(o.monthly, o.currency)}<span className="text-subhead font-normal text-label2"> /mo</span></p>}
            {!!o.term && <p className="mt-1 text-subhead text-label2">{o.term}-month contract</p>}
            {!!o.subsidy && o.term !== undefined && (
              <p className="mt-3 rounded-control bg-surface2 p-3 text-footnote">
                Early termination at month {Math.min(elapsed, o.term)}: <strong>{fmt(etc(o.subsidy, o.term, elapsed), o.currency)}</strong>
              </p>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
