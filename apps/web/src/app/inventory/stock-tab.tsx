'use client';
import { Alert, Button, Card, Empty, Field, Input, LoadMore, SearchField, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ImportStock } from './import-stock';
import { useLocations } from './locations';

export const REASONS: Array<[string, string]> = [['DAMAGED', 'Damaged'], ['LOST', 'Lost'], ['EXPIRED', 'Expired'], ['THEFT', 'Stolen'], ['COUNT', 'Stock count came up short'], ['OTHER', 'Other (say what happened)']];

export function StockTab() {
  const { can, me } = useAuth();
  const [loc, setLoc] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const locations = useLocations();
  const list = usePaged(`/inventory?limit=50&locationId=${encodeURIComponent(loc)}&sku=${encodeURIComponent(term)}`);
  const [panel, setPanel] = useState<'' | 'receive' | 'writeoff'>('');
  const [importing, setImporting] = useState(false);
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search SKU" placeholder="SKU starts with…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        {!me?.storeId && <Select aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)} className="md:max-w-[240px]"><option value="">All locations</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select>}
        <span className="flex-1" />
        <div className="flex flex-wrap gap-2">
          {can('inventory:write') && <Button type="button" variant="secondary" onClick={() => setImporting(true)}>Load in batch (CSV)</Button>}
          {can('inventory:write') && <Button type="button" variant="secondary" onClick={() => setPanel(panel === 'receive' ? '' : 'receive')}>Receive stock</Button>}
          {can('inventory:writeoff') && <Button type="button" variant="secondary" onClick={() => setPanel(panel === 'writeoff' ? '' : 'writeoff')}>Write off</Button>}
        </div>
      </div>
      {panel === 'receive' && <MovementForm kind="receive" locations={locations} onDone={() => { setPanel(''); void list.reload(); }} />}
      {panel === 'writeoff' && <MovementForm kind="writeoff" locations={locations} onDone={() => { setPanel(''); void list.reload(); }} />}
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term || loc ? 'No stock matches.' : 'No stock records.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Location</Th><Th>SKU</Th><Th right>On hand</Th><Th right>Reserved</Th><Th right>Available</Th></tr></thead><tbody>
            {list.items.map((s: any) => <tr key={s.locationId + s.sku}><Td>{s.locationId}</Td><Td className="font-mono">{s.sku}</Td><Td right>{s.onHand}</Td><Td right>{s.reserved}</Td><Td right className={s.available <= 3 ? 'font-semibold text-danger' : ''}>{s.available}</Td></tr>)}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="stock lines" />
        </>
      )}
      {importing && <ImportStock locations={locations.map((l) => l.id)} onClose={() => setImporting(false)} onDone={list.reload} />}
    </>
  );
}

/** Receive one SKU, or write it off with a reason. Bigger deliveries go through the CSV batch load. */
function MovementForm({ kind, locations, onDone }: { kind: 'receive' | 'writeoff'; locations: { id: string; label: string }[]; onDone: () => void }) {
  const { me } = useAuth();
  const [f, setF] = useState({ locationId: me?.storeId ?? 'WH-MAIN', sku: '', quantity: '1', reason: 'DAMAGED', note: '' });
  const { run, busy, error } = useAction();
  const stock = useApi<{ items: any[] }>(kind === 'writeoff' && f.sku.trim().length > 1 ? `/inventory?limit=1&locationId=${encodeURIComponent(f.locationId)}&sku=${encodeURIComponent(f.sku.trim())}` : null);
  const have = stock.data?.items.find((s) => s.sku === f.sku.trim().toUpperCase());
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run(() => kind === 'receive'
      ? post('/inventory/adjust', { locationId: f.locationId, sku: f.sku, delta: Number(f.quantity), note: f.note || undefined })
      : post('/inventory/write-off', { locationId: f.locationId, sku: f.sku, quantity: Number(f.quantity), reason: f.reason, note: f.note || undefined }));
    if (ok) onDone();
  };
  return (
    <Card className="mb-4">
      <h2 className="mb-3 text-title3 font-semibold">{kind === 'receive' ? 'Receive stock' : 'Write stock off'}</h2>
      <form className="grid gap-3 sm:grid-cols-4 sm:items-end" onSubmit={submit}>
        <Field label="Location"><Select required disabled={!!me?.storeId} value={f.locationId} onChange={set('locationId')}>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>
        <Field label="SKU" hint={kind === 'writeoff' && have ? `${have.available} available to write off` : undefined}><Input required value={f.sku} onChange={set('sku')} className="font-mono uppercase" /></Field>
        <Field label="Quantity"><Input required type="number" min={1} step={1} value={f.quantity} onChange={set('quantity')} /></Field>
        {kind === 'writeoff'
          ? <Field label="Reason"><Select value={f.reason} onChange={set('reason')}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          : <Field label="Note (optional)"><Input value={f.note} maxLength={300} onChange={set('note')} placeholder="Delivery note, PO…" /></Field>}
        {kind === 'writeoff' && <div className="sm:col-span-3"><Field label={f.reason === 'OTHER' ? 'What happened' : 'Note (optional)'}><Input required={f.reason === 'OTHER'} value={f.note} maxLength={300} onChange={set('note')} /></Field></div>}
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : kind === 'receive' ? 'Receive' : 'Write off'}</Button>
        {error && <div className="sm:col-span-4"><Alert>{error}</Alert></div>}
      </form>
    </Card>
  );
}
