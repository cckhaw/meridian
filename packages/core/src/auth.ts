import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { audit } from './audit.js';
import { effectiveMarket } from './settings.js';
import { getRoleOverrides } from './roles-config.js';
import { assertStoreUsable } from './stores.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, DomainError, invalid, notFound, rejected } from './errors.js';
import { dummyHash, hashPassword, passwordProblem, temporaryPassword, verifyPassword } from './passwords.js';
import { verifyDirectoryPassword } from './auth-providers.js';
import { checkChallenge, confirmedKinds, openLoginChallenge, type LoginChallenge } from './mfa.js';
import { checkPassword, getSecurityPolicy, idleMinutesFor, isReusedPassword, mfaRequiredFor, rememberPassword } from './security-policy.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { likePrefix } from './search.js';
import { describeAgent } from './profile.js';
import { raiseUserAlert } from './user-notifications.js';
import { creditLimitOf, homeOf, roleDef, missingBinding, modulesOf, permissionsOf, scopeOf, type NavModule, type RoleBook, type Permission, type RoleId, type Scope } from './rbac.js';

// ───────────────────────── configuration ─────────────────────────
const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export const authConfig = () => ({
  idleMinutes: num('MERIDIAN_SESSION_IDLE_MINUTES', 30),
  maxHours: num('MERIDIAN_SESSION_MAX_HOURS', 12),
  lockAfter: num('MERIDIAN_LOCK_AFTER_FAILURES', 5),
  lockMinutes: num('MERIDIAN_LOCK_MINUTES', 15),
  ipLimit: num('MERIDIAN_LOGIN_IP_LIMIT', 30),       // failed attempts per address per window
  userLimit: num('MERIDIAN_LOGIN_USER_LIMIT', 10),   // failed attempts per username per window
  windowMinutes: 15,
});

export interface SuperuserConfig { username: string; password: string }
/** The super user lives in the environment, never in the database. Returns null (disabled) unless both values are usable. */
export function superuserConfig(): SuperuserConfig | null {
  const username = process.env.MERIDIAN_SUPERUSER_USERNAME?.trim();
  const password = process.env.MERIDIAN_SUPERUSER_PASSWORD;
  if (!username || !password) return null;
  if (username.length < 3 || passwordProblem(password, username)) return null;
  return { username, password };
}
export function superuserProblem(): string | null {
  const username = process.env.MERIDIAN_SUPERUSER_USERNAME?.trim();
  const password = process.env.MERIDIAN_SUPERUSER_PASSWORD;
  if (!username && !password) return 'MERIDIAN_SUPERUSER_USERNAME and MERIDIAN_SUPERUSER_PASSWORD are not set';
  if (!username || username.length < 3) return 'MERIDIAN_SUPERUSER_USERNAME must be at least 3 characters';
  const p = passwordProblem(password ?? '', username);
  return p ? `MERIDIAN_SUPERUSER_PASSWORD is not acceptable: ${p}` : null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string) => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };
