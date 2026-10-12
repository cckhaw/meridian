'use client';
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = any>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/shop${path}`, {
    method: init.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'Something went wrong. Please try again.');
  return data as T;
}
