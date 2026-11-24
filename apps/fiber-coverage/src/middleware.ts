import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from '@/lib/csp';

/** First line of defence only: page requests without a session cookie go to the sign-in page. The API validates the session against the database on every call. */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Every page gets its own script nonce: the policy goes on the request (so Next can put the nonce on its scripts and the layout can read it) and on the response.
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const next = () => { const res = NextResponse.next({ request: { headers } }); res.headers.set('content-security-policy', csp); return res; };
  if (pathname === '/login') return next();
  if (req.cookies.has('fiber_session') || req.cookies.has('__Host-fiber_session')) return next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}
export const config = { matcher: ['/((?!api/|tmf-api/|_next/|brand/|favicon.ico|icon.svg).*)'] };
