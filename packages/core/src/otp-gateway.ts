import type { Db, Queryable } from './db.js';
import { audit } from './audit.js';
import { hubEndpointWithSecret } from './integration-hub.js';

/**
 * Sends the one-time codes that the sign-in code (second factor) and password recovery put in the outbox, through the SMS or WhatsApp gateway set up in the
 * Integration hub (Sign-in and identity). Without a gateway the codes simply wait in the outbox for whatever delivers notifications at the operator, as before.
 *
 * The gateway receives a JSON message: { to, channel, text, templateId, senderId, variables: { code, minutes, name } }, with `Authorization: Bearer <token>`.
 * `channel` is SMS or WHATSAPP, as the administrator chose; WhatsApp usually needs an approved template, so the template ids are sent too.
 * E-mail codes are the gateway's job only when the administrator opts in with `emailCodes: true` in the endpoint's settings (the gateway must then accept `channel: "EMAIL"`,
 * `to` being the address, with a `subject`); otherwise they wait in the outbox for the e-mail connector, as before.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setOtpHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };

type GatewayEndpoint = NonNullable<Awaited<ReturnType<typeof hubEndpointWithSecret>>>;
/** The one messaging gateway the product has: the enabled OTP_GATEWAY in the Integration hub. Alerts and signed agreement copies use it too. */
export const messagingGateway = (q: Queryable) => hubEndpointWithSecret(q, 'auth', 'OTP_GATEWAY');
export const gatewayChannel = (ep: GatewayEndpoint): 'SMS' | 'WHATSAPP' => ((ep.config.deliver as string) === 'WHATSAPP' ? 'WHATSAPP' : 'SMS');
export const gatewayTemplate = (ep: GatewayEndpoint, purpose: string): string | null => ((ep.config.templateIds ?? {}) as Record<string, string>)[purpose] ?? null;
/** Posts one message to the gateway; throws when it cannot be reached or does not accept it. */
export async function postToGateway(ep: GatewayEndpoint, m: { to: string; text: string; purpose: string; variables: Record<string, unknown>; reference: string; channel?: string; subject?: string }): Promise<void> {
  const res = await httpImpl(ep.url!, {
    method: 'POST', signal: AbortSignal.timeout(ep.timeoutMs),
    headers: { 'content-type': 'application/json', ...(ep.secret ? { authorization: `Bearer ${ep.secret}` } : {}) },
    body: JSON.stringify({ to: m.to, channel: m.channel ?? gatewayChannel(ep), ...(m.subject ? { subject: m.subject } : {}), text: m.text, templateId: gatewayTemplate(ep, m.purpose), senderId: ep.config.senderId ?? null, variables: m.variables, reference: m.reference }),
  });
  if (!res.ok) throw new Error(`gateway answered ${res.status}`);
}

const TEXT: Record<string, (code: string, mins: number) => string> = {
  MFA: (code, mins) => `Your Meridian sign-in code is ${code}. It expires in ${mins} minutes. Never share it.`,
  RESET: (code, mins) => `Your Meridian password reset code is ${code}. It expires in ${mins} minutes. If you did not ask for it, ignore this message.`,
};

/** Which kinds of code the configured gateway can carry (nothing when there is none). Lets a caller say so plainly before a code is generated that could not go out. */
export async function otpGatewayStatus(db: Db): Promise<{ configured: boolean; sms: boolean; email: boolean }> {
  const ep = await messagingGateway(db);
  const ok = !!ep?.url;
  return { configured: ok, sms: ok, email: ok && ep!.config.emailCodes === true };
}

/** `only.to` limits the run to the newest sign-in code waiting for that number or address (a sign-in asking for its own), so one person's request never spends the batch on others and an older, no longer valid code is never sent after it. */
export async function deliverOtpMessages(db: Db, limit = 25, only?: { to: string }): Promise<{ sent: number; failed: number; waiting: number }> {
  const ep = await messagingGateway(db);
  if (!ep) return { sent: 0, failed: 0, waiting: 0 };
  const kinds = ep.config.emailCodes === true ? ['SMS', 'EMAIL'] : ['SMS'];
  let sent = 0, failed = 0;
  const rows = await db.tx(async (q) => (await q.query(
    `SELECT id, instruction, payload FROM lifecycle_outbox WHERE kind='NOTIFY' AND delivered_at IS NULL AND instruction IN ('MFA_OTP','PASSWORD_RESET') AND payload->>'channel' = ANY($2::text[]) AND payload->>'code' IS NOT NULL ${only ? `AND instruction='MFA_OTP' AND payload->>'purpose'='LOGIN' AND payload->>'to'=$3` : ''}
      ORDER BY id ${only ? 'DESC' : ''} LIMIT $1 FOR UPDATE SKIP LOCKED`, only ? [1, kinds, only.to] : [limit, kinds])).rows);
  for (const r of rows) {
    const p = r.payload as { to: string; code: string; name?: string; expiresAt?: string; channel?: string };
    const channel = p.channel === 'EMAIL' ? 'EMAIL' : gatewayChannel(ep);
    const purpose = r.instruction === 'MFA_OTP' ? 'MFA' : 'RESET';
    const minutes = Math.max(1, Math.round((new Date(p.expiresAt ?? Date.now() + 600_000).getTime() - Date.now()) / 60_000));
    try {
      await postToGateway(ep, { to: p.to, text: TEXT[purpose]!(p.code, minutes), purpose, variables: { code: p.code, minutes, name: p.name ?? null }, reference: `outbox-${r.id}`, ...(channel === 'EMAIL' ? { channel, subject: 'Your Meridian code' } : {}) });
      // The code is not kept once it has gone out: the outbox row records only that a message was sent.
      await db.query(`UPDATE lifecycle_outbox SET delivered_at=now(), payload = payload - 'code' || jsonb_build_object('deliveredVia', $2::text) WHERE id=$1`, [r.id, channel]);
      sent++;
    } catch (e) {
      failed++;
      await audit(db, 'otp-gateway', 'auth', String(r.id), 'OTP_DELIVERY_FAILED', { channel, error: (e as Error).message.slice(0, 200) });
    }
  }
  return { sent, failed, waiting: Math.max(0, rows.length - sent - failed) };
}
