'use client';
import { Button, LoadMore, MenuButton, SearchField } from '@meridian/ui';
import Link from 'next/link';
import { useRef } from 'react';
import type { PagedState } from '@/lib/api';
import { label, money } from '@/lib/format';
import { CHILD_LEVEL, LEVEL_NOUN, LEVEL_PLURAL, STATUS_DOT, STATUS_TEXT, type CNode } from './catalog-ui';

export interface Crumb { id: string | null; name: string }

/** "Catalog › Mobile › Postpaid": every step is a way back, and the last one is where you are. */
export function Crumbs({ trail, onGo }: { trail: Crumb[]; onGo: (id: string | null) => void }) {
  return (
    <nav aria-label="Where you are" className="flex flex-wrap items-center gap-x-1 text-subhead text-label2">
      {trail.map((c, i) => (
        <span key={c.id ?? 'root'} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>›</span>}
          {i === trail.length - 1
            ? <span aria-current="page" className="font-medium text-label">{c.name}</span>
            : <button onClick={() => onGo(c.id)} className="rounded px-0.5 hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{c.name}</button>}
        </span>
      ))}
    </nav>
  );
}

interface Props {
  /** The container whose children are listed (null = network types). */
  location: CNode | null;
  crumbs: Crumb[];
  list: PagedState<CNode>;
  results: PagedState<CNode>;
  /** The user is still typing: results for the previous text are on screen or on their way. */
  pending?: boolean;
  query: string;
  onQuery: (q: string) => void;
  selectedId: string | null;
  editable: boolean;
  direction: 'fwd' | 'back';
  onOpen: (n: CNode) => void;
  onGo: (id: string | null) => void;
  onAdd: () => void;
  onReorder: (id: string, d: 'up' | 'down') => void;
  onStatus: (id: string, s: string) => void;
}

/**
 * One level of the catalog at a time, like Files on iPhone: tap a folder to go in, use the path above to come back out.
 * It only ever holds a page of children (50), searches the whole catalog on the server, and shows where each result lives.
 */
export function BrowseList(p: Props) {
  const searching = !!p.query.trim();
  const view = searching ? { ...p.results, loading: p.results.loading || !!p.pending } : p.list;
  const childLevel = p.location ? CHILD_LEVEL[p.location.level] : 'NETWORK_TYPE';
  const key = searching ? 'search' : (p.location?.id ?? 'root');
  const ref = useRef<HTMLUListElement>(null);
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <SearchField label="Search the catalog" placeholder="Search products" value={p.query} onChange={p.onQuery} />
      {!searching && <Crumbs trail={p.crumbs} onGo={p.onGo} />}
      {searching && <p className="px-1 text-footnote text-label2" aria-live="polite">{view.loading && view.items.length === 0 ? 'Searching…' : `Results for “${p.query.trim()}”`}</p>}

      <div key={key} className={p.direction === 'fwd' ? 'push-fwd' : 'push-back'}>
        {view.error && <p role="alert" className="rounded-card bg-danger/10 p-3 text-subhead text-danger">{view.error}</p>}
        {view.loading && view.items.length === 0 && <ul className="space-y-px overflow-hidden rounded-card bg-surface shadow-card" aria-hidden>{[0, 1, 2, 3].map((i) => <li key={i} className="h-14 animate-pulse bg-surface2/60" />)}</ul>}
        {!view.loading && view.items.length === 0 && !view.error && (
          <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">
            {searching ? 'Nothing matches. Try fewer or shorter words.'
              : <>Empty. {p.editable && childLevel === 'OFFER' && p.location && <Link className="text-accent underline" href={`/catalog/manage?parent=${p.location.id}`}>Create the first offer</Link>}{p.editable && childLevel && childLevel !== 'OFFER' && <button className="text-accent underline" onClick={p.onAdd}>Add a {LEVEL_NOUN[childLevel]}</button>}</>}
          </p>
        )}
        {view.items.length > 0 && (
          <ul ref={ref} role="list" aria-label={searching ? 'Search results' : p.location ? `Inside ${p.location.name}` : 'Network types'} className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
            {view.items.map((n, i) => (
              <Row key={n.id} node={n} selected={n.id === p.selectedId} showTrail={searching} editable={p.editable && !searching}
                canUp={i > 0} canDown={i < view.items.length - 1 || view.hasMore} onOpen={() => p.onOpen(n)} onReorder={p.onReorder} onStatus={p.onStatus} />
            ))}
          </ul>
        )}
        {view.items.length > 0 && <LoadMore shown={view.items.length} hasMore={view.hasMore} loading={view.loadingMore} onMore={view.loadMore} noun={searching ? 'results' : (childLevel ? LEVEL_PLURAL[childLevel]!.toLowerCase() : 'items')} />}
      </div>

      {p.editable && !searching && childLevel && (
        <div>
          {childLevel === 'OFFER' && p.location
            ? <Link href={`/catalog/manage?parent=${p.location.id}`} className="inline-flex min-h-tap items-center rounded-control bg-surface2 px-4 text-subhead font-medium text-accent hover:opacity-80">＋ New offer</Link>
            : <Button variant="secondary" onClick={p.onAdd}>＋ {childLevel === 'NETWORK_TYPE' ? 'New network type' : `Add ${LEVEL_NOUN[childLevel]}`}</Button>}
        </div>
      )}
    </div>
  );
}

