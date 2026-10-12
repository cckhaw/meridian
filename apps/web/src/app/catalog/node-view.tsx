'use client';
import { Badge, Button, MenuButton } from '@meridian/ui';
import Link from 'next/link';
import { label, money, tone } from '@/lib/format';
import { LEVEL_NOUN, LEVEL_PLURAL, CHILD_LEVEL, STATUS_DOT, STATUS_TEXT, structureChildren } from './catalog-ui';
import type { TreeNode } from './node-modals';

export interface Actions {
  editable: boolean;
  onSelect: (id: string | null) => void; onEdit: (n: TreeNode) => void; onAdd: (parent: TreeNode) => void;
  onReorder: (id: string, d: 'up' | 'down') => void; onStatus: (id: string, s: string) => void;
}

export const Crumbs = ({ trail, onSelect }: { trail: TreeNode[]; onSelect: (id: string | null) => void }) => (
  <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-subhead text-label2">
    <button onClick={() => onSelect(null)} className="rounded px-1 hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Catalog</button>
    {trail.map((t) => <span key={t.id} className="flex items-center gap-1"><span aria-hidden>›</span><button onClick={() => onSelect(t.id)} className="rounded px-1 hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{t.name}</button></span>)}
  </nav>
);

export function NodeMenu({ node, a, siblingsCount, index }: { node: TreeNode; a: Actions; siblingsCount: number; index: number }) {
  if (!a.editable) return null;
  return (
    <MenuButton label={`Actions for ${node.name}`} items={[
      { label: 'Edit…', onSelect: () => a.onEdit(node) },
      { label: 'Move up', onSelect: () => a.onReorder(node.id, 'up'), disabled: index <= 0, divider: true },
      { label: 'Move down', onSelect: () => a.onReorder(node.id, 'down'), disabled: index < 0 || index >= siblingsCount - 1 },
      node.status === 'ACTIVE' ? { label: 'Retire', onSelect: () => a.onStatus(node.id, 'RETIRED'), divider: true } : { label: 'Make live', onSelect: () => a.onStatus(node.id, 'ACTIVE'), divider: true },
    ]} />
  );
}

/** A network type, category or group: its title, and what it contains as one tidy list. */
export function ContainerView({ node, trail, siblings, a }: { node: TreeNode; trail: TreeNode[]; siblings: TreeNode[]; a: Actions }) {
  const kids = structureChildren(node);
  const childLevel = CHILD_LEVEL[node.level];
  const idx = siblings.findIndex((s) => s.id === node.id);
  return (
    <div>
      <Crumbs trail={trail} onSelect={a.onSelect} />
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-footnote font-medium uppercase tracking-wide text-accent">{label(LEVEL_NOUN[node.level]!)}</p>
          <h1 className="text-title1 font-bold tracking-tight sm:text-large-title">{node.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-subhead text-label2">
            {node.status !== 'ACTIVE' && <Badge tone={tone(node.status)}>{label(node.status)}</Badge>}
            {node.activeOfferCount} of {node.offerCount} offers live
          </p>
        </div>
        <div className="flex items-center gap-1">
          {a.editable && childLevel === 'OFFER' && <Link href={`/catalog/manage?parent=${node.id}`} className="inline-flex min-h-[40px] items-center rounded-control bg-accent px-4 text-subhead font-medium text-accent-fg hover:opacity-90">＋ New offer</Link>}
          {a.editable && childLevel && childLevel !== 'OFFER' && <Button className="!min-h-[40px] !px-4 !text-subhead" onClick={() => a.onAdd(node)}>＋ Add {LEVEL_NOUN[childLevel]}</Button>}
          <NodeMenu node={node} a={a} siblingsCount={siblings.length} index={idx} />
        </div>
      </header>

      <h2 className="mb-2 px-1 text-footnote font-semibold uppercase tracking-wide text-label2">{childLevel ? LEVEL_PLURAL[childLevel] : 'Contents'}</h2>
      {kids.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-8 text-center text-subhead text-label2 shadow-card">Empty. {a.editable && childLevel && childLevel !== 'OFFER' && <button className="text-accent underline" onClick={() => a.onAdd(node)}>Add a {LEVEL_NOUN[childLevel]}</button>}{a.editable && childLevel === 'OFFER' && <Link className="text-accent underline" href={`/catalog/manage?parent=${node.id}`}>Create the first offer</Link>}</p>
      ) : (
        <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {kids.map((c) => <ChildRow key={c.id} node={c} a={a} />)}
        </ul>
      )}
    </div>
  );
}

function ChildRow({ node, a }: { node: TreeNode; a: Actions }) {
  const rec = node.prices?.find((p: any) => p.type === 'RECURRING');
  const once = node.prices?.find((p: any) => p.type === 'ONE_TIME');
  const items = node.children.filter((c) => c.level === 'LINE_ITEM').length;
  return (
    <li>
      <button onClick={() => a.onSelect(node.id)} className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface2 focus-visible:bg-surface2 focus-visible:outline-none">
        <span title={STATUS_TEXT[node.status]} className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[node.status]}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{node.name}</span>
          <span className="block truncate text-footnote text-label2">
            {node.level === 'OFFER'
              ? `${label(node.kind ?? '')}${node.contract?.termMonths ? ` · ${node.contract.termMonths}-month contract` : ''}${items ? ` · ${items} included` : ''}${(node.requires?.length ?? 0) ? ' · has prerequisites' : ''}`
              : `${node.activeOfferCount} of ${node.offerCount} offers live`}
          </span>
        </span>
        {node.level === 'OFFER' && (
          <span className="shrink-0 text-right tabular-nums">
            <span className="block font-medium">{rec ? <>{money(rec.amount.amountMinor)}<span className="text-footnote font-normal text-label2">/mo</span></> : once ? money(once.amount.amountMinor) : '–'}</span>
            {rec && once && once.amount.amountMinor > 0 && <span className="block text-caption text-label2">{money(once.amount.amountMinor)} upfront</span>}
          </span>
        )}
        <span aria-hidden className="text-label2">›</span>
      </button>
    </li>
  );
}
