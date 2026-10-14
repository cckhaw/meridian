'use client';
import { FULFILMENT_MECHANICS, OFFER_TEMPLATES, TEMPLATES } from '@meridian/types';
import { Alert, Badge, Button, Card, DataList, Field, Input, Modal, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';

/** Settings → Catalog → Offer types: the list of types the offer wizard offers. What a type does comes from the behaviour it is based on. */
export function OfferTypeSettings() {
  const { data, error, reload } = useApi<any>('/settings/catalog');
  const [editing, setEditing] = useState<any>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <Card>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-subhead text-label2">An offer type says what kind of thing an offer is. It decides what the offer wizard asks for and what happens when it is sold: whether a service is created, whether something ships, whether a contract is offered. Add your own types, rename them, or switch off the ones you do not use.</p>
        <Button className="shrink-0 self-start whitespace-nowrap" onClick={() => setEditing({})}>New offer type</Button>
      </div>
      <DataList label="Offer types" rows={data.types} rowKey={(t: any) => t.id}
        columns={[
          { key: 'type', label: 'Type', primary: true, render: (t: any) => <><span className="font-medium">{t.name}</span>{t.description && <span className="block text-footnote text-label2">{t.description}</span>}<span className="block font-mono text-caption text-label2">{t.id}</span></> },
          { key: 'like', label: 'Behaves like', render: (t: any) => <span className="text-footnote text-label2 md:text-label2">{TEMPLATES[t.template as keyof typeof TEMPLATES]?.label ?? t.template}</span> },
          { key: 'offers', label: 'Offers', right: true, render: (t: any) => t.offers },
          { key: 'status', label: 'Status', render: (t: any) => <Badge tone={t.status === 'ACTIVE' ? 'success' : 'neutral'}>{t.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
        ]}
        actions={(t: any) => <Button variant="secondary" onClick={() => setEditing(t)}>Edit</Button>} />
      <p className="mt-3 text-footnote text-label2">Switching a type off stops it being chosen for new offers; offers already using it keep working.</p>
      {editing && <TypeForm item={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload(); }} />}
    </Card>
  );
}

function TypeForm({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const isNew = !item.id;
  const [f, setF] = useState({ name: item.name ?? '', description: item.description ?? '', template: item.template ?? 'SIM_ONLY', active: (item.status ?? 'ACTIVE') === 'ACTIVE' });
  const { run, busy, error } = useAction();
  const tpl = TEMPLATES[f.template as keyof typeof TEMPLATES];
  return (
    <Modal title={isNew ? 'New offer type' : `Edit ${item.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => (isNew ? post('/settings/offer-types', { name: f.name, description: f.description, template: f.template }) : patch(`/settings/offer-types/${item.id}`, { name: f.name, description: f.description, status: f.active ? 'ACTIVE' : 'INACTIVE' })))) onDone();
      }}>
        <Field label="Name"><Input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description" hint="Shown to staff when they choose a type."><Input maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Behaves like" hint={isNew ? 'Decides how it is sold, fulfilled and billed. Cannot be changed later.' : 'Fixed once created.'}>
          <Select value={f.template} disabled={!isNew} onChange={(e) => setF({ ...f, template: e.target.value })}>{OFFER_TEMPLATES.map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}</Select>
        </Field>
        {tpl && <p className="rounded-control bg-surface2 p-3 text-footnote text-label2">{tpl.summary}</p>}
        {!isNew && <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active: can be chosen for new offers</label>}
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>{isNew ? 'Create type' : 'Save'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && !item.isBuiltin && <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={async () => { if (window.confirm(`Remove ${item.name}? This only works if no offer uses it.`) && (await run(() => del(`/settings/offer-types/${item.id}`)))) onDone(); }}>Remove</Button>}
        </div>
      </form>
    </Modal>
  );
}

/** Settings → Catalog → Fulfilment options: the ways an offer can be delivered, including collect in store. */
export function FulfilmentSettings() {
  const { data, error, reload } = useApi<any>('/settings/catalog');
  const [editing, setEditing] = useState<any>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const how = (m: string) => FULFILMENT_MECHANICS.find((x) => x.id === m);
  return (
    <Card>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-subhead text-label2">Fulfilment options are what you tick on an offer to say how it reaches the customer. Each one works like a delivery, a collection in store, an installation or a SIM activation, which decides when an order can still be cancelled. Turn on <strong>track stock</strong> for an option if the offers using it reserve stock (for SIM-only plans, turn it on for SIM activation only if you count SIM cards in inventory).</p>
        <Button className="shrink-0 self-start whitespace-nowrap" onClick={() => setEditing({})}>New option</Button>
      </div>
      <DataList label="Fulfilment options" rows={data.options} rowKey={(o: any) => o.id}
        columns={[
          { key: 'option', label: 'Option', primary: true, render: (o: any) => <><span className="font-medium">{o.name}</span>{o.description && <span className="block text-footnote text-label2">{o.description}</span>}<span className="block font-mono text-caption text-label2">{o.id}</span></> },
          { key: 'works', label: 'Works like', render: (o: any) => <span className="text-footnote text-label2">{how(o.mechanic)?.label ?? o.mechanic}</span> },
          { key: 'stock', label: 'Stock', render: (o: any) => <span className="text-footnote text-label2">{o.tracksStock ? 'Tracked' : 'Not tracked'}</span> },
          { key: 'offers', label: 'Offers', right: true, render: (o: any) => o.offers },
          { key: 'status', label: 'Status', render: (o: any) => <Badge tone={o.status === 'ACTIVE' ? 'success' : 'neutral'}>{o.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
        ]}
        actions={(o: any) => <Button variant="secondary" onClick={() => setEditing(o)}>Edit</Button>} />
      {editing && <OptionForm item={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload(); }} />}
    </Card>
  );
}

function OptionForm({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const isNew = !item.id;
  const [f, setF] = useState({ name: item.name ?? '', description: item.description ?? '', mechanic: item.mechanic ?? 'SHIP', tracksStock: !!item.tracksStock, active: (item.status ?? 'ACTIVE') === 'ACTIVE' });
  const { run, busy, error } = useAction();
  const how = FULFILMENT_MECHANICS.find((m) => m.id === f.mechanic);
  return (
    <Modal title={isNew ? 'New fulfilment option' : `Edit ${item.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => (isNew ? post('/settings/fulfilment-options', { name: f.name, description: f.description, mechanic: f.mechanic, tracksStock: f.tracksStock })
          : patch(`/settings/fulfilment-options/${item.id}`, { name: f.name, description: f.description, tracksStock: f.tracksStock, status: f.active ? 'ACTIVE' : 'INACTIVE' })))) onDone();
      }}>
        <Field label="Name"><Input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Input maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Works like" hint={isNew ? 'Decides when an order can still be cancelled. Cannot be changed later.' : 'Fixed once created.'}>
          <Select value={f.mechanic} disabled={!isNew} onChange={(e) => setF({ ...f, mechanic: e.target.value })}>{FULFILMENT_MECHANICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select>
        </Field>
        {how && <p className="rounded-control bg-surface2 p-3 text-footnote text-label2">{how.summary}</p>}
        <label className="flex min-h-tap items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.tracksStock} onChange={(e) => setF({ ...f, tracksStock: e.target.checked })} />
          <span>Track stock<span className="block text-footnote text-label2">Offers using this option list the stock SKUs reserved when they are sold.</span></span></label>
        {!isNew && <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active: can be chosen for new offers</label>}
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>{isNew ? 'Create option' : 'Save'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && !item.isBuiltin && <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={async () => { if (window.confirm(`Remove ${item.name}? This only works if no offer uses it.`) && (await run(() => del(`/settings/fulfilment-options/${item.id}`)))) onDone(); }}>Remove</Button>}
        </div>
      </form>
    </Modal>
  );
}
