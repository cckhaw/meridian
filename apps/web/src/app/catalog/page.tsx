'use client';
import { Alert, Badge, Button, Empty, IconButton, Input, LargeTitle, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { label, money, tone } from '@/lib/format';
import { AddNodeModal, EditNodeModal, type TreeNode } from './node-modals';

const LEVELS: Array<{ level: TreeNode['level']; label: string; plural: string }> = [
  { level: 'NETWORK_TYPE', label: 'Network type', plural: 'Network types' },
  { level: 'CATEGORY', label: 'Category', plural: 'Categories' },
  { level: 'GROUP', label: 'Group', plural: 'Groups' },
  { level: 'OFFER', label: 'Offer', plural: 'Offers' },
];
const CHILD_LEVEL: Record<string, TreeNode['level'] | undefined> = { NETWORK_TYPE: 'CATEGORY', CATEGORY: 'GROUP', GROUP: 'OFFER' };

const flatten = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);

/** Keeps a node if it, or anything beneath it, matches the search. */
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  const t = q.toLowerCase();
  return nodes.flatMap((n) => {
    const kids = filterTree(n.children, q);
    const self = n.name.toLowerCase().includes(t) || n.id.toLowerCase().includes(t);
    return self ? [{ ...n, children: n.children }] : kids.length ? [{ ...n, children: kids }] : [];
  });
}

export default function Catalog() {
  const { can } = useAuth();
  const editable = can('catalog:write');
  const { data, error, loading, reload } = useApi('/catalog/tree');
  const act = useAction(reload);
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<TreeNode | null>(null);
  const [adding, setAdding] = useState<{ level: TreeNode['level']; parent: TreeNode | null } | null>(null);

  const roots: TreeNode[] = data?.items ?? [];
  const all = useMemo(() => flatten(roots), [roots]);
  const byId = useMemo(() => new Map(all.map((n) => [n.id, n])), [all]);
  const shown = useMemo(() => filterTree(roots, q), [roots, q]);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const collapseAll = () => setCollapsed(new Set(all.filter((n) => n.level !== 'OFFER').map((n) => n.id)));
  const done = useCallback(() => { setEditing(null); setAdding(null); void reload(); }, [reload]);
  const counts = (l: TreeNode['level']) => all.filter((n) => n.level === l).length;

  return (
    <>
      <LargeTitle subtitle="Network type → Category → Group → Offer. Everything customers can buy hangs off this tree.">Product catalog</LargeTitle>

      <div aria-label="Hierarchy levels" className="mb-5 flex flex-wrap items-center gap-2 text-subhead">
        {LEVELS.map((l, i) => (
          <span key={l.level} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden className="text-label2">→</span>}
            <span className={`rounded-full px-3 py-1 font-medium ${LEVEL_STYLE[l.level]}`}>{l.label} <span className="font-normal opacity-70">{counts(l.level)}</span></span>
          </span>
        ))}
      </div>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input type="search" aria-label="Search the catalog" placeholder="Search products and categories…" value={q} onChange={(e) => setQ(e.target.value)} className="sm:max-w-sm" />
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="secondary" onClick={() => setCollapsed(new Set())}>Expand all</Button>
          <Button variant="secondary" onClick={collapseAll}>Collapse all</Button>
          {editable && <Button onClick={() => setAdding({ level: 'NETWORK_TYPE', parent: null })}>New network type</Button>}
        </div>
      </div>

      {act.error && <div className="mb-4"><Alert>{act.error}</Alert></div>}
      {error && <Alert>{error}</Alert>}
      {loading && !data && <Spinner />}
      {data && shown.length === 0 && (
        <Empty>{q ? 'Nothing matches your search.' : editable ? 'The catalog is empty. Start with a network type (Mobile, Fibre, IoT…), then add categories, groups and offers beneath it.' : 'No products are available yet.'}</Empty>
      )}
      <div className="space-y-4">
        {shown.map((n) => (
          <NodeBlock key={n.id} node={n} depth={0} forceOpen={!!q} collapsed={collapsed} toggle={toggle} editable={editable} byId={byId}
            onEdit={setEditing} onAdd={(parent) => setAdding({ level: CHILD_LEVEL[parent.level]!, parent })}
            onReorder={(id, direction) => act.run(() => post(`/catalog/${id}/reorder`, { direction }))}
            onStatus={(id, status) => act.run(() => patch(`/catalog/${id}`, { status }))} />
        ))}
      </div>

      {editing && <EditNodeModal node={editing} all={all} onClose={() => setEditing(null)} onDone={done} />}
      {adding && <AddNodeModal level={adding.level} parent={adding.parent} onClose={() => setAdding(null)} onDone={done} />}
    </>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  NETWORK_TYPE: 'bg-accent text-accent-fg', CATEGORY: 'bg-accent/20 text-accent', GROUP: 'bg-surface2 text-label', OFFER: 'border border-separator bg-surface text-label2',
};
const LEVEL_NOUN: Record<string, string> = { NETWORK_TYPE: 'network type', CATEGORY: 'category', GROUP: 'group', OFFER: 'offer' };

