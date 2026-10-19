'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiError, post } from '@/lib/api';
import { BrandMark, useBrand } from '@/components/brand';

type Method = 'TOTP' | 'SMS' | 'EMAIL';
interface Challenge { token: string; methods: Method[]; method: Method; sentTo?: string; resendAfterSeconds?: number }
const NAME: Record<Method, string> = { TOTP: 'authenticator', SMS: 'SMS', EMAIL: 'e-mail' };
const orList = (a: string[]) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}` : a[0] ?? '');

const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : '/settings/fiber-coverage');

function Form() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const brand = useBrand();
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [canSend, setCanSend] = useState<{ SMS: boolean; EMAIL: boolean }>({ SMS: false, EMAIL: false });
  const [sent, setSent] = useState<null | { method: Method; to: string; pending: boolean }>(null);
  const [until, setUntil] = useState<Partial<Record<Method, number>>>({});   // when each method may be asked for a code again
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!Object.values(until).some((t) => (t ?? 0) > Date.now())) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  const wait = (m: Method) => Math.max(0, Math.ceil(((until[m] ?? 0) - now) / 1000));
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try {
      const r = await fn();
      if (r.mfaRequired) {
        const c: Challenge = r.challenge; setChallenge(c); setCanSend(r.canSend ?? { SMS: false, EMAIL: false }); setNow(Date.now());
        if (c.sentTo) { setSent({ method: c.method, to: c.sentTo, pending: r.delivery !== 'SENT' }); setUntil({ [c.method]: Date.now() + (c.resendAfterSeconds ?? 30) * 1000 }); }
      } else router.replace(next);
    }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Sign-in failed.'); }
    finally { setBusy(false); }
  };
  const sendCode = async (method: Method) => {
    if (!challenge) return;
    setSending(true); setError(null);
    try {
      const r = await post('/admin/2fa/send-code', { challenge: challenge.token, method });
      setNow(Date.now()); setSent({ method, to: r.sentTo, pending: r.delivery !== 'SENT' }); setUntil((u) => ({ ...u, [method]: Date.now() + (r.resendAfterSeconds ?? 30) * 1000 }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && e.retryAfter) { setNow(Date.now()); setUntil((u) => ({ ...u, [method]: Date.now() + e.retryAfter! * 1000 })); }
      setError(e instanceof ApiError ? e.message : 'The code could not be sent.');
    } finally { setSending(false); }
  };
  const sendable = (challenge?.methods ?? []).filter((m): m is 'SMS' | 'EMAIL' => m !== 'TOTP' && canSend[m]);
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mb-3"><BrandMark size="lg" /></div>
          <h1 className="text-title2 font-semibold tracking-tight">Fibre coverage</h1>
          <p className="mt-1 text-body text-label2">Sign in with your {brand.name} account</p>
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
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(() => post('/admin/verify-2fa', { challenge: challenge.token, ...(code.includes('-') || code.length > 8 ? { recoveryCode: code.trim() } : { code: code.trim() }) })); }}>
              <Field label={`Code from your ${orList(challenge.methods.map((m) => NAME[m]))}`} hint="Or one of your recovery codes."><Input name="otp" inputMode="numeric" autoComplete="one-time-code" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} aria-describedby="code-status" /></Field>
              <p id="code-status" role="status" aria-live="polite" className="text-subhead text-label2">
                {sent && (sent.pending ? `A code was requested for ${sent.to} but has not gone out yet. If it does not arrive within a couple of minutes, use another method.` : `A code was sent by ${NAME[sent.method]} to ${sent.to}.`)}
              </p>
              {sendable.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {sendable.map((m) => {
                    const w = wait(m), again = sent?.method === m;
                    return <Button key={m} type="button" variant="secondary" disabled={sending || w > 0} aria-disabled={sending || w > 0} onClick={() => void sendCode(m)}>
                      {w > 0 ? `${again ? 'Resend' : 'Send again'} in ${w}s` : again ? 'Resend code' : sent ? `Send it by ${NAME[m]} instead` : sendable.length > 1 ? `Send me a code by ${NAME[m]}` : 'Send me a code'}
                    </Button>;
                  })}
                </div>)}
              {error && <Alert>{error}</Alert>}
              <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
              <button type="button" className="w-full text-center text-subhead text-label2 underline" onClick={() => { setChallenge(null); setCode(''); setP(''); setSent(null); setUntil({}); setError(null); }}>Back to sign in</button>
            </form>
          )}
        </Card>
        <p className="mt-6 text-center text-footnote text-label2">Fibre Ops and network planning only. Activity is logged.</p>
      </div>
    </main>
  );
}
export default function Page() { return <Suspense><Form /></Suspense>; }
