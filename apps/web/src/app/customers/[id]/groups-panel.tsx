'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LoadMore, Modal, Select, Spinner, TableWrap, Td, Th } from '@meridian/ui';
import { useState } from 'react';
import { del, patch, post, useAction, useApi, usePaged } from '@/lib/api';
import { label, tone } from '@/lib/format';

interface Benefits { allowances?: { dataGb?: number; voiceMinutes?: number; smsCount?: number }; discountBps?: number }

/** "100 GB data · 2,000 min · 500 SMS shared · 10% off supplementary lines" */
export function benefitsText(b: Benefits | undefined): string {
  const a = b?.allowances ?? {};
  const parts = [a.dataGb !== undefined && `${a.dataGb.toLocaleString()} GB data`, a.voiceMinutes !== undefined && `${a.voiceMinutes.toLocaleString()} min`, a.smsCount !== undefined && `${a.smsCount.toLocaleString()} SMS`].filter(Boolean);
  return [parts.length ? `${parts.join(' · ')} shared` : '', b?.discountBps ? `${b.discountBps / 100}% off supplementary lines` : ''].filter(Boolean).join(' · ') || 'No shared benefits yet';
}

const num = (v: string) => (v.trim() === '' ? null : Number(v));
const toBody = (f: { dataGb: string; voiceMinutes: string; smsCount: string; discount: string }) => ({
  allowances: { dataGb: num(f.dataGb), voiceMinutes: num(f.voiceMinutes), smsCount: num(f.smsCount) },
  discountBps: f.discount.trim() === '' ? null : Math.round(Number(f.discount) * 100),
});
const initial = (b?: Benefits) => ({ dataGb: b?.allowances?.dataGb?.toString() ?? '', voiceMinutes: b?.allowances?.voiceMinutes?.toString() ?? '', smsCount: b?.allowances?.smsCount?.toString() ?? '', discount: b?.discountBps ? String(b.discountBps / 100) : '' });

function BenefitsFields({ f, setF }: { f: ReturnType<typeof initial>; setF: (v: ReturnType<typeof initial>) => void }) {
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <fieldset className="rounded-control bg-surface2 p-4">
      <legend className="px-1 text-subhead font-medium">Shared by the group</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Data (GB)"><Input type="number" min={0} step="any" inputMode="decimal" value={f.dataGb} onChange={set('dataGb')} placeholder="None" /></Field>
        <Field label="Voice (minutes)"><Input type="number" min={0} step="any" inputMode="decimal" value={f.voiceMinutes} onChange={set('voiceMinutes')} placeholder="None" /></Field>
        <Field label="SMS"><Input type="number" min={0} step="any" inputMode="decimal" value={f.smsCount} onChange={set('smsCount')} placeholder="None" /></Field>
        <Field label="Discount on supplementary lines (%)" hint="Taken off their monthly fee on each bill."><Input type="number" min={0} max={100} step="any" inputMode="decimal" value={f.discount} onChange={set('discount')} placeholder="None" /></Field>
      </div>
      <p className="mt-2 text-footnote text-label2">Shared allowances are recorded on the group; usage is not metered in this release.</p>
    </fieldset>
  );
}

/** The groups on one account. A group is a set of services that share benefits: one Principal, any number of Supplementary, none without the principal. */
export function GroupsPanel({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const list = usePaged<any>(`/accounts/${accountId}/groups?limit=20`);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);
  return (
    <section aria-label="Groups">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <h3 className="text-footnote font-semibold uppercase tracking-wide text-label2">Groups</h3>
        {canManage && <button className="text-subhead text-accent" onClick={() => setCreating(true)}>New group</button>}
      </div>
      {list.error && <Alert>{list.error}</Alert>}
      {list.loading && list.items.length === 0 && <Spinner />}
      {!list.loading && list.items.length === 0 && !list.error && <Empty>No groups on this account. A group lets several services share data, voice and SMS, and earn a discount, around one principal service.</Empty>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {list.items.map((g: any) => (
          <li key={g.id}>
            <button onClick={() => setManaging(g.id)} className="flex w-full items-center gap-3 rounded-card bg-surface p-4 text-left shadow-card transition active:scale-[0.99] hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{g.name}</span>
                <span className="block truncate text-footnote text-label2">{Number(g.memberCount)} service{Number(g.memberCount) === 1 ? '' : 's'} · Principal <span className="font-mono">{g.principalIdentifier}</span></span>
                <span className="block truncate text-footnote text-label2">{benefitsText(g.benefits)}</span>
              </span>
              <span aria-hidden className="text-label2">›</span>
            </button>
          </li>
        ))}
      </ul>
      <LoadMore shown={list.items.length} hasMore={list.hasMore} loading={list.loadingMore} onMore={list.loadMore} noun="groups" />
      {creating && <NewGroup accountId={accountId} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void list.reload(); }} />}
      {managing && <ManageGroup id={managing} accountId={accountId} canManage={canManage} onClose={() => { setManaging(null); void list.reload(); }} />}
    </section>
  );
}