/** Changes whenever the super-user credentials change, which invalidates their sessions. */
const epochOf = (c: SuperuserConfig) => sha256(`${c.username}\u0000${c.password}`).slice(0, 24);
const superuserId = (username: string) => { const h = sha256(`meridian-superuser:${username.toLowerCase()}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

// ───────────────────────── the authenticated user ─────────────────────────
export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  isSuperuser: boolean;
  roles: RoleId[];
  mustChangePassword: boolean;
  /** The security policy requires a second factor for this person and they have not set one up yet: they can only reach My profile until they do. */
  mfaEnrollRequired: boolean;
  storeId: string | null;
  dealerId: string | null;
  customerId: string | null;
  marketCode: string;
  permissions: Set<Permission>;
  scope: Scope;
  creditLimitMinor: number | null;
  roleLabels: string[];
  home: string;
  modules: NavModule[];
}

function toUser(r: Row, book: RoleBook): SessionUser {
  const roles = (r.roles as string[]).filter((x) => !!roleDef(x, book)); // a role that no longer exists grants nothing
  const base = { isSuperuser: r.isSuperuser as boolean, roles, customerId: r.customerId, storeId: r.storeId, dealerId: r.dealerId };
  const permissions = permissionsOf(base, book);
  return {
    id: r.id, username: r.username, displayName: r.displayName, email: r.email, isSuperuser: base.isSuperuser, roles,
    mustChangePassword: r.mustChangePassword, mfaEnrollRequired: false, storeId: r.storeId, dealerId: r.dealerId, customerId: r.customerId, marketCode: (r.marketCode ?? 'SG').trim(),
    permissions, scope: scopeOf(base, book), creditLimitMinor: creditLimitOf(base, book),
    roleLabels: base.isSuperuser ? ['Super user'] : roles.map((x) => roleDef(x, book)!.label), home: homeOf(base, book), modules: modulesOf(base, permissions, book),
  };
}

/** What the browser is told about the signed-in user (never includes hashes). */
export function publicUser(u: SessionUser): {
  id: string; username: string; displayName: string; isSuperuser: boolean; roles: RoleId[]; roleLabels: string[]; permissions: Permission[]; modules: NavModule[]; home: string;
  mustChangePassword: boolean; mfaEnrollRequired: boolean; storeId: string | null; dealerId: string | null; customerId: string | null; marketCode: string; creditLimitMinor: number | null;
} {
  return {
    id: u.id, username: u.username, displayName: u.displayName, isSuperuser: u.isSuperuser, roles: u.roles, roleLabels: u.roleLabels, permissions: [...u.permissions], modules: u.modules,
    home: u.mustChangePassword ? '/change-password' : u.mfaEnrollRequired ? '/profile?setup=mfa' : u.home, mustChangePassword: u.mustChangePassword, mfaEnrollRequired: u.mfaEnrollRequired, storeId: u.storeId, dealerId: u.dealerId,
    customerId: u.customerId, marketCode: u.marketCode, creditLimitMinor: u.creditLimitMinor,
  };
}

export const can = (u: SessionUser, p: Permission) => u.permissions.has(p);
export const canAny = (u: SessionUser, ps: Permission[]) => ps.some((p) => u.permissions.has(p));

// ───────────────────────── login ─────────────────────────
export interface LoginResult { token: string; user: SessionUser; expiresAt: Date }
export class RateLimited extends DomainError {
  constructor(public readonly retryAfterSeconds: number) { super('RATE_LIMITED', 'Too many sign-in attempts. Try again later.'); this.name = 'RateLimited'; }
}
/** The password was right but a second factor is needed: the browser is given a short-lived challenge instead of a session. */
export class MfaRequired extends DomainError {
  constructor(public readonly challenge: LoginChallenge) { super('UNAUTHENTICATED', 'Enter your second-factor code to finish signing in.'); this.name = 'MfaRequired'; }
}
const BAD_LOGIN = 'Incorrect username or password.';

async function failures(q: Queryable, key: string, windowMin: number): Promise<number> {
  return (await q.query(`SELECT count(*) AS n FROM auth_attempts WHERE key=$1 AND at > now() - ($2 || ' minutes')::interval`, [key, String(windowMin)])).rows[0]!.n as number;
}
const recordFailure = (q: Queryable, ...keys: string[]) => Promise.all(keys.map((k) => q.query('INSERT INTO auth_attempts (key) VALUES ($1)', [k])));

async function ensureSuperuserRow(q: Queryable, su: SuperuserConfig): Promise<Row> {
  const id = superuserId(su.username);
  await q.query(
    `INSERT INTO users (id, username, display_name, roles, is_superuser, status, created_by) VALUES ($1,$2,'Super user','{}',true,'ACTIVE','environment')
     ON CONFLICT (id) DO UPDATE SET status='ACTIVE', username=EXCLUDED.username`, [id, su.username]);
  // Only the environment-defined super user may exist: a renamed one leaves its old row disabled and its sessions revoked.
  await q.query(`UPDATE sessions SET revoked_at = now() WHERE user_id IN (SELECT id FROM users WHERE is_superuser AND id <> $1) AND revoked_at IS NULL`, [id]);
  await q.query(`UPDATE users SET status='DISABLED' WHERE is_superuser AND id <> $1`, [id]);
  return (await q.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]!;
}

async function openSession(q: Queryable, userId: string, epoch: string, ip?: string, ua?: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (await getSecurityPolicy(q)).session.absoluteHours * 3_600_000);
  await q.query(`INSERT INTO sessions (id, user_id, auth_epoch, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(token), userId, epoch, expiresAt.toISOString(), ip ?? null, ua?.slice(0, 300) ?? null]);
  return { token, expiresAt };
}

