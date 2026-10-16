import { generateKeyPairSync, createSign, type JsonWebKey } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { login, createUser, changePassword, resetPassword, validateSession } from './auth.js';
import { authEndpointProblem } from './auth-provider-config.js';
import { listSignInProviders, oidcBegin, oidcFinish, rolesForGroups, setAuthHttp, setDirectoryClient, syncDirectory, runDueDirectorySyncs, verifyIdToken, type DirectoryEntry } from './auth-providers.js';
import { saveHubEndpoint } from './integration-hub.js';
import { queueOutbox } from './lifecycle-state.js';
import { deliverOtpMessages, setOtpHttp } from './otp-gateway.js';
import { requestPasswordReset } from './password-recovery.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); setAuthHttp(null); setDirectoryClient(null); setOtpHttp(null); });

const ISSUER = 'https://idp.example.com/realm';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const data = `${b64u(header)}.${b64u(claims)}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
let nextClaims: Record<string, unknown> = {};
let tokenStatus = 200;

function mockIdp() {
  setAuthHttp(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/keys` });
    if (u.endsWith('/keys')) return Response.json({ keys: [jwk] });
    if (u.endsWith('/token')) {
      if (tokenStatus !== 200) return new Response('no', { status: tokenStatus });
      const form = new URLSearchParams(String(init!.body));
      expect(form.get('code_verifier')).toBeTruthy(); expect(form.get('client_secret')).toBe('s3cret');
      return Response.json({ id_token: sign({ iss: ISSUER, aud: 'meridian', exp: now() + 300, iat: now(), ...nextClaims }) });
    }
    return new Response('?', { status: 404 });
  });
}
async function signIn(claims: Record<string, unknown>, o: { nonceOverride?: string } = {}) {
  const { url } = await oidcBegin(db, oidcId);
  const q = new URL(url).searchParams;
  expect(q.get('code_challenge_method')).toBe('S256');
  nextClaims = { nonce: o.nonceOverride ?? q.get('nonce'), ...claims };
  return { state: q.get('state')!, run: (state = q.get('state')!) => oidcFinish(db, { state, code: 'abc' }) };
}
let oidcId = '';

describe('OpenID Connect sign-in', () => {
  beforeAll(async () => {
    mockIdp();
    const ep = await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'IDP_OIDC', name: 'Entra ID', url: ISSUER, secret: 's3cret', config: { clientId: 'meridian', redirectUri: 'https://crm.example.com/login/sso', vendor: 'ENTRA', groupsClaim: 'groups', roleMappings: { 'Billing Team': 'ROLE_BILLING_OPS', 'Call Centre': 'ROLE_CALL_CENTER_AGENT', Admins: 'ROLE_ADMIN' } } });
    oidcId = ep.id;
  });

  it('lists the sign-in button without anything secret', async () => {
    const l = await listSignInProviders(db);
    expect(l).toEqual([{ id: oidcId, label: 'Sign in with Entra ID', vendor: 'ENTRA' }]);
  });
  it('creates the person on first sign-in with the role their group maps to, and uses the code once', async () => {
    const s = await signIn({ sub: 'u-1', email: 'Jane.Tan@corp.example', name: 'Jane Tan', groups: ['Billing Team', 'Other'] });
    const r = await s.run();
    expect(r.user).toMatchObject({ username: 'jane.tan', displayName: 'Jane Tan', roles: ['billing-ops'] });
    expect(await validateSession(db, r.token)).toBeTruthy();
    await expect(s.run()).rejects.toThrow(/expired|start again/);   // the state is single use
    const row = (await db.query(`SELECT auth_source, external_id, created_by FROM users WHERE username='jane.tan'`)).rows[0];
    expect(row).toMatchObject({ authSource: 'OIDC', externalId: 'u-1', createdBy: 'sso' });
  });
  it('follows a change of group on the next sign-in, and never grants the Administrator role', async () => {
    const r = await (await signIn({ sub: 'u-1', email: 'jane.tan@corp.example', name: 'Jane Tan', groups: ['Call Centre', 'Admins'] })).run();
    expect(r.user.roles).toEqual(['call-center']);
    expect(await rolesForGroups(db, ['Admins'], { Admins: 'ROLE_ADMIN' })).toEqual([]);
  });
  it('refuses a person whose groups map to no role, and a local account with the same name unless linking is on', async () => {
    await expect((await signIn({ sub: 'u-2', email: 'nobody@corp.example', groups: ['Marketing'] })).run()).rejects.toThrow(/no access/);
    await createUser(db, 'admin', { username: 'sam.lee', displayName: 'Sam Lee', roles: ['call-center'], password: 'Str0ng!Passw0rd#1' });
    await expect((await signIn({ sub: 'u-3', email: 'sam.lee@corp.example', groups: ['Call Centre'] })).run()).rejects.toThrow(/already exists/);
    expect((await db.query(`SELECT auth_source FROM users WHERE username='sam.lee'`)).rows[0]!.authSource).toBe('LOCAL');
  });
  it('rejects a response for another attempt, another audience, an expired one, an unsigned one and a refused code', async () => {
    await expect((await signIn({ sub: 'u-1', groups: ['Call Centre'] }, { nonceOverride: 'someone-elses' })).run()).rejects.toThrow(/did not match/);
    await expect((await signIn({ sub: 'u-1', aud: 'other-app', groups: ['Call Centre'] })).run()).rejects.toThrow(/different application/);
    await expect((await signIn({ sub: 'u-1', exp: now() - 3600, groups: ['Call Centre'] })).run()).rejects.toThrow(/expired/);
    tokenStatus = 400;
    await expect((await signIn({ sub: 'u-1' })).run()).rejects.toThrow(/did not accept/);
    tokenStatus = 200;
    const unsigned = `${b64u({ alg: 'none' })}.${b64u({ iss: ISSUER, aud: 'meridian', exp: now() + 99, sub: 'x', nonce: 'n' })}.`;
    await expect(verifyIdToken(unsigned, { jwks: { keys: [jwk] }, issuer: ISSUER, clientId: 'meridian', nonce: 'n' })).rejects.toThrow(/does not accept/);
    const forged = sign({ iss: ISSUER, aud: 'meridian', exp: now() + 99, sub: 'x', nonce: 'n' }).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(verifyIdToken(forged, { jwks: { keys: [jwk] }, issuer: ISSUER, clientId: 'meridian', nonce: 'n' })).rejects.toThrow(/verified/);
    await expect(oidcFinish(db, { state: 'never-issued-state', code: 'x' })).rejects.toThrow(/expired/);
  });
  it('keeps a switched-off person out and leaves password changes to the provider', async () => {
    const id = (await db.query(`SELECT id FROM users WHERE username='jane.tan'`)).rows[0]!.id;
    await expect(resetPassword(db, 'admin', id)).rejects.toThrow(/single sign-on/);
    expect(await requestPasswordReset(db, { identifier: 'jane.tan', ip: '1.1.1.1' })).toBeTruthy();
    expect((await db.query(`SELECT count(*) AS n FROM password_reset_tokens WHERE user_id=$1`, [id])).rows[0]!.n).toBe(0);
    await expect(changePassword(db, { id, username: 'jane.tan', isSuperuser: false } as never, 'x', 'y')).rejects.toThrow(/managed/);
    await db.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [id]);
    await expect((await signIn({ sub: 'u-1', groups: ['Call Centre'] })).run()).rejects.toThrow(/switched off/);
  });
});

