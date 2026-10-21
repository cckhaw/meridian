import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as core from '@meridian/core';
import type { Db } from '@meridian/core';
import { dispatch } from './router';

// The hub's sign-in codes end to end: login queues and delivers, "send me a code" resends under the CRM's throttling, and no answer tells an outsider whether an account exists.
process.env.MERIDIAN_SUPERUSER_USERNAME = 'root-admin';
process.env.MERIDIAN_SUPERUSER_PASSWORD = 'Correct-Horse-Battery-9';
process.env.MERIDIAN_SEED = 'none';
delete process.env.DATABASE_URL;
const ORIGIN = 'http://fiber.test';
const PW = 'Sturdy-Pass-Word-1';

let db: Db; let n = 0;
async function call(path: string, body: unknown, ip = '203.0.113.7') {
  const res = await dispatch(new Request(ORIGIN + path, { method: 'POST', headers: { host: 'fiber.test', origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) }), path.replace(/^\/api\//, '').split('/'));
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
}
const signIn = (username: string, ip?: string) => call('/api/admin/login', { username, password: PW }, ip);
const sendCode = (challenge: string, method: string, ip?: string) => call('/api/admin/2fa/send-code', { challenge, method }, ip);
const verify = (challenge: string, code: string) => call('/api/admin/verify-2fa', { challenge, code });
/** Lets the 30 second wait pass without waiting. */
const waited = () => db.query(`UPDATE auth_attempts SET at = now() - interval '2 minutes' WHERE key LIKE 'mfa-send:%' AND key NOT LIKE 'mfa-send:ip:%'`);
const outbox = async () => Number((await db.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='MFA_OTP'`)).rows[0]!.n);

async function person(methods: Array<'TOTP' | 'SMS' | 'EMAIL'>, roles = ['call-center']) {
  const username = `hub.user${++n}`, phone = `+65912345${String(10 + n).padStart(2, '0')}`, email = `hub${n}@example.com`;
  const { user } = await core.createUser(db, 'admin', { username, displayName: `Hub ${n}`, roles, email, phone, password: PW });
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
  const u = { id: user.id, name: `Hub ${n}`, username, email, phone };
  let secret = '';
  // e-mail can only be set up while e-mail codes are available: borrow a sender and the switch for the set-up, then put things back
  const before = await core.emailCodesStatus(db), policyBefore = (await core.getSecurityPolicy(db)).email.codesEnabled;
  if (methods.includes('EMAIL') && !before.available) {
    await core.setSecurityPolicy(db, 'admin', { email: { codesEnabled: true } as never });
    if (!before.senderEnabled) await core.saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'EMAIL_GATEWAY', name: 'Temp', config: { mode: 'SIMULATOR', fromName: 'M', fromAddress: 'm@example.com' } });
  }
  try {
  for (const m of methods) {
    if (m === 'TOTP') { secret = (await core.beginTotp(db, u)).secret; await core.confirmTotp(db, u, core.hotp(core.base32Decode(secret), core.totpCounter())); }
    else { await core.beginOtpMethod(db, u, m); await core.confirmOtpMethod(db, u, m, (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='MFA_OTP' ORDER BY id DESC LIMIT 1`)).rows[0]!.payload.code); }
  }
  } finally {
    if (methods.includes('EMAIL') && !before.available) {
      if (!before.senderEnabled) await db.query(`DELETE FROM integration_endpoints WHERE name='Temp' AND kind='EMAIL_GATEWAY'`);
      await core.setSecurityPolicy(db, 'admin', { email: { codesEnabled: policyBefore } as never });
    }
  }
  return { ...u, totp: () => core.hotp(core.base32Decode(secret), core.totpCounter()) };
}

