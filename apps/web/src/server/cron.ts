import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Scheduled jobs for a scheduler that has no sign-in (Vercel Cron, a GitHub Actions schedule, a cron service). They are authorised by one secret in `MERIDIAN_CRON_SECRET`, sent as
 * `Authorization: Bearer <secret>`, and can run only the fixed list of jobs in the router: nothing else is reachable with it and it is not a user, so it never has to be given to
 * a staff account's password or a long-lived session. Without the secret set (at least 32 characters) the routes are off.
 */
export const CRON_SECRET_MIN = 32;
export type CronAuth = 'ok' | 'disabled' | 'denied';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function cronAuth(authorization: string | null, env: Record<string, string | undefined> = process.env): CronAuth {
  const secret = env.MERIDIAN_CRON_SECRET ?? '';
  if (secret.length < CRON_SECRET_MIN) return 'disabled';
  const m = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!m) return 'denied';
  return timingSafeEqual(digest(m[1]!), digest(secret)) ? 'ok' : 'denied';   // compared as digests, so the length of the secret is not leaked either
}
