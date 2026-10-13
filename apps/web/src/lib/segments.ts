'use client';
import { useMemo } from 'react';
import { useApi } from '@/lib/api';

export interface SegmentInfo { id: string; name: string; description?: string | null; individual: boolean; status: string }

/** The operator's customer segments (Settings → Customers): the names to show, and the active ones to choose from. */
export function useSegments() {
  const { data } = useApi<SegmentInfo[]>('/segments');
  return useMemo(() => {
    const list = data ?? [];
    const byId = new Map(list.map((s) => [s.id, s]));
    return { list, name: (id: string) => byId.get(id)?.name ?? id.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), individual: (id: string) => !!byId.get(id)?.individual };
  }, [data]);
}
