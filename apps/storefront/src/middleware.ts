import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from '@/lib/csp';

/** Gives every page its own script nonce: the policy goes on the request (so Next can put the nonce on its scripts and the layout can read it) and on the response. */
export function middleware(req: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}
export const config = { matcher: ['/((?!api/|_next/|brand/|favicon.ico|icon.svg).*)'] };
