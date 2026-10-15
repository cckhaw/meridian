'use client';
import { Alert, Badge, Button, DataList, Empty, Field, Input, LargeTitle, LoadMore, Modal, SearchField, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { BulkImport } from '@/components/bulk-import';
import { del, patch, post, useAction, useDebounced, usePaged } from '@/lib/api';

export default function Stores() {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [editing, setEditing] = useState<any>(null); // a store, or {} for a new one
  const [bulk, setBulk] = useState(false);
  const list = usePaged<any>(`/stores?limit=25&q=${encodeURIComponent(term)}`);
  return (
    <>
      <LargeTitle subtitle="The retail stores your staff sell from. Create a store here, then choose it when you create a store user under Users & roles.">Stores</LargeTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchField label="Search stores" placeholder="Store id or name starts with…" value={q} onChange={setQ} className="w-full md:w-auto md:max-w-sm md:flex-1" />
        <span className="hidden flex-1 md:block" />
        <Button variant="secondary" className="whitespace-nowrap" onClick={() => setBulk(true)}>Import / export</Button>
        <Button onClick={() => setEditing({})}>New store</Button>
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term ? 'No store matches.' : 'No stores yet. Add the first one.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <DataList label="Stores" rows={list.items} rowKey={(s: any) => s.id}
            columns={[
              { key: 'name', label: 'Store', primary: true, render: (s: any) => <><span className="font-medium">{s.name}</span><span className="block font-mono text-footnote text-label2">{s.id}</span>{s.phone && <span className="block text-footnote text-label2">{s.phone}</span>}</> },
              { key: 'addr', label: 'Address', render: (s: any) => <span className="text-footnote text-label2">{s.address || '—'}</span> },
              { key: 'staff', label: 'Active staff', right: true, render: (s: any) => Number(s.staffCount) },
              { key: 'st', label: 'Status', render: (s: any) => <Badge tone={s.status === 'ACTIVE' ? 'success' : 'neutral'}>{s.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
            ]}
            actions={(s: any) => <Button variant="secondary" onClick={() => setEditing(s)}>Edit</Button>} />
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="stores" />
        </>
      )}
      {bulk && <BulkImport title="Import or export stores" onClose={() => setBulk(false)} onDone={() => void list.reload()} tabs={[{ id: 'stores', label: 'Stores', noun: ['store', 'stores'], templateHref: '/api/stores/import-template', exportHref: '/api/stores/export', importPath: '/stores/import' }]} />}
      {editing && <StoreForm store={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload(); }} />}
    </>
  );
}

function StoreForm({ store, onClose, onDone }: { store: any; onClose: () => void; onDone: () => void }) {
  const isNew = !store.id;
  const [f, setF] = useState({ name: store.name ?? '', address: store.address ?? '', phone: store.phone ?? '', status: store.status ?? 'ACTIVE' });
  const { run, busy, error } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={isNew ? 'New store' : `Edit ${store.name}`} onClose={onClose}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: f.name, address: f.address, phone: f.phone };
        if (await run(() => (isNew ? post('/stores', body) : patch(`/stores/${store.id}`, { ...body, status: f.status })))) onDone();
      }}>
        {!isNew && <Field label="Store id" hint="Issued by the system"><Input readOnly value={store.id} className="bg-surface2 font-mono" /></Field>}
        <Field label="Name"><Input required maxLength={120} value={f.name} onChange={set('name')} placeholder="e.g. Orchard Flagship" /></Field>
        <div className="sm:col-span-2"><Field label="Address"><Input maxLength={300} value={f.address} onChange={set('address')} /></Field></div>
        <Field label="Phone"><Input maxLength={40} value={f.phone} onChange={set('phone')} /></Field>
        {!isNew && (
          <label className="flex min-h-tap items-center gap-3 sm:col-span-2"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.status === 'ACTIVE'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'ACTIVE' : 'INACTIVE' })} />Active: staff can be assigned and orders can be sold here</label>
        )}
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex flex-wrap gap-3 sm:col-span-2">
          <Button type="submit" disabled={busy}>{isNew ? 'Create store' : 'Save'}</Button>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={async () => {
            if (!window.confirm(`Remove ${store.name}? This only works for a store that has never had staff, orders or stock; otherwise switch it off instead.`)) return;
            if (await run(() => del(`/stores/${store.id}`))) onDone();
          }}>Remove store</Button>}
        </div>
      </form>
    </Modal>
  );
}
