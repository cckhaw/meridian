'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, post } from '@/lib/api';

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : '/settings/fiber-coverage');

function Form() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { const r = await fn(); if (r.mfaRequired) setChallenge(r.challenge.token ?? r.challenge); else router.replace(next); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  };
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div aria-hidden className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-[16px] bg-accent text-title2 font-bold text-accent-fg">F</div>
          <h1 className="text-title1 font-bold tracking-tight">Fibre coverage</h1>
          <p className="mt-1 text-body text-label2">Sign in with your Meridian account</p>
        </div>
        <Card>
          {!challenge ? (
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(() => post('/admin/login', { username: u, password: p })); }}>
              <Field label="Username"><Input name="username" autoComplete="username" autoCapitalize="none" required autoFocus value={u} onChange={(e) => setU(e.target.value)} /></Field>
              <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required value={p} onChange={(e) => setP(e.target.value)} /></Field>
              {error && <Alert>{error}</Alert>}
              <Button type="submit" className="w-full" disabled={busy || !u || !p}>{busy ? 'Signing in…' : 'Sign in'}</Button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(() => post('/admin/verify-2fa', { challenge, ...(code.includes('-') || code.length > 8 ? { recoveryCode: code.trim() } : { code: code.trim() }) })); }}>
              <Field label="Code from your authenticator, SMS or e-mail" hint="Or one of your recovery codes."><Input name="otp" inputMode="numeric" autoComplete="one-time-code" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              {error && <Alert>{error}</Alert>}
              <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
            </form>
          )}
        </Card>
        <p className="mt-6 text-center text-footnote text-label2">Fibre Ops and network planning only. Activity is logged.</p>
      </div>
    </main>
  );
}
export default function Page() { return <Suspense><Form /></Suspense>; }
