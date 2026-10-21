'use client';
import { Alert, Button, Field, Input, Select, Spinner } from '@meridian/ui';
import Link from 'next/link';
import { useState } from 'react';
import { post, useAction, useApi } from '@/lib/api';

/** The field-service (workforce-management) connection: which system, its settings, whether it is on, and the secret its callbacks are signed with. The callback address itself is listed once, in the card's API list above. */
export function FieldServicePanel({ onSaved }: { onSaved: () => void | Promise<void> }) {
  const ov = useApi<any>('/integrations/field-service');
  const act = useAction(async () => { await ov.reload(); await onSaved(); });
  const [vendor, setVendor] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [bookAt, setBookAt] = useState<boolean | null>(null);
  const [cfg, setCfg] = useState<Record<string, any>>({});
  const [secretEnv, setSecretEnv] = useState<string | null>(null);
  const [test, setTest] = useState<any>(null);
  if (ov.error) return <Alert>{ov.error}</Alert>;
  if (!ov.data) return <Spinner />;
  const o = ov.data, vid = vendor ?? o.vendor ?? '', on = enabled ?? o.enabled, bookOn = bookAt ?? !!o.bookAtOrder;
  const vend = o.vendors.find((x: any) => x.id === vid);
  const conf = { ...(vend?.config ?? {}), ...cfg };
  const dirty = vendor !== null || enabled !== null || bookAt !== null || Object.keys(cfg).length > 0 || secretEnv !== null;
  return (
    <section aria-label="Field service connection">
      <h3 className="mb-1.5 text-footnote font-semibold uppercase tracking-wide text-label2">Field service connection</h3>
      <div className="rounded-control bg-surface2 p-3">
        <p className="mb-3 text-subhead text-label2">Connect your workforce-management system so agents can book technician visits from a case. The system reports progress to the callback address listed above, and the case follows it. When supervisors are told about a late visit, and automatic booking, are set in <Link href="/admin/settings?section=cases" className="text-accent">Settings → Cases</Link>.</p>
        <div className="grid max-w-xl gap-3">
          <Field label="System"><Select value={vid} onChange={(e) => { setVendor(e.target.value); setCfg({}); setTest(null); }}><option value="">None</option>{o.vendors.map((x: any) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
          {vend && <p className="text-footnote text-label2">{vend.summary}</p>}
          {vend?.fields.map((f: any) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.kind === 'select' ? <Select value={String(conf[f.key] ?? '')} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })}>{f.options.map((op: any) => <option key={op.value} value={op.value}>{op.label}</option>)}</Select>
                : <Input type={f.kind === 'number' ? 'number' : 'text'} value={String(conf[f.key] ?? '')} placeholder={f.placeholder} className={f.kind === 'env' ? 'font-mono' : ''} onChange={(e) => setCfg({ ...cfg, [f.key]: f.kind === 'number' ? Number(e.target.value) : e.target.value })} />}
            </Field>))}
          <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={on} onChange={(e) => setEnabled(e.target.checked)} /><span>Switched on</span></label>
          <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 accent-[rgb(var(--accent))]" checked={bookOn} onChange={(e) => setBookAt(e.target.checked)} /><span>Let the customer pick the installation time while the order is taken<span className="block text-footnote text-label2">The new-order screen asks the field-service system for free times at the installation address; the chosen time is held, and booked once the order is paid. It can be moved later from the installation case. Off: only a preferred date is noted.</span></span></label>
          <Field label="Callback secret (environment variable)" hint={`The system signs each call to the callback address above with this secret. ${o.webhookSecretSet && secretEnv === null ? `Set on the server. Signatures are checked with ${o.webhookSecretEnv}.` : `Not set on the server yet: add ${secretEnv ?? o.webhookSecretEnv} (16 characters or more), or callbacks are refused.`}`}>
            <Input value={secretEnv ?? o.webhookSecretEnv} onChange={(e) => setSecretEnv(e.target.value)} className="font-mono" /></Field>
          {o.problem && <Alert tone="info">{o.problem}</Alert>}
          {test && <Alert tone={test.ok ? 'success' : 'danger'}>{test.detail}</Alert>}
          {act.error && <Alert>{act.error}</Alert>}{act.ok && !dirty && <Alert tone="success">{act.ok}</Alert>}
          <div className="flex gap-2">
            <Button disabled={act.busy || !dirty} onClick={async () => { if (await act.run(() => post('/integrations/field-service', { vendor: vid || null, enabled: on && !!vid, bookAtOrder: bookOn, config: vid ? conf : undefined, ...(secretEnv !== null ? { webhookSecretEnv: secretEnv } : {}) }), 'Saved')) { setVendor(null); setEnabled(null); setBookAt(null); setCfg({}); setSecretEnv(null); } }}>Save</Button>
            <Button variant="secondary" disabled={act.busy || !o.vendor} onClick={async () => setTest(await act.run(() => post('/integrations/field-service/test')))}>Test the connection</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
