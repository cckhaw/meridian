import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from '@/lib/csp';
import { isPublicPath } from '@/lib/public-paths';

/**
 * First line of defence only: page requests without a session cookie are sent to the login screen before anything renders.
 * The cookie is NOT trusted here; the API validates it against the database on every request.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Every page gets its own script nonce: the policy goes on the request (so Next can put the nonce on its scripts and the layout can read it) and on the response.
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const next = () => { const res = NextResponse.next({ request: { headers } }); res.headers.set('content-security-policy', csp); return res; };
  if (isPublicPath(pathname)) return next();
  const has = req.cookies.has('meridian_session') || req.cookies.has('__Host-meridian_session');
  if (has) return next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!api/|_next/|favicon.ico|icon.svg).*)'] };
