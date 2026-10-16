import type { Db } from './db.js';
import { audit } from './audit.js';
import { hubEndpointWithSecret } from './integration-hub.js';

/**
 * Sends the one-time codes that the sign-in code (second factor) and password recovery put in the outbox, through the SMS or WhatsApp gateway set up in the
 * Integration hub (Sign-in and identity). Without a gateway the codes simply wait in the outbox for whatever delivers notifications at the operator, as before.
 *
 * The gateway receives a JSON message: { to, channel, text, templateId, senderId, variables: { code, minutes, name } }, with `Authorization: Bearer <token>`.
 * `channel` is SMS or WHATSAPP, as the administrator chose; WhatsApp usually needs an approved template, so the template ids are sent too.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
export const setOtpHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };

const TEXT: Record<string, (code: string, mins: number) => string> = {
  MFA: (code, mins) => `Your Meridian sign-in code is ${code}. It expires in ${mins} minutes. Never share it.`,
  RESET: (code, mins) => `Your Meridian password reset code is ${code}. It expires in ${mins} minutes. If you did not ask for it, ignore this message.`,
};

export async function deliverOtpMessages(db: Db, limit = 25): Promise<{ sent: number; failed: number; waiting: number }> {
  const ep = await hubEndpointWithSecret(db, 'auth', 'OTP_GATEWAY');
  if (!ep) return { sent: 0, failed: 0, waiting: 0 };
  const channel = (ep.config.deliver as string) === 'WHATSAPP' ? 'WHATSAPP' : 'SMS';
  const templates = (ep.config.templateIds ?? {}) as Record<string, string>;
  let sent = 0, failed = 0;
  const rows = await db.tx(async (q) => (await q.query(
    `SELECT id, instruction, payload FROM lifecycle_outbox WHERE kind='NOTIFY' AND delivered_at IS NULL AND instruction IN ('MFA_OTP','PASSWORD_RESET') AND payload->>'channel'='SMS' AND payload->>'code' IS NOT NULL
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows);
  for (const r of rows) {
    const p = r.payload as { to: string; code: string; name?: string; expiresAt?: string };
    const purpose = r.instruction === 'MFA_OTP' ? 'MFA' : 'RESET';
    const minutes = Math.max(1, Math.round((new Date(p.expiresAt ?? Date.now() + 600_000).getTime() - Date.now()) / 60_000));
    try {
      const res = await httpImpl(ep.url!, {
        method: 'POST', signal: AbortSignal.timeout(ep.timeoutMs),
        headers: { 'content-type': 'application/json', ...(ep.secret ? { authorization: `Bearer ${ep.secret}` } : {}) },
        body: JSON.stringify({ to: p.to, channel, text: TEXT[purpose]!(p.code, minutes), templateId: templates[purpose] ?? null, senderId: ep.config.senderId ?? null, variables: { code: p.code, minutes, name: p.name ?? null }, reference: `outbox-${r.id}` }),
      });
      if (!res.ok) throw new Error(`gateway answered ${res.status}`);
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
