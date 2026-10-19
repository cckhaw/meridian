import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import { createUser, login, MfaRequired } from './auth.js';
import type { Db } from './db.js';
import { authEndpointProblem } from './auth-provider-config.js';
import { emailCodesStatus, emailSenderStatus, listSimulatedEmails, sendEmail, setEmailHttp, testEmail } from './email-gateway.js';
import { EMAIL_PRESETS, emailGatewayProblem, parseBodyTemplate, renderBodyTemplate } from './email-gateway-config.js';
import { deliverOtpMessages, setOtpHttp } from './otp-gateway.js';
import { saveHubEndpoint } from './integration-hub.js';
import { ensureStarterTemplates } from './doc-templates.js';
import { beginOtpMethod, confirmOtpMethod, openLoginChallenge } from './mfa.js';
import { placeOrder } from './orders.js';
import { requestPasswordReset } from './password-recovery.js';
import { defaultSecurityPolicy, getSecurityPolicy, setSecurityPolicy } from './security-policy.js';
import { deliverSignedCopies, retryFailedSignedCopies, signedCopyStatus } from './signed-copies.js';
import { freshDb, newCustomer, signatureDataUrl } from './test-helpers.js';
import { deliverUserAlerts, notificationChannelStatus, notifyUser } from './user-notifications.js';
import { MIGRATIONS } from './migrations.generated.js';

let db: Db; let n = 0;
let mails: Array<{ url: string; headers: Record<string, string>; body: any; redirect?: string }> = [];
let answer: () => Response | Promise<Response> = () => new Response('{}');
let sms: any[] = []; let smsStatus = 200;
const TOKEN = 'tok-SECRET-0123456789';
const PW = 'Sturdy-Pass-Word-1';
const API = { mode: 'API', fromName: 'Meridian Telecom', fromAddress: 'noreply@example.com', replyTo: 'help@example.com', auth: 'BEARER', bodyTemplate: EMAIL_PRESETS[0]!.bodyTemplate };

beforeAll(async () => { db = await freshDb(); await ensureStarterTemplates(db, { username: 'root' }); });
afterAll(async () => { await db.close(); setEmailHttp(null); setOtpHttp(null); });
beforeEach(() => {
  mails = []; sms = []; smsStatus = 200; answer = () => new Response('{}');
  setEmailHttp(async (url, init) => { mails.push({ url, headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)), redirect: init!.redirect as string }); return answer(); });
  setOtpHttp(async (_u, init) => { sms.push(JSON.parse(String(init!.body))); return new Response('{}', { status: smsStatus }); });
});
afterEach(async () => {
  await db.query(`DELETE FROM integration_endpoints`); await db.query('DELETE FROM simulated_emails'); await db.query('DELETE FROM auth_attempts');
  await setSecurityPolicy(db, 't', defaultSecurityPolicy());
});

const addSender = (config: Record<string, unknown> = {}, o: { url?: string | null; secret?: string; enabled?: boolean; timeoutMs?: number } = {}) =>
  saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'EMAIL_GATEWAY', name: 'Mail', url: o.url === undefined ? 'https://mail.example.com/v1/send' : o.url, secret: o.secret ?? TOKEN, enabled: o.enabled, timeoutMs: o.timeoutMs, config: { ...API, ...config } });
const addGateway = () => saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'GW', url: 'https://sms.example.com/send', secret: 'sms-tok', config: {} });
const msg = { to: 'amy@example.com', subject: 'Hello', text: 'Plain text' };

