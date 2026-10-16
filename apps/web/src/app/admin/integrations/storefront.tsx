'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState, type ReactNode } from 'react';
import { del, post, useAction, useApi } from '@/lib/api';
import { dt } from '@/lib/format';

/**
 * The three panels that used to be one "Store-front" form. Each integration owns its own settings and says where they apply: the store-front, the CRM
 * (staff selling), or both. They all read and write the same stored settings, one panel's save never touches another's fields.
 */
interface StoreSettings { kycMode: 'manual' | 'auto'; minAge: number; requireKycForServices: boolean; kycGate: 'BEFORE_ORDER' | 'BEFORE_ACTIVATION'; kycSlaHours: number; kycRequireLiveCapture: boolean; termsUrl: string; privacyUrl: string; termsVersion: string; applicationTtlHours: number; gateways: { enabled: string[]; default: string | null; crm: string[] } }
interface GatewayInfo { id: string; label: string; configured: boolean; paymentLink: boolean }

function useStore() {
  const { data, error, loading, reload } = useApi('/settings/store');
  return { data, error, loading, reload };
}
function Loading({ s, children }: { s: ReturnType<typeof useStore>; children: (d: any) => ReactNode }) {
  if (s.loading && !s.data) return <Spinner />;
  if (s.error || !s.data) return <Alert>{s.error ?? 'Could not load'}</Alert>;
  return <>{children(s.data)}</>;
}

/** Where a setting applies. */
function Where({ store, crm }: { store?: boolean; crm?: boolean }) {
  return <span className="inline-flex shrink-0 gap-1">{store && <Badge tone="neutral">Store-front</Badge>}{crm && <Badge tone="neutral">CRM</Badge>}</span>;
}
function Row({ title, hint, where, children }: { title: string; hint?: ReactNode; where: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-2 py-3">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="font-medium">{title}</div>{hint && <div className="text-footnote text-label2">{hint}</div>}</div>{where}</div>
      {children}
    </div>
  );
}
const checkbox = 'mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]';

