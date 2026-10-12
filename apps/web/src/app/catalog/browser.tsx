'use client';
import { Alert, MenuButton, Spinner } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { patch, post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BrowseList, type Crumb } from './browse-list';
import { CHILD_LEVEL, type CNode } from './catalog-ui';
import { ContainerInspector, OfferInspector, Welcome, type Actions, type Detail } from './inspector';
import { AddNodeModal, EditNodeModal } from './node-modals';

/**
 * The catalog as a browser, like Files: the folder you are in on the left (one level, a page at a time), the thing you picked on the right.
 * Nothing loads the whole tree, so it stays quick with tens of thousands of offers. On a phone it is one screen at a time.
 * The selection lives in the address (?node=…) so every item can be linked to and Back works.
 */
export function CatalogBrowser() {
  const { can } = useAuth();
  const editable = can('catalog:write');
  const router = useRouter();
  const params = useSearchParams();
  const nodeId = params.get('node');

  const detailApi = useApi<Detail>(nodeId ? `/catalog/${encodeURIComponent(nodeId)}/detail` : null);
  const detail = nodeId && detailApi.data?.node.id === nodeId ? detailApi.data : null;
  const summary = useApi<{ levels: Record<string, number>; offers: number; offersLive: number }>(nodeId ? null : '/catalog/summary');

  const isOffer = detail?.node.level === 'OFFER';
  // The folder shown on the left: the node itself, or (for an offer) the group it sits in.
  const location: CNode | null = !detail ? null
    : isOffer ? (() => { const t = detail.trail[detail.trail.length - 1]; return t ? ({ id: t.id, name: t.name, level: t.level, status: 'ACTIVE' } as CNode) : null; })()
    : detail.node;
  const ready = !nodeId || !!detail;
  const list = usePaged<CNode>(ready ? `/catalog/browse?limit=50&parent=${encodeURIComponent(location?.id ?? '')}` : null);

  const [query, setQuery] = useState('');
  const term = useDebounced(query.trim());
  const results = usePaged<CNode>(term ? `/catalog/search?limit=30&q=${encodeURIComponent(term)}` : null);

  const [editing, setEditing] = useState<CNode | null>(null);
  const [adding, setAdding] = useState<{ level: CNode['level']; parent: CNode | null } | null>(null);
  const reloadAll = useCallback(async () => { await Promise.all([list.reload(), nodeId ? detailApi.reload() : summary.reload()]); }, [list.reload, detailApi.reload, summary.reload, nodeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useAction(reloadAll);

  const crumbs: Crumb[] = useMemo(() => {
    const out: Crumb[] = [{ id: null, name: 'Catalog' }];
    if (detail) { for (const t of detail.trail) out.push({ id: t.id, name: t.name }); if (!isOffer) out.push({ id: detail.node.id, name: detail.node.name }); }
    return out;
  }, [detail, isOffer]);
  // Going deeper slides in from the right; coming back out slides in from the left.
  const depth = crumbs.length, prev = useRef(depth);
  const direction = depth >= prev.current ? 'fwd' : 'back';
  useEffect(() => { prev.current = depth; }, [depth]);

  const go = useCallback((id: string | null) => { setQuery(''); router.push(id ? `/catalog?node=${encodeURIComponent(id)}` : '/catalog', { scroll: true }); }, [router]);
  // The selected item was deleted (or the link is stale): go up a level instead of showing an empty pane.
  useEffect(() => { if (nodeId && detailApi.error && !detailApi.data) router.replace('/catalog'); }, [nodeId, detailApi.error, detailApi.data, router]);

  const afterEdit = useCallback(() => {
    const gone = editing && editing.id === nodeId;
    setEditing(null); setAdding(null);
    if (gone) { const up = detail?.trail[detail.trail.length - 1]; void detailApi.reload().catch(() => go(up?.id ?? null)); }
    void reloadAll();
  }, [editing, nodeId, detail, detailApi, go, reloadAll]);

  const a: Actions = {
    editable, onOpen: go, onEdit: setEditing, onChanged: () => void reloadAll(),
    onAdd: (parent) => setAdding({ level: CHILD_LEVEL[parent.level]!, parent }),
    onStatus: (id, status) => act.run(() => patch(`/catalog/${id}`, { status })),
  };
  const open = (n: CNode) => { if (n.level === 'LINE_ITEM') go(n.parentId ?? null); else go(n.id); };
  const back = detail ? (detail.trail[detail.trail.length - 1]?.id ?? null) : null;
  const showInspectorOnPhone = !!nodeId && isOffer;

  if (nodeId && detailApi.loading && !detail) return <Spinner />;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,380px)_1fr] lg:items-start">
        <aside className={`${showInspectorOnPhone ? 'hidden lg:block' : ''} min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:pr-1`}>
          <div className="mb-3 flex items-center justify-between gap-2 lg:hidden">
            <h1 className="min-w-0 truncate text-title1 font-bold tracking-tight">{location?.name ?? 'Product catalog'}</h1>
            {editable && location && (
              <MenuButton label={`Actions for ${location.name}`} items={[
                { label: 'Edit…', onSelect: () => detail && setEditing(detail.node) },
                detail?.node.status === 'ACTIVE' ? { label: 'Retire', onSelect: () => a.onStatus(location.id, 'RETIRED'), divider: true } : { label: 'Make live', onSelect: () => a.onStatus(location.id, 'ACTIVE'), divider: true },
              ]} />
            )}
          </div>
          <BrowseList location={location} crumbs={crumbs} list={list} results={results} pending={query.trim() !== term} query={query} onQuery={setQuery}
            selectedId={nodeId} editable={editable} direction={direction} onOpen={open} onGo={go}
            onAdd={() => setAdding({ level: location ? CHILD_LEVEL[location.level]! : 'NETWORK_TYPE', parent: detail && !isOffer ? detail.node : location })}
            onReorder={(id, d) => act.run(() => post(`/catalog/${id}/reorder`, { direction: d }))}
            onStatus={a.onStatus} />
        </aside>

        <section aria-live="polite" className={`${showInspectorOnPhone ? '' : 'hidden lg:block'} min-w-0`}>
          {showInspectorOnPhone && (
            <button onClick={() => go(back)} className="mb-3 inline-flex min-h-tap items-center gap-1 text-body text-accent lg:hidden"><span aria-hidden>‹</span>{location?.name ?? 'Catalog'}</button>
          )}
          {(act.error || detailApi.error) && <div className="mb-4"><Alert>{act.error ?? detailApi.error}</Alert></div>}
          {!detail
            ? <Welcome summary={summary.data} editable={editable} onAdd={() => setAdding({ level: 'NETWORK_TYPE', parent: null })} />
            : isOffer
              ? <OfferInspector key={detail.node.id} d={detail} a={a} />
              : <ContainerInspector key={detail.node.id} d={detail} a={a} />}
        </section>
      </div>
      {editing && <EditNodeModal node={editing} parentName={detail?.trail[detail.trail.length - 1]?.name} onClose={() => setEditing(null)} onDone={afterEdit} />}
      {adding && <AddNodeModal level={adding.level} parent={adding.parent} onClose={() => setAdding(null)} onDone={() => { setAdding(null); void reloadAll(); }} />}
    </>
  );
}
