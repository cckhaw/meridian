'use client';
import { Alert, Badge, Button, Card, Field, Input, Modal, SectionTitle, Segmented, Select, Spinner, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';

type Tab = 'gateway' | 'webhooks' | 'wfm' | 'network' | 'finance' | 'events';
const TABS: Array<{ value: Tab; label: string; blurb: string }> = [
  { value: 'gateway', label: 'API gateway', blurb: 'Who may call Meridian’s northbound APIs, with what rights, and how often.' },
  { value: 'webhooks', label: 'Webhooks', blurb: 'Where Meridian tells partners what happened, and the keys that prove incoming callbacks are genuine.' },
  { value: 'wfm', label: 'Field service', blurb: 'The dispatch system that books and tracks technician visits.' },
  { value: 'network', label: 'Core network', blurb: 'HLR/HSS, UDM, PCRF, the charging system and the eSIM server.' },
  { value: 'finance', label: 'Finance', blurb: 'The SAP ledger and the payment providers.' },
  { value: 'events', label: 'Events', blurb: 'Which business events go to which topics, and who has subscribed to notifications.' },
];

interface Hub {
  groups: Tab[]; endpointKinds: Record<string, Array<{ kind: string; label: string; hint: string }>>; endpoints: any[]; oauthClients: any[]; apiKeys: any[]; rateLimits: Array<{ channel: string; perMinute: number; enabled: boolean; isDefault: boolean }>;
  webhooks: any[]; topics: any[]; eventTypes: string[]; channels: string[]; scopes: Array<{ id: string; label: string }>;
}

/** Settings → Integrations: the credentials, endpoints and rules behind every outside connection, in six groups. Secrets are write-only: they are encrypted when saved and never shown again. */
export function IntegrationHubSettings() {
  const hub = useApi<Hub>('/settings/integration-hub');
  const [tab, setTab] = useState<Tab>('gateway');
  if (hub.error) return <Alert>{hub.error}</Alert>;
  if (!hub.data) return <Spinner />;
  const h = hub.data; const reload = hub.reload;
  const cur = TABS.find((t) => t.value === tab)!;
  return (
    <div className="space-y-5">
      <Segmented label="Group" value={tab} options={TABS.map((t) => ({ value: t.value, label: t.label }))} onChange={setTab} />
      <p className="text-subhead text-label2">{cur.blurb} Secrets you enter here are encrypted and are never shown again; to change one, enter a new value.</p>
      {tab === 'gateway' && <Gateway h={h} reload={reload} />}
      {tab === 'webhooks' && <Webhooks h={h} reload={reload} />}
      {(tab === 'wfm' || tab === 'network' || tab === 'finance') && <Endpoints key={tab} group={tab} h={h} reload={reload} />}
      {tab === 'events' && <Events h={h} reload={reload} />}
    </div>
  );
}

// ───────────────────────── shared bits ─────────────────────────
function ShownOnce({ title, items, onClose }: { title: string; items: Array<[string, string]>; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3">
        <Alert tone="info">Copy {items.length > 1 ? 'these' : 'this'} now. It is not stored in a form that can be shown again; if it is lost, rotate or reissue it.</Alert>
        {items.map(([k, v]) => <Field key={k} label={k}><Input readOnly value={v} className="font-mono" onFocus={(e) => e.currentTarget.select()} /></Field>)}
        <Button onClick={onClose}>I have copied it</Button>
      </div>
    </Modal>
  );
}
const Check = ({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) => (
  <label className="flex min-h-tap items-center gap-2 text-subhead"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}</label>
);

// ───────────────────────── 1. API gateway ─────────────────────────
function Gateway({ h, reload }: { h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const [oc, setOc] = useState<any | null>(null);
  const [key, setKey] = useState<any | null>(null);
  const [once, setOnce] = useState<{ title: string; items: Array<[string, string]> } | null>(null);
  const [rot, setRot] = useState<string | null>(null);
  const [grace, setGrace] = useState('60');
  const calls = useApi<any[]>('/settings/integration-hub/calls?limit=15');

  const saveOauth = async () => {
    const body = { name: oc.name, channel: oc.channel, scopes: oc.scopes, tokenTtlSeconds: Number(oc.ttl) };
    const r = await act.run(() => (oc.id ? patch(`/settings/integration-hub/oauth-clients/${oc.id}`, body) : post('/settings/integration-hub/oauth-clients', body)));
    if (r) { if (r.clientSecret) setOnce({ title: 'Client credentials', items: [['Client ID', r.client.clientId], ['Client secret', r.clientSecret]] }); setOc(null); }
  };
  const saveKey = async () => {
    const r = await act.run(() => post('/settings/api-clients', { name: key.name, scopes: key.scopes, channel: key.channel, expiresAt: key.expiresAt ? new Date(key.expiresAt).toISOString() : null, signRequests: key.sign }));
    if (r) { setOnce({ title: 'API key', items: [['API key', r.key], ...(r.hmacSecret ? [['Signing secret', r.hmacSecret] as [string, string]] : [])] }); setKey(null); }
  };
  const ScopePick = ({ v, set }: { v: string[]; set: (s: string[]) => void }) => (
    <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Scopes: what this credential may do</p>
      <div className="grid gap-1 sm:grid-cols-2">{h.scopes.map((s) => <Check key={s.id} checked={v.includes(s.id)} onChange={(on) => set(on ? [...v, s.id] : v.filter((x) => x !== s.id))}><span><code className="text-footnote">{s.id}</code> <span className="text-label2">{s.label}</span></span></Check>)}</div></div>
  );
  return (
    <div className="space-y-6">
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <section aria-label="OAuth clients">
        <SectionTitle action={<Button variant="secondary" onClick={() => setOc({ name: '', channel: 'SELF_CARE', scopes: [], ttl: '900' })}>＋ New OAuth client</Button>}>OAuth 2.0 / OIDC clients</SectionTitle>
        <Card>
          <p className="mb-3 text-subhead text-label2">For digital channels such as the self-care app and web portal. A client exchanges its ID and secret at <code>POST /api/v1/oauth/token</code> (grant <code>client_credentials</code>) for a short-lived bearer token carrying the scopes below.</p>
          {h.oauthClients.length === 0 ? <p className="text-subhead text-label2">No clients yet.</p> : (
            <ul className="divide-y divide-separator">{h.oauthClients.map((c) => (
              <li key={c.id} className={`flex flex-wrap items-center gap-3 py-2 ${c.status === 'ACTIVE' ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.name}</span><Badge>{label(c.channel)}</Badge>{c.status !== 'ACTIVE' && <Badge tone="danger">Revoked</Badge>}{c.previousSecretValidUntil && <Badge tone="warning">Old secret valid until {dt(c.previousSecretValidUntil)}</Badge>}</div>
                  <p className="text-footnote text-label2"><code>{c.clientId}</code> · token lives {Math.round(c.tokenTtlSeconds / 60)} min · {c.scopes.join(', ')}{c.lastUsedAt ? ` · last used ${dt(c.lastUsedAt)}` : ''}</p>
                </div>
                {c.status === 'ACTIVE' && <>
                  <Button variant="secondary" onClick={() => setOc({ id: c.id, name: c.name, channel: c.channel, scopes: c.scopes, ttl: String(c.tokenTtlSeconds) })}>Edit</Button>
                  <Button variant="secondary" onClick={() => setRot(c.id)}>Rotate secret</Button>
                  <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Revoke ${c.name}? Its tokens stop working at once.`) && void act.run(() => post(`/settings/integration-hub/oauth-clients/${c.id}/revoke`), 'Revoked')}>Revoke</button></>}
              </li>))}</ul>)}
        </Card>
      </section>

      <section aria-label="API keys">
        <SectionTitle action={<Button variant="secondary" onClick={() => setKey({ name: '', channel: 'PARTNER_PORTAL', scopes: [], expiresAt: '', sign: false })}>＋ New API key</Button>}>API keys and partner access</SectionTitle>
        <Card>
          <p className="mb-3 text-subhead text-label2">For dealer portals and third-party partners: <code>Authorization: Bearer mk_…</code>. A key can also require every request to be signed (<code>X-Meridian-Signature</code>, HMAC-SHA256 of the timestamp and body) and can expire.</p>
          {h.apiKeys.length === 0 ? <p className="text-subhead text-label2">No keys yet.</p> : (
            <ul className="divide-y divide-separator">{h.apiKeys.map((k) => (
              <li key={k.id} className={`flex flex-wrap items-center gap-3 py-2 ${k.status === 'ACTIVE' ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{k.name}</span><Badge>{label(k.channel)}</Badge>{k.signed && <Badge tone="success">Signed requests</Badge>}{k.status !== 'ACTIVE' && <Badge tone="danger">Revoked</Badge>}</div>
                  <p className="text-footnote text-label2"><code>mk_…_{k.keyPrefix}_…</code> · {k.scopes.join(', ')}{k.expiresAt ? ` · expires ${dt(k.expiresAt)}` : ''}{k.lastUsedAt ? ` · last used ${dt(k.lastUsedAt)}` : ''}</p>
                </div>
                {k.status === 'ACTIVE' && <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Revoke ${k.name}?`) && void act.run(() => del(`/settings/api-clients/${k.id}`), 'Revoked')}>Revoke</button>}
              </li>))}</ul>)}
        </Card>
      </section>

      <section aria-label="Rate limits">
        <SectionTitle>Throttling and rate limits</SectionTitle>
        <Card>
          <p className="mb-3 text-subhead text-label2">Requests a minute per credential, counted over a sliding window and set per channel. Over the limit a caller gets <code>429</code> with <code>Retry-After</code>.</p>
          <ul className="divide-y divide-separator">{h.rateLimits.map((r) => <RateRow key={r.channel} r={r} act={act} />)}</ul>
        </Card>
      </section>

      <section aria-label="Recent calls">
        <SectionTitle>Recent API calls</SectionTitle>
        <Card>
          {!calls.data ? <Spinner /> : calls.data.length === 0 ? <p className="text-subhead text-label2">No calls yet.</p> : (
            <ul className="divide-y divide-separator text-footnote">{calls.data.map((c) => <li key={c.id} className="flex flex-wrap gap-2 py-1.5"><span className="text-label2">{dt(c.at)}</span><Badge tone={c.status < 300 ? 'success' : c.status < 500 ? 'warning' : 'danger'}>{c.status}</Badge><span className="font-mono">{c.method} {c.path}</span><span className="text-label2">{c.clientRef} · {c.ms} ms</span></li>)}</ul>)}
        </Card>
      </section>

      {oc && (
        <Modal title={oc.id ? 'Edit OAuth client' : 'New OAuth client'} onClose={() => setOc(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Name"><Input value={oc.name} maxLength={80} onChange={(e) => setOc({ ...oc, name: e.target.value })} /></Field>
            <Field label="Channel" hint="Decides the rate limit."><Select value={oc.channel} onChange={(e) => setOc({ ...oc, channel: e.target.value })}>{h.channels.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
            <Field label="Token lifetime (seconds)" hint="60 to 86,400"><Input type="number" min={60} max={86400} value={oc.ttl} onChange={(e) => setOc({ ...oc, ttl: e.target.value })} /></Field>
            <ScopePick v={oc.scopes} set={(scopes) => setOc({ ...oc, scopes })} />
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !oc.name.trim() || !oc.scopes.length} onClick={() => void saveOauth()}>{oc.id ? 'Save' : 'Create client'}</Button><Button variant="secondary" onClick={() => setOc(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
      {key && (
        <Modal title="New API key" onClose={() => setKey(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Name"><Input value={key.name} maxLength={60} onChange={(e) => setKey({ ...key, name: e.target.value })} /></Field>
            <Field label="Channel"><Select value={key.channel} onChange={(e) => setKey({ ...key, channel: e.target.value })}>{h.channels.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select></Field>
            <Field label="Expires" hint="Leave empty for no expiry."><Input type="date" value={key.expiresAt} onChange={(e) => setKey({ ...key, expiresAt: e.target.value })} /></Field>
            <Check checked={key.sign} onChange={(sign) => setKey({ ...key, sign })}>Require every request to be signed</Check>
            <ScopePick v={key.scopes} set={(scopes) => setKey({ ...key, scopes })} />
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !key.name.trim() || !key.scopes.length} onClick={() => void saveKey()}>Create key</Button><Button variant="secondary" onClick={() => setKey(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
      {rot && (
        <Modal title="Rotate client secret" onClose={() => setRot(null)}>
          <div className="space-y-3">
            <p className="text-subhead text-label2">A new secret is issued. The current one keeps working for the time below so the client can switch over without an outage.</p>
            <Field label="Keep the old secret valid for (minutes)" hint="0 to 10,080"><Input type="number" min={0} max={10080} value={grace} onChange={(e) => setGrace(e.target.value)} /></Field>
            <div className="flex gap-2"><Button disabled={act.busy} onClick={async () => { const r = await act.run(() => post(`/settings/integration-hub/oauth-clients/${rot}/rotate`, { graceMinutes: Number(grace) })); if (r) { setOnce({ title: 'New client secret', items: [['Client ID', r.client.clientId], ['Client secret', r.clientSecret]] }); setRot(null); } }}>Rotate</Button><Button variant="secondary" onClick={() => setRot(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
      {once && <ShownOnce title={once.title} items={once.items} onClose={() => setOnce(null)} />}
    </div>
  );
}
function RateRow({ r, act }: { r: Hub['rateLimits'][number]; act: ReturnType<typeof useAction> }) {
  const [v, setV] = useState(String(r.perMinute));
  const [on, setOn] = useState(r.enabled);
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <span className="min-w-[10rem] flex-1 font-medium">{label(r.channel)} {r.isDefault && <span className="text-footnote font-normal text-label2">(default)</span>}</span>
      <Input aria-label={`${r.channel} requests a minute`} type="number" min={1} max={100000} value={v} onChange={(e) => setV(e.target.value)} className="w-28" /><span className="text-footnote text-label2">per minute</span>
      <Check checked={on} onChange={setOn}>On</Check>
      <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post('/settings/integration-hub/rate-limits', { channel: r.channel, perMinute: Number(v), enabled: on }), 'Saved')}>Save</Button>
      {!r.isDefault && <button type="button" className="text-footnote text-accent" onClick={() => void act.run(() => del(`/settings/integration-hub/rate-limits/${r.channel}`), 'Back to the default')}>Reset</button>}
    </li>
  );
}

// ───────────────────────── 2. webhooks ─────────────────────────
function Webhooks({ h, reload }: { h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const [f, setF] = useState<any | null>(null);
  const out = h.webhooks.filter((w) => w.kind === 'OUTBOUND'), inn = h.webhooks.filter((w) => w.kind === 'INBOUND');
  const save = async () => {
    const body = { kind: f.kind, name: f.name, targetUrl: f.targetUrl || null, authKind: f.authKind, secret: f.secret || undefined, provider: f.provider || null, events: f.events, retryMax: Number(f.retryMax), retryBackoffSeconds: Number(f.backoff), status: f.status };
    if (await act.run(() => (f.id ? patch(`/settings/integration-hub/webhooks/${f.id}`, body) : post('/settings/integration-hub/webhooks', body)), 'Saved')) setF(null);
  };
  const List = ({ items, empty }: { items: any[]; empty: string }) => items.length === 0 ? <p className="text-subhead text-label2">{empty}</p> : (
    <ul className="divide-y divide-separator">{items.map((w) => (
      <li key={w.id} className="flex flex-wrap items-center gap-3 py-2">
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{w.name}</span><Badge tone={w.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(w.status)}</Badge>{w.authKind !== 'NONE' && <Badge>{w.authKind}</Badge>}</div>
          <p className="truncate text-footnote text-label2">{w.kind === 'OUTBOUND' ? `${w.targetUrl} · ${w.events.length ? w.events.join(', ') : 'all events'} · ${w.retryMax} retries` : `${w.provider} · key ${w.hasSecret ? 'set' : 'not set'}`}</p></div>
        <Button variant="secondary" onClick={() => setF({ id: w.id, kind: w.kind, name: w.name, targetUrl: w.targetUrl ?? '', authKind: w.authKind, secret: '', provider: w.provider ?? '', events: w.events, retryMax: String(w.retryMax), backoff: String(w.retryBackoffSeconds), status: w.status })}>Edit</Button>
        <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Remove ${w.name}?`) && void act.run(() => del(`/settings/integration-hub/webhooks/${w.id}`), 'Removed')}>Remove</button>
      </li>))}</ul>);
  const blank = (kind: 'OUTBOUND' | 'INBOUND') => ({ kind, name: '', targetUrl: '', authKind: kind === 'INBOUND' ? 'HMAC' : 'HMAC', secret: '', provider: '', events: [], retryMax: '5', backoff: '30', status: 'ACTIVE' });
  return (
    <div className="space-y-6">
      {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <section aria-label="Outbound webhooks">
        <SectionTitle action={<Button variant="secondary" onClick={() => setF(blank('OUTBOUND'))}>＋ New outbound webhook</Button>}>Outbound webhooks</SectionTitle>
        <Card><p className="mb-3 text-subhead text-label2">Meridian posts events to these addresses, signed or with a bearer token, and retries a failed delivery with a growing wait.</p><List items={out} empty="None registered." /></Card>
      </section>
      <section aria-label="Inbound webhook keys">
        <SectionTitle action={<Button variant="secondary" onClick={() => setF(blank('INBOUND'))}>＋ New verification key</Button>}>Inbound webhook verification keys</SectionTitle>
        <Card><p className="mb-3 text-subhead text-label2">The HMAC keys that prove a callback from a payment gateway, courier or dealer channel is genuine.</p><List items={inn} empty="None registered." /></Card>
      </section>
      {f && (
        <Modal title={`${f.id ? 'Edit' : 'New'} ${f.kind === 'OUTBOUND' ? 'outbound webhook' : 'verification key'}`} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Name"><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            {f.kind === 'OUTBOUND'
              ? <Field label="Target address" hint="https://"><Input value={f.targetUrl} onChange={(e) => setF({ ...f, targetUrl: e.target.value })} /></Field>
              : <Field label="Sent by" hint="The outside system, e.g. DuitNow, PromptPay, a courier"><Input value={f.provider} maxLength={60} onChange={(e) => setF({ ...f, provider: e.target.value })} /></Field>}
            {f.kind === 'OUTBOUND' && <Field label="Authentication"><Select value={f.authKind} onChange={(e) => setF({ ...f, authKind: e.target.value })}><option value="HMAC">HMAC signature</option><option value="BEARER">Bearer token</option><option value="NONE">None</option></Select></Field>}
            {(f.kind === 'INBOUND' || f.authKind !== 'NONE') && <Field label={f.authKind === 'BEARER' ? 'Bearer token' : 'HMAC key'} hint={f.id ? 'Leave empty to keep the current one.' : 'At least 16 characters.'}><Input type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>}
            {f.kind === 'OUTBOUND' && <>
              <Field label="Retries" hint="0 to 20"><Input type="number" min={0} max={20} value={f.retryMax} onChange={(e) => setF({ ...f, retryMax: e.target.value })} /></Field>
              <Field label="First wait between retries (seconds)"><Input type="number" min={1} value={f.backoff} onChange={(e) => setF({ ...f, backoff: e.target.value })} /></Field>
              <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option></Select></Field>
              <div className="sm:col-span-2"><p className="mb-1 text-footnote font-medium text-label2">Events (none ticked = all)</p>
                <div className="grid gap-1 sm:grid-cols-3">{h.eventTypes.map((e) => <Check key={e} checked={f.events.includes(e)} onChange={(on) => setF({ ...f, events: on ? [...f.events, e] : f.events.filter((x: string) => x !== e) })}><code className="text-footnote">{e}</code></Check>)}</div></div></>}
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
    </div>
  );
}

// ───────────────────────── 3–5. endpoints (field service, network, finance) ─────────────────────────
const CONFIG_HINT: Record<string, string> = {
  WFM_GATEWAY: '{"vendor":"Salesforce Field Service","oauthTokenUrl":"https://…/token","scope":"api","poolSize":10}',
  SLOT_SYNC: '{"windows":["08:00-12:00","13:00-17:00"],"skills":["FIBER_SPLICING","ONT_INSTALL"],"emergencyPriority":"P1"}',
  HLR_HSS: '{"protocol":"Diameter","realm":"epc.example.net","poolSize":8}',
  UDM: '{"protocol":"HTTP/2","apiRoot":"/nudm-sdm/v2"}',
  PCRF: '{"protocol":"Diameter","realm":"pcrf.example.net"}',
  OCS: '{"protocol":"HTTP/2","apiRoot":"/ocs/v1"}',
  SMDP_PLUS: '{"smdpAddress":"smdp.example.net","matchingIdPrefix":"MER","profileType":"consumer"}',
  SAP_FICO: '{"transport":"SFTP","directory":"/inbound/gl","companyCode":"1000","format":"IDOC"}',
  PAYMENT_GATEWAY: '{"provider":"DuitNow","callbackUrl":"https://…/api/webhooks/gateway/duitnow","merchantId":"…"}',
};
function Endpoints({ group, h, reload }: { group: Tab; h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const kinds = h.endpointKinds[group] ?? [];
  const items = h.endpoints.filter((e) => e.group === group);
  const [f, setF] = useState<any | null>(null);
  const open = (e?: any) => setF(e ? { id: e.id, kind: e.kind, name: e.name, url: e.url ?? '', fallbackUrl: e.fallbackUrl ?? '', timeoutMs: String(e.timeoutMs), config: JSON.stringify(e.config ?? {}, null, 2), secret: '', clearSecret: false, enabled: e.enabled, hasSecret: e.hasSecret }
    : { kind: kinds[0]?.kind ?? '', name: '', url: '', fallbackUrl: '', timeoutMs: '10000', config: '{}', secret: '', clearSecret: false, enabled: true, hasSecret: false });
  const save = async () => {
    let config: unknown; try { config = JSON.parse(f.config || '{}'); } catch { act.clear(); alert('The settings must be valid JSON.'); return; }
    const body = { group, kind: f.kind, name: f.name, url: f.url || null, fallbackUrl: f.fallbackUrl || null, timeoutMs: Number(f.timeoutMs), config, enabled: f.enabled, secret: f.clearSecret ? '' : f.secret || undefined };
    if (await act.run(() => (f.id ? patch(`/settings/integration-hub/endpoints/${f.id}`, body) : post('/settings/integration-hub/endpoints', body)), 'Saved')) setF(null);
  };
  const info = (k: string) => kinds.find((x) => x.kind === k);
  return (
    <section aria-label="Endpoints">
      <SectionTitle action={<Button variant="secondary" onClick={() => open()}>＋ New connection</Button>}>Connections</SectionTitle>
      <Card>
        {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        <ul className="mb-3 space-y-1 text-footnote text-label2">{kinds.map((k) => <li key={k.kind}><b className="text-label">{k.label}</b>: {k.hint}</li>)}</ul>
        {items.length === 0 ? <p className="text-subhead text-label2">Nothing configured yet.</p> : (
          <ul className="divide-y divide-separator">{items.map((e) => (
            <li key={e.id} className={`flex flex-wrap items-center gap-3 py-2 ${e.enabled ? '' : 'opacity-60'}`}>
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{e.name}</span><Badge>{info(e.kind)?.label ?? e.kind}</Badge>{!e.enabled && <Badge>Off</Badge>}{e.hasSecret && <Badge tone="success">Credentials set</Badge>}</div>
                <p className="truncate text-footnote text-label2">{e.url ?? 'no address'}{e.fallbackUrl ? ` · fallback ${e.fallbackUrl}` : ''} · timeout {e.timeoutMs} ms</p></div>
              <Button variant="secondary" onClick={() => open(e)}>Edit</Button>
              <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Remove ${e.name}?`) && void act.run(() => del(`/settings/integration-hub/endpoints/${e.id}`), 'Removed')}>Remove</button>
            </li>))}</ul>)}
      </Card>
      {f && (
        <Modal title={f.id ? 'Edit connection' : 'New connection'} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</Select></Field>
            <Field label="Name"><Input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Primary address" hint="https://, sftp://, diameter://, rfc://"><Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
            <Field label="Fallback address"><Input value={f.fallbackUrl} onChange={(e) => setF({ ...f, fallbackUrl: e.target.value })} /></Field>
            <Field label="Timeout (milliseconds)"><Input type="number" min={100} max={120000} value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: e.target.value })} /></Field>
            <Check checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })}>Connection is on</Check>
            <Field label="Credentials" hint={f.hasSecret ? 'Set. Enter a new value to replace it.' : 'Password, client secret or certificate bundle. Encrypted; never shown again.'}><Textarea rows={3} value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} className="font-mono" autoComplete="off" /></Field>
            {f.hasSecret ? <Check checked={f.clearSecret} onChange={(clearSecret) => setF({ ...f, clearSecret })}>Remove the stored credentials</Check> : <span />}
            <div className="sm:col-span-2"><Field label="Settings (JSON)" hint={`For example ${CONFIG_HINT[f.kind] ?? '{}'}`}><Textarea rows={5} value={f.config} onChange={(e) => setF({ ...f, config: e.target.value })} className="font-mono text-footnote" spellCheck={false} /></Field></div>
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
    </section>
  );
}

// ───────────────────────── 6. events ─────────────────────────
function Events({ h, reload }: { h: Hub; reload: () => void | Promise<void> }) {
  const act = useAction(reload);
  const [ev, setEv] = useState(h.eventTypes[0] ?? '');
  const [topic, setTopic] = useState('');
  const tmf = h.webhooks.filter((w) => w.kind === 'TMF688');
  return (
    <div className="space-y-6">
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <section aria-label="Topics">
        <SectionTitle>Event streaming topics</SectionTitle>
        <Card>
          <p className="mb-3 text-subhead text-label2">Each business event can be published to one or more topics on the event bus (for example Kafka). An event with no mapping is not published.</p>
          {h.topics.length > 0 && <ul className="mb-3 divide-y divide-separator">{h.topics.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 py-2"><code className="text-footnote">{t.eventType}</code><span aria-hidden>→</span><code className="min-w-0 flex-1 truncate text-footnote">{t.topic}</code>
              <Check checked={t.enabled} onChange={(enabled) => void act.run(() => post('/settings/integration-hub/topics', { eventType: t.eventType, topic: t.topic, enabled }))}>On</Check>
              <button type="button" className="text-footnote text-danger" onClick={() => void act.run(() => del(`/settings/integration-hub/topics/${t.id}`), 'Removed')}>Remove</button></li>))}</ul>}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Event"><Select value={ev} onChange={(e) => setEv(e.target.value)}>{h.eventTypes.map((e) => <option key={e} value={e}>{e}</option>)}</Select></Field>
            <Field label="Topic"><Input value={topic} maxLength={120} onChange={(e) => setTopic(e.target.value)} placeholder="bss.subscriber.sim-swapped" /></Field>
            <Button disabled={act.busy || !topic.trim()} onClick={async () => { if (await act.run(() => post('/settings/integration-hub/topics', { eventType: ev, topic: topic.trim() }), 'Mapped')) setTopic(''); }}>Map</Button>
          </div>
        </Card>
      </section>
      <section aria-label="TM Forum subscriptions">
        <SectionTitle>TM Forum notification subscriptions (TMF 688)</SectionTitle>
        <Card>
          <p className="mb-3 text-subhead text-label2">External systems register themselves with <code>POST /api/tmf-api/eventManagement/v4/hub</code> (callback and filter) using a credential that holds the <code>event:subscribe</code> scope. They are listed here, and can be paused or removed.</p>
          {tmf.length === 0 ? <p className="text-subhead text-label2">No subscribers yet.</p> : (
            <ul className="divide-y divide-separator">{tmf.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><code className="truncate text-footnote">{w.targetUrl}</code><Badge tone={w.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(w.status)}</Badge></div><p className="text-footnote text-label2">{w.clientId} · {w.query ?? 'all events'}</p></div>
                <Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => patch(`/settings/integration-hub/webhooks/${w.id}`, { kind: 'TMF688', name: w.name, targetUrl: w.targetUrl, authKind: 'NONE', events: w.events, query: w.query, status: w.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }))}>{w.status === 'ACTIVE' ? 'Pause' : 'Resume'}</Button>
                <button type="button" className="text-footnote text-danger" onClick={() => void act.run(() => del(`/settings/integration-hub/webhooks/${w.id}`), 'Removed')}>Remove</button>
              </li>))}</ul>)}
        </Card>
      </section>
    </div>
  );
}
