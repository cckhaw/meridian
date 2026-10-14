'use client';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Every place stock can be held: switched-on warehouses and stores. A store user only has their own store. */
export function useLocations(): { id: string; label: string }[] {
  const { me } = useAuth();
  const wh = useApi<{ items: any[] }>(me?.storeId ? null : '/warehouses');
  const stores = useApi<{ items: any[] }>(me?.storeId ? null : '/stores?status=ACTIVE&limit=200');
  if (me?.storeId) return [{ id: me.storeId, label: me.storeId }];
  return [
    ...(wh.data?.items ?? []).filter((w) => w.status === 'ACTIVE').map((w) => ({ id: w.id as string, label: `${w.name} (${w.id})` })),
    ...(stores.data?.items ?? []).map((s) => ({ id: s.id as string, label: `${s.name} (${s.id})` })),
  ];
}
