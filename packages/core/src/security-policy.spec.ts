import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changePassword, createUser, login, validateSession } from './auth.js';
import type { Db } from './db.js';
import { requestPasswordReset, resetPasswordWithToken } from './password-recovery.js';
import { checkPassword, defaultSecurityPolicy, getSecurityPolicy, idleMinutesFor, setSecurityPolicy } from './security-policy.js';
import { saveHubEndpoint } from './integration-hub.js';
import { freshDb } from './test-helpers.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
let db: Db;
let n = 0;
beforeAll(async () => { db = await freshDb(); await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'EMAIL_GATEWAY', name: 'Simulated mail', config: { mode: 'SIMULATOR', fromName: 'Meridian', fromAddress: 'noreply@example.com' } }); });
afterAll(async () => { await db.close(); });
beforeEach(() => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; });
afterEach(async () => { await db.query('DELETE FROM auth_attempts'); await setSecurityPolicy(db, 'test', defaultSecurityPolicy()); });

const PW = 'Sturdy-Pass-Word-1';
const person = async (o: { email?: string; phone?: string; roles?: string[] } = {}) => {
  const username = `sec.user${++n}`;
  const { user } = await createUser(db, 'admin', { username, displayName: username, roles: o.roles ?? ['call-center'], email: o.email, phone: o.phone, password: PW });
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
  return { id: user.id, username };
};
const outbox = async (instr: string) => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction=$1 ORDER BY id DESC LIMIT 1`, [instr])).rows[0]?.payload;

describe('the policy', () => {
  it('starts as the environment said before, and refuses values that make no sense', async () => {
    expect(await getSecurityPolicy(db)).toMatchObject({ lockout: { maxFailures: 5, lockMinutes: 15 }, session: { idleMinutes: 30, absoluteHours: 12 }, password: { minLength: 12, maxAgeDays: 0, historyCount: 0 } });
    await expect(setSecurityPolicy(db, 'a', { password: { minLength: 4 } as never })).rejects.toThrow(/8 to 64/);
    await expect(setSecurityPolicy(db, 'a', { lockout: { maxFailures: 1, lockMinutes: 5 } })).rejects.toThrow(/3 to 20/);
    await expect(setSecurityPolicy(db, 'a', { recovery: { publicUrl: 'not a url' } as never })).rejects.toThrow(/public address/);
  });

  it('enforces the password composition rules when a password is set', async () => {
    await setSecurityPolicy(db, 'a', { password: { minLength: 14, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true } as never });
    const p = await getSecurityPolicy(db);
    expect(checkPassword(p, 'shortOne1!')).toMatch(/14 characters/);
    expect(checkPassword(p, 'alllowercase-and-long-1!')).toMatch(/uppercase/);
    expect(checkPassword(p, 'NoSymbolsAtAll12345')).toMatch(/symbol/);
    expect(checkPassword(p, 'Quite-Strong-Pass-7')).toBeNull();
    await expect(createUser(db, 'admin', { username: `weak${++n}`, displayName: 'W', roles: ['call-center'], password: 'plainlongpassword' })).rejects.toThrow(/uppercase|number|symbol/);
  });

  it('refuses a recently used password, and forgets once the history is switched off', async () => {
    await setSecurityPolicy(db, 'a', { password: { historyCount: 3 } as never });
    const u = await person();
    const me = (await login(db, { username: u.username, password: PW })).user;
    await changePassword(db, me, PW, 'Second-Pass-Word-2');
    const again = (await login(db, { username: u.username, password: 'Second-Pass-Word-2' })).user;
    await expect(changePassword(db, again, 'Second-Pass-Word-2', PW)).rejects.toThrow(/used that password before/);
    await setSecurityPolicy(db, 'a', { password: { historyCount: 0 } as never });
    await changePassword(db, again, 'Second-Pass-Word-2', PW);
  });

  it('makes an old password change at sign-in', async () => {
    await setSecurityPolicy(db, 'a', { password: { maxAgeDays: 90 } as never });
    const u = await person();
    expect((await login(db, { username: u.username, password: PW })).user.mustChangePassword).toBe(false);
    await db.query(`UPDATE users SET password_changed_at = now() - interval '91 days' WHERE id=$1`, [u.id]);
    expect((await login(db, { username: u.username, password: PW })).user.mustChangePassword).toBe(true);
  });

  it('locks after the configured number of failures, for the configured time', async () => {
    await setSecurityPolicy(db, 'a', { lockout: { maxFailures: 3, lockMinutes: 30 } });
    const u = await person();
    for (let i = 0; i < 3; i++) await expect(login(db, { username: u.username, password: 'wrong-password-1', ip: `10.9.0.${i}` })).rejects.toThrow(/Incorrect/);
    await expect(login(db, { username: u.username, password: PW })).rejects.toThrow(/locked/);
    const mins = (await db.query(`SELECT extract(epoch FROM (locked_until - now()))/60 AS m FROM users WHERE id=$1`, [u.id])).rows[0]!.m as number;
    expect(Math.round(mins)).toBeGreaterThanOrEqual(29);
  });

  it('signs counter and call-centre roles out sooner than everyone else', async () => {
    await setSecurityPolicy(db, 'a', { session: { idleMinutes: 30, strictRoleIds: ['retail-store'], strictIdleMinutes: 10 } as never });
    expect(idleMinutesFor(await getSecurityPolicy(db), ['retail-store'])).toBe(10);
    expect(idleMinutesFor(await getSecurityPolicy(db), ['call-center'])).toBe(30);
    const a = await person({ roles: ['call-center'] });
    const ta = (await login(db, { username: a.username, password: PW })).token;
    const b = (await createUser(db, 'admin', { username: `store${++n}`, displayName: 'Store', roles: ['retail-store'], storeId: 'STORE-SG-001', password: PW })).user;
    await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [b.id]);
    const tb = (await login(db, { username: b.username, password: PW })).token;
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '20 minutes'`);
    expect(await validateSession(db, ta)).not.toBeNull();   // 20 minutes idle is fine at 30
    expect(await validateSession(db, tb)).toBeNull();       // but not at 10
  });
});

