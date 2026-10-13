'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LargeTitle, LoadMore, Modal, SearchField, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { patch, post, useAction, useDebounced, usePaged } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function Dealers() {
  const { can } = useAuth();
  const manage = can('dealer:manage');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim());
  const [editing, setEditing] = useState<any>(null); // a dealer, or {} for a new one
  const [open, setOpen] = useState<any>(null);       // the dealer whose agents are shown
  const list = usePaged<any>(`/dealers?limit=25&q=${encodeURIComponent(term)}`);
  return (
    <>
      <LargeTitle subtitle="Partner dealers and the agents who sell for them. Orders placed on a dealer’s behalf name both.">Dealers</LargeTitle>
      <div className="mb-4 flex items-center gap-3">
        <SearchField label="Search dealers" placeholder="Dealer id or name starts with…" value={q} onChange={setQ} className="md:max-w-sm md:flex-1" />
        <span className="flex-1" />
        {manage && <Button onClick={() => setEditing({})}>New dealer</Button>}
      </div>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>{term ? 'No dealer matches.' : 'No dealers yet.'}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Dealer id</Th><Th>Name</Th><Th>Contact</Th><Th right>Active agents</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead><tbody>
            {list.items.map((d: any) => (
              <tr key={d.id}>
                <Td className="font-mono">{d.id}</Td><Td>{d.name}</Td>
                <Td className="text-footnote text-label2">{[d.contactName, d.email, d.phone].filter(Boolean).join(' · ') || '—'}</Td>
                <Td right>{d.activeAgents}</Td>
                <Td><Badge tone={d.status === 'ACTIVE' ? 'success' : 'neutral'}>{d.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge></Td>
                <Td right><button className="min-h-tap px-2 text-accent" onClick={() => setOpen(d)}>Agents</button>{manage && <button className="min-h-tap px-2 text-accent" onClick={() => setEditing(d)}>Edit</button>}</Td>
              </tr>
            ))}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="dealers" />
        </>
      )}
      {editing && <DealerForm dealer={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void list.reload(); }} />}
      {open && <Agents dealer={open} manage={manage} onClose={() => { setOpen(null); void list.reload(); }} />}
    </>
  );
}

function DealerForm({ dealer, onClose, onDone }: { dealer: any; onClose: () => void; onDone: () => void }) {
  const isNew = !dealer.id;
  const [f, setF] = useState({ id: dealer.id ?? '', name: dealer.name ?? '', contactName: dealer.contactName ?? '', email: dealer.email ?? '', phone: dealer.phone ?? '', status: dealer.status ?? 'ACTIVE' });
  const { run, busy, error } = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={isNew ? 'New dealer' : `Edit ${dealer.name}`} onClose={onClose}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: f.name, contactName: f.contactName, email: f.email, phone: f.phone };
        if (await run(() => (isNew ? post('/dealers', { ...body, id: f.id }) : patch(`/dealers/${dealer.id}`, { ...body, status: f.status })))) onDone();
      }}>
        <Field label="Dealer id" hint={isNew ? 'Used on orders and commission; cannot be changed later' : undefined}><Input required readOnly={!isNew} value={f.id} onChange={set('id')} autoCapitalize="none" /></Field>
        <Field label="Name"><Input required value={f.name} onChange={set('name')} /></Field>
        <Field label="Contact person"><Input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
        <div className="sm:col-span-2"><Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field></div>
        {!isNew && (
          <label className="flex min-h-tap items-center gap-3 sm:col-span-2"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={f.status === 'ACTIVE'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'ACTIVE' : 'INACTIVE' })} />Active: can be chosen on new orders</label>
        )}
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex gap-3 sm:col-span-2"><Button type="submit" disabled={busy}>{isNew ? 'Create dealer' : 'Save'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

function Agents({ dealer, manage, onClose }: { dealer: any; manage: boolean; onClose: () => void }) {
  const list = usePaged<any>(`/dealers/${encodeURIComponent(dealer.id)}/agents?limit=50`);
  const [f, setF] = useState({ name: '', phone: '', email: '' });
  const act = useAction(list.reload);
  return (
    <Modal title={`${dealer.name} · agents`} onClose={onClose} wide>
      {list.error && <Alert>{list.error}</Alert>}{list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>No agents yet.{manage ? ' Add the first one below.' : ''}</Empty>}
      {list.items.length > 0 && (
        <>
          <TableWrap><thead><tr><Th>Agent id</Th><Th>Name</Th><Th>Contact</Th><Th>Status</Th>{manage && <Th><span className="sr-only">Actions</span></Th>}</tr></thead><tbody>
            {list.items.map((a: any) => (
              <tr key={a.id}>
                <Td className="font-mono">{a.id}</Td><Td>{a.name}</Td>
                <Td className="text-footnote text-label2">{[a.phone, a.email].filter(Boolean).join(' · ') || '—'}</Td>
                <Td><Badge tone={a.status === 'ACTIVE' ? 'success' : 'neutral'}>{a.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge></Td>
                {manage && <Td right><button className="min-h-tap px-2 text-accent" onClick={() => void act.run(() => patch(`/dealer-agents/${a.id}`, { status: a.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}>{a.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}</button></Td>}
              </tr>
            ))}
          </tbody></TableWrap>
          <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="agents" />
        </>
      )}
      {manage && dealer.status === 'ACTIVE' && (
        <Card className="mt-4"><form className="grid gap-3 sm:grid-cols-4 sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => post(`/dealers/${dealer.id}/agents`, f))) setF({ name: '', phone: '', email: '' }); }}>
          <Field label="Agent name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Button type="submit" disabled={act.busy}>Add agent</Button>
        </form></Card>
      )}
      {act.error && <div className="mt-3"><Alert>{act.error}</Alert></div>}
    </Modal>
  );
}
