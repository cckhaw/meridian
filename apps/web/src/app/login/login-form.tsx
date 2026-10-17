'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, post } from '@/lib/api';
import { useBrand } from '@/components/settings-provider';
import { useAuth } from '@/lib/auth';

/** Only same-site paths are honoured, so a crafted ?next= cannot bounce a user to another site after sign-in. */
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : null);

export function LoginForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const { me, refresh } = useAuth();
  const brand = useBrand();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => { api<{ items: Array<{ id: string; label: string }> }>('/auth/sso/providers').then((r) => setSso(r.items)).catch(() => {}); }, []);
  const startSso = async (id: string) => {
    setBusy(true); setError(null);
    try { try { sessionStorage.setItem('sso-next', next ?? '/'); } catch { /* private mode */ } const r = await post<{ url: string }>('/auth/sso/start', { providerId: id }); window.location.href = r.url; }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Single sign-on is not available right now.'); setBusy(false); }
  };
  const [error, setError] = useState<string | null>(null);
  // Second step: set when the password was right but a code is needed.
  const [mfa, setMfa] = useState<null | { token: string; methods: string[]; method: string; sentTo?: string }>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => { if (me) router.replace(next ?? me.home); }, [me, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post('/auth/login', { username, password });
      if (r.mfaRequired) { setMfa(r.challenge); setPassword(''); setCode(''); setUseRecovery(false); return; }
      await refresh();
      router.replace(r.user.mustChangePassword ? '/change-password' : next ?? r.user.home);
    } catch (err) {
      const a = err as ApiError;
      setError(a.code === 'MISCONFIGURED' ? 'The system is not configured yet. Contact your administrator.' : a.message);
      setPassword('');
    } finally { setBusy(false); }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfa) return;
    setBusy(true); setError(null);
    try {
      const r = await post('/auth/verify-2fa', { challenge: mfa.token, ...(useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') }) });
      await refresh();
      router.replace(r.user.mustChangePassword ? '/change-password' : r.user.mfaEnrollRequired ? '/profile?setup=mfa' : next ?? r.user.home);
    } catch (err) { setError((err as ApiError).message); setCode(''); } finally { setBusy(false); }
  };
  const sendInstead = async (method: 'SMS' | 'EMAIL') => {
    if (!mfa) return;
    setBusy(true); setError(null);
    try { const r = await post('/auth/2fa/send-code', { challenge: mfa.token, method }); setMfa({ ...mfa, method, sentTo: r.sentTo }); setUseRecovery(false); setCode(''); } catch (err) { setError((err as ApiError).message); } finally { setBusy(false); }
  };
  const prompt: Record<string, string> = { TOTP: 'Open your authenticator app and enter the 6-digit code.', SMS: 'We texted a 6-digit code to', EMAIL: 'We e-mailed a 6-digit code to' };

  if (mfa) return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-title1 font-bold tracking-tight">Confirm it is you</h1>
        <p className="mb-6 text-center text-body text-label2">{useRecovery ? 'Enter one of your recovery codes.' : `${prompt[mfa.method] ?? ''}${mfa.sentTo ? ` ${mfa.sentTo}.` : ''}`}</p>
        <Card>
          <form onSubmit={verify} className="space-y-4">
            <Field label={useRecovery ? 'Recovery code' : '6-digit code'}>
              <Input name="otp" inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus maxLength={useRecovery ? 12 : 7} value={code} onChange={(e) => setCode(e.target.value)} className="text-center font-mono text-title3 tracking-widest" />
            </Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
          </form>
          <div className="mt-4 flex flex-col gap-1 border-t border-separator pt-3 text-subhead">
            {!useRecovery && mfa.methods.filter((m) => m !== mfa.method).map((m) => (
              <button key={m} type="button" disabled={busy} onClick={() => (m === 'TOTP' ? (setMfa({ ...mfa, method: 'TOTP', sentTo: undefined }), setCode('')) : void sendInstead(m as 'SMS' | 'EMAIL'))} className="min-h-tap text-left text-accent">{m === 'TOTP' ? 'Use my authenticator app instead' : m === 'SMS' ? 'Text me a code instead' : 'E-mail me a code instead'}</button>))}
            {!useRecovery && mfa.method !== 'TOTP' && <button type="button" disabled={busy} onClick={() => void sendInstead(mfa.method as 'SMS' | 'EMAIL')} className="min-h-tap text-left text-accent">Send the code again</button>}
            <button type="button" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(null); }} className="min-h-tap text-left text-accent">{useRecovery ? 'Use a code instead' : 'I lost my phone: use a recovery code'}</button>
            <button type="button" onClick={() => { setMfa(null); setError(null); }} className="min-h-tap text-left text-label2">‹ Back to sign in</button>
          </div>
        </Card>
      </div>
    </main>
  );

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {brand.logoUrl ? (
            // The logo is the brand: it replaces the name rather than sitting above it. The name stays in the page for screen readers.
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={brand.logoUrl} alt="" className="mx-auto mb-3 max-h-20 w-auto max-w-[300px] object-contain" />
              <h1 className="sr-only">{brand.name}</h1>
            </>
          ) : (
            <>
              <div aria-hidden className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-[16px] bg-accent text-title2 font-bold text-accent-fg">{brand.name.slice(0, 1).toUpperCase()}</div>
              <h1 className="text-title1 font-bold tracking-tight">{brand.name}</h1>
            </>
          )}
          <p className="mt-1 text-body text-label2">Sign in to continue</p>
        </div>
        <Card>
          <form onSubmit={submit} className="space-y-4" autoComplete="on">
            <Field label="Username"><Input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" required autoFocus value={username} onChange={(e) => setUsername(e.target.value)}
              // Tab (and the keyboard's Next key) always lands on the password, whatever the browser or a password manager does in between.
              onKeyDown={(e) => { if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && username && !password)) { e.preventDefault(); passwordRef.current?.focus(); } }} /></Field>
            <div>
              <label htmlFor="password" className="mb-1 block text-subhead font-medium text-label">Password</label>
              <div className="relative">
                <Input id="password" ref={passwordRef} name="password" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="pr-20" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 min-w-tap px-3 text-subhead text-accent">{show ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" className="w-full" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
          {sso.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-separator pt-4">
              {sso.map((p) => <Button key={p.id} type="button" variant="secondary" className="w-full" disabled={busy} onClick={() => void startSso(p.id)}>{p.label}</Button>)}
            </div>
          )}
        </Card>
        <p className="mt-4 text-center"><Link href="/forgot-password" className="inline-flex min-h-tap items-center text-subhead text-accent">Forgot your password?</Link></p>
        <p className="mt-6 text-center text-footnote text-label2">Access is limited to authorised users. Activity is logged.</p>
      </div>
    </main>
  );
}
