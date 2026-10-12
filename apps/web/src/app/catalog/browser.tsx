'use client';
import { Alert, Spinner } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ancestorsOf, flatten, structureChildren } from './catalog-ui';
import { AddNodeModal, EditNodeModal, type TreeNode } from './node-modals';
import { ContainerView, type Actions } from './node-view';
import { OfferView } from './offer-view';
import { filterOutline, Outline } from './outline';
import { Overview } from './overview';

/**
 * The catalog as a browser, like Files or Settings: an outline on the left, the selected thing on the right.
 * On a phone it is one screen at a time (the outline, then the item, with a Back button).
 * The selection lives in the address (?node=…) so every item can be linked to and Back works.
 */
export function CatalogBrowser() {
  const { can } = useAuth();
  const editable = can('catalog:write');
  const router = useRouter();
  const params = useSearchParams();
  const { data, error, loading, reload } = useApi('/catalog/tree');
  const act = useAction(reload);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<TreeNode | null>(null);
  const [adding, setAdding] = useState<{ level: TreeNode['level']; parent: TreeNode | null } | null>(null);

  const roots: TreeNode[] = data?.items ?? [];
  const all = useMemo(() => flatten(roots), [roots]);
  const byId = useMemo(() => new Map(all.map((n) => [n.id, n])), [all]);
  const nodeId = params.get('node');
  const selected = nodeId ? byId.get(nodeId) ?? null : null;
  const trail = useMemo(() => (selected ? ancestorsOf(selected.id, byId) : []), [selected, byId]);
  const outline = useMemo(() => filterOutline(roots.map((r) => ({ ...r })), query), [roots, query]);

  const select = useCallback((id: string | null) => { router.push(id ? `/catalog?node=${encodeURIComponent(id)}` : '/catalog', { scroll: true }); }, [router]);
  // Opening something reveals it in the outline.
  useEffect(() => {
    if (!selected) return;
    setExpanded((s) => { const n = new Set(s); for (const t of ancestorsOf(selected.id, byId)) n.add(t.id); n.add(selected.id); return n; });
  }, [selected, byId]);
  // First visit: show the top two levels so the outline is not a wall of closed folders.
  useEffect(() => { if (data && expanded.size === 0 && !nodeId) setExpanded(new Set(roots.map((r) => r.id))); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // The selected item was deleted (or the link is stale): go back to the overview instead of showing an empty pane.
  useEffect(() => { if (data && nodeId && !byId.has(nodeId)) router.replace('/catalog'); }, [data, nodeId, byId, router]);

  const toggle = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const done = useCallback(() => { setEditing(null); setAdding(null); void reload(); }, [reload]);
  const actions: Actions = {
    editable, onSelect: select, onEdit: setEditing, onAdd: (parent) => setAdding({ level: ({ NETWORK_TYPE: 'CATEGORY', CATEGORY: 'GROUP', GROUP: 'OFFER' } as const)[parent.level as 'NETWORK_TYPE']!, parent }),
    onReorder: (id, direction) => act.run(() => post(`/catalog/${id}/reorder`, { direction })),
    onStatus: (id, status) => act.run(() => patch(`/catalog/${id}`, { status })),
  };
  const siblings = selected ? (selected.parentId ? structureChildren(byId.get(selected.parentId)!) : roots) : [];
  const parent = selected?.parentId ? byId.get(selected.parentId) : null;

  if (loading && !data) return <Spinner />;
  if (error) return <Alert>{error}</Alert>;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:items-start">
        <aside className={`${selected ? 'hidden lg:block' : ''} lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto`}>
          {!selected && <h1 className="mb-4 text-title1 font-bold tracking-tight lg:hidden">Product catalog</h1>}
          <Outline roots={outline} selectedId={selected?.id ?? null} expanded={expanded} query={query} searching={!!query} editable={editable}
            onQuery={setQuery} onToggle={toggle} onSelect={select} onNewRoot={() => setAdding({ level: 'NETWORK_TYPE', parent: null })} />
        </aside>
        <section aria-live="polite" className={`${selected ? '' : 'hidden lg:block'} min-w-0`}>
          {selected && (
            <button onClick={() => select(parent?.id ?? null)} className="mb-3 inline-flex min-h-tap items-center gap-1 text-body text-accent lg:hidden"><span aria-hidden>‹</span>{parent?.name ?? 'Catalog'}</button>
          )}
          {act.error && <div className="mb-4"><Alert>{act.error}</Alert></div>}
          {!selected
            ? <Overview roots={roots} all={all} editable={editable} onSelect={select} onNewRoot={() => setAdding({ level: 'NETWORK_TYPE', parent: null })} />
            : selected.level === 'OFFER'
              ? <OfferView key={selected.id} offer={selected} trail={trail} siblings={siblings} byId={byId} a={actions} onChanged={reload} />
              : <ContainerView key={selected.id} node={selected} trail={trail} siblings={siblings} a={actions} />}
        </section>
      </div>
      {editing && <EditNodeModal node={editing} all={all} onClose={() => setEditing(null)} onDone={done} />}
      {adding && <AddNodeModal level={adding.level} parent={adding.parent} onClose={() => setAdding(null)} onDone={done} />}
    </>
  );
}
