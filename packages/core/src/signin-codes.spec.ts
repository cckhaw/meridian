import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, MfaRequired, verifyMfaLogin } from './auth.js';
import { authEndpointProblem } from './auth-provider-config.js';
import type { Db } from './db.js';
import { saveHubEndpoint } from './integration-hub.js';
import { beginOtpMethod, challengeRecipient, CODE_RESEND_SECONDS, CODES_PER_SIGN_IN, CodeThrottled, confirmOtpMethod, sendChallengeCode } from './mfa.js';
import { deliverOtpMessages, otpGatewayStatus, setOtpHttp } from './otp-gateway.js';
import { handleOtpRelay, otpRelayConfigured, relayOtpDelivery, setOtpRelayHttp } from './otp-relay.js';
import { defaultSecurityPolicy, setSecurityPolicy } from './security-policy.js';
import { freshDb } from './test-helpers.js';
import { wfmSignature } from './wfm-webhook.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
const PW = 'Sturdy-Pass-Word-1';
let db: Db; let n = 0;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); setOtpHttp(null); setOtpRelayHttp(null); });
beforeEach(() => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; });
afterEach(async () => { await db.query('DELETE FROM auth_attempts'); await setSecurityPolicy(db, 't', defaultSecurityPolicy()); });

const lastOtp = async () => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='MFA_OTP' ORDER BY id DESC LIMIT 1`)).rows[0]?.payload;
/** A person with SMS and e-mail codes set up. */
async function smsAndEmail() {
  const username = `codes.user${++n}`, phone = '+6591234567', email = `c${n}@example.com`;
  const { user } = await createUser(db, 'admin', { username, displayName: `Codes ${n}`, roles: ['call-center'], email, phone, password: PW });
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
  const u = { id: user.id, name: `Codes ${n}`, username, email, phone };
  for (const kind of ['SMS', 'EMAIL'] as const) { await beginOtpMethod(db, u, kind); await confirmOtpMethod(db, u, kind, (await lastOtp()).code); }
  return u;
}
const challengeOf = async (username: string) => { try { await login(db, { username, password: PW }); } catch (e) { if (e instanceof MfaRequired) return e.challenge; throw e; } throw new Error('no challenge'); };
const throttled = async (p: Promise<unknown>) => p.then(() => null, (e) => e as CodeThrottled);

describe('resending a sign-in code', () => {
  it('waits 30 seconds per method, lets the person switch method, and names how long to wait', async () => {
    const u = await smsAndEmail();
    const ch = await challengeOf(u.username);
    expect(ch).toMatchObject({ method: 'EMAIL', resendAfterSeconds: CODE_RESEND_SECONDS });   // the code that went out at sign-in already counts
    const e = await throttled(sendChallengeCode(db, ch.token, 'EMAIL'));
    expect(e).toBeInstanceOf(CodeThrottled); expect(e!.code).toBe('RATE_LIMITED'); expect(e!.status).toBe(429);
    expect(e!.retryAfterSeconds).toBeGreaterThan(0); expect(e!.retryAfterSeconds).toBeLessThanOrEqual(CODE_RESEND_SECONDS);
    const sms = await sendChallengeCode(db, ch.token, 'SMS');                               // another way is fine
    expect(sms).toEqual({ sentTo: '+65•••67', resendAfterSeconds: CODE_RESEND_SECONDS });
    await db.query(`UPDATE auth_attempts SET at = now() - interval '31 seconds' WHERE key LIKE 'mfa-send:%:SMS'`);
    expect((await sendChallengeCode(db, ch.token, 'SMS')).sentTo).toBe('+65•••67');          // after the wait, the same method again
    const code = (await lastOtp()).code;
    expect((await verifyMfaLogin(db, { challenge: ch.token, code })).user.username).toBe(u.username);
  });

  it('stops after five codes for one sign-in, and ten for one account in an hour', async () => {
    const u = await smsAndEmail();
    const ch = await challengeOf(u.username);                                                // 1
    for (let i = 1; i < CODES_PER_SIGN_IN; i++) {
      await db.query(`UPDATE auth_attempts SET at = now() - interval '1 minute' WHERE key LIKE 'mfa-send:%'`);
      await sendChallengeCode(db, ch.token, i % 2 ? 'SMS' : 'EMAIL');
    }
    await db.query(`UPDATE auth_attempts SET at = now() - interval '1 minute' WHERE key LIKE 'mfa-send:%'`);
    await expect(sendChallengeCode(db, ch.token, 'SMS')).rejects.toThrow(/Too many codes were sent for this sign-in/);
    // a fresh sign-in has its own five, but the account has only ten an hour
    for (let round = 0; round < 2; round++) {
      const c = await challengeOf(u.username);
      for (let i = 1; i < 3; i++) { await db.query(`UPDATE auth_attempts SET at = now() - interval '1 minute' WHERE key LIKE 'mfa-send:%'`); await sendChallengeCode(db, c.token, i % 2 ? 'SMS' : 'EMAIL').catch((e) => { expect(e).toBeInstanceOf(CodeThrottled); }); }
    }
    await db.query(`UPDATE auth_attempts SET at = now() - interval '1 minute' WHERE key LIKE 'mfa-send:%'`);
    const last = await challengeOf(u.username);
    await db.query(`UPDATE auth_attempts SET at = now() - interval '1 minute' WHERE key LIKE 'mfa-send:%'`);
    await expect(sendChallengeCode(db, last.token, 'SMS')).rejects.toThrow(/lately/);
  });

  it('refuses a locked account, a method the policy has turned off, and a sign-in that never existed or ran out, all the same way for the last', async () => {
    const u = await smsAndEmail();
    const ch = await challengeOf(u.username);
    await setSecurityPolicy(db, 't', { mfa: { methods: ['TOTP', 'EMAIL'] } as never });
    await expect(sendChallengeCode(db, ch.token, 'SMS')).rejects.toThrow(/not set up/);
    await setSecurityPolicy(db, 't', defaultSecurityPolicy());
    await db.query(`UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id=$1`, [u.id]);
    await expect(sendChallengeCode(db, ch.token, 'SMS')).rejects.toThrow(/locked/);
    await db.query(`UPDATE users SET locked_until = NULL WHERE id=$1`, [u.id]);
    await db.query(`UPDATE mfa_challenges SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [u.id]);
    const expired = (await sendChallengeCode(db, ch.token, 'SMS').catch((e) => e)) as Error;
    const unknown = (await sendChallengeCode(db, 'x'.repeat(43), 'SMS').catch((e) => e)) as Error;
    expect(expired.message).toBe('This sign-in has expired. Sign in again.');
    expect(unknown.message).toBe(expired.message);
  });

  it('names the raw recipient only to the server that delivers the code', async () => {
    const u = await smsAndEmail();
    const ch = await challengeOf(u.username);
    expect(await challengeRecipient(db, ch.token)).toBe(u.email);
    await sendChallengeCode(db, ch.token, 'SMS').catch(() => undefined);
    expect(await challengeRecipient(db, 'nope'.repeat(10))).toBeNull();
  });
});

