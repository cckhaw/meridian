'use client';
import { Alert, Badge, Button, Field, Input, Modal, Select } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction } from '@/lib/api';
import type { Hub } from './integration-hub';

/**
 * The connections of the identity checks: the ID check service (OCR, face match, liveness over REST) and MyDigital ID. Each has the fields an administrator
 * thinks in; the secret is write-only. Saved through the Integration hub's endpoint API (group “identity”).
 */
type Kind = 'KYC_OCR' | 'KYC_MYDIGITALID';
interface Form { id?: string; kind: Kind; name: string; url: string; enabled: boolean; secret: string; clearSecret: boolean; hasSecret: boolean; timeoutMs: number; c: Record<string, any> }

const MAP_FIELDS: Array<[string, string, string]> = [
  ['verdict', 'Verdict', 'verdict'], ['reasons', 'Reasons', 'reasons'], ['reference', 'Reference', 'id'], ['fullName', 'Name read from the ID', 'extracted.fullName'], ['dateOfBirth', 'Date of birth read', 'extracted.dateOfBirth'],
  ['idNumber', 'ID number read', 'extracted.idNumber'], ['idExpiry', 'Expiry read', 'extracted.expiry'], ['faceMatch', 'Face-match score', 'faceMatch.score'], ['liveness', 'Liveness result', 'liveness.result'],
];
const CLAIM_FIELDS: Array<[string, string, string]> = [['name', 'Name', 'name'], ['idNumber', 'ID number', 'id_number'], ['dateOfBirth', 'Date of birth', 'birthdate'], ['nationality', 'Nationality', 'nationality']];

const blank = (kind: Kind, origin: string): Form => ({
  kind, name: kind === 'KYC_OCR' ? 'ID check service' : 'MyDigital ID', url: '', enabled: true, secret: '', clearSecret: false, hasSecret: false, timeoutMs: kind === 'KYC_OCR' ? 20000 : 10000,
  c: kind === 'KYC_OCR' ? { mode: 'SIMULATOR', authKind: 'BEARER', autoApprove: true, autoReject: true, faceMatchMin: 0.8, faceFailBelow: 0.3, map: {} }
    : { scopes: 'openid profile', redirectUriCrm: `${origin}/api/kyc/mydigitalid/callback`, redirectUriStore: '', autoApprove: true, claims: {}, buttonLabel: 'MyDigital ID' },
});
const fromEndpoint = (e: any): Form => ({ id: e.id, kind: e.kind, name: e.name, url: e.url ?? '', enabled: e.enabled, secret: '', clearSecret: false, hasSecret: e.hasSecret, timeoutMs: e.timeoutMs, c: { map: {}, claims: {}, ...(e.config ?? {}) } });
const pct = (v: unknown, d: number) => String(Math.round(Number(v ?? d) * 100));
const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');

