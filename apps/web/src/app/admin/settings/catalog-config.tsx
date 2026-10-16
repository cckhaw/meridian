'use client';
import { FULFILMENT_MECHANICS, OFFER_TEMPLATES, ORDER_STEP_LABEL, ORDER_STEPS, TEMPLATES, describeSwitches, switchProblems, switchesOf, type BehaviourSwitches, type OrderStep } from '@meridian/types';
import { Alert, Badge, Button, Card, DataList, Field, Input, Modal, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi } from '@/lib/api';

/** Settings → Catalog → Offer types: the list of types the offer wizard offers. What a type does comes from the behaviour it is based on. */
const kindName = (data: any) => (id: string) => (data?.serviceKinds ?? []).find((k: any) => k.id === id)?.name?.toLowerCase() ?? id.toLowerCase();

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
          { key: 'like', label: 'What it does', render: (t: any) => <span className="text-footnote text-label2">{describeSwitches(t.effective, kindName(data))}</span> },
          { key: 'offers', label: 'Offers', right: true, render: (t: any) => t.offers },
          { key: 'status', label: 'Status', render: (t: any) => <Badge tone={t.status === 'ACTIVE' ? 'success' : 'neutral'}>{t.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
        ]}
        actions={(t: any) => <Button variant="secondary" onClick={() => setEditing(t)}>Edit</Button>} />
      <p className="mt-3 text-footnote text-label2">Switching a type off stops it being chosen for new offers; offers already using it keep working.</p>
      {editing && <TypeForm item={editing} kinds={data.serviceKinds} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload(); }} />}
      <Combinations types={data.types} />
    </Card>
  );
}

