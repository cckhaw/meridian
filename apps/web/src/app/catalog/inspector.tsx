'use client';
import { Badge, Button, MenuButton, Segmented } from '@meridian/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { label, money, tone } from '@/lib/format';
import { CHILD_LEVEL, LEVEL_NOUN, LEVEL_PLURAL, type CNode } from './catalog-ui';
import { LineItemsSection } from './line-items';

export interface Detail {
  node: CNode; trail: Array<{ id: string; name: string; level: string }>; lineItems: CNode[];
  requires: Array<{ id: string; name?: string; level?: string; missing?: true }>; excludes: Array<{ id: string; name?: string; level?: string; missing?: true }>;
  usage?: { services: number; orders: number; capped: boolean };
}
export interface Actions { editable: boolean; onOpen: (id: string) => void; onEdit: (n: CNode) => void; onAdd: (parent: CNode) => void; onStatus: (id: string, s: string) => void; onChanged: () => void }

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section><h3 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{title}</h3>{children}</section>
);
const Rows = ({ rows }: { rows: Array<[string, ReactNode]> }) => (
  <dl className="divide-y divide-separator rounded-card bg-surface shadow-card">
    {rows.map(([k, v]) => <div key={k} className="flex min-h-[44px] items-start justify-between gap-4 px-4 py-2.5"><dt className="shrink-0 text-subhead text-label2">{k}</dt><dd className="min-w-0 text-right text-subhead">{v}</dd></div>)}
  </dl>
);
const big = (n: number, capped?: boolean) => `${n.toLocaleString()}${capped ? '+' : ''}`;

/** What you see on the right for a network type, category or group (or, at the top, a welcome and the shape of the catalog). */
export function ContainerInspector({ d, a }: { d: Detail; a: Actions }) {
  const n = d.node, childLevel = CHILD_LEVEL[n.level];
  return (
    <div className="space-y-6">
      <Header node={n} sub={`${label(LEVEL_NOUN[n.level]!)}${d.trail.length ? ` in ${d.trail[d.trail.length - 1]!.name}` : ''}`} a={a}
        actions={a.editable && childLevel && (childLevel === 'OFFER'
          ? <Link href={`/catalog/manage?parent=${n.id}`} className="inline-flex min-h-[40px] items-center rounded-control bg-accent px-4 text-subhead font-medium text-accent-fg hover:opacity-90">＋ New offer</Link>
          : <Button className="!min-h-[40px] !px-4 !text-subhead" onClick={() => a.onAdd(n)}>＋ Add {LEVEL_NOUN[childLevel]}</Button>)} />
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat k="Offers live" v={big(n.activeOfferCount)} sub={`of ${big(n.offerCount)}`} />
        <Stat k="Not live" v={big(n.offerCount - n.activeOfferCount)} sub="draft or retired" />
        <Stat k="Status" v={n.status === 'ACTIVE' ? 'Live' : label(n.status)} />
      </ul>
      <p className="px-1 text-subhead text-label2">
        {childLevel ? <>The {LEVEL_PLURAL[childLevel]!.toLowerCase()} inside {n.name} are listed on the left. Choose one to open it.</> : null}
        {n.status !== 'ACTIVE' && ' Everything inside a node that is not live is hidden from sales channels.'}
      </p>
    </div>
  );
}

export function Welcome({ summary, editable, onAdd }: { summary: { levels: Record<string, number>; offers: number; offersLive: number } | null; editable: boolean; onAdd: () => void }) {
  const l = summary?.levels ?? {};
  return (
    <div className="space-y-6">
      <header><h1 className="text-title1 font-bold tracking-tight sm:text-large-title">Product catalog</h1>
        <p className="mt-1 text-subhead text-label2">Network type → Category → Group → Offer → Line items. Open a folder on the left, or search for anything by name.</p></header>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat k="Network types" v={big(l.NETWORK_TYPE ?? 0)} /><Stat k="Categories" v={big(l.CATEGORY ?? 0)} /><Stat k="Groups" v={big(l.GROUP ?? 0)} />
        <Stat k="Offers live" v={big(summary?.offersLive ?? 0)} sub={`of ${big(summary?.offers ?? 0)}`} /><Stat k="Line items" v={big(l.LINE_ITEM ?? 0)} />
      </ul>
      {editable && <p><Link href="/catalog/bundles" className="text-subhead text-accent">Bundle discounts →</Link></p>}
      {editable && summary && summary.offers === 0 && <p className="text-subhead text-label2">The catalog is empty. Start with a network type (Mobile, Fibre, IoT…), then add categories, groups and offers beneath it. <button className="text-accent underline" onClick={onAdd}>New network type</button></p>}
    </div>
  );
}

const Stat = ({ k, v, sub }: { k: string; v: string; sub?: string }) => (
  <li className="rounded-card bg-surface p-4 shadow-card"><p className="text-footnote text-label2">{k}</p><p className="text-title2 font-semibold tabular-nums">{v}{sub && <span className="ml-1 text-subhead font-normal text-label2">{sub}</span>}</p></li>
);