describe('the settings of the sender', () => {
  it('checks every mode and says what is wrong in plain words', () => {
    const ok = (config: Record<string, unknown>, url: string | null = 'https://m.example.com/send') => emailGatewayProblem({ url, config });
    expect(ok(API)).toBeNull();
    expect(ok({ ...API, mode: 'FAX' })).toMatch(/Choose how/);
    expect(ok({ ...API, fromName: '' })).toMatch(/sender name/);
    expect(ok({ ...API, fromAddress: 'not an address' })).toMatch(/from address/);
    expect(ok({ ...API, fromAddress: 'a@example.com\nBcc: x@evil.com' })).toMatch(/from address/);
    expect(ok({ ...API, replyTo: 'x' })).toMatch(/reply-to/);
    expect(ok(API, null)).toMatch(/provider’s address/);
    expect(ok({ ...API, auth: 'HEADER', authHeader: 'bad header' })).toMatch(/header/);
    expect(ok({ ...API, auth: 'HEADER', authHeader: 'Content-Type' })).toMatch(/cannot carry/);
    expect(ok({ ...API, bodyTemplate: '{ nope' })).toMatch(/not valid JSON/);
    expect(ok({ ...API, bodyTemplate: '{"to":"{{to}}","subject":"{{subject}}"}' })).toMatch(/\{\{text\}\} or \{\{html\}\}/);
    expect(ok({ ...API, bodyTemplate: '{"to":"{{to}}","subject":"{{subject}}","text":"{{secret}}"}' })).toMatch(/Unknown placeholder/);
    expect(ok({ ...API, bodyTemplate: '{"{{to}}":"x"}' })).toMatch(/values, not in field names/);
    const smtp = { mode: 'SMTP', fromName: 'M', fromAddress: 'a@example.com', smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'STARTTLS' };
    expect(ok(smtp, null)).toBeNull();
    expect(ok({ ...smtp, smtpPort: 0 }, null)).toMatch(/port/);
    expect(ok({ ...smtp, smtpHost: 'bad host!' }, null)).toMatch(/host name/);
    expect(emailGatewayProblem({ config: { ...smtp, smtpSecurity: 'NONE' } }, true)).toMatch(/without encryption/);
    expect(emailGatewayProblem({ config: { ...smtp, smtpSecurity: 'NONE', smtpHost: 'localhost' } }, true)).toBeNull();
    expect(ok({ mode: 'SIMULATOR', fromName: 'M', fromAddress: 'a@example.com' }, null)).toBeNull();
    expect(authEndpointProblem('EMAIL_GATEWAY', { url: null, config: { mode: 'SIMULATOR', fromName: 'M', fromAddress: 'a@example.com' } })).toBeNull();
    for (const p of EMAIL_PRESETS) expect(parseBodyTemplate(p.bodyTemplate)).toHaveProperty('template');
  });
  it('refuses to save a bad sender and does not accept the old emailCodes setting as a thing', async () => {
    await expect(addSender({ fromAddress: 'nope' })).rejects.toThrow(/from address/);
    await expect(saveHubEndpoint(db, 'admin', { group: 'identity', kind: 'EMAIL_GATEWAY', name: 'x', config: API })).rejects.toThrow(/Choose a kind/);
    expect(authEndpointProblem('OTP_GATEWAY', { url: 'https://g.example.com', config: { emailCodes: 'yes' } })).toBeNull();
  });
});

describe('the body template', () => {
  it('puts values into the parsed JSON, so quotes, braces and new lines cannot add fields or break out', () => {
    const t = parseBodyTemplate('{"to":"{{to}}","personalizations":[{"subject":"Re: {{subject}}"}],"text":"{{text}}","reply_to":"{{replyTo}}","html":"{{html}}"}');
    if (!('template' in t)) throw new Error(t.problem);
    const evil = '", "bcc": "x@evil.com", "x": "';
    const out = JSON.parse(renderBodyTemplate(t.template, { to: 'a@example.com', subject: evil, text: `line1\n${evil}\\`, html: '', from: 'f@example.com', fromName: 'F', replyTo: '' }));
    expect(Object.keys(out).sort()).toEqual(['personalizations', 'text', 'to']);        // no bcc, and the empty reply-to and html fields are left out
    expect(out.personalizations[0].subject).toBe(`Re: ${evil}`);
    expect(out.text).toBe(`line1\n${evil}\\`);
  });
});

