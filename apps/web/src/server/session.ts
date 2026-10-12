/** Session cookie conventions shared by the API and the edge middleware. */
export const SESSION_COOKIE = 'meridian_session';
export const SECURE_SESSION_COOKIE = '__Host-meridian_session';

export const isSecureRequest = (req: Request) =>
  process.env.NODE_ENV === 'production' || (req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')) === 'https';

export const cookieName = (secure: boolean) => (secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE);

export function readToken(req: Request): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim();
    if (name === SESSION_COOKIE || name === SECURE_SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** HttpOnly (no script access), SameSite=Lax, and the __Host- prefix when secure (no Domain, Path=/, cannot be overwritten by a subdomain). */
export function sessionCookie(req: Request, token: string, expires: Date): string {
  const secure = isSecureRequest(req);
  return `${cookieName(secure)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}
export function clearCookie(req: Request): string {
  const secure = isSecureRequest(req);
  return `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

/** The address Meridian sees for rate limiting. Only trust forwarding headers when running behind your own proxy (Vercel, a load balancer). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || req.headers.get('x-real-ip') || 'unknown';
}

/** CSRF defence for state-changing requests: the browser's Origin must be this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  try { const o = new URL(origin); return o.host === host && o.protocol === `${proto}:`; } catch { return false; }
}
