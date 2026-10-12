'use client';
import { Alert, Button, Card, Field, Input, LargeTitle } from '@meridian/ui';
import { useState } from 'react';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function ChangePassword() {
  const { me } = useAuth();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (me?.isSuperuser) return <Alert tone="info">The super user password is set by the <code className="font-mono">MERIDIAN_SUPERUSER_PASSWORD</code> environment variable. Change it there and redeploy.</Alert>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) return setError('The new passwords do not match.');
    setBusy(true); setError(null);
    try { await post('/auth/change-password', { current: f.current, next: f.next }); setDone(true); setTimeout(() => window.location.assign('/login'), 1500); } // the server already ended every session
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <LargeTitle subtitle={me?.mustChangePassword ? 'Choose your own password before you continue.' : 'You will be signed out on all devices afterwards.'}>Change password</LargeTitle>
      <Card className="max-w-md">
        {done ? <Alert tone="success">Password changed. Signing you out so you can sign in again…</Alert> : (
          <form onSubmit={submit} className="space-y-4">
            <Field label="Current password"><Input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
            <Field label="New password" hint="At least 12 characters. A passphrase works well."><Input type="password" autoComplete="new-password" required minLength={12} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
            <Field label="Repeat new password"><Input type="password" autoComplete="new-password" required value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</Button>
          </form>
        )}
      </Card>
    </>
  );
}
