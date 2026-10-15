'use client';
import { Alert, Badge, Button, Card, DataList, Field, Input, Modal, SectionTitle, Select, Spinner } from '@meridian/ui';
import { useState } from 'react';
import { patch, post, useAction, useApi } from '@/lib/api';

const FIELD_LABELS = { email: 'E-mail', phone: 'Phone', dateOfBirth: 'Date of birth', gender: 'Gender', address: 'Address', postcode: 'Postcode', city: 'City', state: 'State or region', country: 'Country' } as const;

/** Settings → Customers: whether a customer can be created on their own, and the segments customers are sorted into. */
export function CustomerSettings() {
  const { data, error, reload } = useApi<any>('/settings/customers');
  const toggle = useAction(reload);
  const [pending, setPending] = useState<boolean | null>(null); // shown at once, before the server confirms
  const [editing, setEditing] = useState<any>(null); // a segment, or {} for a new one
  const fieldAction = useAction(reload);
  const [fieldsPending, setFieldsPending] = useState<Record<string, string>>({});
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const allow: boolean = pending ?? data.settings.allowCreateWithoutOrder;
  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle>Creating customers</SectionTitle>
        <label className="flex min-h-tap items-start gap-3">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={allow} disabled={toggle.busy}
            onChange={async (e) => { const v = e.target.checked; setPending(v); await toggle.run(() => post('/settings/customers', { allowCreateWithoutOrder: v })); setPending(null); }} />
          <span>
            <span className="block font-medium">Allow creating a customer from the Customers page</span>
            <span className="block text-subhead text-label2">
              {allow ? 'Staff with permission can add a customer on its own, without an order.' : 'Off: a customer is created while placing their first order, so nobody exists without one. The “New customer” button is hidden on the Customers page.'}
            </span>
          </span>
        </label>
        {toggle.error && <div className="mt-3"><Alert>{toggle.error}</Alert></div>}
      </Card>

      <Card>
        <SectionTitle>Details on the customer form</SectionTitle>
        <p className="-mt-2 mb-3 text-subhead text-label2">Name, ID document, segment and bill cycle are always asked. For each detail below choose whether the new-customer form shows it, and whether it must be filled in. A hidden detail is not asked and is not stored.</p>
        <ul className="divide-y divide-separator">
          {(Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>).map((k) => (
            <li key={k} className="flex min-h-[52px] items-center justify-between gap-3 py-1.5">
              <span className="font-medium">{FIELD_LABELS[k]}</span>
              <Select aria-label={`${FIELD_LABELS[k]} on the customer form`} className="max-w-[170px]" value={fieldsPending[k] ?? data.settings.fields[k]} disabled={fieldAction.busy}
                onChange={async (e) => { const v = e.target.value; setFieldsPending((p) => ({ ...p, [k]: v })); await fieldAction.run(() => post('/settings/customers', { allowCreateWithoutOrder: data.settings.allowCreateWithoutOrder, fields: { [k]: v } })); setFieldsPending((p) => { const n = { ...p }; delete n[k]; return n; }); }}>
                <option value="hidden">Hidden</option><option value="optional">Optional</option><option value="required">Required</option>
              </Select>
            </li>
          ))}
        </ul>
        {fieldAction.error && <div className="mt-3"><Alert>{fieldAction.error}</Alert></div>}
      </Card>

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><SectionTitle>Customer segments</SectionTitle>
            <p className="-mt-2 mb-3 text-subhead text-label2">Every customer belongs to one segment. A customer is a person or a company; beneath them sit accounts, and beneath each account its services. Switch a segment off to stop using it without losing the customers already in it.</p></div>
          <Button className="shrink-0 self-start whitespace-nowrap" onClick={() => setEditing({})}>New segment</Button>
        </div>
        <DataList label="Customer segments" rows={data.segments} rowKey={(s: any) => s.id}
          columns={[
            { key: 'segment', label: 'Segment', primary: true, render: (s: any) => <><span className="font-medium">{s.name}</span>{s.description && <span className="block text-footnote text-label2">{s.description}</span>}<span className="block font-mono text-caption text-label2">{s.id}</span></> },
            { key: 'are', label: 'Customers are', render: (s: any) => <span className="text-footnote text-label2">{s.individual ? 'Individuals: one customer per ID document' : 'Companies or fleets: an ID document may be shared'}</span> },
            { key: 'customers', label: 'Customers', right: true, render: (s: any) => (s.customersCapped ? `${s.customers.toLocaleString()}+` : (s.customers ?? 0).toLocaleString()) },
            { key: 'status', label: 'Status', render: (s: any) => <Badge tone={s.status === 'ACTIVE' ? 'success' : 'neutral'}>{s.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
          ]}
          actions={(s: any) => <Button variant="secondary" onClick={() => setEditing(s)}>Edit</Button>} />
        <p className="mt-3 text-footnote text-label2">To move one customer to another segment, open the customer and choose “Change segment”. The move, who made it and why are recorded.</p>
      </Card>
      {editing && <SegmentForm segment={editing} used={(editing.customers ?? 0) > 0} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload(); }} />}
    </div>
  );
}

