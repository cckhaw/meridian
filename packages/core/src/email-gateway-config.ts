/**
 * The settings of the e-mail sender (hub endpoint kind EMAIL_GATEWAY, group `auth`), checked when an administrator saves them, and the request-body template.
 * Kept apart from email-gateway.ts (which talks to the provider) so the hub's validation can use it without a cycle.
 *
 *  mode API        `url` is the provider's address, `auth` says how the token (the endpoint's secret) is sent, `bodyTemplate` is the JSON the provider expects.
 *  mode SMTP       smtpHost, smtpPort, smtpSecurity and smtpUser; the endpoint's secret is the SMTP password.
 *  mode SIMULATOR  records the message, sends nothing.
 */
export const EMAIL_MODES = ['API', 'SMTP', 'SIMULATOR'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export const EMAIL_AUTH = ['BEARER', 'HEADER', 'NONE'] as const;
export const SMTP_SECURITY = ['STARTTLS', 'TLS', 'NONE'] as const;
export const PLACEHOLDERS = ['to', 'subject', 'text', 'html', 'from', 'fromName', 'replyTo'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface EmailConfig {
  mode: EmailMode; fromName: string; fromAddress: string; replyTo?: string;
  auth?: (typeof EMAIL_AUTH)[number]; authHeader?: string; bodyTemplate?: string;
  smtpHost?: string; smtpPort?: number; smtpSecurity?: (typeof SMTP_SECURITY)[number]; smtpUser?: string;
}

const GENERIC = { from: { name: '{{fromName}}', email: '{{from}}' }, to: '{{to}}', reply_to: '{{replyTo}}', subject: '{{subject}}', text: '{{text}}', html: '{{html}}' };
const FLAT = { from: '{{from}}', fromName: '{{fromName}}', to: '{{to}}', replyTo: '{{replyTo}}', subject: '{{subject}}', text: '{{text}}', html: '{{html}}' };
/** One-click starting points for the screen. Nothing vendor-specific and no credentials: the administrator adjusts the field names to the provider's documentation. */
export const EMAIL_PRESETS: Array<{ id: string; label: string; auth: 'BEARER' | 'HEADER'; authHeader: string; bodyTemplate: string }> = [
  { id: 'generic-bearer', label: 'Generic JSON provider, token as a bearer token', auth: 'BEARER', authHeader: '', bodyTemplate: JSON.stringify(GENERIC, null, 2) },
  { id: 'generic-header', label: 'Generic JSON provider, token in a header', auth: 'HEADER', authHeader: 'x-api-key', bodyTemplate: JSON.stringify(GENERIC, null, 2) },
  { id: 'flat', label: 'Flat JSON (from, to, subject, text, html)', auth: 'BEARER', authHeader: '', bodyTemplate: JSON.stringify(FLAT, null, 2) },
];

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
export const hasControl = (s: string) => CONTROL.test(s);
const ADDRESS = /^[^\s@<>(),;:"\\[\]]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
/** What is wrong with a single e-mail address (no display name, no list, no line breaks), or null. */
export function emailAddressProblem(a: unknown, what = 'The e-mail address'): string | null {
  if (typeof a !== 'string' || !a) return `${what} is missing.`;
  if (hasControl(a) || a.length > 254 || !ADDRESS.test(a)) return `${what} is not a valid single e-mail address.`;
  return null;
}
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'cookie', 'set-cookie', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization']);
const HOST = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const isLocalHost = (h: string) => ['localhost', '127.0.0.1', '::1'].includes(h);

const nameOf = (m: string) => m.replace(/^\{\{\s*|\s*\}\}$/g, '');
/** The JSON body template: valid JSON object, only the known placeholders, in values only. Returns the parsed template or a problem. */
export function parseBodyTemplate(t: unknown): { template: Record<string, unknown> } | { problem: string } {
  if (typeof t !== 'string' || !t.trim()) return { problem: 'Write the request body the provider expects (JSON with placeholders such as {{to}}).' };
  if (t.length > 8000) return { problem: 'The request body is too long (8,000 characters at most).' };
  let v: unknown;
  try { v = JSON.parse(t); } catch { return { problem: 'The request body is not valid JSON.' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { problem: 'The request body is a JSON object, for example { "to": "{{to}}", … }.' };
  const seen = new Set<string>();
  let bad: string | null = null;
  const walk = (n: unknown): void => {
    if (typeof n === 'string') { for (const m of n.matchAll(/\{\{[^}]*\}\}/g)) { const p = nameOf(m[0]); if (!(PLACEHOLDERS as readonly string[]).includes(p)) bad ??= `Unknown placeholder {{${p}}}. Use ${PLACEHOLDERS.map((x) => `{{${x}}}`).join(', ')}.`; else seen.add(p); } }
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') for (const [k, x] of Object.entries(n)) { if (k.includes('{{')) bad ??= 'Placeholders go in values, not in field names.'; walk(x); }
  };
  walk(v);
  if (bad) return { problem: bad };
  if (!seen.has('to')) return { problem: 'The request body must contain {{to}}.' };
  if (!seen.has('subject')) return { problem: 'The request body must contain {{subject}}.' };
  if (!seen.has('text') && !seen.has('html')) return { problem: 'The request body must contain {{text}} or {{html}}.' };
  return { template: v as Record<string, unknown> };
}

/**
 * Fills the template. Values are put into the parsed JSON, never spliced into text, so nothing a message contains can add a field or break out of a string.
 * A field whose whole value is one placeholder that has no value (no reply-to, no HTML part) is left out.
 */
export function renderBodyTemplate(template: Record<string, unknown>, v: Record<Placeholder, string>): string {
  const fill = (s: string) => s.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_m, p: string) => v[p as Placeholder] ?? '');
  const walk = (n: unknown): unknown => {
    if (typeof n === 'string') return fill(n);
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(n)) {
        const r = walk(x);
        if (typeof x === 'string' && /^\{\{\s*[A-Za-z]+\s*\}\}$/.test(x) && r === '') continue;
        out[k] = r;
      }
      return out;
    }
    return n;
  };
  return JSON.stringify(walk(template));
}

/** What is wrong with the e-mail sender's settings, or null. */
export function emailGatewayProblem(i: { url?: string | null; config?: Record<string, unknown> }, production = process.env.NODE_ENV === 'production'): string | null {
  const c = (i.config ?? {}) as Record<string, unknown>;
  if (!(EMAIL_MODES as readonly unknown[]).includes(c.mode)) return `Choose how e-mail is sent: ${EMAIL_MODES.join(', ')}.`;
  const name = typeof c.fromName === 'string' ? c.fromName.trim() : '';
  if (!name || name.length > 80 || hasControl(name)) return 'Enter the sender name (up to 80 characters, on one line).';
  const fromProblem = emailAddressProblem(c.fromAddress, 'The from address'); if (fromProblem) return fromProblem;
  if (c.replyTo !== undefined && c.replyTo !== '' && c.replyTo !== null) { const p = emailAddressProblem(c.replyTo, 'The reply-to address'); if (p) return p; }
  if (c.mode === 'API') {
    if (!i.url) return 'Enter the provider’s address (https://…).';
    const auth = c.auth ?? 'BEARER';
    if (!(EMAIL_AUTH as readonly unknown[]).includes(auth)) return `Send the token as ${EMAIL_AUTH.join(', ')}.`;
    if (auth === 'HEADER') {
      const h = typeof c.authHeader === 'string' ? c.authHeader.trim() : '';
      if (!/^[A-Za-z0-9-]{1,60}$/.test(h)) return 'Name the header that carries the token (letters, digits and dashes, for example x-api-key).';
      if (FORBIDDEN_HEADERS.has(h.toLowerCase())) return `The header ${h} cannot carry the token.`;
    }
    const t = parseBodyTemplate(c.bodyTemplate); if ('problem' in t) return t.problem;
  } else if (c.mode === 'SMTP') {
    const host = typeof c.smtpHost === 'string' ? c.smtpHost.trim() : '';
    if (!host || host.length > 253 || !HOST.test(host)) return 'Enter the SMTP server’s host name.';
    if (!Number.isInteger(c.smtpPort) || (c.smtpPort as number) < 1 || (c.smtpPort as number) > 65535) return 'The SMTP port is 1 to 65535 (587 for STARTTLS, 465 for TLS).';
    if (!(SMTP_SECURITY as readonly unknown[]).includes(c.smtpSecurity)) return `Choose the connection security: ${SMTP_SECURITY.join(', ')}.`;
    if (c.smtpSecurity === 'NONE' && production && !isLocalHost(host.toLowerCase())) return 'An SMTP connection without encryption is only allowed to this machine itself in production. Use STARTTLS or TLS.';
    if (c.smtpUser !== undefined && c.smtpUser !== null && (typeof c.smtpUser !== 'string' || c.smtpUser.length > 200 || hasControl(c.smtpUser))) return 'The SMTP user is up to 200 characters on one line.';
  }
  return null;
}
