import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { DomainError, invalid, rejected } from './errors.js';
import { emailCodesAvailable } from './email-gateway.js';
import { decryptText, encryptText } from './field-crypto.js';
import { queueOutbox } from './lifecycle-state.js';
import { verifyPassword } from './passwords.js';
import { raiseUserAlert } from './user-notifications.js';
import { getSecurityPolicy } from './security-policy.js';

/**
 * Second factor. Three methods: an authenticator app (TOTP, RFC 6238), a code by SMS, or a code by e-mail (only while e-mail codes are available, see availableMfaMethods). Recovery codes cover a lost phone.
 * Secrets are encrypted at rest, codes and recovery codes are stored as hashes, every code works once, and a challenge locks after a few wrong tries.
 */
export type MfaKind = 'TOTP' | 'SMS' | 'EMAIL';
export const MFA_KINDS: MfaKind[] = ['TOTP', 'SMS', 'EMAIL'];
const MAX_TRIES = 5;
/** Resending a sign-in code, the same on the CRM and the fibre hub: a code by one method at most every 30 seconds, 5 codes per sign-in, 10 per account per hour. */
export const CODE_RESEND_SECONDS = 30, CODES_PER_SIGN_IN = 5, CODES_PER_ACCOUNT_HOUR = 10;
export class CodeThrottled extends DomainError {
  constructor(public readonly retryAfterSeconds: number, message: string) { super('RATE_LIMITED', message); this.name = 'CodeThrottled'; }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ───────────────────────── TOTP (RFC 6238 over RFC 4226, SHA-1, 6 digits, 30 s) ─────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(b: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of b) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export const totpCounter = (nowMs = Date.now(), step = 30) => Math.floor(nowMs / 1000 / step);
/** The counter a code belongs to (within one step either side of now) and later than `after`, or null. A code cannot be used twice. */
export function verifyTotp(secretB32: string, code: string, after: number, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32), now = totpCounter(nowMs);
  for (const c of [now, now - 1, now + 1]) if (c > after && eq(hotp(secret, c), code)) return c;
  return null;
}
export const otpauthUri = (secretB32: string, account: string, issuer = 'Meridian') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ───────────────────────── what a person has set up ─────────────────────────
export interface MfaStatus { methods: Array<{ kind: MfaKind; confirmedAt: string }>; recoveryCodesLeft: number; pendingTotp: boolean }
export async function mfaStatus(q: Queryable, userId: string): Promise<MfaStatus> {
  const m = (await q.query('SELECT kind, confirmed_at FROM mfa_methods WHERE user_id=$1', [userId])).rows;
  const left = (await q.query('SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL', [userId])).rows[0]!.n as number;
  return { methods: m.filter((x) => x.confirmedAt).map((x) => ({ kind: x.kind as MfaKind, confirmedAt: String(x.confirmedAt) })), recoveryCodesLeft: left, pendingTotp: m.some((x) => x.kind === 'TOTP' && !x.confirmedAt) };
}
export const confirmedKinds = async (q: Queryable, userId: string): Promise<MfaKind[]> =>
  (await q.query('SELECT kind FROM mfa_methods WHERE user_id=$1 AND confirmed_at IS NOT NULL ORDER BY kind', [userId])).rows.map((r) => r.kind as MfaKind);

/** The methods people can use right now: the policy's, without e-mail unless e-mail codes are switched on and an e-mail sender is enabled (Settings → Security policy, Integration). */
export async function availableMfaMethods(q: Queryable, policy?: Awaited<ReturnType<typeof getSecurityPolicy>>): Promise<MfaKind[]> {
  const p = policy ?? (await getSecurityPolicy(q));
  return p.mfa.methods.includes('EMAIL') && !(await emailCodesAvailable(q)) ? p.mfa.methods.filter((m) => m !== 'EMAIL') : p.mfa.methods;
}
async function requireAllowed(q: Queryable, kind: MfaKind) {
  if (!(await availableMfaMethods(q)).includes(kind)) throw rejected(kind === 'EMAIL' ? 'Codes by e-mail are not available here.' : 'That second-factor method is not enabled here.');
}