describe('the gateway and sign-in codes', () => {
  let calls: any[] = [];
  beforeEach(() => { calls = []; setOtpHttp(async (_url, init) => { calls.push(JSON.parse(String(init!.body))); return new Response('{}'); }); });

  it('says what the gateway can carry, and carries e-mail codes only when the administrator opted in', async () => {
    expect(await otpGatewayStatus(db)).toEqual({ configured: false, sms: false, email: false });
    expect(authEndpointProblem('OTP_GATEWAY', { url: 'https://g.example.com', config: { emailCodes: 'yes' } })).toMatch(/true or false/);
    const ep = await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'GW', url: 'https://g.example.com/send', secret: 'tok-123456' });
    expect(await otpGatewayStatus(db)).toEqual({ configured: true, sms: true, email: false });
    const u = await smsAndEmail();
    await db.query(`DELETE FROM lifecycle_outbox WHERE instruction='MFA_OTP'`);              // leftovers of the set-up and of earlier tests
    const ch = await challengeOf(u.username);                                                // an e-mail code is waiting
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(0);
    await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'GW', url: 'https://g.example.com/send', config: { emailCodes: true } }, ep.id);
    expect(await otpGatewayStatus(db)).toEqual({ configured: true, sms: true, email: true });
    expect(await deliverOtpMessages(db, 25, { to: 'someone.else@example.com' })).toMatchObject({ sent: 0 });   // only the recipient asked for
    expect(await deliverOtpMessages(db, 25, { to: u.email })).toMatchObject({ sent: 1, failed: 0 });
    expect(calls[0]).toMatchObject({ to: u.email, channel: 'EMAIL', subject: expect.any(String), variables: { code: expect.stringMatching(/^\d{6}$/) } });
    expect((await lastOtp()).code).toBeUndefined();                                            // not kept once sent
    expect(ch.method).toBe('EMAIL');
    await db.query(`DELETE FROM integration_endpoints`);
  });
});

