import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { audit } from './audit.js';
import { revokeUserSessions } from './auth.js';
import type { Db } from './db.js';
import { invalid, rejected } from './errors.js';
import { queueOutbox } from './lifecycle-state.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { checkPassword, getSecurityPolicy, isReusedPassword, rememberPassword } from './security-policy.js';

/**
 * "Forgot password". A person asks with their username or e-mail; what happens is the same whether or not the account exists, so the form cannot be used to
 * find out who has one. A link (e-mail) or a six-digit code (SMS) is queued for delivery, works once, expires, and a code locks after a few wrong tries.
 * Only hashes are stored. The super user is never recoverable this way: their password lives in the environment.
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const BAD = 'This reset link or code is not valid, or it has expired. Ask for a new one.';
const MAX_CODE_TRIES = 5;

export async function requestPasswordReset(db: Db, i: { identifier: string; ip?: string }): Promise<{ ok: true }> {
  const policy = await getSecurityPolicy(db);
  const done = { ok: true } as const;
  const id = (i.identifier ?? '').trim().toLowerCase();
  if (!policy.recovery.enabled || !id || id.length > 200) return done;
  // Throttle by address as well, before looking anyone up.
  const ikey = `reset:ip:${i.ip ?? 'unknown'}`;
  const tries = (await db.query(`SELECT count(*) AS n FROM auth_attempts WHERE key=$1 AND at > now() - interval '1 hour'`, [ikey])).rows[0]!.n as number;
  await db.query('INSERT INTO auth_attempts (key) VALUES ($1)', [ikey]);
  if (tries >= 20) return done;

  const u = (await db.query(`SELECT * FROM users WHERE (lower(username)=$1 OR lower(email)=$1) AND NOT is_superuser AND status='ACTIVE' AND auth_source='LOCAL' AND password_hash IS NOT NULL LIMIT 1`, [id])).rows[0];
  if (!u) return done;
  const recent = (await db.query(`SELECT count(*) AS n FROM password_reset_tokens WHERE user_id=$1 AND created_at > now() - interval '1 hour'`, [u.id])).rows[0]!.n as number;
  if (recent >= policy.recovery.maxRequestsPerHour) return done;

  const want = policy.recovery.channel;
  const channel: 'EMAIL' | 'SMS' | null = want === 'SMS' ? (u.phone ? 'SMS' : null) : want === 'EMAIL' ? (u.email ? 'EMAIL' : null) : u.email ? 'EMAIL' : u.phone ? 'SMS' : null;
  if (!channel) { await audit(db, u.username, 'auth', u.id, 'PASSWORD_RESET_NO_CHANNEL'); return done; }
  const expiresAt = new Date(Date.now() + policy.recovery.tokenMinutes * 60_000);
  await db.tx(async (q) => {
    await q.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id=$1 AND used_at IS NULL`, [u.id]); // a new request replaces any open one
    if (channel === 'EMAIL' && policy.recovery.publicUrl) {
      const token = randomBytes(32).toString('base64url');
      await q.query('INSERT INTO password_reset_tokens (user_id, token_hash, channel, expires_at) VALUES ($1,$2,$3,$4)', [u.id, sha(token), channel, expiresAt.toISOString()]);
      await queueOutbox(q, { kind: 'NOTIFY', instruction: 'PASSWORD_RESET', payload: { channel, to: u.email, name: u.displayName, link: `${policy.recovery.publicUrl}/reset-password?token=${token}`, expiresAt: expiresAt.toISOString() } });
    } else {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await q.query('INSERT INTO password_reset_tokens (user_id, token_hash, channel, expires_at) VALUES ($1,$2,$3,$4)', [u.id, sha(`${u.id}:${code}`), channel, expiresAt.toISOString()]);
      await queueOutbox(q, { kind: 'NOTIFY', instruction: 'PASSWORD_RESET', payload: { channel, to: channel === 'EMAIL' ? u.email : u.phone, name: u.displayName, code, expiresAt: expiresAt.toISOString() } });
    }
    await audit(q, u.username, 'auth', u.id, 'PASSWORD_RESET_REQUESTED', { channel, ip: i.ip });
  });
  return done;
}

/** Sets a new password with a link token (e-mail) or with the username plus the six-digit code (SMS). Single use. Signs the person out everywhere. */
export async function resetPasswordWithToken(db: Db, i: { token?: string; identifier?: string; code?: string; newPassword: string; ip?: string }): Promise<{ ok: true }> {
  const policy = await getSecurityPolicy(db);
  if (!policy.recovery.enabled) throw rejected(BAD);
  let row: Record<string, any> | undefined;
  if (i.token) {
    if (i.token.length < 20 || i.token.length > 200) throw rejected(BAD);
    row = (await db.query(`SELECT t.*, u.username, u.password_hash AS user_hash FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1`, [sha(i.token)])).rows[0];
  } else if (i.identifier && i.code && /^\d{6}$/.test(i.code)) {
    const u = (await db.query(`SELECT id FROM users WHERE (lower(username)=$1 OR lower(email)=$1) AND NOT is_superuser`, [i.identifier.trim().toLowerCase()])).rows[0];
    if (u) {
      const t = (await db.query(`SELECT t.*, u.username, u.password_hash AS user_hash FROM password_reset_tokens t JOIN users u ON u.id=t.user_id WHERE t.user_id=$1 AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1`, [u.id])).rows[0];
      if (t) {
        if (t.attempts >= MAX_CODE_TRIES) throw rejected(BAD);
        await db.query('UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE id=$1', [t.id]);
        if (eq(t.tokenHash, sha(`${u.id}:${i.code}`))) row = t;
      }
    }
  }
  if (!row || row.usedAt || new Date(row.expiresAt).getTime() < Date.now()) throw rejected(BAD);

  const problem = checkPassword(policy, i.newPassword, row.username);
  if (problem) throw invalid(problem);
  if (row.userHash && (await verifyPassword(i.newPassword, row.userHash))) throw invalid('Choose a password different from the current one.');
  if (await isReusedPassword(db, row.userId, i.newPassword, verifyPassword, policy)) throw invalid(`You used that password before. Choose one you have not used in your last ${policy.password.historyCount} passwords.`);
  await db.tx(async (q) => {
    // Claim the token inside the transaction so two requests cannot both use it.
    const claimed = await q.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id=$1 AND used_at IS NULL RETURNING id`, [row!.id]);
    if (!claimed.rowCount) throw rejected(BAD);
    const hash = await hashPassword(i.newPassword);
    await q.query(`UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [row!.userId, hash]);
    await rememberPassword(q, row!.userId, hash);
    await q.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id=$1 AND used_at IS NULL`, [row!.userId]);
    await revokeUserSessions(q, row!.userId);
    await audit(q, row!.username, 'auth', row!.userId, 'PASSWORD_RESET_DONE', { ip: i.ip });
  });
  return { ok: true };
}
