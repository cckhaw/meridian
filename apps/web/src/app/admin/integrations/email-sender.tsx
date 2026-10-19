'use client';
import { Alert, Badge, Button, Field, Input, Modal, Select, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { dt } from '@/lib/format';
import type { Hub } from './integration-hub';

/**
 * The e-mail sender (Integration → Messaging → E-mail sender): who the mail comes from and how it is sent (HTTPS API, SMTP or the simulator). Everything is a field,
 * no JSON settings; the token or SMTP password is write-only and kept encrypted like every other hub secret. Saved through the hub's endpoint API (group auth, kind EMAIL_GATEWAY).
 */
interface Form {
  id?: string; name: string; enabled: boolean; secret: string; clearSecret: boolean; hasSecret: boolean; url: string; timeoutMs: number;
  c: { mode: 'API' | 'SMTP' | 'SIMULATOR'; fromName: string; fromAddress: string; replyTo: string; auth: 'BEARER' | 'HEADER' | 'NONE'; authHeader: string; bodyTemplate: string; smtpHost: string; smtpPort: number; smtpSecurity: 'STARTTLS' | 'TLS' | 'NONE'; smtpUser: string };
}
const MODE_LABEL = { API: 'HTTPS API', SMTP: 'SMTP', SIMULATOR: 'Simulator' } as const;
const PLACEHOLDERS = '{{to}} {{subject}} {{text}} {{html}} {{from}} {{fromName}} {{replyTo}}';

const blank = (h: Hub): Form => ({
  name: 'E-mail', enabled: true, secret: '', clearSecret: false, hasSecret: false, url: '', timeoutMs: 10000,
  c: { mode: 'API', fromName: '', fromAddress: '', replyTo: '', auth: h.emailPresets[0]?.auth ?? 'BEARER', authHeader: h.emailPresets[0]?.authHeader ?? '', bodyTemplate: h.emailPresets[0]?.bodyTemplate ?? '', smtpHost: '', smtpPort: 587, smtpSecurity: 'STARTTLS', smtpUser: '' },
});
const fromEndpoint = (e: any, h: Hub): Form => ({ ...blank(h), id: e.id, name: e.name, enabled: e.enabled, hasSecret: e.hasSecret, url: e.url ?? '', timeoutMs: e.timeoutMs, c: { ...blank(h).c, ...(e.config ?? {}), replyTo: e.config?.replyTo ?? '', smtpUser: e.config?.smtpUser ?? '' } });

export function EmailSender({ h, reload }: { h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const items = h.endpoints.filter((e) => e.kind === 'EMAIL_GATEWAY');
  const [f, setF] = useState<Form | null>(null);
  const [test, setTest] = useState<{ id: string; to: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const me = useApi<{ email?: string | null }>(test ? '/profile' : null);
  const sim = useApi<{ items: Array<{ id: string; to: string; subject: string; text: string; at: string }> }>(items.some((e) => e.config?.mode === 'SIMULATOR') ? '/settings/integration-hub/email/simulated' : null);
  const set = (k: keyof Form['c'], v: unknown) => setF((x) => (x ? { ...x, c: { ...x.c, [k]: v } } : x));
  const c = f?.c;

  const save = async () => {
    if (!f) return;
    const k = f.c;
    const config: Record<string, unknown> = { mode: k.mode, fromName: k.fromName, fromAddress: k.fromAddress, ...(k.replyTo ? { replyTo: k.replyTo } : {}) };
    if (k.mode === 'API') Object.assign(config, { auth: k.auth, ...(k.auth === 'HEADER' ? { authHeader: k.authHeader } : {}), bodyTemplate: k.bodyTemplate });
    if (k.mode === 'SMTP') Object.assign(config, { smtpHost: k.smtpHost, smtpPort: Number(k.smtpPort), smtpSecurity: k.smtpSecurity, ...(k.smtpUser ? { smtpUser: k.smtpUser } : {}) });
    const body = { group: 'auth', kind: 'EMAIL_GATEWAY', name: f.name, url: k.mode === 'API' ? f.url || null : null, timeoutMs: Number(f.timeoutMs), config, enabled: f.enabled, secret: f.clearSecret ? '' : f.secret ? f.secret : undefined };
    if (await act.run(() => (f.id ? patch(`/settings/integration-hub/endpoints/${f.id}`, body) : post('/settings/integration-hub/endpoints', body)), 'Saved')) setF(null);
  };
  const sendTest = async () => {
    if (!test) return;
    setResult(null);
    try {
      const r = await post<{ ok: boolean; error?: string; simulated: boolean }>(`/settings/integration-hub/email/${test.id}/test`, { to: test.to });
      setResult(r.ok ? { ok: true, text: r.simulated ? 'Recorded by the simulator below. Nothing was sent.' : `Sent to ${test.to}. Check the inbox.` } : { ok: false, text: r.error ?? 'The e-mail was not sent.' });
      await reload();
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); }
  };
  const secretLabel = c?.mode === 'SMTP' ? 'SMTP password' : 'API token';

  return (
    <section aria-label="E-mail sender">
      <div className="mb-2 mt-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">Sender</h3>
        <Button variant="secondary" onClick={() => setF(blank(h))}>Add an e-mail sender</Button>
      </div>
      <div className="rounded-control bg-surface2 p-3">
        {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        {items.length === 0 ? <p className="text-subhead text-label2">No e-mail sender yet. Until one is added and switched on, e-mail alerts wait in the notification outbox and e-mail codes are not offered anywhere.</p> : (
          <ul className="divide-y divide-separator">
            {items.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-center gap-3 py-2 ${e.enabled ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{e.name}</span>{!e.enabled && <Badge>Off</Badge>}{e.hasSecret && <Badge tone="success">Secret set</Badge>}<Badge>{MODE_LABEL[e.config?.mode as keyof typeof MODE_LABEL] ?? 'Not set'}</Badge></div>
                  <p className="truncate text-footnote text-label2">{e.config?.fromName} &lt;{e.config?.fromAddress}&gt;{e.config?.mode === 'API' ? ` · ${e.url ?? 'no address'}` : e.config?.mode === 'SMTP' ? ` · ${e.config.smtpHost}:${e.config.smtpPort}` : ''}</p>
                </div>
                <Button variant="secondary" onClick={() => { setResult(null); setTest({ id: e.id, to: '' }); }}>Send a test e-mail</Button>
                <Button variant="secondary" onClick={() => setF(fromEndpoint(e, h))}>Edit</Button>
                <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Remove ${e.name}?`) && void act.run(() => del(`/settings/integration-hub/endpoints/${e.id}`), 'Removed')}>Remove</button>
              </li>))}
          </ul>)}
        {items.filter((e) => e.enabled).length > 1 && <p className="mt-2 text-footnote text-warning">More than one sender is on. Only the oldest one is used; switch the others off.</p>}
        {sim.data && sim.data.items.length > 0 && (
          <div className="mt-3"><p className="mb-1 text-footnote font-semibold text-label2">Recorded by the simulator (newest first; messages that carry sign-in codes are kept here in clear, so use the simulator only to try things out)</p>
            <ul className="space-y-1 text-footnote text-label2">{sim.data.items.slice(0, 8).map((m) => <li key={m.id}>{dt(m.at)} · to {m.to} · <b className="text-label">{m.subject}</b><span className="block whitespace-pre-wrap">{m.text}</span></li>)}</ul></div>)}
      </div>

      {test && (
        <Modal title="Send a test e-mail" onClose={() => { setTest(null); setResult(null); }}>
          <div className="space-y-3">
            <Field label="Send it to" hint={me.data?.email ? 'Type an address, or use your own.' : 'Type the address to send the test to.'}><Input type="email" value={test.to} placeholder={me.data?.email ?? 'you@example.com'} onChange={(e) => setTest({ ...test, to: e.target.value })} /></Field>
            {me.data?.email && test.to !== me.data.email && <button type="button" className="text-footnote text-accent" onClick={() => setTest({ ...test, to: me.data!.email! })}>Use my address ({me.data.email})</button>}
            {result && <Alert tone={result.ok ? 'success' : 'danger'}>{result.text}</Alert>}
            <div className="flex gap-2"><Button disabled={!test.to.trim()} onClick={() => void sendTest()}>Send</Button><Button variant="secondary" onClick={() => { setTest(null); setResult(null); }}>Close</Button></div>
          </div>
        </Modal>)}

      {f && c && (
        <Modal title={`${f.id ? 'Edit' : 'New'} e-mail sender`} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Name" hint="For your own reference."><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="How it sends"><Select value={c.mode} onChange={(e) => set('mode', e.target.value)}><option value="API">HTTPS API of an e-mail provider</option><option value="SMTP">SMTP server</option><option value="SIMULATOR">Simulator (records, sends nothing)</option></Select></Field>
            <Field label="Sender name" hint="Shown to the person who gets the e-mail."><Input value={c.fromName} maxLength={80} onChange={(e) => set('fromName', e.target.value)} /></Field>
            <Field label="From address" hint="Your provider usually requires a verified address or domain."><Input type="email" value={c.fromAddress} onChange={(e) => set('fromAddress', e.target.value)} /></Field>
            <Field label="Reply-to address (optional)"><Input type="email" value={c.replyTo} onChange={(e) => set('replyTo', e.target.value)} /></Field>
            <Field label="Time limit (milliseconds)" hint="100 to 120,000."><Input type="number" min={100} max={120000} value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: Number(e.target.value) })} /></Field>

            {c.mode === 'API' && <>
              <div className="sm:col-span-2"><Field label="Start from a preset" hint="Fills the token placement and the request body below. Adjust the field names to your provider’s documentation.">
                <Select value="" onChange={(e) => { const p = h.emailPresets.find((x) => x.id === e.target.value); if (p) setF({ ...f, c: { ...c, auth: p.auth, authHeader: p.authHeader, bodyTemplate: p.bodyTemplate } }); }}><option value="">Choose a preset…</option>{h.emailPresets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></Field></div>
              <div className="sm:col-span-2"><Field label="Provider address" hint="The address that accepts a message, https://…"><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field></div>
              <Field label="The token is sent as"><Select value={c.auth} onChange={(e) => set('auth', e.target.value)}><option value="BEARER">A bearer token (Authorization header)</option><option value="HEADER">A header with a name I choose</option><option value="NONE">No token</option></Select></Field>
              {c.auth === 'HEADER' ? <Field label="Header name" hint="For example x-api-key."><Input value={c.authHeader} onChange={(e) => set('authHeader', e.target.value)} /></Field> : <span />}
              <div className="sm:col-span-2"><Field label="Request body (JSON)" hint={`Placeholders: ${PLACEHOLDERS}. Put them in values; each is filled in safely. A field whose whole value is one placeholder with nothing to fill (no reply-to, no HTML) is left out.`}>
                <Textarea rows={10} value={c.bodyTemplate} onChange={(e) => set('bodyTemplate', e.target.value)} className="font-mono text-footnote" /></Field></div>
            </>}
            {c.mode === 'SMTP' && <>
              <Field label="SMTP host"><Input value={c.smtpHost} placeholder="smtp.example.com" onChange={(e) => set('smtpHost', e.target.value)} /></Field>
              <Field label="Port" hint="587 for STARTTLS, 465 for TLS."><Input type="number" min={1} max={65535} value={c.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} /></Field>
              <Field label="Connection security" hint="Without encryption is only allowed to this machine itself in production."><Select value={c.smtpSecurity} onChange={(e) => set('smtpSecurity', e.target.value)}><option value="STARTTLS">STARTTLS (upgrade the connection, required)</option><option value="TLS">TLS from the start</option><option value="NONE">None</option></Select></Field>
              <Field label="SMTP user" hint="Leave empty if the server needs no sign-in."><Input value={c.smtpUser} autoComplete="off" onChange={(e) => set('smtpUser', e.target.value)} /></Field>
            </>}
            {c.mode === 'SIMULATOR' && <div className="sm:col-span-2"><Alert tone="info">The simulator records each message (shown on this page) and sends nothing, so nobody receives anything, including sign-in codes. Use it to try the screens, then switch to a real sender.</Alert></div>}

            {c.mode !== 'SIMULATOR' && !(c.mode === 'API' && c.auth === 'NONE') && <Field label={secretLabel} hint={f.hasSecret ? 'Set. Enter a new value to replace it. It is never shown.' : 'Encrypted and never shown again.'}><Input type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>}
            {f.hasSecret ? <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={f.clearSecret} onChange={(e) => setF({ ...f, clearSecret: e.target.checked })} /> Remove the stored secret</label> : <span />}
            <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Sender is on</label>
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
            <p className="text-footnote text-label2 sm:col-span-2">After saving, use “Send a test e-mail” on the sender. Sign-in and recovery codes by e-mail are switched on separately in Settings → Security policy.</p>
          </div>
        </Modal>)}
    </section>
  );
}
