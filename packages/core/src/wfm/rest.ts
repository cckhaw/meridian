import { invalid } from '../errors.js';
import type { WfmAddress, WfmBooking, WfmConnector, WfmResult, WfmSlot, WfmSlotQuery, WfmTechnician, WfmVendor } from './types.js';

/**
 * A connector for a field-service system (or a thin adapter in front of Salesforce Field Service, Oracle Field Service Cloud or TOA) that speaks Meridian's
 * small REST/JSON contract. Four calls, all `POST` with a JSON body:
 *
 *   /availability   { postalNode, address, skills, equipment, from, to, durationMinutes }     -> { slots: [{ id, start, end, capacityLeft? }] }
 *   /reservations   { caseId, caseNumber, idempotencyKey, slot, skills, equipment, address, customer, problem, notes, priority }  -> { reservationRef, expiresAt }
 *   /jobs           the same, plus reservationRef                                             -> { jobRef, status: "SCHEDULED" | "REQUESTED", technician? }
 *   /cancellations  { jobRef?, reservationRef?, reason }                                       -> 2xx
 *
 * and the system reports progress by calling Meridian's callback URL (see docs/CASES.md). Safe by construction: https only (plain http only to localhost outside
 * production), the token comes from an environment variable and never from the database, answers are validated before they are believed.
 */
export interface WfmRestConfig { baseUrl: string; auth: 'NONE' | 'BEARER'; tokenEnv: string; timeoutMs: number }

const iso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const text = (v: unknown, max = 120) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

export function createWfmRestConnector(config: WfmRestConfig, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): WfmConnector {
  async function post<T>(path: string, body: unknown, read: (j: Record<string, unknown>) => T | string): Promise<WfmResult<{ value: T }>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (config.auth === 'BEARER') headers.authorization = `Bearer ${env[config.tokenEnv] ?? ''}`;
    let res: Response;
    try { res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(config.timeoutMs) }); }
    catch (e) { return { ok: false, retryable: true, detail: `Could not reach the field-service system: ${(e as Error).message}` }; }
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, retryable: res.status >= 500 || res.status === 429 || res.status === 408, detail: `The field-service system answered ${res.status}${raw ? `: ${raw.slice(0, 200)}` : ''}` };
    let j: unknown = {};
    if (raw.trim()) { try { j = JSON.parse(raw); } catch { return { ok: false, retryable: false, detail: 'The field-service system sent an answer that is not JSON.' }; } }
    const v = read((j && typeof j === 'object' ? j : {}) as Record<string, unknown>);
    return typeof v === 'string' ? { ok: false, retryable: false, detail: v } : { ok: true, value: v };
  }
  const flat = <T>(r: WfmResult<{ value: T }>): WfmResult<T extends Record<string, unknown> ? T : never> => (r.ok ? ({ ok: true, ...(r.value as object) } as never) : r);
  const bookingBody = (b: WfmBooking) => ({ caseId: b.caseId, caseNumber: b.caseNumber, idempotencyKey: b.idempotencyKey, slot: b.slot, skills: b.skills, equipment: b.equipment, address: b.address as WfmAddress, customer: b.customer, problem: b.problem, notes: b.notes, priority: b.priority });
  return {
    vendor: 'rest',
    problem: () => (config.auth === 'BEARER' && !(env[config.tokenEnv] ?? '').trim() ? `${config.tokenEnv} is not set on the server.` : null),
    async availability(q: WfmSlotQuery) {
      const { booked: _b, ...body } = q;
      return flat(await post('/availability', body, (j) => {
        const slots = (Array.isArray(j.slots) ? j.slots : []).filter((s): s is Record<string, unknown> => !!s && typeof s === 'object').map((s): WfmSlot | null => (text(s.id, 200) && iso(s.start) && iso(s.end) ? { id: String(s.id), start: new Date(s.start as string).toISOString(), end: new Date(s.end as string).toISOString(), capacityLeft: Number.isInteger(s.capacityLeft) ? Number(s.capacityLeft) : null } : null)).filter((s): s is WfmSlot => !!s);
        return { slots: slots.filter((s) => s.capacityLeft === null || s.capacityLeft > 0).slice(0, 200) };
      })) as WfmResult<{ slots: WfmSlot[] }>;
    },
    async reserve(b) {
      return flat(await post('/reservations', bookingBody(b), (j) => (text(j.reservationRef, 200) ? { reservationRef: String(j.reservationRef), expiresAt: iso(j.expiresAt) ? new Date(j.expiresAt as string).toISOString() : new Date(Date.now() + 15 * 60_000).toISOString() } : 'The field-service system did not give a reservation reference.'))) as WfmResult<{ reservationRef: string; expiresAt: string }>;
    },
    async confirm(b) {
      return flat(await post('/jobs', { ...bookingBody(b), reservationRef: b.reservationRef }, (j) => {
        if (!text(j.jobRef, 200)) return 'The field-service system did not give a job number.';
        const t = j.technician && typeof j.technician === 'object' ? (j.technician as Record<string, unknown>) : null;
        const technician: WfmTechnician | undefined = t ? { ref: text(t.ref) ?? undefined, name: text(t.name) ?? undefined, phone: text(t.phone, 40) ?? undefined } : undefined;
        return { jobRef: String(j.jobRef), status: j.status === 'REQUESTED' ? ('REQUESTED' as const) : ('SCHEDULED' as const), technician };
      })) as WfmResult<{ jobRef: string; status: 'SCHEDULED' | 'REQUESTED'; technician?: WfmTechnician }>;
    },
    async cancel(r) {
      const x = await post('/cancellations', { jobRef: r.jobRef ?? undefined, reservationRef: r.reservationRef ?? undefined, reason: r.reason }, () => ({}));
      return x.ok ? { ok: true } : x;
    },
    async test() {
      const r = await post('/availability', { postalNode: null, address: {}, skills: [], equipment: [], from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 60 }, () => ({}));
      return { ok: r.ok, detail: r.ok ? 'Connected: the system answered an availability request.' : r.detail };
    },
  };
}

