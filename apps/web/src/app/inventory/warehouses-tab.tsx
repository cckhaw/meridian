'use client';
import { Alert, Badge, Button, Card, DataList, Empty, Field, Input, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';

/** Warehouse locations: add, rename, switch off and remove. Stock is received at, and written off from, these and the stores. */
export function WarehousesTab({ canManage }: { canManage: boolean }) {
  const { data, error, reload } = useApi<{ items: any[] }>('/warehouses');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const act = useAction(reload);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <>
      {canManage && <div className="mb-4 flex"><span className="flex-1" /><Button onClick={() => { setAdding(!adding); setEditing(null); }}>{adding ? 'Close' : 'Add warehouse'}</Button></div>}
      {adding && <WarehouseForm onDone={() => { setAdding(false); void reload(); }} />}
      {editing && <WarehouseForm warehouse={editing} onDone={() => { setEditing(null); void reload(); }} />}
      {act.error && <Alert>{act.error}</Alert>}
      {data.items.length === 0 ? <Empty>No warehouses yet.</Empty> : (
        <DataList label="Warehouses" rows={data.items} rowKey={(w: any) => w.id}
          columns={[
            { key: 'name', label: 'Warehouse', primary: true, render: (w: any) => <><span className="font-medium">{w.name}</span><div className="font-mono text-caption text-label2">{w.id}</div></> },
            { key: 'addr', label: 'Address', render: (w: any) => <span className="text-footnote text-label2">{w.address ?? ''}</span> },
            { key: 'skus', label: 'SKUs', right: true, render: (w: any) => w.stockLines },
            { key: 'units', label: 'Units', right: true, render: (w: any) => w.units },
            { key: 'st', label: 'Status', render: (w: any) => <Badge tone={w.status === 'ACTIVE' ? 'success' : 'neutral'}>{w.status === 'ACTIVE' ? 'On' : 'Switched off'}</Badge> },
          ]}
          actions={canManage ? (w: any) => (<>
                <Button variant="secondary" onClick={() => { setEditing(w); setAdding(false); }}>Edit</Button>
                {w.id !== 'WH-MAIN' && <Button variant="secondary" disabled={act.busy} onClick={() => act.run(() => patch(`/warehouses/${w.id}`, { status: w.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}>{w.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}</Button>}
                {w.id !== 'WH-MAIN' && <Button variant="secondary" disabled={act.busy} onClick={() => { if (confirm(`Remove ${w.name}? This only works when it holds no stock.`)) void act.run(() => del(`/warehouses/${w.id}`)); }}>Remove</Button>}
              </>) : undefined} />
      )}
      <p className="mt-3 text-footnote text-label2">The main warehouse is where online orders are fulfilled from, so it stays. A warehouse that holds stock cannot be removed: write the stock off first, or switch it off.</p>
    </>
  );
}

function WarehouseForm({ warehouse, onDone }: { warehouse?: any; onDone: () => void }) {
  const [f, setF] = useState({ name: warehouse?.name ?? '', address: warehouse?.address ?? '' });
  const { run, busy, error } = useAction();
  return (
    <Card className="mb-4 border border-accent/30">
      <h2 className="mb-3 text-title3 font-semibold">{warehouse ? `Edit ${warehouse.id}` : 'Add a warehouse'}</h2>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await run(() => (warehouse ? patch(`/warehouses/${warehouse.id}`, f) : post('/warehouses', f)))) onDone(); }}>
        <Field label="Name"><Input required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Penang distribution centre" /></Field>
        <Field label="Address" hint="Optional"><Input maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex gap-2 sm:col-span-2"><Button type="submit" disabled={busy}>{warehouse ? 'Save' : 'Add warehouse'}</Button><Button type="button" variant="secondary" onClick={onDone}>Cancel</Button></div>
      </form>
    </Card>
  );
}
