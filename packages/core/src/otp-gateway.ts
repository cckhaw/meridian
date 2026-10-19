import type { Db, Queryable } from './db.js';
import { audit } from './audit.js';
import { emailCodesAvailable, sendEmail } from './email-gateway.js';
import { hubEndpointWithSecret } from './integration-hub.js';

/**
 * Sends the one-time codes that the sign-in code (second factor) and password recovery put in the outbox. Codes by SMS or WhatsApp go through the messaging gateway
 * set up in the Integration hub (Messaging); codes and recovery links by e-mail go through the e-mail sender of the same hub (email-gateway.ts), and only while
 * Settings → Security policy allows e-mail codes. A channel with nothing behind it leaves its codes waiting in the outbox.
 *
 * The gateway receives a JSON message: { to, channel, text, templateId, senderId, variables: { code, minutes, name } }, with `Authorization: Bearer <token>`.
 * `channel` is SMS or WHATSAPP, as the administrator chose; WhatsApp usually needs an approved template, so the template ids are sent too.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setOtpHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };

type GatewayEndpoint = NonNullable<Awaited<ReturnType<typeof hubEndpointWithSecret>>>;
/** The one SMS / WhatsApp gateway the product has: the enabled OTP_GATEWAY in the Integration hub. Alerts and signed agreement copies use it too (e-mail has its own sender, email-gateway.ts). */
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
const SUBJECT: Record<string, string> = { MFA: 'Your Meridian sign-in code', RESET: 'Reset your Meridian password' };
const linkText = (link: string, mins: number) => `Open this link to choose a new Meridian password: ${link}\nIt works once and expires in ${mins} minutes. If you did not ask for it, ignore this message.`;

/** Which kinds of code can go out now (nothing when there is no gateway or sender). Lets a caller say so plainly before a code is generated that could not go out. */
export async function otpGatewayStatus(db: Db): Promise<{ configured: boolean; sms: boolean; email: boolean }> {
  const ep = await messagingGateway(db);
  const ok = !!ep?.url;
  return { configured: ok, sms: ok, email: await emailCodesAvailable(db) };
}

/** `only.to` limits the run to the newest sign-in code waiting for that number or address (a sign-in asking for its own), so one person's request never spends the batch on others and an older, no longer valid code is never sent after it. */
export async function deliverOtpMessages(db: Db, limit = 25, only?: { to: string }): Promise<{ sent: number; failed: number; waiting: number }> {
  const [ep, emailOn] = await Promise.all([messagingGateway(db), emailCodesAvailable(db)]);
  const kinds = [...(ep ? ['SMS'] : []), ...(emailOn ? ['EMAIL'] : [])];
  if (!kinds.length) return { sent: 0, failed: 0, waiting: 0 };
  let sent = 0, failed = 0;
  const rows = await db.tx(async (q) => (await q.query(
    `SELECT id, instruction, payload FROM lifecycle_outbox WHERE kind='NOTIFY' AND delivered_at IS NULL AND failed_at IS NULL AND instruction IN ('MFA_OTP','PASSWORD_RESET') AND payload->>'channel' = ANY($2::text[]) AND (payload->>'code' IS NOT NULL OR payload->>'link' IS NOT NULL) ${only ? `AND instruction='MFA_OTP' AND payload->>'purpose'='LOGIN' AND payload->>'to'=$3` : ''}
      ORDER BY id ${only ? 'DESC' : ''} LIMIT $1 FOR UPDATE SKIP LOCKED`, only ? [1, kinds, only.to] : [limit, kinds])).rows);
  for (const r of rows) {
    const p = r.payload as { to: string; code?: string; link?: string; name?: string; expiresAt?: string; channel?: string };
    const email = p.channel === 'EMAIL';
    const channel = email ? 'EMAIL' : gatewayChannel(ep!);
    const purpose = r.instruction === 'MFA_OTP' ? 'MFA' : 'RESET';
    const minutes = Math.max(1, Math.round((new Date(p.expiresAt ?? Date.now() + 600_000).getTime() - Date.now()) / 60_000));
    const text = p.code ? TEXT[purpose]!(p.code, minutes) : linkText(p.link!, minutes);
    try {
      if (email) {
        const res = await sendEmail(db, { to: p.to, subject: SUBJECT[purpose]!, text });
        if (!res.ok) {
          // A code that can never be sent (a bad address) is dropped, not kept in the outbox for ever.
          if (!res.retryable) await db.query(`UPDATE lifecycle_outbox SET failed_at=now(), last_error=$2, payload = payload - 'code' - 'link' WHERE id=$1`, [r.id, (res.error ?? '').slice(0, 300)]);
          throw new Error(res.error);
        }
      } else await postToGateway(ep!, { to: p.to, text, purpose, variables: { code: p.code, minutes, name: p.name ?? null }, reference: `outbox-${r.id}` });
      // The code is not kept once it has gone out: the outbox row records only that a message was sent.
      await db.query(`UPDATE lifecycle_outbox SET delivered_at=now(), payload = payload - 'code' - 'link' || jsonb_build_object('deliveredVia', $2::text) WHERE id=$1`, [r.id, channel]);
      sent++;
    } catch (e) {
      failed++;
      await audit(db, 'otp-gateway', 'auth', String(r.id), 'OTP_DELIVERY_FAILED', { channel, error: (e as Error).message.slice(0, 200) });
    }
  }
  return { sent, failed, waiting: Math.max(0, rows.length - sent - failed) };
}
