'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, post, useAction, useApi } from '@/lib/api';
import { dt } from '@/lib/format';

interface StoreSettings { kycMode: 'manual' | 'auto'; minAge: number; requireKycForServices: boolean; termsUrl: string; privacyUrl: string; termsVersion: string; applicationTtlHours: number; gateways: { enabled: string[]; default: string | null } }

export function StorefrontSettings() {
  const { data, error, loading, reload } = useApi('/settings/store');
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert>{error ?? 'Could not load'}</Alert>;
  return (
    <div className="space-y-5">
      <Rules initial={data.store} gateways={data.gateways} webhookPath={data.webhookPath} onSaved={reload} />
      <Keys clients={data.clients} onChange={reload} />
    </div>
  );
}

function Rules({ initial, gateways, webhookPath, onSaved }: { initial: StoreSettings; gateways: Array<{ id: string; label: string; configured: boolean }>; webhookPath: string; onSaved: () => void }) {
  const [f, setF] = useState<StoreSettings>(initial);
  const act = useAction(onSaved);
  const set = <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => setF((s) => ({ ...s, [k]: v }));
  const enabled = new Set(f.gateways.enabled);
  const toggleGw = (id: string, on: boolean) => {
    const list = on ? [...enabled, id] : [...enabled].filter((x) => x !== id);
    setF({ ...f, gateways: { enabled: list, default: list.includes(f.gateways.default ?? '') ? f.gateways.default : list[0] ?? null } });
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void act.run(() => post('/settings/store', f), 'Store-front settings saved.'); }}>
      <Card>
        <SectionTitle>Identity verification (KYC)</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Online sign-ups are approved by" hint="Manual: every application is reviewed by a compliance officer. Automatic: ones passing all rules are approved without review (use with an eKYC provider).">
            <Select value={f.kycMode} onChange={(e) => set('kycMode', e.target.value as StoreSettings['kycMode'])}><option value="manual">A compliance officer (recommended)</option><option value="auto">Automatic rules only</option></Select>
          </Field>
          <Field label="Minimum age"><Input type="number" min={0} max={100} value={f.minAge} onChange={(e) => set('minAge', Number(e.target.value))} /></Field>
          <label className="flex min-h-tap items-start gap-3 sm:col-span-2"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.requireKycForServices} onChange={(e) => set('requireKycForServices', e.target.checked)} />
            <span><span className="block font-medium">Require verified identity before selling any service</span><span className="text-footnote text-label2">Applies to every channel, including staff creating orders in the CRM. Turn on once your existing customers are verified, or they cannot be sold new services.</span></span></label>
        </div>
      </Card>

      <Card>
        <SectionTitle>Terms and privacy</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Terms and conditions link"><Input type="url" placeholder="https://…" value={f.termsUrl} onChange={(e) => set('termsUrl', e.target.value)} /></Field>
          <Field label="Privacy notice link"><Input type="url" placeholder="https://…" value={f.privacyUrl} onChange={(e) => set('privacyUrl', e.target.value)} /></Field>
          <Field label="Terms version" hint="Recorded with each customer’s acceptance. Change it when the terms change."><Input value={f.termsVersion} onChange={(e) => set('termsVersion', e.target.value)} maxLength={20} /></Field>
          <Field label="Keep unfinished sign-ups for (hours)"><Input type="number" min={1} max={720} value={f.applicationTtlHours} onChange={(e) => set('applicationTtlHours', Number(e.target.value))} /></Field>
        </div>
      </Card>

      <Card>
        <SectionTitle>Payment gateways</SectionTitle>
        <p className="mb-3 text-subhead text-label2">Online payments in the store-front. A gateway is offered only when it is switched on here <em>and</em> its keys are set on the server.</p>
        <ul className="divide-y divide-separator">
          {gateways.map((g) => (
            <li key={g.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-3">
              <label className="flex min-h-tap items-center gap-3 sm:flex-1"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={enabled.has(g.id)} onChange={(e) => toggleGw(g.id, e.target.checked)} /><span className="font-medium">{g.label}</span></label>
              <div className="flex flex-wrap items-center gap-3 pl-8 sm:pl-0">
              <Badge tone={g.configured ? 'success' : 'warning'}>{g.configured ? 'Keys configured' : 'Keys not set'}</Badge>
              <label className="flex min-h-[32px] items-center gap-2 text-subhead"><input type="radio" name="default-gw" disabled={!enabled.has(g.id)} checked={f.gateways.default === g.id} onChange={() => setF({ ...f, gateways: { ...f.gateways, default: g.id } })} />Default</label>
              </div>
            </li>
          ))}
        </ul>
        <details className="mt-3 rounded-control bg-surface2 p-3 text-subhead">
          <summary className="cursor-pointer font-medium">Set up Stripe</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-label2">
            <li>In the server environment set <code>MERIDIAN_STRIPE_SECRET_KEY</code> (sk_…), <code>MERIDIAN_STRIPE_PUBLISHABLE_KEY</code> (pk_…) and <code>MERIDIAN_STRIPE_WEBHOOK_SECRET</code> (whsec_…).</li>
            <li>In Stripe → Developers → Webhooks add the endpoint <code className="break-all">{origin}{webhookPath}</code> and subscribe to <code>payment_intent.succeeded</code> and <code>payment_intent.payment_failed</code>.</li>
            <li>Redeploy, switch Stripe on above and save. Orders are confirmed only by Stripe’s signed webhook.</li>
          </ol>
          <p className="mt-2 text-label2">Another provider can be added later: it implements the same small gateway interface and appears in this list.</p>
        </details>
      </Card>
      {act.error && <Alert>{act.error}</Alert>}
      {act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Button type="submit" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save store-front settings'}</Button>
    </form>
  );
}

