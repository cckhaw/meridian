'use client';
import { Alert, Badge, Button, Empty, Field, Input, LoadMore, Modal, Select, Spinner, Textarea } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dt, label } from '@/lib/format';
import { parseSimList } from './sim-list';

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { REQUESTED: 'neutral', IN_TRANSIT: 'warning', RECEIVED: 'success', CANCELLED: 'danger', RETURNED: 'danger' };
interface Place { id: string; name: string; kind: string }

/** Moving stock and SIM cards between warehouses and stores: ask, dispatch (it leaves the sender), receive (it reaches the receiver). */
export function TransfersTab({ canTransfer }: { canTransfer: boolean }) {
  const { me } = useAuth();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = usePaged(`/inventory/transfers?limit=30&status=${status}`);
  const places = useApi<{ items: Place[] }>('/inventory/transfer-places');
  const name = (id: string) => places.data?.items.find((p) => p.id === id)?.name ?? id;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="md:max-w-[220px]"><option value="">All transfers</option>{Object.keys(TONE).map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        {canTransfer && <Button className="ml-auto" onClick={() => setCreating(true)}>＋ New transfer</Button>}
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>No transfers yet. Move stock or SIM cards from one store or warehouse to another here.</Empty>}
      <ul className="space-y-2">
        {list.items.map((t: any) => (
          <li key={t.id}>
            <button type="button" onClick={() => setOpen(t.id)} className="flex w-full flex-wrap items-center gap-3 rounded-card bg-surface px-4 py-3 text-left shadow-card hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="font-mono text-subhead font-semibold">{t.number}</span>
              <Badge tone={TONE[t.status]}>{label(t.status)}</Badge>{t.discrepancy && <Badge tone="danger">Received short</Badge>}
              <span className="min-w-0 flex-1 truncate text-subhead">{name(t.fromLocation)} <span aria-hidden>→</span> {name(t.toLocation)}</span>
              <span className="text-footnote text-label2">{Number(t.units) > 0 ? `${t.units} units` : ''}{Number(t.units) > 0 && Number(t.sims) > 0 ? ' · ' : ''}{Number(t.sims) > 0 ? `${t.sims} SIM cards` : ''} · {dt(t.requestedAt)}</span>
            </button>
          </li>))}
      </ul>
      <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="transfers" />
      {creating && <NewTransfer places={places.data?.items ?? []} fixed={me?.storeId ?? null} onClose={() => setCreating(false)} onDone={async () => { setCreating(false); await list.reload(); }} />}
      {open && <TransferDetail id={open} name={name} canTransfer={canTransfer} onClose={() => setOpen(null)} onChanged={() => list.reload()} />}
    </>
  );
}

function NewTransfer({ places, fixed, onClose, onDone }: { places: Place[]; fixed: string | null; onClose: () => void; onDone: () => void | Promise<void> }) {
  const act = useAction();
  const [from, setFrom] = useState(fixed ?? '');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState([{ sku: '', quantity: '1' }]);
  const [sims, setSims] = useState('');
  const [note, setNote] = useState('');
  const submit = async () => {
    const iccids = parseSimList(sims);
    const count = !iccids.length && /^\d+$/.test(sims.trim()) ? Number(sims.trim()) : undefined;
    const body = { from, to, note: note || undefined, lines: lines.filter((l) => l.sku.trim()).map((l) => ({ sku: l.sku.trim(), quantity: Number(l.quantity) })), sims: iccids.length > 1 || (iccids.length === 1 && !count) ? { iccids } : count ? { count } : undefined };
    if (await act.run(() => post('/inventory/transfers', body))) await onDone();
  };
  return (
    <Modal title="New transfer" onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        {act.error && <div className="sm:col-span-2"><Alert>{act.error}</Alert></div>}
        <Field label="From"><Select value={from} disabled={!!fixed} onChange={(e) => setFrom(e.target.value)}><option value="">Choose…</option>{places.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}</Select></Field>
        <Field label="To"><Select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{places.filter((p) => p.id !== from).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}</Select></Field>
        <div className="sm:col-span-2">
          <p className="mb-1 text-footnote font-medium text-label2">Products</p>
          {lines.map((l, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <Input aria-label="SKU" placeholder="SKU" value={l.sku} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, sku: e.target.value.toUpperCase() } : x)))} className="font-mono" />
              <Input aria-label="Quantity" type="number" min={1} value={l.quantity} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} className="w-28" />
              {lines.length > 1 && <button type="button" aria-label="Remove line" className="px-2 text-danger" onClick={() => setLines(lines.filter((_, k) => k !== i))}>✕</button>}
            </div>))}
          <button type="button" className="text-footnote text-accent" onClick={() => setLines([...lines, { sku: '', quantity: '1' }])}>＋ Add a product</button>
        </div>
        <div className="sm:col-span-2"><Field label="SIM cards" hint="A number to take that many free cards from the sender, or paste the card numbers (ICCIDs), one per line or separated by commas or spaces. Leave empty for none."><Textarea rows={3} value={sims} onChange={(e) => setSims(e.target.value)} className="font-mono" /></Field></div>
        <div className="sm:col-span-2"><Field label="Note"><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field></div>
        <div className="flex gap-2 sm:col-span-2"><Button disabled={act.busy || !from || !to} onClick={() => void submit()}>Request transfer</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}

