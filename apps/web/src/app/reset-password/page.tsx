'use client';
import { Alert, Button, Card, Field, Input, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { post } from '@/lib/api';
import { useBrand } from '@/components/settings-provider';
import { PasswordField } from '@/components/password-field';

/** Step two: a new password, with the link from the e-mail (the token is in the address) or the six-digit code with the username. */
export default function ResetPassword() {
  return <Suspense fallback={<Spinner />}><Reset /></Suspense>;
}

function Reset() {
  const brand = useBrand();
  const token = useSearchParams().get('token');
  const [f, setF] = useState({ identifier: '', code: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) return setError('The two passwords do not match.');
    setBusy(true); setError(null);
    try { await post('/auth/reset-password', token ? { token, newPassword: f.next } : { identifier: f.identifier, code: f.code, newPassword: f.next }); setDone(true); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-title1 font-bold tracking-tight">{brand.name}</h1>
        <p className="mb-6 text-center text-body text-label2">Choose a new password</p>
        <Card>
          {done ? (
            <div className="space-y-4"><Alert tone="success">Your password is changed. You were signed out everywhere.</Alert><Link href="/login" className="inline-flex min-h-tap items-center text-accent">Sign in ›</Link></div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {!token && <>
                <Field label="Username or e-mail"><Input autoComplete="username" autoCapitalize="none" required value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} /></Field>
                <Field label="Six-digit code" hint="From the message we sent you."><Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></Field>
              </>}
              <PasswordField value={f.next} onChange={(v) => setF({ ...f, next: v })} username={f.identifier} />
              <Field label="Repeat new password"><Input type="password" autoComplete="new-password" required value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
              {error && <Alert>{error}</Alert>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
            </form>
          )}
        </Card>
        <p className="mt-6 text-center"><Link href="/forgot-password" className="inline-flex min-h-tap items-center text-subhead text-accent">Ask for a new link or code</Link></p>
      </div>
    </main>
  );
}