describe('sending through an HTTPS API', () => {
  it('posts the rendered body with the bearer token, never follows redirects, and succeeds', async () => {
    await addSender();
    expect(await sendEmail(db, { ...msg, html: '<b>Hi</b>' })).toEqual({ ok: true, retryable: false });
    expect(mails[0]!.url).toBe('https://mail.example.com/v1/send');
    expect(mails[0]!.redirect).toBe('manual');
    expect(mails[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    expect(mails[0]!.body).toEqual({ from: { name: 'Meridian Telecom', email: 'noreply@example.com' }, to: 'amy@example.com', reply_to: 'help@example.com', subject: 'Hello', text: 'Plain text', html: '<b>Hi</b>' });
  });
  it('sends the token in a named header when asked, and sends none when told not to', async () => {
    await addSender({ auth: 'HEADER', authHeader: 'x-api-key' });
    await sendEmail(db, msg);
    expect(mails[0]!.headers['x-api-key']).toBe(TOKEN); expect(mails[0]!.headers.authorization).toBeUndefined();
    await db.query('DELETE FROM integration_endpoints');
    await addSender({ auth: 'NONE' });
    await sendEmail(db, msg);
    expect(Object.keys(mails[1]!.headers).join()).not.toMatch(/authorization|api-key/i);
  });
  it('rejects header injection through the recipient, the subject, and the sender fields, without calling the provider', async () => {
    await addSender();
    for (const bad of [{ ...msg, to: 'a@example.com\r\nBcc: x@evil.com' }, { ...msg, to: 'a@example.com, b@example.com' }, { ...msg, to: 'Amy <a@example.com>' }, { ...msg, to: 'a@example.com;b@example.com' }, { ...msg, subject: 'Hi\r\nBcc: x@evil.com' }, { ...msg, subject: 'Hi\nthere' }, { ...msg, to: '' }]) {
      const r = await sendEmail(db, bad);
      expect(r).toMatchObject({ ok: false, retryable: false });
    }
    expect(mails).toHaveLength(0);
  });
  it('reports the provider’s error, tells retryable from permanent, and never puts the token in it', async () => {
    await addSender();
    answer = () => new Response(JSON.stringify({ message: `Invalid key ${TOKEN} for sender` }), { status: 401 });
    const bad = await sendEmail(db, msg);
    expect(bad).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('401') });
    expect(bad.error).toContain('Invalid key'); expect(bad.error).not.toContain(TOKEN);
    for (const [status, retry] of [[400, false], [403, false], [422, false], [408, true], [429, true], [500, true], [503, true]] as const) {
      answer = () => new Response('nope', { status });
      expect(await sendEmail(db, msg), String(status)).toMatchObject({ ok: false, retryable: retry });
    }
    answer = () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } });
    const redirected = await sendEmail(db, msg);
    expect(redirected).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/redirect/) });
    expect(redirected.error).not.toContain('evil.example.com');
    expect(mails.every((m) => m.url === 'https://mail.example.com/v1/send')).toBe(true);
  });
  it('caps what it reads of a huge answer, and times out, retryably, and unreachable is retryable too', async () => {
    await addSender();
    answer = () => new Response('x'.repeat(5_000_000), { status: 500 });
    const big = await sendEmail(db, msg);
    expect(big.ok).toBe(false); expect(big.error!.length).toBeLessThan(260);
    setEmailHttp(async (_u, init) => new Promise((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))); }));
    await db.query('DELETE FROM integration_endpoints');
    await addSender({}, { timeoutMs: 150 });
    expect(await sendEmail(db, msg)).toEqual({ ok: false, error: 'The provider did not answer in time.', retryable: true });
    setEmailHttp(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: `connect to https://mail.example.com/?key=${TOKEN}` } }); });
    const down = await sendEmail(db, msg);
    expect(down).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining('ECONNREFUSED') });
    expect(down.error).not.toContain(TOKEN); expect(down.error).not.toContain('mail.example.com');
  });
  it('says plainly when nothing is set up or the token is missing', async () => {
    expect(await sendEmail(db, msg)).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/No e-mail sender is enabled/) });
    await addSender({}, { secret: '' });
    expect(await sendEmail(db, msg)).toMatchObject({ ok: false, error: expect.stringMatching(/No API token/) });
    await db.query('UPDATE integration_endpoints SET enabled=false');
    expect(await sendEmail(db, msg)).toMatchObject({ error: expect.stringMatching(/No e-mail sender is enabled/) });
    expect(mails).toHaveLength(0);
  });
});

describe('the simulator', () => {
  it('records the message and sends nothing', async () => {
    await addSender({ mode: 'SIMULATOR' }, { url: null });
    expect(await sendEmail(db, { ...msg, html: '<p>x</p>' })).toEqual({ ok: true, retryable: false });
    expect(mails).toHaveLength(0);
    expect(await listSimulatedEmails(db)).toMatchObject([{ to: 'amy@example.com', subject: 'Hello', text: 'Plain text' }]);
    expect(await emailSenderStatus(db)).toMatchObject({ enabled: true, mode: 'SIMULATOR' });
  });
});

