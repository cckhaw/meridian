'use client';
import { Alert, Badge, Button, Empty, Field, Input, LargeTitle, LoadMore, Modal, SearchField, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useDebounced, usePaged } from '@/lib/api';

export default function Stores() {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [editing, setEditing] = useState<any>(null); // a store, or {} for a new one
  const list = usePaged<any>(`/stores?limit=25&q=${encodeURIComponent(term)}`);
  return (
    <>
      <LargeTitle subtitle="The retail stores your staff sell from. Create a store here, then choose it when you create a store user under Users & roles.">Stores</LargeTitle>
      <div className="mb-4 flex items-center gap-3">
        <SearchField label="Search stores" placeholder="Store id or name starts with…" value={q} onChange={setQ} className="md:max-w-sm md:flex-1" />
        <span className="flex-1" />
        <Button onClick={() => setEditing({})}>New store</Button>
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term ? 'No store matches.' : 'No stores yet. Add the first one.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Store id</Th><Th>Name</Th><Th>Address</Th><Th right>Active staff</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead><tbody>
            {list.items.map((s: any) => (
              <tr key={s.id}>
                <Td className="font-mono">{s.id}</Td>
                <Td><span className="font-medium">{s.name}</span>{s.phone && <span className="block text-footnote text-label2">{s.phone}</span>}</Td>
                <Td className="text-footnote text-label2">{s.address || '—'}</Td>
                <Td right>{Number(s.staffCount)}</Td>
                <Td><Badge tone={s.status === 'ACTIVE' ? 'success' : 'neutral'}>{s.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge></Td>
                <Td right><button className="min-h-tap px-2 text-accent" onClick={() => setEditing(s)}>Edit</button></Td>
              </tr>
            ))}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="stores" />
        </>
      )}
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
