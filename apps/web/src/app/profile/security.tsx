'use client';
import { Alert, Badge, Button, Card, Field, Input, Modal, SectionTitle, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { PasswordField, meetsRules, usePasswordRules } from '@/components/password-field';
import { api, del, post, useAction, useApi } from '@/lib/api';
import { dt } from '@/lib/format';
import type { Profile } from './page';

interface Sec { mfa: { methods: Array<{ kind: 'TOTP' | 'SMS' | 'EMAIL'; confirmedAt: string }>; recoveryCodesLeft: number }; allowedMethods: Array<'TOTP' | 'SMS' | 'EMAIL'>; required: boolean; canUseMfa: boolean; hasPhone: boolean; hasEmail: boolean }
interface Sess { id: string; device: string; ip: string | null; lastSeenAt: string; createdAt: string; current: boolean }
const LABEL = { TOTP: 'Authenticator app', SMS: 'Text message (SMS)', EMAIL: 'E-mail' } as const;
const HINT = { TOTP: 'A code from Google Authenticator, Authy or similar. Works without a signal.', SMS: 'A 6-digit code sent to your mobile number.', EMAIL: 'A 6-digit code sent to your e-mail address.' } as const;

export function SecurityTab({ p }: { p: Profile }) {
  return (
    <div className="grid max-w-3xl gap-8">
      <PasswordCard p={p} />
      <TwoFactor p={p} />
      <Sessions />
    </div>
  );
}

function PasswordCard({ p }: { p: Profile }) {
  const rules = usePasswordRules();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const act = useAction();
  const [done, setDone] = useState(false);
  if (p.isSuperuser) return null;
  const ok = f.current && meetsRules(rules, f.next, p.username) && f.next === f.again;
  return (
    <section aria-label="Password">
      <SectionTitle>Password</SectionTitle>
      <Card>
        <p className="mb-3 text-footnote text-label2">{p.passwordChangedAt ? `Last changed ${dt(p.passwordChangedAt)}.` : 'Not changed since your account was created.'} Changing it signs you out on every device.</p>
        {done ? <Alert tone="success">Password changed. Signing you out so you can sign in again…</Alert> : (
          <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post('/auth/change-password', { current: f.current, next: f.next }))) { setDone(true); setTimeout(() => window.location.assign('/login'), 1500); } }}>
            <Field label="Current password"><Input type="password" autoComplete="current-password" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
            <PasswordField value={f.next} onChange={(v) => setF({ ...f, next: v })} username={p.username} />
            <Field label="Repeat new password" error={f.again && f.next !== f.again ? 'The two passwords do not match.' : undefined}><Input type="password" autoComplete="new-password" required value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
            {act.error && <Alert>{act.error}</Alert>}
            <Button type="submit" disabled={act.busy || !ok}>{act.busy ? 'Saving…' : 'Change password'}</Button>
          </form>)}
      </Card>
    </section>
  );
}

function TwoFactor({ p }: { p: Profile }) {
  const sec = useApi<Sec>('/profile/security');
  const act = useAction(async () => { await sec.reload(); });
  const [wizard, setWizard] = useState<null | 'TOTP' | 'SMS' | 'EMAIL'>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState<null | { kind: 'TOTP' | 'SMS' | 'EMAIL' | 'CODES'; password: string }>(null);
  if (!sec.data) return <section><SectionTitle>Two-step sign-in</SectionTitle><Spinner /></section>;
  const s = sec.data;
  if (!s.canUseMfa) return <section><SectionTitle>Two-step sign-in</SectionTitle><Alert tone="info">The super user signs in with credentials from the server’s environment, so a second step cannot be added here.</Alert></section>;
  const on = new Set(s.mfa.methods.map((m) => m.kind));
  return (
    <section aria-label="Two-step sign-in">
      <SectionTitle>Two-step sign-in</SectionTitle>
      <Card className="space-y-4">
        <p className="text-subhead text-label2">After your password, you enter a code only you can get. {s.required ? <strong className="text-label">Your role requires it.</strong> : 'It is optional, and it stops anyone who learns your password from signing in.'}</p>
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        <ul className="divide-y divide-separator">
          {s.allowedMethods.map((k) => (
            <li key={k} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><p className="font-medium">{LABEL[k]} {on.has(k) && <Badge tone="success">On</Badge>}</p><p className="text-footnote text-label2">{HINT[k]}{k === 'SMS' && !s.hasPhone ? ' Add your mobile number on the Personal tab first.' : ''}{k === 'EMAIL' && !s.hasEmail ? ' Add your e-mail address on the Personal tab first.' : ''}</p></div>
              {on.has(k) ? <Button variant="secondary" onClick={() => setOff({ kind: k, password: '' })}>Turn off</Button>
                : <Button variant="secondary" disabled={(k === 'SMS' && !s.hasPhone) || (k === 'EMAIL' && !s.hasEmail)} onClick={() => setWizard(k)}>Set up</Button>}
            </li>))}
        </ul>
        {on.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-separator pt-3">
            <p className="flex-1 text-subhead">Recovery codes: <strong>{s.mfa.recoveryCodesLeft}</strong> left. Use one if you lose your phone.</p>
            <Button variant="secondary" onClick={() => setOff({ kind: 'CODES', password: '' })}>Get new codes</Button>
          </div>)}
      </Card>
      {wizard && <Wizard kind={wizard} onClose={() => setWizard(null)} onDone={(c) => { setWizard(null); void sec.reload(); if (c) setCodes(c); }} />}
      {codes && <Codes codes={codes} onClose={() => setCodes(null)} />}
      {off && (
        <Modal title={off.kind === 'CODES' ? 'Get new recovery codes' : `Turn off ${LABEL[off.kind]}`} onClose={() => setOff(null)}>
          <form className="space-y-4" onSubmit={async (e) => {
            e.preventDefault();
            const ok = off.kind === 'CODES'
              ? await act.run(async () => { const r = await post('/profile/mfa/recovery-codes', { password: off.password }); setCodes(r.recoveryCodes); })
              : await act.run(() => post('/profile/mfa/disable', { kind: off.kind, password: off.password }), 'Turned off');
            if (ok) setOff(null);
          }}>
            <p className="text-subhead text-label2">{off.kind === 'CODES' ? 'Your old codes stop working.' : 'Anyone with your password will be able to sign in without this step.'} Enter your password to confirm.</p>
            <Field label="Password"><Input type="password" autoComplete="current-password" required autoFocus value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} /></Field>
            {act.error && <Alert>{act.error}</Alert>}
            <div className="flex gap-2"><Button type="submit" disabled={act.busy || !off.password}>Confirm</Button><Button type="button" variant="secondary" onClick={() => setOff(null)}>Cancel</Button></div>
          </form>
        </Modal>)}
      <span className="sr-only">{p.username}</span>
    </section>
  );
}

