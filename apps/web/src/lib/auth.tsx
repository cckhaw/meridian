'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, post } from './api';

export interface Me {
  id: string; username: string; displayName: string; isSuperuser: boolean; roles: string[]; roleLabels: string[]; permissions: string[];
  modules: Array<{ id: string; label: string; href: string; icon: string }>; home: string; mustChangePassword: boolean; mfaEnrollRequired: boolean;
  storeId: string | null; dealerId: string | null; customerId: string | null; marketCode: string; creditLimitMinor: number | null;
}
interface AuthState { me: Me | null; loading: boolean; can: (...p: string[]) => boolean; refresh: () => Promise<void>; signOut: () => Promise<void> }

const Ctx = createContext<AuthState>({ me: null, loading: true, can: () => false, refresh: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setMe((await api('/auth/me')).user); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const signOut = useCallback(async () => { try { await post('/auth/logout'); } finally { setMe(null); window.location.assign('/login'); } }, []);
  const value = useMemo<AuthState>(() => {
    const perms = new Set(me?.permissions ?? []);
    return { me, loading, refresh, signOut, can: (...p) => p.some((x) => perms.has(x)) };
  }, [me, loading, refresh, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Hides children unless the user holds one of the permissions. Presentation only: the API enforces the same rule. */
export function Can({ any, children, fallback = null }: { any: string[]; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useAuth();
  return <>{can(...any) ? children : fallback}</>;
}