function NewGroup({ accountId, onClose, onDone }: { accountId: string; onClose: () => void; onDone: () => void }) {
  const free = useApi<{ items: any[] }>(`/services?accountId=${accountId}&groupable=1&limit=200`);
  const [name, setName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [sup, setSup] = useState<string[]>([]);
  const [b, setB] = useState(initial());
  const { run, busy, error } = useAction();
  const items = free.data?.items ?? [];
  const toggle = (id: string) => setSup((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <Modal title="New group" onClose={onClose} wide>
      {free.data && items.length === 0 ? <Alert tone="info">Every live service on this account is already in a group, or there are none yet.</Alert> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post(`/accounts/${accountId}/groups`, { name, principalServiceId: principal, supplementaryServiceIds: sup.filter((s) => s !== principal), benefits: toBody(b) }))) onDone(); }}>
          <Field label="Group name"><Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Lim household, Sales team" /></Field>
          <Field label="Principal service" hint="The main service. Supplementary services depend on it."><Select required value={principal} onChange={(e) => setPrincipal(e.target.value)}><option value="">Choose…</option>{items.map((s) => <option key={s.id} value={s.id}>{s.identifier} · {s.offerName}</option>)}</Select></Field>
          <fieldset>
            <legend className="mb-1 text-subhead font-medium">Supplementary services</legend>
            <ul className="max-h-48 divide-y divide-separator overflow-y-auto rounded-control bg-surface2">
              {items.filter((s) => s.id !== principal).map((s) => (
                <li key={s.id}><label className="flex min-h-tap cursor-pointer items-center gap-3 px-3"><input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={sup.includes(s.id)} onChange={() => toggle(s.id)} /><span className="font-mono text-footnote">{s.identifier}</span><span className="text-footnote text-label2">{s.offerName}</span></label></li>
              ))}
              {items.length <= 1 && <li className="px-3 py-3 text-footnote text-label2">No other services available to add.</li>}
            </ul>
          </fieldset>
          <BenefitsFields f={b} setF={setB} />
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-3"><Button type="submit" disabled={busy || !principal}>{busy ? 'Creating…' : 'Create group'}</Button><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button></div>
        </form>
      )}
      {free.loading && <Spinner />}
    </Modal>
  );
}

function ManageGroup({ id, accountId, canManage, onClose }: { id: string; accountId: string; canManage: boolean; onClose: () => void }) {
  const g = useApi<any>(`/groups/${id}`);
  const free = useApi<{ items: any[] }>(canManage ? `/services?accountId=${accountId}&groupable=1&limit=200` : null);
  const [adding, setAdding] = useState('');
  const [edit, setEdit] = useState<{ name: string; b: ReturnType<typeof initial> } | null>(null);
  const reloadAll = async () => { await g.reload(); await free.reload(); };
  const act = useAction(reloadAll);
  const data = g.data;
  const close = async (fn: () => Promise<unknown>) => { const r = await act.run(fn); if (r !== undefined) { /* stays open */ } };
  return (
    <Modal title={data ? data.name : 'Group'} onClose={onClose} wide>
      {g.error && <Alert>{g.error}</Alert>}{!data && <Spinner />}
      {data && (
        <div className="space-y-4">
          <p className="text-subhead text-label2">{benefitsText(data.benefits)}</p>
          <TableWrap><thead><tr><Th>Service</Th><Th>Plan</Th><Th>Role</Th>{canManage && <Th><span className="sr-only">Actions</span></Th>}</tr></thead><tbody>
            {data.members.map((m: any) => (
              <tr key={m.serviceId}>
                <Td className="font-mono">{m.identifier}</Td>
                <Td className="text-footnote text-label2">{m.offerName} · <Badge tone={tone(m.status)}>{label(m.status)}</Badge></Td>
                <Td><Badge tone={m.role === 'PRINCIPAL' ? 'success' : 'neutral'}>{m.role === 'PRINCIPAL' ? 'Principal' : 'Supplementary'}</Badge></Td>
                {canManage && (
                  <Td right>
                    {m.role !== 'PRINCIPAL' && <button className="min-h-tap px-2 text-accent" onClick={() => void close(() => post(`/groups/${id}/principal`, { serviceId: m.serviceId }))}>Make principal</button>}
                    {(m.role !== 'PRINCIPAL' || data.members.length === 1) && <button className="min-h-tap px-2 text-danger" onClick={() => void close(async () => { const r = await del(`/groups/${id}/members/${m.serviceId}`); if (r?.closed) onClose(); })}>Remove</button>}
                  </Td>
                )}
              </tr>
            ))}
          </tbody></TableWrap>
          {canManage && data.members.length > 1 && <p className="text-footnote text-label2">The principal can leave only after another service takes over, or the group is dissolved: a supplementary service cannot exist without one.</p>}
          {canManage && (
            <>
              <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (adding && (await act.run(() => post(`/groups/${id}/members`, { serviceId: adding })))) setAdding(''); }}>
                <div className="flex-1"><Field label="Add a supplementary service"><Select value={adding} onChange={(e) => setAdding(e.target.value)}><option value="">{(free.data?.items.length ?? 0) ? 'Choose…' : 'No other services available'}</option>{(free.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.identifier} · {s.offerName}</option>)}</Select></Field></div>
                <Button type="submit" disabled={!adding || act.busy}>Add</Button>
              </form>
              {edit ? (
                <form className="space-y-3 rounded-card bg-surface2 p-4" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => patch(`/groups/${id}`, { name: edit.name, benefits: toBody(edit.b) }))) setEdit(null); }}>
                  <Field label="Group name"><Input required maxLength={80} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
                  <BenefitsFields f={edit.b} setF={(b) => setEdit({ ...edit, b })} />
                  <div className="flex gap-3"><Button type="submit" disabled={act.busy}>Save</Button><Button type="button" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button></div>
                </form>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <Button variant="secondary" onClick={() => setEdit({ name: data.name, b: initial(data.benefits) })}>Edit name and benefits</Button>
                  <Button variant="destructive" onClick={() => { if (window.confirm(`Dissolve “${data.name}”? The services stay on the account; they just stop sharing.`)) void act.run(async () => { await del(`/groups/${id}`); onClose(); }); }}>Dissolve group</Button>
                </div>
              )}
            </>
          )}
          {act.error && <Alert>{act.error}</Alert>}
        </div>
      )}
    </Modal>
  );
}