describe('asking the CRM to deliver (signed)', () => {
  const KEY = 'mk_test_0123456789abcdef0123456789abcdef';
  let seen: Array<{ url: string; sig: string | null; body: string }> = [];
  beforeEach(() => { seen = []; process.env.MERIDIAN_CRM_URL = 'https://crm.example.com/'; process.env.MERIDIAN_FIBER_API_KEY = KEY; });
  afterEach(() => { delete process.env.MERIDIAN_CRM_URL; delete process.env.MERIDIAN_FIBER_API_KEY; setOtpRelayHttp(null); });

  it('is not available until the CRM address and the shared key are both set', async () => {
    delete process.env.MERIDIAN_CRM_URL;
    expect(otpRelayConfigured()).toBe(false);
    expect(await relayOtpDelivery('+6591234567')).toBeNull();
    process.env.MERIDIAN_CRM_URL = 'http://crm.example.com';                                   // plain http to another host is refused
    expect(otpRelayConfigured()).toBe(false);
    process.env.MERIDIAN_CRM_URL = 'https://crm.example.com';
    expect(otpRelayConfigured()).toBe(true);
  });
  it('signs what it sends, and the CRM side accepts exactly that and nothing else', async () => {
    setOtpRelayHttp(async (url, init) => { seen.push({ url, sig: (init!.headers as Record<string, string>)['x-meridian-signature'] ?? null, body: String(init!.body) }); return Response.json({ sent: 1, failed: 0, waiting: 0 }); });
    expect(await relayOtpDelivery('+6591234567')).toEqual({ sent: 1, failed: 0, waiting: 0 });
    expect(seen[0]!.url).toBe('https://crm.example.com/api/internal/fiber/deliver-otp');
    expect(JSON.parse(seen[0]!.body)).toEqual({ to: '+6591234567' });                           // no code, no key, no token
    expect(seen[0]!.body + (seen[0]!.sig ?? '')).not.toContain(KEY);

    setOtpHttp(async () => new Response('{}'));
    await expect(handleOtpRelay(db, seen[0]!.body, seen[0]!.sig)).resolves.toMatchObject({ failed: 0 });
    await expect(handleOtpRelay(db, seen[0]!.body, null)).rejects.toThrow(/invalid signature/);
    await expect(handleOtpRelay(db, seen[0]!.body.replace('91234567', '99999999'), seen[0]!.sig)).rejects.toThrow(/invalid signature/);   // body changed
    await expect(handleOtpRelay(db, seen[0]!.body, wfmSignature(seen[0]!.body, 'another-secret-of-some-length'))).rejects.toThrow(/invalid signature/);
    await expect(handleOtpRelay(db, seen[0]!.body, wfmSignature(seen[0]!.body, 'x'.repeat(64), Date.now() - 3_600_000))).rejects.toThrow(/invalid signature/);   // stale
    delete process.env.MERIDIAN_FIBER_API_KEY;
    await expect(handleOtpRelay(db, seen[0]!.body, seen[0]!.sig)).rejects.toThrow(/not found/);   // the CRM without the key behaves as if the route does not exist
  });
  it('gives up quietly when the CRM does not answer', async () => {
    setOtpRelayHttp(async () => { throw new Error('connect ECONNREFUSED'); });
    expect(await relayOtpDelivery('+6591234567')).toBeNull();
    setOtpRelayHttp(async () => new Response('no', { status: 401 }));
    expect(await relayOtpDelivery('+6591234567')).toBeNull();
  });
});