let sent: any[] = []; let gatewayStatus = 200;
beforeAll(async () => {
  db = await core.getDb();
  core.setOtpHttp(async (_u, init) => { const b = JSON.parse(String(init!.body)); if (gatewayStatus === 200) sent.push(b); return new Response('{}', { status: gatewayStatus }); });
  // e-mail goes through the e-mail sender; record it in the same shape as the gateway's messages so the tests read alike
  core.setEmailHttp(async (_u, init) => { const b = JSON.parse(String(init!.body)); if (gatewayStatus === 200) sent.push({ to: b.to, channel: 'EMAIL', variables: { code: /\b(\d{6})\b/.exec(b.text)?.[1] } }); return new Response('{}', { status: gatewayStatus }); });
});
afterAll(async () => { core.setOtpHttp(null); core.setEmailHttp(null); core.setOtpRelayHttp(null); await db.close(); });
afterEach(async () => { gatewayStatus = 200; sent = []; delete process.env.MERIDIAN_CRM_URL; delete process.env.MERIDIAN_FIBER_API_KEY; core.setOtpRelayHttp(null); await db.query('DELETE FROM auth_attempts'); });
/** The SMS gateway, and (unless `email` is false) the e-mail sender plus the policy switch for e-mail codes. */
const gateway = async (email = true) => {
  await db.query('DELETE FROM integration_endpoints');
  await core.setSecurityPolicy(db, 'admin', { email: { codesEnabled: email } as never });
  if (email) await core.saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'EMAIL_GATEWAY', name: 'Mail', url: 'https://mail.example.com/send', secret: 'mail-token-123', config: { mode: 'API', fromName: 'Meridian', fromAddress: 'noreply@example.com', bodyTemplate: '{"to":"{{to}}","subject":"{{subject}}","text":"{{text}}"}' } });
  return core.saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'GW', url: 'https://sms.example.com/send', secret: 'tok-0123456789', config: {} });
};
const noGateway = async () => { await db.query('DELETE FROM integration_endpoints'); await core.setSecurityPolicy(db, 'admin', { email: { codesEnabled: true } as never }); };