/** Recovery codes: ten, shown once. Replaces any earlier set. */
export async function newRecoveryCodes(q: Queryable, userId: string): Promise<string[]> {
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
  const codes = Array.from({ length: 10 }, () => { const a = randomBytes(5).toString('hex'); return `${a.slice(0, 5)}-${a.slice(5)}`; });
  for (const c of codes) await q.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [userId, sha(`${userId}:${c}`)]);
  return codes;
}
/** Uses a recovery code if it is valid and unused. */
export async function useRecoveryCode(q: Queryable, userId: string, code: string): Promise<boolean> {
  const r = await q.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE id = (SELECT id FROM mfa_recovery_codes WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL LIMIT 1) RETURNING id`, [userId, sha(`${userId}:${code.trim().toLowerCase()}`)]);
  return !!r.rowCount;
}

// ───────────────────────── setting up an authenticator app ─────────────────────────
export async function beginTotp(q: Queryable, u: { id: string; username: string }, issuer = 'Meridian') {
  await requireAllowed(q, 'TOTP');
  if ((await confirmedKinds(q, u.id)).includes('TOTP')) throw invalid('An authenticator app is already set up. Remove it first to set up a new one.');
  const secret = base32Encode(randomBytes(20));
  await q.query(`INSERT INTO mfa_methods (user_id, kind, secret_enc) VALUES ($1,'TOTP',$2) ON CONFLICT (user_id, kind) DO UPDATE SET secret_enc=EXCLUDED.secret_enc, confirmed_at=NULL, last_counter=0`, [u.id, encryptText(secret)]);
  const uri = otpauthUri(secret, u.username, issuer);
  return { secret, otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
}
/** The first valid code proves the app is set up. Returns recovery codes when this is the person's first second factor. */
export async function confirmTotp(q: Queryable, u: { id: string; username: string }, code: string): Promise<{ recoveryCodes?: string[] }> {
  const m = (await q.query(`SELECT * FROM mfa_methods WHERE user_id=$1 AND kind='TOTP' AND confirmed_at IS NULL`, [u.id])).rows[0];
  if (!m) throw invalid('Start the authenticator setup first.');
  const c = verifyTotp(decryptText(m.secretEnc), (code ?? '').replace(/\s/g, ''), 0);
  if (c === null) throw rejected('That code is not right. Check the time on your phone and try the next code.');
  const first = (await confirmedKinds(q, u.id)).length === 0;
  await q.query(`UPDATE mfa_methods SET confirmed_at = now(), last_counter=$2 WHERE user_id=$1 AND kind='TOTP'`, [u.id, c]);
  await audit(q, u.username, 'user', u.id, 'MFA_ENABLED', { kind: 'TOTP' });
  await raiseUserAlert(q, { id: u.id }, 'securityAlerts', { title: 'Second factor changed', body: 'An authenticator app was added as a second factor on your account. If this was not you, change your password and contact your administrator.', link: '/profile?tab=security' });
  return first ? { recoveryCodes: await newRecoveryCodes(q, u.id) } : {};
}

// ───────────────────────── codes by SMS or e-mail ─────────────────────────
const codeOf = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
async function sendCode(q: Queryable, u: { id: string; name: string; email: string | null; phone: string | null }, kind: 'SMS' | 'EMAIL', purpose: 'LOGIN' | 'ENROL', minutes: number): Promise<string> {
  if (kind === 'EMAIL' && !(await emailCodesAvailable(q))) throw rejected('Codes by e-mail are not available here.');
  const to = kind === 'SMS' ? u.phone : u.email;
  if (!to) throw invalid(kind === 'SMS' ? 'Add your mobile number to your profile first.' : 'Add your e-mail address to your profile first.');
  const code = codeOf();
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  await queueOutbox(q, { kind: 'NOTIFY', instruction: 'MFA_OTP', payload: { channel: kind, to, name: u.name, code, purpose, expiresAt: expiresAt.toISOString() } });
  return JSON.stringify({ hash: sha(`${u.id}:${kind}:${code}`), expiresAt });
}
/** Sends a code to the number or address on the account, to prove it is theirs and switch the method on. */
export async function beginOtpMethod(q: Queryable, u: { id: string; name: string; email: string | null; phone: string | null }, kind: 'SMS' | 'EMAIL') {
  await requireAllowed(q, kind);
  if ((await confirmedKinds(q, u.id)).includes(kind)) throw invalid('That method is already on.');
  const p = await getSecurityPolicy(q);
  const sent = JSON.parse(await sendCode(q, u, kind, 'ENROL', p.mfa.challengeMinutes));
  await q.query(`UPDATE mfa_challenges SET used_at = now() WHERE user_id=$1 AND purpose='ENROL' AND used_at IS NULL`, [u.id]);
  await q.query(`INSERT INTO mfa_challenges (user_id, purpose, token_hash, code_hash, code_kind, expires_at) VALUES ($1,'ENROL',$2,$3,$4,$5)`, [u.id, sha(randomBytes(16).toString('hex')), sent.hash, kind, sent.expiresAt]);
  return { sentTo: kind === 'SMS' ? mask(u.phone!) : mask(u.email!) };
}
export async function confirmOtpMethod(q: Queryable, u: { id: string; username: string }, kind: 'SMS' | 'EMAIL', code: string): Promise<{ recoveryCodes?: string[] }> {
  const ch = (await q.query(`SELECT * FROM mfa_challenges WHERE user_id=$1 AND purpose='ENROL' AND code_kind=$2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, [u.id, kind])).rows[0];
  const bad = rejected('That code is not right or has expired. Ask for a new one.');
  if (!ch || new Date(ch.expiresAt).getTime() < Date.now() || ch.attempts >= MAX_TRIES) throw bad;
  await q.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id=$1', [ch.id]);
  if (!/^\d{6}$/.test(code ?? '') || !eq(ch.codeHash, sha(`${u.id}:${kind}:${code}`))) throw bad;
  const first = (await confirmedKinds(q, u.id)).length === 0;
  await q.query('UPDATE mfa_challenges SET used_at = now() WHERE id=$1', [ch.id]);
  await q.query(`INSERT INTO mfa_methods (user_id, kind, confirmed_at) VALUES ($1,$2,now()) ON CONFLICT (user_id, kind) DO UPDATE SET confirmed_at = now()`, [u.id, kind]);
  await audit(q, u.username, 'user', u.id, 'MFA_ENABLED', { kind });
  await raiseUserAlert(q, { id: u.id }, 'securityAlerts', { title: 'Second factor changed', body: `A code by ${kind === 'SMS' ? 'SMS' : 'e-mail'} was added as a second factor on your account. If this was not you, change your password and contact your administrator.`, link: '/profile?tab=security' });
  return first ? { recoveryCodes: await newRecoveryCodes(q, u.id) } : {};
}
const mask = (s: string) => (s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1•••$2') : `${s.slice(0, 3)}•••${s.slice(-2)}`);

// ───────────────────────── turning methods off, and new recovery codes ─────────────────────────
async function confirmPassword(q: Queryable, userId: string, password: string) {
  const row = (await q.query('SELECT password_hash FROM users WHERE id=$1', [userId])).rows[0];
  if (!row?.passwordHash || !(await verifyPassword(password ?? '', row.passwordHash))) throw rejected('The password is not right.');
}
/** Turns a method off after the password is confirmed. When the policy makes a second factor compulsory for this person, the last one stays. */
export async function disableMethod(q: Queryable, u: { id: string; username: string }, kind: MfaKind, password: string, required: boolean) {
  await confirmPassword(q, u.id, password);
  const have = await confirmedKinds(q, u.id);
  if (required && have.length === 1 && have[0] === kind) throw rejected('A second factor is required for your role, so you cannot remove your last one. Add another first.');
  await q.query('DELETE FROM mfa_methods WHERE user_id=$1 AND kind=$2', [u.id, kind]);
  if (!(await confirmedKinds(q, u.id)).length) await q.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [u.id]);
  await audit(q, u.username, 'user', u.id, 'MFA_DISABLED', { kind });
  await raiseUserAlert(q, { id: u.id }, 'securityAlerts', { title: 'Second factor changed', body: 'A second factor was removed from your account. If this was not you, change your password and contact your administrator.', link: '/profile?tab=security' });
}
export async function regenerateRecoveryCodes(q: Queryable, u: { id: string; username: string }, password: string): Promise<string[]> {
  await confirmPassword(q, u.id, password);
  if (!(await confirmedKinds(q, u.id)).length) throw invalid('Turn on a second factor first.');
  await audit(q, u.username, 'user', u.id, 'MFA_RECOVERY_CODES_REISSUED');
  await raiseUserAlert(q, { id: u.id }, 'securityAlerts', { title: 'Second factor changed', body: 'New recovery codes were issued for your account and the old ones no longer work. If this was not you, change your password and contact your administrator.', link: '/profile?tab=security' });
  return newRecoveryCodes(q, u.id);
}
/** An administrator removes a person's second factors (a lost phone with no recovery codes left). */
export async function resetMfa(q: Queryable, actor: string, userId: string) {
  await q.query('DELETE FROM mfa_methods WHERE user_id=$1', [userId]);
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
  await audit(q, actor, 'user', userId, 'MFA_RESET_BY_ADMIN');
  await raiseUserAlert(q, { id: userId }, 'securityAlerts', { title: 'Second factor changed', body: 'An administrator removed your second factors. Set one up again from My profile, Security.', link: '/profile?tab=security' });
}

