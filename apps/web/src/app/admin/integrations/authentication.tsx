'use client';
import { Alert, Badge, Button, Field, Input, Modal, Select, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';
import type { Hub } from './integration-hub';

/**
 * The connection forms of the "Sign-in and identity" systems. Each kind has the fields an administrator actually thinks in (issuer, client id, which group gets
 * which role) instead of raw JSON; the secret is write-only. Everything is saved through the Integration hub's endpoint API.
 */
type Kind = 'IDP_OIDC' | 'IDP_SAML' | 'LDAP' | 'OTP_GATEWAY';
interface Form {
  id?: string; kind: Kind; name: string; url: string; enabled: boolean; secret: string; clearSecret: boolean; hasSecret: boolean;
  c: Record<string, any>; mappings: Array<{ group: string; role: string }>;
}
const VENDORS = [['ENTRA', 'Microsoft Entra ID (Azure AD)'], ['OKTA', 'Okta'], ['PING', 'Ping Identity'], ['KEYCLOAK', 'Keycloak'], ['OTHER', 'Another OpenID Connect provider']];
const ISSUER_HINT: Record<string, string> = { ENTRA: 'https://login.microsoftonline.com/<tenant id>/v2.0', OKTA: 'https://<your-domain>.okta.com', PING: 'https://auth.pingone.com/<environment id>/as', KEYCLOAK: 'https://<host>/realms/<realm>', OTHER: 'https://…' };

const blank = (kind: Kind, origin: string): Form => ({
  kind, name: '', url: '', enabled: true, secret: '', clearSecret: false, hasSecret: false, mappings: [],
  c: kind === 'IDP_OIDC' ? { vendor: 'ENTRA', redirectUri: `${origin}/login/sso`, scopes: 'openid profile email', usernameClaim: 'email', nameClaim: 'name', groupsClaim: 'groups', provision: true }
    : kind === 'LDAP' ? { usernameAttr: 'sAMAccountName', nameAttr: 'displayName', mailAttr: 'mail', phoneAttr: 'mobile', groupAttr: 'memberOf', userFilter: '(&(objectClass=person)(!(objectClass=computer)))', syncEveryMinutes: 60, disableMissing: true }
    : kind === 'OTP_GATEWAY' ? { deliver: 'SMS', templateIds: {} } : {},
});
const fromEndpoint = (e: any): Form => {
  const { roleMappings, ...c } = e.config ?? {};
  return { id: e.id, kind: e.kind, name: e.name, url: e.url ?? '', enabled: e.enabled, secret: '', clearSecret: false, hasSecret: e.hasSecret, c, mappings: Object.entries((roleMappings ?? {}) as Record<string, string>).map(([group, role]) => ({ group, role })) };
};

const NOUN: Record<Kind, string> = { IDP_OIDC: 'single sign-on provider', IDP_SAML: 'SAML provider', LDAP: 'directory connection', OTP_GATEWAY: 'message gateway' };
const COPY: Record<Kind, { add: string; url: string; urlHint: string; secret: string; empty: string }> = {
  IDP_OIDC: { add: 'Add a provider', url: 'Issuer', urlHint: '', secret: 'Client secret', empty: 'No provider yet. Once one is added and switched on, a sign-in button appears on the sign-in page.' },
  IDP_SAML: { add: 'Add a SAML provider', url: 'Single sign-on address', urlHint: 'https://…', secret: 'Not used', empty: 'Nothing stored yet.' },
  LDAP: { add: 'Add a directory', url: 'Directory address', urlHint: 'ldaps://dc01.corp.example:636', secret: 'Service account password', empty: 'No directory yet.' },
  OTP_GATEWAY: { add: 'Add a gateway', url: 'Gateway address', urlHint: 'https://…/messages', secret: 'API token', empty: 'No gateway yet. Until one is added, sign-in codes wait in the notification outbox.' },
};

export function AuthConnections({ kind, h, reload }: { kind: Kind; h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const items = h.endpoints.filter((e) => e.kind === kind);
  const [f, setF] = useState<Form | null>(null);
  const roles = useApi<Array<{ id: string; label: string; code?: string; disabled?: boolean }>>(f ? '/roles' : null);
  const runs = useApi<{ items: any[] }>(kind === 'LDAP' ? '/settings/integration-hub/auth/directory/runs' : null);
  const copy = COPY[kind];
  const set = (k: string, v: unknown) => setF((x) => (x ? { ...x, c: { ...x.c, [k]: v } } : x));

  const save = async () => {
    if (!f) return;
    const roleMappings = Object.fromEntries(f.mappings.filter((m) => m.group.trim() && m.role).map((m) => [m.group.trim(), m.role]));
    const config: Record<string, unknown> = { ...f.c };
    if (kind !== 'OTP_GATEWAY' && kind !== 'IDP_SAML') config.roleMappings = roleMappings;
    if (kind === 'LDAP') config.syncEveryMinutes = Number(f.c.syncEveryMinutes || 0);
    const body = { group: 'auth', kind, name: f.name, url: f.url || null, config, enabled: f.enabled, secret: f.clearSecret ? '' : f.secret ? f.secret : undefined };
    if (await act.run(() => (f.id ? patch(`/settings/integration-hub/endpoints/${f.id}`, body) : post('/settings/integration-hub/endpoints', body)), 'Saved')) setF(null);
  };

  return (
    <section aria-label={copy.add}>
      <div className="mb-2 mt-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">Connections</h3>
        <Button variant="secondary" onClick={() => setF(blank(kind, origin))}>{copy.add}</Button>
      </div>
      <div className="rounded-control bg-surface2 p-3">
        {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        {kind === 'IDP_SAML' && <Alert tone="info">Meridian does not accept SAML sign-ins yet. What you enter here is kept and checked so it is ready; use OpenID Connect to sign in today.</Alert>}
        {items.length === 0 ? <p className="text-subhead text-label2">{copy.empty}</p> : (
          <ul className="divide-y divide-separator">
            {items.map((e) => (
              <li key={e.id} className={`flex flex-wrap items-center gap-3 py-2 ${e.enabled ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{e.name}</span>{!e.enabled && <Badge>Off</Badge>}{e.hasSecret && <Badge tone="success">Secret set</Badge>}{kind === 'OTP_GATEWAY' && <Badge>{e.config?.deliver === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}</Badge>}</div>
                  <p className="truncate text-footnote text-label2">{e.url ?? 'no address'}{kind === 'LDAP' && e.config?.syncEveryMinutes ? ` · syncs every ${e.config.syncEveryMinutes} min` : ''}</p>
                </div>
                {kind === 'LDAP' && <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(async () => { const r = await post(`/settings/integration-hub/auth/directory/${e.id}/sync`); await runs.reload(); return r; }, 'Directory synced')}>Sync now</Button>}
                <Button variant="secondary" onClick={() => setF(fromEndpoint(e))}>Edit</Button>
                <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Remove ${e.name}?`) && void act.run(() => del(`/settings/integration-hub/endpoints/${e.id}`), 'Removed')}>Remove</button>
              </li>))}
          </ul>)}
        {kind === 'LDAP' && runs.data && runs.data.items.length > 0 && (
          <div className="mt-3"><p className="mb-1 text-footnote font-semibold text-label2">Recent syncs</p>
            <ul className="space-y-1 text-footnote text-label2">{runs.data.items.slice(0, 5).map((r) => <li key={r.id}>{dt(r.startedAt)} · <b className={r.status === 'FAILED' ? 'text-danger' : 'text-label'}>{label(r.status)}</b>{r.status === 'OK' ? ` · ${r.created} new, ${r.updated} updated, ${r.disabled} switched off, ${r.skipped} skipped` : r.error ? ` · ${r.error}` : ''}</li>)}</ul></div>)}
      </div>

      {f && (
        <Modal title={`${f.id ? 'Edit' : 'New'} ${NOUN[kind]}`} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Name" hint={kind === 'IDP_OIDC' ? 'Shown on the sign-in button: “Sign in with …”' : undefined}><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            {kind === 'IDP_OIDC' && <Field label="Provider"><Select value={f.c.vendor} onChange={(e) => set('vendor', e.target.value)}>{VENDORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>}
            <Field label={copy.url} hint={kind === 'IDP_OIDC' ? ISSUER_HINT[f.c.vendor] : copy.urlHint}><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>

            {kind === 'IDP_OIDC' && <>
              <Field label="Client id"><Input value={f.c.clientId ?? ''} onChange={(e) => set('clientId', e.target.value)} autoComplete="off" /></Field>
              <Field label="Redirect address" hint="Register exactly this address with the provider."><Input value={f.c.redirectUri ?? ''} onChange={(e) => set('redirectUri', e.target.value)} /></Field>
              <Field label="Username from" hint="The claim that becomes the Meridian username."><Input value={f.c.usernameClaim ?? ''} onChange={(e) => set('usernameClaim', e.target.value)} /></Field>
              <Field label="Groups claim" hint="Entra ID needs the groups claim turned on in the app’s token configuration."><Input value={f.c.groupsClaim ?? ''} onChange={(e) => set('groupsClaim', e.target.value)} /></Field>
              <Check on={f.c.provision !== false} set={(v) => set('provision', v)}>Create accounts on first sign-in</Check>
              <Check on={f.c.syncRoles !== false} set={(v) => set('syncRoles', v)}>Update roles from groups at every sign-in</Check>
            </>}
            {kind === 'IDP_SAML' && <>
              <Field label="Entity id"><Input value={f.c.entityId ?? ''} onChange={(e) => set('entityId', e.target.value)} /></Field>
              <div className="sm:col-span-2"><Field label="Signing certificate" hint="PEM, starting with -----BEGIN CERTIFICATE-----. This is public, not a secret."><Textarea rows={5} value={f.c.certificate ?? ''} onChange={(e) => set('certificate', e.target.value)} className="font-mono text-footnote" /></Field></div>
            </>}
            {kind === 'LDAP' && <>
              <Field label="Service account (bind DN)"><Input value={f.c.bindDn ?? ''} onChange={(e) => set('bindDn', e.target.value)} placeholder="CN=svc-meridian,OU=Service,DC=corp,DC=example" /></Field>
              <Field label="Search base (base DN)"><Input value={f.c.baseDn ?? ''} onChange={(e) => set('baseDn', e.target.value)} placeholder="OU=Staff,DC=corp,DC=example" /></Field>
              <Field label="Who counts as a person" hint="An LDAP filter."><Input value={f.c.userFilter ?? ''} onChange={(e) => set('userFilter', e.target.value)} className="font-mono" /></Field>
              <Field label="Sync every (minutes)" hint="15 or more. 0 syncs only when you press Sync now."><Input type="number" min={0} max={10080} value={f.c.syncEveryMinutes ?? 0} onChange={(e) => set('syncEveryMinutes', e.target.value)} /></Field>
              <Field label="Username attribute"><Input value={f.c.usernameAttr ?? ''} onChange={(e) => set('usernameAttr', e.target.value)} /></Field>
              <Field label="Name attribute"><Input value={f.c.nameAttr ?? ''} onChange={(e) => set('nameAttr', e.target.value)} /></Field>
              <Field label="E-mail attribute"><Input value={f.c.mailAttr ?? ''} onChange={(e) => set('mailAttr', e.target.value)} /></Field>
              <Field label="Phone attribute"><Input value={f.c.phoneAttr ?? ''} onChange={(e) => set('phoneAttr', e.target.value)} /></Field>
              <Check on={f.c.disableMissing !== false} set={(v) => set('disableMissing', v)}>Switch off people who leave the directory</Check>
            </>}
            {kind === 'OTP_GATEWAY' && <>
              <Field label="Send codes by"><Select value={f.c.deliver} onChange={(e) => set('deliver', e.target.value)}><option value="SMS">SMS</option><option value="WHATSAPP">WhatsApp</option></Select></Field>
              <Field label="Sender id" hint="The name or number messages come from."><Input value={f.c.senderId ?? ''} onChange={(e) => set('senderId', e.target.value)} maxLength={40} /></Field>
              <Field label="Template id: sign-in code" hint="WhatsApp needs an approved template."><Input value={f.c.templateIds?.MFA ?? ''} onChange={(e) => set('templateIds', { ...f.c.templateIds, MFA: e.target.value })} /></Field>
              <Field label="Template id: password reset"><Input value={f.c.templateIds?.RESET ?? ''} onChange={(e) => set('templateIds', { ...f.c.templateIds, RESET: e.target.value })} /></Field>
            </>}

            {kind !== 'IDP_SAML' && <Field label={copy.secret} hint={f.hasSecret ? 'Set. Enter a new value to replace it.' : 'Encrypted and never shown again.'}><Input type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>}
            {f.hasSecret && kind !== 'IDP_SAML' ? <Check on={f.clearSecret} set={(clearSecret) => setF({ ...f, clearSecret })}>Remove the stored secret</Check> : <span />}
            <Check on={f.enabled} set={(enabled) => setF({ ...f, enabled })}>Connection is on</Check>

            {(kind === 'IDP_OIDC' || kind === 'LDAP') && (
              <div className="sm:col-span-2">
                <p className="mb-1 text-subhead font-medium">Which group gets which role</p>
                <p className="mb-2 text-footnote text-label2">{kind === 'LDAP' ? 'A group’s name or full distinguished name.' : 'The group names (or ids) the provider sends.'} {kind === 'LDAP' ? 'A person in no listed group gets no access: a new one is not created and an existing one is switched off.' : 'A new person in no listed group is refused; someone who already has an account keeps their current roles.'} The Administrator role cannot be given this way.</p>
                {f.mappings.map((m, i) => (
                  <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                    <Input aria-label="Group" value={m.group} placeholder="Group" onChange={(e) => setF({ ...f, mappings: f.mappings.map((x, j) => (j === i ? { ...x, group: e.target.value } : x)) })} />
                    <Select aria-label="Role" value={m.role} onChange={(e) => setF({ ...f, mappings: f.mappings.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })}>
                      <option value="">Choose a role…</option>
                      {(roles.data ?? []).filter((r) => r.id !== 'admin' && r.code).map((r) => <option key={r.id} value={r.code}>{r.label}</option>)}
                    </Select>
                    <button type="button" className="min-h-tap px-2 text-footnote text-danger" onClick={() => setF({ ...f, mappings: f.mappings.filter((_, j) => j !== i) })}>Remove</button>
                  </div>))}
                <Button variant="secondary" onClick={() => setF({ ...f, mappings: [...f.mappings, { group: '', role: '' }] })}>Add a mapping</Button>
              </div>)}
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
    </section>
  );
}
const Check = ({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: React.ReactNode }) => (
  <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> {children}</label>
);
