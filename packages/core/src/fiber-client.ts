import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { conflict, invalid, rejected } from './errors.js';
import { kindsWhere } from './offer-config.js';

/**
 * How the CRM and the store-front use the fibre coverage service (apps/fiber-coverage): a switch, and a small asynchronous client. Nothing else in the core knows
 * the module exists: with the switch off the fixed-broadband offers are not for sale, and with the service down the coverage check says so and the order can
 * still go ahead (the customer is told the address will be confirmed after the order).
 *
 *   FEATURE_FIBER_COVERAGE_MODULE_ENABLED   starting value of the switch (on/off; unset means on); an administrator's choice in Settings → Modules overrides it
 *   MERIDIAN_FIBER_URL                      base address of the service, e.g. https://fiber.example.com
 *   MERIDIAN_FIBER_API_KEY                  a key with the `fiber` scope, issued in the service's hub
 */
const envFlag = (): boolean => { const v = (process.env.FEATURE_FIBER_COVERAGE_MODULE_ENABLED ?? '').trim(); return v === '' || /^(1|true|on|yes)$/i.test(v); };   // unset keeps fibre on sale, as before the module existed

export async function fiberModuleEnabled(q: Queryable): Promise<boolean> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='modules'`)).rows[0];
  const v = (r?.value as { fiberCoverage?: { enabled?: boolean } } | undefined)?.fiberCoverage?.enabled;
  return typeof v === 'boolean' ? v : envFlag();
}
export async function setFiberModuleEnabled(q: Queryable, actor: string, enabled: boolean): Promise<boolean> {
  const cur = (await q.query(`SELECT value FROM settings WHERE key='modules'`)).rows[0]?.value ?? {};
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('modules', $1, $2) ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`, [JSON.stringify({ ...cur, fiberCoverage: { enabled } }), actor]);
  await audit(q, actor, 'settings', 'modules', enabled ? 'FIBER_MODULE_ON' : 'FIBER_MODULE_OFF', { enabled });
  return enabled;
}
export const fiberConfigured = () => !!process.env.MERIDIAN_FIBER_URL?.trim() && !!process.env.MERIDIAN_FIBER_API_KEY?.trim();
export async function fiberStatus(q: Queryable): Promise<{ enabled: boolean; configured: boolean; host: string | null }> {
  let host: string | null = null;
  try { host = process.env.MERIDIAN_FIBER_URL ? new URL(process.env.MERIDIAN_FIBER_URL).host : null; } catch { /* a malformed address shows as not set */ }
  return { enabled: await fiberModuleEnabled(q), configured: fiberConfigured() && !!host, host };
}

/** The offer types that are fixed broadband (they create a FIBER service). With the module off these are not sold: not listed for ordering, and refused if a basket still has one. */
export async function hiddenFixedKinds(q: Queryable): Promise<string[]> {
  if (await fiberModuleEnabled(q)) return [];
  return kindsWhere(q, (b) => b.service === 'FIBER');
}

// ───────────────────────── the client ─────────────────────────
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setFiberFetch = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };
const TIMEOUT_MS = 3500;

async function call<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const base = process.env.MERIDIAN_FIBER_URL?.replace(/\/$/, ''), key = process.env.MERIDIAN_FIBER_API_KEY;
  if (!base || !key) throw rejected('The coverage service is not connected yet.');
  let res: Response;
  try {
    res = await httpImpl(`${base}/api${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: init.json === undefined ? undefined : JSON.stringify(init.json), cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) } as RequestInit);
  } catch { throw rejected('The coverage check is not available right now.'); }
  const text = await res.text();
  let data: any; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (res.ok) return data as T;
  const msg = String(data?.error?.message ?? '');
  if (res.status === 401 || res.status === 503 || res.status >= 500) throw rejected('The coverage check is not available right now.');
  if (res.status === 409) throw conflict(msg || 'That port is no longer free.');
  if (res.status === 400) throw invalid(msg || 'The coverage request was not valid.');
  throw rejected(msg || 'The coverage check could not be completed.');
}
const on = async (q: Queryable) => { if (!(await fiberModuleEnabled(q))) throw rejected('Fibre coverage is switched off.'); };

export interface FiberPlace { lat?: number; lng?: number; address?: string; postalCode?: string; speedMbps?: number }
/** What a customer at this address would be told: the availability matrix. */
export async function fiberQualify(q: Queryable, p: FiberPlace) { await on(q); return call<any>('/v1/coverage/qualify-address', { method: 'POST', json: p }); }
export async function fiberReserve(q: Queryable, p: { providerId: string; dpId?: string; customerRef?: string; speedMbps?: number; lat?: number; lng?: number; address?: string }) { await on(q); return call<any>('/v1/coverage/reservations', { method: 'POST', json: p }); }
export async function fiberRelease(q: Queryable, id: string) { await on(q); return call<any>(`/v1/coverage/reservations/${encodeURIComponent(id)}/release`, { method: 'POST', json: {} }); }
export async function fiberWaitlist(q: Queryable, p: { providerId: string; dpId?: string; customerRef?: string; contact?: string; lat?: number; lng?: number; address?: string; speedMbps?: number }) { await on(q); return call<any>('/v1/coverage/waitlist', { method: 'POST', json: p }); }

/** Before an order is placed: the port the customer was holding must still be held. A lock that ran out sends them back to check again. No-op while the module is off. */
export async function fiberVerifyLock(q: Queryable, reservationId: string | null | undefined): Promise<void> {
  if (!reservationId || !(await fiberModuleEnabled(q))) return;
  const r = await call<{ state: string; expiresAt: string | null }>(`/v1/coverage/reservations/${encodeURIComponent(reservationId)}`);
  if (r.state === 'CONFIRMED') throw rejected('That port is already taken by another order. Please check availability again.');
  if (r.state !== 'ACTIVE' || (r.expiresAt && new Date(r.expiresAt) < new Date())) throw rejected('The port held for this order has been released because it took too long. Please check availability again.');
}
/** After the order exists: the held port becomes the order's. Never fails the order; a failure is written to the audit log for Fibre Ops to follow up. */
export async function fiberConfirmLock(q: Queryable, reservationId: string | null | undefined, orderRef: string, actor: string): Promise<boolean> {
  if (!reservationId) return false;
  try { await call(`/v1/coverage/reservations/${encodeURIComponent(reservationId)}/confirm`, { method: 'POST', json: { orderRef } }); return true; }
  catch (e) { await audit(q, actor, 'order', orderRef, 'FIBER_CONFIRM_FAILED', { reservationId, error: (e as Error).message }).catch(() => {}); return false; }
}