/** Which offer types cannot be sold in the same order. A rule works both ways; the order screen greys the second offer out, and orders are refused whichever channel they come from. */
function Combinations({ types }: { types: any[] }) {
  const rules = useApi<{ pairs: Array<[string, string]> }>('/settings/offer-type-conflicts');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const act = useAction(async () => { await rules.reload(); });
  const name = (id: string) => types.find((t) => t.id === id)?.name ?? id;
  const save = (pairs: Array<[string, string]>) => act.run(() => post('/settings/offer-type-conflicts', { pairs }), 'Saved');
  if (rules.error) return <Alert>{rules.error}</Alert>;
  if (!rules.data) return <Spinner />;
  const pairs = rules.data.pairs;
  const dup = !!a && !!b && pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  return (
    <div className="mt-6 border-t border-separator pt-4">
      <h3 className="text-title3 font-semibold">Combinations</h3>
      <p className="mb-3 text-subhead text-label2">Offer types that cannot be sold in the same order. A rule works both ways: with “Fibre” and “SIM only” listed, choosing one greys out the other, and an order with both is refused in every channel. Types not listed here can be combined freely.</p>
      {pairs.length === 0 && <p className="mb-3 text-subhead text-label2">No rules: every type can be ordered with every other.</p>}
      <ul className="mb-3 space-y-2">{pairs.map(([x, y]) => (
        <li key={`${x}|${y}`} className="flex flex-wrap items-center gap-2 rounded-control bg-surface2 px-3 py-2 text-subhead"><span className="font-medium">{name(x)}</span><span className="text-label2">cannot be ordered with</span><span className="font-medium">{name(y)}</span>
          <Button variant="plain" className="ml-auto" disabled={act.busy} onClick={() => void save(pairs.filter(([p, q]) => !(p === x && q === y)))}>Remove</Button></li>))}</ul>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Offer type"><Select value={a} onChange={(e) => setA(e.target.value)}><option value="">Choose…</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <span className="pb-3 text-subhead text-label2">cannot be ordered with</span>
        <Field label="Offer type"><Select value={b} onChange={(e) => setB(e.target.value)}><option value="">Choose…</option>{types.filter((t) => t.id !== a).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Button disabled={act.busy || !a || !b || a === b || dup} onClick={async () => { if (await save([...pairs, [a, b]])) { setA(''); setB(''); } }}>Add rule</Button>
      </div>
      {act.error && <div className="mt-2"><Alert>{act.error}</Alert></div>}{act.ok && <div className="mt-2"><Alert tone="success">{act.ok}</Alert></div>}
    </div>
  );
}

function TypeForm({ item, kinds, onClose, onDone }: { item: any; kinds: any[]; onClose: () => void; onDone: () => void }) {
  const isNew = !item.id;
  const [f, setF] = useState({ name: item.name ?? '', description: item.description ?? '', template: item.template ?? 'SIM_ONLY', active: (item.status ?? 'ACTIVE') === 'ACTIVE' });
  const [sw, setSw] = useState<BehaviourSwitches>(item.effective ?? switchesOf(TEMPLATES[(item.template ?? 'SIM_ONLY') as keyof typeof TEMPLATES]));
  const { run, busy, error } = useAction();
  const inUse = !isNew && (item.offers ?? 0) > 0;
  const fixed = !isNew && item.isBuiltin;               // the built-in types keep their behaviour
  const lockedCore = fixed || inUse;                    // what an order creates cannot change under existing offers
  const problems = switchProblems(sw);
  const set = (p: Partial<BehaviourSwitches>) => setSw((x) => ({ ...x, ...p }));
  const step = (id: OrderStep, on: boolean) => set({ steps: ORDER_STEPS.filter((s) => (s === id ? on : sw.steps.includes(s))) });
  const kindOptions = kinds.filter((k) => k.status === 'ACTIVE' || k.id === sw.service);
  return (
    <Modal title={isNew ? 'New offer type' : `Edit ${item.name}`} wide onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        const behaviour = isNew ? sw : fixed ? undefined : sw;
        if (await run(() => (isNew ? post('/settings/offer-types', { name: f.name, description: f.description, template: f.template, behaviour }) : patch(`/settings/offer-types/${item.id}`, { name: f.name, description: f.description, status: f.active ? 'ACTIVE' : 'INACTIVE', ...(behaviour ? { behaviour } : {}) })))) onDone();
      }}>
        <Field label="Name"><Input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description" hint="Shown to staff when they choose a type."><Input maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {isNew && (
          <Field label="Start from" hint="Fills in the switches below with a built-in type's. Change any of them.">
            <Select value={f.template} onChange={(e) => { setF({ ...f, template: e.target.value }); setSw(switchesOf(TEMPLATES[e.target.value as keyof typeof TEMPLATES])); }}>{OFFER_TEMPLATES.map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}</Select>
          </Field>
        )}

        <fieldset className="space-y-3 rounded-card border border-separator p-4">
          <legend className="px-1 text-subhead font-semibold">What happens when it is sold</legend>
          {fixed && <p className="text-footnote text-label2">A built-in type keeps its behaviour. To change it, add a new type starting from this one.</p>}
          {inUse && !fixed && <p className="text-footnote text-label2">{item.offers} offer{item.offers === 1 ? ' uses' : 's use'} this type, so only where it is picked and “one per order” can change. Add a new type for different behaviour.</p>}
          <Field label="Service it creates" hint="The order starts a service of this type. Types you define yourself are under Service types.">
            <Select disabled={lockedCore} value={sw.service ?? ''} onChange={(e) => set({ service: e.target.value || null, ...(e.target.value ? {} : { serviceNeedsFee: false, needsInstallation: false }) })}>
              <option value="">None: nothing is created, it is a one-off sale</option>
              {kindOptions.map((k) => <option key={k.id} value={k.id}>{k.name}{k.isBuiltin ? '' : ' (yours)'}</option>)}
            </Select>
          </Field>
          <Switch disabled={lockedCore || !sw.service} checked={sw.serviceNeedsFee ?? false} onChange={(v) => set({ serviceNeedsFee: v })} label="Only creates the service if the offer has a monthly fee" hint="A watch with no plan is just goods." />
          <Switch disabled={lockedCore} checked={sw.goods} onChange={(v) => set({ goods: v })} label="Includes a physical item" hint="It ships or is collected, and can have colours and storage." />
          <Switch disabled={lockedCore} checked={!!sw.outright} onChange={(v) => set(v ? { outright: true, goods: true, service: null, serviceNeedsFee: false, needsInstallation: false, contract: 'none' } : { outright: false })} label="Sold outright" hint="No service and no contract; can be rung up as a quick sale." />
          <Field label="Contract"><Select disabled={lockedCore || !!sw.outright} value={sw.contract} onChange={(e) => set({ contract: e.target.value as 'none' | 'optional' })}><option value="optional">A contract term can be offered</option><option value="none">Never on a contract</option></Select></Field>
          <Switch disabled={lockedCore || !sw.service} checked={!!sw.needsInstallation} onChange={(v) => set({ needsInstallation: v })} label="Needs an installation visit" />
          <Switch disabled={lockedCore} checked={!!sw.needsPartner} onChange={(v) => set({ needsPartner: v })} label="Needs the partner’s code" hint="For services provided by another company, for example streaming." />
        </fieldset>

        <fieldset className="space-y-2 rounded-card border border-separator p-4">
          <legend className="px-1 text-subhead font-semibold">Where it is picked in the order</legend>
          {ORDER_STEPS.map((id) => <Switch key={id} disabled={fixed} checked={sw.steps.includes(id)} onChange={(v) => step(id, v)} label={ORDER_STEP_LABEL[id]} />)}
          <Switch disabled={fixed || !sw.steps.includes('PLAN')} checked={!!sw.exclusive} onChange={(v) => set({ exclusive: v })} label="Only one per order" hint="For a main plan: other lines join it as members or are added as add-ons." />
        </fieldset>

        <p className="rounded-control bg-surface2 p-3 text-footnote text-label2" aria-live="polite">{describeSwitches(sw, kindName({ serviceKinds: kinds }))}</p>
        {!fixed && problems.length > 0 && <Alert>{problems.join(' ')}</Alert>}
        {!isNew && <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active: can be chosen for new offers</label>}
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy || (!fixed && problems.length > 0)}>{isNew ? 'Create type' : 'Save'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && !item.isBuiltin && <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={async () => { if (window.confirm(`Remove ${item.name}? This only works if no offer uses it.`) && (await run(() => del(`/settings/offer-types/${item.id}`)))) onDone(); }}>Remove</Button>}
        </div>
      </form>
    </Modal>
  );
}

