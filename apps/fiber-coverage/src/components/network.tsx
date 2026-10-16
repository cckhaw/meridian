'use client';
import { Alert, Badge, Button, Empty, Field, Input, Modal, Segmented, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { del, post, patch, useAction, useApi } from '@/lib/api';
import { dt, label, tiers } from '@/lib/format';
import { PortBar } from './shared';

type Sub = 'dps' | 'cabinets' | 'areas';
export function Network() {
  const [sub, setSub] = useState<Sub>('dps');
  const providers = useApi<{ items: any[] }>('/admin/providers');
  return (
    <div className="grid gap-4 [&>*]:min-w-0">
      <Segmented label="Network" value={sub} options={[{ value: 'dps', label: 'Distribution points' }, { value: 'cabinets', label: 'Cabinets' }, { value: 'areas', label: 'Coverage areas' }]} onChange={setSub} />
      {sub === 'dps' && <Dps providers={providers.data?.items ?? []} />}
      {sub === 'cabinets' && <Cabinets providers={providers.data?.items ?? []} />}
      {sub === 'areas' && <Areas />}
    </div>
  );
}

const SPLITS = [2, 4, 8, 16, 32, 64];
function Dps({ providers }: { providers: any[] }) {
  const [prov, setProv] = useState('');
  const list = useApi<{ items: any[] }>(`/admin/dps${prov ? `?providerId=${prov}` : ''}`);
  const cabs = useApi<{ items: any[] }>('/admin/cabinets');
  const act = useAction(list.reload);
  const [f, setF] = useState<any | null>(null);
  const [ports, setPorts] = useState<{ dp: any; items: any[] } | null>(null);
  const open = async (dp: any) => setPorts(await (await import('@/lib/api')).api(`/admin/dps/${dp.id}/ports`));
  const save = async () => {
    const b = { providerId: f.providerId, cabinetId: f.cabinetId || null, code: f.code.trim(), name: f.name, kind: f.kind, lat: Number(f.lat), lng: Number(f.lng), splitterRatio: Number(f.splitterRatio), radiusM: Number(f.radiusM), address: f.address || undefined, city: f.city || undefined, postalCode: f.postalCode || undefined, status: f.status, ...(f.id ? {} : { usedPorts: Number(f.usedPorts || 0), faultyPorts: Number(f.faultyPorts || 0) }) };
    if (await act.run(() => (f.id ? patch(`/admin/dps/${f.id}`, b) : post('/admin/dps', b)), 'Saved')) setF(null);
  };
  return (
    <>
      {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Provider"><Select value={prov} onChange={(e) => setProv(e.target.value)}><option value="">All providers</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Button disabled={!providers.length} onClick={() => setF({ providerId: providers[0]?.id ?? '', cabinetId: '', code: '', name: '', kind: 'DP', lat: '', lng: '', splitterRatio: '8', radiusM: '150', address: '', city: '', postalCode: '', status: 'ACTIVE', usedPorts: '0', faultyPorts: '0' })}>Add distribution point</Button>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.data && list.data.items.length === 0 && <Empty>No distribution points{prov ? ' for this provider' : ''} yet. Add one, or load a file under Import.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <TableWrap>
          <thead><tr><Th>DP</Th><Th>Provider</Th><Th>Splitter</Th><Th>Ports</Th><Th right>Reach</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>{list.data.items.map((d) => (
            <tr key={d.id}>
              <Td><span className="font-medium">{d.code}</span><span className="block text-footnote text-label2">{d.name}{d.city ? ` · ${d.city}` : ''}</span></Td><Td>{d.providerCode}</Td><Td>1:{d.splitterRatio}</Td>
              <Td><PortBar available={d.available} reserved={d.reservedCheckout + d.reservedOrder} inUse={d.inUse} faulty={d.faulty} total={d.total} /></Td><Td right>{d.radiusM} m</Td><Td><Badge tone={d.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(d.status)}</Badge></Td>
              <Td><div className="flex gap-2"><Button variant="secondary" onClick={() => void open(d)}>Ports</Button><Button variant="secondary" onClick={() => setF({ ...d, cabinetId: d.cabinetId ?? '', lat: String(d.lat), lng: String(d.lng), splitterRatio: String(d.splitterRatio), radiusM: String(d.radiusM), address: d.address ?? '', city: d.city ?? '', postalCode: d.postalCode ?? '' })}>Edit</Button></div></Td>
            </tr>))}</tbody>
        </TableWrap>)}

      {f && (
        <Modal title={`${f.id ? 'Edit' : 'New'} distribution point`} onClose={() => setF(null)} wide>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Provider"><Select value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Cabinet"><Select value={f.cabinetId} onChange={(e) => setF({ ...f, cabinetId: e.target.value })}><option value="">None</option>{(cabs.data?.items ?? []).filter((c) => c.providerId === f.providerId).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select></Field>
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="DP">DP box</option><option value="FDP">FDP</option></Select></Field>
            <Field label="Splitter"><Select value={f.splitterRatio} onChange={(e) => setF({ ...f, splitterRatio: e.target.value })}>{SPLITS.map((s) => <option key={s} value={s}>1:{s}</option>)}</Select></Field>
            <Field label="Latitude"><Input value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Longitude"><Input value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Coverage radius (metres)"><Input type="number" min={10} max={5000} value={f.radiusM} onChange={(e) => setF({ ...f, radiusM: e.target.value })} /></Field>
            <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Active</option><option value="PLANNED">Planned</option><option value="DECOMMISSIONED">Decommissioned</option></Select></Field>
            <Field label="Address"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3"><Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field><Field label="Postcode"><Input value={f.postalCode} onChange={(e) => setF({ ...f, postalCode: e.target.value })} /></Field></div>
            {!f.id && <><Field label="Ports already in use" hint="From existing inventory."><Input type="number" min={0} value={f.usedPorts} onChange={(e) => setF({ ...f, usedPorts: e.target.value })} /></Field><Field label="Ports faulty"><Input type="number" min={0} value={f.faultyPorts} onChange={(e) => setF({ ...f, faultyPorts: e.target.value })} /></Field></>}
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.code || !f.name || f.lat === '' || f.lng === ''} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}

      {ports && <PortsModal data={ports} onClose={() => { setPorts(null); void list.reload(); }} />}
    </>
  );
}

function PortsModal({ data, onClose }: { data: { dp: any; items: any[] }; onClose: () => void }) {
  const [items, setItems] = useState(data.items);
  const act = useAction();
  const TONE: Record<string, string> = { AVAILABLE: 'bg-success/20 text-success', RESERVED_CHECKOUT: 'bg-warning/20 text-warning', RESERVED_ORDER: 'bg-warning/20 text-warning', IN_USE: 'bg-label2/20 text-label', FAULTY: 'bg-danger/20 text-danger' };
  const flip = async (p: any) => {
    const to = p.state === 'FAULTY' ? 'AVAILABLE' : 'FAULTY';
    const r = await act.run(() => post(`/admin/ports/${p.id}/state`, { state: to }));
    if (r) setItems(items.map((x) => (x.id === p.id ? { ...x, state: to } : x)));
  };
  return (
    <Modal title={`${data.dp.code}: ports`} onClose={onClose}>
      {act.error && <Alert>{act.error}</Alert>}
      <p className="mb-3 text-subhead text-label2">Tap a free port to mark it faulty, or a faulty one to bring it back. Ports reserved or in use belong to a customer and are released through their reservation.</p>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {items.map((p) => (
          <button key={p.id} type="button" disabled={act.busy || ['RESERVED_CHECKOUT', 'RESERVED_ORDER', 'IN_USE'].includes(p.state)} onClick={() => void flip(p)} title={label(p.state)}
            className={`min-h-tap rounded-control px-2 py-2 text-footnote font-medium ${TONE[p.state]} disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>{p.portNo}<span className="block text-caption font-normal">{label(p.state).split(' ')[0]}</span></button>))}
      </div>
    </Modal>
  );
}

function Cabinets({ providers }: { providers: any[] }) {
  const list = useApi<{ items: any[] }>('/admin/cabinets');
  const act = useAction(list.reload);
  const [f, setF] = useState<any | null>(null);
  const save = async () => { const b = { providerId: f.providerId, code: f.code.trim(), name: f.name, lat: Number(f.lat), lng: Number(f.lng), city: f.city || undefined, state: f.state || undefined, postalCode: f.postalCode || undefined, status: f.status }; if (await act.run(() => (f.id ? patch(`/admin/cabinets/${f.id}`, b) : post('/admin/cabinets', b)), 'Saved')) setF(null); };
  const name = (id: string) => providers.find((p) => p.id === id)?.code ?? '';
  return (
    <>
      {act.error && !f && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <div className="flex justify-end"><Button disabled={!providers.length} onClick={() => setF({ providerId: providers[0]?.id ?? '', code: '', name: '', lat: '', lng: '', city: '', state: '', postalCode: '', status: 'ACTIVE' })}>Add cabinet</Button></div>
      {list.data && list.data.items.length === 0 && <Empty>No cabinets yet. A cabinet groups the distribution points it feeds.</Empty>}
      {list.data && list.data.items.length > 0 && <TableWrap><thead><tr><Th>Cabinet</Th><Th>Provider</Th><Th>Location</Th><Th>Status</Th><Th /></tr></thead><tbody>{list.data.items.map((c) => <tr key={c.id}><Td><span className="font-medium">{c.code}</span><span className="block text-footnote text-label2">{c.name}</span></Td><Td>{name(c.providerId)}</Td><Td className="text-label2">{c.lat.toFixed(5)}, {c.lng.toFixed(5)}{c.city ? ` · ${c.city}` : ''}</Td><Td><Badge tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>{label(c.status)}</Badge></Td><Td><Button variant="secondary" onClick={() => setF({ ...c, lat: String(c.lat), lng: String(c.lng), city: c.city ?? '', state: c.state ?? '', postalCode: c.postalCode ?? '' })}>Edit</Button></Td></tr>)}</tbody></TableWrap>}
      {f && (
        <Modal title={`${f.id ? 'Edit' : 'New'} cabinet`} onClose={() => setF(null)}>
          <div className="grid gap-3 sm:grid-cols-2">
            {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
            <Field label="Provider"><Select value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Active</option><option value="PLANNED">Planned</option><option value="DECOMMISSIONED">Decommissioned</option></Select></Field>
            <Field label="Latitude"><Input value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /></Field><Field label="Longitude"><Input value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} /></Field>
            <Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field><Field label="State / province"><Input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></Field>
            <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !f.code || !f.name || f.lat === '' || f.lng === ''} onClick={() => void save()}>Save</Button><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button></div>
          </div>
        </Modal>)}
    </>
  );
}

function Areas() {
  const list = useApi<{ items: any[] }>('/admin/polygons');
  const act = useAction(list.reload);
  return (
    <>
      {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
      <p className="text-subhead text-label2">Coverage areas are drawn on the Map tab or loaded from a partner’s file under Import. Each one says which provider reaches the places inside it, at which speeds, and whether it has capacity.</p>
      {list.data && list.data.items.length === 0 && <Empty>No coverage areas yet.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <TableWrap><thead><tr><Th>Area</Th><Th>Provider</Th><Th>Kind</Th><Th>Speeds</Th><Th>Capacity</Th><Th>Source</Th><Th /></tr></thead>
          <tbody>{list.data.items.map((g) => <tr key={g.id}><Td className="font-medium">{g.name}</Td><Td>{g.providerCode}</Td><Td className="text-label2">{label(g.kind)}</Td><Td className="text-label2">{g.speedTiersMbps ? tiers(g.speedTiersMbps) : 'Provider default'}</Td><Td><Badge tone={g.capacityStatus === 'AVAILABLE' ? 'success' : 'warning'}>{label(g.capacityStatus)}</Badge></Td><Td className="text-footnote text-label2">{g.source.startsWith('IMPORT') ? 'Imported' : 'Drawn'} · {dt(g.createdAt)}</Td><Td><button type="button" className="text-footnote text-danger" onClick={() => confirm(`Remove ${g.name}?`) && void act.run(() => del(`/admin/polygons/${g.id}`), 'Removed')}>Remove</button></Td></tr>)}</tbody></TableWrap>)}
    </>
  );
}
