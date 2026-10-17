'use client';
import { Alert, Badge, Button, Card, Empty, Field, Input, LoadMore, Modal, Select, Spinner, DataList } from '@meridian/ui';
import Link from 'next/link';
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
                <li key={s.id}><label className="flex min-h-tap cursor-pointer items-center gap-3 px-3"><input type="checkbox" className="h-5 w-5 shrink-0 accent-[rgb(var(--accent))]" checked={sup.includes(s.id)} onChange={() => toggle(s.id)} /><span className="font-mono text-footnote">{s.identifier}</span><span className="text-footnote text-label2">{s.offerName}</span></label></li>
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
  const [dissolving, setDissolving] = useState(false);
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
          {data.slots && <p className="text-subhead"><span className="font-medium">{data.slots.remaining === 0 ? 'The group is full' : `${data.slots.remaining} of ${data.slots.max} places free`}</span><span className="text-label2"> · {data.slots.used} member line{data.slots.used === 1 ? '' : 's'} besides the family head</span></p>}
          <DataList label="Group members" rows={data.members} rowKey={(m: any) => m.serviceId}
            columns={[
              { key: 'id', label: 'Service', primary: true, render: (m: any) => <span className="font-mono">{m.identifier}</span> },
              { key: 'plan', label: 'Plan', render: (m: any) => <span className="text-footnote text-label2">{m.offerName} · <Badge tone={tone(m.status)}>{label(m.status)}</Badge></span> },
              { key: 'role', label: 'Role', render: (m: any) => <Badge tone={m.role === 'PRINCIPAL' ? 'success' : 'neutral'}>{m.role === 'PRINCIPAL' ? 'Principal' : 'Supplementary'}</Badge> },
            ]}
            actions={canManage ? (m: any) => (<>
              {m.role !== 'PRINCIPAL' && <Button variant="secondary" onClick={() => void close(() => post(`/groups/${id}/principal`, { serviceId: m.serviceId }))}>Make principal</Button>}
              {m.role !== 'PRINCIPAL' && <Button variant="plain" onClick={() => void close(async () => { const r = await del(`/groups/${id}/members/${m.serviceId}`); if (r?.closed) onClose(); })}>Remove</Button>}
            </>) : undefined} />
          {canManage && data.members.length > 1 && <p className="text-footnote text-label2">The principal can leave only after another service takes over, or the group is dissolved: a supplementary service cannot exist without one.</p>}
          {canManage && (
            <>
              {(data.slots?.remaining ?? 1) > 0 && (
                <div className="rounded-card bg-surface2 p-4">
                  <p className="font-medium">Add a new line to this group</p>
                  <p className="mb-3 text-footnote text-label2">Sell a new SIM and number that joins the group: the order wizard opens for this customer with the group already chosen.</p>
                  <Link href={`/orders/new?customerId=${data.customerId}&joinGroup=${id}`} className="inline-flex min-h-tap items-center rounded-control bg-accent px-4 font-medium text-accent-fg">Sell a new line</Link>
                </div>
              )}
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
                  <Button variant="destructive" onClick={() => setDissolving(true)}>Dissolve group…</Button>
                </div>
              )}
            </>
          )}
          {act.error && <Alert>{act.error}</Alert>}
          {dissolving && <DissolveGroup group={data} onClose={() => setDissolving(false)} onDone={onClose} />}
        </div>
      )}
    </Modal>
  );
}

/**
 * Dissolving ends the sharing, and every line goes back to a single-line plan. The family head is on the group plan, which only exists with the group, so a
 * single plan has to be chosen for it. The other lines keep their plan unless another is chosen.
 */
function DissolveGroup({ group, onClose, onDone }: { group: any; onClose: () => void; onDone: () => void }) {
  const plans = useApi<{ items: any[] }>('/catalog?limit=50&status=ACTIVE&kind=SIM_ONLY');
  const singles = (plans.data?.items ?? []).filter((o) => !o.group?.isGroupOffer);
  const members: any[] = group.members;
  // A line on the group plan has no single plan to fall back on, so one must be chosen for it; every other line defaults to keeping its own plan.
  const isHead = (m: any) => !!m.onGroupPlan;
  const [pick, setPick] = useState<Record<string, string>>({});
  const { run, busy, error } = useAction();
  const missing = members.filter((m) => isHead(m) && !pick[m.serviceId]);
  const submit = async () => {
    const chosen = Object.fromEntries(Object.entries(pick).filter(([sid, offer]) => offer && offer !== members.find((m) => m.serviceId === sid)?.offerId));
    if (await run(() => post(`/groups/${group.id}/dissolve`, { plans: chosen }), 'Group dissolved.')) onDone();
  };
  return (
    <Modal title={`Dissolve “${group.name}”`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-subhead text-label2">Every line goes back to a single subscription and stops sharing. Numbers, SIMs and history stay. The new plan’s fee applies from the next bill run.</p>
        {plans.loading && <Spinner />}
        <ul className="space-y-3">
          {members.map((m) => (
            <li key={m.serviceId} className="rounded-card border border-separator p-3">
              <p className="mb-2 flex flex-wrap items-center gap-2"><span className="font-mono">{m.identifier}</span><Badge tone={m.role === 'PRINCIPAL' ? 'success' : 'neutral'}>{m.role === 'PRINCIPAL' ? 'Family head' : 'Member'}</Badge><span className="text-footnote text-label2">now on {m.offerName}</span></p>
              <Field label="Single plan" hint={isHead(m) ? 'Required: the family head is on the group plan.' : 'Keep the current plan or choose another.'}>
                <Select value={pick[m.serviceId] ?? (isHead(m) ? '' : m.offerId)} onChange={(e) => setPick({ ...pick, [m.serviceId]: e.target.value })}>
                  {isHead(m) ? <option value="">Choose a plan…</option> : <option value={m.offerId}>Keep {m.offerName}</option>}
                  {singles.filter((o) => o.id !== m.offerId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            </li>
          ))}
        </ul>
        {error && <Alert>{error}</Alert>}
        <div className="flex gap-3"><Button variant="destructive" disabled={busy || plans.loading || missing.length > 0} onClick={() => void submit()}>{busy ? 'Dissolving…' : 'Dissolve the group'}</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  );
}