interface BlockProps {
  node: TreeNode; depth: number; forceOpen: boolean; collapsed: Set<string>; toggle: (id: string) => void; editable: boolean; byId: Map<string, TreeNode>;
  onEdit: (n: TreeNode) => void; onAdd: (parent: TreeNode) => void; onReorder: (id: string, d: 'up' | 'down') => void; onStatus: (id: string, s: string) => void;
}

function NodeBlock(p: BlockProps) {
  const { node, depth, collapsed, toggle, editable } = p;
  const open = p.forceOpen || !collapsed.has(node.id);
  const offers = node.children.filter((c) => c.level === 'OFFER');
  const groups = node.children.filter((c) => c.level !== 'OFFER');
  const canAdd = editable && CHILD_LEVEL[node.level];
  const top = depth === 0;

  return (
    <section aria-label={node.name} className={top ? 'rounded-card bg-surface p-4 shadow-card sm:p-5' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => toggle(node.id)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
          className="grid min-h-[36px] min-w-[36px] place-items-center rounded-full text-label2 hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span aria-hidden className={`inline-block transition ${open ? 'rotate-90' : ''}`}>▸</span>
        </button>
        <span className={`rounded-full px-2.5 py-0.5 text-caption font-medium ${LEVEL_STYLE[node.level]}`}>{label(LEVEL_NOUN[node.level]!)}</span>
        <h2 className={top ? 'text-title3 font-semibold' : 'text-body font-semibold'}>{node.name}</h2>
        {node.status !== 'ACTIVE' && <Badge tone={tone(node.status)}>{label(node.status)}</Badge>}
        <span className="text-footnote text-label2">{node.activeOfferCount}/{node.offerCount} offers live</span>
        {editable && (
          <span className="ml-auto flex items-center">
            <IconButton label={`Move ${node.name} up`} onClick={() => p.onReorder(node.id, 'up')}>↑</IconButton>
            <IconButton label={`Move ${node.name} down`} onClick={() => p.onReorder(node.id, 'down')}>↓</IconButton>
            {canAdd && <IconButton label={`Add ${LEVEL_NOUN[CHILD_LEVEL[node.level]!]} to ${node.name}`} onClick={() => p.onAdd(node)}>＋</IconButton>}
            <IconButton label={`Edit ${node.name}`} onClick={() => p.onEdit(node)}>✎</IconButton>
          </span>
        )}
      </div>

      {open && (
        <div className={`mt-3 ${top ? '' : 'ml-4 border-l border-separator pl-3 sm:ml-5 sm:pl-4'} space-y-3`}>
          {groups.map((c) => <NodeBlock key={c.id} {...p} node={c} depth={depth + 1} />)}
          {offers.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {offers.map((o) => <OfferPanel key={o.id} offer={o} editable={editable} byId={p.byId} onReorder={p.onReorder} onStatus={p.onStatus} />)}
            </div>
          )}
          {groups.length === 0 && offers.length === 0 && (
            <p className="text-subhead text-label2">Empty. {canAdd ? <button className="text-accent" onClick={() => p.onAdd(node)}>Add a {LEVEL_NOUN[CHILD_LEVEL[node.level]!]}</button> : null}</p>
          )}
          {node.level === 'GROUP' && editable && (
            <Link href={`/catalog/manage?parent=${node.id}`} className="inline-flex min-h-tap items-center rounded-control border border-dashed border-separator px-4 text-subhead font-medium text-accent hover:bg-surface2">＋ New offer in {node.name}</Link>
          )}
        </div>
      )}
    </section>
  );
}