/** A sign-in from a browser or device this person has not signed in from before (their very first sign-in does not count). */
async function isNewDevice(q: Queryable, userId: string, ua?: string): Promise<boolean> {
  try { return await seenBefore(q, userId, ua); } catch { return false; }
}
async function seenBefore(q: Queryable, userId: string, ua?: string): Promise<boolean> {
  const rows = (await q.query('SELECT DISTINCT user_agent FROM sessions WHERE user_id=$1', [userId])).rows;
  return rows.length > 0 && !rows.some((r) => describeAgent(r.userAgent) === describeAgent(ua ?? null));
}
const signInAlert = (db: Db, u: Row, ip?: string, ua?: string) =>
  raiseUserAlert(db, { id: u.id as string }, 'securityAlerts', { title: 'New sign-in', body: `Your account was signed in from ${describeAgent(ua ?? null)}${ip ? ` (address ${ip})` : ''} on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. If this was not you, change your password now.`, link: '/profile?tab=security' });

export async function login(db: Db, i: { username: string; password: string; ip?: string; userAgent?: string }): Promise<LoginResult> {
  const cfg = authConfig();
  const policy = await getSecurityPolicy(db);
  const username = i.username.trim();
  const ukey = `user:${username.toLowerCase()}`, ikey = `ip:${i.ip ?? 'unknown'}`;
  if (!username || !i.password || i.password.length > 1024 || username.length > 100) throw rejected(BAD_LOGIN);

  // Throttle before doing any expensive work (and before revealing whether the account exists).
  if ((await failures(db, ikey, cfg.windowMinutes)) >= cfg.ipLimit || (await failures(db, ukey, cfg.windowMinutes)) >= cfg.userLimit) {
    await audit(db, username, 'auth', username, 'LOGIN_THROTTLED', { ip: i.ip });
    throw new RateLimited(cfg.windowMinutes * 60);
  }
  void db.query(`DELETE FROM auth_attempts WHERE at < now() - interval '1 day'`).catch(() => {});

  const su = superuserConfig();
  // ── environment-defined super user ──
  if (su && safeEq(username.toLowerCase(), su.username.toLowerCase())) {
    if (!safeEq(i.password, su.password)) {
      await recordFailure(db, ikey, ukey);
      await audit(db, username, 'auth', username, 'LOGIN_FAILED', { ip: i.ip, superuser: true });
      throw rejected(BAD_LOGIN);
    }
    return db.tx(async (q) => {
      const row = await ensureSuperuserRow(q, su);
      await q.query('UPDATE users SET last_login_at = now() WHERE id=$1', [row.id]);
      const { token, expiresAt } = await openSession(q, row.id, epochOf(su), i.ip, i.userAgent);
      await audit(q, row.username, 'auth', row.id, 'LOGIN', { ip: i.ip, superuser: true });
      return { token, user: toUser({ ...row, mustChangePassword: false }, await getRoleOverrides(q)), expiresAt };
    });
  }

  // ── database users ──
  const row = (await db.query('SELECT * FROM users WHERE lower(username)=lower($1) AND NOT is_superuser', [username])).rows[0];
  const ok = row?.authSource === 'LDAP' ? await verifyDirectoryPassword(db, row, i.password)   // directory users prove themselves to the directory
    : await verifyPassword(i.password, row?.passwordHash ?? (await dummyHash()));   // always one hash verification
  if (!row || !ok || row.status !== 'ACTIVE') {
    await recordFailure(db, ikey, ukey);
    if (row && row.status === 'ACTIVE') await registerFailure(db, row, policy);
    await audit(db, username, 'auth', row?.id ?? username, 'LOGIN_FAILED', { ip: i.ip });
    throw rejected(BAD_LOGIN);
  }
  if (row.lockedUntil && new Date(row.lockedUntil) > new Date()) {
    await audit(db, username, 'auth', row.id, 'LOGIN_BLOCKED_LOCKED', { ip: i.ip });
    throw rejected(`This account is locked after repeated failures. Try again after ${new Date(row.lockedUntil).toISOString().slice(11, 16)} UTC or ask an administrator to unlock it.`);
  }
  // A second factor, when the person has set one up, comes before any session is opened.
  if ((await confirmedKinds(db, row.id)).length) {
    const challenge = await openLoginChallenge(db, { id: row.id, name: row.displayName, email: row.email, phone: row.phone }, { ip: i.ip, userAgent: i.userAgent });
    await audit(db, row.username, 'auth', row.id, 'LOGIN_MFA_CHALLENGE', { ip: i.ip, method: challenge.method });
    throw new MfaRequired(challenge);
  }
  // A password older than the policy allows must be changed before anything else can be done.
  const age = policy.password.maxAgeDays;
  const expired = age > 0 && Date.now() - new Date(row.passwordChangedAt ?? row.createdAt).getTime() > age * 86_400_000;
  const fresh = await isNewDevice(db, row.id, i.userAgent);
  const res = await db.tx(async (q) => {
    await q.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now(), must_change_password = must_change_password OR $2 WHERE id=$1`, [row.id, expired]);
    const { token, expiresAt } = await openSession(q, row.id, '', i.ip, i.userAgent);
    await audit(q, row.username, 'auth', row.id, expired ? 'LOGIN_PASSWORD_EXPIRED' : 'LOGIN', { ip: i.ip });
    const user = toUser({ ...row, mustChangePassword: row.mustChangePassword || expired }, await getRoleOverrides(q));
    user.mfaEnrollRequired = mfaRequiredFor(policy, user.roles);
    return { token, user, expiresAt };
  });
  if (fresh) await signInAlert(db, row, i.ip, i.userAgent);
  return res;
}

/** Opens a session for someone the identity provider has already authenticated. The provider is the authority (and its own second factor), so no local one is asked for. */
export async function openFederatedSession(db: Db, userId: string, via: string, i: { ip?: string; userAgent?: string } = {}): Promise<LoginResult> {
  const row = (await db.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
  if (!row || row.status !== 'ACTIVE' || row.isSuperuser) throw rejected(BAD_LOGIN);
  const fresh = await isNewDevice(db, row.id, i.userAgent);
  const res = await db.tx(async (q) => {
    await q.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [row.id]);
    const { token, expiresAt } = await openSession(q, row.id, '', i.ip, i.userAgent);
    await audit(q, row.username, 'auth', row.id, 'LOGIN_SSO', { ip: i.ip, via });
    const user = toUser({ ...row, mustChangePassword: false }, await getRoleOverrides(q));
    user.mfaEnrollRequired = false;
    return { token, user, expiresAt };
  });
  if (fresh) await signInAlert(db, row, i.ip, i.userAgent);
  return res;
}

/** Second step of a sign-in: the code (app, SMS or e-mail) or a recovery code, against the challenge the first step returned. */
export async function verifyMfaLogin(db: Db, i: { challenge: string; code?: string; recoveryCode?: string; ip?: string; userAgent?: string }): Promise<LoginResult> {
  const cfg = authConfig();
  const ikey = `ip:${i.ip ?? 'unknown'}`;
  if ((await failures(db, `mfa:${ikey}`, cfg.windowMinutes)) >= cfg.userLimit * 3) throw new RateLimited(cfg.windowMinutes * 60);
  let r;
  try { r = await checkChallenge(db, { token: i.challenge, code: i.code, recoveryCode: i.recoveryCode }); }
  catch (e) { await recordFailure(db, `mfa:${ikey}`); throw e; }
  const row = (await db.query('SELECT * FROM users WHERE id=$1', [r.userId])).rows[0];
  if (!row || row.status !== 'ACTIVE') throw rejected(BAD_LOGIN);
  if (row.lockedUntil && new Date(row.lockedUntil) > new Date()) throw rejected('This account is locked. Try again later or ask an administrator.');
  const policy = await getSecurityPolicy(db);
  const age = policy.password.maxAgeDays;
  const expired = age > 0 && Date.now() - new Date(row.passwordChangedAt ?? row.createdAt).getTime() > age * 86_400_000;
  const ip = i.ip ?? r.ip ?? undefined, ua = i.userAgent ?? r.userAgent ?? undefined;
  const fresh = await isNewDevice(db, row.id, ua);
  const res = await db.tx(async (q) => {
    await q.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now(), must_change_password = must_change_password OR $2 WHERE id=$1`, [row.id, expired]);
    const { token, expiresAt } = await openSession(q, row.id, '', ip, ua);
    await audit(q, row.username, 'auth', row.id, r.usedRecovery ? 'LOGIN_MFA_RECOVERY_CODE' : 'LOGIN_MFA', { ip: i.ip });
    const user = toUser({ ...row, mustChangePassword: row.mustChangePassword || expired }, await getRoleOverrides(q));
    user.mfaEnrollRequired = false;
    return { token, user, expiresAt };
  });
  if (fresh) await signInAlert(db, row, ip, ua);
  return res;
}

