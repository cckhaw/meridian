'use client';
import { Alert, Button, Card, Field, Input } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useApi } from '@/lib/api';
import { useBrand } from '@/components/settings-provider';

/** Step one of recovery: say who you are. The answer is the same whoever you name, so this cannot be used to find out who has an account. */
export default function ForgotPassword() {
  const brand = useBrand();
  const pol = useApi<{ recovery: { enabled: boolean; channel: string } }>('/auth/password-policy');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await post('/auth/forgot-password', { identifier: id }); setSent(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const off = pol.data && !pol.data.recovery.enabled;
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-title1 font-bold tracking-tight">{brand.name}</h1>
        <p className="mb-6 text-center text-body text-label2">Reset your password</p>
        <Card>
          {off ? <Alert tone="info">Password recovery is switched off here. Ask an administrator to reset your password.</Alert> : sent ? (
            <div className="space-y-4">
              <Alert tone="success">If that account exists and has a way to reach it, a link or a six-digit code is on its way. It works once and expires soon.</Alert>
              <Link href="/reset-password" className="inline-flex min-h-tap items-center text-accent">I have a code ›</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Field label="Username or e-mail" hint="We will send a link to your e-mail or a code to your mobile, whichever is on your account."><Input autoComplete="username" autoCapitalize="none" required autoFocus value={id} onChange={(e) => setId(e.target.value)} /></Field>
              {error && <Alert>{error}</Alert>}
              <Button type="submit" className="w-full" disabled={busy || !id.trim()}>{busy ? 'Sending…' : 'Send link or code'}</Button>
            </form>
          )}
        </Card>
        <p className="mt-6 text-center"><Link href="/login" className="inline-flex min-h-tap items-center text-subhead text-accent">‹ Back to sign in</Link></p>
      </div>
    </main>
  );
}