describe('sending through SMTP', () => {
  let server: SMTPServer; let port = 0; let received: Array<{ from: string; to: string[]; raw: string; user: string | null }> = [];
  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'],
      onAuth(a, _s, cb) { if (a.username === 'mailer' && a.password === 'smtp-PASS-123') cb(null, { user: a.username }); else cb(new Error('Invalid login')); },
      onRcptTo(a, _s, cb) { if (a.address.startsWith('nobody@')) { const e = Object.assign(new Error('550 5.1.1 No such user'), { responseCode: 550 }); return cb(e); } if (a.address.startsWith('later@')) { const e = Object.assign(new Error('451 4.3.0 Try again later'), { responseCode: 451 }); return cb(e); } cb(); },
      onData(stream, session, cb) { const chunks: Buffer[] = []; stream.on('data', (c) => chunks.push(c)); stream.on('end', () => { received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString(), user: (session as any).user ?? null }); cb(); }); },
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise((res) => server.close(() => res(null))); });
  beforeEach(() => { received = []; });
  const smtp = (o: Record<string, unknown> = {}, secret = 'smtp-PASS-123') => addSender({ mode: 'SMTP', smtpHost: '127.0.0.1', smtpPort: port, smtpSecurity: 'NONE', smtpUser: 'mailer', ...o }, { url: null, secret, timeoutMs: 5000 });

  it('delivers to a real SMTP server with the from name, reply-to, subject and both parts', async () => {
    await smtp();
    expect(await sendEmail(db, { ...msg, html: '<b>Hi</b>' })).toEqual({ ok: true, retryable: false });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: 'noreply@example.com', to: ['amy@example.com'], user: 'mailer' });
    expect(received[0]!.raw).toMatch(/From: "?Meridian Telecom"? <noreply@example.com>/);
    expect(received[0]!.raw).toMatch(/Reply-To: help@example.com/i);
    expect(received[0]!.raw).toMatch(/Subject: Hello/); expect(received[0]!.raw).toContain('Plain text'); expect(received[0]!.raw).toContain('<b>Hi</b>');
  });
  it('tells a refused login, a permanent refusal and a temporary one apart, with no password in the error', async () => {
    await smtp({}, 'wrong-PASSWORD-1');
    const auth = await sendEmail(db, msg);
    expect(auth).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/user name or password/) });
    expect(auth.error).not.toContain('wrong-PASSWORD-1');
    await db.query('DELETE FROM integration_endpoints'); await smtp();
    expect(await sendEmail(db, { ...msg, to: 'nobody@example.com' })).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('550') });
    expect(await sendEmail(db, { ...msg, to: 'later@example.com' })).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining('451') });
  });
  it('insists on STARTTLS when chosen, and a closed port is a retryable failure', async () => {
    await smtp({ smtpSecurity: 'STARTTLS' });
    expect(await sendEmail(db, msg)).toMatchObject({ ok: false });   // this server offers no STARTTLS: nothing is sent in the clear
    expect(received).toHaveLength(0);
    await db.query('DELETE FROM integration_endpoints'); await smtp({ smtpPort: 1 });
    expect(await sendEmail(db, msg)).toMatchObject({ ok: false, retryable: true });
  });
});

