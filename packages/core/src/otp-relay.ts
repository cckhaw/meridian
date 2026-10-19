import { createHmac } from 'node:crypto';
import type { Db } from './db.js';
import { DomainError } from './errors.js';
import { hubUrlProblem } from './integration-hub.js';
import { deliverOtpMessages } from './otp-gateway.js';
import { verifyWfmSignature, wfmSignature } from './wfm-webhook.js';

/**
 * The fibre hub is a separate deployment that shares the CRM's database, so it normally hands sign-in codes to the SMS/WhatsApp gateway itself (the gateway's address and
 * token are settings in that database). When the hub cannot reach the gateway from where it runs, it asks the CRM to do it: a signed server-to-server call that only means
 * "deliver the codes that are waiting" (nothing secret travels, and a replay can do no more than that).
 *
 *   MERIDIAN_CRM_URL         on the hub: the CRM's address, e.g. https://crm.example.com
 *   MERIDIAN_FIBER_API_KEY   on both: the fibre key the CRM already uses to call the hub. Here it only keys the signature; the hub never sends it.
 *
 * The signature is the one the field-service callback uses (`t=<seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`, five minutes either way), with a key derived from the fibre key.
 */
export const OTP_RELAY_PATH = '/api/internal/fiber/deliver-otp';
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setOtpRelayHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };

const secretOf = (): string | null => { const k = process.env.MERIDIAN_FIBER_API_KEY?.trim(); return k && k.length >= 16 ? createHmac('sha256', 'meridian-fiber-otp-relay-v1').update(k).digest('hex') : null; };
const crmBase = (): string | null => { const u = process.env.MERIDIAN_CRM_URL?.trim().replace(/\/$/, ''); return u && !hubUrlProblem(u) ? u : null; };
export const otpRelayConfigured = () => !!crmBase() && !!secretOf();

export interface OtpRelayResult { sent: number; failed: number; waiting: number }
/** Hub side: asks the CRM to deliver the code waiting for `to`. Null when the relay is not set up or the CRM does not answer. */
export async function relayOtpDelivery(to: string): Promise<OtpRelayResult | null> {
  const base = crmBase(), secret = secretOf();
  if (!base || !secret) return null;
  const raw = JSON.stringify({ to });
  try {
    const res = await httpImpl(`${base}${OTP_RELAY_PATH}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-meridian-signature': wfmSignature(raw, secret) }, body: raw, cache: 'no-store' } as RequestInit);
    return res.ok ? ((await res.json()) as OtpRelayResult) : null;
  } catch { return null; }
}
/** CRM side: checks the signature over the raw body, then delivers the code waiting for that number or address. Answers "not found" when the relay is not set up. */
export async function handleOtpRelay(db: Db, raw: string, signature: string | null | undefined): Promise<OtpRelayResult> {
  const secret = secretOf();
  if (!secret) throw new DomainError('NOT_FOUND', 'not found');
  verifyWfmSignature(raw, signature, secret);
  let to: unknown;
  try { to = (JSON.parse(raw) as { to?: unknown }).to; } catch { /* handled below */ }
  if (typeof to !== 'string' || !to || to.length > 200) throw new DomainError('INVALID', 'The request needs a recipient.');
  return deliverOtpMessages(db, 5, { to });
}