function Header({ node, sub, a, actions, menu }: { node: CNode; sub: string; a: Actions; actions?: ReactNode; menu?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-footnote font-medium uppercase tracking-wide text-accent">{sub}</p>
        <h1 className="text-title1 font-bold tracking-tight sm:text-large-title">{node.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-subhead text-label2"><Badge tone={tone(node.status)}>{node.status === 'ACTIVE' ? 'Live' : label(node.status)}</Badge>{node.description}</p>
      </div>
      {a.editable && (
        <div className="flex items-center gap-1">
          {actions}
          {menu ?? <MenuButton label={`Actions for ${node.name}`} items={[
            { label: 'Edit…', onSelect: () => a.onEdit(node) },
            node.status === 'ACTIVE' ? { label: 'Retire', onSelect: () => a.onStatus(node.id, 'RETIRED'), divider: true } : { label: 'Make live', onSelect: () => a.onStatus(node.id, 'ACTIVE'), divider: true },
          ]} />}
        </div>
      )}
    </header>
  );
}

type Tab = 'included' | 'pricing' | 'rules' | 'sales';

/** An offer opened for reading: header, then one section at a time so nothing is below the fold. */
export function OfferInspector({ d, a }: { d: Detail; a: Actions }) {
  const offer = d.node;
  const sold = (d.usage?.services ?? 0) + (d.usage?.orders ?? 0);
  const [tab, setTab] = useState<Tab>('included');
  const tabs = [{ value: 'included', label: 'Included' }, { value: 'pricing', label: 'Pricing' }, { value: 'rules', label: 'Rules' }, ...(sold > 0 ? [{ value: 'sales', label: 'Sales' }] : [])];
  const rec = offer.prices?.find((p: any) => p.type === 'RECURRING');
  const once = offer.prices?.filter((p: any) => p.type === 'ONE_TIME') ?? [];
  const c = offer.contract, f = offer.fulfilment ?? {};
  const chips = (refs: Detail['requires']) => refs.length === 0 ? <span className="text-label2">None</span> : (
    <span className="flex flex-wrap justify-end gap-1.5">
      {refs.map((r) => <button key={r.id} onClick={() => !r.missing && a.onOpen(r.id)} disabled={!!r.missing} className="rounded-full bg-surface2 px-3 py-1 text-subhead hover:bg-separator focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{r.missing ? `${r.id} (missing)` : r.level === 'OFFER' ? r.name : `Any ${r.name}`}</button>)}
    </span>
  );
  const fulfil = [f.requiresShipping && 'Ships to the customer', f.requiresInstallation && 'Installation visit', f.requiresSimActivation && 'SIM activation'].filter(Boolean) as string[];
  return (
    <div className="space-y-5">
      <Header node={offer} sub={label(offer.kind ?? 'Offer')} a={a}
        actions={<Link href={`/catalog/edit/${offer.id}`} className="inline-flex min-h-[40px] items-center gap-2 rounded-control bg-accent px-4 text-subhead font-medium text-accent-fg hover:opacity-90"><span aria-hidden>✎</span>Edit offer</Link>}
        menu={<MenuButton label={`Actions for ${offer.name}`} items={[
          { label: offer.status === 'ACTIVE' ? 'Retire' : 'Make live', onSelect: () => a.onStatus(offer.id, offer.status === 'ACTIVE' ? 'RETIRED' : 'ACTIVE') },
          { label: 'Create a new version', href: `/catalog/manage?from=${offer.id}`, divider: true },
          { label: 'Delete…', onSelect: () => a.onEdit(offer), tone: 'danger' },
        ]} />} />

      <div className="flex items-center justify-between gap-3 rounded-card bg-surface px-4 py-3 shadow-card">
        <div><p className="text-footnote text-label2">Customer pays</p><p className="text-title2 font-semibold tabular-nums">{rec ? <>{money(rec.amount.amountMinor)}<span className="text-subhead font-normal text-label2"> /month</span></> : once[0] ? money(once[0].amount.amountMinor) : 'Free'}</p></div>
        <p className="text-right text-subhead text-label2">{c?.termMonths ? `${c.termMonths}-month contract` : 'No contract'}{rec && once[0]?.amount.amountMinor ? <><br />{money(once[0].amount.amountMinor)} upfront</> : null}</p>
      </div>

      <Segmented label="Offer sections" value={tab} options={tabs} onChange={(v) => setTab(v as Tab)} />

      <div key={tab} className="sheet-in">
        {tab === 'included' && <LineItemsSection offer={offer} items={d.lineItems} editable={a.editable} onChanged={a.onChanged} />}
        {tab === 'pricing' && (
          <Rows rows={[
            ['Monthly fee', rec ? <>{money(rec.amount.amountMinor)}<span className="text-label2"> /month</span></> : <span className="text-label2">None</span>],
            ...once.map((p: any, i: number): [string, ReactNode] => [i ? `Upfront ${i + 1}` : 'Upfront', p.amount.amountMinor ? money(p.amount.amountMinor) : <span className="text-label2">No upfront cost</span>]),
            ['Contract', c?.termMonths ? `${c.termMonths} months` : 'No contract'],
            ...(c?.termMonths ? [['Early exit', label(c.etc?.method ?? '')] as [string, ReactNode]] : []),
            ...(c?.subsidy ? [['Device subsidy', `${money(c.subsidy.subsidyAmount.amountMinor)} of ${money(c.subsidy.deviceRetailPrice.amountMinor)}`] as [string, ReactNode]] : []),
          ]} />
        )}
        {tab === 'rules' && (
          <Rows rows={[
            ['Customer must first have', chips(d.requires)],
            ['Cannot be bought with', chips(d.excludes)],
            ['Sold through', (offer.salesChannels?.length ?? 0) ? offer.salesChannels!.map(label).join(', ') : <span className="text-label2">All channels</span>],
            ['Markets', (offer.markets?.length ?? 0) ? offer.markets!.join(', ') : <span className="text-label2">All</span>],
            ['Fulfilment', fulfil.length ? fulfil.join(' · ') : <span className="text-label2">Digital, nothing to ship</span>],
          ]} />
        )}
        {tab === 'sales' && <Rows rows={[['Subscribers', big(d.usage?.services ?? 0, d.usage?.capped)], ['Order lines', big(d.usage?.orders ?? 0, d.usage?.capped)]]} />}
      </div>
    </div>
  );
}
