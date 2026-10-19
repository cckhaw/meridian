import type { Db, Queryable } from './db.js';
import { audit } from './audit.js';
import { invalid, notFound } from './errors.js';
import { hubEndpointByIdWithSecret, hubEndpointWithSecret } from './integration-hub.js';
import { emailAddressProblem, hasControl, parseBodyTemplate, renderBodyTemplate, type EmailConfig, type EmailMode } from './email-gateway-config.js';
import { getSecurityPolicy } from './security-policy.js';

/**
 * The e-mail sender of the Integration hub (Messaging, kind EMAIL_GATEWAY) and the one place that talks to it: `sendEmail` for everything Meridian sends by e-mail
 * (sign-in and recovery codes, staff alerts, signed agreement copies) and `testEmail` for the screen's "Send a test e-mail". Three modes:
 *  - API        one POST of the administrator's JSON template to an HTTPS address, with the token as a bearer token or in a named header;
 *  - SMTP       nodemailer, with the connection security the administrator chose;
 *  - SIMULATOR  records the message in `simulated_emails` and sends nothing.
 * Every call has a timeout, redirects are never followed, an answer is read up to a few kilobytes, and neither the token nor the SMTP password appears in an
 * error. A result says whether another try could help (`retryable`): timeouts, connection failures, 408/425/429 and 5xx can be tried again; the rest cannot.
 */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let httpImpl: Fetch = (url, init) => fetch(url, init);
/** Tests replace the HTTP call (like setOtpHttp for the SMS gateway). */
export const setEmailHttp = (f: Fetch | null) => { httpImpl = f ?? ((url, init) => fetch(url, init)); };

type Sender = NonNullable<Awaited<ReturnType<typeof emailSender>>>;
/** The one e-mail sender the product has: the first enabled EMAIL_GATEWAY in the Integration hub. */
export const emailSender = (q: Queryable) => hubEndpointWithSecret(q, 'auth', 'EMAIL_GATEWAY');
const cfg = (ep: Sender) => ep.config as unknown as EmailConfig;

export interface EmailMessage { to: string; subject: string; text: string; html?: string }
export interface EmailResult { ok: boolean; error?: string; retryable: boolean }
const fail = (error: string, retryable = false): EmailResult => ({ ok: false, error, retryable });
const MAX_SNIPPET = 2048;

/** Rejects what could turn into a header or a second recipient. */
function messageProblem(m: EmailMessage): string | null {
  const to = emailAddressProblem(m.to, 'The recipient address'); if (to) return to;
  if (typeof m.subject !== 'string' || !m.subject.trim() || m.subject.length > 200 || hasControl(m.subject)) return 'The subject is 1 to 200 characters on one line.';
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 20_000) return 'The message text is 1 to 20,000 characters.';
  if (m.html !== undefined && (typeof m.html !== 'string' || m.html.length > 100_000)) return 'The HTML part is too long.';
  return null;
}
/** Something safe to show: no secret, no control characters, short. */
const scrub = (s: string, secrets: Array<string | null | undefined>, max = 200) => {
  let out = s;
  for (const x of secrets) if (x && x.length >= 4) out = out.split(x).join('***');
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
};
async function readSnippet(res: Response): Promise<string> {
  try {
    const rd = res.body?.getReader();
    if (!rd) return '';
    const chunks: Uint8Array[] = []; let n = 0;
    while (n < MAX_SNIPPET) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); n += value.length; }
    await rd.cancel().catch(() => undefined);
    return Buffer.concat(chunks).subarray(0, MAX_SNIPPET).toString('utf8');
  } catch { return ''; }
}
/** The provider's own words when its answer is JSON with a message, else the start of its text. */
const providerWords = (raw: string) => {
  try { const j = JSON.parse(raw) as Record<string, any>; const m = j.message ?? j.error?.message ?? j.error ?? j.detail ?? j.errors?.[0]?.message ?? j.errors?.[0]; if (typeof m === 'string' && m) return m; } catch { /* plain text */ }
  return raw;
};

