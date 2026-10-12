'use client';
import { LoadMore, SearchField } from '@meridian/ui';
import { useState } from 'react';
import { useDebounced, usePaged } from '@/lib/api';
import { label } from '@/lib/format';
import { STATUS_DOT } from './catalog-ui';

export interface Picked { id: string; name: string; level: string; trail?: Array<{ name: string }> }

/**
 * Finds a catalog node by typing, without ever loading the catalog: results come from the search API a few at a time.
 * `levels` limits what can be chosen (e.g. only groups, or offers and whole groups).
 */
export function NodePicker({ levels, exclude, placeholder = 'Search by name…', onPick }: { levels: string[]; exclude?: Set<string>; placeholder?: string; onPick: (n: Picked) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const list = usePaged<any>(`/catalog/search?limit=8&level=${levels.join(',')}&q=${encodeURIComponent(term)}`);
  const rows = list.items.filter((n) => !exclude?.has(n.id));
  return (
    <div>
      <SearchField label={placeholder} placeholder={placeholder} value={q} onChange={setQ} />
      <ul className="mt-2 max-h-64 divide-y divide-separator overflow-y-auto rounded-control bg-surface2" aria-label="Matches">
        {list.loading && rows.length === 0 && <li className="px-3 py-3 text-subhead text-label2">Searching…</li>}
        {!list.loading && rows.length === 0 && <li className="px-3 py-3 text-subhead text-label2">{term ? 'Nothing matches.' : 'Type to search.'}</li>}
        {rows.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onPick({ id: n.id, name: n.name, level: n.level, trail: n.trail })} className="flex min-h-[44px] w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-separator/60 focus-visible:bg-separator/60 focus-visible:outline-none">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[n.status]}`} />
              <span className="min-w-0 flex-1"><span className="block truncate text-subhead">{n.name}</span><span className="block truncate text-caption text-label2">{label(n.level)}{n.trail?.length ? ` · ${n.trail.map((t: any) => t.name).join(' › ')}` : ''}</span></span>
            </button>
          </li>
        ))}
      </ul>
      {list.hasMore && <LoadMore shown={rows.length} hasMore loading={list.loadingMore} onMore={list.loadMore} noun="matches" />}
    </div>
  );
}