export const wfmRestVendor: WfmVendor = {
  id: 'rest',
  label: 'REST (Meridian field-service contract)',
  summary: 'Any field-service system with a small REST/JSON interface, or an adapter in front of Salesforce Field Service, Oracle Field Service Cloud or TOA. Four calls: availability, reservations, jobs, cancellations.',
  notes: ['The system reports progress by calling Meridian’s callback URL, signed with the webhook secret.'],
  real: true,
  fields: [
    { key: 'baseUrl', label: 'Base address', kind: 'url', required: true, placeholder: 'https://wfm.example.com/meridian' },
    { key: 'auth', label: 'Sign-in', kind: 'select', options: [{ value: 'BEARER', label: 'Bearer token' }, { value: 'NONE', label: 'None' }] },
    { key: 'tokenEnv', label: 'Token (environment variable)', kind: 'env', hint: 'Name of the server environment variable holding the token, for example MERIDIAN_WFM_TOKEN.' },
    { key: 'timeoutMs', label: 'Timeout (ms)', kind: 'number', min: 1000, max: 60000 },
  ],
  defaults: () => ({ baseUrl: '', auth: 'BEARER', tokenEnv: 'MERIDIAN_WFM_TOKEN', timeoutMs: 15000 }),
  validate(raw) {
    const r = (raw ?? {}) as Partial<WfmRestConfig>;
    const baseUrl = String(r.baseUrl ?? '').trim();
    let u: URL; try { u = new URL(baseUrl); } catch { throw invalid('Give the base address of the field-service system, starting with https://.'); }
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && process.env.NODE_ENV !== 'production')) throw invalid('The base address must start with https://.');
    if (u.username || u.password) throw invalid('Do not put a user name or password in the address: use the token setting.');
    const auth = r.auth ?? 'BEARER';
    if (auth !== 'NONE' && auth !== 'BEARER') throw invalid('Sign-in is a bearer token or none.');
    const tokenEnv = String(r.tokenEnv ?? '').trim();
    if (auth === 'BEARER' && !/^MERIDIAN_WFM_[A-Z0-9_]{1,40}$/.test(tokenEnv)) throw invalid('The token variable must be named MERIDIAN_WFM_ followed by capitals, digits or underscores.');
    const timeoutMs = Number(r.timeoutMs ?? 15000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw invalid('The timeout is from 1,000 to 60,000 ms.');
    return { baseUrl: u.toString().replace(/\/+$/, ''), auth, tokenEnv, timeoutMs };
  },
  create: (config, env, fetchImpl) => createWfmRestConnector(config as unknown as WfmRestConfig, env, fetchImpl),
};