async function registerFailure(db: Queryable, row: Row, policy: Awaited<ReturnType<typeof getSecurityPolicy>>) {
  const n = row.failedAttempts + 1;
  if (n >= policy.lockout.maxFailures) {
    await db.query(`UPDATE users SET failed_attempts=$2, locked_until = now() + ($3 || ' minutes')::interval WHERE id=$1`, [row.id, n, String(policy.lockout.lockMinutes)]);
    await audit(db, row.username, 'auth', row.id, 'ACCOUNT_LOCKED', { failures: n });
  } else await db.query('UPDATE users SET failed_attempts=$2 WHERE id=$1', [row.id, n]);
}

/** Resolves a cookie token to a live user, enforcing idle + absolute expiry, revocation, account status and credential rotation. */
export async function validateSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const id = sha256(token);
  const s = (await db.query(
    `SELECT s.*, u.* , s.id AS sid, s.auth_epoch AS epoch, EXISTS (SELECT 1 FROM mfa_methods m WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL) AS has_mfa FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id=$1`, [id])).rows[0];
  if (!s || s.revokedAt) return null;
  const now = Date.now();
  const policy = await getSecurityPolicy(db);
  const idleMs = idleMinutesFor(policy, s.isSuperuser ? [] : (s.roles as string[])) * 60_000;
  if (new Date(s.expiresAt).getTime() <= now || now - new Date(s.lastSeenAt).getTime() > idleMs || s.status !== 'ACTIVE') {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL', [id]);
    return null;
  }
  if (s.isSuperuser) {
    const su = superuserConfig();
    if (!su || superuserId(su.username) !== s.userId || epochOf(su) !== s.epoch) {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id=$1', [id]);
      return null;
    }
  }
  if (now - new Date(s.lastSeenAt).getTime() > 60_000) await db.query('UPDATE sessions SET last_seen_at = now() WHERE id=$1', [id]);
  const user = toUser({ ...s, id: s.userId }, await getRoleOverrides(db));
  user.mfaEnrollRequired = !s.isSuperuser && !s.hasMfa && mfaRequiredFor(policy, user.roles);
  return user;
}