describe('the test e-mail', () => {
  it('goes through exactly what is saved and reports success or the provider’s error, to the address typed', async () => {
    const ep = await addSender({}, { enabled: false });   // a sender that is still switched off can be tried
    expect(await testEmail(db, 'sam', ep.id, 'sam@example.com')).toMatchObject({ ok: true, mode: 'API', simulated: false });
    expect(mails[0]!.body).toMatchObject({ to: 'sam@example.com', subject: 'Meridian test e-mail' });
    answer = () => new Response('{"error":{"message":"Sender not verified"}}', { status: 403 });
    expect(await testEmail(db, 'sam', ep.id, 'sam@example.com')).toMatchObject({ ok: false, error: expect.stringContaining('Sender not verified') });
    await expect(testEmail(db, 'sam', ep.id, 'bad')).rejects.toThrow(/valid single/);
    await expect(testEmail(db, 'sam', '00000000-0000-0000-0000-000000000000', 'a@example.com')).rejects.toThrow(/not found/i);
    await db.query('UPDATE integration_endpoints SET enabled=true');
    expect(await emailSenderStatus(db)).toMatchObject({ enabled: true, mode: 'API', target: 'mail.example.com', lastTest: { ok: false } });
    const sim = await addSender({ mode: 'SIMULATOR' }, { url: null }).catch(() => null);   // a second one of the same name is refused
    expect(sim).toBeNull();
  });
  it('keeps the secret out of everything the hub shows and exports', async () => {
    const ep = await addSender();
    expect(JSON.stringify(ep)).not.toContain(TOKEN); expect(ep.hasSecret).toBe(true);
    const row = (await db.query('SELECT * FROM integration_endpoints')).rows[0]!;
    expect(JSON.stringify(row.config)).not.toContain(TOKEN); expect(row.secretEnc).not.toContain(TOKEN);
  });
});