function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`flex min-h-tap items-start gap-3 ${disabled ? 'opacity-60' : ''}`}>
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium">{label}</span>{hint && <span className="block text-footnote text-label2">{hint}</span>}</span>
    </label>
  );
}

/** Settings → Catalog → Service types: the kinds of service an order starts (mobile, fibre, IoT, subscription, and your own), and how the network and the charging system hear about them. */
export function ServiceKindSettings() {
  const { data, error, reload } = useApi<any>('/settings/catalog');
  const [editing, setEditing] = useState<any>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <Card>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-subhead text-label2">A service type is what an order starts for a customer. Mobile, Fibre, IoT and Subscription come with the platform; define your own for a pass, a voucher or a top-up. For each type you set what the network is told when its services start and end, and whether its services are provisioned into the charging system. Then choose a type as the <strong>service it creates</strong> in an offer type (Offer types). Billing follows the offer’s prices, as for any subscription.</p>
        <Button className="shrink-0 self-start whitespace-nowrap" onClick={() => setEditing({})}>New service type</Button>
      </div>
      <DataList label="Service types" rows={data.serviceKinds} rowKey={(k: any) => k.id}
        columns={[
          { key: 'kind', label: 'Service type', primary: true, render: (k: any) => <><span className="font-medium">{k.name}</span>{k.description && <span className="block text-footnote text-label2">{k.description}</span>}<span className="block font-mono text-caption text-label2">{k.id}{k.isBuiltin ? ' · built in' : ''}</span></> },
          { key: 'ends', label: 'Ends', render: (k: any) => (k.isBuiltin ? 'When cancelled' : k.expires ? `After ${k.validityDays} days` : 'When cancelled') },
          { key: 'sys', label: 'Tells the network', render: (k: any) => <span className="text-footnote text-label2">{(k.announceStart ? `Start ${k.provisionInstruction}, ` : '') + `end ${k.deprovisionInstruction}`}<span className="block">{k.provisionSystems.length ? k.provisionSystems.join(', ') : k.isBuiltin ? 'HLR, HSS, PCRF (default)' : 'No systems named'}</span></span> },
          { key: 'ocs', label: 'Charging system', render: (k: any) => <Badge tone={k.ocsEnabled ? 'success' : 'neutral'}>{k.ocsEnabled ? 'Provisioned' : 'Not sent'}</Badge> },
          { key: 'use', label: 'In use', right: true, render: (k: any) => (k.isBuiltin ? '—' : `${k.offerTypes} type${k.offerTypes === 1 ? '' : 's'}, ${k.services} service${k.services === 1 ? '' : 's'}`) },
          { key: 'status', label: 'Status', render: (k: any) => <Badge tone={k.status === 'ACTIVE' ? 'success' : 'neutral'}>{k.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
        ]}
        actions={(k: any) => <Button variant="secondary" onClick={() => setEditing(k)}>Edit</Button>} />
      {editing && <KindForm item={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload(); }} />}
    </Card>
  );
}

