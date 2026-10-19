'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}

let redirecting = false;
function toLogin() {
  if (redirecting || typeof window === 'undefined' || window.location.pathname === '/login') return;
  redirecting = true;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, credentials: 'same-origin', headers: { 'content-type': 'application/json', ...init?.headers }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body, cache: 'no-store' });
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    const code = e?.error?.code ?? 'ERROR';
    if (res.status === 401 && code === 'UNAUTHENTICATED' && !path.startsWith('/admin/login') && !path.startsWith('/admin/verify') && !path.startsWith('/admin/2fa')) toLogin();
    throw new ApiError(res.status, code, e?.error?.message ?? `Request failed (${res.status})`, Number(res.headers.get('retry-after')) || undefined);
  }
  return res.json();
}
export const post = <T = any>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const put = <T = any>(path: string, json: unknown) => api<T>(path, { method: 'PUT', json });
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
