import { createHash, randomBytes } from 'node:crypto';
import { audit } from './audit.js';
import type { SessionUser } from './auth.js';
import type { Db, Queryable } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { verifyPassword } from './passwords.js';

/**
 * "My profile": what a person keeps about themselves (name, e-mail, mobile, picture, which alerts reach them), the devices they are signed in on,
 * and a way to refresh their session. Changing the e-mail address or mobile number asks for the password, because both are used to recover the account.
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface NotificationPrefs {
  channels: { email: boolean; sms: boolean; push: boolean };
  events: { caseAssigned: boolean; caseUpdates: boolean; systemAlerts: boolean; securityAlerts: boolean };
}
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { channels: { email: true, sms: false, push: true }, events: { caseAssigned: true, caseUpdates: true, systemAlerts: true, securityAlerts: true } };
export const notificationPrefs = (stored: unknown): NotificationPrefs => {
  const v = (stored ?? {}) as Partial<NotificationPrefs>;
  return { channels: { ...DEFAULT_NOTIFICATION_PREFS.channels, ...(v.channels ?? {}) }, events: { ...DEFAULT_NOTIFICATION_PREFS.events, ...(v.events ?? {}) } };
};

export async function getProfile(q: Queryable, u: SessionUser) {
  const r = (await q.query('SELECT * FROM users WHERE id=$1', [u.id])).rows[0];
  if (!r) throw notFound('user', u.id);
  const store = u.storeId ? (await q.query('SELECT name FROM stores WHERE id=$1', [u.storeId])).rows[0]?.name ?? null : null;
  const dealer = u.dealerId ? (await q.query('SELECT name FROM dealers WHERE id=$1', [u.dealerId])).rows[0]?.name ?? null : null;
  return {
    id: r.id, username: r.username, displayName: r.displayName, email: r.email ?? null, phone: r.phone ?? null, avatar: r.avatar ?? null, isSuperuser: !!r.isSuperuser,
    roles: u.roleLabels, passwordChangedAt: r.passwordChangedAt ?? null, lastLoginAt: r.lastLoginAt ?? null,
    // The organisation node is set by an administrator and shown read-only.
    organisation: { storeId: u.storeId, storeName: store, dealerId: u.dealerId, dealerName: dealer },
    notificationPrefs: notificationPrefs(r.notificationPrefs),
  };
}

const AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export interface ProfileUpdate { displayName?: string; email?: string | null; phone?: string | null; avatar?: string | null; notificationPrefs?: Partial<NotificationPrefs>; currentPassword?: string }

export async function updateProfile(db: Db, u: SessionUser, p: ProfileUpdate) {
  if (u.isSuperuser) throw rejected('The super user has no profile in the database. Its name and password are set in the environment.');
  const row = (await db.query('SELECT * FROM users WHERE id=$1', [u.id])).rows[0];
  if (!row) throw notFound('user', u.id);
  const sets: string[] = [], vals: unknown[] = [u.id];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (p.displayName !== undefined) { const n = p.displayName.trim(); if (!n || n.length > 100) throw invalid('Enter your name (up to 100 characters).'); add('display_name', n); }
  const contactChanged = (p.email !== undefined && (p.email ?? null) !== (row.email ?? null)) || (p.phone !== undefined && (p.phone ?? null) !== (row.phone ?? null));
  if (contactChanged) {
    if (!p.currentPassword || !row.passwordHash || !(await verifyPassword(p.currentPassword, row.passwordHash))) throw rejected('Enter your current password to change your e-mail address or mobile number.');
    if (p.email !== undefined) { const e = p.email?.trim() || null; if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw invalid('That e-mail address does not look right.'); add('email', e); }
    if (p.phone !== undefined) { const ph = p.phone?.replace(/[\s()-]/g, '') || null; if (ph && !/^\+?\d{7,15}$/.test(ph)) throw invalid('Enter the mobile number with its country code, for example +6591234567.'); add('phone', ph); }
  }
  if (p.avatar !== undefined) {
    if (p.avatar !== null && (!AVATAR.test(p.avatar) || p.avatar.length > 200_000)) throw invalid('Use a PNG, JPEG or WebP picture of at most about 150 KB.');
    add('avatar', p.avatar);
  }
  if (p.notificationPrefs) add('notification_prefs', JSON.stringify(notificationPrefs({ channels: { ...notificationPrefs(row.notificationPrefs).channels, ...(p.notificationPrefs.channels ?? {}) }, events: { ...notificationPrefs(row.notificationPrefs).events, ...(p.notificationPrefs.events ?? {}) } })));
  if (!sets.length) return getProfile(db, u);
  await db.query(`UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
  await audit(db, u.username, 'user', u.id, 'PROFILE_UPDATED', { fields: sets.map((s) => s.split('=')[0]), contactChanged });
  return getProfile(db, u);
}

// ───────────────────────── devices and sessions ─────────────────────────
/** "Chrome on macOS" from a browser's user-agent text. */
export function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  return `${browser} on ${os}`;
}
export interface SessionView { id: string; device: string; ip: string | null; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean }
export async function listMySessions(q: Queryable, userId: string, currentToken: string | undefined): Promise<SessionView[]> {
  const cur = currentToken ? sha256(currentToken) : '';
  const rows = (await q.query(`SELECT * FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [userId])).rows;
  return rows.map((r) => ({ id: String(r.id).slice(0, 16), device: describeAgent(r.userAgent), ip: r.ip, createdAt: String(r.createdAt), lastSeenAt: String(r.lastSeenAt), expiresAt: String(r.expiresAt), current: r.id === cur }));
}
/** Signs out every other device, keeping the one in use. */
export async function revokeOtherSessions(db: Db, u: SessionUser, currentToken: string | undefined): Promise<{ revoked: number }> {
  const r = await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL AND id <> $2`, [u.id, currentToken ? sha256(currentToken) : '']);
  await audit(db, u.username, 'auth', u.id, 'SESSIONS_REVOKED_OTHERS', { count: r.rowCount });
  return { revoked: r.rowCount ?? 0 };
}
export async function revokeMySession(db: Db, u: SessionUser, publicId: string, currentToken: string | undefined): Promise<void> {
  if (!/^[0-9a-f]{16}$/.test(publicId)) throw notFound('session', publicId);
  if (currentToken && sha256(currentToken).startsWith(publicId)) throw invalid('That is the device you are using now. Sign out instead.');
  const r = await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL AND id LIKE $2`, [u.id, `${publicId}%`]);
  if (!r.rowCount) throw notFound('session', publicId);
  await audit(db, u.username, 'auth', u.id, 'SESSION_REVOKED', { device: publicId });
}

/**
 * Replaces the session's token with a fresh one (the old one stops working), keeping the same device record and the same absolute end time.
 * Used by the app to rotate the cookie without signing the person out; it never lengthens the session.
 */
export async function refreshSession(db: Db, token: string): Promise<{ token: string; expiresAt: Date }> {
  const old = sha256(token);
  const next = randomBytes(32).toString('base64url');
  return db.tx(async (q) => {
    const s = (await q.query(`SELECT * FROM sessions WHERE id=$1 AND revoked_at IS NULL FOR UPDATE`, [old])).rows[0];
    if (!s || new Date(s.expiresAt).getTime() <= Date.now()) throw rejected('Your session has ended. Sign in again.');
    await q.query(`UPDATE sessions SET revoked_at = now() WHERE id=$1`, [old]);
    await q.query(`INSERT INTO sessions (id, user_id, auth_epoch, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,now(),$5,$6,$7)`, [sha256(next), s.userId, s.authEpoch, s.createdAt, s.expiresAt, s.ip, s.userAgent]);
    return { token: next, expiresAt: new Date(s.expiresAt) };
  });
}