function TransferDetail({ id, name, canTransfer, onClose, onChanged }: { id: string; name: (id: string) => string; canTransfer: boolean; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const { me } = useAuth();
  const t = useApi<any>(`/inventory/transfers/${id}`);
  const act = useAction(async () => { await t.reload(); await onChanged(); });
  const [got, setGot] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState('');
  if (!t.data) return <Modal title="Transfer" onClose={onClose}><Spinner /></Modal>;
  const x = t.data;
  const mineFrom = !me?.storeId || me.storeId === x.fromLocation, mineTo = !me?.storeId || me.storeId === x.toLocation;
  const receive = async () => {
    const received = Object.fromEntries(x.lines.map((l: any) => [l.sku, got[l.sku] === undefined ? l.quantity : Number(got[l.sku])]));
    const absent = parseSimList(missing);
    const iccids = absent.length ? x.sims.map((s: any) => s.iccid).filter((i: string) => !absent.includes(i)) : undefined;
    await act.run(() => post(`/inventory/transfers/${id}/receive`, { received, iccids }), 'Received');
  };
  return (
    <Modal title={x.number} onClose={onClose} wide>
      <div className="space-y-4">
        {act.error && <Alert>{act.error}</Alert>}{act.ok && <Alert tone="success">{act.ok}</Alert>}
        <p className="flex flex-wrap items-center gap-2 text-subhead"><Badge tone={TONE[x.status]}>{label(x.status)}</Badge>{x.discrepancy && <Badge tone="danger">Received short</Badge>}<span>{name(x.fromLocation)} → {name(x.toLocation)}</span></p>
        <p className="text-footnote text-label2">Requested by {x.requestedBy}, {dt(x.requestedAt)}{x.dispatchedAt ? ` · dispatched ${dt(x.dispatchedAt)} by ${x.dispatchedBy}` : ''}{x.receivedAt ? ` · received ${dt(x.receivedAt)} by ${x.receivedBy}` : ''}{x.note ? ` · ${x.note}` : ''}</p>
        {x.lines.length > 0 && (
          <ul className="divide-y divide-separator rounded-card bg-surface2 px-3">{x.lines.map((l: any) => (
            <li key={l.sku} className="flex flex-wrap items-center gap-3 py-2"><span className="font-mono">{l.sku}</span><span className="text-label2">{l.quantity} sent</span>
              {l.received !== null && <span className={l.received < l.quantity ? 'text-danger' : 'text-label2'}>{l.received} received</span>}
              {x.status === 'IN_TRANSIT' && canTransfer && mineTo && <label className="ml-auto flex items-center gap-2 text-footnote">Received <Input type="number" min={0} max={l.quantity} value={got[l.sku] ?? String(l.quantity)} onChange={(e) => setGot({ ...got, [l.sku]: e.target.value })} className="w-24" /></label>}
            </li>))}</ul>)}
        {x.simCount > 0 && (
          <div>
            <p className="text-subhead font-medium">{x.simCount} SIM cards</p>
            <p className="mt-1 max-h-24 overflow-auto font-mono text-footnote text-label2">{x.sims.map((s: any) => s.iccid + (s.received === false ? ' (lost)' : '')).join(', ')}{x.simCount > x.sims.length ? ' …' : ''}</p>
            {x.status === 'IN_TRANSIT' && canTransfer && mineTo && <Field label="Cards that did not arrive" hint="Paste their numbers, one per line or separated by commas or spaces. They are written off as lost in transit."><Textarea rows={2} value={missing} onChange={(e) => setMissing(e.target.value)} className="font-mono" /></Field>}
          </div>)}
        {canTransfer && (
          <div className="flex flex-wrap gap-2">
            {x.status === 'REQUESTED' && mineFrom && <Button disabled={act.busy} onClick={() => void act.run(() => post(`/inventory/transfers/${id}/dispatch`), 'Dispatched: the stock has left the sender')}>Dispatch</Button>}
            {x.status === 'IN_TRANSIT' && mineTo && <Button disabled={act.busy} onClick={() => void receive()}>Receive</Button>}
            {(x.status === 'REQUESTED' || x.status === 'IN_TRANSIT') && <Button variant="secondary" disabled={act.busy} onClick={() => confirm(x.status === 'REQUESTED' ? 'Cancel this request?' : 'Send it back? The stock returns to the sender.') && void act.run(() => post(`/inventory/transfers/${id}/cancel`), x.status === 'REQUESTED' ? 'Cancelled' : 'Sent back')}>{x.status === 'REQUESTED' ? 'Cancel request' : 'Send back'}</Button>}
          </div>)}
      </div>
    </Modal>
  );
}