function SegmentForm({ segment, used, onClose, onDone }: { segment: any; used: boolean; onClose: () => void; onDone: () => void }) {
  const isNew = !segment.id;
  const [f, setF] = useState({ name: segment.name ?? '', description: segment.description ?? '', individual: !!segment.individual, active: (segment.status ?? 'ACTIVE') === 'ACTIVE' });
  const { run, busy, error } = useAction();
  return (
    <Modal title={isNew ? 'New segment' : `Edit ${segment.name}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: f.name, description: f.description, individual: f.individual };
        if (await run(() => (isNew ? post('/settings/segments', body) : patch(`/settings/segments/${segment.id}`, { ...body, status: f.active ? 'ACTIVE' : 'INACTIVE' })))) onDone();
      }}>
        <Field label="Name"><Input required maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description" hint="Shown to staff when they choose a segment."><Input maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <label className="flex min-h-tap items-start gap-3">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.individual} disabled={!isNew && used} onChange={(e) => setF({ ...f, individual: e.target.checked })} />
          <span><span className="block">Customers are individuals</span><span className="block text-footnote text-label2">{!isNew && used ? 'Fixed, because customers already belong to this segment.' : 'One customer per ID document: the same person cannot be added twice.'}</span></span>
        </label>
        {!isNew && (
          <label className="flex min-h-tap items-center gap-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active: can be chosen for new customers and moves</label>
        )}
        {isNew && <p className="text-footnote text-label2">A short code is issued from the name and never changes.</p>}
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-3"><Button type="submit" disabled={busy}>{isNew ? 'Create segment' : 'Save'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button></div>
      </form>
    </Modal>
  );
}

/** Settings → Bill cycles: which cycles a customer's account can be given, and the one a new account starts with. */
export function BillCycleSettings() {
  const { data, error, reload } = useApi<{ days: number[]; defaultCycle: number; defaultMode: 'FIXED' | 'NEXT' | 'PREVIOUS' }>('/settings/bill-cycles');
  const [days, setDays] = useState<number[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [dflt, setDflt] = useState<string | null>(null);
  const save = useAction(reload);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const on = days ?? data.days, m = (mode ?? data.defaultMode) as 'FIXED' | 'NEXT' | 'PREVIOUS', def = dflt ?? String(data.defaultCycle);
  const toggle = (d: number) => setDays(on.includes(d) ? on.filter((x) => x !== d) : [...on, d].sort((a, b) => a - b));
  const dirty = days !== null || mode !== null || dflt !== null;
  const ok = on.length > 0 && (m !== 'FIXED' || on.includes(Number(def)));
  return (
    <Card>
      <SectionTitle>Bill cycles</SectionTitle>
      <p className="-mt-2 mb-4 text-subhead text-label2">A bill cycle is the day of the month an account is billed. Switch on the days you use: those are the cycles offered when a customer or account is created. Accounts that already have a cycle keep it.</p>
      <fieldset>
        <legend className="mb-2 text-subhead font-medium">Monthly, on day</legend>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
            <label key={d} className={`flex min-h-tap cursor-pointer items-center justify-center gap-2 rounded-control border px-2 text-subhead ${on.includes(d) ? 'border-accent bg-accent/10 font-medium text-accent' : 'border-separator bg-surface text-label2'}`}>
              <input type="checkbox" className="sr-only" checked={on.includes(d)} onChange={() => toggle(d)} />{d}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 max-w-md space-y-3">
        <Field label="Default for a new billing account" hint="Used when nobody chooses a cycle.">
          <Select value={m} onChange={(e) => setMode(e.target.value)}>
            <option value="FIXED">A chosen day</option>
            <option value="NEXT">Next bill cycle date (after the account is created)</option>
            <option value="PREVIOUS">Previous bill cycle date (before the account is created)</option>
          </Select>
        </Field>
        {m === 'FIXED' && <Field label="Day"><Select value={on.includes(Number(def)) ? def : ''} onChange={(e) => setDflt(e.target.value)}><option value="" disabled>Choose…</option>{on.map((d) => <option key={d} value={d}>Day {d}</option>)}</Select></Field>}
        {m !== 'FIXED' && <p className="text-footnote text-label2">Looks at the day of the month the billing account is created and picks, from the days switched on above, the {m === 'NEXT' ? 'next one after it' : 'previous one before it'}, going round the month when there is none. For example, with days 1, 15 and 25 on, an account created on the 10th gets day {m === 'NEXT' ? '15' : '1'}.</p>}
      </div>
      {save.error && <div className="mt-3"><Alert>{save.error}</Alert></div>}{save.ok && !dirty && <div className="mt-3"><Alert tone="success">{save.ok}</Alert></div>}
      <div className="mt-4"><Button disabled={!dirty || save.busy || !ok} onClick={async () => { const r = await save.run(() => post('/settings/bill-cycles', { days: on, defaultMode: m, defaultCycle: on.includes(Number(def)) ? Number(def) : on[0] }), 'Saved'); if (r) { setDays(null); setMode(null); setDflt(null); } }}>{save.busy ? 'Saving…' : 'Save bill cycles'}</Button></div>
    </Card>
  );
}
