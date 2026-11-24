'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useApi } from '@/lib/api';
import { RELEASE_EVENT, setActiveRelease, useActiveReleaseId } from './release';

export interface ReleaseSummaryData { release: { id: string; number: string; name: string; status: string; publishAt: string | null; changeCount?: number }; changes: Array<{ id: number }>; conflicts: Array<{ nodeId: string }>; nodeIds: string[] }

/** The release being worked in, loaded and kept current: staged writes anywhere on the Catalog screens tell it to reload. Null when there is none. */
export function useActiveRelease() {
  const id = useActiveReleaseId();
  const api = useApi<ReleaseSummaryData>(id ? `/catalog/releases/${id}` : null);
  const { reload } = api;
  useEffect(() => { const on = () => void reload(); window.addEventListener(RELEASE_EVENT, on); return () => window.removeEventListener(RELEASE_EVENT, on); }, [reload]);
  // a release that is gone, published or cancelled is no longer one to work in
  useEffect(() => { if (id && (api.error || (api.data && api.data.release.status !== 'DRAFT'))) setActiveRelease(null); }, [id, api.error, api.data]);
  return id && api.data ? api.data : null;
}

/** Above the catalog: which release is open, how many changes it holds, and whether the item on screen is part of it. */
export function ReleaseBar({ nodeId }: { nodeId?: string | null }) {
  const r = useActiveRelease();
  if (!r) return null;
  const inIt = !!nodeId && r.nodeIds.includes(nodeId);
  return (
    <div role="status" className="mb-4 space-y-1 rounded-card bg-accent/10 px-4 py-3 text-subhead">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>Working in <strong>{r.release.number}</strong> · {r.release.name}</span>
        <span className="text-label2">{r.changes.length} {r.changes.length === 1 ? 'change' : 'changes'}, not live yet{r.conflicts.length ? ` · ${r.conflicts.length} to resolve` : ''}</span>
        <Link href={`/catalog/releases/${r.release.id}`} className="font-medium text-accent">Review and publish</Link>
        <button type="button" onClick={() => setActiveRelease(null)} className="text-accent">Stop working in it</button>
      </p>
      {inIt && <p className="text-footnote text-label2">This item has changes in this release. What you see below is live; open the release to see the difference.</p>}
    </div>
  );
}