describe('alerts by e-mail', () => {
  const user = async () => {
    const username = `mail.user${++n}`;
    const { user } = await createUser(db, 'admin', { username, displayName: 'Mail User', roles: ['call-center'], email: `${username}@example.com`, phone: '+6591234567', password: PW });
    await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
    return { id: user.id as string, username, email: `${username}@example.com` };
  };
  const rows = async (id: string) => (await db.query(`SELECT * FROM lifecycle_outbox WHERE instruction='USER_ALERT' AND payload->>'userId'=$1`, [id])).rows;
  it('stays queued, untouched, without a sender, and goes out when one is set up', async () => {
    await db.query(`DELETE FROM lifecycle_outbox WHERE instruction='USER_ALERT'`);
    const u = await user();
    expect(await notifyUser(db, { id: u.id }, 'securityAlerts', { title: 'Password changed', body: 'Your password was changed.' })).toMatchObject({ email: true });
    expect(await deliverUserAlerts(db)).toEqual({ sent: 0, failed: 0 });
    expect((await rows(u.id))[0]).toMatchObject({ attempts: 0, deliveredAt: null, failedAt: null });
    expect(await notificationChannelStatus(db)).toMatchObject({ email: { available: false, via: null, note: expect.stringMatching(/No e-mail sender is set up/) } });
    await addSender();
    expect(await notificationChannelStatus(db)).toMatchObject({ email: { available: true, via: 'API', note: expect.stringMatching(/HTTPS API/) } });
    expect(await deliverUserAlerts(db)).toEqual({ sent: 1, failed: 0 });
    expect(mails[0]!.body).toMatchObject({ to: u.email, subject: 'Password changed' });
    expect(mails[0]!.body.text).toContain('Your password was changed.');
    expect(mails[0]!.body.text).not.toMatch(/https?:\/\/|\b\d{6}\b/);
    expect((await rows(u.id))[0]).toMatchObject({ payload: { deliveredVia: 'EMAIL' } });
  });
  it('retries with the same back-off as SMS, gives up after the last try, and fails a bad address at once', async () => {
    await db.query(`DELETE FROM lifecycle_outbox WHERE instruction='USER_ALERT'`);
    await addSender();
    const u = await user();
    await notifyUser(db, { id: u.id }, 'systemAlerts', { title: 'Maintenance', body: 'Tonight.' });
    answer = () => new Response('busy', { status: 503 });
    expect(await deliverUserAlerts(db)).toEqual({ sent: 0, failed: 1 });
    const r = (await rows(u.id))[0]!;
    expect(r).toMatchObject({ attempts: 1, deliveredAt: null, lastError: expect.stringContaining('503') });
    expect(new Date(r.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(await deliverUserAlerts(db)).toEqual({ sent: 0, failed: 0 });
    answer = () => new Response('{}');
    await db.query('UPDATE lifecycle_outbox SET next_attempt_at = NULL WHERE id=$1', [r.id]);
    expect(await deliverUserAlerts(db)).toEqual({ sent: 1, failed: 0 });
    const v = await user();
    await notifyUser(db, { id: v.id }, 'systemAlerts', { title: 'T', body: 'B' });
    answer = () => new Response('busy', { status: 500 });
    for (let i = 0; i < 8; i++) { await db.query(`UPDATE lifecycle_outbox SET next_attempt_at = NULL WHERE payload->>'userId'=$1`, [v.id]); await deliverUserAlerts(db); }
    expect((await rows(v.id))[0]).toMatchObject({ attempts: 6, failedAt: expect.anything(), deliveredAt: null });
    const w = await user();
    await db.query('UPDATE users SET email=$2 WHERE id=$1', [w.id, 'bad address@example.com']);
    await notifyUser(db, { id: w.id }, 'systemAlerts', { title: 'T', body: 'B' });
    answer = () => new Response('{}');
    expect(await deliverUserAlerts(db)).toEqual({ sent: 0, failed: 1 });
    expect((await rows(w.id))[0]).toMatchObject({ attempts: 1, failedAt: expect.anything() });
  });
});

describe('signed agreement copies by e-mail', () => {
  const signed = async (o: { phone?: string; email?: string } = {}) => {
    const customer = (await newCustomer(db, { phone: o.phone, email: o.email })).customer;
    await db.query('UPDATE customers SET phone=$2, email=$3 WHERE id=$1', [customer.id, o.phone ?? null, o.email ?? null]);
    const order = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: '1 Test Road', lines: [{ offerId: 'plan-sim-5g' }], agreement: { signature: { image: signatureDataUrl(), signerName: 'Sam Lee' }, ip: '203.0.113.5', userAgent: 'vitest' } });
    return order.id as string;
  };
  const row = async (orderId: string) => (await db.query(`SELECT * FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND payload->>'orderId'=$1`, [orderId])).rows[0]!;
  beforeEach(async () => { await db.query(`DELETE FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED'`); await setSecurityPolicy(db, 'root', { recovery: { publicUrl: 'https://crm.example.com' } as never }); });

  it('sends the link by e-mail when that is all there is, and the status says so', async () => {
    await addSender();
    const o = await signed({ email: 'cust@example.com' });
    expect(await signedCopyStatus(db)).toMatchObject({ canSend: true, gateway: { configured: false }, email: { configured: true, mode: 'API' }, blocked: null });
    const r = await deliverSignedCopies(db);
    expect(r).toMatchObject({ failed: 0, sent: 1 });
    expect(mails.length).toBeGreaterThanOrEqual(2);
    expect(mails[0]!.body).toMatchObject({ to: 'cust@example.com', subject: 'Your signed agreement' });
    expect(mails[0]!.body.text).toMatch(/https:\/\/crm\.example\.com\/api\/documents\/file\/\S+/); expect(mails[0]!.body.text).toMatch(/15 minutes/);
    expect((await row(o)).payload).toMatchObject({ deliveredVia: 'EMAIL' });
  });
  it('uses the configured order when the customer has both, and falls back to the other channel on failure', async () => {
    await addSender(); await addGateway();
    const a = await signed({ phone: '+6591230001', email: 'both@example.com' });
    await deliverSignedCopies(db);                                                         // default: the messaging gateway first
    expect(sms.length).toBeGreaterThanOrEqual(1); expect(mails).toHaveLength(0);
    expect((await row(a)).payload).toMatchObject({ deliveredVia: 'SMS' });
    await setSecurityPolicy(db, 'root', { email: { signedCopyFirst: 'EMAIL' } as never });
    sms = [];
    const b = await signed({ phone: '+6591230002', email: 'both2@example.com' });
    await deliverSignedCopies(db);
    expect(mails.length).toBeGreaterThanOrEqual(1); expect(sms).toHaveLength(0);
    expect((await row(b)).payload).toMatchObject({ deliveredVia: 'EMAIL' });
    // first channel fails: the other one carries the copy
    mails = []; answer = () => new Response('down', { status: 502 });
    const c = await signed({ phone: '+6591230003', email: 'both3@example.com' });
    expect(await deliverSignedCopies(db)).toMatchObject({ sent: 1, failed: 0 });
    expect(mails.length).toBeGreaterThanOrEqual(1); expect(sms.some((m) => m.to === '+6591230003')).toBe(true);
    expect((await row(c)).payload).toMatchObject({ deliveredVia: 'SMS' });
  });
  it('retries when every channel fails, naming each, and fails at once for a customer nothing can reach', async () => {
    await addSender();
    answer = () => new Response('down', { status: 502 });
    const a = await signed({ email: 'x@example.com' });
    expect(await deliverSignedCopies(db)).toMatchObject({ sent: 0, failed: 1 });
    expect(await row(a)).toMatchObject({ attempts: 1, deliveredAt: null, failedAt: null, lastError: expect.stringMatching(/e-mail: .*502/) });
    answer = () => new Response('{}');
    await retryFailedSignedCopies(db, 'root');
    await db.query('UPDATE lifecycle_outbox SET next_attempt_at = NULL WHERE id=$1', [(await row(a)).id]);
    expect((await deliverSignedCopies(db)).sent).toBe(1);
    const b = await signed({});
    await deliverSignedCopies(db);
    expect(await row(b)).toMatchObject({ failedAt: expect.anything(), lastError: expect.stringMatching(/no e-mail address on file/) });
  });
});

