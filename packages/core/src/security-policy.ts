import { DEFAULT_PASSWORD_RULES, passwordIssue, type PasswordRules } from '@meridian/types';
import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';
import { passwordProblem } from './passwords.js';

/**
 * The deployment's security policy, set in Settings → Security policy. Until an administrator saves one, the defaults are what the environment variables
 * (MERIDIAN_SESSION_IDLE_MINUTES, _MAX_HOURS, MERIDIAN_LOCK_AFTER_FAILURES, _LOCK_MINUTES) said before, so upgrading changes nothing by itself.
 * It is read on every sign-in and request, so a change takes effect at once.
 */
export interface SecurityPolicy {
  password: PasswordRules & {
    /** Passwords older than this must be changed at the next sign-in. 0 = never expire. */
    maxAgeDays: number;
    /** The number of previous passwords that cannot be used again. 0 = no check. */
    historyCount: number;
  };
  lockout: { maxFailures: number; lockMinutes: number };
  session: {
    idleMinutes: number; absoluteHours: number;
    /** Roles that sign out sooner (counter and call-centre screens in public or shared places), and how soon. */
    strictRoleIds: string[]; strictIdleMinutes: number;
  };
  recovery: {
    enabled: boolean;
    /** How a forgotten password is recovered: a link by e-mail, a code by SMS, or whichever the person has on file. */
    channel: 'EMAIL' | 'SMS' | 'EITHER';
    tokenMinutes: number; maxRequestsPerHour: number;
    /** The address people reach Meridian at (https://crm.example.com). Reset links are built from it, never from the request, so a forged Host header cannot redirect them. Empty: e-mail carries a six-digit code instead of a link. */
    publicUrl: string;
  };
}

const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
export const defaultSecurityPolicy = (): SecurityPolicy => ({
  password: { ...DEFAULT_PASSWORD_RULES, maxAgeDays: 0, historyCount: 0 },
  lockout: { maxFailures: num('MERIDIAN_LOCK_AFTER_FAILURES', 5), lockMinutes: num('MERIDIAN_LOCK_MINUTES', 15) },
  session: { idleMinutes: num('MERIDIAN_SESSION_IDLE_MINUTES', 30), absoluteHours: num('MERIDIAN_SESSION_MAX_HOURS', 12), strictRoleIds: [], strictIdleMinutes: 15 },
  recovery: { enabled: true, channel: 'EITHER', tokenMinutes: 30, maxRequestsPerHour: 3, publicUrl: '' },
});

export async function getSecurityPolicy(q: Queryable): Promise<SecurityPolicy> {
  const d = defaultSecurityPolicy();
  const v = (await q.query(`SELECT value FROM settings WHERE key='securityPolicy'`)).rows[0]?.value as Partial<SecurityPolicy> | undefined;
  return { password: { ...d.password, ...(v?.password ?? {}) }, lockout: { ...d.lockout, ...(v?.lockout ?? {}) }, session: { ...d.session, ...(v?.session ?? {}) }, recovery: { ...d.recovery, ...(v?.recovery ?? {}) } };
}

const int = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
export function securityPolicyProblems(p: SecurityPolicy): string[] {
  const e: string[] = [];
  if (!int(p.password.minLength, 8, 64)) e.push('The shortest password is 8 to 64 characters.');
  if (!int(p.password.maxAgeDays, 0, 3650)) e.push('A password can last 1 to 3650 days, or never expire (0).');
  if (!int(p.password.historyCount, 0, 24)) e.push('Remember up to 24 previous passwords (0 = do not check).');
  if (!int(p.lockout.maxFailures, 3, 20)) e.push('Lock an account after 3 to 20 failed sign-ins.');
  if (!int(p.lockout.lockMinutes, 1, 1440)) e.push('Keep an account locked for 1 to 1440 minutes.');
  if (!int(p.session.idleMinutes, 5, 720)) e.push('Sign out after 5 to 720 idle minutes.');
  if (!int(p.session.absoluteHours, 1, 72)) e.push('A session lasts at most 1 to 72 hours.');
  if (!int(p.session.strictIdleMinutes, 5, 720)) e.push('The shorter idle limit is 5 to 720 minutes.');
  if (p.session.strictRoleIds.length > 50) e.push('Too many roles chosen for the shorter idle limit.');
  if (!['EMAIL', 'SMS', 'EITHER'].includes(p.recovery.channel)) e.push('Recover a password by e-mail, SMS or either.');
  if (!int(p.recovery.tokenMinutes, 5, 1440)) e.push('A recovery link or code works for 5 to 1440 minutes.');
  if (!int(p.recovery.maxRequestsPerHour, 1, 20)) e.push('Allow 1 to 20 recovery requests an hour for one person.');
  if (p.recovery.publicUrl && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(p.recovery.publicUrl)) e.push('The public address looks like https://crm.example.com.');
  return e;
}

export async function setSecurityPolicy(q: Queryable, actor: string, input: Partial<SecurityPolicy>): Promise<SecurityPolicy> {
  const cur = await getSecurityPolicy(q);
  const next: SecurityPolicy = {
    password: { ...cur.password, ...(input.password ?? {}) }, lockout: { ...cur.lockout, ...(input.lockout ?? {}) },
    session: { ...cur.session, ...(input.session ?? {}) }, recovery: { ...cur.recovery, ...(input.recovery ?? {}) },
  };
  next.session.strictRoleIds = [...new Set(next.session.strictRoleIds)];
  next.recovery.publicUrl = (next.recovery.publicUrl ?? '').trim().replace(/\/+$/, '');
  const problems = securityPolicyProblems(next);
  if (problems.length) throw invalid(problems.slice(0, 4).join(' '), problems);
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('securityPolicy', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'securityPolicy', 'update', { password: next.password, lockout: next.lockout, session: { ...next.session, strictRoleIds: next.session.strictRoleIds.length }, recovery: next.recovery });
  return next;
}

/** Idle limit for someone holding these roles: the shorter limit applies if any of their roles is on the strict list. */
export const idleMinutesFor = (p: SecurityPolicy, roles: string[]): number =>
  roles.some((r) => p.session.strictRoleIds.includes(r)) ? Math.min(p.session.idleMinutes, p.session.strictIdleMinutes) : p.session.idleMinutes;

/** Whether a password may be used: the policy's rules, then the fixed checks (blocklist of common passwords, no username, not repetitive). Null = fine. */
export function checkPassword(policy: SecurityPolicy, password: string, username = ''): string | null {
  return passwordIssue(policy.password, password, username) ?? passwordProblem(password, username, policy.password.minLength);
}

/** True when this password is one of the person's last `historyCount` passwords (or their current one). */
export async function isReusedPassword(q: Queryable, userId: string, password: string, verify: (pw: string, hash: string) => Promise<boolean>, policy: SecurityPolicy): Promise<boolean> {
  if (policy.password.historyCount <= 0) return false;
  const rows = (await q.query('SELECT hash FROM password_history WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [userId, policy.password.historyCount])).rows;
  for (const r of rows) if (await verify(password, r.hash)) return true;
  return false;
}
export async function rememberPassword(q: Queryable, userId: string, hash: string): Promise<void> {
  await q.query('INSERT INTO password_history (user_id, hash) VALUES ($1,$2)', [userId, hash]);
  await q.query(`DELETE FROM password_history WHERE user_id=$1 AND id NOT IN (SELECT id FROM password_history WHERE user_id=$1 ORDER BY id DESC LIMIT 24)`, [userId]);
}
