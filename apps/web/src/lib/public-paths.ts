/** Pages that work without a session. Shared by the client-side Gate and the middleware so the two cannot drift apart. */
const PUBLIC_EXACT = ['/login', '/pay/done', '/forgot-password', '/reset-password'];

/** True for the public pages, and for anything under /login/ (the single sign-on return page runs before a session exists). */
export function isPublicPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return PUBLIC_EXACT.includes(p) || p.startsWith('/login/');
}
