'use client';
import { SearchField } from '@meridian/ui';
import { useState } from 'react';
import { useApi, useDebounced } from '@/lib/api';

/** Choose a store by searching its id or name. Only switched-on stores are offered. Scales to hundreds of stores: it never loads them all. */
export function StorePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const found = useApi<{ items: any[] }>(value ? null : `/stores?status=ACTIVE&limit=8&q=${encodeURIComponent(term)}`);
  const current = useApi<{ items: any[] }>(value ? `/stores?q=${encodeURIComponent(value)}&limit=5` : null);
  const store = current.data?.items.find((s) => s.id === value);
  if (value) {
    return (
      <div className="flex min-h-tap items-center justify-between gap-3 rounded-control bg-surface2 px-4">
        <span className="min-w-0 truncate"><span className="font-mono text-footnote text-label2">{value}</span>{store && <span className="ml-2">{store.name}</span>}{store && store.status !== 'ACTIVE' && <span className="ml-2 text-footnote text-label2">(switched off)</span>}</span>
        <button type="button" className="shrink-0 text-accent" onClick={() => { onChange(''); setQ(''); }}>Change</button>
      </div>
    );
  }
  return (
    <div>
      <SearchField label="Find store" placeholder="Store id or name…" value={q} onChange={setQ} />
      <ul className="mt-2 divide-y divide-separator overflow-hidden rounded-control bg-surface2">
        {(found.data?.items ?? []).map((s) => (
          <li key={s.id}><button type="button" className="flex min-h-tap w-full items-center gap-3 px-4 text-left hover:bg-surface" onClick={() => onChange(s.id)}>
            <span className="font-mono text-footnote text-label2">{s.id}</span><span className="truncate">{s.name}</span>
          </button></li>
        ))}
        {found.data && found.data.items.length === 0 && <li className="px-4 py-3 text-subhead text-label2">{term ? 'No active store matches.' : 'No stores set up yet. Add them under Stores.'}</li>}
      </ul>
    </div>
  );
}