function Row({ node, selected, showTrail, editable, canUp, canDown, onOpen, onReorder, onStatus }: { node: CNode; selected: boolean; showTrail: boolean; editable: boolean; canUp: boolean; canDown: boolean; onOpen: () => void; onReorder: (id: string, d: 'up' | 'down') => void; onStatus: (id: string, s: string) => void }) {
  const isOffer = node.level === 'OFFER', isItem = node.level === 'LINE_ITEM', container = !isOffer && !isItem;
  const rec = node.prices?.find((x: any) => x.type === 'RECURRING');
  const once = node.prices?.find((x: any) => x.type === 'ONE_TIME');
  const sub = showTrail
    ? `${label(node.level)}${node.trail?.length ? ` · ${node.trail.map((t) => t.name).join(' › ')}` : ''}`
    : isOffer ? `${label(node.kind ?? '')}${node.contract?.termMonths ? ` · ${node.contract.termMonths}-month` : ''}${node.lineItemCount ? ` · ${node.lineItemCount} included` : ''}`
    : `${node.activeOfferCount.toLocaleString()} of ${node.offerCount.toLocaleString()} offer${node.offerCount === 1 ? '' : 's'} live`;
  return (
    <li className={`group relative flex items-center ${node.status === 'RETIRED' ? 'opacity-60' : ''}`}>
      <button onClick={onOpen} aria-current={selected ? 'true' : undefined}
        className={`flex min-h-[56px] min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left transition-colors active:bg-separator/70 focus-visible:bg-surface2 focus-visible:outline-none ${selected ? 'bg-accent/12' : 'hover:bg-surface2'}`}>
        <span role="img" aria-label={STATUS_TEXT[node.status]} className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[node.status]}`} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate ${selected ? 'font-semibold text-accent' : 'font-medium'}`}>{node.name}</span>
          <span className="block truncate text-footnote text-label2">{sub}</span>
        </span>
        {isOffer && !showTrail && (
          <span className="shrink-0 text-right tabular-nums">
            <span className="block text-subhead font-medium">{rec ? <>{money(rec.amount.amountMinor)}<span className="text-footnote font-normal text-label2">/mo</span></> : once ? money(once.amount.amountMinor) : '–'}</span>
          </span>
        )}
        {container && <span aria-hidden className="text-label2">›</span>}
      </button>
      {editable && (
        <span className="pr-2 opacity-100 lg:opacity-0 lg:transition-opacity lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
          <MenuButton label={`Actions for ${node.name}`} items={[
            { label: node.status === 'ACTIVE' ? 'Retire' : 'Make live', onSelect: () => onStatus(node.id, node.status === 'ACTIVE' ? 'RETIRED' : 'ACTIVE') },
            { label: 'Move up', onSelect: () => onReorder(node.id, 'up'), disabled: !canUp, divider: true },
            { label: 'Move down', onSelect: () => onReorder(node.id, 'down'), disabled: !canDown },
          ]} />
        </span>
      )}
    </li>
  );
}