export const logout = (db: Db, token: string | undefined) => token ? db.query('UPDATE sessions SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL', [sha256(token)]) : Promise.resolve();
export const revokeUserSessions = (q: Queryable, userId: string) => q.query('UPDATE sessions SET revoked_at = now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);

// ───────────────────────── user administration ─────────────────────────
export interface NewUser { username: string; displayName: string; email?: string; phone?: string; roles: string[]; storeId?: string; dealerId?: string; customerId?: string; marketCode?: string; password?: string }

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,49}$/i;

function checkBinding(roles: RoleId[], b: { storeId?: string | null; dealerId?: string | null; customerId?: string | null }, book: RoleBook) {
  const m = missingBinding(roles, b, book);
  if (m) throw invalid(m);
}
function parseRoles(roles: string[], book: RoleBook): RoleId[] {
  const bad = roles.filter((r) => !roleDef(r, book));
  if (bad.length) throw invalid(`unknown role: ${bad.join(', ')}`);
  if (roles.length === 0) throw invalid('assign at least one role');
  return [...new Set(roles)] as RoleId[];
}
const adminView = (r: Row) => ({
  id: r.id, username: r.username, displayName: r.displayName, email: r.email, phone: r.phone ?? null, roles: r.roles, status: r.status, isSuperuser: r.isSuperuser,
  mustChangePassword: r.mustChangePassword, locked: !!r.lockedUntil && new Date(r.lockedUntil) > new Date(), lastLoginAt: r.lastLoginAt,
  storeId: r.storeId, dealerId: r.dealerId, customerId: r.customerId, marketCode: r.marketCode?.trim(), createdAt: r.createdAt, createdBy: r.createdBy, authSource: r.authSource ?? 'LOCAL',
});