async function viaApi(ep: Sender, c: EmailConfig, m: EmailMessage): Promise<EmailResult> {
  if (!ep.url) return fail('The e-mail sender has no provider address.');
  const t = parseBodyTemplate(c.bodyTemplate);
  if ('problem' in t) return fail('The request body of the e-mail sender is not valid. Open it in Integration and fix it.');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const auth = c.auth ?? 'BEARER';
  if (auth !== 'NONE') {
    if (!ep.secret) return fail('No API token is set for the e-mail sender.');
    if (hasControl(ep.secret)) return fail('The API token of the e-mail sender is not valid.');
    if (auth === 'BEARER') headers.authorization = `Bearer ${ep.secret}`; else headers[(c.authHeader ?? '').trim()] = ep.secret;
  }
  const body = renderBodyTemplate(t.template, { to: m.to, subject: m.subject, text: m.text, html: m.html ?? '', from: c.fromAddress, fromName: c.fromName, replyTo: c.replyTo ?? '' });
  let res: Response;
  try { res = await httpImpl(ep.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(ep.timeoutMs), headers, body, cache: 'no-store' } as RequestInit); }
  catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return fail('The provider did not answer in time.', true);
    const code = typeof err.cause?.code === 'string' && /^[A-Z_]{3,30}$/.test(err.cause.code) ? ` (${err.cause.code})` : '';
    return fail(`The provider could not be reached${code}.`, true);
  }
  if (res.ok) { await res.body?.cancel().catch(() => undefined); return { ok: true, retryable: false }; }
  const words = scrub(providerWords(await readSnippet(res)), [ep.secret], 160);
  if (res.status >= 300 && res.status < 400) return fail(`The provider answered ${res.status} (a redirect). Redirects are not followed; enter the final address.`);
  return fail(`The provider answered ${res.status}${words ? `: ${words}` : ''}.`, [408, 425, 429].includes(res.status) || res.status >= 500);
}

async function viaSmtp(ep: Sender, c: EmailConfig, m: EmailMessage): Promise<EmailResult> {
  const { default: nodemailer } = await import('nodemailer');
  const sec = c.smtpSecurity ?? 'STARTTLS', ms = ep.timeoutMs;
  const tr = nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: sec === 'TLS', requireTLS: sec === 'STARTTLS', ignoreTLS: sec === 'NONE',
    ...(c.smtpUser ? { auth: { user: c.smtpUser, pass: ep.secret ?? '' } } : {}),
    connectionTimeout: ms, greetingTimeout: ms, socketTimeout: ms, dnsTimeout: ms,
  });
  try {
    await tr.sendMail({ from: { name: c.fromName, address: c.fromAddress }, to: m.to, ...(c.replyTo ? { replyTo: c.replyTo } : {}), subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) });
    return { ok: true, retryable: false };
  } catch (e) {
    const err = e as { code?: string; responseCode?: number; response?: string; command?: string };
    const secrets = [ep.secret, c.smtpUser];
    if (err.code === 'EAUTH') return fail('The SMTP server refused the user name or password.');
    if (err.code === 'ETIMEDOUT') return fail('The SMTP server did not answer in time.', true);
    if (typeof err.responseCode === 'number') return fail(`The SMTP server answered: ${scrub(err.response ?? String(err.responseCode), secrets, 160)}`, err.responseCode >= 400 && err.responseCode < 500);
    if (err.code === 'ECONNECTION' || err.code === 'ESOCKET' || err.code === 'EDNS') return fail(`The SMTP server could not be reached or the secure connection failed${err.command === 'STARTTLS' ? ' (STARTTLS)' : ''}.`, true);
    return fail('The message could not be sent through the SMTP server.');
  } finally { tr.close(); }
}

async function viaSimulator(q: Queryable, m: EmailMessage): Promise<EmailResult> {
  await q.query('INSERT INTO simulated_emails (to_address, subject, body_text, body_html) VALUES ($1,$2,$3,$4)', [m.to, m.subject, m.text, m.html ?? null]);
  await q.query(`DELETE FROM simulated_emails WHERE id NOT IN (SELECT id FROM simulated_emails ORDER BY id DESC LIMIT 50) OR created_at < now() - interval '7 days'`);
  return { ok: true, retryable: false };
}

