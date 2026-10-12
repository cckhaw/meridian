'use client';
import { Button, Input } from '@meridian/ui';
import { STATUS_DOT, STATUS_TEXT, structureChildren } from './catalog-ui';
import type { TreeNode } from './node-modals';

/** Keeps a node if it, or anything beneath it, matches the search. */
export function filterOutline(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  const t = q.toLowerCase();
  return nodes.flatMap((n) => {
    const kids = filterOutline(structureChildren(n), q);
    const self = n.name.toLowerCase().includes(t) || n.id.toLowerCase().includes(t);
    return self || kids.length ? [{ ...n, children: self ? structureChildren(n) : kids }] : [];
  });
}

interface Props {
  roots: TreeNode[]; selectedId: string | null; expanded: Set<string>; query: string; searching: boolean; editable: boolean;
  onQuery: (q: string) => void; onToggle: (id: string) => void; onSelect: (id: string | null) => void; onNewRoot: () => void;
}

/** The catalog's table of contents, like a Finder sidebar: structure only, down to offers, one line each. */
export function Outline(p: Props) {
  return (
    <nav aria-label="Catalog outline" className="flex flex-col gap-3">
      <Input type="search" aria-label="Search the catalog" placeholder="Search" value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
      <div role="tree" aria-label="Product hierarchy" className="rounded-card bg-surface p-1.5 shadow-card">
        <button onClick={() => p.onSelect(null)} aria-current={p.selectedId === null ? 'page' : undefined}
          className={`mb-1 flex min-h-[40px] w-full items-center gap-2 rounded-control px-3 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${p.selectedId === null ? 'bg-accent/15 text-accent' : 'hover:bg-surface2'}`}>
          <span aria-hidden>▦</span>All products
        </button>
        {p.roots.length === 0 && <p className="px-3 py-4 text-subhead text-label2">{p.query ? 'No matches.' : 'Nothing here yet.'}</p>}
        {p.roots.map((n) => <Row key={n.id} node={n} depth={0} {...p} />)}
      </div>
      {p.editable && <Button variant="secondary" onClick={p.onNewRoot}>＋ New network type</Button>}
    </nav>
  );
}

function Row({ node, depth, ...p }: { node: TreeNode; depth: number } & Props) {
  const kids = structureChildren(node);
  const open = p.searching || p.expanded.has(node.id);
  const selected = p.selectedId === node.id;
  return (
    <div role="none">
      <div role="treeitem" aria-expanded={kids.length ? open : undefined} aria-selected={selected} className="flex items-center" style={{ paddingLeft: depth * 14 }}>
        {kids.length > 0
          ? <button aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`} onClick={() => p.onToggle(node.id)} className="grid h-9 w-7 shrink-0 place-items-center text-label2 hover:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span aria-hidden className={`inline-block text-footnote transition ${open ? 'rotate-90' : ''}`}>▸</span></button>
          : <span className="w-7 shrink-0" />}
        <button onClick={() => p.onSelect(node.id)} aria-current={selected ? 'page' : undefined}
          className={`flex min-h-[36px] min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-subhead focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected ? 'bg-accent/15 font-medium text-accent' : 'hover:bg-surface2'} ${node.status === 'RETIRED' ? 'opacity-60' : ''}`}>
          <span title={STATUS_TEXT[node.status]} aria-label={STATUS_TEXT[node.status]} className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[node.status]}`} />
          <span className="truncate">{node.name}</span>
          {node.level !== 'OFFER' && <span className="ml-auto shrink-0 text-caption tabular-nums text-label2">{node.offerCount}</span>}
        </button>
      </div>
      {open && kids.length > 0 && <div role="group">{kids.map((c) => <Row key={c.id} node={c} depth={depth + 1} {...p} />)}</div>}
    </div>
  );
}
