'use client';
import { Alert, Button, Card, Empty, Field, Input, LargeTitle, LoadMore, SearchField, Select, SectionTitle, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { post, useAction, useApi, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function Inventory() {
  const { can, me } = useAuth();
  const [loc, setLoc] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const locations = useApi<{ items: string[] }>(me?.storeId ? null : '/inventory/locations');
  const list = usePaged(`/inventory?limit=50&locationId=${encodeURIComponent(loc)}&sku=${encodeURIComponent(term)}`);
  const [f, setF] = useState({ locationId: me?.storeId ?? 'WH-MAIN', sku: '', delta: '10' });
  const { run, busy, error: aerr, ok } = useAction(list.reload);
  return (
    <>
      <LargeTitle subtitle="On-hand, reserved and available stock by location. Search by SKU prefix.">Inventory</LargeTitle>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchField label="Search SKU" placeholder="SKU starts with…" value={q} onChange={setQ} className="md:max-w-md md:flex-1" />
        {!me?.storeId && <Select aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)} className="md:max-w-[220px]"><option value="">All locations</option>{(locations.data?.items ?? []).map((l) => <option key={l}>{l}</option>)}</Select>}
      </div>
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
      {can('inventory:write') && <><SectionTitle>Goods receipt / adjustment</SectionTitle>
      <Card><form className="grid gap-3 sm:grid-cols-4 sm:items-end" onSubmit={(e) => { e.preventDefault(); void run(() => post('/inventory/adjust', { locationId: f.locationId, sku: f.sku, delta: Number(f.delta) }), 'Stock updated'); }}>
        <Field label="Location"><Input required readOnly={!!me?.storeId} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} /></Field>
        <Field label="SKU"><Input required value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label="Change" hint="Negative to write off"><Input required type="number" value={f.delta} onChange={(e) => setF({ ...f, delta: e.target.value })} /></Field>
        <Button type="submit" disabled={busy}>Apply</Button>
        {aerr && <div className="sm:col-span-4"><Alert>{aerr}</Alert></div>}{ok && <div className="sm:col-span-4"><Alert tone="success">{ok}</Alert></div>}
      </form></Card></>}
    </>
  );
}
