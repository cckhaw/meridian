'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, TableWrap, Td, Textarea, Th } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';
import { label, money, parseTiers, tiers } from '@/lib/format';
import { Check } from './shared';

const blank = () => ({ code: '', name: '', type: 'WHOLESALE_PARTNER', agreementId: '', costPerPortMinor: '0', currency: 'SGD', installLeadDays: '7', slaResponseHours: '48', tiers: '100, 500, 1000', adapterKind: 'NONE', adapterUrl: '', adapterConfig: '{}', adapterEnabled: false, enabled: true, secret: '', clearSecret: false, hasSecret: false });
const CONFIG_HINT = '{"method":"POST","body":{"lat":"{{lat}}","lng":"{{lng}}"},"paths":{"serviceable":"data.covered","portStatus":"data.ports","speedsMbps":"data.speeds","leadDays":"data.lead"},"exhaustedValues":["FULL"]}';

export function Providers() {
  const list = useApi<{ items: any[] }>('/admin/providers');
  const act = useAction(list.reload);
  const [f, setF] = useState<(ReturnType<typeof blank> & { id?: string }) | null>(null);
  const [test, setTest] = useState<{ p: any; lat: string; lng: string; out?: any } | null>(null);
  const edit = (p: any) => setF({ id: p.id, code: p.code, name: p.name, type: p.type, agreementId: p.agreementId ?? '', costPerPortMinor: String(p.costPerPortMinor), currency: p.currency, installLeadDays: String(p.installLeadDays), slaResponseHours: String(p.slaResponseHours), tiers: (p.speedTiersMbps ?? []).join(', '), adapterKind: p.adapterKind, adapterUrl: p.adapterUrl ?? '', adapterConfig: JSON.stringify(p.adapterConfig ?? {}, null, 2), adapterEnabled: p.adapterEnabled, enabled: p.enabled, secret: '', clearSecret: false, hasSecret: p.hasAdapterSecret });
  const save = async () => {
    if (!f) return;
    let adapterConfig: unknown; try { adapterConfig = JSON.parse(f.adapterConfig || '{}'); } catch { act.clear(); alert('The adapter settings must be valid JSON.'); return; }
    const body = { code: f.code.trim().toUpperCase(), name: f.name, type: f.type, agreementId: f.agreementId || null, costPerPortMinor: Math.round(Number(f.costPerPortMinor || 0)), currency: f.currency, installLeadDays: Number(f.installLeadDays), slaResponseHours: Number(f.slaResponseHours), speedTiersMbps: parseTiers(f.tiers), adapterKind: f.adapterKind, adapterUrl: f.adapterUrl || null, adapterConfig, adapterEnabled: f.adapterEnabled, enabled: f.enabled, adapterSecret: f.clearSecret ? '' : f.secret || undefined };
    if (await act.run(() => (f.id ? patch(`/admin/providers/${f.id}`, body) : post('/admin/providers', body)), 'Saved')) setF(null);
  };
  return (
    <div className="grid gap-4 [&>*]:min-w-0">
      {(act.error && !f) && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}{list.error && <Alert>{list.error}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-subhead text-label2">The networks customers can be connected on: your own, and wholesale partners. Commercial terms are for staff only and never leave this service.</p><Button onClick={() => setF(blank())}>Add provider</Button></div>
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.items.length === 0 && <Empty>No provider yet. Add your own network first, then each wholesale partner.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <TableWrap>
          <thead><tr><Th>Provider</Th><Th>Type</Th><Th>Agreement</Th><Th right>Cost / port</Th><Th right>Lead</Th><Th right>SLA</Th><Th>Speeds</Th><Th>Adapter</Th><Th /></tr></thead>
          <tbody>{list.data.items.map((p) => (
            <tr key={p.id} className={p.enabled ? '' : 'opacity-60'}>
              <Td><span className="font-medium">{p.name}</span><span className="block text-footnote text-label2">{p.code}</span></Td>
              <Td>{p.type === 'OWNED_INFRASTRUCTURE' ? <Badge tone="success">Owned</Badge> : <Badge>Wholesale</Badge>}</Td>
              <Td className="text-label2">{p.agreementId ?? '—'}</Td><Td right>{p.type === 'OWNED_INFRASTRUCTURE' ? '—' : money(p.costPerPortMinor, p.currency)}</Td><Td right>{p.installLeadDays} d</Td><Td right>{p.slaResponseHours} h</Td><Td className="text-label2">{tiers(p.speedTiersMbps)}</Td>
              <Td>{p.adapterKind === 'NONE' ? <span className="text-label2">Coverage files</span> : <Badge tone={p.adapterEnabled ? 'success' : 'neutral'}>{p.adapterKind}{p.adapterEnabled ? '' : ' (off)'}</Badge>}</Td>
              <Td><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => edit(p)}>Edit</Button>{p.adapterKind !== 'NONE' && <Button variant="secondary" onClick={() => setTest({ p, lat: '1.3048', lng: '103.8318' })}>Test</Button>}</div></Td>
            </tr>))}</tbody>
        </TableWrap>)}

      {f && (
        <Modal title={`${f.id ? 'Edit' : 'New'} provider`} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Code" hint="Capitals, digits, underscore. For example TIME_DOTCOM."><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="OWNED_INFRASTRUCTURE">Owned infrastructure</option><option value="WHOLESALE_PARTNER">Wholesale partner</option></Select></Field>
            <Field label="Wholesale agreement id"><Input value={f.agreementId} onChange={(e) => setF({ ...f, agreementId: e.target.value })} /></Field>
            <Field label="Cost per port (minor units)" hint="For example 4500 is 45.00."><Input type="number" min={0} value={f.costPerPortMinor} onChange={(e) => setF({ ...f, costPerPortMinor: e.target.value })} /></Field>
            <Field label="Currency"><Input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Installation lead time (days)"><Input type="number" min={0} max={365} value={f.installLeadDays} onChange={(e) => setF({ ...f, installLeadDays: e.target.value })} /></Field>
            <Field label="SLA response window (hours)"><Input type="number" min={0} value={f.slaResponseHours} onChange={(e) => setF({ ...f, slaResponseHours: e.target.value })} /></Field>
            <Field label="Speed tiers (Mbps)" hint="Comma separated."><Input value={f.tiers} onChange={(e) => setF({ ...f, tiers: e.target.value })} /></Field>
            <Check on={f.enabled} set={(enabled) => setF({ ...f, enabled })}>Provider is on</Check>
            <div className="sm:col-span-2 border-t border-separator pt-3"><p className="mb-2 text-subhead font-semibold">Live coverage adapter</p></div>
            <Field label="Adapter"><Select value={f.adapterKind} onChange={(e) => setF({ ...f, adapterKind: e.target.value })}><option value="NONE">None: use imported coverage files</option><option value="REST">REST</option><option value="SOAP">SOAP</option></Select></Field>
            <Field label="Partner address"><Input value={f.adapterUrl} onChange={(e) => setF({ ...f, adapterUrl: e.target.value })} placeholder="https://…" disabled={f.adapterKind === 'NONE'} /></Field>
            <Field label="Credential" hint={f.hasSecret ? 'Set. Enter a new value to replace it.' : 'Sent as a bearer token (or the header you configure). Encrypted; never shown again.'}><Input type="password" autoComplete="new-password" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} disabled={f.adapterKind === 'NONE'} /></Field>
            <div className="flex flex-col justify-end">{f.hasSecret && <Check on={f.clearSecret} set={(clearSecret) => setF({ ...f, clearSecret })}>Remove the stored credential</Check>}<Check on={f.adapterEnabled} set={(adapterEnabled) => setF({ ...f, adapterEnabled })} disabled={f.adapterKind === 'NONE'}>Ask this partner live</Check></div>
            <div className="sm:col-span-2"><Field label="Adapter settings (JSON)" hint={`Where to read the partner's answer. For example ${CONFIG_HINT}`}><Textarea rows={7} className="font-mono text-footnote" value={f.adapterConfig} onChange={(e) => setF({ ...f, adapterConfig: e.target.value })} disabled={f.adapterKind === 'NONE'} /></Field></div>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button disabled={act.busy || !f.code || !f.name} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button>
              {f.id && <button type="button" className="ml-auto text-footnote text-danger" onClick={() => confirm(`Remove ${f.name}?`) && void act.run(() => del(`/admin/providers/${f.id}`), 'Removed').then(() => setF(null))}>Remove</button>}
            </div>
          </div>
        </Modal>)}

      {test && (
        <Modal title={`Test ${test.p.name}`} onClose={() => setTest(null)}>
          <p className="mb-3 text-subhead text-label2">Sends one real request to the partner and shows how its answer is read. Nothing is saved.</p>
          <div className="grid grid-cols-2 gap-3"><Field label="Latitude"><Input value={test.lat} onChange={(e) => setTest({ ...test, lat: e.target.value, out: undefined })} /></Field><Field label="Longitude"><Input value={test.lng} onChange={(e) => setTest({ ...test, lng: e.target.value, out: undefined })} /></Field></div>
          <div className="mt-3 flex gap-2"><Button disabled={act.busy} onClick={async () => { const o = await act.run(() => post(`/admin/providers/${test.p.id}/test`, { lat: Number(test.lat), lng: Number(test.lng) })); if (o) setTest({ ...test, out: o }); }}>Send test</Button><Button variant="secondary" onClick={() => { void act.run(() => post(`/admin/providers/${test.p.id}/clear-cache`), 'Cache cleared'); }}>Clear cached answers</Button></div>
          {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
          {test.out && <Card className="mt-3 !p-3">{test.out.ok ? <><p className="text-subhead"><Badge tone={test.out.answer.serviceable ? 'success' : 'danger'}>{test.out.answer.serviceable ? 'Serviceable' : 'Not serviceable'}</Badge> {label(test.out.answer.portStatus)} · {test.out.ms} ms</p><p className="mt-1 text-footnote text-label2">Speeds {tiers(test.out.answer.speedsMbps)} · lead {test.out.answer.leadDays ?? 'default'} days · ref {test.out.answer.reference ?? '—'}</p></> : <Alert>{test.out.error}</Alert>}</Card>}
        </Modal>)}
    </div>
  );
}