function OfferPanel({ offer: o, editable, byId, onReorder, onStatus }: { offer: TreeNode; editable: boolean; byId: Map<string, TreeNode>; onReorder: (id: string, d: 'up' | 'down') => void; onStatus: (id: string, s: string) => void }) {
  const rec = o.prices?.find((p: any) => p.type === 'RECURRING'), once = o.prices?.filter((p: any) => p.type === 'ONE_TIME') ?? [];
  const sold = (o.usage?.services ?? 0) + (o.usage?.orders ?? 0);
  const need = (o.requires ?? []).map((id: string) => { const n = byId.get(id); return n ? (n.level === 'OFFER' ? n.name : `any ${n.name}`) : id; });
  const no = (o.excludes ?? []).map((id: string) => byId.get(id)?.name ?? id);
  return (
    <article className={`flex flex-col rounded-card border border-separator bg-bg p-4 ${o.status === 'ACTIVE' ? '' : 'opacity-75'}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{o.name}</h3>
          <p className="text-footnote text-label2">{label(o.kind ?? '')}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Badge tone={tone(o.status)}>{label(o.status)}</Badge>
          {editable && <IconButton label={`Edit ${o.name}`} href={`/catalog/edit/${o.id}`}>✎</IconButton>}
        </span>
      </div>
      {o.description && <p className="mt-1 text-subhead text-label2">{o.description}</p>}
      <div className="mt-2">
        {rec && <p className="text-title3 font-semibold">{money(rec.amount.amountMinor, rec.amount.currency)}<span className="text-subhead font-normal text-label2"> /mo</span></p>}
        {once.map((p: any, i: number) => <p key={i} className="text-subhead text-label2">{p.amount.amountMinor ? `${money(p.amount.amountMinor, p.amount.currency)} upfront` : 'No upfront cost'}</p>)}
        {o.contract?.termMonths > 0 && <p className="text-footnote text-label2">{o.contract.termMonths}-month contract · early exit: {label(o.contract.etc?.method ?? '')}</p>}
      </div>
      {(need.length > 0 || no.length > 0 || (o.salesChannels?.length ?? 0) > 0) && (
        <ul className="mt-2 space-y-1 text-footnote">
          {need.length > 0 && <li><span className="font-medium">Requires</span> <span className="text-label2">{need.join(' + ')}</span></li>}
          {no.length > 0 && <li><span className="font-medium">Not with</span> <span className="text-label2">{no.join(', ')}</span></li>}
          {(o.salesChannels?.length ?? 0) > 0 && <li><span className="font-medium">Sold via</span> <span className="text-label2">{o.salesChannels!.map(label).join(', ')}</span></li>}
        </ul>
      )}
      {sold > 0 && <p className="mt-2 text-caption text-label2">{o.usage?.services ?? 0} subscribers · {o.usage?.orders ?? 0} order lines</p>}
      {editable && (
        <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
          {o.status === 'ACTIVE'
            ? <Button variant="secondary" className="!min-h-[36px] !px-3 !text-subhead" onClick={() => onStatus(o.id, 'RETIRED')}>Retire</Button>
            : <Button variant="secondary" className="!min-h-[36px] !px-3 !text-subhead" onClick={() => onStatus(o.id, 'ACTIVE')}>Activate</Button>}
          <span className="ml-auto flex">
            <IconButton label={`Move ${o.name} up`} onClick={() => onReorder(o.id, 'up')}>↑</IconButton>
            <IconButton label={`Move ${o.name} down`} onClick={() => onReorder(o.id, 'down')}>↓</IconButton>
          </span>
        </div>
      )}
    </article>
  );
}
