'use client';
import { Alert, Button, Card, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ApiError, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Where the identity provider sends the browser back: trades the one-time code for a Meridian session. */
function Finish() {
  const q = useSearchParams();
  const router = useRouter();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);   // the code works once; a second effect run must not try again
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const code = q.get('code'), state = q.get('state');
    if (q.get('error')) { setError(q.get('error_description') || 'The sign-in provider refused the sign-in.'); return; }
    if (!code || !state) { setError('This page is only for returning from your company sign-in.'); return; }
    post('/auth/sso/callback', { code, state })
      .then(async (r) => {
        await refresh();
        let next = r?.user?.home ?? '/';
        try { next = sessionStorage.getItem('sso-next') || next; sessionStorage.removeItem('sso-next'); } catch { /* private mode */ }
        router.replace(next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/');
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Sign-in failed. Please try again.'));
  }, [q, router, refresh]);
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm text-center">
        {error ? (
          <Card><Alert>{error}</Alert><Link href="/login"><Button className="mt-4 w-full">Back to sign in</Button></Link></Card>
        ) : (<><Spinner label="Signing you in" /><p className="mt-3 text-subhead text-label2">Signing you in…</p></>)}
      </div>
    </main>
  );
}
export default function Page() { return <Suspense><Finish /></Suspense>; }