describe('codes by e-mail need the policy and a sender', () => {
  const person = async (o: { email?: string } = {}) => {
    const username = `code.user${++n}`, email = o.email ?? `c${n}@example.com`;
    const { user } = await createUser(db, 'admin', { username, displayName: 'Code User', roles: ['call-center'], email, phone: '+6591234567', password: PW });
    await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
    return { id: user.id as string, name: 'Code User', username, email, phone: '+6591234567' };
  };
  const lastOtp = async () => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='MFA_OTP' ORDER BY id DESC LIMIT 1`)).rows[0]?.payload;
  it('reports the switch and the sender separately, and is available only with both', async () => {
    expect(await emailCodesStatus(db)).toEqual({ switchedOn: false, senderEnabled: false, simulated: false, available: false });
    await addSender();
    expect(await emailCodesStatus(db)).toMatchObject({ switchedOn: false, senderEnabled: true, available: false });
    await setSecurityPolicy(db, 'a', { email: { codesEnabled: true } as never });
    expect(await emailCodesStatus(db)).toMatchObject({ available: true });
    await db.query('UPDATE integration_endpoints SET enabled=false');
    expect(await emailCodesStatus(db)).toMatchObject({ switchedOn: true, senderEnabled: false, available: false });
    await expect(setSecurityPolicy(db, 'a', { email: { signedCopyFirst: 'FAX' } as never })).rejects.toThrow(/gateway or by e-mail/);
    expect((await getSecurityPolicy(db)).email).toEqual({ codesEnabled: true, signedCopyFirst: 'GATEWAY' });
  });
  it('sends an enrolment code and a sign-in code by e-mail only when allowed, and wipes it after sending', async () => {
    const u = await person();
    await expect(beginOtpMethod(db, u, 'EMAIL')).rejects.toThrow(/not available/);          // policy off
    await setSecurityPolicy(db, 'a', { email: { codesEnabled: true } as never });
    await expect(beginOtpMethod(db, u, 'EMAIL')).rejects.toThrow(/not available/);          // no sender
    await addSender();
    await beginOtpMethod(db, u, 'EMAIL');
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 1, failed: 0 });
    const code = /\b(\d{6})\b/.exec(mails[0]!.body.text)![1]!;
    expect(mails[0]!.body).toMatchObject({ to: u.email, subject: 'Your Meridian sign-in code' }); expect(sms).toHaveLength(0);
    expect((await lastOtp()).code).toBeUndefined();
    await confirmOtpMethod(db, u, 'EMAIL', code);
    mails = [];
    const err = await login(db, { username: u.username, password: PW }).catch((e) => e);
    expect(err).toBeInstanceOf(MfaRequired); expect(err.challenge).toMatchObject({ method: 'EMAIL', methods: ['EMAIL'] });
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 1 }); expect(mails).toHaveLength(1);
    await setSecurityPolicy(db, 'a', { email: { codesEnabled: false } as never });            // off again: not offered at sign-in
    await expect(openLoginChallenge(db, u, {})).rejects.toThrow(/not available/);
  });
  it('recovers a password by e-mail (link or code) only when allowed, else by SMS or not at all', async () => {
    const u = await person();
    const reset = async () => (await db.query(`SELECT payload FROM lifecycle_outbox WHERE instruction='PASSWORD_RESET' AND payload->>'to' IN ($1,$2) ORDER BY id DESC LIMIT 1`, [u.email, u.phone])).rows[0]?.payload;
    await requestPasswordReset(db, { identifier: u.username });                              // EITHER, e-mail off: SMS
    expect((await reset())!.channel).toBe('SMS');
    await db.query(`DELETE FROM lifecycle_outbox WHERE instruction='PASSWORD_RESET'`);
    await setSecurityPolicy(db, 'a', { recovery: { channel: 'EMAIL' } as never });
    await db.query('DELETE FROM password_reset_tokens'); await db.query('DELETE FROM auth_attempts');
    await requestPasswordReset(db, { identifier: u.username });                              // e-mail only, e-mail off: nothing
    expect(await reset()).toBeUndefined();
    await addSender(); await setSecurityPolicy(db, 'a', { email: { codesEnabled: true } as never, recovery: { channel: 'EMAIL', publicUrl: 'https://crm.example.com' } as never });
    await db.query('DELETE FROM password_reset_tokens'); await db.query('DELETE FROM auth_attempts');
    await requestPasswordReset(db, { identifier: u.username });
    expect((await reset())!.link).toMatch(/^https:\/\/crm\.example\.com\/reset-password\?token=/);
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 1 });
    expect(mails[0]!.body).toMatchObject({ to: u.email, subject: 'Reset your Meridian password' }); expect(mails[0]!.body.text).toMatch(/reset-password\?token=/);
    expect((await reset())!.link).toBeUndefined();                                            // the link is not kept once sent
  });
  it('drops a code that can never be sent instead of keeping it', async () => {
    await addSender(); await setSecurityPolicy(db, 'a', { email: { codesEnabled: true } as never });
    const u = await person();
    await beginOtpMethod(db, u, 'EMAIL');
    await db.query(`UPDATE lifecycle_outbox SET payload = jsonb_set(payload, '{to}', '"bad address"') WHERE instruction='MFA_OTP' AND payload->>'to'=$1`, [u.email]);
    expect(await deliverOtpMessages(db)).toMatchObject({ sent: 0, failed: 1 });
    const r = (await db.query(`SELECT * FROM lifecycle_outbox WHERE instruction='MFA_OTP' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(r.failedAt).not.toBeNull(); expect(r.payload.code).toBeUndefined();
  });
});

