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

/**
 * The address Meridian sees for rate limiting. A client can put anything at the front of `X-Forwarded-For`; each proxy in front of the app appends the address it received the request
 * from, so the trustworthy entry is the one the nearest trusted proxy added: counted from the **end**. MERIDIAN_TRUSTED_PROXY_HOPS is how many proxies are in front (default 1: Vercel, or
 * one load balancer; add one for each extra CDN or proxy). With no forwarding header the address is "unknown".
 */
export function clientIp(req: Request, env: Record<string, string | undefined> = process.env): string {
  const hops = Math.min(Math.max(Math.floor(Number(env.MERIDIAN_TRUSTED_PROXY_HOPS ?? 1)) || 1, 1), 10);
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (chain.length) return chain[Math.max(0, chain.length - hops)]!.slice(0, 64);
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

/** CSRF defence for state-changing requests: the browser's Origin must be this site. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  try { const o = new URL(origin); return o.host === host && o.protocol === `${proto}:`; } catch { return false; }
}