export function IdentityConnections({ kind, h, reload }: { kind: Kind; h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const test = useAction();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const items = h.endpoints.filter((e) => e.kind === kind);
  const [f, setF] = useState<Form | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(null);
  const set = (k: string, v: unknown) => setF((x) => (x ? { ...x, c: { ...x.c, [k]: v } } : x));
  const setIn = (group: 'map' | 'claims', k: string, v: string) => setF((x) => { if (!x) return x; const next = { ...(x.c[group] ?? {}) }; if (v.trim()) next[k] = v.trim(); else delete next[k]; return { ...x, c: { ...x.c, [group]: next } }; });
  const ocr = kind === 'KYC_OCR';

  const save = async () => {
    if (!f) return;
    const config: Record<string, unknown> = { ...f.c };
    for (const k of ['map', 'claims']) if (!Object.keys((config[k] as object) ?? {}).length) delete config[k];
    if (ocr) {
      for (const k of ['passValues', 'failValues']) { const raw = f.c[k]; if (typeof raw === 'string') { const l = raw.split(',').map((x: string) => x.trim()).filter(Boolean); if (l.length) config[k] = l; else delete config[k]; } }
      if (config.authKind !== 'HEADER') delete config.authHeader;
    }
    for (const k of Object.keys(config)) if (config[k] === '' || config[k] === undefined) delete config[k];
    const body = { group: 'identity', kind, name: f.name, url: f.url || null, timeoutMs: Number(f.timeoutMs) || undefined, config, enabled: f.enabled, secret: f.clearSecret ? '' : f.secret ? f.secret : undefined };
    if (await act.run(() => (f.id ? patch(`/settings/integration-hub/endpoints/${f.id}`, body) : post('/settings/integration-hub/endpoints', body)), 'Saved')) setF(null);
  };

  return (
    <section aria-label={ocr ? 'ID check service' : 'MyDigital ID'}>
      <div className="mb-2 mt-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">{ocr ? 'ID check service' : 'MyDigital ID connection'}</h3>
        {items.length === 0 && <Button variant="secondary" onClick={() => setF(blank(kind, origin))}>{ocr ? 'Connect a service' : 'Set up MyDigital ID'}</Button>}
      </div>
      <div className="rounded-control bg-surface2 p-3">
        {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        {tested && <Alert tone={tested.ok ? 'success' : 'danger'}>{tested.message}</Alert>}
        {items.length === 0 ? <p className="text-subhead text-label2">{ocr ? 'No service connected. Every case waits for a person, or for the rules alone in automatic mode.' : 'Not set up. Customers use the photographs.'}</p> : (
          <ul className="divide-y divide-separator">
            {items.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-center gap-3 py-2 ${e.enabled ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{e.name}</span>{!e.enabled && <Badge>Off</Badge>}{e.hasSecret && <Badge tone="success">Secret set</Badge>}
                    {ocr && <Badge tone={e.config?.mode === 'SIMULATOR' ? 'warning' : 'success'}>{e.config?.mode === 'SIMULATOR' ? 'Simulator' : 'REST'}</Badge>}
                    {ocr && <Badge>{e.config?.autoApprove === false ? 'A person approves' : 'Clean passes are approved'}</Badge>}</div>
                  <p className="truncate text-footnote text-label2">{e.url ?? (ocr ? 'built-in simulator' : 'no address')}</p>
                </div>
                {!ocr && <Button variant="secondary" disabled={test.busy} onClick={async () => { setTested(null); const r = await test.run(() => post('/kyc/mydigitalid/test')); if (r) setTested(r); }}>Test the connection</Button>}
                <Button variant="secondary" onClick={() => { setTested(null); setF(fromEndpoint(e)); }}>Edit</Button>
                <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Remove ${e.name}?`) && void act.run(() => del(`/settings/integration-hub/endpoints/${e.id}`), 'Removed')}>Remove</button>
              </li>))}
          </ul>)}
      </div>

      {f && (
        <Modal title={`${f.id ? 'Edit' : 'Set up'} ${ocr ? 'the ID check service' : 'MyDigital ID'}`} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Name"><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            {ocr ? <>
              <Field label="Mode" hint="The simulator answers by the ID number’s ending (9999 fails, 0000 goes to review, 5555 is an outage) so you can try the flow."><Select value={f.c.mode ?? 'REST'} onChange={(e) => set('mode', e.target.value)}><option value="SIMULATOR">Simulator (for trying it out)</option><option value="REST">A real service (REST)</option></Select></Field>
              {f.c.mode !== 'SIMULATOR' && <>
                <Field label="Service address" hint="Receives a POST with the photographs and the typed details."><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…/v1/check" /></Field>
                <Field label="Timeout (ms)" hint="After this the case goes to a person."><Input type="number" min={1000} max={120000} value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: Number(e.target.value) })} /></Field>
                <Field label="Authentication"><Select value={f.c.authKind ?? 'BEARER'} onChange={(e) => set('authKind', e.target.value)}><option value="BEARER">Bearer token</option><option value="HEADER">A header</option><option value="NONE">None</option></Select></Field>
                {f.c.authKind === 'HEADER' && <Field label="Header name"><Input value={f.c.authHeader ?? ''} onChange={(e) => set('authHeader', e.target.value)} placeholder="X-Api-Key" /></Field>}
                <Field label="Key" hint={f.hasSecret ? 'Set. Enter a new value to replace it.' : 'Encrypted and never shown again.'}><Input type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>
              </>}
              <Check on={f.c.autoApprove !== false} set={(v) => set('autoApprove', v)}>Approve a clean pass without a person</Check>
              <Check on={f.c.autoReject !== false} set={(v) => set('autoReject', v)}>Reject a fail without a person</Check>
              <Field label="Face match passes from (%)" hint="Below this a person looks. Ignored if the service has no face match."><Input type="number" min={0} max={100} value={pct(f.c.faceMatchMin, 0.8)} onChange={(e) => set('faceMatchMin', Number(e.target.value) / 100)} /></Field>
              <Field label="Face match fails below (%)" hint="Clearly someone else. Cannot be higher than the pass limit."><Input type="number" min={0} max={100} value={pct(f.c.faceFailBelow, 0.3)} onChange={(e) => set('faceFailBelow', Number(e.target.value) / 100)} /></Field>
              {f.c.mode !== 'SIMULATOR' && <>
                <div className="sm:col-span-2"><p className="mb-1 text-subhead font-medium">Where the answer keeps each value</p>
                  <p className="mb-2 text-footnote text-label2">A path into the JSON answer, such as <code>extracted.fullName</code>. Leave blank to use the default. A value the service does not return is simply not judged, so a service that only checks the document works.</p>
                  <div className="grid gap-2 sm:grid-cols-2">{MAP_FIELDS.map(([k, l, d]) => <Field key={k} label={l}><Input value={f.c.map?.[k] ?? ''} placeholder={d} onChange={(e) => setIn('map', k, e.target.value)} className="font-mono" /></Field>)}</div></div>
                <Field label="Words that mean pass" hint="Comma separated. Default: PASS, APPROVED, VERIFIED, OK…"><Input value={typeof f.c.passValues === 'string' ? f.c.passValues : list(f.c.passValues)} onChange={(e) => set('passValues', e.target.value)} /></Field>
                <Field label="Words that mean fail" hint="Comma separated. Anything else is sent to a person."><Input value={typeof f.c.failValues === 'string' ? f.c.failValues : list(f.c.failValues)} onChange={(e) => set('failValues', e.target.value)} /></Field>
              </>}
            </> : <>
              <Field label="Issuer" hint="MyDigital ID’s issuer address. Meridian finds the sign-in, token and key addresses from it."><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" /></Field>
              <Field label="Client id"><Input value={f.c.clientId ?? ''} autoComplete="off" onChange={(e) => set('clientId', e.target.value)} /></Field>
              <Field label="Client secret" hint={f.hasSecret ? 'Set. Enter a new value to replace it.' : 'Encrypted and never shown again.'}><Input type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>
              <Field label="Button text" hint="What the customer sees next to “Photograph the ID”."><Input value={f.c.buttonLabel ?? ''} maxLength={40} onChange={(e) => set('buttonLabel', e.target.value)} /></Field>
              <Field label="Redirect address: CRM" hint="Register exactly this address with MyDigital ID. Leave blank to switch the CRM off."><Input value={f.c.redirectUriCrm ?? ''} onChange={(e) => set('redirectUriCrm', e.target.value)} /></Field>
              <Field label="Redirect address: store-front" hint="Your shop’s address followed by /apply/mydigitalid. Leave blank to switch the shop off."><Input value={f.c.redirectUriStore ?? ''} onChange={(e) => set('redirectUriStore', e.target.value)} placeholder="https://shop.example.com/apply/mydigitalid" /></Field>
              <Field label="Scopes"><Input value={f.c.scopes ?? ''} onChange={(e) => set('scopes', e.target.value)} /></Field>
              <Field label="Timeout (ms)"><Input type="number" min={1000} max={120000} value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: Number(e.target.value) })} /></Field>
              <div className="sm:col-span-2"><p className="mb-1 text-subhead font-medium">Claim names</p>
                <p className="mb-2 text-footnote text-label2">What MyDigital ID calls each value in its answer. The ID number must be present; Meridian compares it with what was entered.</p>
                <div className="grid gap-2 sm:grid-cols-2">{CLAIM_FIELDS.map(([k, l, d]) => <Field key={k} label={l}><Input value={f.c.claims?.[k] ?? ''} placeholder={d} onChange={(e) => setIn('claims', k, e.target.value)} className="font-mono" /></Field>)}</div></div>
              <details className="sm:col-span-2"><summary className="cursor-pointer text-subhead text-accent">Enter the addresses by hand</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <Field label="Authorization"><Input value={f.c.authorizationEndpoint ?? ''} onChange={(e) => set('authorizationEndpoint', e.target.value)} /></Field>
                  <Field label="Token"><Input value={f.c.tokenEndpoint ?? ''} onChange={(e) => set('tokenEndpoint', e.target.value)} /></Field>
                  <Field label="Keys (JWKS)"><Input value={f.c.jwksUri ?? ''} onChange={(e) => set('jwksUri', e.target.value)} /></Field>
                </div></details>
              <Check on={f.c.autoApprove !== false} set={(v) => set('autoApprove', v)}>Confirmed identities are verified without a person</Check>
            </>}
            {f.hasSecret && !(ocr && f.c.mode === 'SIMULATOR') ? <Check on={f.clearSecret} set={(clearSecret) => setF({ ...f, clearSecret })}>Remove the stored secret</Check> : <span />}
            <Check on={f.enabled} set={(enabled) => setF({ ...f, enabled })}>Connection is on</Check>
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
    </section>
  );
}
const Check = ({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: React.ReactNode }) => (
  <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> {children}</label>
);
