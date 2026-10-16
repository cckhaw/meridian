/** Session cookie and request conventions for this deployment (its own cookie name, so it never collides with the CRM's on a shared parent domain). */
export const SESSION_COOKIE = 'fiber_session';
export const SECURE_SESSION_COOKIE = '__Host-fiber_session';

export const isSecureRequest = (req: Request) => process.env.NODE_ENV === 'production' || (req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')) === 'https';
const name = (secure: boolean) => (secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE);

export function readToken(req: Request): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    const n = part.slice(0, i).trim();
    if (n === SESSION_COOKIE || n === SECURE_SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
export const sessionCookie = (req: Request, token: string, expires: Date) => `${name(isSecureRequest(req))}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${isSecureRequest(req) ? '; Secure' : ''}`;
export const clearCookie = (req: Request) => `${name(isSecureRequest(req))}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${isSecureRequest(req) ? '; Secure' : ''}`;
export const clientIp = (req: Request) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';

/** CSRF defence for state-changing requests that carry the session cookie: the browser's Origin must be this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  try { const o = new URL(origin); return o.host === host && o.protocol === `${proto}:`; } catch { return false; }
}

export const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json', ...headers } });
/** The TM Forum error shape, for the /tmf-api routes. */
export const tmfFail = (status: number, reason: string, message: string) => new Response(JSON.stringify({ '@type': 'Error', code: String(status), reason, message, status: String(status) }), { status, headers: { 'content-type': 'application/json' } });