describe('directory sync', () => {
  let ldapId = '';
  let entries: DirectoryEntry[] = [];
  const passwords = new Map<string, string>();
  beforeAll(async () => {
    setDirectoryClient({ list: async () => entries, bind: async (_ep, dn, pw) => passwords.get(dn) === pw });
    ldapId = (await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'LDAP', name: 'Corp AD', url: 'ldaps://ad.example.com:636', secret: 'bind-pw', config: { bindDn: 'CN=svc,DC=corp', baseDn: 'DC=corp', syncEveryMinutes: 60, roleMappings: { 'Retail Ops': 'ROLE_TELESALES', 'Fraud Team': 'ROLE_FRAUD_ANALYST' } } })).id;
  });
  const person = (u: string, groups: string[]): DirectoryEntry => ({ dn: `CN=${u},OU=Staff,DC=corp`, username: u, displayName: u.toUpperCase(), email: `${u}@corp.example`, phone: null, groups });

  it('creates people with the role their group maps to, skips unmapped people and never touches a local account', async () => {
    entries = [person('amy', ['Retail Ops']), person('raj', ['Fraud Team']), person('zed', ['Cafeteria']), person('sam.lee', ['Retail Ops'])];
    const r = await syncDirectory(db, ldapId, 'test');
    expect(r).toMatchObject({ created: 2, skipped: 2, total: 4 });
    expect((await db.query(`SELECT roles, auth_source FROM users WHERE username='amy'`)).rows[0]).toMatchObject({ roles: ['telesales'], authSource: 'LDAP' });
    expect((await db.query(`SELECT auth_source FROM users WHERE username='sam.lee'`)).rows[0]!.authSource).toBe('LOCAL');
  });
  it('signs a directory user in with their directory password, and refuses a wrong or empty one', async () => {
    passwords.set('CN=amy,OU=Staff,DC=corp', 'DirPassw0rd!');
    expect((await login(db, { username: 'amy', password: 'DirPassw0rd!' })).user.roles).toEqual(['telesales']);
    await expect(login(db, { username: 'amy', password: 'wrong' })).rejects.toThrow(/incorrect|invalid|Sign-in/i);
    await expect(login(db, { username: 'amy', password: ' ' })).rejects.toThrow();
  });
  it('updates changed roles, switches off people who left or lost their group, and ignores an empty directory answer', async () => {
    entries = [person('amy', ['Fraud Team'])];
    const r = await syncDirectory(db, ldapId);
    expect(r).toMatchObject({ updated: 1, disabled: 1 });
    expect((await db.query(`SELECT roles FROM users WHERE username='amy'`)).rows[0]!.roles).toEqual(['fraud']);
    expect((await db.query(`SELECT status FROM users WHERE username='raj'`)).rows[0]!.status).toBe('DISABLED');
    entries = [];
    expect(await syncDirectory(db, ldapId)).toMatchObject({ disabled: 0, total: 0 });
    expect((await db.query(`SELECT status FROM users WHERE username='amy'`)).rows[0]!.status).toBe('ACTIVE');
  });
  it('runs on schedule only when due', async () => {
    expect(await runDueDirectorySyncs(db)).toEqual({ ran: 0, failed: 0 });   // synced a moment ago
    await db.query(`UPDATE directory_sync_runs SET started_at = now() - interval '2 hours'`);
    expect(await runDueDirectorySyncs(db)).toEqual({ ran: 1, failed: 0 });
  });
});