describe('forgot password', () => {
  beforeEach(async () => { await setSecurityPolicy(db, 'a', { email: { codesEnabled: true } as never }); });   // recovery by e-mail needs the switch and a sender
  it('sends a link by e-mail when a public address is set, and a six-digit code otherwise', async () => {
    const u = await person({ email: 'who@example.com' });
    await requestPasswordReset(db, { identifier: u.username });
    const code = await outbox('PASSWORD_RESET');
    expect(code).toMatchObject({ channel: 'EMAIL', to: 'who@example.com', code: expect.stringMatching(/^\d{6}$/) });
    expect(code.link).toBeUndefined();
    await setSecurityPolicy(db, 'a', { recovery: { publicUrl: 'https://crm.example.com/' } as never });
    await requestPasswordReset(db, { identifier: 'WHO@example.com' });
    const link = await outbox('PASSWORD_RESET');
    expect(link.link).toMatch(/^https:\/\/crm\.example\.com\/reset-password\?token=[\w-]{40,}$/);
  });

  it('answers the same for a stranger and queues nothing', async () => {
    const before = (await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='PASSWORD_RESET'`)).rows[0]!.n;
    expect(await requestPasswordReset(db, { identifier: 'nobody-here' })).toEqual({ ok: true });
    expect((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='PASSWORD_RESET'`)).rows[0]!.n).toBe(before);
  });

  it('works once, ends every session, clears a lock, and a new request replaces an open one', async () => {
    await setSecurityPolicy(db, 'a', { recovery: { publicUrl: 'https://crm.example.com' } as never });
    const u = await person({ email: `r${n}@example.com` });
    const token = (await login(db, { username: u.username, password: PW })).token;
    await requestPasswordReset(db, { identifier: u.username });
    const first = (await outbox('PASSWORD_RESET')).link.split('token=')[1] as string;
    await requestPasswordReset(db, { identifier: u.username });
    const second = (await outbox('PASSWORD_RESET')).link.split('token=')[1] as string;
    await expect(resetPasswordWithToken(db, { token: first, newPassword: 'Brand-New-Pass-3' })).rejects.toThrow(/not valid/);
    await expect(resetPasswordWithToken(db, { token: second, newPassword: 'weak' })).rejects.toThrow(/at least/);
    await resetPasswordWithToken(db, { token: second, newPassword: 'Brand-New-Pass-3' });
    await expect(resetPasswordWithToken(db, { token: second, newPassword: 'Another-Pass-Word-4' })).rejects.toThrow(/not valid/);
    expect(await validateSession(db, token)).toBeNull();
    await login(db, { username: u.username, password: 'Brand-New-Pass-3' });
  });

  it('expires, and a code locks after five wrong tries', async () => {
    const u = await person({ phone: '+6591234567' });
    await requestPasswordReset(db, { identifier: u.username });
    const sent = await outbox('PASSWORD_RESET');
    expect(sent).toMatchObject({ channel: 'SMS', to: '+6591234567' });
    const wrong = sent.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await expect(resetPasswordWithToken(db, { identifier: u.username, code: wrong, newPassword: 'Brand-New-Pass-3' })).rejects.toThrow(/not valid/);
    await expect(resetPasswordWithToken(db, { identifier: u.username, code: sent.code, newPassword: 'Brand-New-Pass-3' })).rejects.toThrow(/not valid/); // locked
    await requestPasswordReset(db, { identifier: u.username });
    const fresh = await outbox('PASSWORD_RESET');
    await db.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [u.id]);
    await expect(resetPasswordWithToken(db, { identifier: u.username, code: fresh.code, newPassword: 'Brand-New-Pass-3' })).rejects.toThrow(/not valid/);
  });

  it('limits requests per person per hour and can be switched off', async () => {
    const u = await person({ email: `lim${n}@example.com` });
    await setSecurityPolicy(db, 'a', { recovery: { maxRequestsPerHour: 2 } as never });
    for (let i = 0; i < 4; i++) await requestPasswordReset(db, { identifier: u.username });
    expect((await db.query(`SELECT count(*) AS n FROM password_reset_tokens WHERE user_id=$1`, [u.id])).rows[0]!.n).toBe(2);
    await setSecurityPolicy(db, 'a', { recovery: { enabled: false } as never });
    await requestPasswordReset(db, { identifier: u.username });
    expect((await db.query(`SELECT count(*) AS n FROM password_reset_tokens WHERE user_id=$1`, [u.id])).rows[0]!.n).toBe(2);
  });
});