function KindForm({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const isNew = !item.id;
  const builtin = !!item.isBuiltin;
  const [f, setF] = useState({ name: item.name ?? '', description: item.description ?? '', prefix: item.identifierPrefix ?? 'SVC', expires: !!item.expires, days: item.validityDays ? String(item.validityDays) : '7', systems: (item.provisionSystems ?? []).join(', '), start: item.provisionInstruction ?? 'PROVISION', end: item.deprovisionInstruction ?? 'DEPROVISION', announce: item.announceStart ?? true, ocs: item.ocsEnabled ?? true, active: (item.status ?? 'ACTIVE') === 'ACTIVE' });
  const { run, busy, error } = useAction();
  return (
    <Modal title={isNew ? 'New service type' : `Edit ${item.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        const common = { name: f.name, description: f.description, provisionSystems: f.systems.split(',').map((x: string) => x.trim()).filter(Boolean), provisionInstruction: f.start, deprovisionInstruction: f.end, announceStart: f.announce, ocsEnabled: f.ocs };
        const body = builtin ? common : { ...common, identifierPrefix: f.prefix, expires: f.expires, validityDays: f.expires ? Number(f.days) : null, ...(isNew ? {} : { status: f.active ? 'ACTIVE' : 'INACTIVE' }) };
        if (await run(() => (isNew ? post('/settings/service-kinds', body) : patch(`/settings/service-kinds/${item.id}`, body)))) onDone();
      }}>
        {builtin && <Alert tone="info">{item.name} comes with the platform. You can rename it and change how the network and charging system are told about it. Its identifiers ({item.id === 'MOBILE' ? 'the number comes from your number pool' : `start with ${item.identifierPrefix}`}) and its life cycle are fixed, and it cannot be switched off or removed.</Alert>}
        <Field label="Name"><Input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description"><Input maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {!builtin && <Field label="Identifier starts with" hint="Each service gets an identifier made of this and a running number, for example RP-10432."><Input className="font-mono" maxLength={10} value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.toUpperCase() })} /></Field>}
        {!builtin && <Switch checked={f.expires} onChange={(v) => setF({ ...f, expires: v })} label="Ends by itself" hint="The daily job ends the service when its time is up. An offer can set its own length; this is the default." />}
        {!builtin && f.expires && <Field label="Default length (days)"><Input type="number" min={1} max={3650} required value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></Field>}
        <fieldset className="space-y-3 rounded-control border border-separator p-3">
          <legend className="px-1 text-subhead font-medium">Network provisioning</legend>
          <Switch checked={f.announce} onChange={(v) => setF({ ...f, announce: v })} label="Tell the network when a service starts" hint={builtin ? 'Off until you turn it on: today only the end, bar and plan-change instructions are sent for this type.' : 'Queues the start instruction for your integration.'} />
          <Field label="Systems to tell" hint={`Names of the systems that act on the instructions, separated by commas, for example PCRF, VOUCHER_PLATFORM. They are in the message sent to your integration.${builtin ? ' Left empty, the end instruction goes to HLR, HSS and PCRF.' : ''}`}><Input className="font-mono" value={f.systems} onChange={(e) => setF({ ...f, systems: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Instruction when it starts"><Input className="font-mono" maxLength={32} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value.toUpperCase() })} /></Field>
            <Field label="Instruction when it ends"><Input className="font-mono" maxLength={32} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value.toUpperCase() })} /></Field>
          </div>
        </fieldset>
        <Switch checked={f.ocs} onChange={(v) => setF({ ...f, ocs: v })} label="Provision into the charging system (OCS)" hint="Plans of this type that have an OCS plan code are created in the OCS, changed, barred and closed there. Off: they are never sent." />
        {!isNew && !builtin && <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active: can be chosen for offer types</label>}
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>{isNew ? 'Create service type' : 'Save'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {!isNew && !builtin && <Button type="button" variant="destructive" className="sm:ml-auto" disabled={busy} onClick={async () => { if (window.confirm(`Remove ${item.name}? This only works if nothing uses it.`) && (await run(() => del(`/settings/service-kinds/${item.id}`)))) onDone(); }}>Remove</Button>}
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
