import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, MfaRequired, validateSession, verifyMfaLogin } from './auth.js';
import type { Db } from './db.js';
import { base32Decode, base32Encode, beginOtpMethod, beginTotp, confirmOtpMethod, confirmTotp, disableMethod, hotp, mfaStatus, regenerateRecoveryCodes, resetMfa, sendChallengeCode, totpCounter, verifyTotp } from './mfa.js';
import { describeAgent, getProfile, listMySessions, refreshSession, revokeMySession, revokeOtherSessions, updateProfile } from './profile.js';
import { defaultSecurityPolicy, setSecurityPolicy } from './security-policy.js';
import { decryptText } from './field-crypto.js';
import { freshDb } from './test-helpers.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
const PW = 'Sturdy-Pass-Word-1';
let db: Db;
let n = 0;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(() => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; });
afterEach(async () => { await db.query('DELETE FROM auth_attempts'); await setSecurityPolicy(db, 't', defaultSecurityPolicy()); });

const person = async (o: { email?: string; phone?: string; roles?: string[] } = {}) => {
  const username = `mfa.user${++n}`;
  const { user } = await createUser(db, 'admin', { username, displayName: `Person ${n}`, roles: o.roles ?? ['call-center'], email: o.email, phone: o.phone, password: PW });
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
  const s = (await login(db, { username, password: PW })).user;
  return { id: user.id, username, session: s };
};
const nowCode = async (userId: string) => { const m = (await db.query(`SELECT secret_enc FROM mfa_methods WHERE user_id=$1 AND kind='TOTP'`, [userId])).rows[0]; return hotp(base32Decode(decryptText(m!.secretEnc)), totpCounter()); };
const lastOtp = async () => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='MFA_OTP' ORDER BY id DESC LIMIT 1`)).rows[0]?.payload;
const mfaChallenge = async (username: string) => { try { await login(db, { username, password: PW }); } catch (e) { if (e instanceof MfaRequired) return e.challenge; throw e; } throw new Error('no challenge'); };

describe('TOTP', () => {
  it('matches the RFC 6238 test vector, accepts the neighbouring step, and never accepts a code twice', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, 1, 8)).toBe('94287082');                     // RFC 6238 appendix B, T = 59 s, SHA-1
    const b32 = base32Encode(secret);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    expect(verifyTotp(b32, '287082', 0, 59_000)).toBe(1);
    expect(verifyTotp(b32, '287082', 0, 59_000 + 30_000)).toBe(1);    // one step late is fine
    expect(verifyTotp(b32, '287082', 0, 59_000 + 90_000)).toBeNull(); // three steps late is not
    expect(verifyTotp(b32, '287082', 1, 59_000)).toBeNull();          // already used
    expect(verifyTotp(b32, 'abcdef', 0, 59_000)).toBeNull();
  });
});

describe('setting up and signing in with a second factor', () => {
  it('sets up an authenticator app, then asks for it at sign-in, once per code, with recovery codes as a way back', async () => {
    const u = await person();
    const setup = await beginTotp(db, u);
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/Meridian:mfa\.user\d+\?secret=[A-Z2-7]+&issuer=Meridian/);
    expect(setup.qrSvg).toContain('<svg');
    await expect(confirmTotp(db, u, '000000')).rejects.toThrow(/not right/);
    const done = await confirmTotp(db, u, await nowCode(u.id));
    expect(done.recoveryCodes).toHaveLength(10);
    expect((await mfaStatus(db, u.id)).methods.map((m) => m.kind)).toEqual(['TOTP']);

    // the password alone no longer opens a session
    const ch = await mfaChallenge(u.username);
    expect(ch).toMatchObject({ method: 'TOTP', methods: ['TOTP'] });
    await expect(verifyMfaLogin(db, { challenge: ch.token, code: '123456' })).rejects.toThrow(/not right/);
    // the code used during setup is spent, so this sign-in uses a recovery code
    const rc = done.recoveryCodes![0]!;
    const ok = await verifyMfaLogin(db, { challenge: ch.token, recoveryCode: rc });
    expect(await validateSession(db, ok.token)).not.toBeNull();
    const again = await mfaChallenge(u.username);
    await expect(verifyMfaLogin(db, { challenge: again.token, recoveryCode: rc })).rejects.toThrow(/not right/);   // a recovery code works once
    expect((await mfaStatus(db, u.id)).recoveryCodesLeft).toBe(9);
  });

  it('locks a pending sign-in after five wrong codes', async () => {
    const u = await person();
    await beginTotp(db, u); await confirmTotp(db, u, await nowCode(u.id));
    const ch = await mfaChallenge(u.username);
    for (let i = 0; i < 5; i++) await expect(verifyMfaLogin(db, { challenge: ch.token, code: '000000' })).rejects.toThrow(/not right/);
    await expect(verifyMfaLogin(db, { challenge: ch.token, code: await nowCode(u.id) })).rejects.toThrow(/not right/);
  });

  it('works with a code by SMS or e-mail, sent when asked for', async () => {
    const u = await person({ phone: '+6591234567', email: 'p@example.com' });
    await expect(beginOtpMethod(db, { id: u.id, name: 'P', email: null, phone: null }, 'SMS')).rejects.toThrow(/mobile number/);
    const sent = await beginOtpMethod(db, { id: u.id, name: 'P', email: 'p@example.com', phone: '+6591234567' }, 'SMS');
    expect(sent.sentTo).toMatch(/^\+65•••67$/);
    expect(await lastOtp()).toMatchObject({ channel: 'SMS', to: '+6591234567', purpose: 'ENROL', code: expect.stringMatching(/^\d{6}$/) });
    await expect(confirmOtpMethod(db, u, 'SMS', '000000')).rejects.toThrow(/not right/);
    const first = await confirmOtpMethod(db, u, 'SMS', (await lastOtp()).code);
    expect(first.recoveryCodes).toHaveLength(10);

    const ch = await mfaChallenge(u.username);                        // SMS is the method, so the code went out at sign-in
    expect(ch).toMatchObject({ method: 'SMS', sentTo: '+65•••67' });
    const code = (await lastOtp()).code;
    expect((await lastOtp()).purpose).toBe('LOGIN');
    const ok = await verifyMfaLogin(db, { challenge: ch.token, code });
    expect(ok.user.username).toBe(u.username);
    await expect(verifyMfaLogin(db, { challenge: ch.token, code })).rejects.toThrow(/not right/);   // spent

    await beginOtpMethod(db, { id: u.id, name: 'P', email: 'p@example.com', phone: '+6591234567' }, 'EMAIL');
    await confirmOtpMethod(db, u, 'EMAIL', (await lastOtp()).code);
    const ch2 = await mfaChallenge(u.username);
    expect(ch2.methods).toEqual(['EMAIL', 'SMS']);
    await sendChallengeCode(db, ch2.token, 'SMS');
    expect((await lastOtp()).channel).toBe('SMS');
    await verifyMfaLogin(db, { challenge: ch2.token, code: (await lastOtp()).code });
  });

  it('can be required for chosen roles, and the last method cannot be removed then', async () => {
    await setSecurityPolicy(db, 'a', { mfa: { requirement: 'ROLES', roleIds: ['call-center'] } as never });
    const u = await person({ roles: ['call-center'] });
    const other = await person({ roles: ['billing-ops'] });
    expect((await validateSession(db, (await login(db, { username: u.username, password: PW })).token))!.mfaEnrollRequired).toBe(true);
    expect((await validateSession(db, (await login(db, { username: other.username, password: PW })).token))!.mfaEnrollRequired).toBe(false);
    await beginTotp(db, u); await confirmTotp(db, u, await nowCode(u.id));
    await expect(disableMethod(db, u, 'TOTP', PW, true)).rejects.toThrow(/required for your role/);
    await expect(disableMethod(db, u, 'TOTP', 'wrong', false)).rejects.toThrow(/password is not right/);
    await disableMethod(db, u, 'TOTP', PW, false);
    expect((await mfaStatus(db, u.id)).methods).toHaveLength(0);
  });

  it('lets an administrator clear a lost second factor, and new recovery codes need the password', async () => {
    const u = await person();
    await beginTotp(db, u); await confirmTotp(db, u, await nowCode(u.id));
    await expect(regenerateRecoveryCodes(db, u, 'nope')).rejects.toThrow(/password/);
    expect(await regenerateRecoveryCodes(db, u, PW)).toHaveLength(10);
    await resetMfa(db, 'admin', u.id);
    await login(db, { username: u.username, password: PW });          // password alone works again
  });
});

describe('profile and sessions', () => {
  it('keeps contact changes behind the password, checks the picture, and merges alert preferences', async () => {
    const u = await person({ email: 'old@example.com' });
    await expect(updateProfile(db, u.session, { email: 'new@example.com' })).rejects.toThrow(/current password/);
    const p = await updateProfile(db, u.session, { email: 'new@example.com', phone: '+65 9123 4567', currentPassword: PW, displayName: 'New Name' });
    expect(p).toMatchObject({ email: 'new@example.com', phone: '+6591234567', displayName: 'New Name' });
    await expect(updateProfile(db, u.session, { avatar: 'http://evil.example/x.png' })).rejects.toThrow(/PNG/);
    expect((await updateProfile(db, u.session, { avatar: 'data:image/png;base64,iVBORw0KGgo=' })).avatar).toMatch(/^data:image\/png/);
    const prefs = (await updateProfile(db, u.session, { notificationPrefs: { channels: { sms: true } as never } })).notificationPrefs;
    expect(prefs.channels).toEqual({ email: true, sms: true, push: true });
    expect((await getProfile(db, u.session)).organisation).toEqual({ storeId: null, storeName: null, dealerId: null, dealerName: null });
  });

  it('lists devices, signs the others out, and rotates a token without lengthening the session', async () => {
    const u = await person();
    const a = (await login(db, { username: u.username, password: PW, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120.0 Safari/537.36', ip: '10.1.1.1' })).token;
    const b = (await login(db, { username: u.username, password: PW, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1', ip: '10.1.1.2' })).token;
    const list = await listMySessions(db, u.id, a);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.map((s) => s.device)).toEqual(expect.arrayContaining(['Chrome on macOS', 'Safari on iOS']));
    const other = list.find((s) => !s.current && s.device === 'Safari on iOS')!;
    await expect(revokeMySession(db, u.session, list.find((s) => s.current)!.id, a)).rejects.toThrow(/device you are using/);
    await revokeMySession(db, u.session, other.id, a);
    expect(await validateSession(db, b)).toBeNull();
    const c = (await login(db, { username: u.username, password: PW })).token;
    expect((await revokeOtherSessions(db, u.session, a)).revoked).toBeGreaterThanOrEqual(1);
    expect(await validateSession(db, c)).toBeNull();
    const before = (await db.query('SELECT expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [u.id])).rows.map((r) => new Date(r.expiresAt).getTime());
    const fresh = await refreshSession(db, a);
    expect(await validateSession(db, a)).toBeNull();
    expect(await validateSession(db, fresh.token)).not.toBeNull();
    expect(before).toContain(fresh.expiresAt.getTime());
  });

  it('describes a browser in plain words', () => {
    expect(describeAgent('Mozilla/5.0 (Windows NT 10.0) Edg/120.0')).toBe('Edge on Windows');
    expect(describeAgent(null)).toBe('Unknown device');
  });
});