describe('the emailCodes setting moves into the security policy', () => {
  it('turns a stored emailCodes: true into the policy switch and removes it from the gateway', async () => {
    const sql = MIGRATIONS.find((m) => m.name.startsWith('0059'))!.sql.split('CREATE TABLE simulated_emails')[1]!.replace(/^[\s\S]*?\);\n/, '').split('\n').filter((l) => !l.startsWith('--')).join('\n');
    const up = { run: async () => { for (const st of sql.split(';\n').map((x) => x.trim()).filter(Boolean)) await db.query(st); } };
    await db.query(`INSERT INTO integration_endpoints (group_key, kind, name, url, config) VALUES ('auth','OTP_GATEWAY','Old','https://g.example.com','{"deliver":"SMS","emailCodes":true}')`);
    await db.query(`INSERT INTO settings (key, value, updated_by) VALUES ('securityPolicy','{"lockout":{"maxFailures":7,"lockMinutes":15}}','t') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    await up.run();
    const p = await getSecurityPolicy(db);
    expect(p.email.codesEnabled).toBe(true); expect(p.lockout.maxFailures).toBe(7);          // nothing else lost
    expect((await db.query(`SELECT config FROM integration_endpoints WHERE name='Old'`)).rows[0]!.config).toEqual({ deliver: 'SMS' });
    // without the old setting, nothing changes
    await db.query(`DELETE FROM settings WHERE key='securityPolicy'`);
    await up.run();
    expect((await getSecurityPolicy(db)).email.codesEnabled).toBe(false);
    await db.query(`INSERT INTO integration_endpoints (group_key, kind, name, url, config) VALUES ('auth','OTP_GATEWAY','Old2','https://g.example.com','{"emailCodes":false}')`);
    await up.run();
    expect((await getSecurityPolicy(db)).email.codesEnabled).toBe(false);
  });
});