function Wizard({ kind, onClose, onDone }: { kind: 'TOTP' | 'SMS' | 'EMAIL'; onClose: () => void; onDone: (codes?: string[]) => void }) {
  const act = useAction();
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const start = async () => { await act.run(async () => { if (kind === 'TOTP') setSetup(await post('/profile/mfa/totp/start')); else setSentTo((await post('/profile/mfa/otp/start', { kind })).sentTo); }); };
  const confirm = async () => { await act.run(async () => { const r = kind === 'TOTP' ? await post('/profile/mfa/totp/confirm', { code }) : await post('/profile/mfa/otp/confirm', { kind, code }); onDone(r.recoveryCodes); }); };
  const started = !!(setup || sentTo);
  return (
    <Modal title={`Set up ${LABEL[kind].toLowerCase()}`} onClose={onClose}>
      <div className="space-y-4">
        {act.error && <Alert>{act.error}</Alert>}
        {!started ? (
          <>
            <p className="text-subhead text-label2">{kind === 'TOTP' ? 'You will scan a code with an authenticator app (Google Authenticator, Authy, Microsoft Authenticator or 1Password), then enter the 6-digit code it shows.' : `We will send a 6-digit code to the ${kind === 'SMS' ? 'mobile number' : 'e-mail address'} on your profile.`}</p>
            <Button onClick={() => void start()} disabled={act.busy}>{kind === 'TOTP' ? 'Show the code to scan' : 'Send me a code'}</Button>
          </>
        ) : (
          <>
            {setup && (
              <div className="space-y-3 text-center">
                <p className="text-subhead text-label2">1. Scan this with your authenticator app.</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="QR code for your authenticator app" className="mx-auto h-48 w-48 rounded-card bg-white p-2" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} />
                <p className="text-footnote text-label2">Cannot scan? Enter this key in the app:</p>
                <code className="block select-all break-all rounded-control bg-surface2 px-3 py-2 font-mono text-footnote">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                <p className="text-subhead text-label2">2. Enter the 6-digit code the app shows.</p>
              </div>)}
            {sentTo && <p className="text-subhead text-label2">We sent a code to <strong className="text-label">{sentTo}</strong>. It expires in a few minutes.</p>}
            <Field label="6-digit code"><Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} className="text-center font-mono text-title3 tracking-widest" /></Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void confirm()} disabled={act.busy || code.replace(/\s/g, '').length !== 6}>Turn on</Button>
              {kind !== 'TOTP' && <Button variant="secondary" onClick={() => void start()} disabled={act.busy}>Send again</Button>}
              <Button variant="plain" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Codes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const text = codes.join('\n');
  return (
    <Modal title="Save your recovery codes" onClose={onClose}>
      <div className="space-y-4">
        <Alert tone="info">Keep these somewhere safe. Each works once if you lose your phone. They are not shown again.</Alert>
        <ul className="grid grid-cols-2 gap-2 rounded-card bg-surface2 p-4 font-mono text-subhead">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</Button>
          <Button variant="secondary" onClick={() => { const a = document.createElement('a'); a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(`Meridian recovery codes\n\n${text}\n`)}`; a.download = 'meridian-recovery-codes.txt'; a.click(); }}>Download</Button>
          <Button onClick={onClose}>I have saved them</Button>
        </div>
      </div>
    </Modal>
  );
}

function Sessions() {
  const list = useApi<Sess[]>('/profile/sessions');
  const act = useAction(async () => { await list.reload(); });
  return (
    <section aria-label="Signed-in devices">
      <SectionTitle action={list.data && list.data.length > 1 ? <Button variant="secondary" disabled={act.busy} onClick={() => confirm('Sign out of every other device?') && void act.run(() => post('/profile/sessions/revoke-others'), 'Signed out everywhere else')}>Log out all other sessions</Button> : undefined}>Where you are signed in</SectionTitle>
      <Card>
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        {!list.data ? <Spinner /> : (
          <ul className="divide-y divide-separator">
            {list.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1"><p className="font-medium">{s.device} {s.current && <Badge tone="success">This device</Badge>}</p><p className="text-footnote text-label2">{s.ip ?? 'Unknown address'} · active {dt(s.lastSeenAt)} · since {dt(s.createdAt)}</p></div>
                {!s.current && <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => del(`/profile/sessions/${s.id}`), 'Signed out')}>Sign out</Button>}
              </li>))}
          </ul>)}
      </Card>
    </section>
  );
}
