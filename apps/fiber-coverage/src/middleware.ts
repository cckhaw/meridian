import { NextResponse, type NextRequest } from 'next/server';

/** First line of defence only: page requests without a session cookie go to the sign-in page. The API validates the session against the database on every call. */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === '/login') return NextResponse.next();
  if (req.cookies.has('fiber_session') || req.cookies.has('__Host-fiber_session')) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}
export const config = { matcher: ['/((?!api/|tmf-api/|_next/|favicon.ico|icon.svg).*)'] };
