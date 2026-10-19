import * as core from '@meridian/core';
import type { Db } from '@meridian/core';

/**
 * Sign-in codes by SMS or e-mail at the hub. The code is queued by the shared sign-in code (the same rules as the CRM); this hands it to the SMS / WhatsApp gateway or the e-mail sender set up in the Integration hub.
 * The hub shares the CRM's database, so it normally calls the gateway itself; if it cannot, it asks the CRM to (signed, see docs/FIBER_COVERAGE.md). A code that goes neither way
 * stays queued for the CRM's delivery job, which retries every minute.
 */
export type Delivery = 'SENT' | 'PENDING';
export async function deliverLoginCode(db: Db, challengeToken: string): Promise<Delivery> {
  const to = await core.challengeRecipient(db, challengeToken);
  if (!to) return 'PENDING';
  const r = await core.deliverOtpMessages(db, 5, { to }).catch(() => null);
  if (r?.sent) return 'SENT';
  if (!r || r.failed) return (await core.relayOtpDelivery(to))?.sent ? 'SENT' : 'PENDING';
  return 'PENDING';
}
/** What this site can send: SMS needs the gateway, e-mail needs e-mail codes switched on in the security policy and an e-mail sender. A kind that cannot go out is not offered, and asking for it says so instead of queueing a code nobody will deliver. */
export async function sendable(db: Db): Promise<{ SMS: boolean; EMAIL: boolean }> {
  const g = await core.otpGatewayStatus(db);
  return { SMS: g.sms, EMAIL: g.email };
}
/** Requests for a code are limited per address like wrong-code guesses are (three times the sign-in limit per window), counted whether or not they succeed so a guessed token cannot be probed. */
export async function throttleSends(db: Db, ip: string): Promise<void> {
  const cfg = core.authConfig(), key = `mfa-send:ip:${ip}`;
  const n = (await db.query(`SELECT count(*)::int AS n FROM auth_attempts WHERE key=$1 AND at > now() - ($2 || ' minutes')::interval`, [key, String(cfg.windowMinutes)])).rows[0]!.n as number;
  if (n >= cfg.userLimit * 3) throw new core.CodeThrottled(cfg.windowMinutes * 60, 'Too many code requests from this address. Try again later.');
  await db.query('INSERT INTO auth_attempts (key) VALUES ($1)', [key]);
}
