'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, post } from '@/lib/api';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (me) router.replace(next ?? me.home); }, [me, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await post('/auth/login', { username, password });
      await refresh();
      router.replace(r.user.mustChangePassword ? '/change-password' : next ?? r.user.home);
    } catch (err) {
      const a = err as ApiError;
      setError(a.code === 'MISCONFIGURED' ? 'The system is not configured yet. Contact your administrator.' : a.message);
      setPassword('');
    } finally { setBusy(false); }
  };

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
            <Field label="Username"><Input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <div>
              <label htmlFor="password" className="mb-1 block text-subhead font-medium text-label">Password</label>
              <div className="relative">
                <Input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="pr-20" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 min-w-tap px-3 text-subhead text-accent">{show ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" className="w-full" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </Card>
        <p className="mt-6 text-center text-footnote text-label2">Access is limited to authorised users. Activity is logged.</p>
      </div>
    </main>
  );
}