async function transmit(q: Queryable, ep: Sender, m: EmailMessage): Promise<EmailResult> {
  const problem = messageProblem(m);
  if (problem) return fail(problem);
  const c = cfg(ep);
  try {
    if (c.mode === 'SIMULATOR') return await viaSimulator(q, m);
    if (c.mode === 'SMTP') return await viaSmtp(ep, c, m);
    if (c.mode === 'API') return await viaApi(ep, c, m);
    return fail('The e-mail sender has no sending mode. Open it in Integration and choose one.');
  } catch (e) { return fail(`The e-mail could not be sent (${scrub((e as Error).message, [ep.secret, c.smtpUser], 80)}).`); }
}

/** Sends one e-mail through the enabled sender. Never throws; says whether another try could help. */
export async function sendEmail(db: Queryable, m: EmailMessage): Promise<EmailResult> {
  const ep = await emailSender(db);
  if (!ep) return fail('No e-mail sender is enabled in the Integration hub.');
  return transmit(db, ep, m);
}

/** The screen's "Send a test e-mail": through exactly what is stored for that sender, enabled or not. */
export async function testEmail(db: Db, actor: string, endpointId: string, to: string): Promise<EmailResult & { mode: EmailMode | null; simulated: boolean }> {
  const ep = await hubEndpointByIdWithSecret(db, endpointId);
  if (!ep || ep.kind !== 'EMAIL_GATEWAY') throw notFound('e-mail sender', endpointId);
  const p = emailAddressProblem(to, 'The address to send the test to'); if (p) throw invalid(p);
  const mode = cfg(ep).mode ?? null;
  const r = await transmit(db, ep, { to, subject: 'Meridian test e-mail', text: `This is a test e-mail from Meridian, sent by ${actor} from Integration, Messaging, E-mail sender. If you can read it, the sender works.` });
  await audit(db, actor, 'email_gateway', ep.id, 'EMAIL_TEST', { mode, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  return { ...r, mode, simulated: mode === 'SIMULATOR' };
}

/** What the screens and the overview say about the sender: is there one, how it sends, and how the last test went. */
export async function emailSenderStatus(q: Queryable): Promise<{ enabled: boolean; mode: EmailMode | null; name: string | null; endpointId: string | null; from: string | null; target: string | null; lastTest: { ok: boolean; at: string; error: string | null } | null }> {
  const ep = await emailSender(q);
  const last = (await q.query(`SELECT at, detail FROM audit_log WHERE entity='email_gateway' AND action='EMAIL_TEST' ORDER BY id DESC LIMIT 1`)).rows[0];
  const lastTest = last ? { ok: !!last.detail?.ok, at: new Date(last.at).toISOString(), error: (last.detail?.error as string | undefined) ?? null } : null;
  if (!ep) return { enabled: false, mode: null, name: null, endpointId: null, from: null, target: null, lastTest };
  const c = cfg(ep);
  const target = c.mode === 'API' && ep.url ? (() => { try { return new URL(ep.url!).host; } catch { return null; } })() : c.mode === 'SMTP' ? `${c.smtpHost}:${c.smtpPort}` : null;
  return { enabled: true, mode: c.mode ?? null, name: ep.name, endpointId: ep.id, from: c.fromAddress ?? null, target, lastTest };
}

/** The messages the simulator holds, newest first, for the screen. */
export async function listSimulatedEmails(q: Queryable, limit = 20) {
  return (await q.query('SELECT id, to_address, subject, body_text, created_at FROM simulated_emails ORDER BY id DESC LIMIT $1', [Math.min(limit, 50)])).rows
    .map((r) => ({ id: String(r.id), to: r.toAddress as string, subject: r.subject as string, text: r.bodyText as string, at: new Date(r.createdAt).toISOString() }));
}

/**
 * E-mail codes (sign-in codes by e-mail, e-mail recovery of a password) are on only when Settings → Security policy allows them AND an e-mail sender is enabled in
 * the Integration hub. This is the one check; the screens, the router and the code that sends all use it.
 */
export async function emailCodesStatus(q: Queryable): Promise<{ switchedOn: boolean; senderEnabled: boolean; simulated: boolean; available: boolean }> {
  const [policy, ep] = await Promise.all([getSecurityPolicy(q), emailSender(q)]);
  const switchedOn = policy.email.codesEnabled, senderEnabled = !!ep;
  return { switchedOn, senderEnabled, simulated: ep ? cfg(ep).mode === 'SIMULATOR' : false, available: switchedOn && senderEnabled };
}
export const emailCodesAvailable = async (q: Queryable) => (await emailCodesStatus(q)).available;