describe('the hub sign-in step', () => {
  it('offers only what the person has: an authenticator-only person gets no code to send and no SMS or e-mail wording to hide behind', async () => {
    await gateway();
    const u = await person(['TOTP']);
    sent = [];                                                         // the set-up raised a security alert, which goes out by e-mail now
    const r = await signIn(u.username);
    expect(r.json).toMatchObject({ mfaRequired: true, challenge: { methods: ['TOTP'], method: 'TOTP' } });
    expect(r.json.challenge.sentTo).toBeUndefined(); expect(r.json.delivery).toBeUndefined();
    expect(sent).toHaveLength(0);
    const ask = await sendCode(r.json.challenge.token, 'SMS');
    expect(ask.status).toBe(400); expect(ask.json.error.message).toMatch(/not set up/);
    expect(sent).toHaveLength(0);
    // the authenticator code still works: it passes the second factor (this hub then only lets in people whose role holds Settings or Integration)
    expect((await verify(r.json.challenge.token, '000000')).status).toBe(401);
    await db.query(`UPDATE mfa_methods SET last_counter=0 WHERE user_id=$1`, [u.id]);   // the set-up used this step's code; a code works once
    const ok = await verify(r.json.challenge.token, u.totp());
    expect(ok.status).toBe(403); expect(ok.json.error.message).toMatch(/may not manage fibre coverage/); expect(ok.headers.get('set-cookie')).toBeNull();
  });

  it('admits staff whose role holds Settings or Integration after their second factor, and still refuses the rest', async () => {
    await gateway();
    for (const [name, perm] of [['Hub settings', 'settings:manage'], ['Hub integration', 'integration:manage']] as const) {
      const role = await core.createCustomRole(db, 'root', { name, permissions: ['dashboard:read', perm] }, true);
      const u = await person(['TOTP'], [role.id]);
      const r = await signIn(u.username);
      expect(r.json).toMatchObject({ mfaRequired: true });
      await db.query(`UPDATE mfa_methods SET last_counter=0 WHERE user_id=$1`, [u.id]);
      const ok = await verify(r.json.challenge.token, u.totp());
      expect(ok.status).toBe(200); expect(ok.json.user.username).toBe(u.username);
      const cookie = /(?:__Host-)?fiber_session=[^;]+/.exec(ok.headers.get('set-cookie') ?? '')?.[0];
      expect(cookie).toBeTruthy();
      const me = await dispatch(new Request(ORIGIN + '/api/admin/me', { headers: { host: 'fiber.test', origin: ORIGIN, cookie: cookie! } }), ['admin', 'me']);
      expect(me.status).toBe(200);
      await db.query(`DELETE FROM sessions WHERE user_id=$1`, [u.id]); await db.query(`DELETE FROM mfa_methods WHERE user_id=$1`, [u.id]); await db.query(`DELETE FROM users WHERE id=$1`, [u.id]);
      await core.deleteCustomRole(db, 'root', role.id, true);
    }
  });

  it('delivers the code queued at sign-in itself, through the gateway, and shows the channel only masked', async () => {
    await gateway();
    const u = await person(['SMS', 'EMAIL']);
    sent = [];
    const r = await signIn(u.username);
    expect(r.json).toMatchObject({ mfaRequired: true, delivery: 'SENT', canSend: { SMS: true, EMAIL: true }, challenge: { method: 'EMAIL', methods: ['EMAIL', 'SMS'], resendAfterSeconds: 30 } });
    expect(r.json.challenge.sentTo).toMatch(/•••/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: u.email, channel: 'EMAIL', variables: { code: expect.stringMatching(/^\d{6}$/) } });
    expect(r.text).not.toContain(u.email); expect(r.text).not.toContain(sent[0].variables.code);
    const second = await verify(r.json.challenge.token, sent[0].variables.code);   // the delivered code is the real one
    expect(second.status).toBe(403);   // second factor passed; see above for why the hub then declines
  });

  it('sends a code another way on request, waits 30 seconds per method, and says how long', async () => {
    await gateway();
    const u = await person(['SMS', 'EMAIL']);
    const ch = (await signIn(u.username)).json.challenge;
    sent = [];
    const again = await sendCode(ch.token, 'EMAIL');
    expect(again.status).toBe(429); expect(again.json.error.code).toBe('RATE_LIMITED');
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0); expect(Number(again.headers.get('retry-after'))).toBeLessThanOrEqual(30);
    expect(sent).toHaveLength(0);
    const sms = await sendCode(ch.token, 'SMS');
    expect(sms.status).toBe(200);
    expect(sms.json).toMatchObject({ method: 'SMS', delivery: 'SENT', resendAfterSeconds: 30, sentTo: expect.stringMatching(/^\+65•••\d\d$/) });
    expect(sms.text).not.toContain(u.phone);
    expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ to: u.phone, channel: 'SMS' });
    await waited();
    expect((await sendCode(ch.token, 'SMS')).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ to: u.phone });
    expect((await verify(ch.token, sent.at(-1).variables.code)).status).toBe(403);
  });

  it('limits requests per address, and 429s with a wait', async () => {
    await gateway();
    let last = await sendCode('x'.repeat(40), 'SMS', '198.51.100.9');
    for (let i = 1; i < 30; i++) last = await sendCode('x'.repeat(40), 'SMS', '198.51.100.9');
    expect(last.status).toBe(401);                                    // thirty tries, all answered like an expired sign-in
    const blocked = await sendCode('x'.repeat(40), 'SMS', '198.51.100.9');
    expect(blocked.status).toBe(429); expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await sendCode('x'.repeat(40), 'SMS', '198.51.100.10')).status).toBe(401);   // another address is not affected
  });

  it('never reveals whether an account exists, and never sends to someone else', async () => {
    await gateway();
    const a = await person(['SMS']), b = await person(['TOTP']);
    const wrongPassword = await call('/api/admin/login', { username: a.username, password: 'Wrong-Password-1!' });
    const noSuchUser = await call('/api/admin/login', { username: 'nobody.at.all', password: 'Wrong-Password-1!' });
    expect(wrongPassword.status).toBe(401); expect(noSuchUser.status).toBe(401);
    expect(noSuchUser.json).toEqual(wrongPassword.json);
    const chA = (await signIn(a.username)).json.challenge, chB = (await signIn(b.username)).json.challenge;
    sent = [];
    await waited();
    // B asks for an SMS code: B has none set up, so nothing goes to A's phone or anyone's, and the answer says nothing about other accounts
    const forB = await sendCode(chB.token, 'SMS');
    expect(forB.status).toBe(400); expect(sent).toHaveLength(0); expect(forB.text).not.toContain(a.phone);
    // a token that never existed and one that ran out are answered identically
    await db.query(`UPDATE mfa_challenges SET expires_at = now() - interval '1 minute' WHERE token_hash IS NOT NULL AND user_id=$1`, [a.id]);
    const expired = await sendCode(chA.token, 'SMS'), unknown = await sendCode('y'.repeat(43), 'SMS');
    expect(expired.status).toBe(401); expect(expired.json).toEqual(unknown.json); expect(expired.json.error.message).toBe('This sign-in has expired. Sign in again.');
    expect(sent).toHaveLength(0);
  });

  it('applies the account lock and the wrong-code limit the CRM applies', async () => {
    await gateway();
    const u = await person(['SMS', 'EMAIL']);
    const ch = (await signIn(u.username)).json.challenge;
    await db.query(`UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id=$1`, [u.id]);
    await waited(); sent = [];
    const locked = await sendCode(ch.token, 'SMS');
    expect(locked.status).toBe(401); expect(locked.json.error.message).toMatch(/locked/); expect(sent).toHaveLength(0);
    await db.query(`UPDATE users SET locked_until = NULL WHERE id=$1`, [u.id]);
    for (let i = 0; i < 5; i++) expect((await verify(ch.token, '000000')).status).toBe(401);
    sent = []; await sendCode(ch.token, 'SMS');                       // a fresh code resets that sign-in's tries, within the five-codes limit
    expect(sent).toHaveLength(1);
  });
});

