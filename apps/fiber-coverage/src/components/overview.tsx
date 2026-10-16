'use client';
import { Alert, Badge, Button, Card, Field, Input, SectionTitle, Stat } from '@meridian/ui';
import { useEffect, useState } from 'react';
import { del, patch, post, put, useAction, useApi } from '@/lib/api';
import { dt, label } from '@/lib/format';
import { Check } from './shared';

export function Overview({ onModule }: { onModule?: () => void }) {
  const mod = useApi<{ enabled: boolean; envDefault: boolean }>('/admin/module');
  const settings = useApi<any>('/admin/settings');
  const providers = useApi<{ items: any[] }>('/admin/providers');
  const keys = useApi<{ items: any[] }>('/admin/api-keys');
  const res = useApi<{ items: any[] }>('/admin/reservations');
  const act = useAction(async () => { await Promise.all([mod.reload(), settings.reload(), providers.reload(), keys.reload(), res.reload()]); onModule?.(); });
  const [f, setF] = useState<any>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  useEffect(() => { if (settings.data && !f) setF(settings.data); }, [settings.data, f]);
  const on = mod.data?.enabled ?? false;
  const dirty = f && settings.data && JSON.stringify({ ...f, adapters: undefined }) !== JSON.stringify({ ...settings.data, adapters: undefined });
  const partners = (providers.data?.items ?? []).filter((p) => p.adapterKind !== 'NONE');

  return (
    <div className="grid gap-5 [&>*]:min-w-0">
      {(act.error || mod.error) && <Alert>{act.error || mod.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-title3 font-semibold">Fibre coverage module</h2>
            <p className="mt-1 text-subhead text-label2">
              {on ? 'On. The CRM and the store-front show the coverage check at address entry, hold a port while the customer checks out, and sell fixed-broadband plans.'
                : 'Off. The CRM and the store-front hide the coverage check and the fixed-broadband plans, skip installation scheduling, and nothing else changes. Switching it on again restores everything.'}
            </p>
            {mod.data && !mod.data.envDefault && !on && <p className="mt-1 text-footnote text-label3">Default from FEATURE_FIBER_COVERAGE_MODULE_ENABLED: off.</p>}
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Badge>
            <button type="button" role="switch" aria-checked={on} aria-label="Fibre coverage module" disabled={act.busy || !mod.data}
              onClick={() => { if (on && !confirm('Switch the module off? Customers will no longer see the coverage check or fixed-broadband plans.')) return; void act.run(() => put('/admin/module', { enabled: !on }), on ? 'Module switched off' : 'Module switched on'); }}
              className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition ${on ? 'bg-success' : 'bg-label3/40'} disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
              <span className={`inline-block h-6 w-6 rounded-full bg-white shadow transition ${on ? 'translate-x-7' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      </Card>

      <section aria-label="Partner adapters">
        <SectionTitle>Wholesale partner adapters</SectionTitle>
        <Card>
          {partners.length === 0 ? <p className="text-subhead text-label2">No partner has an API adapter. Add one under Providers; partners without one are served from their imported coverage files.</p> : (
            <ul className="divide-y divide-separator">
              {partners.map((p) => {
                const off = settings.data?.adapters?.[p.code] === false;
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                    <div className="min-w-0 flex-1"><p className="font-medium">{p.name} <span className="text-footnote text-label2">({p.code})</span></p><p className="text-footnote text-label2">{p.adapterKind} · {p.adapterUrl ?? 'no address'} · {p.adapterEnabled ? 'enabled on the provider' : 'switched off on the provider'}</p></div>
                    <Check on={!off} disabled={act.busy} set={(v) => void act.run(() => patch('/admin/settings', { adapters: { ...(settings.data?.adapters ?? {}), [p.code]: v } }), v ? `${p.code} adapter on` : `${p.code} adapter off`)}>Use this adapter</Check>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      <section aria-label="Behaviour">
        <SectionTitle>Behaviour</SectionTitle>
        <Card>
          {f && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Checkout port lock (minutes)" hint="How long a port is held while a customer checks out."><Input type="number" min={1} max={240} value={f.lockMinutes} onChange={(e) => setF({ ...f, lockMinutes: Number(e.target.value) })} /></Field>
              <Field label="Partner answer cache (hours)" hint="0 asks the partner every time."><Input type="number" min={0} max={168} value={f.cacheHours} onChange={(e) => setF({ ...f, cacheHours: Number(e.target.value) })} /></Field>
              <Field label="Partner timeout (ms)" hint="A slower partner is left out of the answer."><Input type="number" min={200} max={30000} step={100} value={f.partnerTimeoutMs} onChange={(e) => setF({ ...f, partnerTimeoutMs: Number(e.target.value) })} /></Field>
              <Field label="“Low” when this few ports are free"><Input type="number" min={0} max={64} value={f.lowPortsAbsolute} onChange={(e) => setF({ ...f, lowPortsAbsolute: Number(e.target.value) })} /></Field>
              <Field label="…or this share is free (%)"><Input type="number" min={0} max={100} value={f.lowPortsPercent} onChange={(e) => setF({ ...f, lowPortsPercent: Number(e.target.value) })} /></Field>
              <div className="flex items-end"><Button disabled={!dirty || act.busy} onClick={() => void act.run(() => patch('/admin/settings', { lockMinutes: f.lockMinutes, cacheHours: f.cacheHours, partnerTimeoutMs: f.partnerTimeoutMs, lowPortsAbsolute: f.lowPortsAbsolute, lowPortsPercent: f.lowPortsPercent }), 'Saved')}>Save</Button></div>
            </div>
          )}
          <div className="mt-4 border-t border-separator pt-3"><Button variant="secondary" disabled={act.busy} onClick={() => void act.run(() => post('/admin/sweep'), 'Expired locks freed and old cache entries removed')}>Free expired locks now</Button></div>
        </Card>
      </section>

      <section aria-label="Access keys">
        <SectionTitle>Access keys</SectionTitle>
        <Card>
          <p className="mb-3 text-subhead text-label2">The CRM, the store-front and partners call this service with a key. Each key can qualify addresses and hold ports; nothing else.</p>
          {newKey && <Alert tone="info">Key for {newKey.name}: <code className="break-all font-mono">{newKey.key}</code> Copy it now: it is not shown again.</Alert>}
          <ul className="divide-y divide-separator">
            {(keys.data?.items ?? []).map((k) => (
              <li key={k.id} className={`flex flex-wrap items-center gap-3 py-2 ${k.status === 'ACTIVE' ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1"><p className="font-medium">{k.name} <Badge tone={k.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(k.status)}</Badge></p><p className="text-footnote text-label2">mk_…{k.keyPrefix} · last used {dt(k.lastUsedAt)}</p></div>
                {k.status === 'ACTIVE' && <button type="button" className="text-footnote text-danger" onClick={() => confirm(`Revoke ${k.name}?`) && void act.run(() => del(`/admin/api-keys/${k.id}`), 'Revoked')}>Revoke</button>}
              </li>))}
          </ul>
          <div className="mt-3 flex flex-wrap items-end gap-2"><Field label="New key for"><Input value={keyName} maxLength={60} onChange={(e) => setKeyName(e.target.value)} placeholder="CRM, Store-front, Partner name" /></Field>
            <Button disabled={act.busy || !keyName.trim()} onClick={async () => { const r = await act.run(() => post('/admin/api-keys', { name: keyName.trim() })); if (r) { setNewKey({ name: keyName.trim(), key: r.key }); setKeyName(''); } }}>Create key</Button></div>
        </Card>
      </section>

      <section aria-label="Port locks">
        <SectionTitle>Recent port locks</SectionTitle>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['ACTIVE', 'CONFIRMED', 'ACTIVATED', 'RELEASED'] as const).map((s) => <Stat key={s} label={label(s)} value={(res.data?.items ?? []).filter((r) => r.state === s).length} />)}
        </div>
        {(res.data?.items ?? []).length === 0 ? <p className="text-subhead text-label2">No port has been locked yet.</p> : (
          <ul className="divide-y divide-separator rounded-card bg-surface px-4 shadow-card">
            {(res.data?.items ?? []).slice(0, 8).map((r) => <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-subhead"><Badge tone={r.state === 'ACTIVE' ? 'warning' : r.state === 'CONFIRMED' || r.state === 'ACTIVATED' ? 'success' : 'neutral'}>{label(r.state)}</Badge><span className="font-medium">{r.providerCode}{r.dpCode ? ` · ${r.dpCode} port ${r.portNo ?? '?'}` : ' · no port inventory'}</span><span className="text-label2">{r.customerRef ?? '—'}{r.orderRef ? ` · order ${r.orderRef}` : ''}</span><span className="ml-auto text-footnote text-label2">{r.state === 'ACTIVE' ? `until ${dt(r.expiresAt)}` : dt(r.createdAt)}</span></li>)}
          </ul>)}
      </section>
    </div>
  );
}