// ───────────────────────── the sign-in step ─────────────────────────
export interface LoginChallenge { token: string; methods: MfaKind[]; method: MfaKind; sentTo?: string; resendAfterSeconds?: number }
/** Opens the step between a correct password and a session. If the preferred method is SMS or e-mail, its code is sent now. */
export async function openLoginChallenge(q: Queryable, u: { id: string; name: string; email: string | null; phone: string | null }, ctx: { ip?: string; userAgent?: string }): Promise<LoginChallenge> {
  const p = await getSecurityPolicy(q);
  const allowed = await availableMfaMethods(q, p);
  const methods = (await confirmedKinds(q, u.id)).filter((k) => allowed.includes(k));
  if (!methods.length) throw rejected('Your second-factor methods are not available. Ask an administrator to reset them.');
  const method = methods.includes('TOTP') ? 'TOTP' : methods[0]!;
  const token = randomBytes(32).toString('base64url');
  let codeHash: string | null = null, expires = new Date(Date.now() + p.mfa.challengeMinutes * 60_000);
  let sentTo: string | undefined;
  if (method !== 'TOTP') { const sent = JSON.parse(await sendCode(q, u, method, 'LOGIN', p.mfa.challengeMinutes)); codeHash = sent.hash; expires = new Date(sent.expiresAt); sentTo = mask(method === 'SMS' ? u.phone! : u.email!); }
  await q.query(`INSERT INTO mfa_challenges (user_id, purpose, token_hash, code_hash, code_kind, expires_at, ip, user_agent) VALUES ($1,'LOGIN',$2,$3,$4,$5,$6,$7)`,
    [u.id, sha(token), codeHash, codeHash ? method : null, expires.toISOString(), ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null]);
  if (codeHash) await noteSend(q, token, u.id, method);
  return { token, methods, method, sentTo, ...(codeHash ? { resendAfterSeconds: CODE_RESEND_SECONDS } : {}) };
}
// Sends are counted in auth_attempts (swept daily with the sign-in failures): per sign-in and method, per sign-in, and per account.
const sendPrefix = (token: string) => `mfa-send:${sha(token).slice(0, 24)}:`;
const noteSend = async (q: Queryable, token: string, userId: string, kind: MfaKind) => { for (const k of [`${sendPrefix(token)}${kind}`, `mfa-send:user:${userId}`]) await q.query('INSERT INTO auth_attempts (key) VALUES ($1)', [k]); };
async function checkSendRules(q: Queryable, token: string, userId: string, kind: MfaKind) {
  const r = (await q.query(
    `SELECT (SELECT count(*)::int FROM auth_attempts WHERE key LIKE $1) AS sign_in,
            (SELECT count(*)::int FROM auth_attempts WHERE key=$3 AND at > now() - interval '1 hour') AS account,
            (SELECT extract(epoch FROM now() - max(at))::float FROM auth_attempts WHERE key=$2) AS since`, [`${sendPrefix(token)}%`, `${sendPrefix(token)}${kind}`, `mfa-send:user:${userId}`])).rows[0]!;
  if (r.since !== null && r.since < CODE_RESEND_SECONDS) throw new CodeThrottled(Math.max(1, Math.ceil(CODE_RESEND_SECONDS - r.since)), 'A code was just sent. Wait a moment before asking for another.');
  if (r.signIn >= CODES_PER_SIGN_IN) throw new CodeThrottled(300, 'Too many codes were sent for this sign-in. Sign in again, or use your authenticator app or a recovery code.');
  if (r.account >= CODES_PER_ACCOUNT_HOUR) throw new CodeThrottled(600, 'Too many codes were sent to this account lately. Try again later, or use your authenticator app or a recovery code.');
}
/** Sends a code for another method (the person chose "text me instead"), or sends the same one again. Throttled (see CODE_RESEND_SECONDS) and refused for a locked or disabled account. */
export async function sendChallengeCode(q: Queryable, challengeToken: string, kind: 'SMS' | 'EMAIL'): Promise<{ sentTo: string; resendAfterSeconds: number }> {
  const ch = (await q.query(`SELECT c.*, u.display_name, u.email, u.phone, u.status AS user_status, u.locked_until FROM mfa_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.purpose='LOGIN' AND c.used_at IS NULL`, [sha(challengeToken ?? '')])).rows[0];
  if (!ch || new Date(ch.expiresAt).getTime() < Date.now() || ch.userStatus !== 'ACTIVE') throw rejected('This sign-in has expired. Sign in again.');
  if (ch.lockedUntil && new Date(ch.lockedUntil) > new Date()) throw rejected('This account is locked. Try again later or ask an administrator.');
  const p = await getSecurityPolicy(q);
  if (!(await confirmedKinds(q, ch.userId)).includes(kind) || !(await availableMfaMethods(q, p)).includes(kind)) throw invalid('That method is not set up.');
  await checkSendRules(q, challengeToken, ch.userId, kind);
  const sent = JSON.parse(await sendCode(q, { id: ch.userId, name: ch.displayName, email: ch.email, phone: ch.phone }, kind, 'LOGIN', p.mfa.challengeMinutes));
  await q.query('UPDATE mfa_challenges SET code_hash=$2, code_kind=$3, attempts=0 WHERE id=$1', [ch.id, sent.hash, kind]);
  await noteSend(q, challengeToken, ch.userId, kind);
  return { sentTo: mask(kind === 'SMS' ? ch.phone : ch.email), resendAfterSeconds: CODE_RESEND_SECONDS };
}
/** The raw number or address the pending sign-in's code went to, for the server that hands it to the gateway. Never send this to a browser (the browser gets the masked `sentTo`). */
export async function challengeRecipient(q: Queryable, challengeToken: string): Promise<string | null> {
  const r = (await q.query(`SELECT c.code_kind, u.email, u.phone FROM mfa_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.purpose='LOGIN' AND c.used_at IS NULL AND c.expires_at > now()`, [sha(challengeToken ?? '')])).rows[0];
  return r?.codeKind === 'SMS' ? r.phone ?? null : r?.codeKind === 'EMAIL' ? r.email ?? null : null;
}
/** Checks the second factor for a pending sign-in. Returns the user's id when it is right; the challenge is then spent. */
export async function checkChallenge(q: Queryable, i: { token: string; code?: string; recoveryCode?: string }): Promise<{ userId: string; ip: string | null; userAgent: string | null; usedRecovery: boolean }> {
  const bad = rejected('That code is not right or has expired.');
  const ch = (await q.query(`SELECT * FROM mfa_challenges WHERE token_hash=$1 AND purpose='LOGIN' AND used_at IS NULL`, [sha(i.token ?? '')])).rows[0];
  if (!ch || new Date(ch.expiresAt).getTime() < Date.now() || ch.attempts >= MAX_TRIES) throw bad;
  await q.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id=$1', [ch.id]);
  let ok = false, usedRecovery = false;
  if (i.recoveryCode) { ok = await useRecoveryCode(q, ch.userId, i.recoveryCode); usedRecovery = ok; }
  else if (i.code && /^\d{6}$/.test(i.code.replace(/\s/g, ''))) {
    const code = i.code.replace(/\s/g, '');
    if (ch.codeHash && ch.codeKind && eq(ch.codeHash, sha(`${ch.userId}:${ch.codeKind}:${code}`))) ok = true;
    else {
      const m = (await q.query(`SELECT * FROM mfa_methods WHERE user_id=$1 AND kind='TOTP' AND confirmed_at IS NOT NULL`, [ch.userId])).rows[0];
      if (m) { const c = verifyTotp(decryptText(m.secretEnc), code, Number(m.lastCounter)); if (c !== null) { await q.query(`UPDATE mfa_methods SET last_counter=$2 WHERE user_id=$1 AND kind='TOTP' AND last_counter < $2`, [ch.userId, c]); ok = true; } }
    }
  }
  if (!ok) throw bad;
  await q.query('UPDATE mfa_challenges SET used_at = now() WHERE id=$1', [ch.id]);
  return { userId: ch.userId, ip: ch.ip, userAgent: ch.userAgent, usedRecovery };
}