describe('when the hub cannot send the code itself', () => {
  it('says so plainly when no gateway is set up, and queues nothing', async () => {
    await noGateway();
    const u = await person(['SMS', 'EMAIL']);
    const r = await signIn(u.username);
    expect(r.json).toMatchObject({ mfaRequired: true, canSend: { SMS: false, EMAIL: false }, delivery: 'PENDING' });   // queued at sign-in for whatever delivers the CRM's codes
    const before = await outbox();
    await waited();
    const ask = await sendCode(r.json.challenge.token, 'SMS');
    expect(ask.status).toBe(503); expect(ask.json.error.code).toBe('CODE_DELIVERY_UNAVAILABLE');
    expect(ask.json.error.message).toMatch(/no SMS gateway is set up.*authenticator app or a recovery code/);
    expect(await outbox()).toBe(before);
  });

  it('carries SMS but not e-mail unless e-mail codes are on and an e-mail sender is enabled', async () => {
    await gateway(false);
    const early = await person(['SMS']);                                                    // e-mail cannot even be set up while it is off
    await expect(core.beginOtpMethod(db, { id: early.id, name: 'E', email: early.email, phone: early.phone }, 'EMAIL')).rejects.toThrow(/not available/);
    await gateway(true);
    await db.query(`DELETE FROM integration_endpoints WHERE kind='EMAIL_GATEWAY'`);        // switch on, but no sender
    const u0 = await person(['SMS']);
    expect((await signIn(u0.username)).json.canSend).toEqual({ SMS: true, EMAIL: false });
    await gateway(true); await core.setSecurityPolicy(db, 'admin', { email: { codesEnabled: false } as never });
    expect((await signIn(u0.username)).json.canSend).toEqual({ SMS: true, EMAIL: false });
    const r = await signIn(u0.username);
    await waited();
    const ask = await sendCode(r.json.challenge.token, 'EMAIL');
    expect(ask.status).toBe(503); expect(ask.json.error.message).toMatch(/e-mail are not available here.*Security policy.*e-mail sender/);
    expect((await sendCode(r.json.challenge.token, 'SMS')).status).toBe(200);
  });

  it('asks the CRM, with a signed call, when the gateway is out of reach from the hub, and says "not sent yet" when that fails too', async () => {
    await gateway();
    const u = await person(['SMS']);
    gatewayStatus = 503;
    process.env.MERIDIAN_CRM_URL = 'https://crm.example.com'; process.env.MERIDIAN_FIBER_API_KEY = 'mk_test_0123456789abcdef0123456789abcdef';
    const relayed: Array<{ url: string; sig: string; body: string }> = [];
    core.setOtpRelayHttp(async (url, init) => { relayed.push({ url, sig: (init!.headers as any)['x-meridian-signature'], body: String(init!.body) }); return Response.json({ sent: 1, failed: 0, waiting: 0 }); });
    const r = await signIn(u.username);
    expect(r.json.delivery).toBe('SENT');
    expect(relayed).toHaveLength(1); expect(relayed[0]!.url).toBe('https://crm.example.com/api/internal/fiber/deliver-otp');
    expect(JSON.parse(relayed[0]!.body)).toEqual({ to: u.phone }); expect(relayed[0]!.sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // the CRM would accept that call: same body, same signature
    await expect(core.handleOtpRelay(db, relayed[0]!.body, relayed[0]!.sig)).resolves.toBeDefined();

    core.setOtpRelayHttp(async () => new Response('down', { status: 502 }));
    await waited();
    const again = await sendCode(r.json.challenge.token, 'SMS');
    expect(again.status).toBe(200); expect(again.json.delivery).toBe('PENDING');
    delete process.env.MERIDIAN_CRM_URL;
    await waited();
    expect((await sendCode(r.json.challenge.token, 'SMS')).json.delivery).toBe('PENDING');
  });
});
