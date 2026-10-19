import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath } from '@/lib/public-paths';

/**
 * First line of defence only: page requests without a session cookie are sent to the login screen before anything renders.
 * The cookie is NOT trusted here; the API validates it against the database on every request.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const has = req.cookies.has('meridian_session') || req.cookies.has('__Host-meridian_session');
  if (has) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/((?!api/|_next/|favicon.ico|icon.svg).*)'] };
