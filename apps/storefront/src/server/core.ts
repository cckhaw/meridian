/**
 * The only place this app talks to the CRM. Configuration (server-side environment variables only; never NEXT_PUBLIC_):
 *   MERIDIAN_API_URL  base URL of the CRM API, e.g. https://crm.example.com/api
 *   MERIDIAN_API_KEY  a store-front key created under Settings → Store-front in the CRM
 */
export class CoreError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const coreConfigured = () => !!process.env.MERIDIAN_API_URL && !!process.env.MERIDIAN_API_KEY;

export async function core<T = any>(path: string, init: { method?: string; json?: unknown; token?: string; shopperIp?: string | null; shopperUa?: string | null } = {}): Promise<T> {
  const base = process.env.MERIDIAN_API_URL?.replace(/\/$/, '');
  const key = process.env.MERIDIAN_API_KEY;
  if (!base || !key) throw new CoreError(503, 'NOT_CONFIGURED', 'The store is not connected to the CRM yet.');
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  if (init.token) headers['x-application-token'] = init.token;
  if (init.shopperIp) headers['x-shopper-ip'] = init.shopperIp;
  if (init.shopperUa) headers['x-shopper-ua'] = init.shopperUa.slice(0, 300);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.json === undefined ? undefined : JSON.stringify(init.json), cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new CoreError(503, 'UNAVAILABLE', 'The store is temporarily unavailable. Please try again in a moment.');
  }
  const text = await res.text();
  let data: any; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) {
    // 401 here means OUR key is wrong, which is not the shopper's problem and must not leak details to them.
    if (res.status === 401) throw new CoreError(503, 'NOT_CONFIGURED', 'The store is not connected to the CRM yet.');
    throw new CoreError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}
