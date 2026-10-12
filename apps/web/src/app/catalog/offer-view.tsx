'use client';
import { Badge, MenuButton } from '@meridian/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { label, money, tone } from '@/lib/format';
import { LineItemsSection } from './line-items';
import { Crumbs, type Actions } from './node-view';
import type { TreeNode } from './node-modals';

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section><h3 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{title}</h3>{children}</section>
);
const Rows = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl className="divide-y divide-separator rounded-card bg-surface shadow-card">
    {rows.map(([k, v]) => <div key={k} className="flex min-h-[44px] items-start justify-between gap-4 px-4 py-2.5"><dt className="text-subhead text-label2">{k}</dt><dd className="text-right text-subhead">{v}</dd></div>)}
  </dl>
);

export function OfferView({ offer, trail, siblings, byId, a, onChanged }: { offer: TreeNode; trail: TreeNode[]; siblings: TreeNode[]; byId: Map<string, TreeNode>; a: Actions; onChanged: () => void }) {
  const rec = offer.prices?.find((p: any) => p.type === 'RECURRING');
  const once = offer.prices?.filter((p: any) => p.type === 'ONE_TIME') ?? [];
  const c = offer.contract;
  const sold = (offer.usage?.services ?? 0) + (offer.usage?.orders ?? 0);
  const idx = siblings.findIndex((s) => s.id === offer.id);
  const f = offer.fulfilment ?? {};
  const chips = (ids: string[]) => ids.length === 0 ? <span className="text-label2">None</span> : (
    <span className="flex flex-wrap justify-end gap-1.5">
      {ids.map((id) => { const n = byId.get(id); return (
        <button key={id} onClick={() => n && a.onSelect(n.id)} disabled={!n} className="rounded-full bg-surface2 px-3 py-1 text-subhead hover:bg-separator focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{n ? (n.level === 'OFFER' ? n.name : `Any ${n.name}`) : `${id} (missing)`}</button>
      ); })}
    </span>
  );
  const fulfil = [f.requiresShipping && 'Ships to the customer', f.requiresInstallation && 'Installation visit', f.requiresSimActivation && 'SIM activation'].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <div>
        <Crumbs trail={trail} onSelect={a.onSelect} />
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-footnote font-medium uppercase tracking-wide text-accent">{label(offer.kind ?? 'Offer')}</p>
            <h1 className="text-title1 font-bold tracking-tight sm:text-large-title">{offer.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-subhead text-label2"><Badge tone={tone(offer.status)}>{offer.status === 'ACTIVE' ? 'Live' : label(offer.status)}</Badge>{offer.description}</p>
          </div>
          {a.editable && (
            <div className="flex items-center gap-1">
              <Link href={`/catalog/edit/${offer.id}`} className="inline-flex min-h-[40px] items-center gap-2 rounded-control bg-accent px-4 text-subhead font-medium text-accent-fg hover:opacity-90"><span aria-hidden>✎</span>Edit offer</Link>
              <MenuButton label={`Actions for ${offer.name}`} items={[
                { label: offer.status === 'ACTIVE' ? 'Retire' : 'Make live', onSelect: () => a.onStatus(offer.id, offer.status === 'ACTIVE' ? 'RETIRED' : 'ACTIVE') },
                { label: 'Move up', onSelect: () => a.onReorder(offer.id, 'up'), disabled: idx <= 0, divider: true },
                { label: 'Move down', onSelect: () => a.onReorder(offer.id, 'down'), disabled: idx < 0 || idx >= siblings.length - 1 },
                { label: 'Create a new version', href: `/catalog/manage?from=${offer.id}`, divider: true },
                { label: 'Delete…', onSelect: () => a.onEdit(offer), tone: 'danger' },
              ]} />
            </div>
          )}
        </header>
      </div>

      <LineItemsSection offer={offer} editable={a.editable} onChanged={onChanged} />

      <Group title="Pricing">
        <Rows rows={[
          ['Monthly fee', rec ? <>{money(rec.amount.amountMinor)}<span className="text-label2"> /month</span></> : <span className="text-label2">None</span>],
          ...once.map((p: any, i: number): [string, ReactNode] => [i ? `Upfront ${i + 1}` : 'Upfront', p.amount.amountMinor ? money(p.amount.amountMinor) : <span className="text-label2">No upfront cost</span>]),
          ['Contract', c?.termMonths ? `${c.termMonths} months` : 'No contract'],
          ...(c?.termMonths ? [['Early exit', label(c.etc?.method ?? '')] as [string, ReactNode]] : []),
          ...(c?.subsidy ? [['Device subsidy', `${money(c.subsidy.subsidyAmount.amountMinor)} of ${money(c.subsidy.deviceRetailPrice.amountMinor)}`] as [string, ReactNode]] : []),
        ]} />
      </Group>

      <Group title="Rules">
        <Rows rows={[
          ['Customer must first have', chips(offer.requires ?? [])],
          ['Cannot be bought with', chips(offer.excludes ?? [])],
          ['Sold through', (offer.salesChannels?.length ?? 0) ? offer.salesChannels!.map(label).join(', ') : <span className="text-label2">All channels</span>],
          ['Markets', (offer.markets?.length ?? 0) ? offer.markets!.join(', ') : <span className="text-label2">All</span>],
          ['Fulfilment', fulfil.length ? fulfil.join(' · ') : <span className="text-label2">Digital, nothing to ship</span>],
        ]} />
      </Group>

      {sold > 0 && (
        <Group title="Sales"><Rows rows={[['Subscribers', (offer.usage?.services ?? 0).toLocaleString()], ['Order lines', (offer.usage?.orders ?? 0).toLocaleString()]]} /></Group>
      )}
    </div>
  );
}
