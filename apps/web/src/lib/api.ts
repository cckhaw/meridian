'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

let redirecting = false;
function toLogin() {
  if (redirecting || typeof window === 'undefined' || window.location.pathname === '/login') return;
  redirecting = true;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: 'no-store',
  });
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    const code = e?.error?.code ?? 'ERROR';
    // An expired or revoked session anywhere sends the user back to sign in; the login call itself reports its own errors.
    if (res.status === 401 && code === 'UNAUTHENTICATED' && !path.startsWith('/auth/login')) toLogin();
    if (code === 'PASSWORD_CHANGE_REQUIRED' && window.location.pathname !== '/change-password') window.location.assign('/change-password');
    if (code === 'MFA_ENROLMENT_REQUIRED' && !window.location.pathname.startsWith('/profile')) window.location.assign('/profile?setup=mfa');
    throw new ApiError(res.status, code, e?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.json();
}
export const post = <T = any>(path: string, json?: unknown, headers?: Record<string, string>) => api<T>(path, { method: 'POST', json: json ?? {}, headers });
export const patch = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

/** Fetches `path` (null = skip). `reload()` refetches without clearing current data, so tables do not flash. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (path === null) return;
    const n = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}

/** Wraps a mutation: tracks busy/error state and reloads on success. */
export function useAction(after?: () => void | Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true); setError(null); setOk(null);
    try { const r = await fn(); if (success) setOk(success); await after?.(); return r; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, [after]);
  return { run, busy, error, ok, clear: () => { setError(null); setOk(null); } };
}

/** Waits for typing to pause before a search runs, so each keystroke does not hit the server. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export interface PagedState<T> { items: T[]; loading: boolean; loadingMore: boolean; error: string | null; hasMore: boolean; loadMore: () => void; reload: () => Promise<void>; extra: Record<string, any> | null }

/**
 * A list that arrives a page at a time. `path` includes any search/filter query string (but not the cursor); changing it starts again from page 1.
 * Pages are appended ("load more"), so the browser never holds more than the user has scrolled through, and the server never counts the table.
 */
export function usePaged<T = any>(path: string | null): PagedState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const join = (base: string, c: string) => `${base}${base.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(c)}`;

  const first = useCallback(async () => {
    if (path === null) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<{ items: T[]; nextCursor: string | null }>(path);
      if (n !== seq.current) return;
      const { items: it, nextCursor, ...rest } = d;
      setItems(it); setCursor(nextCursor); setExtra(Object.keys(rest).length ? rest : null); setError(null);
    } catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { if (n === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { setItems([]); setCursor(null); void first(); }, [first]);

  const loadMore = useCallback(async () => {
    if (!cursor || path === null || loadingMore) return;
    const n = seq.current;
    setLoadingMore(true);
    try {
      const d = await api<{ items: T[]; nextCursor: string | null }>(join(path, cursor));
      if (n !== seq.current) return;
      setItems((cur) => [...cur, ...d.items]); setCursor(d.nextCursor);
    } catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { setLoadingMore(false); }
  }, [cursor, path, loadingMore]);

  return { items, loading, loadingMore, error, hasMore: !!cursor, loadMore: () => void loadMore(), reload: first, extra };
}