function Keys({ clients, onChange }: { clients: any[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const act = useAction(onChange);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Card>
      <SectionTitle>Store-front API keys</SectionTitle>
      <p className="mb-3 text-subhead text-label2">Each externally hosted store-front gets its own key. Keys belong on the store-front’s <strong>server</strong> only; anyone holding one can create sign-ups through your CRM.</p>
      {fresh && (
        <div className="mb-4 space-y-2 rounded-control border border-warning bg-warning/10 p-3" role="status">
          <p className="font-medium">Copy the key for “{fresh.name}” now. It will not be shown again.</p>
          <code className="block break-all rounded bg-surface p-2 text-subhead">{fresh.key}</code>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(fresh.key); setCopied(true); } catch { /* user can select manually */ } }}>{copied ? 'Copied' : 'Copy key'}</Button>
            <Button variant="plain" onClick={() => { setFresh(null); setCopied(false); }}>I’ve saved it</Button>
          </div>
          <p className="text-footnote text-label2">Store-front environment: <code>MERIDIAN_API_URL={origin}/api</code> and <code>MERIDIAN_API_KEY=…</code></p>
        </div>
      )}
      <form className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={async (e) => { e.preventDefault(); const r = await act.run(() => post('/settings/api-clients', { name })); if (r) { setFresh({ name, key: r.key }); setName(''); } }}>
        <div className="sm:w-72"><Field label="Name"><Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Web shop (production)" maxLength={60} /></Field></div>
        <Button type="submit" disabled={act.busy || !name.trim()}>Create key</Button>
      </form>
      {act.error && <div className="mb-3"><Alert>{act.error}</Alert></div>}
      {clients.length === 0 ? <p className="text-subhead text-label2">No keys yet.</p> : (
        <ul className="divide-y divide-separator">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="flex-1"><span className="block font-medium">{c.name}</span><span className="text-footnote text-label2"><code>mk_…_{c.keyPrefix}_…</code> · created {dt(c.createdAt)} by {c.createdBy} · {c.lastUsedAt ? `last used ${dt(c.lastUsedAt)}` : 'never used'}</span></span>
              <Badge tone={c.status === 'ACTIVE' ? 'success' : 'danger'}>{c.status === 'ACTIVE' ? 'Active' : 'Revoked'}</Badge>
              {c.status === 'ACTIVE' && <Button variant="secondary" onClick={() => { if (confirm(`Revoke “${c.name}”? The store-front using it stops working immediately.`)) void act.run(() => del(`/settings/api-clients/${c.id}`)); }}>Revoke</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
