import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { login, MfaRequired, superuserProblem, validateSession, verifyMfaLogin } from './auth.js';
import type { Db } from './db.js';
import { base32Decode, base32Encode, hotp, totpCounter } from './mfa.js';
import { freshDb } from './test-helpers.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
const SECRET = base32Encode(Buffer.from('0123456789abcdefghij'));
const OTHER = base32Encode(Buffer.from('jihgfedcba9876543210'));
const THIRD = base32Encode(Buffer.from('zyxwvutsrqponmlkjihg'));
const KEYS = ['MERIDIAN_SUPERUSER_USERNAME', 'MERIDIAN_SUPERUSER_PASSWORD', 'MERIDIAN_SUPERUSER_TOTP_SECRET'] as const;
const saved: Record<string, string | undefined> = {};
let db: Db;
beforeAll(async () => { for (const k of KEYS) saved[k] = process.env[k]; db = await freshDb(); });
afterAll(async () => { await db.close(); });
afterEach(async () => { await db.query('DELETE FROM auth_attempts'); for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const env = (secret?: string) => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; if (secret) process.env.MERIDIAN_SUPERUSER_TOTP_SECRET = secret; else delete process.env.MERIDIAN_SUPERUSER_TOTP_SECRET; };
const code = (secret: string, stepOffset = 0) => hotp(base32Decode(secret), totpCounter() + stepOffset);
const challenge = async () => { try { await login(db, { ...SU }); } catch (e) { if (e instanceof MfaRequired) return e.challenge.token; throw e; } throw new Error('no second step was asked for'); };

describe('a second factor for the environment-defined super user', () => {
  it('asks for a code after the password, and only a code from the configured authenticator opens a session', async () => {
    env(SECRET);
    await expect(login(db, { ...SU, password: 'wrong-password-123' })).rejects.toThrow(/Incorrect/);        // the password still comes first
    let token = await challenge();
    await expect(verifyMfaLogin(db, { challenge: token, code: '000000' })).rejects.toThrow();
    await expect(verifyMfaLogin(db, { challenge: token, recoveryCode: 'abcde-fghij' })).rejects.toThrow();
    token = await challenge();
    const ok = await verifyMfaLogin(db, { challenge: token, code: code(SECRET), ip: '203.0.113.7', userAgent: 'test' });
    expect(ok.user.isSuperuser).toBe(true);
    expect((await validateSession(db, ok.token))?.isSuperuser).toBe(true);                                      // and the session works
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'LOGIN_MFA' AND actor = $1`, [SU.username])).rows.length).toBe(1);
  });

  it('does not accept a code twice', async () => {
    env(SECRET);
    const c = code(SECRET, 1);                                    // the next step, so an earlier test that used this step cannot interfere
    await verifyMfaLogin(db, { challenge: await challenge(), code: c });
    await expect(verifyMfaLogin(db, { challenge: await challenge(), code: c })).rejects.toThrow();
  });

  it('follows the environment: a new secret signs the super user out and replaces the old code; removing it removes the second step', async () => {
    env(THIRD);
    const first = await verifyMfaLogin(db, { challenge: await challenge(), code: code(THIRD) });
    env(OTHER);
    expect(await validateSession(db, first.token)).toBeNull();                                                   // the old session is gone
    const t = await challenge();
    await expect(verifyMfaLogin(db, { challenge: t, code: code(THIRD) })).rejects.toThrow();                      // the old authenticator no longer works
    const second = await verifyMfaLogin(db, { challenge: await challenge(), code: code(OTHER) });
    expect((await validateSession(db, second.token))?.isSuperuser).toBe(true);
    env();
    const plain = await login(db, { ...SU });                                                                    // no second step any more
    expect(plain.user.isSuperuser).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM mfa_methods m JOIN users u ON u.id = m.user_id WHERE u.is_superuser`)).rows[0]!.n).toBe(0);
  });

  it('keeps the super user switched off, and says why, when the secret is not a usable one', async () => {
    env('not-a-base32-secret!');
    expect(superuserProblem()).toMatch(/MERIDIAN_SUPERUSER_TOTP_SECRET must be a base32 secret/);
    await expect(login(db, { ...SU })).rejects.toThrow(/Incorrect/);                                              // never a quiet sign-in without the second factor
    env('ABC');
    expect(superuserProblem()).toMatch(/at least 16/);
    env(SECRET);
    expect(superuserProblem()).toBeNull();
  });
});
