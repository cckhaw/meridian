'use client';
import { Alert, Badge, Button, Empty, Field, Input, LargeTitle, LoadMore, Segmented, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';
import { setActiveRelease, useActiveReleaseId } from '../release';

export interface Release { id: string; number: string; name: string; description: string | null; status: string; publishAt: string | null; publishError: string | null; createdBy: string; createdAt: string; publishedAt: string | null; publishedBy: string | null; submittedBy: string | null; decidedBy: string | null; reversesReleaseId: string | null; changeCount?: number }
export const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { DRAFT: 'warning', IN_REVIEW: 'warning', APPROVED: 'success', PUBLISHED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };

/** Releases: batches of catalog changes that go live together. Start one, work in it (every save on the Catalog screens is then staged in it), review it, publish it. */
export function ReleaseList() {
  const { can } = useAuth();
  const [view, setView] = useState<'open' | 'done'>('open');
  const list = usePaged<Release>(`/catalog/releases?limit=25&status=${view === 'open' ? 'DRAFT,IN_REVIEW,APPROVED,REJECTED' : 'PUBLISHED,CANCELLED'}`);
  const active = useActiveReleaseId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const act = useAction(() => list.reload());
  const involved = can('catalog:write', 'release:submit', 'release:approve', 'release:publish');
  if (!involved) return <Alert tone="info">Releases are for people who maintain or review the catalog.</Alert>;
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => post<Release>('/catalog/releases', { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }));
    if (r) { setName(''); setDescription(''); setActiveRelease(r.id); }
  };
  return (
    <>
      <LargeTitle subtitle="Batch catalog changes, review and test them, then publish them together. While you work in a release, saving on the Catalog screens adds to it instead of going live.">Catalog releases</LargeTitle>
      <p className="mb-4"><Link href="/catalog" className="text-subhead text-accent">← Back to catalog</Link></p>
      {(act.error || list.error) && <div className="mb-4"><Alert>{act.error ?? list.error}</Alert></div>}
      {can('catalog:write') && <form onSubmit={create} className="mb-6 grid gap-4 rounded-card bg-surface p-4 shadow-card sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <Field label="New release"><Input value={name} maxLength={120} placeholder="e.g. Autumn promotion" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="What it is for" optional><Input value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Button type="submit" disabled={act.busy || !name.trim()}>{act.busy ? 'Creating…' : 'Create and work in it'}</Button>
      </form>}
      <div className="mb-3"><Segmented label="Show" value={view} onChange={setView} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Published and thrown away' }]} /></div>
      {list.loading && !list.items.length && <Spinner />}
      {!list.loading && !list.items.length && !list.error && <Empty>{view === 'open' ? 'No open releases. Create one above to start batching changes.' : 'Nothing published or closed yet.'}</Empty>}
      {list.items.length > 0 && (
        <ul className="divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
          {list.items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2"><Link href={`/catalog/releases/${r.id}`} className="font-medium text-accent">{r.number} · {r.name}</Link>
                  <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{label(r.status)}</Badge>
                  {r.publishAt && r.status !== 'PUBLISHED' && <Badge tone={r.publishError ? 'danger' : 'neutral'}>{r.publishError ? 'Scheduled publish failed' : `Publishes ${dt(r.publishAt)}`}</Badge>}
                  {active === r.id && <Badge tone="success">Working in it</Badge>}</p>
                <p className="text-footnote text-label2">{r.changeCount ?? 0} {r.changeCount === 1 ? 'change' : 'changes'} · {r.createdBy}, {dt(r.createdAt)}{r.publishedAt ? ` · published ${dt(r.publishedAt)}` : ''}{r.description ? ` · ${r.description}` : ''}</p>
              </div>
              {r.status === 'DRAFT' && can('catalog:write') && (active === r.id
                ? <Button variant="secondary" onClick={() => setActiveRelease(null)}>Stop working in it</Button>
                : <Button variant="secondary" onClick={() => setActiveRelease(r.id)}>Work in this release</Button>)}
            </li>
          ))}
        </ul>
      )}
      {list.hasMore && <LoadMore shown={list.items.length} hasMore loading={list.loadingMore} onMore={list.loadMore} noun="releases" />}
    </>
  );
}