function useSave(initial: StoreSettings, reload: () => void) {
  const [f, setF] = useState<StoreSettings>({ ...initial, gateways: { ...initial.gateways, crm: initial.gateways.crm ?? [] } });
  const act = useAction(reload);
  const set = <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => setF((s) => ({ ...s, [k]: v }));
  return { f, setF, set, act, save: (msg: string) => void act.run(() => post('/settings/store', f), msg) };
}
function SaveBar({ act, label, onSave }: { act: ReturnType<typeof useAction>; label: string; onSave: () => void }) {
  return (
    <div className="space-y-3 pt-3">
      {act.error && <Alert>{act.error}</Alert>}
      {act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Button type="button" onClick={onSave} disabled={act.busy}>{act.busy ? 'Saving…' : label}</Button>
    </div>
  );
}

// ───────────────────────── store-front: keys, terms, sign-up retention ─────────────────────────
export function StorefrontPanel() {
  const s = useStore();
  return <Loading s={s}>{(d) => <StorefrontForm initial={d.store} clients={d.clients} reload={s.reload} />}</Loading>;
}
function StorefrontForm({ initial, clients, reload }: { initial: StoreSettings; clients: any[]; reload: () => void }) {
  const { f, set, act, save } = useSave(initial, reload);
  return (
    <div className="space-y-5">
      <Keys clients={clients} onChange={reload} />
      <Card>
        <SectionTitle>Terms and sign-ups</SectionTitle>
        <p className="mb-3 text-footnote text-label2">Shown to online customers and recorded with their consent. Identity verification and payment have their own panels below.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Terms and conditions link"><Input type="url" placeholder="https://…" value={f.termsUrl} onChange={(e) => set('termsUrl', e.target.value)} /></Field>
          <Field label="Privacy notice link"><Input type="url" placeholder="https://…" value={f.privacyUrl} onChange={(e) => set('privacyUrl', e.target.value)} /></Field>
          <Field label="Terms version" hint="Recorded with each customer’s acceptance. Change it when the terms change."><Input value={f.termsVersion} onChange={(e) => set('termsVersion', e.target.value)} maxLength={20} /></Field>
          <Field label="Keep unfinished sign-ups for (hours)"><Input type="number" min={1} max={720} value={f.applicationTtlHours} onChange={(e) => set('applicationTtlHours', Number(e.target.value))} /></Field>
        </div>
        <SaveBar act={act} label="Save" onSave={() => save('Store-front settings saved.')} />
      </Card>
    </div>
  );
}

// ───────────────────────── identity verification (KYC): store-front and CRM ─────────────────────────
export function KycPanel() {
  const s = useStore();
  return <Loading s={s}>{(d) => <KycForm initial={d.store} reload={s.reload} />}</Loading>;
}
function KycForm({ initial, reload }: { initial: StoreSettings; reload: () => void }) {
  const { f, set, act, save } = useSave(initial, reload);
  return (
    <Card>
      <SectionTitle>Identity verification (KYC)</SectionTitle>
      <p className="text-footnote text-label2">One set of rules for both ways of selling. The badge on each line says where it applies.</p>
      <div className="divide-y divide-separator">
        <Row title="Online sign-ups are approved by" where={<Where store />}
          hint="Manual: a compliance officer reviews every application. Automatic: applications that pass every rule are approved without review (only with an eKYC provider behind it).">
          <Select aria-label="Online sign-ups are approved by" value={f.kycMode} onChange={(e) => set('kycMode', e.target.value as StoreSettings['kycMode'])}><option value="manual">A compliance officer (recommended)</option><option value="auto">Automatic rules only</option></Select>
        </Row>
        <Row title="Photographs" where={<Where store crm />}
          hint="Every new customer, online or in the CRM, must photograph their ID (and a selfie). The photos are taken live with the device camera; choosing a picture from the gallery is not possible. They are kept encrypted in the document store, and a review task opens in KYC reviews.">
          <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className={checkbox} checked={f.kycRequireLiveCapture} onChange={(e) => set('kycRequireLiveCapture', e.target.checked)} /><span><span className="block">Only live camera photos are accepted</span><span className="text-footnote text-label2">The server also refuses files that look like gallery photos (they carry photo-library details), stale pictures and ones too small to read. Switch off only for a partner that sends scans through the API.</span></span></label>
        </Row>
        <Row title="Minimum age" where={<Where store crm />} hint="Applicants under this age are refused, online and in the CRM.">
          <div className="w-32"><Input type="number" aria-label="Minimum age" min={0} max={100} value={f.minAge} onChange={(e) => set('minAge', Number(e.target.value))} /></div>
        </Row>
        <Row title="When identity must be settled" where={<Where store crm />}
          hint="Before the service is switched on (recommended): the customer is not kept waiting for a person. The order is taken and paid, the service stays off, and it is activated when the review approves. If the review does not approve, the order is cancelled and refunded. Before the order: nothing is sold until the review approves.">
          <Select aria-label="When identity must be settled" value={f.kycGate} onChange={(e) => set('kycGate', e.target.value as StoreSettings['kycGate'])}><option value="BEFORE_ACTIVATION">Before the service is switched on (recommended)</option><option value="BEFORE_ORDER">Before the order is taken</option></Select>
        </Row>
        <Row title="Review target" where={<Where store crm />} hint="A review task waiting longer than this is shown as overdue in KYC reviews.">
          <div className="flex items-center gap-2"><div className="w-28"><Input type="number" aria-label="Review target in hours" min={1} max={336} value={f.kycSlaHours} onChange={(e) => set('kycSlaHours', Number(e.target.value))} /></div><span className="text-subhead text-label2">hours</span></div>
        </Row>
      </div>
      <SaveBar act={act} label="Save identity rules" onSave={() => save('Identity verification settings saved.')} />
    </Card>
  );
}

// ───────────────────────── payment gateways: store-front and CRM ─────────────────────────
export function PaymentsPanel({ webhookPath }: { webhookPath?: string }) {
  const s = useStore();
  return <Loading s={s}>{(d) => <PaymentsForm initial={d.store} gateways={d.gateways} webhookPath={webhookPath ?? d.webhookPath} reload={s.reload} />}</Loading>;
}
function PaymentsForm({ initial, gateways, webhookPath, reload }: { initial: StoreSettings; gateways: GatewayInfo[]; webhookPath: string; reload: () => void }) {
  const { f, setF, act, save } = useSave(initial, reload);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const store = new Set(f.gateways.enabled), crm = new Set(f.gateways.crm);
  const shown = gateways.filter((g) => g.configured || g.id === 'stripe');
  const toggleStore = (id: string, on: boolean) => {
    const list = on ? [...store, id] : [...store].filter((x) => x !== id);
    setF({ ...f, gateways: { ...f.gateways, enabled: list, default: list.includes(f.gateways.default ?? '') ? f.gateways.default : list[0] ?? null } });
  };
  const toggleCrm = (id: string, on: boolean) => setF({ ...f, gateways: { ...f.gateways, crm: on ? [...crm, id] : [...crm].filter((x) => x !== id) } });
  return (
    <Card>
      <SectionTitle>Where each gateway is used</SectionTitle>
      <p className="text-footnote text-label2">A gateway is offered only where it is switched on here <em>and</em> its keys are set on the server. Orders are always confirmed by the provider’s signed webhook.</p>
      <ul className="divide-y divide-separator">
        {shown.map((g) => (
          <li key={g.id} className="space-y-1 py-3">
            <div className="flex flex-wrap items-center gap-3"><span className="font-medium">{g.label}</span><Badge tone={g.configured ? 'success' : 'warning'}>{g.configured ? 'Keys configured' : 'Keys not set'}</Badge></div>
            <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className={checkbox} checked={store.has(g.id)} onChange={(e) => toggleStore(g.id, e.target.checked)} /><span><span className="block">Store-front</span><span className="text-footnote text-label2">Customers pay by card online at checkout.</span></span></label>
            {store.has(g.id) && <label className="ml-8 flex min-h-[32px] items-center gap-2 text-subhead"><input type="radio" name="default-gw" checked={f.gateways.default === g.id} onChange={() => setF({ ...f, gateways: { ...f.gateways, default: g.id } })} />First choice in the store-front</label>}
            <label className={`flex min-h-tap items-start gap-3 ${g.paymentLink ? '' : 'opacity-60'}`}><input type="checkbox" className={checkbox} disabled={!g.paymentLink} checked={crm.has(g.id)} onChange={(e) => toggleCrm(g.id, e.target.checked)} /><span><span className="block">CRM</span><span className="text-footnote text-label2">{g.paymentLink ? 'Staff send the customer a card payment link from the order (the customer pays on their own phone). Card details are never entered into the CRM.' : 'Not available: this gateway has no payment link, so staff record its payments by hand.'}</span></span></label>
          </li>
        ))}
      </ul>
      <details className="mt-3 rounded-control bg-surface2 p-3 text-subhead">
        <summary className="cursor-pointer font-medium">Set up Stripe</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-label2">
          <li>In the server environment set <code>MERIDIAN_STRIPE_SECRET_KEY</code> (sk_…), <code>MERIDIAN_STRIPE_PUBLISHABLE_KEY</code> (pk_…) and <code>MERIDIAN_STRIPE_WEBHOOK_SECRET</code> (whsec_…).</li>
          <li>In Stripe → Developers → Webhooks add the endpoint <code className="break-all">{origin}{webhookPath}</code> and subscribe to <code>payment_intent.succeeded</code>, <code>payment_intent.payment_failed</code> and <code>checkout.session.completed</code>.</li>
          <li>Redeploy, switch Stripe on above for the store-front, the CRM or both, and save.</li>
        </ol>
        <p className="mt-2 text-label2">Another provider can be added later: it implements the same small gateway interface and appears in this list.</p>
      </details>
      <SaveBar act={act} label="Save payment settings" onSave={() => save('Payment settings saved.')} />
    </Card>
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