/** A login's market decides which offers it can sell: the one given, else the deployment's own country (Settings → Regional), else Singapore. */
async function userMarket(q: Queryable, given?: string): Promise<string> {
  return effectiveMarket(q, given); // one market: the deployment's; several: the one chosen, else the default market
}

/** Creates a user. Without a password a one-time temporary password is generated and returned; the user must change it at first sign-in. */
export async function createUser(db: Db, actor: string, i: NewUser): Promise<{ user: ReturnType<typeof adminView>; temporaryPassword?: string }> {
  if (!USERNAME.test(i.username)) throw invalid('username must be 3-50 characters: letters, digits, dot, dash or underscore');
  const su = superuserConfig();
  if (su && su.username.toLowerCase() === i.username.toLowerCase()) throw conflict('that username is reserved');
  if (!i.displayName.trim()) throw invalid('displayName is required');
  const book = await getRoleOverrides(db);
  const roles = parseRoles(i.roles, book);
  checkBinding(roles, i, book);
  if (i.storeId) await assertStoreUsable(db, i.storeId); // a store user is bound to a store that exists under Stores and is switched on
  if (i.customerId && !(await db.query('SELECT 1 FROM customers WHERE id=$1', [i.customerId])).rows.length) throw notFound('customer', i.customerId);
  const temp = i.password ? undefined : temporaryPassword();
  const password = i.password ?? temp!;
  const problem = checkPassword(await getSecurityPolicy(db), password, i.username);
  if (problem) throw invalid(problem);
  const hash = await hashPassword(password);
  try {
    const r = (await db.query(
      `INSERT INTO users (username, display_name, email, phone, password_hash, roles, must_change_password, store_id, dealer_id, customer_id, market_code, created_by)
       VALUES ($1,$2,$3,$11,$4,$5,true,$6,$7,$8,$9,$10) RETURNING *`,
      [i.username.toLowerCase(), i.displayName.trim(), i.email ?? null, hash, roles, i.storeId ?? null, i.dealerId ?? null, i.customerId ?? null, await userMarket(db, i.marketCode), actor, i.phone ?? null])).rows[0]!;
    await rememberPassword(db, r.id, hash);
    await audit(db, actor, 'user', r.id, 'USER_CREATED', { username: r.username, roles });
    return { user: adminView(r), temporaryPassword: temp };
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw conflict(/customer/.test((e as Error).message) ? 'that customer already has a portal login' : 'that username is taken');
    throw e;
  }
}

