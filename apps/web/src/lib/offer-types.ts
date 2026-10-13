'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { label } from '@/lib/format';

interface Type { id: string; name: string; template: string; status: string }

// One shared request for every row and card on the page, refreshed at most once a minute.
let cached: { at: number; promise: Promise<Type[]> } | null = null;
const load = (): Promise<Type[]> => {
  if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), promise: api<{ types: Type[] }>('/catalog-config').then((r) => r.types).catch(() => { cached = null; return []; }) };
  return cached.promise;
};

/** The operator's offer types (Settings → Catalog → Offer types), for showing a type by its name rather than its code. */
export function useOfferTypes() {
  const [types, setTypes] = useState<Type[]>([]);
  useEffect(() => { let on = true; void load().then((t) => on && setTypes(t)); return () => { on = false; }; }, []);
  return useMemo(() => {
    const by = new Map(types.map((t) => [t.id, t]));
    return { list: types, name: (id?: string | null) => (id ? by.get(id)?.name ?? label(id) : '') };
  }, [types]);
}
