import { XMLParser } from 'fast-xml-parser';
import { invalid, type Row } from '@meridian/core';
import { providerSecret } from './providers.js';

/**
 * Asking a wholesale partner whether a place is serviceable, over REST or SOAP. Every partner words its answer differently, so the mapping is data:
 * `adapter_config` says where in the response to read each answer. A partner that is slow, down or garbled never fails the check; the caller answers without it.
 *
 * REST config:  { method: 'POST'|'GET', query: {…}, body: {…}, authHeader: 'Authorization'|'X-Api-Key', authScheme: 'Bearer'|'', paths: { serviceable, portStatus, speedsMbps, leadDays, reference }, exhaustedValues: ['FULL'] }
 * SOAP config:  { soapAction, body: '<ns:Check>…{{lat}}…</ns:Check>', namespaces?, paths, exhaustedValues }
 * Placeholders in query/body: {{lat}} {{lng}} {{postalCode}} {{address}} {{speedMbps}}.
 */
export interface PartnerAnswer { serviceable: boolean; portStatus: 'AVAILABLE' | 'EXHAUSTED'; speedsMbps: number[]; leadDays: number | null; reference: string | null }
export interface PartnerQuery { lat: number; lng: number; postalCode?: string; address?: string; speedMbps?: number }

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setFiberHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };

const esc = { json: (s: string) => JSON.stringify(s).slice(1, -1), xml: (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!) };
const fill = (tpl: string, q: PartnerQuery, e: (s: string) => string) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => e(String((q as unknown as Record<string, unknown>)[k] ?? '')));
/** A value that is exactly one placeholder keeps the type of what goes in (a latitude stays a number). */
const whole = (v: string, q: PartnerQuery): unknown => { const m = /^\{\{(\w+)\}\}$/.exec(v); const x = m ? (q as unknown as Record<string, unknown>)[m[1]!] : undefined; return typeof x === 'number' ? x : undefined; };
const fillDeep = (v: unknown, q: PartnerQuery): unknown => (typeof v === 'string' ? whole(v, q) ?? fill(v, q, esc.json) : Array.isArray(v) ? v.map((x) => fillDeep(x, q)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, q)])) : v);

export const readPath = (o: unknown, path: string | undefined): unknown => (path ? path.split('.').reduce<unknown>((a, k) => (a == null ? undefined : (a as Record<string, unknown>)[k]), o) : undefined);
const truthy = (v: unknown) => v === true || (typeof v === 'string' && /^(true|yes|1|y|serviceable|covered|available)$/i.test(v)) || v === 1;

/** Reads a partner's answer into ours, using the configured paths (or the plain field names). */
export function mapAnswer(data: unknown, cfg: Record<string, any>): PartnerAnswer {
  const p = (cfg.paths ?? {}) as Record<string, string>;
  const pick = (k: string) => readPath(data, p[k] ?? k);
  const serviceable = truthy(pick('serviceable'));
  const exhausted = ((cfg.exhaustedValues as string[] | undefined) ?? ['EXHAUSTED', 'FULL', 'NO_PORTS', 'none']).map((x) => String(x).toLowerCase());
  const ps = pick('portStatus');
  const speeds = ([] as unknown[]).concat(pick('speedsMbps') ?? []).flatMap((s) => (typeof s === 'string' ? s.split(',') : [s])).map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0);
  const lead = Number(pick('leadDays'));
  return { serviceable, portStatus: ps != null && exhausted.includes(String(ps).toLowerCase()) ? 'EXHAUSTED' : 'AVAILABLE', speedsMbps: [...new Set(speeds)].sort((a, b) => a - b), leadDays: Number.isFinite(lead) && lead >= 0 ? lead : null, reference: pick('reference') != null ? String(pick('reference')) : null };
}

export async function askPartner(provider: Row, query: PartnerQuery, timeoutMs: number): Promise<PartnerAnswer> {
  const cfg = (provider.adapterConfig ?? {}) as Record<string, any>;
  const secret = providerSecret(provider);
  const url = provider.adapterUrl as string | null;
  if (!url) throw invalid('The partner has no address set.');
  const auth: Record<string, string> = secret ? { [cfg.authHeader ?? 'Authorization']: `${cfg.authScheme === undefined ? 'Bearer' : cfg.authScheme}${cfg.authScheme === '' ? '' : ' '}${secret}`.trim() } : {};
  if (provider.adapterKind === 'SOAP') {
    const body = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${fill(String(cfg.body ?? ''), query, esc.xml)}</soapenv:Body></soapenv:Envelope>`;
    const res = await httpImpl(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: String(cfg.soapAction ?? ''), ...auth }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`partner answered ${res.status}`);
    const doc = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true }).parse(await res.text());
    return mapAnswer(doc?.Envelope?.Body ?? doc, cfg);
  }
  const method = String(cfg.method ?? 'POST').toUpperCase();
  const u = new URL(url);
  for (const [k, v] of Object.entries((fillDeep(cfg.query ?? (method === 'GET' ? { lat: '{{lat}}', lng: '{{lng}}' } : {}), query) as Record<string, string>))) u.searchParams.set(k, String(v));
  const body = method === 'GET' ? undefined : JSON.stringify(fillDeep(cfg.body ?? { lat: '{{lat}}', lng: '{{lng}}', postalCode: '{{postalCode}}' }, query));
  const res = await httpImpl(u.toString(), { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...auth }, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`partner answered ${res.status}`);
  return mapAnswer(await res.json(), cfg);
}