export async function listUsers(q: Queryable, f: { q?: string; limit?: number; cursor?: string } = {}): Promise<Page<ReturnType<typeof adminView>>> {
  const limit = pageSize(f.limit, 50, 200);
  const { params, p } = sqlBuilder();
  const where = ['NOT is_superuser'];
  const text = (f.q ?? '').trim().toLowerCase();
  if (text) where.push(`(lower(username) LIKE ${p(likePrefix(text))} OR lower(display_name) LIKE ${p(likePrefix(text))})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(lower(username), id) > (${p(cur[0])}::text, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(`SELECT *, lower(username) AS cursor_u FROM users WHERE ${where.join(' AND ')} ORDER BY lower(username), id LIMIT ${p(limit + 1)}`, params)).rows;
  const page = toPage(rows, limit, (r) => [r.cursorU as string, r.id as string]);
  return { items: page.items.map((r) => adminView(r)), nextCursor: page.nextCursor };
}

export async function updateUser(db: Db, actor: string, id: string, p: { displayName?: string; email?: string; phone?: string | null; roles?: string[]; status?: 'ACTIVE' | 'DISABLED'; storeId?: string | null; dealerId?: string | null; marketCode?: string }) {
  return db.tx(async (q) => {
    const u = (await q.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!u || u.isSuperuser) throw notFound('user', id);
    const book = await getRoleOverrides(q);
    const roles = p.roles ? parseRoles(p.roles, book) : (u.roles as RoleId[]);
    const storeId = p.storeId === undefined ? u.storeId : p.storeId, dealerId = p.dealerId === undefined ? u.dealerId : p.dealerId;
    checkBinding(roles, { storeId, dealerId, customerId: u.customerId }, book);
    if (storeId && storeId !== u.storeId) await assertStoreUsable(q, storeId);
    await q.query(
      `UPDATE users SET display_name = COALESCE($2, display_name), email = COALESCE($3, email), phone = CASE WHEN $9::boolean THEN $10 ELSE phone END, roles=$4, status = COALESCE($5, status), store_id=$6, dealer_id=$7, market_code = COALESCE($8, market_code), updated_at=now() WHERE id=$1`,
      [id, p.displayName?.trim() ?? null, p.email ?? null, roles, p.status ?? null, storeId, dealerId, p.marketCode ? await userMarket(q, p.marketCode) : null, p.phone !== undefined, p.phone ?? null]);
    // Permission and status changes take effect immediately, not at next login.
    if (p.roles || p.status === 'DISABLED' || p.storeId !== undefined || p.dealerId !== undefined) await revokeUserSessions(q, id);
    await audit(q, actor, 'user', id, 'USER_UPDATED', { roles: p.roles, status: p.status, marketCode: p.marketCode });
    return adminView((await q.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]!);
  });
}

export async function resetPassword(db: Db, actor: string, id: string): Promise<{ temporaryPassword: string }> {
  return db.tx(async (q) => {
    const u = (await q.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!u || u.isSuperuser) throw notFound('user', id);
    if (u.authSource !== 'LOCAL') throw rejected(`This account signs in through ${u.authSource === 'LDAP' ? 'the company directory' : 'single sign-on'}; its password is managed there.`);
    const temp = temporaryPassword();
    await q.query(`UPDATE users SET password_hash=$2, must_change_password=true, failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1`, [id, await hashPassword(temp)]);
    await revokeUserSessions(q, id);
    await audit(q, actor, 'user', id, 'PASSWORD_RESET');
    return { temporaryPassword: temp };
  }).then(async (r) => { await raiseUserAlert(db, { id }, 'securityAlerts', { title: 'Password reset by an administrator', body: 'An administrator gave your account a temporary password and signed you out everywhere. You will be asked to choose a new password at your next sign-in.', link: '/profile?tab=security' }); return r; });
}

export async function unlockUser(db: Db, actor: string, id: string) {
  const r = await db.query(`UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1 AND NOT is_superuser`, [id]);
  if (!r.rowCount) throw notFound('user', id);
  await audit(db, actor, 'user', id, 'USER_UNLOCKED');
}

export async function changePassword(db: Db, user: SessionUser, current: string, next: string) {
  if (user.isSuperuser) throw rejected('The super user password is set in the environment (MERIDIAN_SUPERUSER_PASSWORD).');
  const row = (await db.query('SELECT password_hash, auth_source FROM users WHERE id=$1', [user.id])).rows[0];
  if (row && row.authSource !== 'LOCAL') throw rejected('Your password is managed by your company sign-in, not by Meridian.');
  if (!row || !(await verifyPassword(current, row.passwordHash))) throw rejected('The current password is incorrect.');
  const policy = await getSecurityPolicy(db);
  const problem = checkPassword(policy, next, user.username);
  if (problem) throw invalid(problem);
  if (await verifyPassword(next, row.passwordHash)) throw invalid('Choose a password different from the current one.');
  if (await isReusedPassword(db, user.id, next, verifyPassword, policy)) throw invalid(`You used that password before. Choose one you have not used in your last ${policy.password.historyCount} passwords.`);
  await db.tx(async (q) => {
    const hash = await hashPassword(next);
    await q.query(`UPDATE users SET password_hash=$2, must_change_password=false, password_changed_at=now(), updated_at=now() WHERE id=$1`, [user.id, hash]);
    await rememberPassword(q, user.id, hash);
    await revokeUserSessions(q, user.id); // every other device is signed out; the caller signs in again
    await audit(q, user.username, 'user', user.id, 'PASSWORD_CHANGED');
  });
  await raiseUserAlert(db, { id: user.id }, 'securityAlerts', { title: 'Password changed', body: 'Your Meridian password was changed and your other devices were signed out. If this was not you, contact your administrator at once.', link: '/profile?tab=security' });
}

