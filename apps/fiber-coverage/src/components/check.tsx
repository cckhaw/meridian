'use client';
import { Alert, Badge, Button, Card, Field, Input } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction } from '@/lib/api';
import { label, tiers } from '@/lib/format';
import { AVAIL_TONE } from './shared';

/** The availability matrix, as the customer-facing checks show it. Used by the Try-it tab and by the map's click-to-check. */
export function Result({ r }: { r: any }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={AVAIL_TONE[r.availability as keyof typeof AVAIL_TONE]}>{label(r.availability)}</Badge>
        <span className="text-subhead text-label2">{r.location.address?.formatted ? `${r.location.address.formatted} · ` : ''}{r.location.lat.toFixed(5)}, {r.location.lng.toFixed(5)} · located by {label(r.location.precision)} · {r.tookMs} ms</span>
      </div>
      {r.partial && <Alert tone="info">Some partners could not be reached: {r.partnerErrors.map((e: any) => `${e.provider} (${e.error})`).join('; ')}</Alert>}
      {r.options.length === 0 ? <p className="text-subhead text-label2">No provider’s network reaches this place.</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {r.options.map((o: any) => (
            <Card key={o.providerId} className={`!p-4 ${r.recommended?.providerId === o.providerId ? 'ring-2 ring-success' : ''}`}>
              <div className="flex items-start justify-between gap-2"><div><p className="font-semibold">{o.providerName}</p><p className="text-footnote text-label2">{o.ownerType === 'OWNED_INFRASTRUCTURE' ? 'Own network' : 'Wholesale partner'} · {label(o.source)}</p></div><Badge tone={AVAIL_TONE[o.status as keyof typeof AVAIL_TONE]}>{label(o.status)}</Badge></div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-subhead">
                <dt className="text-label2">Speeds</dt><dd>{tiers(o.speedTiersMbps)}</dd>
                <dt className="text-label2">Ports</dt><dd>{o.ports ? `${o.ports.available} free of ${o.ports.total}` : 'Not tracked'}</dd>
                <dt className="text-label2">Distribution point</dt><dd>{o.dp ? `${o.dp.code} (${o.dp.distanceM} m)` : '—'}</dd>
                <dt className="text-label2">Installation</dt><dd>{o.estimatedInstallDays != null ? `about ${o.estimatedInstallDays} days` : '—'}</dd>
                <dt className="text-label2">Provider SLA</dt><dd>{o.slaResponseHours} h response</dd>
              </dl>
              {o.note && <p className="mt-2 text-footnote text-label2">{o.note}</p>}
            </Card>))}
        </div>)}
    </div>
  );
}

export function Check() {
  const act = useAction();
  const [f, setF] = useState({ address: '', postalCode: '', lat: '', lng: '', speed: '' });
  const [r, setR] = useState<any>(null);
  const gps = f.lat !== '' && f.lng !== '';
  const go = async () => {
    const body: any = gps ? { lat: Number(f.lat), lng: Number(f.lng) } : { address: f.address || undefined, postalCode: f.postalCode || undefined };
    if (f.speed) body.speedMbps = Number(f.speed);
    const out = await act.run(() => post('/admin/check', body)); if (out) setR(out);
  };
  return (
    <div className="grid gap-4 [&>*]:min-w-0">
      <Card>
        <p className="mb-3 text-subhead text-label2">Runs exactly what the CRM and store-front run at address entry, so Fibre Ops can see what a customer would be told.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2"><Field label="Address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="1 Orchard Road #05-01" disabled={gps} /></Field></div>
          <Field label="Postcode"><Input value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} disabled={gps} /></Field>
          <Field label="Speed wanted (Mbps)"><Input type="number" min={1} value={f.speed} onChange={(e) => setF({ ...f, speed: e.target.value })} placeholder="Any" /></Field>
          <Field label="Latitude" hint="Instead of an address."><Input value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} inputMode="decimal" /></Field>
          <Field label="Longitude"><Input value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} inputMode="decimal" /></Field>
        </div>
        <div className="mt-3"><Button disabled={act.busy || (!gps && !f.address.trim() && !f.postalCode.trim())} onClick={() => void go()}>{act.busy ? 'Checking…' : 'Check coverage'}</Button></div>
        {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
      </Card>
      {r && <Result r={r} />}
    </div>
  );
}