describe('SMS / WhatsApp gateway', () => {
  let calls: Array<{ url: string; auth: string | null; body: any }> = [];
  let status = 200;
  beforeEach(() => { calls = []; status = 200; setOtpHttp(async (url, init) => { calls.push({ url: String(url), auth: (init!.headers as Record<string, string>).authorization ?? null, body: JSON.parse(String(init!.body)) }); return new Response('{}', { status }); }); });
  const queue = (code: string, channel = 'SMS') => queueOutbox(db, { kind: 'NOTIFY', instruction: 'MFA_OTP', payload: { channel, to: '+6591234567', name: 'Amy', code, purpose: 'LOGIN', expiresAt: new Date(Date.now() + 600_000).toISOString() } });

  it('does nothing until a gateway is configured, then sends waiting codes and forgets them', async () => {
    await queue('111111');
    expect(await deliverOtpMessages(db)).toEqual({ sent: 0, failed: 0, waiting: 0 });
    await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'Twilio', url: 'https://sms.example.com/send', secret: 'tok-123', config: { deliver: 'WHATSAPP', senderId: 'Meridian', templateIds: { MFA: 'tpl_mfa' } } });
    await queue('222222'); await queue('333333', 'EMAIL');
    const r = await deliverOtpMessages(db);
    expect(r).toMatchObject({ sent: 2, failed: 0 });
    expect(calls[0]).toMatchObject({ url: 'https://sms.example.com/send', auth: 'Bearer tok-123', body: { to: '+6591234567', channel: 'WHATSAPP', templateId: 'tpl_mfa', senderId: 'Meridian', variables: { code: '111111' } } });
    const left = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='MFA_OTP' ORDER BY id`)).rows;
    expect(JSON.stringify(left)).not.toMatch(/111111|222222/);
    expect(left[2]!.payload.code).toBe('333333');   // e-mail codes are not the gateway's job
  });
  it('leaves a code in the outbox when the gateway is down, to be tried again', async () => {
    await queue('444444'); status = 503;
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 0, failed: 1 });
    status = 200;
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 1, failed: 0 });
  });
});

describe('settings checks', () => {
  it('explains what is wrong with each kind of sign-in integration', () => {
    expect(authEndpointProblem('IDP_OIDC', { url: ISSUER, config: { redirectUri: 'https://x/login/sso' } })).toMatch(/client id/);
    expect(authEndpointProblem('IDP_OIDC', { config: { clientId: 'a', redirectUri: 'https://x' } })).toMatch(/issuer/);
    expect(authEndpointProblem('IDP_SAML', { url: 'https://idp/sso', config: { entityId: 'e', certificate: 'nope' } })).toMatch(/certificate/);
    expect(authEndpointProblem('LDAP', { url: 'http://ad', config: { bindDn: 'a', baseDn: 'b' } })).toMatch(/ldaps/);
    expect(authEndpointProblem('LDAP', { url: 'ldaps://ad', config: { bindDn: 'a', baseDn: 'b', syncEveryMinutes: 5 } })).toMatch(/15/);
    expect(authEndpointProblem('OTP_GATEWAY', { url: 'https://g', config: { deliver: 'FAX' } })).toMatch(/SMS or WHATSAPP/);
    expect(authEndpointProblem('OTP_GATEWAY', { url: 'https://g', config: { roleMappings: { a: 1 } } })).toMatch(/Role mappings/);
    expect(authEndpointProblem('LDAP', { url: 'ldaps://ad', config: { bindDn: 'a', baseDn: 'b', syncEveryMinutes: 60 } })).toBeNull();
  });
});
